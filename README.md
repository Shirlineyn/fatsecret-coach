# fatsecret-coach

Remote MCP server для FatSecret на Cloudflare Workers. Один публичный HTTPS-эндпоинт,
к которому подключаются Claude Code (Mac), Claude Desktop, claude.ai и мобильные
приложения Claude — через **Custom Connector**. Логируйте еду, смотрите остаток
БЖУ, ставьте цели по весу, получайте рекомендации блюд.

## Что внутри

31 MCP tool, сгруппированы по доменам:

| Группа | Tools | Auth |
|--------|-------|------|
| Auth | `list_users`, `auth_status`, `start_auth`, `complete_auth` | — |
| Coach | `today_summary`, `range_summary`, `get_goals`, `set_goals`, `set_goals_from_profile`, `suggest_meal` | mixed |
| Food | `search_foods`, `get_food`, `autocomplete_foods` | public |
| Local foods | `add_local_food`, `list_local_foods`, `delete_local_food` | KV only |
| Diary | `get_food_entries`, `get_food_entries_month`, `create_food_entry`, `edit_food_entry`, `delete_food_entry`, `log_shared_meal`, `copy_food_entries` | profile |
| Weight | `update_weight`, `get_weight_month` | profile |
| Profile | `get_profile` | profile |
| Favorites | `get_favorite_foods`, `get_most_eaten_foods`, `get_recently_eaten_foods` | profile |
| Recipes | `search_recipes`, `get_recipe` | public |

`public` — OAuth 1.0 2-legged (только consumer key/secret приложения).
`profile` — OAuth 1.0 3-legged (требует одноразовой авторизации через
`start_auth`/`complete_auth`).
`KV only` — локальная база продуктов в Workers KV, FatSecret не задействован.

> Используется OAuth 1.0 для всего. OAuth 2.0 у FatSecret требует whitelist
> IP-адресов, что несовместимо с Cloudflare Workers (плавающие edge-IP).
> OAuth 1.0 аутентифицирует подписью запроса — IP не важен.

### Локальная база продуктов

`add_local_food` — фолбэк, когда продукта нет в FatSecret: региональные бренды,
позиции меню ресторанов, домашние блюда, которые логируются регулярно. Продукт
кладётся в KV, виден всем членам household и получает `food_id` с префиксом
`local_`, пригодный для `create_food_entry`.

Записи с `local_`-продуктами FatSecret не видит: они лежат в KV как локальный
дневник (макросы пересчитаны на `number_of_units` и закешированы в момент
записи). `today_summary`, `range_summary` и `suggest_meal` складывают оба
дневника, `get_food_entries` отдаёт локальные записи отдельным полем
`local_entries`, `delete_food_entry` удаляет и те и другие. В приложении
FatSecret такие записи не появятся, а `copy_food_entries` их не копирует.
Список ключей KV согласован в конечном счёте, поэтому только что сделанная
запись может попасть в сводку с задержкой до минуты.

## Household mode (multiple users)

Один воркер обслуживает несколько FatSecret-аккаунтов одной семьи / пары. Список
участников задаётся в `wrangler.toml` через `COACH_USERS = "me,partner"`.
`COACH_USER_ID` — fallback-пользователь, если bearer-токен ни с кем не связан.

**Каждый tool принимает опциональный `user`** (пример: `today_summary({user: "partner"})`).
Без него — операция идёт от primary пользователя текущего коннектора. Состояние
(`goals:<user>`, `fs_tokens:<user>`) изолировано: данные не пересекаются между
членами семьи.

**Onboarding нового участника:**
1. Добавь его в `COACH_USERS`, передеплой.
2. В Claude: `start_auth({user: "partner"})` → возвращает URL.
3. Он открывает URL **со своего устройства / в incognito**, логинится в свой
   FatSecret, одобряет, копирует PIN.
4. Присылает PIN тебе → в Claude: `complete_auth({oauth_token: "...", verifier: "..."})`
   (user определяется автоматически из oauth_token).
5. `auth_status({user: "partner"})` → `authorized: true`.

**Discovery текущего состояния:** `list_users` показывает кто настроен, у кого
есть OAuth, кто primary.

