"""Age of the last good database dump, for `dump_age_h` in `/status` (S1-BKP).

The dump sidecar writes one line to `last_ok` after a dump has passed `pg_restore --list`: the
UTC time of that dump in ISO-8601, for example `2026-11-12T02:00:00Z`. The server mounts the
file read-only (`A2A_DUMP_LAST_OK_FILE`) and only reads it. There is no `/status` endpoint
yet; this module is the helper it will call.

`None` means "unknown", not "fresh": the file is absent, empty or unparsable (before the first
successful dump, or a mis-set `backup` compose profile). `is_stale` is false for `None`, so the
status client has to show `null` in its own way.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

#: A dump older than this many hours is flagged stale (spec 1.2 and 3.6, round-2 R5).
STALE_AFTER_H = 36.0


def read_last_ok(last_ok_path: str | Path) -> datetime | None:
    """The time in `last_ok`, as an aware datetime, or None if there is none to be had.

    The first line is used. A timestamp without a UTC offset is rejected: the sidecar always
    writes `Z`, and guessing a zone would put a wrong number in `/status`.
    """
    try:
        text = Path(last_ok_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):  # absent, a directory, unreadable, not text
        return None
    lines = text.strip().splitlines()
    if not lines:
        return None
    try:
        stamp = datetime.fromisoformat(lines[0].strip())
    except ValueError:
        return None
    if stamp.tzinfo is None:
        return None
    return stamp.astimezone(UTC)


def dump_age_h(last_ok_path: str | Path, now: datetime) -> float | None:
    """Hours since the last good dump, rounded to 2 decimals; None if unknown.

    `now` must be timezone-aware (pass `clock`'s time, or a fixed one in a test). A timestamp
    in the future (clock skew) counts as age 0.0, never a negative number.
    """
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    stamp = read_last_ok(last_ok_path)
    if stamp is None:
        return None
    seconds = (now - stamp).total_seconds()
    return round(max(seconds, 0.0) / 3600.0, 2)


def is_stale(age_h: float | None) -> bool:
    """True when the dump is older than 36 hours. `None` (unknown) is not stale."""
    return age_h is not None and age_h > STALE_AFTER_H
