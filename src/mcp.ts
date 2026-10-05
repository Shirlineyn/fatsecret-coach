import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef, ToolContext } from "./tools/types";
import { authTools } from "./tools/auth";
import { foodTools } from "./tools/food";
import { diaryTools } from "./tools/diary";
import { weightTools } from "./tools/weight";
import { profileTools } from "./tools/profile";
import { favoritesTools } from "./tools/favorites";
import { recipeTools } from "./tools/recipes";
import { coachTools } from "./tools/coach";
import { localFoodTools } from "./tools/local-foods";
import { FatSecretNotAuthorized, FatSecretApiError } from "./fatsecret/client";
import { UnknownUserError } from "./storage/kv";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "fatsecret-coach", version: "0.1.0" };

export const ALL_TOOLS: ToolDef[] = [
  ...authTools,
  ...coachTools,
  ...foodTools,
  ...localFoodTools,
  ...diaryTools,
  ...weightTools,
  ...profileTools,
  ...favoritesTools,
  ...recipeTools,
];

const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const errors = {
  parse: { code: -32700, message: "Parse error" },
  invalidRequest: { code: -32600, message: "Invalid Request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid params" },
  internal: { code: -32603, message: "Internal error" },
};

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: number | string | null, error: { code: number; message: string; data?: unknown }): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error };
}

function describeTool(t: ToolDef): { name: string; description: string; inputSchema: unknown } {
  const schema = zodToJsonSchema(t.inputSchema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, inputSchema: schema };
}

async function dispatch(req: JsonRpcRequest, ctx: ToolContext): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: ALL_TOOLS.map(describeTool) });

    case "tools/call": {
      const params = req.params as { name?: string; arguments?: unknown } | undefined;
      if (!params?.name) return fail(id, errors.invalidParams);
      const tool = TOOLS_BY_NAME.get(params.name);
      if (!tool) return fail(id, { ...errors.methodNotFound, message: `Tool not found: ${params.name}` });

      const parsed = tool.inputSchema.safeParse(params.arguments ?? {});
      if (!parsed.success) {
        return ok(id, {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
        });
      }
      try {
        const result = await tool.handler(parsed.data, ctx);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (e) {
        const text = formatToolError(e);
        return ok(id, { isError: true, content: [{ type: "text", text }] });
      }
    }

    default:
      return fail(id, errors.methodNotFound);
  }
}

function formatToolError(e: unknown): string {
  if (e instanceof FatSecretNotAuthorized) return e.message;
  if (e instanceof UnknownUserError) return e.message;
  if (e instanceof FatSecretApiError) {
    return `FatSecret API error ${e.code}: ${e.detail}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function handleMcp(req: Request, ctx: ToolContext): Promise<Response> {
  if (req.method === "GET") {
    return new Response(null, { status: 405 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(fail(null, errors.parse));
  }

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((r) => dispatch(r as JsonRpcRequest, ctx)))).filter(
      (r): r is JsonRpcResponse => r !== null,
    );
    if (responses.length === 0) return new Response(null, { status: 204 });
    return Response.json(responses);
  }

  const single = await dispatch(body as JsonRpcRequest, ctx);
  if (single === null) return new Response(null, { status: 204 });
  return Response.json(single);
}
