import { z } from "zod";
import type { Env } from "../env";

export interface ToolContext {
  env: Env;
  /** The user_id associated with the bearer token of the current request. */
  requestUser: string;
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<T extends z.ZodTypeAny>(def: {
  name: string;
  title?: string;
  description: string;
  inputSchema: T;
  handler: (args: z.infer<T>, ctx: ToolContext) => Promise<unknown>;
}): ToolDef {
  return def as ToolDef;
}

export function daysSinceEpoch(dateInput?: string | number): number {
  if (typeof dateInput === "number") return dateInput;
  const d = dateInput ? new Date(dateInput) : new Date();
  return Math.floor(d.getTime() / 86400000);
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export type MealType = "breakfast" | "lunch" | "dinner" | "other";
export const mealSchema = z.enum(["breakfast", "lunch", "dinner", "other"]);

export const userSchema = z
  .string()
  .optional()
  .describe(
    "Household member id, as configured in COACH_USERS (call list_users to see them). Omit to use the primary user of the current connector.",
  );
