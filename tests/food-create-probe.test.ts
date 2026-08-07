import { describe, it } from "vitest";
import { signOAuth1 } from "../src/oauth/fatsecret-oauth1";

declare const process: { env: Record<string, string | undefined> };

const LIVE = !!process.env.FATSECRET_CONSUMER_KEY && !!process.env.FATSECRET_CONSUMER_SECRET;
const d = LIVE ? describe : describe.skip;

async function probe(method: string, params: Record<string, string | number>): Promise<void> {
  const REST = "https://platform.fatsecret.com/rest/server.api";
  const signed = await signOAuth1({
    method: "POST",
    url: REST,
    consumerKey: process.env.FATSECRET_CONSUMER_KEY!,
    consumerSecret: process.env.FATSECRET_CONSUMER_SECRET!,
    bodyParams: { method, format: "json", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) },
  });
  const res = await fetch(signed.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: signed.body,
  });
  const text = await res.text();
  console.log(`[${method}] status=${res.status} body=${text.slice(0, 300)}`);
}

d("FatSecret food.create method probes", () => {
  it("tries common variants of food creation", async () => {
    const sample = {
      food_name: "TestProbeFood2026",
      food_type: "Generic",
      serving_size: "100 g",
      calories: 100,
      protein: 5,
      fat: 3,
      carbohydrate: 12,
    };
    await probe("food.create", sample);
    await probe("food.create.v2", sample);
    await probe("foods.create", sample);
  });
});
