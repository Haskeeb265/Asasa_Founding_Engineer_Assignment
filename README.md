# Asasa Gold Trading Demo

A deployable, credential-free, single-user gold buy/sell demo. The app ships with a
minimal test console at `/` and the full HTTP API it drives.

A reviewer can see the seeded balances, buy gold with PKR or sell gold in grams
or tola, review a 75-second locked quote, wait for Confirm to unlock, and see the
updated balances and receipt. The console also includes a published-price chart,
a runtime guardrail field, and toast notifications.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 App Router, TypeScript, Node runtime on every route |
| Database | Neon Postgres (pooled), `pg` Pool + Drizzle ORM |
| Migrations | drizzle-kit journal, applied by `tsx scripts/apply_migrations.ts` |
| Cache | Upstash Redis REST, optional, with a process-local mirror |
| Money | integer minor units: paisa, microgram, paisa/gram; JS `BigInt`; `bigint` columns |
| Validation | zod at every HTTP boundary |
| Tests | vitest over the pure `domain/` core |
| Source B | local `curl_cffi` Python, or the deployed Vercel Python function |

Postgres is the only authority for whether a trade happened. Redis caches price
snapshots and the fetch claim/cooldown, and is never money.

---

## Local setup

Requirements: Node 20+, Python 3.11+ (only for source B), a Postgres database.

```bash
npm install
python -m pip install curl_cffi

cp .env.example .env.local
# edit DATABASE_URL (Neon pooled) and optionally the Upstash REST variables

npm run db:migrate
npm run db:seed
npm run dev
```

Then open `http://localhost:3000/` for the test console, or
`http://localhost:3000/api/state` for the raw state.

Scripts:

| Script | Purpose |
|---|---|
| `npm test` | 53 vitest unit tests over `domain/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | apply `drizzle/` migrations |
| `npm run db:seed` | insert the three balances and the settings row idempotently |
| `npm run db:generate` | drizzle-kit generate (migrations are checked in) |

### Environment

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon pooled connection string, required |
| `ASASA_DATABASE_URL` | optional override for `DATABASE_URL` when a linked Vercel/Neon integration injects its own value |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | optional; memory fallback when unset. The Vercel-injected `UPSTASH_REDIS_REST_KV_REST_API_*` and `KV_REST_API_*` names are also accepted |
| `GOLDPRICE_FETCH_MODE` | `python`, `remote`, `disabled`; unset ⇒ `remote` on Vercel, otherwise `disabled` |
| `PYTHON_BIN` | default `python` |
| `GOLDPRICE_REMOTE_URL` | only for remote mode without a Vercel URL variable |
| `YAHOO_SYMBOL` | default `GC=F` |

Demo configuration lives in the `settings` table, never in env, so a reviewer
never has to redeploy to change it.

---

## Money and invariants

| Quantity | Storage | Column | Example |
|---|---|---|---|
| PKR | paisa | `bigint` | Rs 49,000.00 → `4_900_000` |
| Gold | microgram | `bigint` | 1.278241 g → `1_278_241` |
| Price | paisa/gram | `bigint` | Rs 32,314.00/g → `3_231_400` |
| Spread | basis points | `integer` | ×1.10 → `11000` |

Rounding happens in exactly two places: ingestion (`domain/units.ts`, where the
float dies) and trade maths (`domain/trade-math.ts`, all integer BigInt).

- Buy with PKR in: `G = floor(A × 1e6 / P)`, then `A = ceil(G × P / 1e6)`
- Buy with grams in: `A = ceil(G × P / 1e6)`
- Sell with grams in: `A = floor(G × P / 1e6)`
- Sell with PKR in: `G = floor(A × 1e6 / P)`, then `A = floor(G × P / 1e6)`

`trades.pkr_is_exact` repeats that formula as a Postgres CHECK, so every receipt
is verifiable in SQL. A PKR-input buy can leave sub-microgram dust in the wallet.

Limits: minimum Rs 1,000 or 0.1 g (compared in the input's own unit), maximum
Rs 1,000,000 notional per trade.

The spread and the reviewer-settable guardrail:

```text
buy  = max(ceil(market × 11000 / 10000), guardrail)
sell = floor(market × 9000 / 10000)
```

The guardrail is an absolute PKR/gram floor on the buy price, default `0` (off).
It is frozen onto the quote and the trade, and never applies to a sell.

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | settle legacy due confirmed quotes; balances, gate, price panel, price history, in-flight quote, 10 receipts, settings |
| GET | `/api/price` | hot price (cache → last recorded cycle); never fetches |
| GET | `/api/db` | read-only mirror: balances, settings, last 25 quotes, 30 prices, 25 trades |
| POST | `/api/quotes` | `{side, input_mode, input, from_quote_id?}` → `201 {quote, price_change_bps, now}` |
| POST | `/api/quotes/:id/confirm` | stage the quote; money moves when the timer ends |
| POST | `/api/quotes/:id/cancel` | cancel an `active` quote at any time, or a `confirmed` quote before its timer |
| GET | `/api/trades/:id` | `{receipt, now}` |
| POST | `/api/demo/:action` | runtime demo controls |

Amounts on the wire are JSON **strings**; JSON numbers are rejected as
`BAD_REQUEST`. Errors use `{ "error": { "code", "message", "hint"?, "detail"? } }`
and the status table in `server/http.ts` (400/404/409/503/500).

Every price response carries `expires_at` plus the server `now`. The client may
calibrate a countdown, but the server is the only judge of when Confirm unlocks.

`GET /api/price` deliberately serves the last recorded cycle even when the gate
currently refuses it; it never fetches. `GET /api/state` withholds the price
(`price: null` + `price_notice`) only for `PRICE_UNAVAILABLE`.

### Quote lifecycle (countdown, then confirm)

```text
(none) ──create──► active ──timer ends──► active, Confirm enabled
                     │                          │
                     ├─ confirm before 0 ──► 409 QUOTE_NOT_READY
                     ├─ cancel ────────────► cancelled
                     └─ confirm at 0 ──────► settled + trade row
