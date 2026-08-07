import { z } from "zod";
import { defineTool, mealSchema, userSchema, type ToolDef } from "./types";
import { fs } from "../fatsecret/client";

export const favoritesTools: ToolDef[] = [
  defineTool({
    name: "get_favorite_foods",
    description: "Get favorite foods (explicitly starred). Defaults to the current bearer's primary user.",
    inputSchema: z.object({ user: userSchema }).strict(),
    handler: ({ user }, { env, requestUser }) =>
      fs.profile(env, "foods.get_favorites", {}, user ?? requestUser),
  }),

  defineTool({
    name: "get_most_eaten_foods",
    description: "Most frequently logged foods, optionally by meal type. Defaults to the current bearer's primary user.",
    inputSchema: z.object({ user: userSchema, meal: mealSchema.optional() }).strict(),
    handler: ({ user, meal }, { env, requestUser }) =>
      fs.profile(env, "foods.get_most_eaten", meal ? { meal } : {}, user ?? requestUser),
  }),

  defineTool({
    name: "get_recently_eaten_foods",
    description: "Recently logged foods, optionally by meal type. Defaults to the current bearer's primary user.",
    inputSchema: z.object({ user: userSchema, meal: mealSchema.optional() }).strict(),
    handler: ({ user, meal }, { env, requestUser }) =>
      fs.profile(env, "foods.get_recently_eaten", meal ? { meal } : {}, user ?? requestUser),
  }),
];
