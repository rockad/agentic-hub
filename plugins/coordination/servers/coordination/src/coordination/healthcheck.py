"""Container healthcheck: `python3 -m coordination.healthcheck`. Exit 0 if /healthz answers ok."""

from __future__ import annotations

import json
import sys
import urllib.request

from coordination.config import load


def check(timeout: float = 3.0) -> bool:
    host, port = load().listen_host_port
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/healthz", timeout=timeout) as resp:
            return resp.status == 200 and json.load(resp) == {"ok": True}
    except (OSError, ValueError):
        return False


if __name__ == "__main__":
    sys.exit(0 if check() else 1)
