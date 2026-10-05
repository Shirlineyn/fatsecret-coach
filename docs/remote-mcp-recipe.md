# Remote MCP на Cloudflare Workers — рецепт

Как собрать и задеплоить кастомный MCP-сервер, доступный из любого клиента Claude
(claude.ai web, iOS, Android, Desktop, Code) через **Custom Connector**.

Этот документ — обобщение опыта, полученного при написании `fatsecret-coach`
(этот репозиторий, 31 tool поверх FatSecret API). Здесь нет ничего специфичного
для FatSecret: тот же скелет годится для любого стороннего REST API с OAuth.
Инструкция «поднять именно fatsecret-coach» — в [README](../README.md).

## Когда это нужно

- Хочется пользоваться MCP-сервером **с телефона** (mobile-первый сценарий).
- Состояние должно быть общим между десктопом и мобайлом (общая база, общая авторизация).
- Сервер обёртывает внешний API, у которого есть OAuth и личные данные пользователя.

Если хватает только десктопа — stdio-MCP через `npx some-mcp` проще, удалённый
воркер можно не разворачивать вовсе.

## Архитектура

```
┌────────────────────────────────────────────────────────────┐
│  Claude (любой клиент)                                     │
└────────────────────────┬───────────────────────────────────┘
                         │ Streamable HTTP MCP + OAuth 2.1 Bearer
                         ▼
┌────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                         │
│    /                  — health JSON                        │
│    /.well-known/oauth-authorization-server — discovery     │
│    /.well-known/oauth-protected-resource   — resource      │
│    /authorize  — auto-approve (single user)                │
│    /token      — code → bearer: client secret + PKCE        │
│    /mcp        — JSON-RPC: initialize, tools/list, tools/call│
│                                                            │
│  Workers KV: access_token:*, oauth_code:*, прикладное      │
│  Secrets:    creds внешнего API + COACH_OAUTH_CLIENT_SECRET│
└────────────────────────┬───────────────────────────────────┘
                         │
                         ▼
                  Третий API (REST)
```

## Стек

- **TypeScript** + **Cloudflare Workers** (`wrangler` v3/v4).
- **Workers KV** для долгоживущего состояния (1 namespace на весь проект).
- **zod** + **zod-to-json-schema** для входных схем (отдаются клиенту в `tools/list`).
- **Web Crypto** для OAuth-подписей (HMAC-SHA1 для OAuth 1.0, SHA-256 для PKCE) — никакого Node'ового `crypto` на Workers нет.
- **БЕЗ** `@modelcontextprotocol/sdk` — его транспорты завязаны на Node `http.IncomingMessage`, на Workers падают. JSON-RPC слой пишется руками за ~80 строк (см. [`src/mcp.ts`](../src/mcp.ts)).

## Подводные камни (то, что узнаётся кровью)

1. **SDK не работает на Workers.** Не тащить `@modelcontextprotocol/sdk`. Реализовать MCP как JSON-RPC поверх POST `/mcp`: методы `initialize`, `tools/list`, `tools/call`, плюс игнорировать notifications (`notifications/initialized`).

2. **Anthropic custom connector требует OAuth 2.1**, не просто Bearer header. Минимум: discovery + `/authorize` + `/token`; Client ID и Secret вписываются в Advanced settings коннектора. Однопользователю — auto-approve без UI согласия, statefull код в KV с TTL 10 мин. **Но тогда секрет клиента — единственный замок:** `/token` обязан проверять его на каждом обмене, *в том числе* когда клиент прислал PKCE. PKCE доказывает, что код обменивает тот же, кто его запросил, а не что это вы. В первой версии fatsecret-coach секрет проверялся только без PKCE, а `/register` (DCR) отдавал его любому — по одному URL воркера кто угодно получал доступ к дневникам. DCR с auto-approve не делать вовсе: он по определению выдаёт креды анониму.

