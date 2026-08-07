import { z } from "zod";
import { defineTool, userSchema, type ToolDef } from "./types";
import { fs } from "../fatsecret/client";

export const profileTools: ToolDef[] = [
  defineTool({
    name: "get_profile",
    description:
      "Get the FatSecret profile (height, age, sex, activity, goal weight). Defaults to the current bearer's primary user.",
    inputSchema: z.object({ user: userSchema }).strict(),
    handler: ({ user }, { env, requestUser }) =>
      fs.profile(env, "profile.get", {}, user ?? requestUser),
  }),
];
