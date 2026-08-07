import type { Env } from "../env";

export interface Goals {
  target_kcal: number;
  target_protein_g: number;
  target_fat_g: number;
  target_carbs_g: number;
  weight_kg_target?: number;
  weight_kg_start?: number;
  deadline?: string;
  weekly_loss_kg?: number;
  updated_at: string;
}

export interface FsTokens {
  oauth_token: string;
  oauth_token_secret: string;
  saved_at: string;
}

export interface FsRequestToken {
  oauth_token: string;
  oauth_token_secret: string;
  created_at: string;
  user_for: string;
}

export interface OAuthCode {
  client_id: string;
  code_challenge?: string;
  code_challenge_method?: string;
  redirect_uri: string;
  created_at: string;
}

/** Household-shared food definition kept in our KV. Used when FatSecret has no match. */
export interface LocalFood {
  food_id: string;            // e.g. "local_a1b2c3"
  name: string;
  brand?: string;
  serving_size: string;       // "1 порция", "100 g"
  calories: number;           // per the serving above
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  saturated_fat_g?: number;
  fiber_g?: number;
  sugar_g?: number;
  notes?: string;
  created_by: string;         // user_id
  created_at: string;         // ISO
}

/** Per-user local diary entry. Caches macros at write time. */
export interface LocalEntry {
  entry_id: string;           // "local_<hex>"
  food_id: string;            // points to local_food:<id>
  food_entry_name: string;
  meal: string;
  date: string;               // ISO YYYY-MM-DD
  number_of_units: number;    // scales the local food's serving
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  created_at: string;
}

const TTL_REQUEST_TOKEN = 60 * 30;
const TTL_OAUTH_CODE = 60 * 10;

export class UnknownUserError extends Error {
  constructor(public userId: string, public known: string[]) {
    super(`Unknown user '${userId}'. Allowed: ${known.join(", ")}.`);
    this.name = "UnknownUserError";
  }
}

export function listUsers(env: Env): string[] {
  const raw = env.COACH_USERS;
  if (!raw) return [env.COACH_USER_ID];
  const arr = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return arr.length > 0 ? arr : [env.COACH_USER_ID];
}

export function resolveUser(env: Env, override?: string): string {
  const candidate = override?.trim() || env.COACH_USER_ID;
  const allowed = listUsers(env);
  if (!allowed.includes(candidate)) throw new UnknownUserError(candidate, allowed);
  return candidate;
}

export class Storage {
  constructor(private kv: KVNamespace, public userId: string) {}

  async getGoals(): Promise<Goals | null> {
    return this.kv.get<Goals>(`goals:${this.userId}`, "json");
  }

  async setGoals(goals: Goals): Promise<void> {
    await this.kv.put(`goals:${this.userId}`, JSON.stringify(goals));
  }

  async getFsTokens(): Promise<FsTokens | null> {
    return this.kv.get<FsTokens>(`fs_tokens:${this.userId}`, "json");
  }

  async setFsTokens(tokens: FsTokens): Promise<void> {
    await this.kv.put(`fs_tokens:${this.userId}`, JSON.stringify(tokens));
  }

  async clearFsTokens(): Promise<void> {
    await this.kv.delete(`fs_tokens:${this.userId}`);
  }

  // FS request tokens are keyed by the oauth_token itself (globally unique), not by user.
  // The `user_for` field records which user the eventual access token should be stored under.
  async putFsRequestToken(token: string, value: FsRequestToken): Promise<void> {
    await this.kv.put(`fs_req:${token}`, JSON.stringify(value), {
      expirationTtl: TTL_REQUEST_TOKEN,
    });
  }

  async takeFsRequestToken(token: string): Promise<FsRequestToken | null> {
    const key = `fs_req:${token}`;
    const value = await this.kv.get<FsRequestToken>(key, "json");
    if (value) await this.kv.delete(key);
    return value;
  }

  async putOAuthCode(code: string, value: OAuthCode): Promise<void> {
    await this.kv.put(`oauth_code:${code}`, JSON.stringify(value), {
      expirationTtl: TTL_OAUTH_CODE,
    });
  }

  async takeOAuthCode(code: string): Promise<OAuthCode | null> {
    const key = `oauth_code:${code}`;
    const value = await this.kv.get<OAuthCode>(key, "json");
    if (value) await this.kv.delete(key);
    return value;
  }

  // --- Local foods (household-shared, not scoped to this Storage's userId) ---
  // These read/write via the same KV instance but are not user-scoped.
  async addLocalFood(food: LocalFood): Promise<void> {
    await this.kv.put(`local_food:${food.food_id}`, JSON.stringify(food));
  }

  async getLocalFood(foodId: string): Promise<LocalFood | null> {
    return this.kv.get<LocalFood>(`local_food:${foodId}`, "json");
  }

  async deleteLocalFood(foodId: string): Promise<void> {
    await this.kv.delete(`local_food:${foodId}`);
  }

  async listLocalFoods(): Promise<LocalFood[]> {
    const out: LocalFood[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: "local_food:", cursor });
      for (const k of page.keys) {
        const v = await this.kv.get<LocalFood>(k.name, "json");
        if (v) out.push(v);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }

  // --- Local diary entries (per-user, by date) ---
  private localEntryKey(date: string, entryId: string): string {
    return `local_entry:${this.userId}:${date}:${entryId}`;
  }

  async addLocalEntry(entry: LocalEntry): Promise<void> {
    await this.kv.put(this.localEntryKey(entry.date, entry.entry_id), JSON.stringify(entry));
  }

  async listLocalEntriesForDate(date: string): Promise<LocalEntry[]> {
    const out: LocalEntry[] = [];
    let cursor: string | undefined;
    const prefix = `local_entry:${this.userId}:${date}:`;
    do {
      const page = await this.kv.list({ prefix, cursor });
      for (const k of page.keys) {
        const v = await this.kv.get<LocalEntry>(k.name, "json");
        if (v) out.push(v);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }

  async deleteLocalEntry(date: string, entryId: string): Promise<boolean> {
    const key = this.localEntryKey(date, entryId);
    const existing = await this.kv.get(key);
    if (!existing) return false;
    await this.kv.delete(key);
    return true;
  }
}

export function isLocalId(id: string): boolean {
  return id.startsWith("local_");
}

export function newLocalId(prefix = "local"): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return `${prefix}_${hex}`;
}

export function storage(env: Env, userOverride?: string): Storage {
  return new Storage(env.KV, resolveUser(env, userOverride));
}
