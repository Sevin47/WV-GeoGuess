#!/usr/bin/env python3
"""
Local dev server: like `python -m http.server`, but tells the browser not to
cache anything. Plain http.server sends no cache headers, so browsers
heuristically cache config.js and the modules and you test stale code.

    python scripts/serve.py            # http://localhost:8000
    python scripts/serve.py 9000
"""
import http.server
import sys
from functools import partial
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = Path(__file__).resolve().parent.parent  # repo root
    handler = partial(NoCacheHandler, directory=str(root))
    print(f"Serving {root} at http://localhost:{port} (no-cache)")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
