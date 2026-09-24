#!/usr/bin/env python3
"""
Local dev server: like `python -m http.server`, but tells the browser not to
cache anything. Plain http.server sends no cache headers, so browsers
heuristically cache config.js and the modules and you test stale code.

It also accepts one kind of write, for tools/review.html: a POST of JSON to
/work/review.json, only from this computer (127.0.0.1 / ::1).

    python scripts/serve.py            # http://localhost:8000
    python scripts/serve.py 9000
"""
import http.server
import json
import sys
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # repo root
REVIEW_PATH = "/work/review.json"
MAX_BODY = 2 * 1024 * 1024


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != REVIEW_PATH:
            return self.send_error(404, "Only /work/review.json accepts writes")
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return self.send_error(403, "Review decisions can only be saved from this computer")
        length = int(self.headers.get("Content-Length", 0))
        if not 0 < length <= MAX_BODY:
            return self.send_error(413, "Body missing or too large")
        try:
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("expected a JSON object")
        except ValueError as e:
            return self.send_error(400, f"Bad JSON: {e}")
        target = ROOT / "work" / "review.json"
        target.parent.mkdir(exist_ok=True)
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        tmp.replace(target)
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = partial(DevHandler, directory=str(ROOT))
    print(f"Serving {ROOT} at http://localhost:{port} (no-cache)")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
