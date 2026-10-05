import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

const ORIGIN = "https://coach.example.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const SECRET = "s3cret-for-tests";

function memoryKV(): KVNamespace {
  const data = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const v = data.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  } as unknown as KVNamespace;
}

let env: Env;
const fetchWorker = (path: string, init?: RequestInit) => worker.fetch(new Request(ORIGIN + path, init), env);

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = "test-verifier-0123456789-0123456789-0123456789";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

async function authorize(challenge: string): Promise<string> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: "claude-connector",
    redirect_uri: REDIRECT,
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const res = await fetchWorker(`/authorize?${q}`);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!).searchParams.get("code")!;
}

function tokenRequest(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fetchWorker("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ grant_type: "authorization_code", redirect_uri: REDIRECT, ...fields }).toString(),
  });
}

beforeEach(() => {
  env = {
    KV: memoryKV(),
    COACH_USER_ID: "alex",
    COACH_USERS: "alex",
    COACH_OAUTH_CLIENT_ID: "claude-connector",
    COACH_OAUTH_CLIENT_SECRET: SECRET,
  } as Env;
});

describe("Claude-facing OAuth", () => {
  it("does not offer dynamic client registration", async () => {
    const meta = (await (await fetchWorker("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBeUndefined();
    expect(meta.token_endpoint_auth_methods_supported).not.toContain("none");
    expect((await fetchWorker("/register", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("refuses a PKCE exchange without the client secret", async () => {
    const { verifier, challenge } = await pkcePair();
    const code = await authorize(challenge);
    const res = await tokenRequest({ code, client_id: "claude-connector", code_verifier: verifier });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });

  it("refuses a wrong client secret", async () => {
    const { verifier, challenge } = await pkcePair();
    const code = await authorize(challenge);
    const res = await tokenRequest({ code, client_id: "claude-connector", client_secret: "guess", code_verifier: verifier });
    expect(res.status).toBe(401);
  });

  it("issues a working bearer for secret + PKCE (post and basic)", async () => {
    const { verifier, challenge } = await pkcePair();

    const viaPost = await tokenRequest({
      code: await authorize(challenge),
      client_id: "claude-connector",
      client_secret: SECRET,
      code_verifier: verifier,
    });
    expect(viaPost.status).toBe(200);

    const viaBasic = await tokenRequest(
      { code: await authorize(challenge), code_verifier: verifier },
      { Authorization: `Basic ${btoa(`claude-connector:${SECRET}`)}` },
    );
    expect(viaBasic.status).toBe(200);

    const { access_token } = (await viaBasic.json()) as { access_token: string };
    const mcp = await fetchWorker("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(200);
  });
});
