"""Vercel file-based Python function for source B (GoldPrice.org).

No web framework: a framework preset would shadow the Next.js routes.
Bundles scripts/fetch_goldprice.py via vercel.json includeFiles.
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from fetch_goldprice import main  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - Vercel contract
        # Capture the script's single JSON line instead of writing to stdout.
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            main()

        line = buffer.getvalue().strip().splitlines()
        body = line[-1] if line else json.dumps({"ok": False, "error": "no output"})

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))
