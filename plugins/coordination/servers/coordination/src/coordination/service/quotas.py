"""Remote-peer quotas (spec 3.3.2).

- At most 20 held tasks per peer; over that, 429 with `Retry-After`. Counted from the database
  (`CoordTaskStore.count_held`), so it survives a restart.
- At most 10 `SendMessage` per minute per peer. Counters are in process memory, like every other
  rate counter (spec 1.1); a restart resets them.

The per-client-IP limit at S3 and the handle-guess counter are not here: the first belongs to the
public listener, the second is built with S2-LISTEN.
"""

from __future__ import annotations

from collections import deque

from coordination.clock import Clock

MAX_HELD_PER_PEER = 20
SENDS_PER_WINDOW = 10
WINDOW_S = 60.0


class SlidingWindowLimiter:
    """`limit` hits per `window_s` seconds per key, on the monotonic clock."""

    def __init__(self, clock: Clock, limit: int = SENDS_PER_WINDOW, window_s: float = WINDOW_S) -> None:
        if limit < 1 or window_s <= 0:
            raise ValueError("limit and window must be positive")
        self._clock = clock
        self._limit = limit
        self._window_s = window_s
        self._hits: dict[str, deque[float]] = {}

    def hit(self, key: str) -> int | None:
        """Count one attempt. None if it is within the limit, else the whole seconds to wait."""
        now = self._clock.monotonic()
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] >= self._window_s:
            hits.popleft()
        if len(hits) >= self._limit:
            return max(1, int(self._window_s - (now - hits[0])) + 1)
        hits.append(now)
        return None

    def forget_idle(self) -> None:
        """Drop keys whose window is empty, so a long run does not keep every peer it ever saw."""
        now = self._clock.monotonic()
        for key in [k for k, h in self._hits.items() if not h or now - h[-1] >= self._window_s]:
            del self._hits[key]
