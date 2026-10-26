# progress.md

Research + understanding checkpoint. **Date: Oct 25, 2026 (a Sunday — see the "weekend caveat" below).**
Scope of this document: (1) my own understanding of the project, (2) answers to the two questions posed by the candidate.
The open questions in `Requirement.md` Section 11 are deliberately **not** answered here per instruction.

---

## 1. My understanding of the project

**What it is.** A deployable, single-user demo for **buying and selling gold at live market prices**, for the Asasa Founding Engineer assessment. A reviewer must be able to: see starting balances → understand the live 24K price → enter an amount (in PKR or grams) → review a **75-second locked quote** → confirm once → see updated balances and a receipt — with no extra guidance, no credentials, and no code changes to test the edge cases.

**The three balances (the heart of correctness).** Seeded dummy data: PKR wallet, user gold holdings (grams), platform gold inventory (grams). These are **separate balances joined only by the quoted price** — PKR is never a substitute for gold. Every trade must keep them internally consistent:
- Buy → PKR ↓, user gold ↑, platform inventory ↓
- Sell → PKR ↑, user gold ↓, platform inventory ↑
- Invariant to test: total gold (user + inventory) is conserved; PKR changes by exactly the quoted amount.
- Validation blocks, all with clear messages (not dead ends): insufficient PKR (buy), insufficient inventory (buy), insufficient user gold (sell).

**Trade journey (per the PDF and the flow sketch in `preview.png`).**
1. **See price** — live 24K rate in PKR/gram, with **source + freshness** visible.
2. **Enter amount** — in PKR *or* grams, with a **buy/sell selector** (the sketch says "enter price"; it really means amount).
3. **Review** — server issues a **75-second locked quote**. Server owns the lock; the client countdown is display only. Cancel = no trade.
4. **Confirm** — settle **exactly once** (idempotency: quote ID consumed once; double-click/replay returns the original result, never a second trade). Expired quotes can never be confirmed, even by replay; the user gets a one-tap fresh quote with the price change disclosed — **never trade at a different price silently**.
5. **Complete** — updated balances + receipt/transaction record.

**Pricing rules.** Server-side fetch only, **no more than once per 5 minutes (ceiling, not schedule** — i.e., a TTL cache, not a timer). Show selected source + last-refreshed time. Sources: **PakGold (primary)** and **GoldPrice.org (fallback)**, normalized to a **24K market reference in PKR/gram**. Customer buys at `max(market × 1.10, guardrail)`; sells at `market × 0.90`. **Pause trading** if neither source is trustworthy. The guardrail is undefined by the brief and must be triggerable by a reviewer **without touching deployed code**.

**Stress cases the reviewer must be able to poke at.** Source stops answering / quote expires / balance runs short / confirm pressed twice — among others (stale cache, both sources down, absurd inputs, rounding, concurrent confirms). This implies a small, non-admin "demo controls" panel.

**Deliverables (easy to forget).** Public GitHub repo with setup instructions + `WhatIDid.md` (understanding, assumptions, decisions, gaps); a publicly deployed app with no reviewer credentials; and a build record (coding-agent transcript or continuous screen recording, secrets redacted, **useful dead ends left in**).

**Judgment calls already flagged in `Requirement.md` that I agree with.**
- Karat rows in PakGold's payload are **five different purities (24K first)**, not repeated readings — never average them; pick 24K per gram by label and fail loudly on structure change.
- The observed reality is that PakGold's displayed numbers **equal USD XAU spot × USD/PKR** (verified with gold-api.com × open.er-api.com, matching to the rupee). So a spot×FX implementation is a *deviation* from "scrape pakgold.pk" that must be documented honestly in `WhatIDid.md` while still honoring PakGold-primary/GoldPrice.org-fallback in the UI.
- **Out of scope:** auth, real money, admin panel. Everything else may be mocked/seeded.

---

## 2. Question 1 — Getting free *live* gold rates (the delay problem)

### First, a reality check on "live"

