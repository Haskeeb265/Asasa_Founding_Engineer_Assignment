# AGENTS.md — session handoff

**Read this first.** Everything a new session needs to continue without re-explaining the project.
Append to the session log at the bottom; don't rewrite history above it.

_Last updated: Oct 26, 2026 (02:38 PKT / Oct 25 21:38 UTC)._

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
app/layout.tsx  app/page.tsx                     (placeholder shell)
server/db/schema.ts                              5 tables
drizzle/0000_gifted_mysterio.sql                 generated DDL, reviewed
domain/units.ts                                  parse / limits / ingestion round / format
domain/trade-math.ts                             spreads, guardrail, grams-canonical rounding
tests/unit/{units,trade-math}.test.ts            25 tests
docs/{Todo.md, gold_sources.md, WhatIDid.md}  progress.md  README.md
```

**Not started:** `server/db/index.ts` (client), `server/db/repo.ts`, pricing cycle + three source adapters, Redis cache/cooldown, every API route, the UI, `scripts/seed.ts`.

⚠️ `package.json` already defines `db:seed` → `scripts/seed.ts`, **which does not exist yet.** Creating it is part of the next step.

**Verification — run these to confirm the baseline is still good:**

```bash
npm run typecheck    # must exit 0
npx vitest run       # must be 25 passed
npx drizzle-kit generate   # must report no schema changes
```

## 4. Blocker

**`.env` is missing** (it existed at session start, then vanished). Nothing that touches the database can be exercised until it is recreated:

```
DATABASE_URL=                  # Neon POOLED string
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
GOLDPRICE_FETCH_MODE=python    # "disabled" on Vercel
PYTHON_BIN=python
YAHOO_SYMBOL=GC=F
```

Then: `npm run db:migrate` → `npm run db:seed`. `.env` is gitignored; don't commit it.

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

---

## Session log

### 2026-10-26 — spec closed, foundation built
- R&D with the user settled: integer units over float (evidence: float drift), Postgres-owned idempotency, no ledger table, one row per source per fetch, A>B>C priority with Yahoo as C, absolute runtime guardrail, public `/demo`.
- Deleted `AI-Assistant/` (PDF, preview, brief) on request; kept README (deliverable).
- Scaffolded Next 16 + Drizzle + vitest; wrote schema, generated migration, wrote the pure money core, 25 tests green.
- Found and fixed: seed 50 g → 20 g (cap made liquidation impossible), TS7 `baseUrl`, drizzle BigInt default.
- **Blocked:** `.env` is gone; no database access.

### 2026-10-26 ~03:30 PKT — server layer built (part 2)
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
- Not built yet: UI (trade flow `app/page.tsx`, receipt page, `/demo` panel), integration tests, README reviewer script, `WhatIDid.md` rewrite.
- Local machine DNS: router resolver (192.168.0.1) fails only `api.gold-api.com` (EAI_AGAIN; 1.1.1.1 resolves it) — source A will fail from local Node until host DNS is fixed or router recovers; Vercel unaffected. Probe methods: `dns.google/resolve`, `curl --resolve`, `nslookup … 1.1.1.1`.
- Still blocked: `.env` absent → `db:migrate`, `db:seed`, and every route run are unexercised against live Postgres.

### 2026-10-26 — progress.md reconciled; now the live project history
- **progress.md was stale research** (checkpoint with a dead brief/PDF/Requirement.md/preview.png lineage). It has been rewritten as the live project history: what exists, the design decisions actually wired into the code, the complete source/pricing/route layout, and the current blocking state.
- **What's wired, verified, and green locally:** typecheck exit 0; vitest **40/40** — 15 new in `tests/unit/quorum.test.ts` beyond the earlier 25; local A and B probes passed; all 7 routes + their typed error codes exist.
- **Two migrations must be applied before any route runs:** `drizzle/0000_gifted_mysterio.sql` (the original `0000` generated for the built `schema.ts`) and `drizzle/0001_slim_firedrake.sql` (the spec-mandated additions). They are plain SQL you can apply with the project's `db:migrate` script or by hand.
- **Current blocker:** `.env` still absent — `db:migrate`, `db:seed`, and every route remain unexercised against a live Postgres.
- **Local DNS caveat still applies:** the host's router resolver can't resolve `api.gold-api.com` (EAI_AGAIN); 1.1.1.1 resolves it fine. Until fixed, local Node tries of source A fail; Vercel is unaffected.
- Remaining work after `.env` is in place: `db:migrate && db:seed && dev`, then exercise a full quote → confirm → receipt flow against a real DB and re-verify with the demo controls.
