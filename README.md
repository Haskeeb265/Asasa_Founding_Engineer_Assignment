What I understood from this assignment is that I we need to create an trading/exchange app for gold and user balance where user can either buy or sell gold based on the prices that are being fetched from actual sources on runtime. We have 2 sources according the document where one is the primary source and the other is the fallback source. 

In total we have 3 balances that we need to maintain across this demo app. User balance, Gold balance, and inventory balance. “Maintaining” the balance means that pre and post trades the total balance stays consistent such that it adds up to the initial state. Consistency of balances is a must.
1. User balance is what the user owns in PKR
2. Gold balance is what the user owns in gold
3. Inventory balance is basically how much gold does the platform (asasa in our case) owns that it can trade with its users

The flow is basically like this:

1. User chooses to buy or sell
2. User is prompted to a text field where he/she would type in the amount of pkr (in case of buying) or gold (incase they’re selling) 
3. The trade would be locked on the live price that is fetched from the source within an interval of 5 minutes. A check would run which would ensure that the user is not buying more than the platform’s inventory has.
4. The user would then be presented with a quote of the locked trade. Here the user can review the trade. The quote will stay locked for 75 seconds. The user can cancel the trade during this time period.
5. Once the quote goes through, all the balances would update and the user will be presented with a receipt of his latest trade

### Assumptions:

1. Gold unit is grams
2. Quote card shows projected post-trade balances labelled
3. Limits: min Rs 1,000 or 0.1 g, max Rs 500,000 per trade
4. Rounding favours the platform by ≤1 paisa. sub-microgram dust stays in the wallet.
5. Published price is always one named source’s number, never an average.
6. One quote produces one all-or-nothing trade; no partial fills, order book, queuing, or price improvement.
7. Market may be closed/frozen; a fresh fetch with a frozen provider print is shown, flagged, and tradeable if two sources validate it.
8. Deployment target is Vercel Hobby, so no reliable 5-minute cron; uses lazy fetch plus best-effort in-process scheduler.
9. Neon pooled Postgres is the database; Upstash Redis is optional with process-local fallback.
10. App runs on Node runtime, not edge, because `pg`, `child_process`, and the Python bridge need Node.

### Key decisions:

1. Using 3 sources to validate prices
2. Source hierarchy to prioritize price correctness (PakGold being the primary source, Goldprice being secondary and Yahoo only for the sake of validation)
3. Validating prices on the basis of source divergence with a threshold of 0.5 difference in source prices

### Gaps:

1. Guardrail not defined nor any method to find out guardrail is defined. Instead letting the evaluator enter it on runtime instead of predefining.
2. Price validation criteria not defined. Using 3 price sources and validating prices on the basis of source hierarchy + source divergence.