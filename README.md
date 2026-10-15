# ink360-management (server)

The server behind the ink360 Management app:

- stores the app's data in MySQL (Postgres also works) — one row per lead, per product, and one for settings
- checks the access codes and keeps login sessions (`/api/login`) — codes stored scrambled, never sent to the browser
- answers the app's data requests (`/api/docs`) — logged-in sessions only, and only from the web addresses in `ALLOWED_ORIGINS`
- receives website leads from WPForms (`/api/hooks/wpforms`, protected by `WPFORMS_KEY`)
- has Claude read each new website lead and draft its quote lines (`lib/autoquote.js`, needs `ANTHROPIC_API_KEY`); prices are set by the app from the 2026 matrix, and Ken checks every draft
- stores Ken's QuickBooks product/service list on first start (`config/qb-items.json`), so the app can check each quote line has a QuickBooks item

The app page itself is **not** in this repo — it lives on ink360's domain (`index.html` + `config.js`). Full setup order: `START-HERE.md` in the deploy package.

## Folders

| Path | What |
|---|---|
| `server.js` | entry point: starts the server, sends each address to its route |
| `package.json` | start command and the two database drivers (`mysql2`, `pg`) |
| `config/index.js` | every setting, read from environment variables |
| `lib/store.js` | MySQL or Postgres storage, picked from `DATABASE_URL` (local JSON file when it isn't set — development only); startup self-check |
| `lib/auth.js` | logins: scrypt-hashed codes, sessions that end when the tab closes or after 12 idle hours (only a hash of each token is stored), sign everyone out on code change |
| `lib/http.js` | request/response helpers, allowed domains (CORS) |
| `lib/leads-from-wpforms.js` | turns a WPForms entry into an ink360 lead |
| `lib/autoquote.js` | draft quotes: sends the lead's request text (not email/phone/address) to Claude, turns the answer into quote lines with stated assumptions and questions for the customer |
| `lib/claude.js` | minimal Claude API client (no SDK), retries on busy/overloaded |
| `lib/qb-items.js` | reads the QuickBooks Products and services CSV export; stores it on first start |
| `config/qb-items.json` | Ken's QuickBooks list, 10/15/2026 export (1,212 items) |
| `routes/autoquote.js` | `/api/autoquote` — draft a quote on request from the app |
| `tools/build-qb-items.js` | `npm run qb-items -- export.csv` — rebuild `config/qb-items.json` from a new export |
| `lib/rate-limit.js` | 30 requests/minute per IP on the website endpoint; 10 login tries per 15 minutes |
| `routes/auth.js` | `/api/login`, `/api/session`, `/api/auth/codes` |
| `routes/docs.js` | `/api/docs` — the app's data (login required) |
| `routes/wpforms.js` | `/api/hooks/wpforms` — website leads |
| `routes/health.js` | `/healthz` — status |
| `routes/app-page.js` | `/` — says what the server is (or shows the app locally if `APP_FILE` is set) |
| `tools/run-tests.js` | `npm test` — 26 checks (draft quotes are tested against a stand-in for the Claude API) |
| `tools/generate-key.js` | `npm run make-key` — prints a random `WPFORMS_KEY` |

## Railway variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{MySQL.MYSQL_URL}}` (or `${{Postgres.DATABASE_URL}}` if you use Postgres) |
| `WPFORMS_KEY` | long random key; same value goes in the WPForms webhook header `X-Ink360-Key` |
| `ALLOWED_ORIGINS` | the app's address, `https://ops.ink360.com` (comma-separate several, no trailing slash) |
| `NODE_ENV` | `production` |
| `OWNER_CODE` | Owner (Ken) access code, 3+ characters — used the first time the server starts |
| `BUILDER_CODE` | Builder (Rob) access code, 3+ characters, different from the Owner code |
| `MIN_CODE_LENGTH` | optional: minimum code length (default 3). Raise it, e.g. to 8, when you want longer codes enforced |
| `ANTHROPIC_API_KEY` | turns on draft quotes. Create it in an **ink360-owned** Anthropic Console account (console.anthropic.com → API keys) and set a monthly spend limit there. Never put it in config.js or the repo |
| `AUTO_QUOTE` | optional: `off` = Claude drafts only when someone clicks **Draft with Claude** (default: every new website lead) |
| `ANTHROPIC_MODEL` | optional: model name (default `claude-sonnet-5-5`) |
| `RESET_CODES` | only when a code is lost: `true` re-applies `OWNER_CODE`/`BUILDER_CODE` and signs everyone out. Remove it afterwards |

After the first start, codes changed in the app (Access Codes, Builder only) win over the variables. `PORT` is set by Railway automatically. Database backups / point-in-time recovery are on Railway's Pro plan.

## Addresses

| Method & path | What |
|---|---|
| `GET /healthz` | status: database self-check (`"database":"passed"`), `"logins":"set"`, webhook key set, allowed origins. Returns 503 if the database check failed |
| `POST /api/login` | `{"code": "..."}` → `{"token", "role", "expiresAt"}`; send the token as `Authorization: Bearer <token>` |
| `GET / DELETE /api/session` | who's logged in / log out |
| `POST /api/auth/codes` | `{"owner"?, "builder"?}` — Builder only; ends every other session |
| `GET /api/docs?since=N` | documents changed after sequence N (the app checks every 10 s) — login required |
| `GET/PUT/DELETE /api/docs/{app\|leads\|products}/{id}` | one document; PUT body `{"data": {...}}` |
| `POST /api/hooks/wpforms?form=<name>` | WPForms webhook; header `X-Ink360-Key` |
| `GET /api/autoquote` | is Claude connected (`enabled`, `auto`, `model`) — login required |
| `POST /api/autoquote/{leadId}` | `{"text"?: pasted email, "replace"?: true}` → draft the quote now — login required |

## What happens to each website entry

- New entry → new lead (stage New, source Website form), original entry kept on the lead.
- Same entry again → ignored (by `entry_id`, or by content if no `entry_id` is sent).
- Same email as a lead that's still open → added to that lead's activity, no second lead.
- WPForms "||" values: Address → ship-to (street, city, state, ZIP); checkboxes → "A, B".
- No name, company, email or phone → rejected (422).
- New lead + `ANTHROPIC_API_KEY` set → Claude drafts the quote in the background (5–30 s). The lead shows **Draft quote from Claude — needs your check**. If Claude can't be reached, the lead says so and **Try again** re-runs it.

## What Claude gets and returns

Sent: company, contact's first name, the form answers/message (email, phone, name and address fields are left out), the customer's existing ink360 products (control #, name, bottle), and the QuickBooks bottle list. Returned: flavors, quantities, passes, bottle shape/size/taper, matching QuickBooks bottle item, repeat or new, and questions for the customer. The server fills gaps with stated defaults (1,000 bottles, 1 pass, 750ml round, not tapered), marks them **assumed**, and adds a question for each. Prices and charges are worked out in the app from the matrix and Pricing settings, never by Claude.

## Troubleshooting

| Railway log / response | Meaning | Fix |
|---|---|---|
| `401 Wrong or missing X-Ink360-Key` | header missing or different | same value in WPForms header and `WPFORMS_KEY`; header name exactly `X-Ink360-Key` |
| `503 WPFORMS_KEY is not set` | variable missing | add it in Railway |
| `422 Entry has no name, company, email or phone` | body keys don't match | use the key names in START-HERE.md |
| App says "Can't reach the ink360 server" | wrong address or domain not allowed | `config.js` address = Railway address; `ALLOWED_ORIGINS` = the app's address exactly (https, no slash) |
| `/healthz` shows `"logins":"not set: …"` | `OWNER_CODE`/`BUILDER_CODE` missing, shorter than `MIN_CODE_LENGTH` (3), or the same | fix the variables, redeploy |
| Login says "Too many tries" | 10 wrong codes in 15 minutes from that network | wait 15 minutes |
| Everyone gets logged out after each deploy | `RESET_CODES=true` left on | remove that variable |
| `/healthz` shows `"database":"failed: …"` or 503 | server can't use the database | `DATABASE_URL` must be the reference `${{MySQL.MYSQL_URL}}` (MySQL service in the same project); check the MySQL service is running |
| `/healthz` shows `"draftQuotes":"off …"` | `ANTHROPIC_API_KEY` not set | add it, redeploy |
| Lead says **Couldn’t draft: Claude API 401** | key wrong or revoked | new key in Railway |
| Lead says **Couldn’t draft: Claude API 400 … credit** | Anthropic account out of credit or over its spend limit | add credit in the Anthropic Console |
| Nothing in the logs | WPForms isn't reaching the server | open `<Railway address>/api/hooks/wpforms` in a browser — it should say it's running |

## Local development

```
node server.js                                  # http://localhost:3000, data in ./data/dev-store.json
APP_FILE=../2-domain-file-manager/index.html node server.js   # also show the app at http://localhost:3000
WPFORMS_KEY=test OWNER_CODE=owner-test BUILDER_CODE=builder-test node server.js   # logins + webhook locally
npm test                                        # 26 checks
```

Needs Node 20+.
