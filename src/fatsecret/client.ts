import type { Env } from "../env";
import { signOAuth1 } from "../oauth/fatsecret-oauth1";
import { storage } from "../storage/kv";

const REST_URL = "https://platform.fatsecret.com/rest/server.api";

export class FatSecretNotAuthorized extends Error {
  constructor(public userId: string) {
    super(
      `FatSecret profile token missing for user '${userId}'. Call start_auth({user: "${userId}"}) and complete_auth first.`,
    );
    this.name = "FatSecretNotAuthorized";
  }
}

export class FatSecretApiError extends Error {
  constructor(
    public code: number,
    public detail: string,
  ) {
    super(`FatSecret API error ${code}: ${detail}`);
    this.name = "FatSecretApiError";
  }
}

export type ApiParams = Record<string, string | number | boolean | undefined>;

function buildParams(method: string, params: ApiParams, env?: Env): Record<string, string> {
  const result: Record<string, string> = { method, format: "json" };
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    result[k] = String(v);
  }
  // Inject region/language defaults from env unless caller already set them.
  if (env) {
    if (env.COACH_REGION && !("region" in result)) result.region = env.COACH_REGION;
    if (env.COACH_LANGUAGE && !("language" in result)) result.language = env.COACH_LANGUAGE;
  }
  return result;
}

async function postSigned(
  env: Env,
  bodyParams: Record<string, string>,
  userToken?: { token: string; secret: string },
): Promise<unknown> {
  const signed = await signOAuth1({
    method: "POST",
    url: REST_URL,
    consumerKey: env.FATSECRET_CONSUMER_KEY,
    consumerSecret: env.FATSECRET_CONSUMER_SECRET,
    token: userToken?.token,
    tokenSecret: userToken?.secret,
    bodyParams,
  });

  const res = await fetch(signed.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: signed.body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FatSecret HTTP ${res.status}: ${text}`);
  return parseAndCheck(text);
}

async function callPublic(env: Env, method: string, params: ApiParams): Promise<unknown> {
  return postSigned(env, buildParams(method, params, env));
}

async function callProfile(
  env: Env,
  method: string,
  params: ApiParams,
  userOverride?: string,
): Promise<unknown> {
  const store = storage(env, userOverride);
  const tokens = await store.getFsTokens();
  if (!tokens) throw new FatSecretNotAuthorized(store.userId);
  // Profile-scope calls (diary CRUD, weight, profile) do not take region/language.
  return postSigned(env, buildParams(method, params), {
    token: tokens.oauth_token,
    secret: tokens.oauth_token_secret,
  });
}

function parseAndCheck(text: string): unknown {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`FatSecret returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (typeof json === "object" && json !== null && "error" in json) {
    const err = (json as { error: { code: number; message: string } }).error;
    throw new FatSecretApiError(err.code, err.message);
  }
  return json;
}

export const fs = {
  public: callPublic,
  profile: callProfile,
};
