# Gold buy/sell demo — Asasa founding-engineer assessment

A deployable, single-user demo for buying and selling 24K gold at live market
prices. A reviewer needs no credentials and no code changes to see the balances,
trade, and try every edge case.

- `docs/Todo.md` — the behaviour contract (authoritative).
- `docs/gold_sources.md` — source research (endpoints, units, WAF behaviour).
- `docs/WhatIDid.md` — the narrative deliverable.

## Run it locally

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL (Neon POOLED string)
python -m pip install curl_cffi   # source B (GoldPrice.org) on this machine

npm run db:migrate            # applies drizzle/*.sql in order
npm run db:seed               # 500,000 PKR / 20 g user / 100 g platform

npm run dev                   # http://localhost:3000
```

`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are optional: without them
the price cache and fetch cooldown fall back to process-local memory, which is
fine for a single instance.

On Vercel set only `DATABASE_URL` and the two Upstash values. Source B is fetched
by `api/goldprice.py`, a Vercel Python function bundling `curl_cffi`
(`requirements.txt`, `vercel.json`); the Node cycle calls it automatically
because `GOLDPRICE_FETCH_MODE` defaults to `remote` wherever `VERCEL` is set.

Migrations are applied by `scripts/apply_migrations.ts` — `drizzle-kit migrate`
exits 1 silently against this project, so `npm run db:migrate` is the reviewer
path.

## The reviewer script (5 minutes)

Three balances, visible at the top of the User page: PKR wallet (Rs 500,000),
your gold (20 g), platform inventory (100 g). Total gold is 120 g, forever.

1. **See the price.** The market card shows the 24K rate in PKR per gram, which
   source produced it, whether it was validated, and how many seconds ago it was
   fetched. The buy rate is market × 1.10 (never below the guardrail); the sell
   rate is market × 0.90.
2. **Buy.** Buy tab, enter `10000` PKR, **Get buy quote**. The quote card shows
   the grams received, the PKR charged, the locked per-gram price and its
   source, the balances you would hold (marked "not yet executed"), and the
   countdown (75 s by default).
3. **Confirm.** **Confirm** stages the trade: the price is locked and the trade
   executes by itself the moment the timer runs out — **Cancel** voids it right
   up to zero. Pressing Confirm twice still confirms once.
4. **Receipt.** When the timer expires the receipt lands under the form and in
   Receipts: side, gold and PKR moved, locked price, market price, source,
   guardrail flag and balances before/after. Balances move by exactly the quoted
   numbers.
5. **Sell.** Sell tab, enter `0.5` grams, repeat. Proceeds are that weight at the
   sell rate.
6. **Expiry.** Let an unconfirmed quote sit until 0 → it folds away and nothing
   was traded; asking for another quote is one click.
7. **Guardrail.** In the sidebar Settings set **Guardrail price floor**, e.g.
   `50000` PKR/g. Buys now lock at the floor (flagged on the quote and receipt);
   sells are untouched. Clear it to switch the guardrail off.
8. **Sources.** The same panel toggles A (PakGold.pk), B (GoldPrice.org) and C
   (Yahoo GC=F, validation only). Trading rules: PakGold alone, or any two, or
   all three → trade. GoldPrice.org alone or Yahoo alone → refused as
   unvalidatable. Nothing reporting → no price, trading paused. Every refusal is
   shown with its reason; the price is withheld when it cannot be stood behind.
9. **Limits and safety.** Below Rs 1,000 or 0.1 g → `BELOW_MIN`; above
   Rs 1,000,000 → `ABOVE_MAX`; balances are re-checked under lock at settlement
   → `INSUFFICIENT_PKR` / `INSUFFICIENT_GOLD` / `INSUFFICIENT_INVENTORY` with
   nothing moved. **Reset demo** restores the seed and clears quotes, trades and
   prices.

The **Live database** tab in the sidebar mirrors every table (balances,
settings, quotes, trades, price rows per source per cycle), refreshed every 2 s.

## Architecture in one paragraph

Next.js App Router with two client pages and thin route handlers at the
boundary (zod in, typed error envelope out). All money maths lives in `domain/`
in integer minor units — PKR in paisa, gold in micrograms, price in
paisa/gram, `bigint` throughout — so `pkr = f(grams, price)` is exact and
rounding favours the platform by at most one paisa (`domain/units.ts`,
`domain/trade-math.ts`, `domain/quorum.ts`). The server owns the quote: Postgres
is the authority for settlement and exactly-once (conditional `UPDATE` on the
quote status, then a `FOR UPDATE` re-read of all three balances inside one
transaction), which is why Redis never touches money. The pricing cycle fetches
each enabled source once per cycle (A = gold-api × er-api, B = GoldPrice.org via
curl_cffi, C = Yahoo GC=F normalized by a configurable basis), runs the
divergence quorum, stores one `prices` row per source and publishes one source's
number — never an average. `server/pricing/price.ts` owns the lazy fetch (cache
TTL = the settings' fetch interval, default 300 s), the durable rebuild from the
`prices` table, and the trading gate; `instrumentation.ts` starts the scheduler
that sweeps quote expiry and refreshes the price every five minutes.

## Checks

```bash
npm run typecheck          # tsc --noEmit, exit 0
npx vitest run             # 40 unit tests (units, trade maths, quorum)
npx drizzle-kit generate   # must report no schema changes
```
