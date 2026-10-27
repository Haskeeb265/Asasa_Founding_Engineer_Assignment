import json
from typing import Any, Dict

"""
GoldPrice.org leg — the brief's named fallback. Its WAF gates on the TLS/JA3
fingerprint: plain requests and curl-with-browser-headers both 403'd while
curl_cffi (impersonate="chrome") returned 200 with valid JSON — verified
Oct 25-27. One attempt per cycle; never a retry loop.

Used from two places:
  - scripts leg       : `python scripts/fetch_goldprice.py` (local Node spawn)
  - Vercel function   : api/goldprice.py imports fetch_goldprice()
Both work against the same dict shape:
    {"ok": True, "pkr_per_oz": float, "prev_close": ..., "ts": ..., "date": ...}
    {"ok": False, "error": "..."}
"""

URL = "https://data-asg.goldprice.org/dbXRates/PKR"


def _fail(error: str) -> Dict[str, Any]:
    return {"ok": False, "error": error}


def fetch_goldprice() -> Dict[str, Any]:
    try:
        from curl_cffi import requests as fl
    except ImportError:
        return _fail("curl_cffi is not installed")

    try:
        r = fl.get(
            URL,
            impersonate="chrome",
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://goldprice.org/",
            },
            timeout=15,
        )
    except Exception as exc:  # noqa: BLE001 - any transport failure is just "B failed"
        return _fail(str(exc))

    if r.status_code != 200:
        return _fail(f"HTTP {r.status_code}")

    try:
        data = r.json()
    except Exception as exc:  # noqa: BLE001
        return _fail(f"non-JSON body: {exc}")

    # Parse defensively: explicit items[0], curr must be PKR, xauPrice > 0.
    items = (data or {}).get("items")
    if not items:
        return _fail("response has no items")
    item = items[0]
    if item.get("curr") != "PKR":
        return _fail(f"unexpected currency {item.get('curr')}")
    pkr_per_oz = item.get("xauPrice")
    if not isinstance(pkr_per_oz, (int, float)) or pkr_per_oz <= 0 or pkr_per_oz != pkr_per_oz:
        return _fail(f"xauPrice unusable: {pkr_per_oz}")

    return {
        "ok": True,
        "pkr_per_oz": float(pkr_per_oz),
        "prev_close": item.get("xauClose"),
        "ts": item.get("tsj"),
        "date": item.get("date"),
    }


def main() -> None:
    print(json.dumps(fetch_goldprice()))


if __name__ == "__main__":
    main()
