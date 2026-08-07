import { describe, it } from "vitest";
import { signOAuth1 } from "../src/oauth/fatsecret-oauth1";

declare const process: { env: Record<string, string | undefined> };

const LIVE = !!process.env.FATSECRET_CONSUMER_KEY && !!process.env.FATSECRET_CONSUMER_SECRET;
const d = LIVE ? describe : describe.skip;

async function probe(label: string, query: string, region?: string, language?: string): Promise<void> {
  const REST = "https://platform.fatsecret.com/rest/server.api";
  const params: Record<string, string> = {
    method: "foods.search",
    search_expression: query,
    format: "json",
    max_results: "5",
  };
  if (region) params.region = region;
  if (language) params.language = language;

  const signed = await signOAuth1({
    method: "POST",
    url: REST,
    consumerKey: process.env.FATSECRET_CONSUMER_KEY!,
    consumerSecret: process.env.FATSECRET_CONSUMER_SECRET!,
    bodyParams: params,
  });
  const res = await fetch(signed.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: signed.body,
  });
  const text = await res.text();
  console.log(`\n[${label}] query=${query} region=${region ?? "—"} language=${language ?? "—"} status=${res.status}`);
  try {
    const j = JSON.parse(text);
    if (j?.error) {
      console.log(`  ERROR: ${JSON.stringify(j.error)}`);
      return;
    }
    const totalResults = j?.foods?.total_results ?? "?";
    console.log(`  total_results: ${totalResults}`);
    const foods = j?.foods?.food;
    const arr = Array.isArray(foods) ? foods : foods ? [foods] : [];
    arr.slice(0, 4).forEach((f: { food_name?: string; brand_name?: string; food_description?: string }) =>
      console.log(`  - ${f.food_name}${f.brand_name ? ` (${f.brand_name})` : ""} | ${f.food_description?.slice(0, 60) ?? ""}`),
    );
  } catch {
    console.log(`  raw: ${text.slice(0, 200)}`);
  }
}

d("FatSecret region probe", () => {
  it("compares default vs RU/ru for Russian query", async () => {
    await probe("US, apple", "apple");
    await probe("RU/ru, apple", "apple", "RU", "ru");
    await probe("US, борщ (cyrillic)", "борщ");
    await probe("RU/ru, борщ", "борщ", "RU", "ru");
    await probe("RU/ru, яблоко", "яблоко", "RU", "ru");
    await probe("RU/ru, молоко", "молоко", "RU", "ru");
  });

  it("compares same query in different regions to confirm region works", async () => {
    await probe("FR/fr, pain", "pain", "FR", "fr");
    await probe("US, pain (default)", "pain");
    await probe("DE/de, brot", "brot", "DE", "de");
    await probe("US, brot", "brot");
  });

  it("tries v3 with region", async () => {
    const REST = "https://platform.fatsecret.com/rest/server.api";
    for (const [region, lang] of [[undefined, undefined], ["RU", "ru"], ["FR", "fr"]] as Array<[string?, string?]>) {
      const params: Record<string, string> = { method: "foods.search.v3", search_expression: "apple", format: "json", max_results: "3" };
      if (region) params.region = region;
      if (lang) params.language = lang;
      const signed = await signOAuth1({
        method: "POST", url: REST,
        consumerKey: process.env.FATSECRET_CONSUMER_KEY!, consumerSecret: process.env.FATSECRET_CONSUMER_SECRET!,
        bodyParams: params,
      });
      const res = await fetch(signed.url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: signed.body });
      const text = await res.text();
      console.log(`\n[v3 region=${region ?? "—"}] status=${res.status}`);
      try {
        const j = JSON.parse(text);
        if (j.error) console.log(`  ERROR: ${JSON.stringify(j.error)}`);
        else {
          const foods = j?.foods_search?.results?.food ?? j?.foods?.food;
          const arr = Array.isArray(foods) ? foods : foods ? [foods] : [];
          console.log(`  total_results: ${j?.foods_search?.total_results ?? j?.foods?.total_results ?? "?"}`);
          arr.slice(0, 3).forEach((f: any) => console.log(`  - ${f.food_name}`));
        }
      } catch { console.log(`  raw: ${text.slice(0,200)}`); }
    }
  });
});
