import type { Goals } from "../storage/kv";

export interface RawEntry {
  food_entry_id?: string;
  food_entry_name?: string;
  food_id?: string;
  meal?: string;
  calories?: string | number;
  carbohydrate?: string | number;
  protein?: string | number;
  fat?: string | number;
  number_of_units?: string | number;
  serving_id?: string;
}

export interface MealTotals {
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
}

export interface EntrySummary {
  food_entry_id?: string;
  name: string;
  meal: string;
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
}

export interface DailySummary {
  date: string;
  consumed: MealTotals;
  by_meal: Record<string, EntrySummary[]>;
  meal_totals: Record<string, MealTotals>;
  target: MealTotals | null;
  remaining: MealTotals | null;
  percent_of_target: { kcal: number; protein_g: number; fat_g: number; carbs_g: number } | null;
}

const ZERO: MealTotals = { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 };

const toNumber = (v: string | number | undefined): number => {
  if (v === undefined || v === null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const normalizeMeal = (raw: string | undefined): string => {
  if (!raw) return "other";
  const m = raw.toLowerCase();
  if (m === "breakfast" || m === "lunch" || m === "dinner" || m === "other") return m;
  return "other";
};

export function entriesFromResponse(resp: unknown): RawEntry[] {
  if (typeof resp !== "object" || resp === null) return [];
  const root = (resp as { food_entries?: { food_entry?: RawEntry | RawEntry[] } }).food_entries;
  if (!root) return [];
  const raw = root.food_entry;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export function summarize(rawEntries: RawEntry[], goals: Goals | null, date: string): DailySummary {
  const meal_totals: Record<string, MealTotals> = {
    breakfast: { ...ZERO },
    lunch: { ...ZERO },
    dinner: { ...ZERO },
    other: { ...ZERO },
  };
  const by_meal: Record<string, EntrySummary[]> = { breakfast: [], lunch: [], dinner: [], other: [] };
  const consumed: MealTotals = { ...ZERO };

  for (const e of rawEntries) {
    const meal = normalizeMeal(e.meal);
    const summary: EntrySummary = {
      food_entry_id: e.food_entry_id,
      name: e.food_entry_name ?? "(unnamed)",
      meal,
      kcal: toNumber(e.calories),
      protein_g: toNumber(e.protein),
      fat_g: toNumber(e.fat),
      carbs_g: toNumber(e.carbohydrate),
    };
    by_meal[meal]!.push(summary);
    const mt = meal_totals[meal]!;
    mt.kcal += summary.kcal;
    mt.protein_g += summary.protein_g;
    mt.fat_g += summary.fat_g;
    mt.carbs_g += summary.carbs_g;
    consumed.kcal += summary.kcal;
    consumed.protein_g += summary.protein_g;
    consumed.fat_g += summary.fat_g;
    consumed.carbs_g += summary.carbs_g;
  }

  if (!goals) {
    return { date, consumed, by_meal, meal_totals, target: null, remaining: null, percent_of_target: null };
  }

  const target: MealTotals = {
    kcal: goals.target_kcal,
    protein_g: goals.target_protein_g,
    fat_g: goals.target_fat_g,
    carbs_g: goals.target_carbs_g,
  };
  const remaining: MealTotals = {
    kcal: target.kcal - consumed.kcal,
    protein_g: target.protein_g - consumed.protein_g,
    fat_g: target.fat_g - consumed.fat_g,
    carbs_g: target.carbs_g - consumed.carbs_g,
  };
  const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const percent_of_target = {
    kcal: pct(consumed.kcal, target.kcal),
    protein_g: pct(consumed.protein_g, target.protein_g),
    fat_g: pct(consumed.fat_g, target.fat_g),
    carbs_g: pct(consumed.carbs_g, target.carbs_g),
  };

  return { date, consumed, by_meal, meal_totals, target, remaining, percent_of_target };
}