No freely available feed of legal **real-time** spot gold exists — sub-second/second-level spot and LBMA data are licensed products. Every free source is a composite quote with some cadence. That's fine **for this assignment**: with a 5-minute server fetch ceiling and ±10% customer spreads, a spot quote that is **~1 minute fresh is functionally "live"**. The goal is not zero delay; it is knowing honestly what the delay is and not shipping something stale.

### Why you're seeing delays right now (verified)

- **It's the weekend.** Spot markets closed Friday NY time (Oct 23). Today (Sunday Oct 25) *every* free feed serves Friday's close:
  - `api.gold-api.com/price/XAU` returns `price: 3996.899902` — byte-identical to your Oct 24 snapshot — while `updatedAt` keeps ticking ("a few seconds ago", timestamp advancing). So **its `updatedAt` is a response time, not a price time.** Do not present it as price freshness.
  - `goldprice.org` PKR feed: `xauPrice: 1,105,847.50` — exactly your Oct 24 snapshot, with `xauClose` (previous close) 1,119,376.66 alongside. Frozen close, correctly labeled.
- **Your FX leg is a daily feed.** `open.er-api.com` PKR updates roughly once per day, so a spot×FX composite inherits that cadence for its currency side. That's acceptable for a 5-min-cached quote, just don't call it "live FX".
- **Free tiers of paid APIs throttle/delay on purpose** (MetalpriceAPI cache is 30–60 min on free plans; GoldAPI.io free tier is 100 req/month). They're verifiers, not the live leg.

**Takeaway:** your current stack is not actually "delayed" — it's *weekend-frozen* (and FX-daily). Real cadence is only measurable on a weekday. Before Monday, I'd sanity-check `gold-api.com` by polling twice a minute mid-session and diffing `price` (while ignoring `updatedAt` and `updatedAtReadable`; the docs describe it as free, keyless, in-memory, "real time").

### Free options for the live leg (ranked, with what I verified today)

| Option | Cost/key | What I verified | Verdict |
|---|---|---|---|
| **`api.gold-api.com/price/XAU`** (gold-api.com) | Free, no key | Responds with clean USD/oz JSON; price frozen across the weekend with a misleadingly ticking `updatedAt` | **Keep as the USD spot source.** Poll 1–2/min with a 5-min TTL cache, and derive freshness from *price change*, not `updatedAt` |
| **`open.er-api.com/v6/latest/USD`** | Free, no key | Known good; daily PKR | Keep as the FX leg (hourly fetch is plenty) |
| **Yahoo Finance chart API (unofficial)** `query1.finance.yahoo.com/v8/finance/chart/GC=F` | Free, no key | **HTTP 200** with full COMEX futures series during RTH (`XAUUSD=X` spot symbol returns 404) | Good independent weekday cross-check for the trust criteria (Section 11.2) |
| **MetalpriceAPI** | Needs own key | Untested (no key); your doc snapshot shows PKRXAU = 1,105,492.74 vs 1,106,047 for gold-api×er-api — **0.05% agreement** | Keep as the independent verifier you already have |
| **goldprice.org `dbXRates/PKR`** | Free, no key | **Works — see Question 2** | Single-shot PKR/oz; fallback **and** cross-check |
| Swissquote public FX feed (`forex-data-feed.swissquote.com/...`) | Free | **Dead** — host doesn't resolve (referenced only by a 7-year-old reddit post) | Drop it |
| TradingView / hosted 3rd-party widgets | Free | Display-only, not fetchable server data | Out |
| CME-futures wrappers (e.g. `omkarcloud/gold-price-api`, ~5,000 req/mo free) | Free tier | Untested | Backup if gold-api cadence disappoints on Monday |

**Recommendation:** stay with **gold-api (spot) + er-api (FX)** as the primary derivation, add **Yahoo `GC=F`** as a cheap second signal, and rely on the trust criteria (parse success, positive price, % drift vs last good price, source agreement) to decide "trusted vs paused". Cross-check with MetalpriceAPI on a low-rate schedule. **Important caveat:** verify the actual weekday update cadence of gold-api before betting the demo on it — that can only be tested once the market reopens.

---

## 3. Question 2 — Fetching the fallback (goldprice.org)

