# Asasa Gold Trading Demo — as-built contract

**Status:** written against the shipped code (Nov 3, 2026). Where this document and the code
disagree, the code is the truth and this file is the bug.
**Companions:** `docs/gold_sources.md` (source research), `docs/WhatIDid.md` (understanding,
decisions, gaps), `README.md` (setup + reviewer script).

---

## 1. The product contract

A single-user, credential-free demo where a reviewer can:

1. See three balances — PKR wallet, their gold (grams), platform inventory (grams).
2. See the 24K market price in PKR/gram with the source it came from and how fresh it is.
3. Enter an amount (PKR when buying, grams when selling) and pick buy or sell.
4. Get a **75-second server-owned quote**, review it, confirm once.
5. See the trade execute when the quote's timer runs out, with updated balances and a receipt.
6. Reset everything and re-run the flow as often as they like.

Hard invariants (each one is enforced somewhere in the code):

- `user_gold + platform_gold` is exactly constant across every operation (120 g from the seed).
- A buy moves PKR down, user gold up, inventory down. A sell does the reverse.
- No balance can go negative — a database CHECK, not just code.
- Confirming twice stages once and settles once.
- An expired quote cannot settle.
- The user is charged exactly the number they were quoted, down to the paisa.

Out of scope: auth, real money, admin panel, multi-user, order book, charts.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript, **Node runtime** |
| DB | Neon Postgres, **pooled** connection string |
| DB access | `pg` Pool + Drizzle ORM + drizzle-kit migrations |
| Cache | Upstash Redis REST — price cache, fetch cooldown, FX cache. **Never money.** |
| Money math | integer minor units, JS `BigInt` |
| Validation | zod at every HTTP boundary |
| Styling | hand-written CSS (`app/globals.css`) — no Tailwind |
| Tests | vitest, unit tests over `domain/` |
| Local-only Python | 3.11+ with `curl_cffi` for source B |

Redis does three jobs: `price:current`, `price:next_fetch_at`, `fx:usd_pkr`. It is deliberately
not the idempotency mechanism — Postgres owns that (§5). Every Redis op mirrors into a
process-local map so a dead endpoint degrades to memory instead of a fetch storm
(`server/pricing/redis.ts`).

Price freshness is maintained **lazily on read** plus an in-process scheduler
(`instrumentation.ts` → `server/pricing/scheduler.ts`, tick every 300 s): no cron, because
Vercel Hobby cannot run one every five minutes.

---

## 3. Units, precision, rounding, limits

| Quantity | Storage unit | Column type | Example |
|---|---|---|---|
| PKR | paisa (1/100 PKR) | `bigint` | Rs 50,000.00 → `5_000_000` |
| Gold | microgram | `bigint` | 1.278241 g → `1_278_241` |
| Price | paisa per gram | `bigint` | Rs 39,116.26/g → `3_911_626` |
| Spread | basis points | `integer` | ×1.10 → `11000` |

### 3.1 Rounding (two places only)

1. **Ingestion** (`domain/units.ts`): `round(usd/oz × usd_pkr × 100 / 31.1034768)` for A and C;
   `round(pkr/oz × 100 / 31.1034768)` for B. The float dies there.
2. **Trade maths** (`domain/trade-math.ts`):

| Path | Formula |
|---|---|
| Buy, PKR in | `G = floor(A_in × 1e6 / P)`, `A = ceil(G × P / 1e6)` |
| Buy, grams in | `A = ceil(G × P / 1e6)` |
| Sell, grams in | `A = floor(G × P / 1e6)` |
| Sell, PKR in | `G = floor(A_in × 1e6 / P)`, `A = floor(G × P / 1e6)` |

Consequences, all intentional: a PKR-input buy can leave sub-microgram dust in the wallet;
`A` is always `f(G, P)`, so `trades.pkr_is_exact` (§4) verifies every receipt in SQL; `A ≤ A_in`
on PKR-input paths, so a user is never charged more than they named.

### 3.2 Limits

Min trade **Rs 1,000** or **0.1 g**; max notional **Rs 1,000,000** per trade. PKR accepts 2
decimals, grams 6. Rejected: empty, non-numeric, `NaN`, `Infinity`, negative, zero, scientific
notation, leading `+`, over the limits.

---

## 4. Schema (5 tables)

