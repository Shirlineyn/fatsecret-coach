import type { Env } from "../env";
import { storage } from "../storage/kv";
import type { FsTokens } from "../storage/kv";

const REQUEST_TOKEN_URL = "https://authentication.fatsecret.com/oauth/request_token";
const AUTHORIZE_URL = "https://authentication.fatsecret.com/oauth/authorize";
const ACCESS_TOKEN_URL = "https://authentication.fatsecret.com/oauth/access_token";

function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  let binary = "";
  const bytes = new Uint8Array(sigBytes);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function randomString(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export interface SignParams {
  method: "GET" | "POST";
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  extraOAuthParams?: Record<string, string>;
  bodyParams?: Record<string, string>;
}

export interface SignedRequest {
  url: string;
  body: string | null;
}

export async function signOAuth1(p: SignParams): Promise<SignedRequest> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: p.consumerKey,
    oauth_nonce: randomString(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
    ...(p.token ? { oauth_token: p.token } : {}),
    ...(p.extraOAuthParams ?? {}),
  };

  const allParams: Record<string, string> = { ...oauthParams, ...(p.bodyParams ?? {}) };

  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k]!)}`)
    .join("&");

  const baseString = [p.method, percentEncode(p.url), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(p.consumerSecret)}&${percentEncode(p.tokenSecret ?? "")}`;
  const signature = await hmacSha1Base64(signingKey, baseString);

  const signedParams: Record<string, string> = { ...allParams, oauth_signature: signature };

  if (p.method === "GET") {
    const qs = Object.keys(signedParams)
      .sort()
      .map((k) => `${percentEncode(k)}=${percentEncode(signedParams[k]!)}`)
      .join("&");
    const url = p.url.includes("?") ? `${p.url}&${qs}` : `${p.url}?${qs}`;
    return { url, body: null };
  }

  const body = Object.keys(signedParams)
    .map((k) => `${percentEncode(k)}=${percentEncode(signedParams[k]!)}`)
    .join("&");
  return { url: p.url, body };
}

function parseQuery(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    out[decodeURIComponent(k!)] = decodeURIComponent(v);
  }
  return out;
}

export interface StartAuthResult {
  authorize_url: string;
  oauth_token: string;
  user_for: string;
}

export async function startFatSecretAuth(env: Env, userOverride?: string): Promise<StartAuthResult> {
  const store = storage(env, userOverride);
  const signed = await signOAuth1({
    method: "GET",
    url: REQUEST_TOKEN_URL,
    consumerKey: env.FATSECRET_CONSUMER_KEY,
    consumerSecret: env.FATSECRET_CONSUMER_SECRET,
    extraOAuthParams: { oauth_callback: "oob" },
  });

  const res = await fetch(signed.url);
  const text = await res.text();
  if (!res.ok) throw new Error(`request_token failed: ${res.status} ${text}`);

  const parsed = parseQuery(text);
  const token = parsed.oauth_token;
  const secret = parsed.oauth_token_secret;
  if (!token || !secret) throw new Error(`request_token bad payload: ${text}`);

  await store.putFsRequestToken(token, {
    oauth_token: token,
    oauth_token_secret: secret,
    created_at: new Date().toISOString(),
    user_for: store.userId,
  });

  const authorize_url = `${AUTHORIZE_URL}?oauth_token=${encodeURIComponent(token)}`;
  return { authorize_url, oauth_token: token, user_for: store.userId };
}

export interface CompleteAuthResult {
  user_for: string;
}

export async function completeFatSecretAuth(
  env: Env,
  oauthToken: string,
  verifier: string,
): Promise<CompleteAuthResult> {
  const tmpStore = storage(env);
  const req = await tmpStore.takeFsRequestToken(oauthToken);
  if (!req) throw new Error("Unknown or expired oauth_token. Call start_auth again.");

  const signed = await signOAuth1({
    method: "GET",
    url: ACCESS_TOKEN_URL,
    consumerKey: env.FATSECRET_CONSUMER_KEY,
    consumerSecret: env.FATSECRET_CONSUMER_SECRET,
    token: req.oauth_token,
    tokenSecret: req.oauth_token_secret,
    extraOAuthParams: { oauth_verifier: verifier },
  });

  const res = await fetch(signed.url);
  const text = await res.text();
  if (!res.ok) throw new Error(`access_token failed: ${res.status} ${text}`);

  const parsed = parseQuery(text);
  const token = parsed.oauth_token;
  const secret = parsed.oauth_token_secret;
  if (!token || !secret) throw new Error(`access_token bad payload: ${text}`);

  const tokens: FsTokens = {
    oauth_token: token,
    oauth_token_secret: secret,
    saved_at: new Date().toISOString(),
  };
  await storage(env, req.user_for).setFsTokens(tokens);
  return { user_for: req.user_for };
}
