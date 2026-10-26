import json
import sys

"""
Local-only B leg (docs/Todo.md §6.2). goldprice.org's WAF gates on TLS/JA3
fingerprint: plain requests and curl-with-browser-headers both 403'd while
curl_cffi (impersonate="chrome") returned 200 with valid JSON — verified
Oct 25-26. Runs one attempt per cycle; never a retry loop.
"""

URL = "https://data-asg.goldprice.org/dbXRates/PKR"

def main() -> None:
    try:
        from curl_cffi import requests as fl
    except ImportError:
        print(json.dumps({"ok": False, "error": "curl_cffi is not installed"}))
        return

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
        print(json.dumps({"ok": False, "error": str(exc)}))
        return

    if r.status_code != 200:
        print(json.dumps({"ok": False, "error": f"HTTP {r.status_code}"}))
        return

    try:
        data = r.json()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"non-JSON body: {exc}"}))
        return

    # Parse defensively: explicit items[0], curr must be PKR, xauPrice > 0.
    items = (data or {}).get("items")
    if not items:
        print(json.dumps({"ok": False, "error": "response has no items"}))
        return
    item = items[0]
    if item.get("curr") != "PKR":
        print(json.dumps({"ok": False, "error": f"unexpected currency {item.get('curr')}"}))
        return
    pkr_per_oz = item.get("xauPrice")
    if not isinstance(pkr_per_oz, (int, float)) or pkr_per_oz <= 0 or pkr_per_oz != pkr_per_oz:
        print(json.dumps({"ok": False, "error": f"xauPrice unusable: {pkr_per_oz}"}))
        return

    print(
        json.dumps(
            {
                "ok": True,
                "pkr_per_oz": float(pkr_per_oz),
                "prev_close": item.get("xauClose"),
                "ts": item.get("tsj"),
                "date": item.get("date"),
            }
        )
    )

if __name__ == "__main__":
    main()