```

The countdown is a review hold, not the quote's lifetime. The quote remains on
screen at zero until the user cancels or confirms it. Confirm is refused by the
server before the countdown ends; at zero it claims the quote and settles in one
transaction: conditional claim → `FOR UPDATE` balances → re-validate → apply
deltas → insert the trade with the quote's exact numbers. The quote's `quote_id`
is unique on `trades`, so a second settle can only replay.

If a balance moved after the quote (for example via `set-balance`), settlement
flips the quote to `rejected`, commits no balance change, and returns the typed
`INSUFFICIENT_*` error with the maximum affordable amount. The sweep still
settles any legacy `confirmed` rows whose timer has passed.

---

## Pricing pipeline

Priority **A > B > C**. One named source's number is published; never an average.

| ID | Source | Method |
|---|---|---|
| A | PakGold methodology | `gold-api.com/price/XAU` × `er-api.com` USD/PKR, cached FX for 6 h; no provider clock |
| B | GoldPrice.org | PKR/troy oz via `curl_cffi` with a Chrome fingerprint and same-site `Referer` locally, or the deployed Python function |
| C | Yahoo `GC=F` | `meta.regularMarketPrice` from query1 with query2 fallback, basis-normalised (default 28 bps), uses A's cached FX |

The quorum (`domain/quorum.ts`) applies a 10× sanity gate against the most recent
selected price (deviation D1), then:

- 0 samples: `paused`, nothing published
- 1 sample: accepted as `single_source` (the trading gate then refuses it)
- 2 samples: within threshold ⇒ both accepted, higher priority published; beyond
  threshold ⇒ reject the one further from the anchor (tie goes against the lower
  priority); with no anchor, publish by priority and mark `degraded`
- 3 samples: median arbitrates; accept everything within the threshold of it

Every sample gets a human `reason`, including failures (`HTTP 403`, `timeout`,
`bad payload: price missing`, `disabled (no fetch mode)`).

The trading gate (`server/pricing/settings-like.ts`) is shared by `/api/state` and
`POST /api/quotes`. Available sources are those **switched on now** and accepted
in the snapshot. Two or three available ⇒ tradeable if the price is not older
than `max_price_age_seconds`; one ⇒ refused; zero ⇒ refused; `force_paused` ⇒
`TRADING_PAUSED`. An active demo price override bypasses the availability rules
by itself (deviation D2) and is labelled as an override.

Freshness has two clocks, never conflated:

- `fetch_age_seconds`: age of the cycle that produced the number (the gate)
- `provider_at` / `market_age_seconds`: the provider's own trade timestamp
  (display only). A contributes none.

Price fetching is lazy: cache → fetch claim (`SET NX EX 60`) → one cycle per
claim; failures cool down for 60 s. A best-effort scheduler (`instrumentation.ts`,
every 300 s, guarded by a Redis claim) sweeps quotes and forces a cycle; the read
path is the guarantee.

---

## Demo controls

`POST /api/demo/:action`. All values live in the database; no redeploy.

| Action | Body | Effect |
|---|---|---|
| `toggle-source` | `{source:'a'\|'b'\|'c', on}` | source on/off, invalidates price cache |
| `pause` | `{on}` | `force_paused` |
| `guardrail` | `{value}` PKR/g string, 2 dp, `0` = off | buy-price floor |
| `threshold` | `{bps}` 1–5000 | divergence threshold, invalidates cache |
| `ttl` | `{seconds}` 1–3600 | TTL for **new** quotes |
| `max-price-age` | `{seconds}` 1–3600 | stale-price gate |
| `fetch-interval` | `{seconds}` 1–86400 | lazy fetch cadence, invalidates cache |
| `basis` | `{bps}` −500..500 | source C spot-equivalence, invalidates cache |
| `override` | `{value}` PKR/g or `null` | synthetic labelled price |
| `set-balance` | `{key, value}` | demo shortfall tool; the only way to break gold conservation |
| `force-cycle` | `{}` | fetch now, ignoring cache/cooldown |
| `reset` | `{}` | delete trades and quotes, reseed balances, clear price cache |

Success returns `{ok:true, settings}`; `set-balance` and `reset` also return
`balances`. `reset` leaves settings and recorded price rows alone.

---

## Reviewer script

Start from a clean seed (`POST /api/demo/reset`) and use
`BASE=http://localhost:3000`.

