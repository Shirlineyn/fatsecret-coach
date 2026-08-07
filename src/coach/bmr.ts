export type Sex = "male" | "female";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";

const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export interface BmrInput {
  weight_kg: number;
  height_cm: number;
  age_years: number;
  sex: Sex;
}

export function mifflinStJeor({ weight_kg, height_cm, age_years, sex }: BmrInput): number {
  const base = 10 * weight_kg + 6.25 * height_cm - 5 * age_years;
  return sex === "male" ? base + 5 : base - 161;
}

export function tdee(input: BmrInput, activity: ActivityLevel): number {
  return mifflinStJeor(input) * ACTIVITY_FACTORS[activity];
}

export interface TargetSuggestion {
  bmr_kcal: number;
  tdee_kcal: number;
  target_kcal: number;
  target_protein_g: number;
  target_fat_g: number;
  target_carbs_g: number;
  daily_deficit_kcal: number;
}

export function suggestTargets(
  input: BmrInput,
  activity: ActivityLevel,
  options: { weekly_loss_kg?: number; protein_g_per_kg?: number; fat_pct?: number } = {},
): TargetSuggestion {
  const { weekly_loss_kg = 0.5, protein_g_per_kg = 1.8, fat_pct = 0.25 } = options;
  const bmr_kcal = Math.round(mifflinStJeor(input));
  const tdee_kcal = Math.round(tdee(input, activity));
  const daily_deficit_kcal = Math.round((weekly_loss_kg * 7700) / 7);
  const target_kcal = Math.max(1200, tdee_kcal - daily_deficit_kcal);

  const target_protein_g = Math.round(protein_g_per_kg * input.weight_kg);
  const target_fat_g = Math.round((fat_pct * target_kcal) / 9);
  const protein_kcal = target_protein_g * 4;
  const fat_kcal = target_fat_g * 9;
  const target_carbs_g = Math.max(0, Math.round((target_kcal - protein_kcal - fat_kcal) / 4));

  return {
    bmr_kcal,
    tdee_kcal,
    target_kcal,
    target_protein_g,
    target_fat_g,
    target_carbs_g,
    daily_deficit_kcal,
  };
}
