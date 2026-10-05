import { z } from "zod";
import { defineTool, daysSinceEpoch, userSchema, type ToolDef } from "./types";
import { fs } from "../fatsecret/client";

export const weightTools: ToolDef[] = [
  defineTool({
    name: "update_weight",
    description: "Record a body weight measurement. Defaults to the current bearer's primary user.",
    inputSchema: z
      .object({
        user: userSchema,
        current_weight_kg: z.number().positive(),
        date: z.string().optional().describe("ISO date YYYY-MM-DD; defaults to today."),
        goal_weight_kg: z.number().positive().optional(),
        weight_type: z.enum(["kg", "lb"]).optional().default("kg"),
      })
      .strict(),
    handler: ({ user, current_weight_kg, date, goal_weight_kg, weight_type }, { env, requestUser }) =>
      fs.profile(
        env,
        "weight.update",
        {
          current_weight_kg,
          date: daysSinceEpoch(date),
          weight_type,
          ...(goal_weight_kg ? { goal_weight_kg } : {}),
        },
        user ?? requestUser,
      ),
  }),

  defineTool({
    name: "get_weight_month",
    description: "Get a month of weight measurements. Defaults to the current bearer's primary user.",
    inputSchema: z
      .object({
        user: userSchema,
        date: z.string().optional().describe("ISO date YYYY-MM-DD; any day in the desired month. Defaults to today."),
      })
      .strict(),
    handler: ({ user, date }, { env, requestUser }) =>
      fs.profile(env, "weights.get_month.v2", { date: daysSinceEpoch(date) }, user ?? requestUser),
  }),
];