### 1. A source stops answering

```bash
curl -s -X POST $BASE/api/demo/toggle-source -H 'content-type: application/json' \
  -d '{"source":"a","on":false}'
curl -s $BASE/api/state
```

If B and C are both reachable, C is published with `degraded:true` and a reason.
If B is blocked from your host, C is the only source left and the gate correctly
refuses (`PRICE_UNAVAILABLE`, `price:null`, `price_notice`). Turn C off too:

```bash
curl -s -X POST $BASE/api/demo/toggle-source -H 'content-type: application/json' \
  -d '{"source":"c","on":false}'
curl -s $BASE/api/state   # "No price source is reporting, so trading is paused."
```

Restore with `{"source":"a","on":true}` / `{"source":"c","on":true}`.

### 2. A quote waits for its countdown

```bash
curl -s -X POST $BASE/api/demo/ttl -H 'content-type: application/json' -d '{"seconds":5}'
ID=$(curl -s -X POST $BASE/api/quotes -H 'content-type: application/json' \
  -d '{"side":"buy","input_mode":"pkr","input":"5000.00"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).quote.id))")
curl -s -i -X POST $BASE/api/quotes/$ID/confirm   # 409 QUOTE_NOT_READY
sleep 6
curl -s $BASE/api/state                          # quote is still active with 0s left
curl -s -X POST $BASE/api/quotes/$ID/confirm     # now settles
curl -s $BASE/api/state                          # quote is gone; trade is in history
```

### 3. A balance runs short

```bash
# At quote time
curl -s -X POST $BASE/api/demo/set-balance -H 'content-type: application/json' \
  -d '{"key":"pkr","value":"100.00"}'
curl -s -X POST $BASE/api/quotes -H 'content-type: application/json' \
  -d '{"side":"buy","input_mode":"pkr","input":"5000.00"}'
# 409 INSUFFICIENT_PKR with detail.max_pkr_paisa / max_gold_micrograms

# At settlement time
curl -s -X POST $BASE/api/demo/reset
curl -s -X POST $BASE/api/demo/ttl -H 'content-type: application/json' -d '{"seconds":2}'
ID=$(curl -s -X POST $BASE/api/quotes -H 'content-type: application/json' \
  -d '{"side":"buy","input_mode":"pkr","input":"2000.00"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).quote.id))")
curl -s -X POST $BASE/api/demo/set-balance -H 'content-type: application/json' \
  -d '{"key":"pkr","value":"0"}'
sleep 3
curl -s -X POST $BASE/api/quotes/$ID/confirm   # 409 INSUFFICIENT_PKR
curl -s $BASE/api/state          # no trade; PKR is still 0
curl -s $BASE/api/db             # quote status "rejected", reason INSUFFICIENT_PKR
```

### 4. Confirm twice

```bash
curl -s -X POST $BASE/api/demo/ttl -H 'content-type: application/json' -d '{"seconds":2}'
ID=$(curl -s -X POST $BASE/api/quotes -H 'content-type: application/json' \
  -d '{"side":"buy","input_mode":"pkr","input":"5000.00"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).quote.id))")
sleep 3
curl -s -X POST $BASE/api/quotes/$ID/confirm & \
curl -s -X POST $BASE/api/quotes/$ID/confirm & wait
curl -s $BASE/api/db | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.trades.filter(t=>t.quote_id===process.argv[1]).length)})" "$ID"
# one trade row; the loser replays the settled quote
```

