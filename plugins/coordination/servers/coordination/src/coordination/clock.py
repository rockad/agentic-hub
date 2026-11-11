"""Clock protocol, so TTLs, wake budgets and retention are testable with a fake clock."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Protocol, runtime_checkable


@runtime_checkable
class Clock(Protocol):
    def now(self) -> datetime:
        """Current wall-clock time, timezone-aware UTC."""
        ...

    def monotonic(self) -> float:
        """Seconds from a monotonic source, for durations and rate windows."""
        ...


class SystemClock:
    """The real clock."""

    def now(self) -> datetime:
        return datetime.now(UTC)

    def monotonic(self) -> float:
        return time.monotonic()
