import { z } from "zod";
import { defineTool, daysSinceEpoch, mealSchema, todayIsoDate, userSchema, type ToolDef } from "./types";
import { fs } from "../fatsecret/client";
import { storage, type Goals } from "../storage/kv";
import { entriesFromResponse, summarize } from "../coach/aggregate";
import { suggestTargets, type ActivityLevel, type Sex } from "../coach/bmr";

const activitySchema = z.enum(["sedentary", "light", "moderate", "active", "very_active"]);

export const coachTools: ToolDef[] = [
  defineTool({
    name: "today_summary",
    description: `Daily nutrition summary for one user: consumed vs target kcal/protein/fat/carbs, per meal, with per-entry list. Defaults to current bearer's primary user.

When the user asks for a chart/visualization (e.g. "график", "покажи", "нарисуй"), render strictly as follows — do NOT invent alternative layouts:

LAYOUT
- Outer card: background var(--color-background-secondary), 0.5px border --color-border-tertiary, border-radius lg, padding 2rem 2rem 1.5rem.
- Header line: small "Сегодня" left, date + user id (e.g. "24 июня · <user>") right, both muted.
- 4 horizontal progress bars stacked, gap 16px.
- Below: by-meal bar chart, height ~180px, label "По приёмам пищи (ккал)" above.

PROGRESS BARS — ONE PER METRIC, each normalized to its own target (0–100%). Do NOT plot absolute values on a shared axis (calories would dwarf macro grams).
- Each row: metric label left in its color (500 weight), right side "<consumed>/<target> <unit> · <pct>% · осталось <remaining>" — metric name and pct in metric color (pct red #A32D2D if >100%); consumed bold; rest muted.
- Track: rgba(<R,G,B>, 0.16). Fill: solid color. Height 10px. Border-radius 5px. Fill width = min(100, pct)%.

COLORS (hex + rgb tuple for rgba tracks):
- Калории  — #534AB7 (83, 74, 183)   purple
- Белок    — #1D9E75 (29, 158, 117)  teal
- Жиры     — #BA7517 (186, 117, 23)  amber
- Углеводы — #D85A30 (216, 90, 48)   coral

BY-MEAL CHART
- Chart.js bar, 4 bars (Завтрак / Обед / Ужин / Перекус) using \`meal_totals.<meal>.kcal\`.
- One semantic dimension (kcal) → one color hue. Use purple alpha gradations: largest bar 0.85, mid 0.4, empty 0.18. Do NOT use 4 different colors here (that conflicts with macros).
- borderRadius 4, no legend, hidden grid.

The "render_hint" field in the response duplicates the key constants so they're available at call time.`,
    inputSchema: z
      .object({
        user: userSchema,
        date: z.string().optional().describe("ISO YYYY-MM-DD; defaults to today."),
      })
      .strict(),
    handler: async ({ user, date }, { env, requestUser }) => {
      const isoDate = date ?? todayIsoDate();
      const store = storage(env, user ?? requestUser);
      const [entriesResp, goals] = await Promise.all([
        fs.profile(env, "food_entries.get.v2", { date: daysSinceEpoch(isoDate) }, store.userId),
        store.getGoals(),
      ]);
      const rawEntries = entriesFromResponse(entriesResp);
      const summary = summarize(rawEntries, goals, isoDate);
      return {
        user: store.userId,
        ...summary,
        render_hint: {
          chart_style: "normalized_progress_bars_with_by_meal",
          colors: {
            kcal:      { hex: "#534AB7", rgb: [83, 74, 183]  },
            protein_g: { hex: "#1D9E75", rgb: [29, 158, 117] },
            fat_g:     { hex: "#BA7517", rgb: [186, 117, 23] },
            carbs_g:   { hex: "#D85A30", rgb: [216, 90, 48]  },
          },
          card: {
            bg: "var(--color-background-secondary)",
            border: "0.5px solid var(--color-border-tertiary)",
            radius: "var(--border-radius-lg)",
            padding: "2rem 2rem 1.5rem",
          },
          bar: { height_px: 10, radius_px: 5, track_alpha: 0.16 },
          by_meal: { palette: "kcal_color_alpha_gradations", alphas: [0.85, 0.18, 0.18, 0.4] },
          note: "Normalize each macro to its own target (0–100%). Do NOT plot absolute values on a shared axis.",
        },
      };
    },
  }),

  defineTool({
    name: "range_summary",
    description:
      "Multi-day nutrition summaries: returns array of DailySummary (consumed vs target macros) for each day in [from_date..to_date], inclusive. Use for week/month trend visualizations — Claude can render as a multi-line chart (kcal/P/F/C over time) or stacked bars per day. Max range 31 days. Defaults to the current bearer's primary user.",
    inputSchema: z
      .object({
        user: userSchema,
        from_date: z.string().describe("ISO YYYY-MM-DD, inclusive"),
        to_date: z.string().describe("ISO YYYY-MM-DD, inclusive"),
      })
      .strict(),
    handler: async ({ user, from_date, to_date }, { env, requestUser }) => {
      const store = storage(env, user ?? requestUser);
      const startMs = Date.parse(from_date);
      const endMs = Date.parse(to_date);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
        throw new Error(`Invalid date range: from=${from_date}, to=${to_date}`);
      }
      const dayMs = 86400000;
      const dayCount = Math.round((endMs - startMs) / dayMs) + 1;
      if (dayCount > 31) throw new Error(`Range too large: ${dayCount} days (max 31)`);

      const isoDates: string[] = [];
      for (let i = 0; i < dayCount; i++) {
        isoDates.push(new Date(startMs + i * dayMs).toISOString().slice(0, 10));
      }

      const goals = await store.getGoals();
      const days = await Promise.all(
        isoDates.map(async (isoDate) => {
          const resp = await fs.profile(
            env,
            "food_entries.get.v2",
            { date: daysSinceEpoch(isoDate) },
            store.userId,
          );
          const summary = summarize(entriesFromResponse(resp), goals, isoDate);
          return {
            date: isoDate,
            consumed: summary.consumed,
            target: summary.target,
            remaining: summary.remaining,
            percent_of_target: summary.percent_of_target,
          };
        }),
      );

      const totals = days.reduce(
        (acc, d) => ({
          kcal: acc.kcal + d.consumed.kcal,
          protein_g: acc.protein_g + d.consumed.protein_g,
          fat_g: acc.fat_g + d.consumed.fat_g,
          carbs_g: acc.carbs_g + d.consumed.carbs_g,
        }),
        { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
      );
      const avg = {
        kcal: Math.round(totals.kcal / dayCount),
        protein_g: Math.round((totals.protein_g / dayCount) * 10) / 10,
        fat_g: Math.round((totals.fat_g / dayCount) * 10) / 10,
        carbs_g: Math.round((totals.carbs_g / dayCount) * 10) / 10,
      };

      return { user: store.userId, from_date, to_date, day_count: dayCount, days, average_per_day: avg, target: days[0]?.target ?? null };
    },
  }),

  defineTool({
    name: "get_goals",
    description: "Read nutrition and weight goals. Defaults to the current bearer's primary user.",
    inputSchema: z.object({ user: userSchema }).strict(),
    handler: async ({ user }, { env, requestUser }) => {
      const store = storage(env, user ?? requestUser);
      const goals = await store.getGoals();
      return goals
        ? { user: store.userId, ...goals }
        : {
            user: store.userId,
            hint: `No goals set for '${store.userId}' yet. Call set_goals or set_goals_from_profile to initialize.`,
          };
    },
  }),

  defineTool({
    name: "set_goals",
    description:
      "Save or update nutrition and weight-loss goals. Defaults to the current bearer's primary user. All fields optional — only provided fields are updated; missing fields preserved.",
    inputSchema: z
      .object({
        user: userSchema,
        target_kcal: z.number().int().positive().optional(),
        target_protein_g: z.number().int().nonnegative().optional(),
        target_fat_g: z.number().int().nonnegative().optional(),
        target_carbs_g: z.number().int().nonnegative().optional(),
        weight_kg_target: z.number().positive().optional(),
        weight_kg_start: z.number().positive().optional(),
        deadline: z.string().optional().describe("ISO YYYY-MM-DD"),
        weekly_loss_kg: z.number().positive().optional(),
      })
      .strict(),
    handler: async ({ user, ...input }, { env, requestUser }) => {
      const store = storage(env, user ?? requestUser);
      const existing = (await store.getGoals()) ?? {
        target_kcal: 0,
        target_protein_g: 0,
        target_fat_g: 0,
        target_carbs_g: 0,
        updated_at: new Date().toISOString(),
      };
      const next: Goals = {
        ...existing,
        ...input,
        updated_at: new Date().toISOString(),
      };
      await store.setGoals(next);
      return { user: store.userId, ...next };
    },
  }),

  defineTool({
    name: "set_goals_from_profile",
    description:
      "Compute calorie/macro targets from the FatSecret profile (weight, height, age, sex) + activity, using Mifflin-St Jeor. Defaults to the current bearer's primary user.",
    inputSchema: z
      .object({
        user: userSchema,
        activity: activitySchema,
        weekly_loss_kg: z.number().positive().max(1).optional().default(0.5),
        sex: z.enum(["male", "female"]).optional().describe("Override profile sex if needed."),
        weight_kg: z.number().positive().optional().describe("Override profile weight if needed."),
        height_cm: z.number().positive().optional().describe("Override profile height if needed."),
        age_years: z.number().int().positive().optional().describe("Override profile age if needed."),
      })
      .strict(),
    handler: async ({ user, ...args }, { env, requestUser }) => {
      const store = storage(env, user ?? requestUser);
      const profileResp = (await fs.profile(env, "profile.get", {}, store.userId)) as {
        profile?: {
          last_weight_kg?: string;
          height?: string;
          height_cm?: string;
          age?: string;
          date_of_birth?: string;
          sex?: string;
          goal_weight_kg?: string;
        };
      };
      const p = profileResp.profile ?? {};

      const weight_kg = args.weight_kg ?? parseFloat(p.last_weight_kg ?? "0");
      const height_cm = args.height_cm ?? parseFloat(p.height_cm ?? p.height ?? "0");
      const age_years = args.age_years ?? deriveAge(p);
      const sex: Sex = args.sex ?? ((p.sex?.toLowerCase() as Sex | undefined) ?? "male");

      if (!weight_kg || !height_cm || !age_years) {
        return {
          user: store.userId,
          error:
            "Profile is missing weight/height/age. Either fill them in fatsecret.com web UI or pass overrides (weight_kg, height_cm, age_years).",
          profile_raw: p,
        };
      }

      const suggestion = suggestTargets(
        { weight_kg, height_cm, age_years, sex },
        args.activity as ActivityLevel,
        { weekly_loss_kg: args.weekly_loss_kg },
      );

      const existing = await store.getGoals();
      const goals: Goals = {
        ...(existing ?? {}),
        target_kcal: suggestion.target_kcal,
        target_protein_g: suggestion.target_protein_g,
        target_fat_g: suggestion.target_fat_g,
        target_carbs_g: suggestion.target_carbs_g,
        weight_kg_start: existing?.weight_kg_start ?? weight_kg,
        weight_kg_target: existing?.weight_kg_target ?? (parseFloat(p.goal_weight_kg ?? "0") || undefined),
        weekly_loss_kg: args.weekly_loss_kg,
        updated_at: new Date().toISOString(),
      };
      await store.setGoals(goals);
      return { user: store.userId, goals, computation: suggestion };
    },
  }),

  defineTool({
    name: "suggest_meal",
    description:
      "Collect candidate foods for a meal slot, biased by recent/favorite foods + remaining macro budget. Defaults to the current bearer's primary user. RETURNS RAW CANDIDATES — caller (Claude) ranks/explains.",
    inputSchema: z
      .object({
        user: userSchema,
        meal: mealSchema,
        max_candidates: z.number().int().min(3).max(40).optional().default(20),
        seed_queries: z
          .array(z.string())
          .optional()
          .describe("Extra search_foods queries to seed candidates, e.g. ['chicken breast', 'greek yogurt']."),
      })
      .strict(),
    handler: async ({ user, meal, max_candidates, seed_queries }, { env, requestUser }) => {
      const isoDate = todayIsoDate();
      const store = storage(env, user ?? requestUser);
      const [entriesResp, goals, favs, mostEaten, recent] = await Promise.all([
        fs.profile(env, "food_entries.get.v2", { date: daysSinceEpoch(isoDate) }, store.userId),
        store.getGoals(),
        fs.profile(env, "foods.get_favorites", {}, store.userId).catch(() => null),
        fs.profile(env, "foods.get_most_eaten", { meal }, store.userId).catch(() => null),
        fs.profile(env, "foods.get_recently_eaten", { meal }, store.userId).catch(() => null),
      ]);
      const summary = summarize(entriesFromResponse(entriesResp), goals, isoDate);

      const seedResults = seed_queries
        ? await Promise.all(
            seed_queries.slice(0, 5).map((q) =>
              fs.public(env, "foods.search", { search_expression: q, max_results: 5 }).catch(() => null),
            ),
          )
        : [];

      return {
        user: store.userId,
        meal,
        remaining: summary.remaining,
        target: summary.target,
        consumed: summary.consumed,
        max_candidates,
        candidates: {
          favorite_foods: favs,
          most_eaten: mostEaten,
          recently_eaten: recent,
          seed_searches: seedResults,
        },
        guidance:
          "Pick 2-3 candidates that close the largest remaining-macro gaps. Prefer recently_eaten and most_eaten for familiarity. Use favorite_foods when remaining budget is small.",
      };
    },
  }),
];

function deriveAge(p: { age?: string; date_of_birth?: string }): number {
  if (p.age) {
    const n = parseInt(p.age, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (p.date_of_birth) {
    const dob = new Date(p.date_of_birth);
    if (!Number.isNaN(dob.getTime())) {
      const ageMs = Date.now() - dob.getTime();
      return Math.floor(ageMs / (365.25 * 86400000));
    }
  }
  return 0;
}