```sql
balances(key text pk, unit text, amount bigint, updated_at)
  -- key in ('pkr','user_gold','platform_gold')
  -- (key='pkr' and unit='paisa') or (key<>'pkr' and unit='microgram')
  -- amount >= 0

settings(id boolean pk default true check(id), guardrail_paisa_per_gram bigint,
  quote_ttl_seconds int, divergence_threshold_bps int, max_price_age_seconds int,
  price_fetch_interval_seconds int, source_a_on bool, source_b_on bool, source_c_on bool,
  source_c_basis_bps int, price_override_paisa bigint, force_paused bool, updated_at)
  -- check: source_c_basis_bps between -500 and 500
  -- check: price_fetch_interval_seconds between 1 and 86400

quotes(id uuid pk, side, status, input_mode, input_minor, market_paisa_per_gram,
  unit_paisa_per_gram, spread_bps, gold_micrograms, pkr_paisa, guardrail_paisa_per_gram,
  guardrail_applied, price_source, price_cycle_id uuid, price_fetched_at, expires_at,
  created_at, settled_at, rejection_reason)
  -- status in ('active','confirmed','settled','expired','cancelled','rejected')
  -- pkr_paisa > 0 and gold_micrograms > 0; expires_at > created_at

trades(id uuid pk, quote_id uuid unique, side, gold_micrograms, pkr_paisa,
  market_paisa_per_gram, unit_paisa_per_gram, spread_bps, guardrail_paisa_per_gram,
  guardrail_applied, price_source, price_fetched_at, quote_created_at, settled_at)
  -- CHECK pkr_paisa = case when side='buy'
  --   then (gold_micrograms*unit_paisa_per_gram + 999999)/1000000
  --   else (gold_micrograms*unit_paisa_per_gram)/1000000 end

prices(id bigserial pk, cycle_id uuid, fetched_at, source, price_paisa_per_gram, accepted,
  selected, reason)
  -- source in ('A_pakgold','B_goldprice','C_yahoo'); one row per source per cycle
```

`quotes` TTL / threshold / max-age ranges are validated at the HTTP boundary; basis and fetch
interval are enforced by the database as well. There is no ledger table (the receipt is the
record), no `price_cycles` table (a cycle is a `cycle_id` group), and no `demo_events` log.
`trades` stores deltas only — receipt balances are reconstructed by `/api/state` (§9).

---

## 5. Quote lifecycle and exactly-once

```
                     confirm (status='active' AND expires_at > now())
  (none) ──create──► active ─────────────────────────────────► confirmed
                       │                                          │
                       ├─ cancel ─────────────────► cancelled     ├─ cancel ──► cancelled
                       │                                          │
                       ├─ timer hits 0 ───────────► expired        └─ timer hits 0 ─► settled
                       │                                                              (trade row)
                       └─ confirm after expiry ───► 409 QUOTE_EXPIRED
```

- **Confirm stages, it does not execute.** The quote keeps its locked numbers; money moves when
  the timer runs out.
- Settlement is claimed with
  `UPDATE quotes SET status='settled', settled_at=now() WHERE id=$1 AND status='confirmed'`.
  Zero rows → diagnose: settled → replay the existing trade (HTTP 200), expired/cancelled/
  rejected → typed 409, gone → 404.
- Inside the same transaction the three balances are re-read `FOR UPDATE`, re-validated, and
  only then updated; the trade inserted last. If the wallet moved since the quote, the quote
  flips to `rejected` and the response is `INSUFFICIENT_PKR` / `INSUFFICIENT_GOLD` /
  `INSUFFICIENT_INVENTORY` with the maximum affordable amount — never a negative balance.
- Sweeps run on every `/api/state` read and on the scheduler tick: `active` past expiry →
  `expired`; `confirmed` past expiry → settled. A concurrent sweep calls the same conditional
  claim, so the loser replays.
- Cancel accepts `active` **and** `confirmed` while `expires_at > now()`; after settlement it is
  `409 QUOTE_SETTLED`.
- Requote: `POST /api/quotes` accepts `from_quote_id` and returns `price_change_bps`; the current
  UI does not send it yet.

---

## 6. Pricing pipeline

### 6.1 Sources, priority A > B > C

