import type { Env } from "../env";
import { storage, listUsers } from "../storage/kv";

const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 365;

interface OAuthClient {
  client_id: string;
  client_secret: string;
  user_id: string;
}

function getClients(env: Env): OAuthClient[] {
  const clients: OAuthClient[] = [
    {
      client_id: env.COACH_OAUTH_CLIENT_ID,
      client_secret: env.COACH_OAUTH_CLIENT_SECRET,
      user_id: env.COACH_USER_ID,
    },
  ];
  if (env.COACH_OAUTH_CLIENT_ID_2 && env.COACH_OAUTH_CLIENT_SECRET_2 && env.COACH_OAUTH_USER_2) {
    clients.push({
      client_id: env.COACH_OAUTH_CLIENT_ID_2,
      client_secret: env.COACH_OAUTH_CLIENT_SECRET_2,
      user_id: env.COACH_OAUTH_USER_2,
    });
  }
  return clients;
}

function findClient(env: Env, clientId: string | null): OAuthClient | undefined {
  if (!clientId) return undefined;
  return getClients(env).find((c) => c.client_id === clientId);
}

function randomString(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function sha256Base64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let binary = "";
  const arr = new Uint8Array(digest);
  for (let i = 0; i < arr.byteLength; i++) binary += String.fromCharCode(arr[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function discoveryDocument(origin: string): Response {
  const body = {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    scopes_supported: ["mcp"],
  };
  return Response.json(body);
}

export function protectedResourceDocument(origin: string): Response {
  const body = {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  };
  return Response.json(body);
}

export async function handleRegister(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  // DCR returns the primary client. Secondary clients are configured out-of-band
  // (operator gives them to a household member who adds the connector manually).
  return Response.json({
    client_id: env.COACH_OAUTH_CLIENT_ID,
    client_secret: env.COACH_OAUTH_CLIENT_SECRET,
    token_endpoint_auth_method: "client_secret_post",
  });
}

export async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const params = url.searchParams;
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? undefined;
  const codeChallengeMethod = params.get("code_challenge_method") ?? undefined;
  const responseType = params.get("response_type");

  if (responseType !== "code") return new Response("unsupported_response_type", { status: 400 });
  const client = findClient(env, clientId);
  if (!client) return new Response("invalid_client", { status: 400 });
  if (!redirectUri) return new Response("missing redirect_uri", { status: 400 });

  const code = randomString();
  await storage(env).putOAuthCode(code, {
    client_id: client.client_id,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    redirect_uri: redirectUri,
    created_at: new Date().toISOString(),
  });

  const dest = new URL(redirectUri);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);
  return Response.redirect(dest.toString(), 302);
}

export async function handleToken(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = new URLSearchParams(await req.text());
  const grantType = form.get("grant_type");
  if (grantType !== "authorization_code") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  const code = form.get("code");
  const clientId = form.get("client_id");
  const clientSecret = form.get("client_secret");
  const codeVerifier = form.get("code_verifier");
  const redirectUri = form.get("redirect_uri");

  if (!code) return Response.json({ error: "invalid_request" }, { status: 400 });
  const entry = await storage(env).takeOAuthCode(code);
  if (!entry) return Response.json({ error: "invalid_grant" }, { status: 400 });

  const client = findClient(env, clientId);
  if (!client || entry.client_id !== client.client_id) {
    return Response.json({ error: "invalid_client" }, { status: 400 });
  }
  if (redirectUri !== entry.redirect_uri) {
    return Response.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, { status: 400 });
  }

  const usingPkce = !!entry.code_challenge;
  if (usingPkce) {
    if (!codeVerifier) return Response.json({ error: "invalid_grant", error_description: "missing code_verifier" }, { status: 400 });
    const method = entry.code_challenge_method ?? "plain";
    const computed = method === "S256" ? await sha256Base64Url(codeVerifier) : codeVerifier;
    if (computed !== entry.code_challenge) {
      return Response.json({ error: "invalid_grant", error_description: "code_verifier mismatch" }, { status: 400 });
    }
  } else {
    if (clientSecret !== client.client_secret) {
      return Response.json({ error: "invalid_client" }, { status: 400 });
    }
  }

  const accessToken = randomString();
  await env.KV.put(`access_token:${accessToken}`, client.user_id, { expirationTtl: ACCESS_TOKEN_TTL });

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    scope: "mcp",
  });
}

export async function verifyBearer(req: Request, env: Env): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const token = m[1]!;
  const userId = await env.KV.get(`access_token:${token}`);
  if (!userId) return null;
  const allowed = listUsers(env);
  return allowed.includes(userId) ? userId : null;
}
