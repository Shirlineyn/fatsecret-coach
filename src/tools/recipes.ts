import { z } from "zod";
import { defineTool, type ToolDef } from "./types";
import { fs } from "../fatsecret/client";

export const recipeTools: ToolDef[] = [
  defineTool({
    name: "search_recipes",
    description: "Search the FatSecret recipe database. Supports filters on calories, fat, carbs, protein, recipe types.",
    inputSchema: z
      .object({
        query: z.string().optional(),
        recipe_types: z.string().optional().describe("Comma-separated, e.g. 'Breakfast,Lunch'"),
        calories_from: z.number().optional(),
        calories_to: z.number().optional(),
        carb_g_from: z.number().optional(),
        carb_g_to: z.number().optional(),
        protein_g_from: z.number().optional(),
        protein_g_to: z.number().optional(),
        fat_g_from: z.number().optional(),
        fat_g_to: z.number().optional(),
        page: z.number().int().min(0).optional().default(0),
        max_results: z.number().int().min(1).max(50).optional().default(20),
      })
      .strict(),
    handler: (args, { env }) => {
      const { query, page, max_results, ...rest } = args;
      return fs.public(env, "recipes.search.v3", {
        ...(query ? { search_expression: query } : {}),
        page_number: page,
        max_results,
        ...rest,
      });
    },
  }),

  defineTool({
    name: "get_recipe",
    description: "Get full recipe details — ingredients, directions, per-serving macros.",
    inputSchema: z.object({ recipe_id: z.string() }).strict(),
    handler: ({ recipe_id }, { env }) => fs.public(env, "recipe.get.v2", { recipe_id }),
  }),
];
