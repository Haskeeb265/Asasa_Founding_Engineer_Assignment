# Gold buy/sell demo — Asasa founding-engineer assessment

A single-page demo for buying and selling 24K gold at live market prices. A
reviewer needs no credentials and no code changes to see every edge case.

The behaviour contract is `flow.md`. Field research on the price sources is in
`docs/gold_sources.md`; the live project history is in `AGENTS.md` (session log
at the bottom) and `progress.md`.

## Run it locally

```bash
npm install
cp .env.example .env    # fill in DATABASE_URL (Neon POOLED string)
python -m pip install curl_cffi   # local-only: the GoldPrice.org leg

npm run db:migrate      # apply the drizzle migration
npm run db:seed         # 500,000 PKR / 20 g user / 100 g platform, 120 g forever

npm run dev             # http://localhost:3000
```

On Vercel: set `DATABASE_URL` (pooled), `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN` and `GOLDPRICE_FETCH_MODE=remote`. Source B
(GoldPrice.org) is fetched by `api/goldprice.py`, a Vercel Python function
running curl_cffi (deps in `requirements.txt`); the Node cycle calls it at
`https://<your-app>/api/goldprice` — no extra env var needed (`VERCEL_URL` is
auto-injected; set `GOLDPRICE_REMOTE_URL` only if you host that function
elsewhere).

## The reviewer script (5 minutes)

Seen money: three balances — PKR wallet (Rs 500,000), your gold (20 g),
platform inventory (100 g). Total gold is 120 g, forever.

1. **Dashboard.** Market price per gram (24K) with buy and sell prices, the
   source it came from, and the "rates updated at" time with timezone.
   Divergences and per-source statuses (last cycle) are shown below.
2. **Buy PKR.** Side = Buy, enter e.g. `10,000`, press **Get quote**. A quote
   card appears: grams you receive at full precision, PKR that moves, locked
   execution price, predicted balances marked **not yet executed**, and a
   75-second countdown. **Confirm** → a receipt with balances before/after and
   an immutable receipt id. Balances move by exactly the values quoted.
3. **Sell grams.** Side = Sell, enter e.g. `0.5 g`, repeat. The sell price is
   market × 0.90; proceeds are whole PKR rounded half up.
4. **Quote is a locked offer.** Let a quote sit; after 75 s the server rejects
   a confirm with `QUOTE_EXPIRED` and nothing happened. **Cancel** while
   pending → `CANCELLED`, no effect.
5. **Exactly-once.** Confirm the same quote repeatedly — every repeat returns
   the same receipt, success not an error, one trade only.
6. **Idempotent submit.** Every form submission sends a client-generated
   idempotency key; submitting the same key returns the existing quote (HTTP
   200, not a second quote).
7. **Guardrail (runtime, no redeploy).** Settings panel → set the buy floor to
   `50,000`. Quotes now show the floor as the locked price with the guardrail
   value recorded; sells are untouched. Set it back to empty/0.
8. **Source failures.** Toggle source A off in settings → the next cycle
   falls back to B with a visible "fallback source" notice. Turn everything
   else off (or wait out market hours) → the no-price message appears and
   Buy/Sell are disabled: "Prices cannot be validated right now. Please try
   again in 5 minutes." The previous price is never served stale.
9. **Limits.** Below Rs 1,000 / 0.1 g → `BELOW_MIN`; above Rs 1,000,000 →
   `ABOVE_MAX`; balances re-checked inside the confirm transaction →
   `INSUFFICIENT_*` with nothing moved.

## Architecture in one paragraph

Next.js App Router page drives seven API routes; all money maths live in
`domain/` (big.js, full precision — never binary float; whole PKR on every
record that moves a balance) and rounding happens once, half up. `server/`
holds the pricing cycle (three sources fetched in parallel, one status row per
source per cycle, divergence validation < 0.5% pairwise, strict A > B
selection with C as validator-only), the Postgres repo (quotes as a state
machine PENDING → CONFIRMED/CANCELLED/EXPIRED, exactly-once settlement via a
conditional UPDATE inside a transaction with FOR UPDATE re-read), and the
wire boundary which computes every display string server-side. Current price
sleeps in Postgres with a 5-minute scheduled refresh (plus an on-read refresh
when the 6-minute validity lapses); Redis carries only the cross-instance
cycle claim and degrades to a no-op without credentials.

## Checks

```bash
npm run typecheck   # tsc --noEmit, exit 0
npx vitest run      # domain unit tests
npx drizzle-kit generate   # must report no schema changes
```
