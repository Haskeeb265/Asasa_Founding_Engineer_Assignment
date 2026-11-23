#!/usr/bin/env python3
"""Fetch GoldPrice.org PKR/troy-oz gold.

The WAF gates on TLS/JA3 fingerprint and navigation headers: plain
requests/Node fetch gets 403. A Chrome impersonation profile plus a same-site
Referer is required.

Prints exactly one JSON line and always exits 0 so the Node caller can turn
every failure into a price sample with a reason.
"""

import json
import sys

URL = "https://data-asg.goldprice.org/dbXRates/PKR"

# The WAF also checks browser navigation headers. A Chrome TLS fingerprint with
# only Accept is still forbidden; a same-site Referer makes the request pass.
HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "referer": "https://goldprice.org/",
    "origin": "https://goldprice.org",
}


def main() -> None:
    try:
        from curl_cffi import requests

        response = requests.get(
            URL,
            impersonate="chrome",
            timeout=15,
            headers=HEADERS,
        )

        if response.status_code != 200:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "status": response.status_code,
                        "error": "request blocked or failed",
                    }
                )
            )
            return

        payload = response.json()
        items = payload.get("items") or []
        if not items:
            print(json.dumps({"ok": False, "error": "items missing"}))
            return

        item = items[0]
        xau_price = item.get("xauPrice")
        if not isinstance(xau_price, (int, float)) or xau_price <= 0:
            print(json.dumps({"ok": False, "error": "xauPrice missing"}))
            return

        print(
            json.dumps(
                {
                    "ok": True,
                    "xauPrice": xau_price,
                    "xauClose": item.get("xauClose"),
                    "date": item.get("date"),
                    "tsj": payload.get("tsj"),
                }
            )
        )
    except Exception as error:  # noqa: BLE001 - one JSON line is the contract
        print(json.dumps({"ok": False, "error": str(error)[:300]}))


if __name__ == "__main__":
    main()
    sys.exit(0)
