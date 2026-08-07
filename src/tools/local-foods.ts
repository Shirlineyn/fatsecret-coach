import { z } from "zod";
import { defineTool, type ToolDef } from "./types";
import { storage, newLocalId, type LocalFood } from "../storage/kv";

export const localFoodTools: ToolDef[] = [
  defineTool({
    name: "add_local_food",
    description:
      "Add a food to the household's LOCAL database — used as a fallback when FatSecret doesn't have a product (regional brands, restaurant menu items like 'Додстер', home-cooked dishes you'll log repeatedly). The food becomes household-shared (both members can find/log it). All macros are PER the serving_size described. Returns a food_id with prefix 'local_' that can be used in create_food_entry.",
    inputSchema: z
      .object({
        name: z.string().describe("Display name, e.g. 'Додстер классический' or 'Творог Простоквашино 5%'"),
        brand: z.string().optional().describe("Brand if relevant, e.g. 'Додо Пицца', 'Простоквашино'"),
        serving_size: z.string().describe("Serving size description, e.g. '1 порция', '100 g', '1 шт.'"),
        calories: z.number().nonnegative().describe("kcal per the serving_size above"),
        protein: z.number().nonnegative().describe("grams of protein per serving"),
        fat: z.number().nonnegative().describe("grams of fat per serving"),
        carbohydrate: z.number().nonnegative().describe("grams of carbs per serving"),
        saturated_fat: z.number().nonnegative().optional(),
        fiber: z.number().nonnegative().optional(),
        sugar: z.number().nonnegative().optional(),
        notes: z.string().optional().describe("Free-form note, e.g. source of macros ('сайт додо', 'упаковка')"),
      })
      .strict(),
    handler: async (args, { env, requestUser }) => {
      const food: LocalFood = {
        food_id: newLocalId("local"),
        name: args.name,
        brand: args.brand,
        serving_size: args.serving_size,
        calories: args.calories,
        protein_g: args.protein,
        fat_g: args.fat,
        carbs_g: args.carbohydrate,
        saturated_fat_g: args.saturated_fat,
        fiber_g: args.fiber,
        sugar_g: args.sugar,
        notes: args.notes,
        created_by: requestUser,
        created_at: new Date().toISOString(),
      };
      await storage(env).addLocalFood(food);
      return food;
    },
  }),

  defineTool({
    name: "list_local_foods",
    description: "List all foods in the household's local database. Supports optional substring filter on name+brand.",
    inputSchema: z
      .object({
        filter: z.string().optional().describe("Optional case-insensitive substring to filter by name or brand"),
      })
      .strict(),
    handler: async ({ filter }, { env }) => {
      const all = await storage(env).listLocalFoods();
      if (!filter) return { count: all.length, foods: all };
      const q = filter.toLowerCase();
      const matches = all.filter(
        (f) => f.name.toLowerCase().includes(q) || (f.brand?.toLowerCase().includes(q) ?? false),
      );
      return { count: matches.length, total_in_db: all.length, foods: matches };
    },
  }),

  defineTool({
    name: "delete_local_food",
    description:
      "Remove a food from the local database. Existing diary entries that referenced it are NOT deleted (they have cached macros).",
    inputSchema: z.object({ food_id: z.string() }).strict(),
    handler: async ({ food_id }, { env }) => {
      const store = storage(env);
      const existing = await store.getLocalFood(food_id);
      if (!existing) return { deleted: false, error: `No local food with id ${food_id}` };
      await store.deleteLocalFood(food_id);
      return { deleted: true, food_id, name: existing.name };
    },
  }),
];
