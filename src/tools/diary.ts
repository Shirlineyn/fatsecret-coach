import { z } from "zod";
import type { Env } from "../env";
import { defineTool, daysSinceEpoch, mealSchema, todayIsoDate, userSchema, type MealType, type ToolDef } from "./types";
import { fs } from "../fatsecret/client";
import { isLocalId, listUsers, storage } from "../storage/kv";
import { createLocalEntry } from "../diary/entries";

/** One diary write, routed by food id: `local_*` foods go to KV, the rest to FatSecret. */
async function createEntry(
  env: Env,
  user: string,
  args: { food_id: string; food_entry_name: string; serving_id?: string; number_of_units: number; meal: MealType; date?: string },
): Promise<unknown> {
  if (isLocalId(args.food_id)) return createLocalEntry(storage(env, user), args);
  if (!args.serving_id) throw new Error(`serving_id is required for FatSecret food ${args.food_id} (get it from get_food).`);
  return fs.profile(
    env,
    "food_entry.create",
    {
      food_id: args.food_id,
      food_entry_name: args.food_entry_name,
      serving_id: args.serving_id,
      number_of_units: args.number_of_units,
      meal: args.meal,
      date: daysSinceEpoch(args.date),
    },
    user,
  );
}

export const diaryTools: ToolDef[] = [
  defineTool({
    name: "get_food_entries",
    description:
      "Get a household member's food diary entries for a given date: the raw FatSecret response plus `local_entries` (foods logged from the local database, which FatSecret does not store). Defaults to the current bearer's primary user.",
    inputSchema: z
      .object({
        user: userSchema,
        date: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today."),
      })
      .strict(),
    handler: async ({ user, date }, { env, requestUser }) => {
      const store = storage(env, user ?? requestUser);
      const [resp, local_entries] = await Promise.all([
        fs.profile(env, "food_entries.get.v2", { date: daysSinceEpoch(date) }, store.userId),
        store.listLocalEntriesForDate(date ?? todayIsoDate()),
      ]);
      return { ...(resp as object), local_entries };
    },
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
      "Add a food entry to a household member's diary. Defaults to the current bearer's primary user. If a meal was eaten by both members — call twice with different `user`. A `local_` food_id (from add_local_food / search_foods local matches) is logged to the local diary: number_of_units multiplies the local food's serving, serving_id is not needed. Local entries count in today_summary and range_summary but do not appear in the FatSecret app.",
    inputSchema: z
      .object({
        user: userSchema,
        food_id: z.string(),
        food_entry_name: z.string().describe("Display name shown in the diary, e.g. 'Chicken breast 200g'"),
        serving_id: z
          .string()
          .optional()
          .describe("Serving id (from get_food) — defines the unit (g, oz, cup, etc.). Required for FatSecret foods, ignored for local_ foods."),
        number_of_units: z.number().positive(),
        meal: mealSchema,
        date: z.string().optional().describe("ISO date YYYY-MM-DD. Defaults to today."),
      })
      .strict(),
    handler: async ({ user, ...args }, { env, requestUser }) => createEntry(env, user ?? requestUser, args),
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
    handler: async ({ user, ...args }, { env, requestUser }) => {
      if (isLocalId(args.food_entry_id)) {
        throw new Error("Local diary entries can't be edited. Delete it with delete_food_entry and log it again.");
      }
      return fs.profile(env, "food_entry.edit", args as Record<string, string | number>, user ?? requestUser);
    },
  }),

  defineTool({
    name: "delete_food_entry",
    description: "Delete a single food diary entry by id (FatSecret or local_). Defaults to the current bearer's primary user.",
    inputSchema: z.object({ user: userSchema, food_entry_id: z.string() }).strict(),
    handler: async ({ user, food_entry_id }, { env, requestUser }) => {
      if (!isLocalId(food_entry_id)) {
        return fs.profile(env, "food_entry.delete", { food_entry_id }, user ?? requestUser);
      }
      const deleted = await storage(env, user ?? requestUser).deleteLocalEntry(food_entry_id);
      if (!deleted) throw new Error(`No local diary entry with id ${food_entry_id}.`);
      return { deleted: true, entry: deleted };
    },
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
                serving_id: z.string().optional().describe("Required for FatSecret foods, omit for local_ foods."),
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
            promise: createEntry(env, user, {
              food_id: ing.food_id,
              food_entry_name: ing.name,
              serving_id: ing.serving_id,
              number_of_units: units,
              meal,
              date,
            }),
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
    description: "Copy FatSecret entries between dates (optionally one meal). Local diary entries are not copied. Defaults to the current bearer's primary user.",
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