| ID | Source | Computation | Role |
|---|---|---|---|
| A | PakGold methodology | `api.gold-api.com/price/XAU` (USD/oz) × `open.er-api.com/v6/latest/USD` (`rates.PKR`) | Primary. Byte-identical to what pakgold.pk computes in the browser. FX cached 6 h. A contributes no provider clock (§6.5). |
| B | GoldPrice.org | `data-asg.goldprice.org/dbXRates/PKR` → `items[0].xauPrice` (PKR/oz) | Named fallback. WAF gates on TLS/JA3, so it is fetched via `curl_cffi`: spawned locally (`python`) or called through the deployed Python function (`remote`). |
| C | Yahoo Finance `GC=F` | `meta.regularMarketPrice` (USD/oz, futures) → basis-normalised spot-equivalent | Validator and last-resort fallback. Read `meta` only. |

`GOLDPRICE_FETCH_MODE` is `python` / `remote` / `disabled`; unset it is **inferred**: `remote`
when `VERCEL` is set, `disabled` otherwise. `api/goldprice.py` is a Vercel file-based Python
function bundling `scripts/fetch_goldprice.py` (`vercel.json`), with `curl_cffi` and no web
framework (a framework preset would shadow the Next routes). The Node side calls it over
`node:https` on the production domain, not the global `fetch`, and reports HTTP status +
content-type + body head when the answer is not JSON.

**C basis (default 28 bps, range −500..500):** GC=F measured +0.275% over spot. The raw print is
normalised with `spot = raw × 10000 / (10000 + basis)` before comparison or publication. If the
real basis moves (roll, backwardation), C diverges and the quorum rejects it — that is the
signal, not something to hide.

### 6.2 Fetch cycle (lazy)

```
getPrice():
  if demo price override set         -> return it (source A, labelled override, single sample)
  cached && age <= price_fetch_interval_seconds -> return cached
  claim = redis SETNX price:next_fetch_at now+20  (TTL 60)
  claim held by someone else         -> serve the durable record from `prices`
  else run_cycle(): one attempt per enabled source, quorum, one `prices` row per source
       success -> cache price:current for the fetch interval
       failure -> cooldown 60 s, serve the last recorded cycle (labelled)
```

- Serving a stale-but-labelled price while a fetch runs is intentional: the UI never blocks on a
  third party.
- Cache loss is not fatal — `prices` rebuilds the last cycle and its age
  (`snapshotFromDb`, newest-first).
- The cooldown is set on failure too, so a 403 storm cannot become a fetch storm.
- `instrumentation.ts` starts a scheduler that sweeps quote expiry and forces a cycle every
  300 s (guarded by a Redis claim). On serverless it is best-effort; the read path is the
  guarantee.

### 6.3 Quorum

`divergence_bps(a,b) = |a-b| × 20000 / (a+b)`. `T` = `divergence_threshold_bps` (default 100,
settable 1–5000). A sanity gate drops anything outside 10× the last trusted price (unit errors).

| n (sources that answered) | Rule |
|---|---|
| 0 | `paused`; no price published. |
| 1 | Accept (`single_source`). A validator is not allowed to deadlock the demo. |
| 2 | Within `T`: accept both, publish the higher priority (`validated`). Beyond `T`: reject the one further from the last trusted price; with no anchor, publish by priority and mark `degraded`. |
| 3 | Median; accept every sample within `T` of it, reject the rest. The median is itself a sample, so at least one is accepted. |

The published price is **always one source's number**, never an average. `degraded` is true when
the published source is not A; the UI shows a degraded note and the reason. Every sample's
fate is a `prices` row with `accepted`, `selected` and a human `reason`.

### 6.4 Trading gate

The gate's verdict (`{ok, code, message, hint}`) is shared by `/api/quotes` and `/api/state`, so
the refusal and the banner cannot disagree. Availability is computed over sources that are
**switched on and reported an accepted price** in the snapshot:

| Available | Verdict |
|---|---|
| 2 or 3 | trade, if the price age is within `max_price_age_seconds` |
| 1 (any source, **including PakGold alone**, and including a lone demo override) | `PRICE_UNAVAILABLE` — "the price is unreliable and cannot be validated", hint names the source |
| 0 | `PRICE_UNAVAILABLE` — "no price source is reporting, so trading is paused" |

Then: `force_paused` → `TRADING_PAUSED`; price fetched longer ago than
`max_price_age_seconds` (default 600, settable 1–3600) → `PRICE_UNAVAILABLE` with the age in the
hint; no usable price at all → `PRICE_UNAVAILABLE`.

