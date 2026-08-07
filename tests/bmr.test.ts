import { describe, expect, it } from "vitest";
import { mifflinStJeor, tdee, suggestTargets } from "../src/coach/bmr";

describe("Mifflin-St Jeor", () => {
  it("matches the published formula for male", () => {
    const bmr = mifflinStJeor({ weight_kg: 80, height_cm: 180, age_years: 30, sex: "male" });
    expect(bmr).toBe(10 * 80 + 6.25 * 180 - 5 * 30 + 5);
  });

  it("matches the published formula for female (-161 offset)", () => {
    const m = mifflinStJeor({ weight_kg: 80, height_cm: 180, age_years: 30, sex: "male" });
    const f = mifflinStJeor({ weight_kg: 80, height_cm: 180, age_years: 30, sex: "female" });
    expect(m - f).toBe(166);
  });
});

describe("TDEE activity multipliers", () => {
  const base = { weight_kg: 70, height_cm: 170, age_years: 35, sex: "male" as const };

  it("sedentary < moderate < very_active", () => {
    const s = tdee(base, "sedentary");
    const m = tdee(base, "moderate");
    const v = tdee(base, "very_active");
    expect(s).toBeLessThan(m);
    expect(m).toBeLessThan(v);
  });

  it("moderate multiplier is 1.55 of BMR", () => {
    const bmr = mifflinStJeor(base);
    expect(tdee(base, "moderate")).toBeCloseTo(bmr * 1.55, 5);
  });
});

describe("suggestTargets", () => {
  const me = { weight_kg: 92, height_cm: 178, age_years: 24, sex: "male" as const };

  it("never drops below the 1200 kcal safety floor", () => {
    const s = suggestTargets(me, "sedentary", { weekly_loss_kg: 1.0 });
    expect(s.target_kcal).toBeGreaterThanOrEqual(1200);
  });

  it("default weekly_loss_kg=0.5 yields ~550 kcal/day deficit (3850/7)", () => {
    const s = suggestTargets(me, "moderate");
    expect(s.daily_deficit_kcal).toBe(Math.round((0.5 * 7700) / 7));
  });

  it("macro split sums (approximately) to total kcal", () => {
    const s = suggestTargets(me, "moderate");
    const kcalFromMacros = s.target_protein_g * 4 + s.target_fat_g * 9 + s.target_carbs_g * 4;
    expect(Math.abs(kcalFromMacros - s.target_kcal)).toBeLessThanOrEqual(4);
  });

  it("protein scales with weight at default 1.8 g/kg", () => {
    const s = suggestTargets(me, "moderate");
    expect(s.target_protein_g).toBe(Math.round(1.8 * me.weight_kg));
  });
});
