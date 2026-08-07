import { describe, it } from "vitest";
import { signOAuth1 } from "../src/oauth/fatsecret-oauth1";

declare const process: { env: Record<string, string | undefined> };

const LIVE = !!process.env.FATSECRET_CONSUMER_KEY && !!process.env.FATSECRET_CONSUMER_SECRET;
const d = LIVE ? describe : describe.skip;

async function probe(barcode: string, label: string): Promise<void> {
  const REST = "https://platform.fatsecret.com/rest/server.api";
  const signed = await signOAuth1({
    method: "POST",
    url: REST,
    consumerKey: process.env.FATSECRET_CONSUMER_KEY!,
    consumerSecret: process.env.FATSECRET_CONSUMER_SECRET!,
    bodyParams: { method: "food.find_id_for_barcode", barcode, format: "json" },
  });
  const res = await fetch(signed.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: signed.body,
  });
  const text = await res.text();
  console.log(`[${label}] barcode=${barcode} status=${res.status} body=${text.slice(0, 300)}`);
}

d("FatSecret barcode lookup", () => {
  it("probes several barcodes on Basic tier", async () => {
    await probe("5449000000996", "Coca-Cola 330ml (BE)");
    await probe("4607034749385", "RU 460-prefix random");
    await probe("0028400064057", "Lay's UPC US");
    await probe("4810057000019", "BY beer (Krinitsa)");
  });
});