3. **PKCE поддержать обязательно** — claude.ai его шлёт. Сравнить `SHA-256(code_verifier)` с сохранённым `code_challenge`.

4. **`/mcp` должен возвращать 401 + `WWW-Authenticate`** со ссылкой на `oauth-protected-resource`, иначе Claude не запускает discovery.

5. **Внешний API с IP whitelist (типа FatSecret OAuth 2.0) на Workers НЕ деплоится** — edge-IP плавают. Лечить через OAuth 1.0 (signature-based, IP-нейтральный), если API поддерживает обе схемы. У FatSecret OAuth 1.0 2-legged покрывает все публичные эндпоинты, 3-legged — личные.

6. **FatSecret OAuth 1.0: параметры в query string / body, не в Authorization header.** Их парсер игнорирует header — выдаёт «Missing required parameter: oauth_consumer_key». Сигнатура та же RFC 5849, только размещение другое. Эталон подписи: [`src/oauth/fatsecret-oauth1.ts`](../src/oauth/fatsecret-oauth1.ts). Мораль шире FatSecret: сверяйте, *где* конкретный вендор ждёт oauth-параметры.

7. **Имена методов в стороннем API** — внимательно сверять. У FatSecret CRUD одной записи — singular (`food_entry.create`), коллекция — plural (`food_entries.get.v2`). Промахнулся → API возвращает код 10 «Unknown method». Правило не без исключений: месяц веса — `weights.get_month.v2`, а `weight.get_month` не существует. Проверять имя дёшево: 2-legged вызов несуществующего метода даёт код 10, существующего профильного — код 2 «Missing oauth_token».

8. **`wrangler secret put` читает stdin** — если запайпить `openssl rand -hex 32 | wrangler secret put X`, значение уйдёт навсегда и `wrangler` его не покажет. Сначала `echo` в переменную, печатай, **потом** пайпь.