**Голосовое использование с телефона** (естественный язык):

| Что говоришь | Что Claude сделает |
|---|---|
| «съел два яйца на завтрак» | create_food_entry для primary user |
| «партнёр съел овсянку» | create_food_entry с user=partner |
| «мы оба съели пиццу 200г» | log_shared_meal — запись обоим, с долями |
| «что сегодня съел партнёр» | today_summary с user=partner |
| «как у меня по калориям» | today_summary для primary |
| «поставь партнёру цель 1700 ккал» | set_goals с user=partner |

> **Доверие в household model:** твой Claude-коннектор имеет полный доступ к
> диете обоих. Второй участник даёт свой PIN добровольно (на этапе onboarding).

### Per-bearer routing (несколько Claude-аккаунтов)

Поддерживается **второй OAuth-клиент** для отдельного Claude-аккаунта члена
семьи. Воркер один, KV один, но каждый bearer-токен мапится на свой
**primary user** — то есть партнёр в своём Claude по умолчанию работает со своим
дневником, а ты в своём — со своим. При этом любой может явно сослаться на
другого через `user`-параметр (для совместных приёмов пищи).

Конфигурация в `wrangler.toml`:

```toml
COACH_OAUTH_CLIENT_ID    = "claude-connector"           # ты: primary=me
COACH_OAUTH_CLIENT_ID_2  = "claude-connector-partner"   # партнёр: primary=partner
COACH_OAUTH_USER_2       = "partner"
```

Secrets:

```bash
wrangler secret put COACH_OAUTH_CLIENT_SECRET     # для первого коннектора
wrangler secret put COACH_OAUTH_CLIENT_SECRET_2   # для второго
```

**Как второй участник подключает коннектор у себя:**

1. В его Claude.ai (или mobile) → Settings → Connectors → `+` → Add custom connector.
2. **MCP Server URL**: тот же `https://fatsecret-coach.<your-sub>.workers.dev/mcp`
3. **OAuth Client ID**: `claude-connector-partner` (значение `COACH_OAUTH_CLIENT_ID_2`)
4. **OAuth Client Secret**: значение `COACH_OAUTH_CLIENT_SECRET_2` (получить у владельца воркера)
5. Жми Connect.
6. После подключения в его Claude: `start_auth` (без user-параметра — defaults к его primary), открыть URL **в его браузере**, PIN → `complete_auth`. Его FS-токены лягут в KV под `fs_tokens:partner`.

**Поведение по умолчанию:**

| Делает | Из твоего Claude → default | Из его Claude → default |
|---|---|---|
| «съел два яйца» | для `me` | для `partner` |
| «съели пиццу вдвоём» | log_shared_meal: `me` + `partner` | то же |
| «что я съел сегодня» | today_summary для `me` | today_summary для `partner` |

Состояние общее: если ты что-то залогировал на `partner`, он это увидит в своём
`today_summary` (и наоборот). FS-аккаунты остаются изолированными — каждый
OAuth-токен к своему профилю на fatsecret.com.

## Установка

Если хочется понять, *как* эта штука устроена, или собрать похожий MCP-сервер
под другой API — читайте [docs/remote-mcp-recipe.md](docs/remote-mcp-recipe.md):
там обобщённый рецепт и список подводных камней. Здесь — только «поднять это».

### 0. Перед началом