`/api/state` withholds the price (`price: null` + `price_notice`) whenever the gate refuses on
`PRICE_UNAVAILABLE`; for `force_paused` the last price stays visible as display information.

### 6.5 Freshness honesty

Two clocks, never conflated:

- `fetch_age_seconds` — age of the cycle that produced the number. **This is what the gate
  checks.**
- `provider_at` / `market_age_seconds` — the source's own trade timestamp. Display only. A
  contributes none (its `updatedAt` ticks while the value stands still), B contributes its
  `date` when parseable, C contributes `regularMarketTime`.

Session times: spot opens Sunday 17:00 New York (02:00 PKT); COMEX `GC=F` opens 17:00 Chicago
(03:00 PKT). A frozen-looking weekend price with a ticking response timestamp is expected; it is
not presented as live.

---

## 7. Trade maths

```
buy_unit  = max(ceil(market × 11000 / 10000), guardrail)    -- platform-favourable up
sell_unit = floor(market × 9000 / 10000)                    -- platform-favourable down
```

`guardrail_applied` is true when the guardrail exceeds `market × 1.10`; it is shown on the quote
and frozen into the receipt. The guardrail is an absolute PKR/gram floor stored in `settings`,
default `0` (off), settable by the reviewer in the UI. Rationale: it is the only definition
independent of the data it guards against, and it is directly demonstrable (`max()` visibly
switches). A computed guardrail would add no testable behaviour to a transactional demo.

---

## 8. Demo controls

In the desktop sidebar on `/` only (`app/settings-panel.tsx`), backed by
`POST /api/demo/:action`. No separate `/demo` page.

| Action | Body | What it proves |
|---|---|---|
| `toggle-source` | `{source:'a'\|'b'\|'c', on}` | Fallback, degraded badge, availability rules |
| `pause` | `{on}` | Quotes refused with `TRADING_PAUSED` |
| `guardrail` | `{value}` (PKR/g, 2 dp) | `max(market×1.10, guardrail)` switching |
| `threshold` | `{bps}` 1–5000 | Tighten it and watch a source get rejected |
| `ttl` | `{seconds}` 1–3600 | Expiry without waiting 75 s |
| `max-price-age` | `{seconds}` 1–3600 | Trading pauses on a stale price |
| `fetch-interval` | `{seconds}` 1–86400 | Faster/slower price refresh |
| `basis` | `{bps}` −500..500 | Source C spot-equivalence |
| `override` | `{value}` or null | Synthetic price, labelled as override |
| `set-balance` | `{key, value}` (2 dp PKR / 6 dp g) | Shortfall paths |
| `force-cycle` | `{}` | Refetch now, ignoring cache/cooldown |
| `reset` | `{}` | Reseed balances, delete quotes/trades, clear cache |

---

## 9. API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Sweep expiry, then balances, price panel, in-flight quote (active or confirmed), 10 recent trades with walked before/after balances, settings. |
| GET | `/api/price` | Hot price only (cache → last recorded cycle). Never fetches. |
| GET | `/api/db` | Read-only mirror: balances, settings, last 25 quotes, last 30 price rows, last 25 trades. |
| POST | `/api/quotes` | `{side, input_mode, input, from_quote_id?}` → 201 `{quote, price_change_bps}`. |
| POST | `/api/quotes/:id/confirm` | Stage the trade; `{confirmed:true, replayed, quote}`. |
| POST | `/api/quotes/:id/cancel` | `{quote:{id,status:'cancelled'}}`; 409 for expired/settled/rejected. |
| GET | `/api/trades/:id` | Receipt. |
| POST | `/api/demo/:action` | Controls above. |

Error envelope `{ error: { code, message, hint?, detail? } }`. Codes: `INVALID_AMOUNT`,
`TOO_MANY_DECIMALS`, `AMOUNT_NOT_POSITIVE`, `BELOW_MIN`, `ABOVE_MAX`, `INSUFFICIENT_PKR`,
`INSUFFICIENT_GOLD`, `INSUFFICIENT_INVENTORY`, `QUOTE_EXPIRED`, `QUOTE_CANCELLED`,
`QUOTE_SETTLED`, `QUOTE_REJECTED`, `TRADING_PAUSED`, `PRICE_UNAVAILABLE`, `NOT_FOUND`,
`BAD_REQUEST`, `INTERNAL`. Status mapping lives in `server/http.ts`.

