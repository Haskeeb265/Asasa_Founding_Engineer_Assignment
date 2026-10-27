# AGENTS.md — session handoff

**Read this first.** Everything a new session needs to continue without re-explaining the project.
Append to the session log at the bottom; don't rewrite history above it.


_Last updated: Oct 28, 2026 (~03:30 PKT)._

---

## 1. What this is

A deployable, single-user demo for **buying and selling gold at live market prices**, built as the Asasa founding-engineer assessment. A reviewer must be able to see three balances, get a **75-second locked quote**, confirm once, and see updated balances plus a receipt — with no credentials and no code changes to test the edge cases.

- **Authoritative spec: `docs/Todo.md`.** It is the contract. Nothing in it should need re-deciding.
- `docs/gold_sources.md` — source research (endpoints, units, WAF behaviour).
- `docs/WhatIDid.md` — the narrative deliverable. **Currently stale**: says "2 sources", presents the guardrail as undecided, predates integer units and Yahoo. Must be rewritten before submission.
- `progress.md` — historical research checkpoint. Reads as history; its references to the deleted brief/PDF are dead on purpose.

The original PDF, `preview.png` and the consolidated brief (formerly `AI-Assistant/`) were **deleted on request**. Do not look for them.

## 2. Stack, as installed

| | |
|---|---|
| Next.js | 16.4.3 (App Router, Node runtime — not edge) |
| React | 19.3.1 |
| TypeScript | **7.0.2** — `baseUrl` is removed; `paths` resolve relative to tsconfig |
| Drizzle ORM | 0.45.4 + drizzle-kit 0.31.11 |
| DB | Neon Postgres, **pooled** connection string, `pg` 8.23 driver |
| Cache | Upstash Redis (`@upstash/redis` 1.39) |
| Validation | zod 4.6.7 |
| Tests | vitest 5.0.5 |
| Python | 3.13 with **curl_cffi 0.16.3 installed globally** (local-only GoldPrice.org leg) |

## 3. Current state — what exists, what doesn't

**Done and verified:**

```
package.json  tsconfig.json  next.config.ts  drizzle.config.ts  .gitignore  .env.example
app/layout.tsx  app/page.tsx                     (trade-flow UI page with tabs: Trade + Live data table)
server/db/schema.ts                              5 tables
server/db/index.ts                               pg Pool + Drizzle + runInTransaction
server/db/repo.ts                                settings / balances / settleQuote / cancelQuote / resetDemo
server/http.ts                                   typed ErrorCode union + envelope
server/serialize.ts                              JSON-safe wires + display strings
server/pricing/redis.ts                           no-op-safe Redis reads/writes
server/pricing/settings-like.ts                  settings-shaped helper
server/pricing/cycle.ts                          planned sources + sanity gate + quorum + rows per source
server/pricing/price.ts                          getPrice / hotPrice / snapshotFromDb / tradingGate
server/sources/types.ts                          source row + provider types
server/sources/pakgold.ts                        A = gold-api × er-api
server/sources/fx.ts                             6 h Redis-cached FX leg
server/sources/yahoo-futures.ts                  C = meta-only, basis-normalized, regularMarketTime kept
server/sources/goldprice-org.ts                  B → scripts/fetch_goldprice.py (curl_cffi chrome)
scripts/env.ts                                   tiny .env loader for tsx
scripts/seed.ts                                  idempotent seed (DEMO_SEED lives here)
scripts/probe_sources.ts                         source liveness probe (ad-hoc, not part of the build)
domain/units.ts                                  parse / limits / ingestion round / format
domain/trade-math.ts                             spreads, guardrail, grams-canonical rounding
domain/quorum.ts                                 divergence / median / trust rules / last-trusted tie-break
tests/unit/{units,trade-math,quorum}.test.ts     40 tests (11 + 14 + 15)
docs/{Todo.md, gold_sources.md, WhatIDid.md}  progress.md  README.md
drizzle/0000_gifted_mysterio.sql                generated DDL, reviewed
drizzle/0001_slim_firedrake.sql                 spec-mandated additions (rejection_reason + source_c_basis_bps)
```

**Not started:** `WhatIDid.md` rewrite (still stale), README reviewer script, integration tests against a real DB, any separate receipt or `/demo` UI page — the whole frontend is still `app/page.tsx`.

**Verification — run these to confirm the baseline is still good:**

```bash
npm run typecheck    # must exit 0
npx vitest run       # must be 40 passed
npx drizzle-kit generate   # must report no schema changes
```

## 4. Blocker

**`.env` exists** (recreated Oct 26 15:00 UTC). The DB-backed routes are now runnable once migrations are applied and the seed runs:

```
DATABASE_URL=                  # Neon POOLED string
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
GOLDPRICE_FETCH_MODE=python    # "disabled" on Vercel
PYTHON_BIN=python
YAHOO_SYMBOL=GC=F
```

Then: `npm run db:migrate` → `npm run db:seed`. `.env` is gitignored; don't commit it.

**Post-migrate verification:** after `db:migrate && db:seed`, run `npm run dev` and exercise a full quote → confirm → receipt flow against a real Postgres, then re-verify with the demo controls (`POST /api/demo/*`).

