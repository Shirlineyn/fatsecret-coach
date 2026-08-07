import { z } from "zod";
import { defineTool, type ToolDef } from "./types";
import { fs } from "../fatsecret/client";
import { storage } from "../storage/kv";

export const foodTools: ToolDef[] = [
  defineTool({
    name: "search_foods",
    description: "Search BOTH the FatSecret food database (US, English) AND the household's local food DB (Russian-friendly, includes regional brands / restaurant items added via add_local_food). Cyrillic queries match local DB; for FatSecret, translate to English first ('борщ' → 'borscht', 'яблоко' → 'apple'). If FatSecret has no match, check `local.matches` for items added by household members. Returns { fatsecret: {...standard FS response or {error}}, local: { count, matches: [{food_id, food_name, brand_name, serving_size, calories, protein_g, fat_g, carbs_g, source: 'local'}] } }. food_ids starting with 'local_' are valid for create_food_entry — they'll route through the local diary path.",
    inputSchema: z
      .object({
        query: z.string().describe("English search expression. Translate Russian queries first ('борщ' → 'borscht', 'яблоко' → 'apple')."),
        page: z.number().int().min(0).optional().default(0),
        max_results: z.number().int().min(1).max(50).optional().default(20),
        region: z.string().optional().describe("ISO country code. Silently ignored on Basic tier (Premier-only)."),
        language: z.string().optional().describe("ISO language code. Silently ignored on Basic tier (Premier-only)."),
      })
      .strict(),
    handler: async ({ query, page, max_results, region, language }, { env }) => {
      const [fatsecret, localFoods] = await Promise.all([
        fs
          .public(env, "foods.search", {
            search_expression: query,
            page_number: page,
            max_results,
            ...(region ? { region } : {}),
            ...(language ? { language } : {}),
          })
          .catch((e: unknown) => ({ error: String(e) })),
        storage(env).listLocalFoods(),
      ]);
      const q = query.toLowerCase();
      const local_matches = localFoods
        .filter((f) => f.name.toLowerCase().includes(q) || (f.brand?.toLowerCase().includes(q) ?? false))
        .map((f) => ({
          food_id: f.food_id,
          food_name: f.name,
          brand_name: f.brand,
          serving_size: f.serving_size,
          calories: f.calories,
          protein_g: f.protein_g,
          fat_g: f.fat_g,
          carbs_g: f.carbs_g,
          source: "local" as const,
        }));
      return { fatsecret, local: { count: local_matches.length, matches: local_matches } };
    },
  }),

  defineTool({
    name: "get_food",
    description: "Get full nutrition data for a single food by id, including all serving variations and macros per serving.",
    inputSchema: z
      .object({
        food_id: z.string().describe("FatSecret food id from search_foods or autocomplete_foods"),
      })
      .strict(),
    handler: ({ food_id }, { env }) => fs.public(env, "food.get.v2", { food_id }),
  }),

  defineTool({
    name: "autocomplete_foods",
    description: "Lightweight autocomplete for partial food names. Faster and cheaper than search_foods; use for type-ahead.",
    inputSchema: z
      .object({
        expression: z.string(),
        max_results: z.number().int().min(1).max(20).optional().default(8),
      })
      .strict(),
    handler: ({ expression, max_results }, { env }) =>
      fs.public(env, "foods.autocomplete.v2", { expression, max_results }),
  }),

  // NOTE: food.create удалён — FatSecret отдаёт его только в Premier-тарифе
  // (на Basic возвращает "Unknown method" для всех вариантов имени).
  // Для одноразовых совместных блюд используй log_shared_meal (логирует
  // ингредиенты напрямую). Для повторяющихся домашних рецептов — либо
  // создавай продукт вручную на fatsecret.com → My Foods, либо см. план
  // tool'ов save_recipe / log_recipe ниже (если будет реализовано).
];