Quote responses carry `expires_at` **and** server `now`; the client calibrates clock skew once
per quote so the countdown is exact. The server is the only judge of expiry.

---

## 10. UI states

`/` — wallet strip → market card → trade form → quote card → receipt → Receipts section.
`/db` — live table mirror, 2 s poll.

Required states: trading paused; no validatable price (price withheld + notice); quote expired
(card folds away, nothing traded); confirmed (card tinted, Confirm disabled, Cancel live);
cancelled; `BELOW_MIN` / `ABOVE_MAX` / `TOO_MANY_DECIMALS`; insufficient PKR / gold / inventory
with the maximum affordable amount; degraded source; fallback source; B unavailable with its
reason; guardrail applied.

Mobile (≤900 px): bottom tab bar, sectioned sheet, stacked receipts. The sidebar — and therefore
the settings controls — is desktop-only.

---

## 11. Seed

| Balance | Value |
|---|---|
| PKR wallet | Rs 500,000.00 (`50_000_000` paisa) |
| User gold | 20.000000 g (`20_000_000` µg) |
| Platform inventory | 100.000000 g (`100_000_000` µg) |

Total gold **120 g forever**. `settings`: quote TTL 75, divergence 100 bps, max price age 600,
fetch interval 300, basis 28, guardrail 0, all three sources on, not paused, no override.

20 g rather than 50 g so a full liquidation (~Rs 640k) stays inside the Rs 1,000,000 cap.

---

## 12. File layout (actual)

```
app/
  page.tsx                      trade flow, quote card, receipts, toasts
  db/page.tsx                   live database mirror
  chrome.tsx                    shell: sidebar, top bar, mobile tab bar
  settings-panel.tsx            demo controls (desktop sidebar, "/" only)
  globals.css
  api/state|price|db/route.ts
  api/quotes/route.ts
  api/quotes/[id]/{confirm,cancel}/route.ts
  api/trades/[id]/route.ts
  api/demo/[...action]/route.ts
domain/                         pure, unit-tested, only place rounding exists
  units.ts  trade-math.ts  quorum.ts
server/
  db/{index.ts,schema.ts,repo.ts}
  pricing/{cycle.ts,price.ts,redis.ts,scheduler.ts,constants.ts,settings-like.ts}
  sources/{pakgold.ts,fx.ts,goldprice-org.ts,yahoo-futures.ts,types.ts}
  http.ts  serialize.ts  cors.ts
api/goldprice.py                Vercel Python function (source B)
scripts/{apply_migrations.ts,seed.ts,env.ts,fetch_goldprice.py}
drizzle/0000…0003 + meta
tests/unit/{units,trade-math,quorum}.test.ts
```

Rule: `domain/` has no imports from `server/`, no `fetch`, no DB.

---

## 13. Environment

| Var | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** string (required) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Optional; memory fallback when unset |
| `GOLDPRICE_FETCH_MODE` | `python` / `remote` / `disabled`; inferred when unset |
| `PYTHON_BIN` | default `python` |
| `GOLDPRICE_REMOTE_URL` | only for `remote` without Vercel URL vars |
| `YAHOO_SYMBOL` | default `GC=F` |

Setup: `npm i`, `python -m pip install curl_cffi`, `npm run db:migrate`, `npm run db:seed`,
`npm run dev`. Demo configuration lives in the database, not env.

---

## 14. Tests

Implemented: **40 vitest unit tests** over the pure core.

- `units` (11): parse acceptance/rejection, limits, ingestion rounding, formatters, wire safety.
- `trade-math` (14): both sides × both input modes, rounding direction, guardrail
  below/at/above, round-trip `A ≤ A_in`, the DB CHECK formula.
- `quorum` (15): n = 0/1/2/3, outlier rejection, two-source tie-break with and without anchor,
  threshold tightening, priority selection.

Not implemented: integration tests against a real Postgres. The money-critical paths
(double-confirm, concurrent settle, expiry, shortfalls, CHECKs) were verified manually against
Neon. This is a known gap, not a passing claim.

Manual reviewer script: `README.md`.

---

## 15. Known gaps

1. **No automated integration tests** against a real Postgres.
2. **Receipt balances are reconstructed**, not stored: `/api/state` walks recent trades backwards
   from the current wallet. Exact unless a demo `set-balance` ran after those trades.
