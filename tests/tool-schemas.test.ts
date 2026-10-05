import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp";
import type { ToolContext } from "../src/tools/types";

// The Anthropic API rejects tool schemas in the draft-04 / OpenAPI 3.0 dialect
// (boolean `exclusiveMinimum`), and Claude silently drops such tools from the
// connector. zod's `.positive()` produced exactly that under target "openApi3",
// so every write tool (create_food_entry, update_weight, set_goals, ...) vanished.
function findBooleanExclusive(node: unknown, path = "$"): string[] {
  if (!node || typeof node !== "object") return [];
  const hits: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof value !== "number") {
      hits.push(`${path}.${key}`);
    }
    hits.push(...findBooleanExclusive(value, `${path}.${key}`));
  }
  return hits;
}

describe("tools/list schemas", () => {
  it("use numeric exclusiveMinimum/exclusiveMaximum and no $ref", async () => {
    const req = new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const res = await handleMcp(req, {} as ToolContext);
    const body = (await res.json()) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    const tools = body.result.tools;
    expect(tools.length).toBeGreaterThan(0);

    for (const t of tools) {
      expect(findBooleanExclusive(t.inputSchema), t.name).toEqual([]);
      expect(JSON.stringify(t.inputSchema), t.name).not.toContain("$ref");
    }
  });
});
