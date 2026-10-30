# Asasa Gold Trading Demo — Finalized Build Spec

**Status:** design phase closed. This document is the contract for implementation. Nothing here should need re-deciding mid-build; anything that does goes in §17 first.
**Date:** Oct 26, 2026 (Sunday — gold market closed, all prices are Friday's close).
**Companions:** `docs/gold_sources.md` (source research), `progress.md` (earlier R&D), `docs/WhatIDid.md` (understanding + decisions). The original brief and PDF were deleted from the repo on request; their substance is carried in `progress.md` and in this document, which is now the authority.

---

## 1. The product contract

A single-user, credential-free demo where a reviewer can:

1. See three balances — PKR wallet, their gold (grams), platform inventory (grams).
2. See the 24K market price in PKR/gram **with the source it came from and how fresh it is**.
3. Enter an amount in PKR or grams, pick buy or sell.
4. Get a **75-second server-owned quote**, review it, confirm once.
5. Get updated balances + a receipt.
6. Reset everything and re-run the same flow as many times as they like.

Hard invariants (each one is a test, §14):

- `user_gold + platform_gold` is **exactly** constant across every operation.
- A buy moves PKR down, user gold up, inventory down. A sell does the reverse.
- No balance can ever go negative — enforced by the database, not just by code.
- Confirming twice creates **one** trade and returns the **same receipt**.
- An expired quote cannot settle, even if the client lies about the time.
- The user is never charged a price different from the one they saw.

Out of scope: auth, real money, admin panel, multi-user, order book, charts.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript, **Node runtime** | Route handlers are `curl`-able, which the reviewer needs |
| DB | Neon Postgres, **pooled** connection string | Vercel marketplace, as chosen |
| DB access | `pg` Pool + **Drizzle ORM** + drizzle-kit migrations | Settlement needs an interactive transaction with row locks; Neon's HTTP driver cannot do that |
| Cache | Upstash Redis (`@upstash/redis`, REST) | Price hot-read + fetch cooldown. **Never money state.** |
| Money math | **Integer minor units**, JS `BigInt` in domain code | See §3 |
| Validation | Zod at every boundary | |
| Styling | Tailwind with Asasa palette tokens | `#0D4A46` teal, `#8CCB50` green, `#F9FAFA` off-white, `#1A1F1B` near-black |
| Tests | Vitest (unit) + integration tests against a real Postgres | |

**Redis does exactly two jobs:** `price:current` (TTL 300 s) and `price:next_fetch_at` (cooldown, set on success *and on failure*). It is deliberately **not** the idempotency mechanism — Postgres owns that (§5). Two stores must never both claim to know whether a trade happened.

**No cron.** Vercel Hobby cron can't run every 5 minutes. Price freshness is maintained lazily on read, guarded by the Redis cooldown.

---

## 3. Units, precision, rounding

### 3.1 Canonical units

| Quantity | Storage unit | Column type | Example |
|---|---|---|---|
| PKR | **paisa** (1/100 PKR) | `bigint` | Rs 50,000.00 → `5000000` |
| Gold | **microgram** (1e-6 g) | `bigint` | 1.278241 g → `1278241` |
| Price | **paisa per gram** | `bigint` | 39,116.26 PKR/g → `3911626` |
| Spread | basis points | `integer` | 1.10 → `11000` |

No floats in the money path, ever. `bigint` columns → Drizzle `mode: 'bigint'` → JS `BigInt`. JSON can't carry BigInt, so the API layer converts at the boundary with an `assertSafeMinor()` guard (all values are validated ≤ 1e12, far below 2^53), and the client only ever *formats* — it never does arithmetic.

Why not `float`: `0.1 + 0.2 = 0.30000000000000004`, `50 + 10×0.1 = 51.000000000000014`, and a real quote computed as `50000 / 39116.2485… × 39116.2485…` returns `49999.99451625`, not `50000`. Those are the exact numbers this build has to make impossible.

### 3.2 Rounding rules (the only place rounding is allowed)

1. **Market price** is rounded **once, at ingestion**: `spot_usd × usd_pkr / 31.1034768` → `round` (nearest) to integer paisa/gram. The float dies there and never travels further.
2. **Buy unit price** = `ceil(market × 11000 / 10000)`  → round up, platform-favorable.
3. **Sell unit price** = `floor(market × 9000 / 10000)` → round down, platform-favorable.
4. **Guardrail** is stored already as integer paisa/gram, so the `max()` comparison can't introduce a fraction.
5. **Grams are canonical.** PKR is always derived *from* grams and the unit price:

| Path | Formula |
|---|---|
| Buy, input PKR `A_in` | `G = floor(A_in × 1e6 / P)` then `A = ceil(G × P / 1e6)` |
| Buy, input grams `G` | `A = ceil(G × P / 1e6)` |
| Sell, input grams `G` | `A = floor(G × P / 1e6)` |
| Sell, input PKR `A_in` | `G = floor(A_in × 1e6 / P)` then `A = floor(G × P / 1e6)` |

Consequences, all intentional:
- A PKR-input buy leaves **fewer than one microgram's worth of paisa** (≈ 0–4 paisa) in the wallet. Disclose it on the quote screen ("dust remains in your wallet") rather than hiding it.
- `A` is **always** `f(G, P)`, so every receipt satisfies the formula exactly and there is never a leftover fraction to explain. This is also a database `CHECK` (§4, `trades.pkr_is_exact`).
- Round-trip safety: `A ≤ A_in` on both PKR-input paths, so we can never overcharge or overpay.

### 3.3 Limits

Min trade: **Rs 1,000** or **0.1 g**. Max notional: **Rs 1,000,000** (a product guardrail against absurd input, plus keeps every intermediate product far from bigint limits). PKR input accepts at most 2 decimals; grams at most 6. Reject: empty, non-numeric, `NaN`, `Infinity`, negative, zero, scientific notation, leading `+`, > limits.

---

## 4. Schema

```sql
-- Exactly three rows. paisa for 'pkr'; micrograms for the gold rows.
create table balances (
  key        text primary key check (key in ('pkr','user_gold','platform_gold')),
  amount     bigint not null check (amount >= 0),
  updated_at timestamptz not null default now()
);

create table price_cycles (
  id                 bigserial primary key,
  created_at         timestamptz not null default now(),
  threshold_bps      integer not null,
  selected_source    text,               -- null => paused
  selected_price     bigint,
  confidence         text not null,      -- 'validated' | 'single_source' | 'paused'
  degraded           boolean not null default false,
  rejected_sources   jsonb not null default '[]'::jsonb
);

create table price_samples (
  id            bigserial primary key,
  cycle_id      bigint not null references price_cycles(id) on delete cascade,
  source        text not null check (source in ('A_pakgold','B_goldprice','C_yahoo')),
  ok            boolean not null,
  price_paisa_per_gram bigint,
  divergence_bps integer,
  accepted      boolean not null default false,
  reject_reason text,
  raw           jsonb,
  fetched_at    timestamptz not null default now()
);

create table quotes (
  id                       uuid primary key default gen_random_uuid(),
  side                     text not null check (side in ('buy','sell')),
  status                   text not null default 'active'
                           check (status in ('active','settled','expired','cancelled','rejected')),
  input_mode               text not null check (input_mode in ('pkr','gold')),
  input_minor              bigint not null check (input_minor > 0),
  market_paisa_per_gram    bigint not null check (market_paisa_per_gram > 0),
  unit_paisa_per_gram      bigint not null check (unit_paisa_per_gram > 0),
  spread_bps               integer not null,
  gold_micrograms          bigint not null check (gold_micrograms > 0),
  pkr_paisa                bigint not null check (pkr_paisa > 0),
  guardrail_paisa_per_gram bigint not null default 0,
  guardrail_applied        boolean not null default false,
  price_source             text not null,
  price_cycle_id           bigint not null references price_cycles(id),
  price_fetched_at         timestamptz not null,
  confidence               text not null,
  expires_at               timestamptz not null,
  created_at               timestamptz not null default now(),
  settled_at               timestamptz,
  trade_id                 uuid,
  rejection_reason         text,
  check (expires_at > created_at)
);
create index quotes_status_expiry on quotes (status, expires_at);

create table trades (
  id                       uuid primary key default gen_random_uuid(),
  quote_id                 uuid not null unique references quotes(id),
  side                     text not null check (side in ('buy','sell')),
  market_paisa_per_gram    bigint not null,
  unit_paisa_per_gram      bigint not null,
  spread_bps               integer not null,
  gold_micrograms          bigint not null check (gold_micrograms > 0),
  pkr_paisa                bigint not null check (pkr_paisa > 0),
  guardrail_paisa_per_gram bigint not null,
  guardrail_applied        boolean not null,
  price_source             text not null,
  price_cycle_id           bigint not null,
  price_fetched_at         timestamptz not null,
  quote_created_at         timestamptz not null,
  settled_at               timestamptz not null default now(),
  balances_after           jsonb not null,
  -- the receipt must satisfy the pricing formula, exactly, in integer math
  constraint pkr_is_exact check (
    pkr_paisa = case when side = 'buy'
      then (gold_micrograms * unit_paisa_per_gram + 999999) / 1000000
      else (gold_micrograms * unit_paisa_per_gram) / 1000000
    end
  )
);

-- Append-only. trade_id is null for seed rows and demo adjustments.
create table ledger_entries (
  id            bigserial primary key,
  trade_id      uuid references trades(id),
  balance_key   text not null,
  delta         bigint not null,
  balance_after bigint not null check (balance_after >= 0),
  note          text,
  created_at    timestamptz not null default now()
);

create table demo_settings (
  id                       boolean primary key default true check (id),
  guardrail_paisa_per_gram bigint  not null default 0,
  divergence_threshold_bps integer not null default 100 check (divergence_threshold_bps between 1 and 5000),
  quote_ttl_seconds        integer not null default 75  check (quote_ttl_seconds between 1 and 3600),
  max_price_age_seconds    integer not null default 600 check (max_price_age_seconds between 1 and 3600),
  source_a_enabled         boolean not null default true,
  source_b_enabled         boolean not null default true,
  source_c_enabled         boolean not null default true,
  source_c_basis_bps       integer not null default 28 check (source_c_basis_bps between -500 and 500),
  price_override_paisa     bigint,
  force_paused             boolean not null default false,
  updated_at               timestamptz not null default now()
);

create table demo_events (
  id         bigserial primary key,
  action     text not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);
```

Design notes worth defending in `WhatIDid.md`:

- `balances.amount >= 0` makes an overdraft a database error instead of a corrupt state.
- `trades.pkr_is_exact` makes "the receipt math is wrong" a constraint violation. The DB independently verifies the pricing formula with integer division.
- The quote stores the **final** `gold_micrograms` and `pkr_paisa`. Settlement applies those numbers and never recomputes a price.
- **No reservations table.** A quote does not hold funds; availability is re-checked under lock at settle time. For one user this is simpler *and* safer than a hold system.
- `trades` and `ledger_entries` are append-only; a receipt is never updated.

---

## 5. Quote lifecycle and exactly-once settlement

```
null ──create──> active ──confirm (ok)──────────> settled   (trade written)
                    │
                    ├──confirm (expired)───────> expired
                    ├──confirm (validation)────> rejected   (balance/shortfall; terminal)
                    └──cancel──────────────────> cancelled
```

`expired` is *derived* from `expires_at <= now()` for display; it is persisted opportunistically when touched. No cron sweeps stale quotes.

### 5.1 The settlement statement

One transaction, this order: **quote row → pkr → user_gold → platform_gold** (fixed lock order, no deadlocks):

```sql
-- 1. claim the quote (this IS the idempotency check)
UPDATE quotes SET status = 'settled', settled_at = now(), trade_id = $trade
WHERE id = $1 AND status = 'active' AND expires_at > now()
RETURNING *;
-- 0 rows -> do not touch balances; diagnose and return a typed error
```

2. Re-read the three balance rows `FOR UPDATE`.
3. Re-validate against *current* balances (they may have moved since quote issue — demo controls can do this).
4. Apply deltas, insert `trades` + 3 `ledger_entries`.
5. `COMMIT`.

Under READ COMMITTED, a concurrent double-confirm blocks on the quote row lock, re-evaluates `status='active'`, and updates 0 rows — so the loser falls into the diagnosis path and receives the **original receipt** (HTTP 200, `replayed: true`). No `SERIALIZABLE`, no advisory locks, no Redis.

### 5.2 Failure diagnosis (0 rows)

| Quote state found | Response | UI |
|---|---|---|
| `settled` | 200 + the original trade | Receipt, marked "already completed" |
| `expired` | 409 `QUOTE_EXPIRED` + current price + `price_change_bps` | "Price moved X%. Get a fresh quote →" (one tap, amount + side preserved) |
| `cancelled` | 409 `QUOTE_CANCELLED` | Back to the form |
| `rejected` | 409 `QUOTE_REJECTED` + reason | Form with the amount preserved |
| validation fails at step 3 | 409 + specific shortfall code, quote → `rejected` | "You can afford N g" / "Only N g in inventory" |

A quote is **terminal** once confirm fails — never silently re-priced at settle.

### 5.3 Requote

`POST /api/quotes` accepts an optional `from_quote_id`. If supplied, the response includes `price_change_bps` vs the old quote so the UI can say "price moved +0.42%". The user always confirms the new number explicitly.

---

## 6. Pricing pipeline

### 6.1 Three sources

| ID | Source | Endpoint | Unit | Role |
|---|---|---|---|---|
| **A** | PakGold methodology | `api.gold-api.com/price/XAU` (USD/troy oz) **×** `open.er-api.com/v6/latest/USD` (`rates.PKR`) | USD/oz × FX | **Primary.** Byte-identical to what pakgold.pk computes in the browser. FX cached 6 h (it updates ~daily). |
| **B** | GoldPrice.org | `data-asg.goldprice.org/dbXRates/PKR` → `items[0].xauPrice` | PKR/oz | **Secondary fallback, local dev only.** Needs `curl_cffi` + browser headers. |
| **C** | Yahoo Finance, **COMEX GC=F** | `query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=1d` → read **`meta.regularMarketPrice` + `meta.regularMarketTime` only** | USD/troy oz, **futures** | **Tertiary fallback.** Keyless, no WAF; the only leg available on Vercel. |

**Priority: A (PakGold) > B (GoldPrice.org) > C (Yahoo GC=F).** A is the brief's primary; B is the brief's named fallback and answers only from a residential IP; when B is unavailable (i.e. always on Vercel) C takes its place.

`market = round(usd_per_oz × usd_pkr / 31.1034768)` paisa/gram for A and C; `round(pkr_per_oz / 31.1034768)` for B.

### 6.1.1 Futures basis (measured, and why C is normalized)

GC=F is a COMEX futures contract, not spot. Measured Oct 26 (both legs at Friday's close): **GC=F 4007.90 vs spot 3996.899902 = +0.275%**. That is a structural offset, not noise, and it would (a) eat ~28 bps of a 100 bps divergence budget and (b) quote a "fallback" price roughly 0.3% above the market the user is being shown.

So C is normalized to a **spot-equivalent** before it is compared or published:

```
c_spot = c_raw × 10000 / (10000 + source_c_basis_bps)     # basis default 28 bps, in demo_settings
```

The allowance is a *measured expectation*, exposed in the UI (`GC=F 4007.90, basis −0.28%, spot-equivalent 3996.7`) and frozen into any receipt priced from it. This is deliberately a fixed number, not a rolling fit: if the real basis moves away from it (stress, roll, backwardation), the implied spot diverges from A and B and C gets **rejected** — which is the correct response, and a genuine signal rather than something the correction should hide.

Read **only `meta`**. The `indicators.quote[].close` series came back malformed pre-open (`KeyError: 'close'`), and we don't need candles — `regularMarketPrice` and `regularMarketTime` were both reliable. Send a browser `User-Agent`; Yahoo is not (observed) TLS-fingerprinting like goldprice.org, but that is unverified from Vercel.

### 6.2 Local vs deployed — the same code, one adapter, two modes

`GOLDPRICE_FETCH_MODE`:

- **`python`** (local): `server/sources/goldprice-org.ts` runs `python scripts/fetch_goldprice.py`, which uses `curl_cffi` with `impersonate="chrome"` + the full header set and prints one JSON object. Verified working from a residential IP.
- **`disabled`** (Vercel): B is not attempted. It is reported in the UI as **"GoldPrice.org — unavailable from this host (WAF blocks non-browser TLS fingerprints)"** and excluded from the quorum. This is a documented **gap**, not a silent omission.

So on Vercel the quorum is A + C; locally it is A + B + C. Nothing else in the app changes.

**Measured why this matters (Oct 26):** B returned `403` without the browser header set even *with* correct TLS impersonation, `403 "You've attempted too many requests"` when hit repeatedly, and once failed at DNS. B is opportunistic by nature: one attempt per cycle, never retried within a cycle, back-off on `403/429`.

### 6.3 Fetch cycle (lazy, on read)

```
getPrice():
  cached = redis.get('price:current')
  if cached and age < TTL(300s): return cached
  if now < redis.get('price:next_fetch_at'): return last row from price_cycles (stale, labelled)
  if not redis.set('price:next_fetch_at', now+20s, nx=true): return last cycle (someone else is fetching)
  run_cycle()                       # A (always), B (mode=python only), C (always)
  redis.set('price:current', result, ex=300)
  if cycle failed: redis.set('price:next_fetch_at', now+60s)   # failure backoff
```

- Serving stale while a fetch is in flight is intentional: the UI never blocks on a third party.
- Cache loss is not fatal: `price_cycles` in Postgres is the durable record, so "last good price + age" always renderable.
- The cooldown is set **on failure too**. A TTL cache alone would let a 403 storm refetch instantly — that's the difference between "ceiling" and "schedule".

### 6.4 Quorum / divergence algorithm

Let `P` = sources that answered and passed basic validation (parses, numeric, `> 0`, settled finite, within 10× of last trusted price — a sanity gate against unit errors). Let `T` = `divergence_threshold_bps` (default **100 bps = 1.0%**, adjustable at runtime).
`divergence_bps(a,b) = |a-b| × 20000 / (a+b)` — integer math.

| `|P|` | Rule |
|---|---|
| 0 | `paused`. No quotes. UI shows last good price + its age. |
| 1 | **Accept it.** `confidence = single_source`. No deadlock waiting for a validator. |
| 2 | If divergence ≤ `T`: accept both, use the higher-priority price, `validated`. If > `T`: reject the one **further from the last trusted price**; if no last trusted price exists, accept the higher-priority one and set `degraded`, flagging the other's value in the UI. |
| ≥3 | Compute the median `M`. Accept every source with `divergence(p, M) ≤ T`; reject the rest with `reject_reason='divergence'`. At least one is always accepted (for odd `n` the median is itself a source), so this branch can't deadlock either. |

Selection priority when several are accepted: **A (PakGold) > B (GoldPrice.org) > C (Yahoo GC=F)**. The published price is always a selected source's number — never an average — so "source" in the UI is always truthful. For C, that number is its basis-normalized spot-equivalent (§6.1.1), and it is labelled as such.

`degraded = true` whenever the selected source isn't A. The UI shows a "fallback" badge and the reason.

**Cadence caveat (documented, intentional):** divergence between sources can be *cadence*, not error — A's FX leg updates daily, B may recompute sooner, C is a different instrument entirely. That is exactly why the threshold exists: sub-threshold divergence is attributed to cadence and accepted. On a large market move, a lagging source can legitimately be rejected; that is the correct behavior, and the per-cycle `price_samples` table makes it explainable to the reviewer.

**Two-source tie-break** is the one case with no majority, which is why the last-trusted-price tiebreak above exists. On Vercel (A+C only) this path is reachable, so it is not academic.

### 6.5 Trading gate

A quote can only be issued when **all** hold:

- `confidence != 'paused'` and `force_paused = false`
- **Source availability** (checked on every read, not only when the price is stale), over the sources that are switched on *and* actually reported an accepted price:

  | Available | Trading |
  |---|---|
  | A alone | **allowed** — PakGold.pk is the trust anchor |
  | B alone, or C alone | **refused**: a lone non-PakGold number has no cross-check, so it cannot be validated |
  | A+B, A+C, B+C, A+B+C | **allowed** |
  | none | refused: no price to publish |

- `now - selected.price_fetched_at ≤ max_price_age_seconds` (default 600 s — two cycles; operator-settable from 1 s)
- selected price passes the sanity gate

Otherwise: `PRICE_UNAVAILABLE` with the honest reason and the age of the last good price (`TRADING_PAUSED` only for `force_paused`).

### 6.6 Freshness honesty

Never present response time as price time. Measured on **Sun Oct 25, 21:35 UTC**:

| Source | Value | Its own clock | Truth |
|---|---|---|---|
| A | 3996.899902 USD/oz — *identical* to the Oct 24 snapshot, three days running | `updatedAt` = 21:35:12Z, advancing | **Response time.** The price did not move; the timestamp did. |
| B | 1,104,969.02 PKR/oz, −0.024% vs its own prev close | `date` = Oct 25, 5:35 pm NY (current) | Provider moment; usable. |
| C | 4007.90 USD/oz | `regularMarketTime` = Fri Oct 23 20:59:58 UTC (**48.6 h old**) | **The honest clock.** Use it. |

Rule: `market_age = now − max(usable provider timestamps)`, where C's `regularMarketTime` is the best available market clock even when C is not the selected source. If `market_age > 15 min`, the UI says **"Last close · 48 h ago"**, never "live". A price is *live* only when its value actually changed across cycles **and** a provider timestamp is recent — never from a ticking `updatedAt`.

Session times, precisely (they differ, and that matters):

| Instrument | Opens | In local time |
|---|---|---|
| OTC spot XAU/USD (A, B) | Sunday 17:00 New York | 21:00 UTC = **02:00 PKT** |
| COMEX GC=F futures (C) | Sunday 17:00 Chicago | 22:00 UTC = **03:00 PKT** |

**Second probe, Sun Oct 25 21:38:40 UTC (02:38 PKT)** — 38 min into the spot week, 21 min before the futures open:

- **A**: `3996.899902` at both samples, identical to Friday's close to six decimals; `updatedAt` advanced 21:38:12 → 21:38:42 (30 s).
- **B**: `1,104,969.02` at 21:35 **and** 21:38 — byte-identical — while its provider date advanced. Its `prevClose` *had* rolled (1,105,237.27, from 1,119,376.66 the day before), so B's backend is alive but publishing no new prints.
- **C**: `4007.90`, `regularMarketTime` still Fri 20:59:58 UTC (48.6 h) — correct, futures open at 22:00 UTC.

Two *independent* feeds frozen identically is evidence of **no new market prints**, not of two dead feeds. The correct conclusion is "the week hasn't started printing yet", and the decisive test is the first ~30 min after the 22:00 UTC futures open. Do not label a value live until a provider timestamp is recent **and** the value has actually changed.

⚠️ **Open risk this exposed:** three days of bit-identical values behind a ticking timestamp is *also* what a pinned feed looks like, and A alone would be alarming. See §15.3.

---

## 7. Trade math

```
buy_unit  = max(ceil(market × 11000 / 10000), guardrail)     # guardrail is a floor we charge
sell_unit = floor(market × 9000 / 10000)                     # guardrail does not apply to sells
```

`guardrail_applied` is set when `guardrail > market × 1.10`, and it is shown on the quote *and* frozen into the receipt, so the reviewer can see the floor actually binding.

**Guardrail = one runtime variable** `demo_settings.guardrail_paisa_per_gram`, default `0` (off). The evaluator sets any value in the demo panel and watches a buy quote switch between "market × 1.10" and "guardrail". No redeploy, no code change. Rationale: an absolute floor is the only definition that doesn't depend on the data it's protecting against, and it is trivially demonstrable — which is the entire point of making it testable.

---

## 8. Demo controls (`/demo`, public, clearly labelled "not part of the product")

| Control | Backing | What the reviewer proves |
|---|---|---|
| Kill switch per source A / B / C | `source_*_enabled` | Fallback, degraded badge, single-source rule |
| `force_paused` | `demo_settings` | Trading halts; quotes refused; honest banner |
| Guardrail value (PKR/g) | `guardrail_paisa_per_gram` | `max(market×1.10, guardrail)` actually switching |
| Divergence threshold (bps) | `divergence_threshold_bps` | Tighten it and watch a source get rejected live |
| Quote TTL (seconds) | `quote_ttl_seconds` | Expiry in seconds instead of waiting 75 s |
| Set / reset balances | `balances` + `ledger_entries` | Shortfall paths: no cash, no gold, no inventory |
| Force price cycle now | clears the Redis cooldown | Test source changes without waiting 5 min |
| Reset all | reseed balances, clear quotes/trades | Repeat the demo cleanly |

Every action is written to `demo_events` and shown in a small activity log — that is what "does it still tell the truth" looks like when a source dies.

---

## 9. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | Balances, price panel (cycle + samples), recent trades, demo settings |
| `GET` | `/api/price` | Hot price only (from Redis). Polled every 30 s. Never triggers a fetch. |
| `POST` | `/api/quotes` | `{side, input_mode, input, from_quote_id?}` → quote |
| `POST` | `/api/quotes/:id/confirm` | Settle. Idempotent. |
| `POST` | `/api/quotes/:id/cancel` | Cancel. |
| `GET` | `/api/trades/:id` | Receipt. |
| `POST` | `/api/demo/*` | Controls above. |

Error envelope: `{ error: { code, message, hint?, detail? } }`. Codes: `INVALID_AMOUNT`, `BELOW_MIN`, `ABOVE_MAX`, `INSUFFICIENT_PKR`, `INSUFFICIENT_GOLD`, `INSUFFICIENT_INVENTORY`, `QUOTE_EXPIRED`, `QUOTE_CANCELLED`, `QUOTE_REJECTED`, `TRADING_PAUSED`, `PRICE_UNAVAILABLE`, `NOT_FOUND`, `INTERNAL`. Codes are a shared TS union so the client switches exhaustively and every failure renders a real affordance.

Quote response carries `expires_at` **and** server `now`, so the countdown is immune to client clock skew. The client clock is display-only; the server is the only judge of expiry.

---

## 10. UI states (mobile first)

`Price panel` (price, source, freshness, degraded badge) → `Trade form` (side toggle, PKR/g toggle, live derived preview, balance hints) → `Quote review` (locked price, spread as bps, guardrail if applied, countdown, dust disclosure) → `Receipt` (all terms + balances before/after) → `Back`.

Required non-happy states: trading paused; quote expired (with requote + price change); cancelled; insufficient cash/gold/inventory (each with the maximum affordable amount); stale price badge; fallback-source badge; B unavailable from this host.

---

## 11. Seed data

| Balance | Value | Why |
|---|---|---|
| PKR wallet | Rs 500,000.00 (`50_000_000` paisa) | Buys ~12 g — enough for a real trade, small enough to exhaust |
| User gold | 20.000000 g (`20_000_000` µg) | Selling 25 g must fail; selling all 20 g (≈ Rs 640k) must **succeed**, so full liquidation stays inside the Rs 1,000,000 per-trade cap |
| Platform inventory | 100.000000 g (`100_000_000` µg) | Buying more than 100 g must fail |

Total gold is **120 g forever** — the invariant every test asserts.

**Why 20 g and not 50 g:** at ~Rs 32,000/g sell price, 50 g is Rs 1.6M, which exceeds the Rs 1,000,000 per-trade notional cap — the reviewer could not liquidate their whole position, which is the most natural thing to try. The cap is the useful guard (it rejects absurd input crisply), so the seed moved instead.

---

## 12. File layout

```
app/
  page.tsx                  # trade flow (server component shell + client form)
  receipt/[tradeId]/page.tsx
  demo/page.tsx
  api/{state,price}/route.ts
  api/quotes/route.ts
  api/quotes/[id]/{confirm,cancel}/route.ts
  api/trades/[id]/route.ts
  api/demo/[...action]/route.ts
domain/                     # pure, no I/O, fully unit-tested
  units.ts                  # parse/format paisa, micrograms; integer helpers
  trade-math.ts             # quote construction, rounding table, guardrail
  quorum.ts                 # divergence, median, acceptance
server/
  db/{schema.ts,repo.ts,tx.ts}
  pricing/{cycle.ts,cache.ts,gate.ts}
  sources/{pakgold.ts,goldprice-org.ts,yahoo-futures.ts,fx.ts}
scripts/fetch_goldprice.py  # curl_cffi, local-only B leg
tests/{unit,integration}/
```

Rule: `domain/` has no imports from `server/`, no `fetch`, no `db`. It is the only place rounding exists.

---

## 13. Environment

| Var | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | |
| `GOLDPRICE_FETCH_MODE` | `python` locally, `disabled` on Vercel |
| `PYTHON_BIN` | default `python` |
| `YAHOO_SYMBOL` | default `GC=F` (COMEX front month) |

Local setup: `npm i`, `pip install curl_cffi` (already installed here, 0.16.3), `npx drizzle-kit migrate`, `npm run seed`, `npm run dev`.
Demo config lives in the **database**, not env — otherwise "no code changes to test edge cases" would mean "no redeploy", which is exactly what we're avoiding.

---

## 14. Test plan

**Unit (`domain/`)**
- Rounding table from §3.2, every path, including the `A ≤ A_in` round-trip property.
- Buy/sell at spread boundaries; guardrail below/at/above `market × 1.10`.
- Quorum: n=0/1/2/3, one outlier rejected, all-agree, two-source tie-break with and without last-good, threshold tightening.
- Input parser rejections (negative, zero, `NaN`, `1e9`, 3-dp PKR, `Infinity`).

**Integration (real Postgres)**
- Conservation: after 100 random trades, `user_gold + platform_gold == 250 g` exactly.
- Double-confirm → 1 trade, identical receipt both times.
- 10 concurrent confirms of one quote → exactly 1 trade.
- Expired quote (TTL forced to 1 s) → `QUOTE_EXPIRED`, no balance change.
- Insufficient PKR / gold / inventory → typed code, balances untouched, quote `rejected`.
- `balances.amount >= 0` and `trades.pkr_is_exact` actually reject bad writes.
- Paused state refuses quote creation.

**Manual reviewer script** (in README): the six stress cases from the brief, each with the expected screen and the exact button to press.

---

## 15. Known gaps (state these plainly in `WhatIDid.md`)

1. **GoldPrice.org (B) is unavailable from Vercel.** The WAF gates on TLS/JA3 fingerprint, and Vercel has no `curl_cffi`/`curl-impersonate`. Locally it works via Python. Mitigation: source C (Yahoo GC=F) takes B's place, and the UI says B is unavailable and why. This is a documented deviation from the brief's named fallback, not a silent drop.
2. **B is flaky even locally**: 403 without the exact header set, per-IP rate limiting ("attempted too many requests"), and one DNS failure observed on Oct 26. One attempt per cycle, back-off on failure.
3. **A's liveness is unproven — the biggest open risk.** gold-api returned bit-identical 3996.899902 USD/oz on Oct 24, 25 and 26, and was still identical 38 min after the spot week reopened, while `updatedAt` advanced every 30 s. B independently showed the same freeze. Most likely explanation: **no new market prints before the COMEX open** (03:00 PKT). The alternative — A serves a pinned value and never tracks spot — is not yet excluded and would be fatal to A-primary. Decisive test: re-probe ~30 min after 03:00 PKT (22:00 UTC). If A still hasn't moved while C has, **A is unusable and priority must fall to B (local) / C (prod)**, with the deviation documented. Do this before writing the pricing module.
4. **FX updates ~daily** (`open.er-api.com`), so the A leg is not tick-live in its currency component. Freshness display must attribute to the oldest leg.
5. **C is a futures contract.** COMEX GC=F measured +0.275% over spot, handled by the configurable basis normalization (§6.1.1) rather than by widening the threshold. The basis can move on a roll or in backwardation; when it does, C should be rejected, not silently trusted.
6. **C's reachability from Vercel is unverified**, as is whether Yahoo requires more than a browser `User-Agent`. Probe on deploy day, first thing, together with the A-liveness re-check.
7. **Neon cold start** adds latency on the first request after idle; the Redis price cache and `/api/state` warm-up absorb most of it.
8. Single-user by design; there is no isolation between "users" because there is no auth.

---

## 16. Deliverables

- Public repo: README (setup), `WhatIDid.md` (understanding, assumptions, decisions, gaps), this spec.
- Public deployment, no credentials.
- Build record: the agent transcript for this session, secrets redacted, **dead ends kept** (the float detour, the goldprice.org WAF probing, the DNS failure).

---

## 17. Decision log (for `WhatIDid.md`)

| # | Decision | Why |
|---|---|---|
| 1 | Integer minor units + BigInt, not float | Floats broke the invariant and the receipt formula in measurement (§3.1) |
| 2 | Postgres owns idempotency, Redis does not | One authority for "did this trade happen" |
| 3 | Conditional `UPDATE` instead of SERIALIZABLE/locks | Same guarantee, far less machinery |
| 4 | Quote stores final amounts, settlement never reprices | Kills the whole class of rounding mismatch |
| 5 | No reservations/holds | Simpler and safer for a single user |
| 6 | Three-source quorum with median outlier rejection | The brief's fallback fails on Vercel; a third source makes reliability measurable instead of assumed |
| 7 | Accept a single source rather than block | A validator can't be a dependency, or the demo deadlocks |
| 8 | Absolute, runtime-settable guardrail | Only definition independent of the data it guards against, and directly demonstrable |
| 9 | Lazy fetch + Redis cooldown, not cron | Serverless has no reliable 5-minute timer |
| 10 | B local-only, documented as a gap | Honest about the deployment constraint instead of faking a fallback |
| 11 | Priority A > B > C (Yahoo), per the brief owner | Keeps PakGold primary and the brief's named fallback second; C only stands in where B cannot reach |
| 12 | C basis-normalized with a configured 28 bps allowance | A futures price presented as spot would quote every fallback trade ~0.3% high; deviation from the allowance still surfaces as divergence |
| 13 | Read Yahoo `meta` only, not the candle series | `indicators.quote[].close` returned malformed pre-open; `regularMarketPrice`/`regularMarketTime` were reliable |

---

## 18. Open items (nothing blocking)

- Confirm the Vercel marketplace Redis is **Upstash** (the adapter is ~5 lines if it's a different provider).
- **Re-probe all three sources ~30 min after 03:00 PKT / 22:00 UTC** and settle whether A is live or pinned (§15.3). Blocks the pricing module. Expected shape of a pass: A's value changes, C's `regularMarketTime` becomes recent, and A↔C divergence stays under the threshold once C's basis is normalized.
- Probe Yahoo `GC=F` from the deployed region on day one (reachability + whether a plain `fetch` is enough), and re-measure the basis then.
- Note: `docs/gold_sources.md` is headed `# Todo.md` — source research appears to have been saved into the wrong file. Left untouched; this file is now the plan.