- **Аккаунт Cloudflare** (бесплатного плана хватает) — `wrangler login` ниже
  предполагает, что он уже есть. Актуальные лимиты Workers и KV смотрите на
  [cloudflare.com/plans/developer-platform](https://www.cloudflare.com/plans/developer-platform/):
  на free tier лимит на **записи** в KV заметно ниже, чем на чтения, и при
  активном логировании вдвоём в него теоретически можно упереться.
- **Node.js 18+** — `wrangler` ставится локально через `npm install`,
  глобально его тянуть не нужно.
- **Первый `wrangler deploy` попросит зарегистрировать workers.dev-поддомен** —
  это интерактивный вопрос, один раз на аккаунт. Он определит хост вида
  `<worker-name>.<your-sub>.workers.dev`.
- **Планируете сразу двоих?** Тогда на шаге 2 понадобится ещё и
  `COACH_OAUTH_CLIENT_SECRET_2` — см. [Per-bearer routing](#per-bearer-routing-несколько-claude-аккаунтов).
  Настроить второго можно и позже, ничего не ломая.

### 1. Зарегистрировать приложение в FatSecret

1. Создать аккаунт на [platform.fatsecret.com](https://platform.fatsecret.com).
2. **API Keys** → секция OAuth 1.0 → выписать `Consumer Key` и `Consumer Secret`.
3. Включить **profile scope** в настройках приложения (нужно для дневника/веса/профиля).
4. OAuth 2.0 секцию можно не трогать — мы её не используем.

### 2. Cloudflare

```bash
npm install
cp wrangler.toml.example wrangler.toml   # заполнить COACH_USERS и т.д.
npx wrangler login

# Создать KV namespace и подставить выданный id в wrangler.toml
npx wrangler kv namespace create fatsecret_coach

# Записать секреты.
# ВНИМАНИЕ: `wrangler secret put` читает stdin — если запайпить напрямую,
# сгенерированное значение уйдёт навсегда и wrangler его не покажет.
# Сначала печатаем, потом пайпим.
npx wrangler secret put FATSECRET_CONSUMER_KEY
npx wrangler secret put FATSECRET_CONSUMER_SECRET
COACH=$(openssl rand -hex 32) && echo "SAVE THIS: $COACH" \
  && echo "$COACH" | npx wrangler secret put COACH_OAUTH_CLIENT_SECRET

# Деплой
npx wrangler deploy
```

Запомни выданный URL вида `https://fatsecret-coach.<your-sub>.workers.dev`
и значение `$COACH` — оба понадобятся на следующем шаге.

> Деплой из РФ может упираться в DPI на больших multipart-аплоадах
> (`POST api.cloudflare.com/.../workers/scripts/.../versions`): GET-эндпоинты и
> KV работают, а `wrangler deploy` таймаутится. Лечится пуском подсетей
> [cloudflare.com/ips](https://www.cloudflare.com/ips/) через туннель, либо
> Workers Builds из GitHub (деплой на стороне CF).

### 3. Подключить как Custom Connector в Claude

- **claude.ai / Claude mobile**: Settings → Connectors → `+` → Add custom connector.
- **Claude Code**: `claude mcp add --transport http fatsecret https://fatsecret-coach.<your-sub>.workers.dev/mcp`.

Параметры:
- **MCP Server URL**: `https://fatsecret-coach.<your-sub>.workers.dev/mcp`
- **OAuth Client ID**: `claude-connector` (значение `COACH_OAUTH_CLIENT_ID`)
- **OAuth Client Secret**: значение `COACH_OAUTH_CLIENT_SECRET` из шага 2

Claude один раз пройдёт OAuth handshake (вы увидите редирект на свой Worker,
автоодобрение, и обратно), затем коннектор появится как **Connected**.

### 4. Авторизовать FatSecret (один раз)

В любом клиенте Claude:

> Подключись к FatSecret — запусти `start_auth`

Откройте полученный `authorize_url` в браузере, одобрите доступ, скопируйте PIN
и пришлите его обратно:

> PIN: 123456

Claude вызовет `complete_auth` и сохранит токен.

### 5. Поставить цели

> Поставь цели: 1900 ккал, 130 белка, 60 жиров, 200 углеводов. Цель — 78 кг к концу декабря.

Или сразу через профиль:

> Посчитай мои цели на основе профиля FatSecret, активность moderate, хочу терять 0.5 кг в неделю.

## Использование

```
"Съел 200г куриной грудки и салат"
"Что я съел сегодня"
"Сколько калорий осталось"
"Что съесть на ужин"
"Взвесился 88.4"
"Как идёт прогресс к 78 кг"
"Добавь в базу Додстер: 250 ккал, 12 белка, 9 жиров, 30 углеводов на порцию"
```

## Локальная разработка

```bash
cp .dev.vars.example .dev.vars
# заполнить
npm run dev          # wrangler dev на 8787
npm test             # unit-тесты (BMR, агрегация)
npm run typecheck    # tsc --noEmit
```

Live-тесты (`*-live.test.ts`, `*-probe.test.ts`) ходят в реальный FatSecret API и
пропускаются, если нет кредов. Активировать так:

```bash
set -a && . ./.dev.vars && set +a && npm test
```

Проверить, что сервер живой и MCP работает:

```bash
# Health
curl http://localhost:8787/

# Discovery
curl http://localhost:8787/.well-known/oauth-authorization-server
```

## Verification (после деплоя)

1. `curl https://<host>/` → `{ "name": "fatsecret-coach", "status": "ok", … }`.
2. `curl https://<host>/.well-known/oauth-authorization-server` → JSON с
   `authorization_endpoint`, `token_endpoint`, `registration_endpoint`.
3. `curl -i -X POST https://<host>/mcp` → 401 + заголовок `WWW-Authenticate`.
4. В Claude добавлен коннектор → tools/list возвращает 31 инструмент.
5. `auth_status` → `{ authorized: false }`; пройти `start_auth`/`complete_auth`
   → `auth_status` → `{ authorized: true }`.
6. `set_goals({target_kcal: 2000, ...})` → запись в KV
   (`npx wrangler kv key get goals:<user>`).
7. `create_food_entry` → запись появилась в fatsecret.com web UI на сегодняшнюю
   дату.
8. `today_summary` → суммы корректны, `remaining` равно `target - consumed`.
9. На телефоне (Claude iOS) тот же коннектор → видит ту же реальность.

## Архитектура

```
Claude (any client) ──OAuth 2.1──▶ /authorize, /token  (Worker)
Claude ──Bearer──▶ /mcp ─dispatch─▶ tools/*
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
         Workers KV         OAuth 1.0 sign       FatSecret REST API
         (goals, local        (HMAC-SHA1 via       (2-legged + 3-legged)
          foods, fs_tokens)    Web Crypto)
```

`/token` записывает `access_token:<token> → <user_id>`, где `user_id` — primary
того OAuth-клиента, который проходил handshake. `verifyBearer` возвращает его в
`ToolContext.requestUser`, и каждый tool резолвит цель как `args.user ?? requestUser`.

| Файл | Что делает |
|---|---|
| `src/env.ts` | `Env` interface — типы для KV, vars, secrets |
| `src/storage/kv.ts` | Обёртка над KV: goals, local foods, FS-токены, OAuth-state с TTL |
| `src/oauth/claude-provider.ts` | OAuth 2.1 для Claude: discovery, authorize, token, register, verifyBearer |
| `src/oauth/fatsecret-oauth1.ts` | OAuth 1.0 подпись и обмен токенов (Web Crypto HMAC-SHA1) |
| `src/fatsecret/client.ts` | REST-клиент: один путь signed-fetch |
| `src/tools/*.ts` | По файлу на домен; `types.ts` — `ToolDef` + `defineTool` |
| `src/mcp.ts` | JSON-RPC dispatcher: initialize, tools/list, tools/call |
| `src/index.ts` | Worker `fetch`: роутинг по pathname, CORS, верификация Bearer |

`@modelcontextprotocol/sdk` намеренно не используется — его транспорты завязаны
на Node `http.IncomingMessage` и на Workers падают. JSON-RPC слой написан руками
(см. `src/mcp.ts`).

## YAGNI

Не реализовано (намеренно):
- exercise tools (не запрашивались)
- saved meals (избыточно — покрывается local foods + `copy_food_entries`)
- Premier-фичи (NLP, штрихкод, фото-распознавание)
- refresh tokens (access TTL = год; Claude передоговорится через discovery)
- кэширование результатов FatSecret API

Добавить позже по реальному запросу.

## Лицензия и происхождение

MIT (см. [LICENSE](LICENSE)). Список tools'ов и идея HTTP-ремоут-формата вдохновлены
[fliptheweb/fatsecret-mcp](https://github.com/fliptheweb/fatsecret-mcp) (MIT),
но это переписанная реализация под Cloudflare Workers без stdio.
