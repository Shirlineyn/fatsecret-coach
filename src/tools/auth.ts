import { z } from "zod";
import { defineTool, userSchema, type ToolDef } from "./types";
import { startFatSecretAuth, completeFatSecretAuth } from "../oauth/fatsecret-oauth1";
import { storage, listUsers } from "../storage/kv";

export const authTools: ToolDef[] = [
  defineTool({
    name: "list_users",
    description:
      "List all household members configured on this MCP, with their FatSecret authorization status, and identify the current request's primary user (from the bearer token).",
    inputSchema: z.object({}).strict(),
    handler: async (_args, { env, requestUser }) => {
      const users = listUsers(env);
      const statuses = await Promise.all(
        users.map(async (u) => {
          const tokens = await storage(env, u).getFsTokens();
          return {
            user: u,
            primary_for_this_bearer: u === requestUser,
            household_default: u === env.COACH_USER_ID,
            authorized: !!tokens,
            saved_at: tokens?.saved_at,
          };
        }),
      );
      return { users: statuses, request_primary_user: requestUser };
    },
  }),

  defineTool({
    name: "auth_status",
    description:
      "Check whether a household member's FatSecret account is currently authorized. Defaults to the current bearer's primary user.",
    inputSchema: z.object({ user: userSchema }).strict(),
    handler: async ({ user }, { env, requestUser }) => {
      const store = storage(env, user ?? requestUser);
      const tokens = await store.getFsTokens();
      return tokens
        ? { user: store.userId, authorized: true, saved_at: tokens.saved_at }
        : {
            user: store.userId,
            authorized: false,
            hint: `Call start_auth({user: "${store.userId}"}) to begin the OAuth flow.`,
          };
    },
  }),

  defineTool({
    name: "start_auth",
    description:
      "Begin the FatSecret OAuth flow for a household member. Defaults to the current bearer's primary user. Returns authorize_url the member must open in a browser; after they approve, the PIN goes to complete_auth.",
    inputSchema: z.object({ user: userSchema }).strict(),
    handler: async ({ user }, { env, requestUser }) => {
      const result = await startFatSecretAuth(env, user ?? requestUser);
      return {
        ...result,
        next_step: `Open authorize_url, approve, copy the PIN, then call complete_auth({oauth_token: "${result.oauth_token}", verifier: "<PIN>"}). The token will be saved for user '${result.user_for}'.`,
      };
    },
  }),

  defineTool({
    name: "complete_auth",
    description:
      "Finish the FatSecret OAuth flow by exchanging the PIN for a long-lived access token. The user is inferred from the oauth_token (stored when start_auth was called).",
    inputSchema: z
      .object({
        oauth_token: z.string().describe("oauth_token returned by start_auth"),
        verifier: z.string().describe("PIN/verifier from FatSecret consent page"),
      })
      .strict(),
    handler: async ({ oauth_token, verifier }, { env }) => {
      const result = await completeFatSecretAuth(env, oauth_token, verifier);
      return { authorized: true, user: result.user_for };
    },
  }),
];
