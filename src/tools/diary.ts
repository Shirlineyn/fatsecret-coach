import { z } from "zod";
import { defineTool, daysSinceEpoch, mealSchema, userSchema, type ToolDef } from "./types";
import { fs } from "../fatsecret/client";
import { listUsers, storage } from "../storage/kv";

export const diaryTools: ToolDef[] = [
  defineTool({
    name: "get_food_entries",
    description: "Get a household member's food diary entries for a given date. Defaults to the current bearer's primary user.",
    inputSchema: z
      .object({
        user: userSchema,
        date: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today."),
      })
      .strict(),
    handler: ({ user, date }, { env, requestUser }) =>
      fs.profile(env, "food_entries.get.v2", { date: daysSinceEpoch(date) }, user ?? requestUser),
  }),

  defineTool({
    name: "get_food_entries_month",
    description: "Get food diary entries for an entire month (daily summaries). Defaults to the current bearer's primary user.",
    inputSchema: z
      .object({
        user: userSchema,
        date: z.string().optional().describe("ISO date YYYY-MM-DD; any day in the desired month."),
      })
      .strict(),
    handler: ({ user, date }, { env, requestUser }) =>
      fs.profile(env, "food_entries.get_month", { date: daysSinceEpoch(date) }, user ?? requestUser),
  }),

  defineTool({
    name: "create_food_entry",
    description:
      "Add a food entry to a household member's diary. Defaults to the current bearer's primary user. If a meal was eaten by both members — call twice with different `user`.",
    inputSchema: z
      .object({
        user: userSchema,
        food_id: z.string(),
        food_entry_name: z.string().describe("Display name shown in the diary, e.g. 'Chicken breast 200g'"),
        serving_id: z.string().describe("Serving id (from food.get) — defines the unit (g, oz, cup, etc.)"),
        number_of_units: z.number().positive(),
        meal: mealSchema,
        date: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today."),
      })
      .strict(),
    handler: ({ user, food_id, food_entry_name, serving_id, number_of_units, meal, date }, { env, requestUser }) =>
      fs.profile(
        env,
        "food_entry.create",
        {
          food_id,
          food_entry_name,
          serving_id,
          number_of_units,
          meal,
          date: daysSinceEpoch(date),
        },
        user ?? requestUser,
      ),
  }),

  defineTool({
    name: "edit_food_entry",
    description: "Edit an existing diary entry. Defaults to the current bearer's primary user.",
    inputSchema: z
      .object({
        user: userSchema,
        food_entry_id: z.string(),
        food_entry_name: z.string().optional(),
        serving_id: z.string().optional(),
        number_of_units: z.number().positive().optional(),
        meal: mealSchema.optional(),
      })
      .strict(),
    handler: ({ user, ...args }, { env, requestUser }) =>
      fs.profile(env, "food_entry.edit", args as Record<string, string | number>, user ?? requestUser),
  }),

  defineTool({
    name: "delete_food_entry",
    description: "Delete a single food diary entry by id. Defaults to the current bearer's primary user.",
    inputSchema: z.object({ user: userSchema, food_entry_id: z.string() }).strict(),
    handler: ({ user, food_entry_id }, { env, requestUser }) =>
      fs.profile(env, "food_entry.delete", { food_entry_id }, user ?? requestUser),
  }),

  defineTool({
    name: "log_shared_meal",
    description:
      "Log a one-off meal that several household members cooked and ate together. Takes a list of ingredients with TOTAL amounts cooked, and proportional shares per person — splits each ingredient across each member's diary as separate food entries. No custom food is created; each ingredient lands as its own diary entry (so e.g. '50g cheese + 1.5 eggs' shows up as two entries, not one combined). Default share = equal split among all authorized household members.",
    inputSchema: z
      .object({
        meal: mealSchema,
        date: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today."),
        ingredients: z
          .array(
            z
              .object({
                food_id: z.string(),
                serving_id: z.string(),
                total_units: z.number().positive().describe("TOTAL amount cooked (in serving_id units), to be split across members."),
                name: z.string().describe("Display name shown in diary, e.g. 'Яйцо' or 'Помидор'"),
              })
              .strict(),
          )
          .min(1),
        shares: z
          .record(z.string(), z.number().nonnegative())
          .optional()
          .describe(
            "Fraction each user ate of the total (0..1 each). If omitted, equal split across all authorized members. Sum < 1 means leftovers (untracked); sum > 1 is allowed (caller's responsibility). Keys are user ids from COACH_USERS, e.g. { \"<user-a>\": 0.6, \"<user-b>\": 0.4 }.",
          ),
      })
      .strict(),
    handler: async ({ meal, date, ingredients, shares }, { env }) => {
      let resolvedShares: Record<string, number>;
      if (shares) {
        for (const u of Object.keys(shares)) {
          if (!listUsers(env).includes(u)) {
            throw new Error(`Unknown user '${u}' in shares. Allowed: ${listUsers(env).join(", ")}.`);
          }
        }
        resolvedShares = shares;
      } else {
        const all = listUsers(env);
        const checks = await Promise.all(
          all.map(async (u) => ({ u, authorized: !!(await storage(env, u).getFsTokens()) })),
        );
        const authorized = checks.filter((c) => c.authorized).map((c) => c.u);
        if (authorized.length === 0) {
          throw new Error("No authorized household members. Run start_auth first.");
        }
        const equal = 1 / authorized.length;
        resolvedShares = Object.fromEntries(authorized.map((u) => [u, equal]));
      }

      const dateInt = daysSinceEpoch(date);
      const jobs: Array<{ user: string; ingredient: string; units: number; promise: Promise<unknown> }> = [];
      for (const [user, share] of Object.entries(resolvedShares)) {
        if (share <= 0) continue;
        for (const ing of ingredients) {
          const units = Math.round(ing.total_units * share * 1000) / 1000;
          if (units <= 0) continue;
          jobs.push({
            user,
            ingredient: ing.name,
            units,
            promise: fs.profile(
              env,
              "food_entry.create",
              {
                food_id: ing.food_id,
                food_entry_name: ing.name,
                serving_id: ing.serving_id,
                number_of_units: units,
                meal,
                date: dateInt,
              },
              user,
            ),
          });
        }
      }

      const results = await Promise.allSettled(jobs.map((j) => j.promise));
      const logged = results.map((r, i) => {
        const job = jobs[i]!;
        return r.status === "fulfilled"
          ? { user: job.user, ingredient: job.ingredient, units: job.units, status: "ok" as const, result: r.value }
          : { user: job.user, ingredient: job.ingredient, units: job.units, status: "error" as const, error: String((r as PromiseRejectedResult).reason) };
      });

      const sumShares = Object.values(resolvedShares).reduce((a, b) => a + b, 0);
      const notes: string[] = [];
      if (sumShares < 0.99) notes.push(`shares sum to ${sumShares.toFixed(2)} — ${Math.round((1 - sumShares) * 100)}% of total is leftover (not logged)`);
      if (sumShares > 1.01) notes.push(`shares sum to ${sumShares.toFixed(2)} (>1) — more was eaten than cooked`);

      return { meal, date: date ?? new Date().toISOString().slice(0, 10), shares: resolvedShares, ingredients: ingredients.length, logged, notes };
    },
  }),

  defineTool({
    name: "copy_food_entries",
    description: "Copy entries between dates (optionally one meal). Defaults to the current bearer's primary user.",
    inputSchema: z
      .object({
        user: userSchema,
        from_date: z.string().describe("ISO YYYY-MM-DD"),
        to_date: z.string().describe("ISO YYYY-MM-DD"),
        meal: mealSchema.optional().describe("If set, only copy entries of this meal type."),
      })
      .strict(),
    handler: ({ user, from_date, to_date, meal }, { env, requestUser }) =>
      fs.profile(
        env,
        "food_entries.copy",
        {
          from_date_int: daysSinceEpoch(from_date),
          to_date_int: daysSinceEpoch(to_date),
          ...(meal ? { meal } : {}),
        },
        user ?? requestUser,
      ),
  }),
];