**Local DNS caveat still applies:** the host's router resolver can't resolve `api.gold-api.com` (EAI_AGAIN); 1.1.1.1 resolves it fine. Until fixed, local Node tries of source A fail; Vercel is unaffected. Probe methods: `dns.google/resolve`, `curl --resolve`, `nslookup … 1.1.1.1`.

## 5. Decisions already locked — do not re-litigate

| Decision | Why |
|---|---|
| **Integer minor units**: PKR in paisa, gold in microgram, price in paisa/gram, all `bigint` + JS `BigInt` | Floats broke the invariant in measurement: `50 + 10×0.1 = 51.000000000000014`, and a real quote round-tripped to `49999.99451625` instead of `50000` |
| **Postgres owns idempotency**, not Redis | One authority for "did this trade happen". A Redis blip must never become a money bug |
| Exactly-once via `UPDATE quotes SET status='settled' WHERE id=$1 AND status='active' AND expires_at > now()` | READ COMMITTED + row lock gives correct replay with no SERIALIZABLE, no advisory locks |
| **No ledger table.** The trade receipt is the record | User's call |
| No reservations/holds — availability re-checked under lock at settle | Simpler and safer for one user |
| **One `prices` row per source per fetch**, grouped by `cycle_id`, `selected` flag | User's call. No `price_cycles` table |
| Source priority **A (PakGold) > B (GoldPrice.org) > C (Yahoo GC=F)** | A is the brief's primary, B its named fallback, C stands in where B can't reach |
| Guardrail = absolute PKR/g, runtime-settable, default off | Only definition independent of the data it guards against, and directly demonstrable |
| Rounding favours the platform by ≤1 paisa: buy charge up, sell payout down; grams canonical | Makes `pkr == f(grams, price)` exact, so the DB CHECK can verify every receipt |
| Lazy price fetch + Redis cooldown, **no cron** | Vercel Hobby cron can't run every 5 minutes |
| Demo controls live in DB `settings`, not env | "Testable without code changes" must not mean "without a redeploy" |
| Single-user, no auth, no wallets table | Auth is explicitly out of scope |

## 6. Seed values (`settings` defaults too)

| Balance | Value | Note |
|---|---|---|
| `pkr` | `50_000_000` paisa (Rs 500,000) | buys ~12 g |
| `user_gold` | `20_000_000` µg (20 g) | full liquidation ≈ Rs 640k, inside the cap |
| `platform_gold` | `100_000_000` µg (100 g) | |

Total gold is **120 g forever** — the invariant every test asserts.

`settings` defaults: `quote_ttl_seconds` 75, `divergence_threshold_bps` 100, `max_price_age_seconds` 600, guardrail `0`, all three sources on.

**Trade limits** (`domain/units.ts`): min Rs 1,000 or 0.1 g; max notional Rs 1,000,000 per trade. The cap is deliberate — it is what makes absurd input fail crisply. The seed was reduced from 50 g to 20 g because 50 g (~Rs 1.6M) exceeded it, so a reviewer could not liquidate their whole position.

## 7. Next step, in dependency order

1. `server/db/index.ts` — `pg` Pool against the pooled URL, Drizzle client, `runInTransaction` helper.
2. `scripts/seed.ts` — three balances + singleton settings; idempotent (`ON CONFLICT DO NOTHING`).
3. `server/pricing/*` — the cycle: read Redis → cooldown check → fetch enabled sources → trust/divergence quorum → write `prices` rows → cache.
4. Routes: `GET /api/state`, `GET /api/price`, `POST /api/quotes`, `POST /api/quotes/:id/confirm`, `POST /api/quotes/:id/cancel`, `GET /api/trades/:id`, `POST /api/demo/*`.

Each route's contract, error codes and UI states are specified in `docs/Todo.md` §5, §6, §9, §10. Don't invent behaviour that contradicts it — fix the doc first if a decision changes.

## 8. Known risks (ranked)