### 5. The guardrail

```bash
curl -s -X POST $BASE/api/demo/override -H 'content-type: application/json' -d '{"value":"5000.00"}'
curl -s -X POST $BASE/api/demo/guardrail -H 'content-type: application/json' -d '{"value":"6000.00"}'
ID=$(curl -s -X POST $BASE/api/quotes -H 'content-type: application/json' \
  -d '{"side":"buy","input_mode":"pkr","input":"1000.00"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).quote.id))")
# guardrail_applied:true, unit_paisa_per_gram:600000 (override × 1.10 = 550000)
curl -s -X POST $BASE/api/quotes/$ID/cancel

curl -s -X POST $BASE/api/quotes -H 'content-type: application/json' \
  -d '{"side":"sell","input_mode":"grams","input":"0.100000"}'
# unit_paisa_per_gram:450000 — sell is unchanged

curl -s -X POST $BASE/api/demo/guardrail -H 'content-type: application/json' -d '{"value":"0.00"}'
curl -s -X POST $BASE/api/demo/override -H 'content-type: application/json' -d '{"value":null}'
```

### 6. Conservation

After any sequence of trades:

```bash
curl -s $BASE/api/db | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s).balances;console.log(BigInt(b.user_gold_micrograms)+BigInt(b.platform_gold_micrograms))})"
# 120000000
```

Or in SQL:

```sql
select sum(amount) from balances where key in ('user_gold', 'platform_gold'); -- 120000000
select count(*) from trades where pkr_paisa <> case when side = 'buy'
  then (gold_micrograms * unit_paisa_per_gram + 999999) / 1000000
  else (gold_micrograms * unit_paisa_per_gram) / 1000000 end; -- 0
```

### 7. Cancel

```bash
# active quote
ID=$(... create ...)
curl -s -X POST $BASE/api/quotes/$ID/cancel          # 200 cancelled
# confirmed quote, before the timer
ID=$(... create ...)
curl -s -X POST $BASE/api/quotes/$ID/confirm
curl -s -X POST $BASE/api/quotes/$ID/cancel          # 200 cancelled
# after settlement
curl -s -X POST $BASE/api/quotes/$ID/cancel          # 409 QUOTE_SETTLED
```

---

## Assumptions and resolved conflicts

The prompt's precedence was applied: this prompt › `Todo.md` as a contract ›
`WhatIDid.md` › `Flow.md` › the PDF.

### Binding conflict resolutions

| # | Resolution |
|---|---|
| C1 | Max notional is **Rs 1,000,000** (`100_000_000` paisa), not Rs 500,000 |
| C2 | Default divergence is **100 bps**, reviewer-settable 1–5000 |
| C3 | **Three** sources: A PakGold methodology, B GoldPrice.org, C Yahoo `GC=F` |
| C4 | **Countdown, then confirm** from `Flow.md`: Confirm is disabled until the review timer ends, then executes the trade. The quote remains until Confirm or Cancel; cancel wins until confirmation |
| C5 | Tola, top-up, withdraw, cost-basis % and charts are **not built** (phase 2) |
| C6 / D1 | The quorum anchor is the **most recent** `selected = true` price row, not the newest of the 50 oldest |
| C7 / D2 | A lone **demo override** satisfies availability by itself; a lone real source is still refused |
| C8 | `set-balance` is the only operation allowed to break gold conservation; `reset` restores 120 g |

### Choices made where the documents were silent

- One initial migration (`drizzle/0000_init.sql`) contains every CHECK; the
  journal is drizzle-kit's format and the migrator applies it.
- `POST /api/quotes` returns **201**. `price_change_bps` is a JSON number.
- A `from_quote_id` that is missing or of the other side is ignored, not a 404.
- `GET /api/trades/:id` returns `{receipt, now}` with the receipt nested.
- `GET /api/price` does not withhold the last recorded price; only
  `/api/state` withholds on `PRICE_UNAVAILABLE`.
- `GET /api/db` includes `now` and all rows newest-first.
- `set-balance` accepts `0` (trade input does not, because a trade of zero is
  meaningless).
- Extra server modules beyond the listed tree: `server/quotes.ts` (orchestration),
  `server/receipts.ts` (walk), `server/db/seed-values.ts` (shared seed constants).
- Receipt balances are not persisted; they are reconstructed from deltas.
- Demo override trades are stored with `price_source = 'A_pakgold'` because the
  schema has no "override" source value; the quote and price panel are labelled
  while the override is active, the receipt is not.
