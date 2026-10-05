import type { Env } from "../env";
import { fs } from "../fatsecret/client";
import { entriesFromResponse, type RawEntry } from "../coach/aggregate";
import { newLocalId, type LocalEntry, type Storage } from "../storage/kv";
import { daysSinceEpoch, todayIsoDate, type MealType } from "../tools/types";

/**
 * Log a food from the household's local database. FatSecret never sees these:
 * the entry lives in KV with macros scaled and cached at write time, so editing
 * or deleting the local food later does not rewrite history.
 */
export async function createLocalEntry(
  store: Storage,
  args: { food_id: string; food_entry_name: string; number_of_units: number; meal: MealType; date?: string },
): Promise<LocalEntry> {
  const food = await store.getLocalFood(args.food_id);
  if (!food) throw new Error(`No local food with id ${args.food_id}. Use list_local_foods to see what exists.`);
  const scale = (v: number) => Math.round(v * args.number_of_units * 10) / 10;
  const entry: LocalEntry = {
    entry_id: newLocalId("local"),
    food_id: food.food_id,
    food_entry_name: args.food_entry_name,
    meal: args.meal,
    date: args.date ?? todayIsoDate(),
    number_of_units: args.number_of_units,
    kcal: scale(food.calories),
    protein_g: scale(food.protein_g),
    fat_g: scale(food.fat_g),
    carbs_g: scale(food.carbs_g),
    created_at: new Date().toISOString(),
  };
  await store.addLocalEntry(entry);
  return entry;
}

export function localEntryToRaw(e: LocalEntry): RawEntry {
  return {
    food_entry_id: e.entry_id,
    food_entry_name: e.food_entry_name,
    food_id: e.food_id,
    meal: e.meal,
    calories: e.kcal,
    protein: e.protein_g,
    fat: e.fat_g,
    carbohydrate: e.carbs_g,
    number_of_units: e.number_of_units,
  };
}

/** Everything eaten on a day: FatSecret diary plus local entries, in summarize() shape. */
export async function loadDayEntries(env: Env, store: Storage, isoDate: string): Promise<RawEntry[]> {
  const [resp, local] = await Promise.all([
    fs.profile(env, "food_entries.get.v2", { date: daysSinceEpoch(isoDate) }, store.userId),
    store.listLocalEntriesForDate(isoDate),
  ]);
  return [...entriesFromResponse(resp), ...local.map(localEntryToRaw)];
}
