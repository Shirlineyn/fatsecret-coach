import { describe, it, expect } from "vitest";
import { signOAuth1 } from "../src/oauth/fatsecret-oauth1";

declare const process: { env: Record<string, string | undefined> };

const LIVE = !!process.env.FATSECRET_CONSUMER_KEY && !!process.env.FATSECRET_CONSUMER_SECRET;
const d = LIVE ? describe : describe.skip;

d("FatSecret OAuth 1.0 live", () => {
  it("request_token returns oauth_token + oauth_token_secret", async () => {
    const url = "https://authentication.fatsecret.com/oauth/request_token";
    const signed = await signOAuth1({
      method: "GET",
      url,
      consumerKey: process.env.FATSECRET_CONSUMER_KEY!,
      consumerSecret: process.env.FATSECRET_CONSUMER_SECRET!,
      extraOAuthParams: { oauth_callback: "oob" },
    });
    const res = await fetch(signed.url);
    const text = await res.text();
    expect(res.status, `request_token returned ${res.status}: ${text}`).toBe(200);
    expect(text).toMatch(/oauth_token=/);
    expect(text).toMatch(/oauth_token_secret=/);
  });

  it("foods.search works with consumer key/secret only (2-legged)", async () => {
    const REST = "https://platform.fatsecret.com/rest/server.api";
    const signed = await signOAuth1({
      method: "POST",
      url: REST,
      consumerKey: process.env.FATSECRET_CONSUMER_KEY!,
      consumerSecret: process.env.FATSECRET_CONSUMER_SECRET!,
      bodyParams: {
        method: "foods.search",
        search_expression: "chicken breast",
        format: "json",
        max_results: "3",
      },
    });
    const res = await fetch(signed.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: signed.body,
    });
    const json = (await res.json()) as { foods?: { food?: unknown }; error?: unknown };
    expect(res.status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.foods?.food).toBeTruthy();
  });
});