1. **Gold-api liveness is unproven.** It returned `3996.899902` USD/oz on Oct 24, 25 and 26 — bit-identical — while `updatedAt` advanced every 30 s. B showed the same freeze, which is most consistent with *no market prints before the 22:00 UTC COMEX open*, but a pinned feed is not excluded. **Decisive test: re-probe ~30 min after the open.** If A is pinned while C moves, A is unusable and priority must fall to B/C.
2. **GoldPrice.org (B) is unreachable from Vercel.** Its WAF gates on TLS/JA3 fingerprint. Needs `curl_cffi` **and** the full browser header set (4/5 targets 200'd with headers, 5/5 403'd without). It also rate-limits per-IP ("attempted too many requests") and threw one DNS failure. One attempt per cycle, never retried within a cycle.
3. **C is a futures contract.** GC=F measured **+0.275%** over spot (4007.90 vs 3996.899902, both Friday's close). Normalized with a configurable `source_c_basis_bps` (default 28) before comparison; deviation from the allowance shows up as divergence, which is correct.
4. Yahoo: read **`meta.regularMarketPrice` + `meta.regularMarketTime` only** — the candle series returned malformed pre-open (`KeyError: 'close'`).
5. `open.er-api.com` FX updates ~daily, so leg A is not tick-live in its currency component.
6. Neon scale-to-zero cold start on first request after idle.

**Session times:** spot opens Sunday 17:00 New York = 21:00 UTC = 02:00 PKT; COMEX GC=F opens 17:00 Chicago = 22:00 UTC = 03:00 PKT.

## 9. Gotchas already hit (don't rediscover these)

- TypeScript **7** removed `baseUrl` → `paths` only.
- `drizzle-kit generate` throws `Do not know how to serialize a BigInt` if any column default is `0n`. Use `.default(sql\`0\`)`.
- `tsconfig` has `noUncheckedIndexedAccess: true` — array destructuring and `[i]` yield `T | undefined`.
- `bigint` columns return **BigInt** in JS; `JSON.stringify` throws on them. Convert at the boundary with `toWire()` in `domain/units.ts`.
- `echo "exit=$?"` after a pipe reports the pipe's status, not the command's. Use `set -o pipefail`.

## 10. Conventions

- Column and variable names carry their unit: `pkrPaisa`, `goldMicrograms`, `unitPaisaPerGram`. Never a bare `amount`.
- **Rounding exists only in `domain/trade-math.ts`.** Ingestion rounding exists only in `domain/units.ts`.
- `domain/` is pure: no `fetch`, no db, no imports from `server/`. It is the unit-tested core.
- Route handlers stay thin: zod at the boundary, all maths in `domain/`, all I/O in `server/`.
- The client never does money arithmetic; it formats. Server sends `expires_at` **and** `now` so the countdown survives clock skew.
- Error envelope: `{ error: { code, message, hint? } }` with the typed codes from `docs/Todo.md` §9.
- Never publish an averaged price — the shown price is always one named source's number, so "source" stays truthful.

_Last updated: Oct 28, 2026 (~03:30 PKT)._

---

## Session log

### 2026-10-28 ~04:50 PKT — "fetched Ns ago" label fixed to the clock the max-age gate checks

User report: set Max price age = 300, but the market card said "fetched 604s ago". Diagnosis:
the gate (tradingGate) checks `fetchAgeSeconds` (seconds since the producing cycle ran) and was
working — live /api/state showed fetch 76s / source stamp 680s; the displayed number was
`market_age_seconds`, i.e. source A's own market stamp (updatedAt lags minutes on weekends),
mislabelled as the fetch age. Fix:
- `server/serialize.ts`: priceWire now also sends `fetch_age_seconds`.
- `app/page.tsx`: MarketCard's dot + text use `fetch_age_seconds` ("fetched 76s ago"), with the
  provider stamp shown separately (" · source updated 680s ago").
- `app/api/quotes/route.ts`: the PRICE_UNAVAILABLE hint quotes the fetch age it actually gate
  on ("Price fetched N s ago (max M s) — …"), not the provider stamp.

Verified live: /api/state carries both clocks; typecheck 0; vitest 40/40; next build clean.

### 2026-10-28 ~04:40 PKT — lime plate + Binance-style mobile app screen

UI only (no server changes): typecheck 0, vitest 40/40, `next build` clean, and `inspect.mjs`
(production `next start`, --app) at 1440/768/390 shows 0 FAIL / 5 defensible WARN. Screenshots in
`.taste-skill/mobile-round2/` (untracked working folder, not committed).

1. **Lime plate, black text** — `.kpi-strip-dark` (wallet strip) is now the lime ground with black
   text (`#17200e`); `.card-market` figures/muted/meta switched from white to black over lime; the
   degraded-price inline white style in page.tsx dropped to `color: inherit`. Hairline dividers on
   lime at rgba(23,32,14,0.12); skeleton fills darkened.
2. **Binance-prompted mobile app screen (≤900px)** — bottom tab bar gained real icons (inline SVG in
   `app/chrome.tsx`, hidden on desktop, active tab tinted `--hue`, inactive `--muted`); solid top bar
   (no blur glass). New appended `@media (max-width: 900px)` block in globals.css recasts the phone
   as its own composition: tonal `#eff1ef` ground, borderless 14px cards, kpi hero (32px figure) +
   hairline asset rows, **segmented Buy/Sell pill** (active segment filled teal, underline rail
   removed), 58px input with 24px figures, 52px buttons, quote/receipt panels on soft fills, nails
   single-column receipts with stacked balance footers.
3. **Widths/paddings, no-wrap** — canvas-inner 1160→1240, market column 360→400, kpi padding
   18/22px, derived-value 15px nowrap (mobile 16px) so "PKR 39,783.61 / g" stays on one line;
   field-hint wraps instead of clipping at 390px; phone text floor 13px (sublines 12px).

Inspector FAIL fixed: receipt side pills de-uppercased (12px sentence case). Remaining warns kept
with reasons: lime colour-spread ≈27% is the user's explicit palette call; inspector reads
rgba-divider base ink only (rendered at 0.12 alpha); hero-void/unused-canvas are the pre-existing
desktop layout the user wanted kept.

---

### 2026-10-27 ~04:20 PKT — flow.md spec change applied end-to-end; live DB verified

flow.md replaced the old integer-minor-units/dedicated-jobs design with: full-precision big.js
money (whole PKR records), spot 24K pricing from three sources: A=PakGold.pk
(gold-api × er-api), B=GoldPrice.org (curl_cffi python leg), C=Yahoo GC=F basis-normalized
validator-only; cycle every 5 min with per-source statuses OK/FAILED/INVALID/STALE/UNRELIABLE,
pairwise divergence < 0.5% on full-precision prices, strict selection A else B, C never displayed,
no last-known price (NO_PRICE row + fixed message when validation fails); quotes are
PENDING/CONFIRMED/CANCELLED/EXPIRED with a client idempotency key; receipts carry before/after
balances; exactly-once via conditional UPDATE inside a FOR UPDATE transaction.

- **schema.ts rewritten** (accounts / price_snapshots / current_price / quotes / receipts /
  settings), migration regenerated as `drizzle/0000_adorable_dakota_north.sql` (plus snapshots).
  NOTE: the earlier generated migration had a double-unique (constraint + same-named
  uniqueIndex) on receipts.quote_id which broke apply — fixed by dropping the uniqueIndex and
  keeping the column-level `.unique()`.
- **Old tables dropped in Neon** (balances, prices, trades + stale shared tables from the
  previous design) before applying the fresh migration; demo data only, no real data kept.
- **Verified against the live Neon DB (localhost):** cycle ran (A OK 35,723/g, B OK after
  installing curl_cffi `python -m pip install curl_cffi`, C STALE (Sunday, futures didn't print)),
  divergence A–B 0.0015% ok; NO_PRICE state with the exact required message when it fails;
  buy quote (Rs 5,000 → 0.12724... g at locked 39,295/g, predictions marked), replay key → 200,
  confirm → receipt with before/after balances, second confirm → same receipt replayed=true,
  cancel-after-confirm → 409 QUOTE_CONFIRMED; sell 0.5 g → PKR 16,075 (round half up);
  guardrail set 50,000 → took over the buy price with guardrail_applied recorded, sells
  untouched; BELOW_MIN / TOO_MANY_DECIMALS / ABOVE_MAX typed errors; quote history + trade
  history + receipt fetch all good; demo/reset restored clean state.
- **Bug fixes during the smoke test:** seed.ts must load .env before server/db is imported
  (pool is created at module import) — dynamic import inside main(); drizzle.config.ts now
  loads .env itself; `drizzle-kit migrate` still exits 1 silently — the migration is applied
  via a one-off script that splits on `--> statement-breakpoint`. Re-examine if a reviewer
  needs a clean `npm run db:migrate`.
- **README rewritten** with the reviewer script; **.env.example scrubbed** to placeholders
  (it previously carried the real Neon password + Upstash tokens — rotate those secrets
  if they were ever in git history).
- **Still open:** `docs/WhatIDid.md` rewrite, integration tests, Vercel deploy pass
  (GOLDPRICE_FETCH_MODE=disabled there), local DNS caveat for gold-api resolved since the
  cycle now reaches A.

### 2026-10-26 — spec closed, foundation built
- R&D with the user settled: integer units over float (evidence: float drift), Postgres-owned idempotency, no ledger table, one row per source per fetch, A>B>C priority with Yahoo as C, absolute runtime guardrail, public `/demo`.
- Deleted `AI-Assistant/` (PDF, preview, brief) on request; kept README (deliverable).
- Scaffolded Next 16 + Drizzle + vitest; wrote schema, generated migration, wrote the pure money core, 25 tests green.
- Found and fixed: seed 50 g → 20 g (cap made liquidation impossible), TS7 `baseUrl`, drizzle BigInt default.
- **Blocked:** `.env` is gone; no database access.

### 2026-10-26 13:51 UTC — server + route layer + frontend page built, still blocked on .env
- Completed the items that used to be "not started": `server/db/index.ts`, `server/db/repo.ts`, the full pricing cycle + three source adapters, Redis cache/cooldown, every API route, `scripts/seed.ts`, `server/http.ts`, `server/serialize.ts`, `domain/quorum.ts` (15 new unit tests), and a 75-second locked-quote trade-flow frontend page in `app/page.tsx`.
- All 7 routes exist and typecheck clean: `GET /api/state`, `GET /api/price`, `POST /api/quotes` (with `from_quote_id` → `price_change_bps`), `POST /api/quotes/[id]/confirm`, `POST /api/quotes/[id]/cancel`, `GET /api/trades/[id]`, `POST /api/demo/[...action]`.
- Migrations exist and must both be applied before any route runs: `drizzle/0000_gifted_mysterio.sql` (original generated DDL) and `drizzle/0001_slim_firedrake.sql` (spec-mandated `quotes.rejection_reason` + `settings.source_c_basis_bps`).
- **Verified green locally:** typecheck exit 0; vitest **40/40** across `tests/unit/{units,trade-math,quorum}.test.ts`.
- **Still blocked the same way:** `.env` is absent, so `db:migrate`, `db:seed`, and every route run remain unexercised against a live Postgres. Local DNS caveat still applies: the host's router resolver can't resolve `api.gold-api.com` (EAI_AGAIN); 1.1.1.1 resolves it fine, and Vercel is unaffected.
- **Still stale / not done:** `docs/WhatIDid.md` (predates integer units + Yahoo), README reviewer script, integration tests, any separate receipt or `/demo` UI page. The whole frontend is still `app/page.tsx`.

### 2026-10-26 13:51 UTC — progress.md reconciled into the live project history
- `progress.md` was originally a stale research checkpoint (with a dead brief/PDF/Requirement.md/preview.png lineage and a "no coding started" status). It has been rewritten to carry both the original understanding + Q1/Q2 research answers **and** the later build state.
- New §5 in `progress.md` records what actually got built, what's verified green, and what's still missing before a reviewer can run the live flow.### 2026-10-26 13:51 UTC — server layer built (final form)
- **A-liveness decisive probe passed** (§18): A fetched `4004.199951` USD/oz @ 22:19Z — first move off the frozen `3996.899902` — minutes after the spot week opened. C was printing intraday (regularMarketTime 22:08:39Z fresh, day range 4005.5–4016.3). FX `276.820884`, updated Sun 00:02Z (~daily cadence as expected). A↔C after C's 28 bps basis ≈ 19 bps — inside threshold. A stays primary.
- **Schema additions + migration `0001_slim_firedrake.sql`**: `quotes.rejection_reason` (§5.2 diagnosis) and `settings.source_c_basis_bps` default 28 with −500..500 check (§6.1.1). First DB to be touched must apply migrations 0000 + 0001.
- Built and typechecked (exit 0; vitest 40/40):
  - `server/db/index.ts` (pg Pool + Drizzle + `runInTransaction`), `scripts/env.ts` (tiny .env loader for tsx), `scripts/seed.ts` (idempotent, `DEMO_SEED` lives there).
  - `domain/quorum.ts` (divergence `|a-b|×20000/(a+b)`, median, n=0/1/2/3 rules, last-trusted tie-break; + 15 unit tests).
  - `server/sources/`: `types.ts`, `fx.ts` (6 h Redis cache), `pakgold.ts` (A = gold-api × er-api; provider stamp deliberately unused — crafting a freshness fake), `yahoo-futures.ts` (meta-only, basis-normalized, `regularMarketTime` kept), `goldprice-org.ts` → `scripts/fetch_goldprice.py` (curl_cffi chrome; works: 1,105,748.83 PKR/oz). B's `ts`/`date` fields returned null from the JSON parse — its row reports response-age only.
  - `server/pricing/`: `redis.ts` (no-ops degrade gracefully without creds), `settings-like.ts`, `cycle.ts` (planned sources, sanity gate vs last trusted `selected` row, quorum, one `prices` row per source), `price.ts` (`getPrice` §6.3 with 300 s cache, 20 s claim-window cooldown doubling as check, 60 s failure backoff; `hotPrice` for `/api/price` never fetches; `snapshotFromDb` durable rebuild; `tradingGate` §6.5).
  - `server/db/repo.ts` (settings ensure-row, balances, resetDemo ON CONFLICT, `settleQuote` = claim-conditional-UPDATE + `FOR UPDATE` re-read + typed shortfall (flips claim to `rejected`) + deltas + `trades` insert; `cancelQuote` diagnostics).
  - `server/http.ts` (typed `ErrorCode` union + envelope; adds `TOO_MANY_DECIMALS`, `AMOUNT_NOT_POSITIVE`, `QUOTE_SETTLED`, `BAD_REQUEST` to §9's list), `server/serialize.ts` (JSON-safe wires; display strings computed here, client only formats).
  - Routes: `GET /api/state`, `GET /api/price`, `POST /api/quotes` (with `from_quote_id` → `price_change_bps`), `POST /api/quotes/[id]/confirm` (settled/replayed/expired/cancelled/rejected/shortfall diagnostics per §5.2), `POST /api/quotes/[id]/cancel`, `GET /api/trades/[id]`, `POST /api/demo/[...action]` (toggle-source, pause, guardrail, threshold, ttl, override, set-balance, force-cycle, reset).
  - Frontend: `app/page.tsx` rewritten as the trade-flow page — form (side/mode/amount/quote/clear) + state panel (balances + market price + active-quote card) + receipt block + in-flow errors, wired to the same API routes. No separate receipt page or `/demo` UI page yet.
- Local machine DNS: router resolver (192.168.0.1) fails only `api.gold-api.com` (EAI_AGAIN; 1.1.1.1 resolves it) — source A will fail from local Node until host DNS is fixed or router recovers; Vercel unaffected. Probe methods: `dns.google/resolve`, `curl --resolve`, `nslookup … 1.1.1.1`.
- Still blocked: `.env` absent → `db:migrate`, `db:seed`, and every route run are unexercised against live Postgres.



### 2026-10-26 13:51 UTC — codebase state snapshot after the frontend rewrite

- `app/page.tsx` is the only UI page (922 lines). It is a single Next.js client page with `Page`, `TradeFlowInner`, `StatePanel`, `Field`, `SegmentedControl`, `BalanceCard`, `PriceCard`, `QuoteCard`, `QuoteAction`, and a tiny `formatMicro` helper.
- It calls `GET /api/state` on mount, then `POST /api/quotes`, `POST /api/quotes/:id/confirm`, `POST /api/quotes/:id/cancel`.
- Remaining frontend state after the rewrite: the page itself builds and typechecks clean; what is still unresolved is that the backend is not yet wired to a real DB because `.env` is missing. The page is therefore not yet a working live demo.

### 2026-10-26 13:51 UTC — server layer built (final form)

- **A-liveness decisive probe passed** (§18): A fetched `4004.199951` USD/oz @ 22:19Z — first move off the frozen `3996.899902` — minutes after the spot week opened. C was printing intraday (regularMarketTime 22:08:39Z fresh, day range 4005.5–4016.3). FX `276.820884`, updated Sun 00:02Z (~daily cadence as expected). A↔C after C's 28 bps basis ≈ 19 bps — inside threshold. A stays primary.
- **Schema additions + migration `0001_slim_firedrake.sql`**: `quotes.rejection_reason` (§5.2 diagnosis) and `settings.source_c_basis_bps` default 28 with −500..500 check (§6.1.1). First DB to be touched must apply migrations 0000 + 0001.
- Built and typechecked (exit 0; vitest 40/40):
  - `server/db/index.ts` (pg Pool + Drizzle + `runInTransaction`), `scripts/env.ts` (tiny .env loader for tsx), `scripts/seed.ts` (idempotent, `DEMO_SEED` lives there).
  - `domain/quorum.ts` (divergence `|a-b|×20000/(a+b)`, median, n=0/1/2/3 rules, last-trusted tie-break; + 15 unit tests).
  - `server/sources/`: `types.ts`, `fx.ts` (6 h Redis cache), `pakgold.ts` (A = gold-api × er-api; provider stamp deliberately unused — crafting a freshness fake), `yahoo-futures.ts` (meta-only, basis-normalized, `regularMarketTime` kept), `goldprice-org.ts` → `scripts/fetch_goldprice.py` (curl_cffi chrome; works: 1,105,748.83 PKR/oz). B's `ts`/`date` fields returned null from the JSON parse — its row reports response-age only.
  - `server/pricing/`: `redis.ts` (no-ops degrade gracefully without creds), `settings-like.ts`, `cycle.ts` (planned sources, sanity gate vs last trusted `selected` row, quorum, one `prices` row per source), `price.ts` (`getPrice` §6.3 with 300 s cache, 20 s claim-window cooldown doubling as check, 60 s failure backoff; `hotPrice` for `/api/price` never fetches; `snapshotFromDb` durable rebuild; `tradingGate` §6.5).
  - `server/db/repo.ts` (settings ensure-row, balances, resetDemo ON CONFLICT, `settleQuote` = claim-conditional-UPDATE + `FOR UPDATE` re-read + typed shortfall (flips claim to `rejected`) + deltas + `trades` insert; `cancelQuote` diagnostics).
  - `server/http.ts` (typed `ErrorCode` union + envelope; adds `TOO_MANY_DECIMALS`, `AMOUNT_NOT_POSITIVE`, `QUOTE_SETTLED`, `BAD_REQUEST` to §9's list), `server/serialize.ts` (JSON-safe wires; display strings computed here, client only formats).
  - Routes: `GET /api/state`, `GET /api/price`, `POST /api/quotes` (with `from_quote_id` → `price_change_bps`), `POST /api/quotes/[id]/confirm` (settled/replayed/expired/cancelled/rejected/shortfall diagnostics per §5.2), `POST /api/quotes/[id]/cancel`, `GET /api/trades/[id]`, `POST /api/demo/[...action]` (toggle-source, pause, guardrail, threshold, ttl, override, set-balance, force-cycle, reset).
  - Frontend: `app/page.tsx` rewritten as the trade-flow page — form (side/mode/amount/quote/clear) + state panel (balances + market price + active-quote card) + receipt block + in-flow errors, wired to the same API routes. No separate receipt page or `/demo` UI page yet.
- Local machine DNS: router resolver (192.168.0.1) fails only `api.gold-api.com` (EAI_AGAIN; 1.1.1.1 resolves it) — source A will fail from local Node until host DNS is fixed or router recovers; Vercel unaffected. Probe methods: `dns.google/resolve`, `curl --resolve`, `nslookup … 1.1.1.1`.
- Still blocked: `.env` absent → `db:migrate`, `db:seed`, and every route run are unexercised against live Postgres.

### 2026-10-26 — progress.md reconciled; now the live project history

- **progress.md was stale research** (checkpoint with a dead brief/PDF/Requirement.md/preview.png lineage). It has been rewritten as the live project history: what exists, the design decisions actually wired into the code, the complete source/pricing/route layout, and the current blocking state.
- **What's wired, verified, and green locally:** typecheck exit 0; vitest **40/40** — 15 new in `tests/unit/quorum.test.ts` beyond the earlier 25; local A and B probes passed; all 7 routes + their typed error codes exist.
- **Two migrations must be applied before any route runs:** `drizzle/0000_gifted_mysterio.sql` (the original `0000` generated for the built `schema.ts`) and `drizzle/0001_slim_firedrake.sql` (the spec-mandated additions). They are plain SQL you can apply with the project's `db:migrate` script or by hand.
- **Current blocker:** `.env` is present; `db:migrate`, `db:seed`, and every route remain unexercised against a live Postgres.
- **Local DNS caveat still applies:** the host's router resolver can't resolve `api.gold-api.com` (EAI_AGAIN); 1.1.1.1 resolves it fine. Until fixed, local Node tries of source A fail; Vercel is unaffected.
- Remaining work after `.env` is in place: `db:migrate && db:seed && dev`, then exercise a full quote → confirm → receipt flow against a real DB and re-verify with the demo controls.

### 2026-10-26 ~19:00 UTC — frontend typecheck fixes + doc update
- Fixed `app/page.tsx` typecheck errors that had crept in: duplicate/premature `StatePanel` function closure leaving its body floating outside any function; missing `setReceipt`/`setTradeResult`/`setAmountError` props on `TradeFlowInner`; `StatePanel` referencing undefined `confirmQuoteInner`/`cancelQuoteInner` stubs; `QuoteCard` and in-flow copy accessing `gold_display`/`pkr_display`/`unit_display` on the `active_quote` type that only carries the raw numeric fields. All props now flow correctly from `Page` → `TradeFlowInner` → children, and `StatePanel` receives `confirmQuote`/`cancelQuote` from `Page`.
- Verified: `npm run typecheck` exits 0; `npx vitest run` is 40/40.
- Updated `AGENTS.md` §3 (seed.ts now exists, test count 40, added `scripts/probe_sources.ts` to the tree) and §4 (blocker is now "migrations+seed unexercised", not ".env missing").
- **Still stale:** `docs/WhatIDid.md` (predates integer units + Yahoo), README reviewer script, integration tests. The whole frontend is still `app/page.tsx` (trade-flow + live data table tabs).

### 2026-10-27 ~09:25 PKT — Staged quotes: confirm now, execute when the timer runs out
User request: confirm alone must not execute the trade; it must execute only when the quote's
remaining time hits zero. Cancel, however, kills the quote at any moment regardless of remaining
time. Implemented as a staged flow that keeps Postgres as the single authority:

- **Repo** (`server/db/repo.ts`): `confirmQuote` (conditional UPDATE active→confirmed, the same
  claim-then-diagnose pattern; double confirm replays). `settleConfirmedQuote` (claim
  confirmed→settled WITH NO clock condition — the caller only hands it due quotes; balances still
  re-read FOR UPDATE and re-validated, so money that left between confirm and expiry flips the
  quote to `rejected`, never a negative balance). `settleDueConfirmedQuotes` lazy sweep (≤25 at a
  time, per-quote errors never poison the pass). `cancelQuote` now cancels from BOTH active and
  confirmed (cancel wins against remaining time); expired confirmed → expired outcome. Confirm
  diagnosis handles already-expired (409 QUOTE_EXPIRED, was falling through to 404).
- **Settlement trigger**: lazy, no cron — `/api/state` sweeps active-expiry then confirmed-due
  BEFORE reading balances/trades (so the receipt history and wallet include the just-executed
  trade), plus the background `scheduler.ts` tick sweeps both so settlement doesn't depend on an
  open client.
- **Routes**: confirm returns `{ confirmed, replayed?, quote }` 200 instead of a receipt (receipt
  comes at execution time); expired confirm keeps the current-price + price_change_bps affordance.
- **Schema**: `quotes_status_valid` widened with `'confirmed'` — regenerated as
  `drizzle/0001_add_confirmed_status.sql` (drop + re-add the check) and APPLIED to Neon via
  `npx tsx` one-off (drizzle-kit migrate still exits 1; that limitation stands).
- **Client** (`app/page.tsx`): QuoteCard for status `confirmed` — banner "Confirmed. The trade
  executes the moment the timer runs out — cancel kills it before that", Confirm disabled
  ("Confirmed"), Cancel live, timer bar turns deep-teal. `pendingQuoteId` ref: when the polled
  /api/state picks up the swept settlement, the receipt card is stamped automatically. /api/state
  re-serves active OR confirmed unexpired quotes as the adoptable in-flight quote.

**Verified live against Neon** (TTL shortened to 10 s): confirm → 200 confirmed; wallet untouched
mid-timer + in-flight shows `confirmed`; double confirm → replayed; cancel ~1 s after confirm →
200 cancelled, wallet unchanged, repeat cancel idempotent; confirmed quote settled as the clock
hit zero (receipt appeared in trades, wallet moved exactly −1,999.98 / +0.050273 g); confirm and
cancel of an already-expired quote → 409 QUOTE_EXPIRED. TTL restored to 75 s. Typecheck exit 0,
pytest 40/40 equivalents (vitest 40/40), next build clean. **Architecture note:** quotes were
previously settled-on-confirm; the reviewer-verifiable exactly-once property now lives in the
expiry sweep, and cancel-after-confirm (impossible before) is now a supported, tested path.

### 2026-10-28 ~03:35 PKT — "Trading is paused" root-caused and fixed; source B (GoldPrice.org) deployable on Vercel

User symptom: force_paused is off, yet clicking Get Buy Quote returns "Trading is paused right now."
Three causes found, all fixed:

1. **`snapshotFromDb` read the 60 OLDEST rows** (`orderBy(fetchedAt).limit(60)` ascending). The "last
   recorded cycle" it served dated to the earliest rows in the table, so whenever the durable
   fallback was consulted its age was over the max and the gate fired on an old snapshot. Fixed in
   `server/pricing/price.ts`: `orderBy(desc(fetchedAt))` + newest-first leading-cycle detection.
2. **The staleness gate used the PROVIDER's market clock** (`providerSeconds` → `marketAgeSeconds`)
   to return `TRADING_PAUSED`/"Trading is paused" — e.g. gold-api's `updatedAt` lagging ~604 s while
   the cycle itself was seconds old. flow.md §3.7 defines staleness as fetch-job staleness. Fixed:
   `PriceSnapshot` gained `fetchAgeSeconds` (`now − fetchedAtSeconds`); `tradingGate` checks it;
   `marketAgeSeconds` (provider clock) remains display info only.
3. **Message mapping** (`app/api/quotes/route.ts`): only `force_paused` says "Trading is paused right
   now."; every other refusal (all sources failed, stale cycle) uses the flow.md §3.6 message
   "Prices cannot be validated right now. Please try again in 5 minutes." with `PRICE_UNAVAILABLE`.

Also fixed en route: zero enabled sources crashed the cycle (`values([])` on an empty insert) —
guarded in `server/pricing/cycle.ts`.
Env flakiness observed (not a code bug): `open.er-api.com` (FX leg) intermittently "fetch failed"
from this host in minute-scale windows; B's python leg then carries the cycle as single_source.
Note: Next dev hot-reload caused confusion during diagnosis — an old dev server kept serving half
the fix; when testing, restart `npm run dev` after server-side changes.

**Source B on Vercel — was never implemented there.** Plain Node fetch with full browser headers is
403'd (TLS/JA3 WAF, verified). New in repo: root `api/goldprice.py` (Vercel file-based Python
function, BaseHTTPRequestHandler) reusing `fetch_goldprice()` extracted from
`scripts/fetch_goldprice.py`; `requirements.txt` lists curl_cffi only (no web framework, so no
Python preset takes over routing); `vercel.json` ships `scripts/fetch_goldprice.py` into the
function bundle (`includeFiles`, maxDuration 30). The Node adapter gained
`GOLDPRICE_FETCH_MODE=remote` (GET /api/goldprice; URL from `GOLDPRICE_REMOTE_URL` or the
auto-injected `VERCEL_URL`). Verified locally: handler import and an end-to-end remote round-trip
(python handler → Node adapter → paisaPerGram). On Vercel set `GOLDPRICE_FETCH_MODE=remote`;
nothing else needed. `.env.example` and README updated.

Verification this session: typecheck exit 0; vitest 40/40; live dev server — quote 201 on repeated
force-cycles, force-paused → TRADING_PAUSED message, all-sources-off → the no-price message,
`/api/state` healthy. Temporary `app/api/debug-price` route was added for diagnosis and removed.

### 2026-10-28 ~09:05 PKT — Test.md items: quote auto-expiry, receipts history, settings toggle, color treatment, mobile revamp
From `Test.md` (item 1, "formulas", was retracted by the user mid-session — NO formula changes were
made to domain/trade-math.ts; confirmed intact, nothing to revert):
- **Quote folds itself away on expiry.** `QuoteCard` fires `onExpire` once when the countdown hits 0
  (`useRef` guard per quote id); parent clears the quote + refetches. `/api/state` now sweeps
  `status='active' AND expires_at < now → 'expired'` before selecting the adoptable quote, and the
  client never re-adopts a quote whose `expires_at` has passed. Copy on the quote card updated.
- **Receipts section on the User page (`/`).** `/api/state` walks the 10 recent trades newest→oldest
  from the live wallet, reversing each delta, so every trade now carries `balances_before/after`
  (exact bigint arithmetic server-side; exact as long as no demo `set-balance` ran since — reset
  deletes trades so the drift case is only mid-history balance overrides). New `ReceiptsSection` +
  `ReceiptCard` in `app/page.tsx`: side pill (Buy lime / Sell teal), gold + PKR delta figures,
  price/market/source/guardrail rows, "balance after" footer. Empty state included.
- **Settings view toggle.** Settings card head now has a Show/Hide button (`aria-expanded`);
  hidden by default; body rendered only when shown.
- **Wallet tiles dark:** `.kpi-strip-dark` — black background (#000), all text #8ccb50 (lime),
  dark hairlines, matching skeleton variant; applied to the KPI strip (striped also on mobile).
- **Market price card lime:** `.card-market` — #8ccb50 background, white text throughout (figure,
  derived cells, meta lines, note), white ok-dot / dark warn-dot so the freshness dot survives
  the green plate; degraded reason restyled white (was var(--danger), unreadable on lime).
- **Mobile revamp (new request mid-session).** Desktop untouched; ≤900px: hamburger login-sheet
  replaced by a fixed **bottom tab bar** (mobile nav psychology: thumb distance), sticky blurred
  topbar with page label, canvas bottom padding accounts for safe-area + bar. ≤720px touch pass:
  48–56px controls (buttons 50px, amount input 56px/21px, side tabs taller), bigger figures,
  receipts single-column, stacked "balance after" footer, tightened card gaps.

Verification: typecheck exit 0; vitest 40/40; `npx next build` clean; live dev server —
`/api/state` 200 and the walked balances chained exactly (newest trade's after == live wallet,
every before == next trade's after, back to seed). Committed & pushed to main.
