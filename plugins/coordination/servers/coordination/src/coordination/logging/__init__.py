"""Structured logging for the coordination server (S1-OBS).

`configure_logging(level)` is called once, from `app.main`. Every record then goes out as one
JSON line with credentials scrubbed (`redact`). The level is `A2A_LOG_LEVEL` (spec 1.5).

This package is named `logging` because the S1-OBS scope names it so. It never shadows the
standard library: every module in the project imports with absolute names.
"""

from __future__ import annotations

import json
import logging as _stdlib
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import IO, Any

from coordination.logging.middleware import (
    AuthorizationRedactionMiddleware,
    credential_from_scope,
)
from coordination.logging.redact import REDACTED, Credential, contains_secret, redact

__all__ = [
    "REDACTED",
    "AuthorizationRedactionMiddleware",
    "Credential",
    "JsonFormatter",
    "RedactingFilter",
    "configure_logging",
    "contains_secret",
    "credential_from_scope",
    "redact",
]

_HANDLER_MARK = "_coordination_handler"


class RedactingFilter(_stdlib.Filter):
    """Rewrites the message of a record with credentials removed, whatever handler gets it."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self._secrets = tuple(s for s in secrets if s)

    def filter(self, record: _stdlib.LogRecord) -> bool:
        record.msg = redact(record.getMessage(), self._secrets)
        record.args = None
        return True


class JsonFormatter(_stdlib.Formatter):
    """One JSON object per line: `ts`, `level`, `logger`, `msg`, optional `fields`, `exc`.

    Pass structured data as `logger.info("text", extra={"fields": {...}})`. Field values and the
    traceback are scrubbed like the message.
    """

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self._secrets = tuple(s for s in secrets if s)

    def _clean(self, value: Any) -> Any:
        if isinstance(value, str):
            return redact(value, self._secrets)
        if isinstance(value, dict):
            return {str(k): self._clean(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._clean(v) for v in value]
        if value is None or isinstance(value, (bool, int, float)):
            return value
        return redact(repr(value), self._secrets)

    def format(self, record: _stdlib.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": self._clean(record.getMessage()),
        }
        fields = getattr(record, "fields", None)
        if fields:
            out["fields"] = self._clean(fields)
        if record.exc_info:
            out["exc"] = self._clean(self.formatException(record.exc_info))
        return json.dumps(out, separators=(",", ":"), ensure_ascii=True)


def configure_logging(
    level: str = "info",
    *,
    stream: IO[str] | None = None,
    secrets: Iterable[str] = (),
) -> _stdlib.Handler:
    """Install the one root handler (JSON lines, redacted) at `level`; return it.

    Calling it again replaces the earlier handler, so tests and re-configuration do not stack
    handlers. Uvicorn's own loggers propagate here when the server runs with `log_config=None`.
    """
    numeric = _stdlib.getLevelNamesMapping().get(level.upper())
    if numeric is None or level.lower() not in ("debug", "info", "warning", "error", "critical"):
        raise ValueError(f"unknown log level {level!r}")
    secrets = tuple(secrets)
    root = _stdlib.getLogger()
    for old in [h for h in root.handlers if getattr(h, _HANDLER_MARK, False)]:
        root.removeHandler(old)
    handler = _stdlib.StreamHandler(stream if stream is not None else sys.stderr)
    handler.addFilter(RedactingFilter(secrets))
    handler.setFormatter(JsonFormatter(secrets))
    setattr(handler, _HANDLER_MARK, True)
    root.addHandler(handler)
    root.setLevel(numeric)
    return handler
