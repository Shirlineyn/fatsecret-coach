import { beforeEach, describe, expect, it, vi } from "vitest";

// FatSecret is stubbed: its diary is empty, and any write that reaches it is recorded,
// so a test can prove that local_ foods never leave KV.
const fsCalls: string[] = [];
vi.mock("../src/fatsecret/client", () => ({
  fs: {
    profile: vi.fn(async (_env: unknown, method: string) => {
      fsCalls.push(method);
      return method === "food_entries.get.v2" ? { food_entries: null } : {};
    }),
    public: vi.fn(async () => ({})),
  },
  FatSecretNotAuthorized: class extends Error {},
  FatSecretApiError: class extends Error {},
}));

import { handleMcp } from "../src/mcp";
import type { Env } from "../src/env";

/** Just enough of KVNamespace for Storage: json get, put, delete, prefix list. */
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
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace;
}

let env: Env;

async function call(name: string, args: Record<string, unknown>, requestUser = "alex"): Promise<any> {
  const req = new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await (await handleMcp(req, { env, requestUser })).json()) as any;
  const text = body.result.content[0].text;
  if (body.result.isError) throw new Error(text);
  return JSON.parse(text);
}

beforeEach(() => {
  fsCalls.length = 0;
  env = { KV: memoryKV(), COACH_USER_ID: "alex", COACH_USERS: "alex,anya" } as Env;
});

describe("local foods", () => {
  it("are listed in tools/list", async () => {
    const req = new Request("https://example.test/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await (await handleMcp(req, { env, requestUser: "alex" })).json()) as any;
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["add_local_food", "list_local_foods", "delete_local_food"]));
  });

  it("log to the local diary, count in today_summary, and delete", async () => {
    const food = await call("add_local_food", {
      name: "Додстер",
      serving_size: "1 порция",
      calories: 250,
      protein: 12,
      fat: 9,
      carbohydrate: 30,
    });
    expect(food.food_id).toMatch(/^local_/);

    const entry = await call("create_food_entry", {
      food_id: food.food_id,
      food_entry_name: "Додстер x1.5",
      number_of_units: 1.5,
      meal: "lunch",
      date: "2026-10-05",
    });
    expect(entry).toMatchObject({ kcal: 375, protein_g: 18, fat_g: 13.5, carbs_g: 45, date: "2026-10-05" });
    expect(fsCalls).not.toContain("food_entry.create");

    const day = await call("today_summary", { date: "2026-10-05" });
    expect(day.consumed).toEqual({ kcal: 375, protein_g: 18, fat_g: 13.5, carbs_g: 45 });
    expect(day.by_meal.lunch[0]).toMatchObject({ name: "Додстер x1.5", food_entry_id: entry.entry_id });

    const raw = await call("get_food_entries", { date: "2026-10-05" });
    expect(raw.local_entries).toHaveLength(1);

    await call("delete_food_entry", { food_entry_id: entry.entry_id });
    expect(fsCalls).not.toContain("food_entry.delete");
    const after = await call("today_summary", { date: "2026-10-05" });
    expect(after.consumed.kcal).toBe(0);
  });

  it("keep each member's diary separate", async () => {
    const food = await call("add_local_food", {
      name: "Сырник",
      serving_size: "1 шт.",
      calories: 100,
      protein: 7,
      fat: 5,
      carbohydrate: 8,
    });
    await call("log_shared_meal", {
      meal: "breakfast",
      date: "2026-10-05",
      ingredients: [{ food_id: food.food_id, total_units: 4, name: "Сырники" }],
      shares: { alex: 0.75, anya: 0.25 },
    });
    expect((await call("today_summary", { date: "2026-10-05" })).consumed.kcal).toBe(300);
    expect((await call("today_summary", { date: "2026-10-05", user: "anya" })).consumed.kcal).toBe(100);
  });

  it("still require serving_id for FatSecret foods", async () => {
    await expect(
      call("create_food_entry", { food_id: "59231", food_entry_name: "Cottage cheese", number_of_units: 1, meal: "other" }),
    ).rejects.toThrow(/serving_id is required/);
  });
});
