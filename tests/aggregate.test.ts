import { describe, expect, it } from "vitest";
import { entriesFromResponse, summarize } from "../src/coach/aggregate";
import type { Goals } from "../src/storage/kv";

const goals: Goals = {
  target_kcal: 2000,
  target_protein_g: 130,
  target_fat_g: 65,
  target_carbs_g: 220,
  updated_at: "2026-06-23T00:00:00.000Z",
};

describe("entriesFromResponse", () => {
  it("handles array shape", () => {
    const resp = { food_entries: { food_entry: [{ calories: "100" }, { calories: "50" }] } };
    expect(entriesFromResponse(resp)).toHaveLength(2);
  });

  it("handles single-object shape (FatSecret quirk)", () => {
    const resp = { food_entries: { food_entry: { calories: "100" } } };
    expect(entriesFromResponse(resp)).toHaveLength(1);
  });

  it("returns empty for missing food_entries", () => {
    expect(entriesFromResponse({})).toHaveLength(0);
    expect(entriesFromResponse(null)).toHaveLength(0);
  });
});

describe("summarize", () => {
  it("sums macros across all entries", () => {
    const entries = [
      { calories: "300", protein: "30", fat: "10", carbohydrate: "20", meal: "Breakfast", food_entry_name: "Eggs" },
      { calories: "500", protein: "40", fat: "15", carbohydrate: "50", meal: "Lunch", food_entry_name: "Chicken bowl" },
    ];
    const s = summarize(entries, goals, "2026-06-23");
    expect(s.consumed.kcal).toBe(800);
    expect(s.consumed.protein_g).toBe(70);
    expect(s.consumed.fat_g).toBe(25);
    expect(s.consumed.carbs_g).toBe(70);
  });

  it("groups by meal type", () => {
    const entries = [
      { calories: "300", meal: "Breakfast", food_entry_name: "A" },
      { calories: "500", meal: "Lunch", food_entry_name: "B" },
      { calories: "200", meal: "Lunch", food_entry_name: "C" },
    ];
    const s = summarize(entries, null, "2026-06-23");
    expect(s.by_meal.breakfast).toHaveLength(1);
    expect(s.by_meal.lunch).toHaveLength(2);
    expect(s.meal_totals.lunch?.kcal).toBe(700);
  });

  it("computes remaining macros vs target", () => {
    const entries = [{ calories: "1500", protein: "100", fat: "50", carbohydrate: "150", meal: "Breakfast", food_entry_name: "Big meal" }];
    const s = summarize(entries, goals, "2026-06-23");
    expect(s.remaining?.kcal).toBe(500);
    expect(s.remaining?.protein_g).toBe(30);
    expect(s.remaining?.fat_g).toBe(15);
    expect(s.remaining?.carbs_g).toBe(70);
  });

  it("returns null target/remaining when no goals set", () => {
    const s = summarize([{ calories: "300", meal: "Breakfast", food_entry_name: "X" }], null, "2026-06-23");
    expect(s.target).toBeNull();
    expect(s.remaining).toBeNull();
  });

  it("normalizes unknown meal types to 'other'", () => {
    const s = summarize(
      [{ calories: "200", meal: "Snack" as unknown as string, food_entry_name: "Apple" }],
      null,
      "2026-06-23",
    );
    expect(s.by_meal.other).toHaveLength(1);
    expect(s.by_meal.breakfast).toHaveLength(0);
  });

  it("computes percent_of_target rounded to one decimal", () => {
    const entries = [{ calories: "1000", protein: "65", fat: "32.5", carbohydrate: "110", meal: "Breakfast", food_entry_name: "Half day" }];
    const s = summarize(entries, goals, "2026-06-23");
    expect(s.percent_of_target?.kcal).toBe(50);
    expect(s.percent_of_target?.protein_g).toBe(50);
  });
});
