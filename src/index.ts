import type { Env } from "./env";
import { handleMcp } from "./mcp";
import {
  discoveryDocument,
  protectedResourceDocument,
  handleAuthorize,
  handleToken,
  handleRegister,
  verifyBearer,
} from "./oauth/claude-provider";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (url.pathname === "/") {
      return cors(
        Response.json({
          name: "fatsecret-coach",
          status: "ok",
          endpoints: {
            mcp: `${origin}/mcp`,
            authorize: `${origin}/authorize`,
            token: `${origin}/token`,
            discovery: `${origin}/.well-known/oauth-authorization-server`,
          },
        }),
      );
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return cors(discoveryDocument(origin));
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return cors(protectedResourceDocument(origin));
    }
    if (url.pathname === "/register") return cors(await handleRegister(request, env));
    if (url.pathname === "/authorize") return cors(await handleAuthorize(request, env));
    if (url.pathname === "/token") return cors(await handleToken(request, env));

    if (url.pathname === "/mcp") {
      const requestUser = await verifyBearer(request, env);
      if (!requestUser) {
        return cors(
          new Response("Unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            },
          }),
        );
      }
      return cors(await handleMcp(request, { env, requestUser }));
    }

    return cors(new Response("Not Found", { status: 404 }));
  },
};

function cors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, mcp-session-id, mcp-protocol-version",
  );
  headers.set("Access-Control-Expose-Headers", "WWW-Authenticate");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