9. **Деплой из РФ упирается в DPI** на `POST api.cloudflare.com/.../workers/scripts/.../versions` (большие multipart-аплоады). GET-эндпоинты доходят, KV/login работают, deploy таймаутится 60–80 сек. Решение — пустить подсети [cloudflare.com/ips](https://www.cloudflare.com/ips/) через туннель, либо перейти на Workers Builds из GitHub (билд и деплой на стороне CF).

10. **Не делать токены долгоживущими «навсегда».** В KV `access_token` ставить TTL (год — нормально). Refresh не реализовывать — Claude сам передоговорится при истечении через discovery.

11. **Single-user mode сильно упрощает всё.** Один client_id, один client_secret, никакого UI consent. Multi-user — отдельный слой, см. «Расширения» ниже; закладываться на него заранее не нужно, но и рефакторинг он потребует не катастрофический.

12. **Схемы в `tools/list` — JSON Schema 7, не OpenAPI 3.** `zodToJsonSchema(schema, { target: "openApi3" })` превращает `.positive()` в `exclusiveMinimum: true` (булево, диалект draft-04). API Anthropic такую схему отвергает, и Claude молча выкидывает инструмент из коннектора: остальные работают, ошибки в интерфейсе нет. Генерировать с `{ target: "jsonSchema7", $refStrategy: "none" }` и держать тест на `tools/list` (`tests/tool-schemas.test.ts`).

## Пошаговый рецепт

### 1. Скаффолд

```bash
mkdir my-mcp-coach && cd my-mcp-coach
npm init -y
npm i -D wrangler typescript @cloudflare/workers-types vitest
npm i zod zod-to-json-schema
```

`wrangler.toml`:
```toml
name = "my-mcp-coach"
main = "src/index.ts"
compatibility_date = "2026-01-15"

[vars]
COACH_USER_ID = "me"
COACH_OAUTH_CLIENT_ID = "claude-connector"

[[kv_namespaces]]
binding = "KV"
id = "REPLACE_ME"
```

`tsconfig.json` — стандартный для Workers (target ES2022, types `@cloudflare/workers-types`).

### 2. Слои кода

| Файл | Что делает |
|---|---|
| `src/env.ts` | `Env` interface — типы для KV, vars, secrets |
| `src/storage/kv.ts` | Обёртка над KV: типизированные get/put для прикладных ключей + OAuth-state с TTL |
| `src/oauth/claude-provider.ts` | OAuth 2.1 для Claude: discovery, authorize, token (с обязательным секретом клиента), verifyBearer |
| `src/oauth/<vendor>-oauth.ts` | Подпись/обмен токенов внешнего API (Web Crypto HMAC) |
| `src/<vendor>/client.ts` | REST-клиент: один путь signed-fetch |
| `src/tools/<domain>.ts` | По файлу на домен. Каждый tool: `name`, `description`, `inputSchema` (zod), `handler` |
| `src/tools/types.ts` | `ToolDef` interface, `defineTool` helper, общие zod-схемы |
| `src/mcp.ts` | JSON-RPC dispatcher: initialize, tools/list (через zod-to-json-schema), tools/call |
| `src/index.ts` | Worker `fetch` handler: роутинг по pathname, CORS, верификация Bearer |

### 3. OAuth 2.1 для Claude (минимум)

`/.well-known/oauth-authorization-server` отдаёт JSON со списком endpoint'ов и
`code_challenge_methods_supported: ["S256"]`. `/authorize` валидирует `client_id`,
генерит код, кладёт в KV `{client_id, code_challenge, code_challenge_method,
redirect_uri}` с TTL 10 мин, редиректит на `redirect_uri?code=X&state=Y`.
`/token` достаёт код, проверяет PKCE (`SHA-256(code_verifier) == code_challenge`)
или `client_secret`, выдаёт случайный access_token, кладёт
`access_token:<token>` → `<user_id>` в KV с TTL год. `/mcp` достаёт
`Authorization: Bearer X`, проверяет KV — если нет, 401 + `WWW-Authenticate`.

### 4. MCP JSON-RPC (минимум)

```ts
switch (req.method) {
  case "initialize": return ok({ protocolVersion: "2024-11-05",
                                capabilities: { tools: {} },
                                serverInfo: { name, version } });
  case "notifications/initialized": return null;
  case "tools/list": return ok({ tools: ALL_TOOLS.map(t => ({
    name: t.name, description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema)
  }))});
  case "tools/call": {
    const tool = TOOLS_BY_NAME.get(params.name);
    const parsed = tool.inputSchema.safeParse(params.arguments);
    const result = await tool.handler(parsed.data, { env });
    return ok({ content: [{type:"text", text: JSON.stringify(result)}],
                structuredContent: result });
  }
}
```

Ошибки tool'а возвращать как `{isError: true, content: [...]}`, **не** как
JSON-RPC error — это user-facing текст, который Claude должен показать и
осмыслить, а не трактовать как сбой протокола.

### 5. Тесты

Чистые функции (агрегация, BMR/расчёты) — обычным vitest без сети.
OAuth-подпись и REST-вызовы — отдельным `*-live.test.ts`, который сам себя
пропускает (`describe.skip`), если в окружении нет кредов; активируется так:

```bash
set -a && . ./.dev.vars && set +a && npm test
```

### 6. Деплой

```bash
# 0. Если деплой упирается в DPI (см. камень 9) — поднять туннель
# 1. Логин
npx wrangler login

# 2. KV namespace; id из вывода → подставить в wrangler.toml
npx wrangler kv namespace create my_coach

# 3. Секреты — ОБЯЗАТЕЛЬНО распечатать перед pipe (см. камень 8)
echo "<vendor-consumer-key>"    | npx wrangler secret put VENDOR_CONSUMER_KEY
echo "<vendor-consumer-secret>" | npx wrangler secret put VENDOR_CONSUMER_SECRET
COACH=$(openssl rand -hex 32) && echo "SAVE: $COACH" \
  && echo "$COACH" | npx wrangler secret put COACH_OAUTH_CLIENT_SECRET

# 4. Деплой
npx wrangler deploy
```

`wrangler` напечатает URL вида `https://my-mcp-coach.<sub>.workers.dev`.
**Сохрани его и `$COACH`** — оба понадобятся при подключении.

### 7. Подключение в Claude

**claude.ai / mobile:** Settings → Connectors → `+` → Add custom connector →
имя любое, URL `https://<host>/mcp`, Client ID = `claude-connector`,
Client Secret = `$COACH`. Жми Connect — Anthropic делает OAuth handshake тихо в
фоне, статус **Connected**.

**Claude Code:** `claude mcp add --transport http my-coach https://<host>/mcp` —
браузер откроет авторизацию.

После подключения вендорские профильные tool'ы первый раз ответят «not
authorized» и попросят пройти OAuth у вендора (через `start_auth`/`complete_auth`
или аналог). Один раз, токены ложатся в KV.

## Verification после деплоя

| Шаг | Команда | Ожидание |
|---|---|---|
| Health | `curl https://<host>/` | JSON `{name, status:"ok", endpoints:{...}}` |
| Discovery | `curl https://<host>/.well-known/oauth-authorization-server` | JSON с authorization/token endpoints |
| 401 без токена | `curl -i https://<host>/mcp -X POST` | 401 + `WWW-Authenticate` |
| Connected в Claude | UI → Connectors | зелёный «Connected» |
| `tools/list` | спросить в Claude «какие тулы у тебя есть из X» | список tool'ов |
| Profile-вызов | вызвать любой profile-tool | `not authorized` + ссылка на start_auth |
| После `complete_auth` | повторный вызов | реальные данные |
| Sync с мобайлом | повторить вызов с телефона | те же данные |

## Известные расширения, если они понадобятся

- **Multi-user (household mode + per-bearer routing)** — реализовано в этом
  репозитории. Два слоя:
  1. *Household mode:* `COACH_USERS = "me,partner"` в env + `userOverride?` в
     `storage(env, override)`. Все tool'ы принимают `user: z.string().optional()`.
     Валидация в `resolveUser()`.
  2. *Per-bearer routing:* `COACH_OAUTH_CLIENT_ID_2` + `COACH_OAUTH_USER_2` +
     `COACH_OAUTH_CLIENT_SECRET_2`. Helper `getClients(env)` возвращает массив
     `{client_id, client_secret, user_id}`. `/token` пишет
     `access_token:<token> → <user_id>` с user_id того клиента, который проходил
     handshake. `verifyBearer` возвращает `user_id`, прокидывается в
     `ToolContext.requestUser`. Каждый tool: `args.user ?? ctx.requestUser` — свой
     Claude-аккаунт по дефолту работает со своим primary, но может явно сослаться
     на другого участника через `user`-параметр. Один KV — общее состояние, разные
     вендорские токены — изолированные аккаунты.
- **Refresh tokens** — добавить `refresh_token` в `/token`, реализовать
  `grant_type=refresh_token`. Имеет смысл, если access TTL делать коротким.
- **Streamable HTTP с SSE** — для server-initiated notifications (например,
  push «истёк токен»). Поверх Worker `Response.body` через `ReadableStream`.
- **Workers Builds через GitHub** — деплой не с локалки, а из git: пушишь → CF
  сама билдит. Заодно обходит проблему из камня 9.

## Ссылки

- [Anthropic — Custom Connectors using Remote MCP](https://support.claude.com/en/articles/11176164-pre-built-integrations-using-remote-mcp)
- [MCP Spec — Streamable HTTP transport](https://modelcontextprotocol.io/specification)
- [Cloudflare — Workers KV docs](https://developers.cloudflare.com/kv/)
- [Cloudflare — планы и лимиты Developer Platform](https://www.cloudflare.com/plans/developer-platform/)