- `snapshotFromDb` (cache loss) reports the cycle fetch time as the only clock.
- The scheduler runs an immediate tick at boot and then every 300 s; on
  serverless it is best-effort.

---

## Tests and verification

`npm test` runs **53 vitest tests** over the pure core:

- `units` (20): parse acceptance/rejection, decimal limits, tola conversion,
  ingestion rounding, formatters, wire safety
- `trade-math` (18): both sides × both input modes, rounding direction, guardrail
  below/at/above, `A ≤ A_in` round-trip, dust, limits, the DB CHECK formula
- `quorum` (15): n = 0/1/2/3, outlier rejection, anchor and no-anchor tie-breaks,
  threshold tightening, 10× sanity gate, priority, reasons

Also run locally during the build, against a throwaway Postgres (PGlite, connected
through the `pg` driver):

- migrations applied through drizzle's own migrator, seed inserted
- every CHECK rejected its invalid case (negative balance, wrong unit, second
  settings row, bad basis, expiry before creation, tampered trade `pkr_paisa`,
  duplicate trade for one quote, duplicate source per cycle)
- 82 API-level acceptance checks: seed, buy, sell, countdown confirmation, parallel
  double confirm, shortfall rejection, cancel active/confirmed/settled,
  guardrail, pause, source gating, override, requote bps, stale price, reset,
  conservation, receipts, amount/limit errors

Those acceptance checks were exercised manually against a live server; no
integration-test suite is committed (see Known gaps).

`npm run typecheck` and `npm run build` are clean.

---

## Known gaps

1. **No committed integration tests.** The money-critical paths were verified
   against a throwaway Postgres manually; `tests/` contains only the pure-core
   unit tests.
2. **Receipt balances are reconstructed**, not stored. Exact unless a
   `set-balance` ran after the trades being displayed.
3. **Legacy confirmed rows need a sweep.** New quotes settle in the confirm
   request; the sweep only remains for any older `confirmed` row.
4. **Redis fallback is per-process.** With Redis down or unset, two instances can
   both claim a fetch. That costs upstream requests, not correctness.
5. **GoldPrice.org is opportunistic.** Its WAF gates on TLS/JA3 and browser
   navigation headers, and it rate-limits per IP. The `curl_cffi` fetcher sends
   a Chrome fingerprint plus a same-site `Referer`, which passes; a block or
   throttle is still recorded as a sample reason and the quorum continues
   without it.
6. **FX updates about daily**, so A's currency leg is not tick-live.
7. **C is a futures contract** with a fixed configurable basis; a roll or
   backwardation can get it rejected (correctly).
8. **A lone real source refuses trading**, even PakGold alone. Intentional. A
   lone override is allowed (D2).
9. **`snapshotFromDb` has no provider clock**, so a cache-rebuilt price reports
   the fetch age as its market age.
10. **Dust is not disclosed** on PKR-input buy quotes; it can be derived from
    `input_minor` and the quote amounts.
11. **No auth / single user.**
12. **Override receipts are not distinguishable** from a real PakGold trade.
13. The scheduler is best-effort on Vercel Hobby; the read path is the guarantee.
14. The local verification used PGlite through a socket shim, not Neon's pooler;
    the pool is configured with `max: 5` and no session-level features.
15. Tola, top-up, withdraw, cost basis and price charts are phase 2 and were not
    built.

---

## Deployment (Vercel Hobby)

1. Create a Neon project and copy the **pooled** connection string. Keep the demo
   in its own database; do not reuse a database with an incompatible schema.
2. Set the production environment variables:
   - `ASASA_DATABASE_URL` (pooled), which takes precedence over `DATABASE_URL`
   - `DATABASE_URL_UNPOOLED` (direct, for running migrations)
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
     (the `UPSTASH_REDIS_REST_KV_REST_API_*` aliases are also accepted)
   - `GOLDPRICE_FETCH_MODE=remote`
   - optionally `YAHOO_SYMBOL=GC=F`
3. Run `npm run db:migrate` and `npm run db:seed` once against that database
   (locally with the production `DATABASE_URL`, or from a one-off job).
4. Deploy with `vercel --prod`. Vercel detects Next.js and also picks up the
   Python function at `api/goldprice.py`; `vercel.json` includes
   `scripts/fetch_goldprice.py` and `requirements.txt` installs `curl_cffi`.
   The function is served at `/api/goldprice` and must not shadow the Next routes.
5. Open `/` for the test console. Demo configuration is database-backed and
   needs no redeploy.
