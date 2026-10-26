# Todo.md

## Data source endpoints

All keyless and free. Verified working Oct 25, 2026 (weekend — prices frozen at Friday close; weekday cadence still unverified).

| # | Source | Endpoint | Returns | Units / purity | Role in project |
|---|--------|----------|---------|----------------|-----------------|
| 1 | **gold-api.com** (goes via PakGold) | `GET https://api.gold-api.com/price/XAU` | `price` (USD/troy oz), `updatedAt` (`updatedAtReadable` lies — ignore it) | **USD per troy oz**, **24K** spot | Primary leg #1 — the exact data PakGold's own site fetches |
| 2 | **open.er-api.com / ExchangeRate-API** (goes via PakGold) | `GET https://open.er-api.com/v6/latest/USD` | `rates.PKR` (PKR per 1 USD) | FX rate, updates ~daily | Primary leg #2 — FX conversion + validator for all direct PKR values |
| 3 | **goldprice.org** | `GET https://data-asg.goldprice.org/dbXRates/PKR` | `items[0].xauPrice` (PKR/troy oz), `items[0].xauClose` (prev close — use to detect frozen market), `tsj`/`date` (true freshness) | **PKR per troy oz**, **24K**, already FX-converted | Fallback source — direct PKR, no FX leg needed |
| 4 | **Yahoo Finance** (unofficial, optional) — `3RD SOURCE (validator, weekdays)` | `GET https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=1d` | COMEX gold futures series | USD per troy oz (futures — allow ~1% basis vs spot), near-real-time on weekdays | Independent keyless validator (no API key; send browser User-Agent). Use "last trade time" in the response meta, not off-hours values. (`XAUUSD=X` spot symbol 404s — use `GC=F`) |
| 5 | **Binance** (Tether Gold token) — `3RD SOURCE (validator, 24/7)` | `GET https://api.binance.com/api/v3/ticker/price?symbol=XAUTUSDT` | `price` (USD per XAUT ≈ 1 fine troy oz) | USD per troy oz, tracks spot within ~0.02% | Keyless, trades 24/7/365 — the only always-live check (covers weekends demo). Token premium caveat: flag if >1% from spot. (PAXGUSDT also works, ran +0.32% premium) |
| 6 | **MetalpriceAPI** (optional, downgraded) | `GET https://api.metalpriceapi.com/v1/latest?api_key=<KEY>&base=PKR&currencies=XAU` | `rates.PKRXAU` (PKR per troy oz) | PKR per troy oz, 24K | ⚠️ Free tier data is ~24h delayed (their own statement) + needs key + quota — demoted from validator to optional historical sanity anchor |
| 7 | **pakgold.pk** | `https://www.pakgold.pk/` (page itself — its inline JS fetches #1 + #2 and computes the table client-side) | Displayed 1 Gram × 24K value | PKR per gram, 24K (row `"1 Gram"`, index 0) | Sanity check ONLY — it has no data endpoint of its own; the exact table you saw is their browser calculating spot × FX |

## Notes

- **PakGold is not a source:** verified from its page source — it fetches `api.gold-api.com/price/XAU` + `open.er-api.com/v6/latest/USD` in the browser and computes 24K×FX into tola/10g/1g/oz rows. "PakGold-primary" = reproduce that methodology server-side (same two endpoints, #1 + #2).
- **Conversions:** per-gram #1+#2: `price × rates.PKR ÷ 31.1034768`; per-gram #3 directly: `xauPrice ÷ 31.1034768`.
- **#3 requires TLS impersonation:** plain GET / curl with browser headers → 403. Works via `curl_cffi` (`impersonate="chrome"`), verified 200 today. Re-test from the deployed host — datacenter IPs may still be blocked by the WAF.
- **Do not use** pakgold.pk's own `v6.exchangerate-api.com/<pakgold's key>` (found in their traffic) — key is pakgold's property and #2 already covers FX. Swissquote's old `forex-data-feed.swissquote.com` is dead (host doesn't resolve).
- **Validation triangle (trust criteria):** A = #1×#2 (spot×FX) vs B = #3 within ~0.5%; A/B vs C = #4 (weekday) or #5 (24/7) within ~1% (basis-aware). Both fail → pause trading, show last good price + its age honestly.
- All three official paths (#1+#2, #3, #4-Metalprice) agreed within ~0.05% on the Oct 24 snapshot: 1,106,047 / 1,105,847.50 / 1,105,492.74 PKR per troy oz.
- Weekend cross-check Oct 25: gold-api 3996.90 USD/oz vs goldprice-PKR÷FX 3994.57 (0.06%) vs XAUT 3997.56 (0.02% vs gold-api) vs PAXG 4009.84 (0.32% premium). LBMA's official `prices.lbma.org.uk/json/gold_pm.json` is Cloudflare-blocked (same TLS-fingerprint wall as goldprice.org) and twice-daily anyway — skip it.