### The endpoint (verified working end-to-end today)

```
GET https://data-asg.goldprice.org/dbXRates/PKR
```
Returns native PKR — no FX leg needed, which is ideal for a fallback:
```json
{"ts":1792951866200,"tsj":1792951865518,"date":"Oct 25th 2026, 02:11:05 pm NY",
 "items":[{"curr":"PKR",
           "xauPrice":1105847.5015,   // ← PKR per troy ounce
           "xagPrice":14922.3512,
           "chgXau":-13529.163,"pcXau":-1.2086,
           "xauClose":1119376.66447}]}
```
→ `market PKR/gram (24K) = items[0].xauPrice / 31.1034768`.
Parse defensively: require `curr === "PKR"`, numeric `xauPrice > 0`, and take **explicitly** `items[0]` with a hard failure if the shape changes. `tsj`/`date` are the provider-side moments — good candidates for "freshness" display. There's also `/dbXRates/USD` if you ever want to unify to a USD pipeline.

### The hard part: their WAF (verified empirically)

`Requirement.md` guessed it needs "browser-like headers". **Today's evidence shows it's stricter than that:**

| Attempt | Result |
|---|---|
| Plain GET (`requests`-style) | **403 Forbidden** |
| `curl` with full browser header set (Chrome UA, Accept, Accept-Language, Referer, Origin) | **403 Forbidden** |
| Getting site cookies from `goldprice.org/gold-price-pakistan.html` first, then retrying | **403 Forbidden — the HTML page itself also 403s** |
| `curl_cffi` with `impersonate="chrome"` (browser-equivalent TLS/JA3 fingerprint) on `/dbXRates/PKR` | **200 + valid JSON** ✅ |

So the gate is **TLS/HTTP2-fingerprint-based**, not header-based: they reject non-browser TLS handshakes. This also matches `Requirement.md`'s warning that it will likely block Vercel/datacenter IPs — from such hosts you'd expect 403/Cloudflare challenges even with a perfect fingerprint, and you must handle that at runtime.

### Practical recipe for the fallback fetcher

1. **Use a TLS-impersonating client** — Python `curl_cffi` (`pip install curl_cffi`; sends in ~10 lines):
   ```python
   from curl_cffi import requests as fl
   r = fl.get(url, impersonate="chrome",
              headers={"Accept": "application/json, text/javascript, */*; q=0.01",
                       "Referer": "https://goldprice.org/"}, timeout=15)
   ```
   Check `r.status_code == 200` and the JSON contract; anything else → fail through to "untrusted/paused". Keep the **last good price + timestamp** so the UI stays honest during outages.
2. **Rate discipline:** fallback attempts belong in the **same** 5-min fetch cycle as the primary (one cycle = primary attempt **then** fallback attempt), never retries in a tight loop; short exponential backoff after a 403/429 (they *will* happen from datacenter IPs).
3. **Cross-check mode:** since the PKR feed is absolute, it can serve triple duty: fallback price, cross-check of the spot×FX primary (their Sunday numbers already match your Oct 24 snapshot exactly), and a sanity check against pakgold.pk's displayed values.
4. **Deploy early from the real host.** Whether `curl_cffi`-Chrome passes from your target platform is *the* second-highest risk after cadence verification — test it the moment you deploy, not the night before.
5. Don't use the goldprice.org *website widget* or scrape rendered HTML — the JSON endpoint is stable and one call gets everything.
6. Respect robots.txt/ToS posture: server-side only, low frequency (the 5-min ceiling guarantees this), clear UA, and treat this whole path as best-effort per the brief.

---

## 4. Status / next steps (not started — per instruction, stopping here)

- ✅ Requirements read and understood (PDF → Requirement.md → preview.png).
- ✅ Q1 researched and answered (with the professional caveat that true cadence can only be measured once markets reopen on Monday).
- ✅ Q2 researched and answered — including a **working fetch of goldprice.org's PKR endpoint via TLS impersonation** (verified end-to-end today).
- ⛔ No coding started, per instruction. `Requirement.md` Section 11 open questions remain open by design.

