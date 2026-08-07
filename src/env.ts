export interface Env {
  KV: KVNamespace;

  // vars
  COACH_USER_ID: string;            // fallback default user if bearer is unmapped
  COACH_USERS?: string;              // comma list of allowed users; defaults to [COACH_USER_ID]
  COACH_OAUTH_CLIENT_ID: string;     // primary connector (owner's Claude account)
  COACH_OAUTH_CLIENT_ID_2?: string;  // optional second connector (another member's Claude)
  COACH_OAUTH_USER_2?: string;       // user_id that the second client is primary for
  COACH_REGION?: string;              // FatSecret region code for searches (e.g. "RU", "US")
  COACH_LANGUAGE?: string;            // FatSecret language code (e.g. "ru", "en")

  // secrets
  FATSECRET_CONSUMER_KEY: string;
  FATSECRET_CONSUMER_SECRET: string;
  COACH_OAUTH_CLIENT_SECRET: string;     // for COACH_OAUTH_CLIENT_ID
  COACH_OAUTH_CLIENT_SECRET_2?: string;  // for COACH_OAUTH_CLIENT_ID_2
}
