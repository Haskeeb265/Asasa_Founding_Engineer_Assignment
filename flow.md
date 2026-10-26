Gold Trading Demo – Agent Build Spec
A single-user gold trading demo that mimics a trading app. This document is written for an AI coding agent: it defines the domain, rules, flows, invariants and acceptance criteria. Decisions already made are logged in section 11. Anything still marked [OPEN] must be confirmed before building.
1. Overview
The app lets one user buy and sell gold using a PKR wallet at a live-derived price. The platform itself holds a gold inventory that it sells from and buys back into.
Three balances (the entire ledger state):
Balance
Owner
Unit
Meaning
user_pkr
User
PKR
Cash wallet
user_gold
User
grams (24K)
Gold holdings
platform_gold
Platform
grams (24K)
Inventory the platform can sell to users
Global invariant: total gold (user_gold + platform_gold) is conserved by every trade. No balance may ever go negative.
2. Glossary
• Source: an external provider of gold prices (PakGold.pk, Goldprice.org, Yahoo).
• Divergence: the difference between two sources' normalized prices.
• Normalized price: price in PKR per gram of 24-karat gold, rounded to a fixed number of decimals.
• Quote: a short-lived, locked offer for a specific trade at a specific price.
• Receipt: immutable record of an executed trade; the audit trail.
• Idempotency: repeating the same confirm request has the same effect as sending it once.
3. Price Pipeline
3.1 Sources
Role
Source
Purpose
A – Primary
PakGold.pk
Default price used by the platform
B – Secondary
Goldprice.org
Fallback if A is unavailable or unreliable
C – Validator
Yahoo (gold rates)
Cross-checks A and B; not normally used as the displayed price
3.2 Refresh cadence
• Fetch all three sources every 5 minutes (scheduled job).
• Fetch them in parallel, with per-source timeouts and error handling. One failing source must not block the others.
• Persist the latest result of each fetch (value, timestamp, status) so staleness can be determined.
3.3 Normalization (applies before any comparison or display)
1. Convert each source's raw unit to grams (not troy ounce, not tola).
2. Convert to 24-karat equivalent where the source quotes another purity.
3. Convert to PKR where the source quotes another currency.
4. Do not round. Keep full precision (see the precision policy below).
Across the whole platform, every displayed or stored gold price is PKR per gram, 24K.
Precision and rounding (one policy, used everywhere):
• Inside the system: full precision. Keep fetched prices exactly as received and derived values exactly as computed (decimal type, never binary float). No rounding in normalization, divergence checks, the 1.10 and 0.90 formulas, or the guardrail comparison.
• On screen: 1 PKR per gram. Displayed prices (market, buy, sell) are rounded to whole PKR.
• In money records: 1 PKR. Every PKR amount that moves a balance, or is saved on a quote or receipt, is rounded to whole PKR.
• Gold quantities are never rounded by the platform.
• Use a single rounding function (round half up) for every rounding step.
3.4 Divergence validation
Purpose: detect whether any one source returned unreliable data. Sources use different methods and update cadences, so small differences are expected and are not errors.
After each fetch cycle, compute all pairwise divergences on the normalized prices:
• A–B
• B–C
• A–C
Threshold: a pair is considered consistent when its divergence is below 0.5%.
Divergence is measured as a percentage on the full-precision normalized prices: abs(x - y) / ((x + y) / 2) * 100.
Interpreting results (identify the outlier):
A–B
B–C
A–C
Conclusion
ok
ok
ok
All reliable
bad
ok
bad
A is the outlier
bad
bad
ok
B is the outlier
ok
bad
bad
C is the outlier
bad
bad
bad
No trustworthy source; treat as price unavailable
3.5 Price selection
Price selection is strict. A price is shown only when it has been validated against at least one other source, so at least two sources must be OK and agree. The platform never assumes, estimates or reuses an unvalidated price.
1. Use A (PakGold.pk) if it is OK and consistent with at least one other OK source.
2. Otherwise use B (Goldprice.org) if it is OK and consistent with at least one other OK source.
3. Otherwise there is no price: apply the no-price rule in section 3.7.
Yahoo (C) validates only. It is never the displayed source and never an emergency price.
The selected price is stored as the current platform price at full precision, with its fetch time, chosen source and the divergence values (for debugging and audit).
3.6 Which price and source the user sees
PakGold.pk is always the primary source and the one shown. Goldprice.org is shown only when PakGold.pk is unavailable or unreliable (high divergence from the other sources). Yahoo is never shown. When neither PakGold.pk nor Goldprice.org can be validated, no price is shown.
The UI must always show next to the price:
• When the rates were last updated (time of the fetch that produced the displayed price, with timezone).
• Which source produced them (PakGold.pk or Goldprice.org).
• A visible notice when the source is not PakGold.pk (for example "Fallback source: Goldprice.org, PakGold.pk unavailable").
• When no price can be validated: no price, Buy and Sell disabled, and the message "Prices cannot be validated right now. Please try again in 5 minutes."
Store price_source and price_fetched_at on the current price, the quote and the receipt.
3.7 Failed sources (explicit handling)
A source is never silently ignored. Every fetch cycle records one explicit status per source:
Status
Meaning
OK
Fetched, parsed, and passed sanity checks
FAILED
Timeout, network or HTTP error, blocked or changed page, unparseable response (store the error reason)
INVALID
Parsed, but the value is missing, zero, negative or implausible
STALE
Data older than the maximum price age (6 minutes), for example because the fetch job did not run
UNRELIABLE
Fetched fine, but flagged as the outlier by divergence validation
Rules:
• A source that is not OK is excluded and counts as unavailable.
• Any divergence pair involving an excluded source is recorded as NOT_COMPUTED, never as pass or fail.
• Store status, error reason and timestamp per source per cycle, log it, and expose it in a status view. If it changes the displayed source, show it in the UI notice too.
• One failing source never aborts the cycle. An immediate single retry of a failed source is allowed, but its result must be final before the cycle ends.
• At least two OK sources that agree are required for any price to be shown.
Behavior by scenario:
Case
Price used and shown
A, B, C all OK; all pairs consistent
A, PakGold.pk
A, B, C all OK; A diverges from both B and C, B–C consistent
B, Goldprice.org, with fallback notice
A, B, C all OK; B or C is the outlier
A, PakGold.pk
A, B, C all OK; every pair diverges
No price
A FAILED; B, C OK and consistent
B, Goldprice.org, with fallback notice
A FAILED; B, C OK but diverging
No price
B FAILED; A, C OK and consistent
A, PakGold.pk
B FAILED; A, C OK but diverging
No price
C FAILED; A, B OK and consistent
A, PakGold.pk
C FAILED; A, B OK but diverging
No price
Only one source OK, or none
No price
No-price rule. Show no price, disable Buy and Sell, and display "Prices cannot be validated right now. Please try again in 5 minutes." This applies whenever step 3 of section 3.5 is reached. Never fall back to a last-known price, a single unvalidated source or Yahoo.
Staleness (maximum price age). A displayed price comes only from a completed fetch cycle that passed validation, so it is at most one cycle old. The remaining risk is the cycle itself not running (crashed scheduler, stuck job, server restart), which would leave an old price on screen. So a validated price may be used for at most 6 minutes (5-minute cycle plus 1 minute grace); after that, apply the no-price rule. A cycle that completes but fails validation invalidates the previous price immediately, with no grace period.
Quotes already issued keep their locked price until they confirm, cancel or expire (75 seconds). The no-price state does not cancel them, because their price was validated when it was locked.
4. Trading Rules
The user can place two kinds of trades. Both execute atomically (all balance changes succeed together or none do).
4.1 Pricing formulas
The platform never trades at the raw market price; it applies a spread. market is the current platform price from section 3.5 (PKR per gram, 24K).
Side
Formula
Notes
Buy (user buys from platform)
buy_price = max(market × 1.10, guardrail)
10% above market, never below the guardrail
Sell (user sells to platform)
sell_price = market × 0.90
10% below market; the guardrail does not apply
• guardrail is a price floor (PKR per gram, 24K) that the operator can change at runtime, with no redeploy. It stops the platform from selling below a chosen minimum when the market drops. It must be a positive number; if unset, the buy price is simply market × 1.10.
• Read the market price and guardrail once, when the quote is created. Store the market price and the resulting execution price on the quote.
• Store the guardrail value on the quote and receipt only when it was accepted by the max function, meaning guardrail > market × 1.10 so the guardrail set the buy price. Otherwise leave the guardrail field empty. The guardrail never applies to sells.
• Every balance change in sections 4.2 and 4.3, the quote card and the receipt uses this locked execution price, never a later market price.
• Compute at full precision; round only as set in section 3.3.
• Illustration only, not real data: market = 30,000 and guardrail = 34,000 gives buy_price = max(33,000, 34,000) = 34,000 (guardrail stored) and sell_price = 27,000. With guardrail = 31,000 the buy price is 33,000 and no guardrail is stored.
4.2 Buy gold (spend PKR)
Balance
Effect
user_pkr
decreases by the PKR amount entered (whole PKR)
platform_gold
decreases by grams bought
user_gold
increases by grams bought
Preconditions: user_pkr >= cost and platform_gold >= grams.
Hard limit: the user cannot buy for more PKR than they own. Check user_pkr >= pkr_amount when the quote is created and check it again inside the confirm transaction, because balances may have changed. On failure reject with INSUFFICIENT_PKR (or INSUFFICIENT_PLATFORM_GOLD for inventory). No partial fills, no overdraft, no negative balance.
4.3 Sell gold (receive PKR)
Balance
Effect
user_gold
decreases by grams sold
user_pkr
increases by grams × sell price, rounded to whole PKR
platform_gold
increases by grams sold
Preconditions: user_gold >= grams.
Hard limit: the user cannot sell more gold than they own. Check user_gold >= grams when the quote is created and again inside the confirm transaction. On failure reject with INSUFFICIENT_GOLD. No short selling, no partial fills, no negative balance.
4.4 Amounts
PKR amounts are always whole PKR and gold quantities keep full precision (section 3.3). The input depends on the side:
• Buy: the user enters a PKR amount. grams_bought = pkr_amount / buy_price, using the full-precision buy price.
• Sell: the user enters a gram amount. pkr_proceeds = round(grams_sold × sell_price), rounded to whole PKR.
Use decimal arithmetic (never binary floats). The quote shows the derived value (grams for a buy, PKR for a sell) before the user confirms.
5. Quote Flow (75-Second Lock)
A trade is never executed the moment the user submits it. It first becomes a quote that the user must confirm.
5.1 Quote creation
When the user selects and finalizes a trade (buy or sell), the system:
1. Reads the current market price, computes the buy or sell price (section 4.1) and locks it into the quote.
2. Validates the preconditions in section 4 (rejects early with a clear error if they fail).
3. Creates a quote record with a unique quote_id, expires_at = created_at + 75s, and status PENDING.
5.2 Quote card (UI contents)
• Side: Buy or Sell
• Amount being bought or sold (grams and PKR value)
• Locked execution price (PKR/gram, 24K): the buy or sell price, not the market price
• Predicted balances after the trade (user_pkr, user_gold), clearly marked as not yet executed
• Countdown timer starting at 75 seconds
• Two buttons: Cancel and Confirm
The client timer is cosmetic. The server's expires_at is the source of truth.
5.3 Outcomes
Trigger
Result
User clicks Confirm before expiry
Trade executes, balances update, receipt is created and shown
User clicks Cancel
No trade; quote marked CANCELLED; user is notified and returned to the previous screen
Timer reaches 0
No trade; quote marked EXPIRED; user is notified and returned to the previous screen
Confirm arrives after expires_at
Rejected server-side; treated as expired
After cancel or expiry, the user can immediately start a new trade.
5.4 Quote state machine
PENDING → CONFIRMED (terminal) | CANCELLED (terminal) | EXPIRED (terminal)
Transitions out of terminal states are forbidden. Only PENDING → CONFIRMED may create a receipt and move balances.
6. Idempotency (Critical)
Requirement: if the user clicks Confirm more than once (double click, retry, network replay, two tabs), the trade executes exactly once.
Implementation guidance:
• Confirm is keyed by quote_id (and/or an idempotency key sent by the client).
• In a single database transaction: lock the quote row (SELECT ... FOR UPDATE) or use a conditional update (UPDATE quotes SET status='CONFIRMED' WHERE id=? AND status='PENDING' AND expires_at > now()), check the affected-row count, then apply balance changes and insert the receipt.
• Enforce uniqueness at the DB level: one receipt per quote_id (unique constraint).
• A repeated confirm for an already-confirmed quote returns the original receipt with a success response (not an error, not a second trade).
• Disable the Confirm button after the first click on the client as a UX nicety only; it is not the safeguard.
• Balance updates must be inside the same transaction as the status change; never read-then-write outside a transaction.
The same guarantee applies to the other transitions:
• Cancel: repeating Cancel on a cancelled quote returns CANCELLED with no further effect; Cancel on a confirmed quote is rejected.
• Expiry: the expiry check (on access or in a job) can run any number of times; it only moves PENDING quotes past expires_at to EXPIRED.
• Race between confirm and cancel or expiry: whichever conditional update wins decides the outcome; the loser gets an error naming the final state.
• Quote creation: every submission of the trade form carries a client-generated idempotency key; submitting the same key again returns the existing quote instead of creating a new one.
• Balance checks: re-run the insufficient-balance checks from section 4 inside the confirm transaction.
7. Receipts and Trade History
Receipt (immutable, created only on confirmed trades) contains:
• receipt_id, quote_id, timestamp
• Side (buy/sell), grams, market price, execution price per gram, PKR total (whole PKR)
• Guardrail value, only for a buy where the guardrail set the price (otherwise omitted)
• Balances before and after (user_pkr, user_gold)
• Price source and the time those rates were fetched; quote creation time
Receipts act as the audit trail. They are never edited or deleted.
Trade History lists confirmed trades only (one entry per receipt, newest first); any entry opens its full receipt.
Quote History lists every quote: confirmed, cancelled and expired (and a pending one, marked PENDING), newest first, each with side, amount, locked price, created time and final status. Confirmed quotes link to their receipt; cancelled and expired quotes have no receipt and changed no balance.
8. Screens
1. Dashboard: three balances; market, buy and sell price (PKR/gram, 24K, shown to 1 PKR); time the rates were last updated and their source (section 3.6); fallback notice, or the no-price message with trading disabled.
2. Trade form: Buy takes a PKR amount, Sell takes a gram amount.
3. Quote card: details, predicted balances, 75s countdown, Cancel and Confirm.
4. Receipt screen: shown after confirmation.
5. Trade History: confirmed trades with their receipts.
6. Quote History: all quotes, confirmed, cancelled and expired, with final status.
7. Notifications/toasts: trade cancelled, quote expired, insufficient PKR, insufficient gold, prices unavailable, errors.
8. Runtime settings: a way for the operator to set the guardrail value without redeploying (setting, admin page or endpoint; implementer's choice).
9. Suggested Data Model
• price_snapshots: id, source, status (OK, FAILED, INVALID, STALE, UNRELIABLE), error_reason, raw_value and normalized_price (full precision), fetched_at
• current_price: state (VALID or NO_PRICE), market_price (full precision), selected_source, price_fetched_at, valid_until (fetched_at + 6 minutes), a_b_div, b_c_div, a_c_div (null when NOT_COMPUTED), updated_at
• settings: guardrail (PKR/gram, 24K), updated_at
• accounts: user_pkr, user_gold, platform_gold (or a ledger of entries)
• quotes: id, idempotency_key (unique), side, input_amount, grams, market_price, execution_price, guardrail_applied (null unless the guardrail set the buy price), pkr_total (whole PKR), predicted balances, price_source, price_fetched_at, created_at, expires_at, status
• receipts: id, quote_id (UNIQUE), side, grams, market_price, execution_price, guardrail_applied (nullable), pkr_total, balances before and after, price_source, price_fetched_at, created_at
10. Acceptance Criteria
1. Prices refresh every 5 minutes from all three sources; a failing source does not break the cycle, and every source has an explicit status each cycle.
2. Divergence is calculated in percent for all pairs (consistent below 0.5%) or marked NOT_COMPUTED, and the outlier is identified.
3. Prices are kept at full precision internally, shown to 1 PKR per gram on screen, and every money record is whole PKR using one rounding function.
4. The displayed price is PakGold.pk when it is OK and consistent with at least one other source; otherwise Goldprice.org under the same rule; otherwise no price (message shown, Buy and Sell disabled). Yahoo is never shown.
5. No price is ever assumed: no unvalidated, single-source or last-known price, and a price older than 6 minutes is not used.
6. The UI shows when the rates were last updated and which source produced them, with a notice when the source is not PakGold.pk.
7. buy_price = max(market × 1.10, guardrail) and sell_price = market × 0.90; a guardrail change applies to the next quote without a redeploy, and the guardrail is stored on a quote and receipt only when it set the buy price.
8. Buy takes a PKR amount and Sell takes a gram amount, and the quote shows the derived value.
9. Buy and sell change exactly the balances listed in section 4, using the locked execution price, and total gold is conserved.
10. Buying for more PKR than owned, selling more gold than owned, and buying more than platform inventory are rejected at quote creation and again at confirm; no balance goes negative.
11. Quote card shows amount, predicted balances, a 75s timer, Cancel and Confirm.
12. Cancel and expiry produce no balance change, notify the user, and return to the previous screen; confirm after server-side expiry is rejected.
13. Confirming the same quote N times (including concurrently) produces exactly one receipt and one set of balance changes; repeated Cancel, repeated expiry checks and repeated submission of the same idempotency key are also harmless.
14. Trade History shows confirmed trades with full receipts; Quote History shows every quote with its final status.
11. Decisions Log
• Precision: full precision internally; 1 PKR per gram on screen; whole PKR in money records; one rounding function (round half up) everywhere.
• Guardrail: stored on the quote and receipt only when the max function chose it.
• Staleness: a validated price may be used for at most 6 minutes (5-minute cycle plus 1 minute grace); a cycle that fails validation invalidates the price immediately. The 6-minute value is a proposal, adjustable if the cycle length changes.
• Source order: PakGold.pk, then Goldprice.org, then no price. At least two agreeing sources are required.
• Unvalidated prices: never shown or assumed; Yahoo is never an emergency price.
• Input mode: Buy takes PKR, Sell takes grams.
• Seeded balances: already decided and seeded; use the existing seed.
• Histories: Trade History shows confirmed trades; Quote History shows all quotes.
• Duplicate quotes: prevented with a client-generated idempotency key per form submission.