3. **The quorum anchor is read from the 50 oldest selected rows** (`cycle.ts` ascending +
   `limit(50)`, then the last), so the "last trusted price" can be very old; the two-source
   tie-break and the 10× sanity gate are weaker than intended.
4. **Any lone source refuses trading** — including PakGold alone and a lone demo price override.
   Consistent, but it means the override cannot unlock quoting by itself.
5. **Settlement needs a sweep**: settles on the next `/api/state` read or scheduler tick after
   expiry. Money is never at risk (the quote is claimed); the receipt can be late.
6. **Redis fallback is per-process**; across instances a fetch claim can double-fire (costs
   requests, not correctness).
7. **GoldPrice.org is opportunistic**: TLS-fingerprint gated, per-IP rate limited, one attempt
   per cycle, DNS failures observed.
8. **FX updates ~daily** (`open.er-api.com`), so A's currency leg is not tick-live.
9. **C is a futures contract** with a fixed 28 bps basis; a roll/backwardation can get it
   rejected (correctly) and leave the fallback dark.
10. **No auth / single user.**
11. **`from_quote_id` is server-only** — the UI does not send it, so "price moved X%" is not
    shown on expiry.
12. **Dust is undisclosed** on PKR-input buy quotes.
13. **Settings are desktop-only** (sidebar hidden on phones).
14. **`snapshotFromDb` has no provider clock**, so a DB-rebuilt price reports the fetch age as
    its market age.

---

## 16. Deliverables

- Public repo: `README.md` (setup + reviewer script), this contract, `docs/WhatIDid.md`
  (understanding, assumptions, decisions, gaps), `docs/gold_sources.md` (source research).
- Public deployment, no credentials.
- Build record with dead ends kept (float detour, WAF probing, DNS failures).

---

## 17. Decision log

| # | Decision | Why |
|---|---|---|
| 1 | Integer minor units + BigInt | Floats broke the invariant and the receipt formula in measurement. |
| 2 | Postgres owns idempotency | One authority for "did this trade happen". |
| 3 | Conditional `UPDATE` + `FOR UPDATE`, not SERIALIZABLE | Same guarantee, less machinery. |
| 4 | Quote stores final amounts; settlement never reprices | Removes the rounding-mismatch class; enables the DB CHECK. |
| 5 | Staged confirm (confirm locks, timer settles, cancel wins until zero) | Matches the brief's "locked quote for review and confirmation"; makes cancel-after-confirm testable. |
| 6 | No reservations/holds | Single user; re-check under lock is safer. |
| 7 | Three-source quorum with median rejection | "Reliable" becomes measurable; the brief's fallback is unusable from some hosts. |
| 8 | Single source does not block the quorum | A validator must not deadlock the demo. |
| 9 | Absolute, runtime guardrail, default off | Independent of the data it guards; demonstrable without redeploy. |
| 10 | Lazy fetch + cooldown + best-effort scheduler | No reliable 5-minute cron on Hobby. |
| 11 | Fetch interval is a DB setting (1–86400) | The reviewer controls cadence without a redeploy. |
| 12 | B fetched by curl_cffi locally / by a Python function on Vercel | The WAF blocks non-browser TLS fingerprints; plain Node fetch is 403'd. |
| 13 | C basis-normalised with a configured allowance | A futures price published as spot would quote fallback trades ~0.3% high; drift surfaces as divergence. |
| 14 | Read Yahoo `meta` only | Candle series was malformed pre-open. |
| 15 | Demo config in `settings`, not env | "No code changes" must not mean "no redeploy". |
| 16 | Fetch age and provider clock are separate fields | The gate judges our freshness; the provider's clock describes the market. |
| 17 | Priority A > B > C | PakGold is the brief's primary, GoldPrice.org its named fallback, Yahoo stands in where B cannot reach. |

---

## 18. Open items

- Integration tests on a throwaway Postgres (conservation, concurrent settle, forced expiry,
  shortfalls, CHECKs).
- Decide whether a lone source (or a lone override) should be tradeable, and make the gate's
  copy match the decision.
- Fix the quorum anchor read (gap 3).
- Persist `balances_before/after` on the trade instead of reconstructing it.
- Surface `from_quote_id` / `price_change_bps` and the dust remainder in the UI.
