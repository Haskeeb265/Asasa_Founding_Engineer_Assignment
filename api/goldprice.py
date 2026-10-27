import json
import os
import sys
from http.server import BaseHTTPRequestHandler

"""
Vercel Python function for the GoldPrice.org leg (source B).

Why this exists: goldprice.org's WAF 403s every non-browser TLS fingerprint,
so the fetch must run through curl_cffi (impersonate="chrome"). Vercel's Node
serverless runtime has no Python and plain Node fetch is blocked, so the
Node pricing cycle calls this function over HTTP instead
(server/sources/goldprice-org.ts, GOLDPRICE_FETCH_MODE=remote).

Vercel maps this file to GET /api/goldprice (file-based /api functions).
The handler reuses the fetch logic from scripts/fetch_goldprice.py; vercel.json
ships that file into this function's bundle.
"""

# The project root must be on sys.path so `scripts.fetch_goldprice` resolves.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.fetch_goldprice import fetch_goldprice  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        body = json.dumps(fetch_goldprice()).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # keep function logs quiet; the Node cycle logs the outcome
