"""The small stateful rules of the wake path, in memory (spec 7.4, 7.5, 7.1).

- `AntiLoop`: after three consecutive wakes of a handle that were not confirmed for the same
  pending set, wakes for that set stop until the set changes or one hour passes (spec 7.4).
- `Announcer`: the `announce` dedupe of `/wake/pending`: true only when the count is above zero
  and changed since the last announcement to the handle, or ten minutes passed (spec 7.5).
- `ParkLimiter`: the `429` of spec 7.1 ("listener polling faster than allowed").

State is per process and lost at a restart. That is safe for each: the hard bound on wakes is the
budget, which is read from the `wakes` rows and survives a restart; a restart only lets a stopped
set wake again (still inside the budget), repeats one announcement, and clears the park counters.
[design] for all three numbers that the spec does not fix (the limiter's, below).
"""

from __future__ import annotations

import hashlib
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta

#: Spec 7.4: "three consecutive wakes ... for the same pending set", then "one hour".
ANTI_LOOP_STREAK = 3
ANTI_LOOP_HOLD = timedelta(hours=1)
#: Spec 7.5: the same count is announced again after ten minutes.
ANNOUNCE_REPEAT = timedelta(minutes=10)
#: [design] A listener may park at most this many times per window per handle. A healthy session
#: parks once per finished turn or per 900 s round; a faster loop is the runaway the budget is for.
PARK_LIMIT = 30
PARK_WINDOW_S = 60.0
#: Bound on remembered handles, so a flood of registrations cannot grow the maps without limit.
MAX_TRACKED = 4096


def fingerprint(task_ids: frozenset[str]) -> str:
    """A short stable name for a pending set: the hash of its sorted ids. Ids only, no content."""
    h = hashlib.sha256()
    for task_id in sorted(task_ids):
        h.update(task_id.encode())
        h.update(b"\n")
    return h.hexdigest()[:16]


@dataclass
class _Loop:
    key: str
    streak: int
    last_at: datetime
    confirmed: bool


class AntiLoop:
    def __init__(self, *, streak: int = ANTI_LOOP_STREAK, hold: timedelta = ANTI_LOOP_HOLD) -> None:
        self._streak = streak
        self._hold = hold
        self._state: dict[str, _Loop] = {}

    def blocked(self, handle: str, key: str, now: datetime) -> bool:
        """True while wakes of `handle` for the pending set `key` are stopped."""
        s = self._state.get(handle)
        if s is None or s.key != key or s.confirmed or s.streak < self._streak:
            return False
        return now - s.last_at < self._hold

    def sent(self, handle: str, key: str, now: datetime) -> int:
        """Record a wake of `handle` for set `key`. Returns the unconfirmed streak it makes."""
        s = self._state.get(handle)
        if s is not None and s.key == key and not s.confirmed and now - s.last_at < self._hold:
            s.streak += 1
            s.last_at = now
        else:
            if s is None and len(self._state) >= MAX_TRACKED:
                self._state.pop(next(iter(self._state)))
            self._state[handle] = s = _Loop(key, 1, now, False)
        return s.streak

    def confirmed(self, handle: str, now: datetime, window: timedelta) -> None:
        """The handle showed up: its last wake counts as confirmed if it was inside `window`."""
        s = self._state.get(handle)
        if s is not None and now - s.last_at <= window:
            s.confirmed = True


class Announcer:
    def __init__(self, *, repeat: timedelta = ANNOUNCE_REPEAT) -> None:
        self._repeat = repeat
        self._last: dict[str, tuple[int, datetime]] = {}

    def check(self, handle: str, pending: int, now: datetime, *, record: bool) -> bool:
        """Should this pending count be announced to `handle` now? With `record`, an announcement
        is remembered (the `announce=1` form); without it the call changes nothing. A count of
        zero clears the memory, so a later non-zero count is announced afresh [design]."""
        if pending <= 0:
            if record:
                self._last.pop(handle, None)
            return False
        last = self._last.get(handle)
        fresh = last is None or last[0] != pending or now - last[1] >= self._repeat
        if fresh and record:
            if last is None and len(self._last) >= MAX_TRACKED:
                self._last.pop(next(iter(self._last)))
            self._last[handle] = (pending, now)
        return fresh


class ParkLimiter:
    """At most `limit` parks per `window_s` per handle, by the monotonic clock."""

    def __init__(self, *, limit: int = PARK_LIMIT, window_s: float = PARK_WINDOW_S) -> None:
        self._limit = limit
        self._window = window_s
        self._seen: dict[str, deque[float]] = {}

    def check(self, handle: str, now_m: float) -> float | None:
        """None if the park may go ahead (and is counted), else the seconds to wait."""
        times = self._seen.get(handle)
        if times is None:
            if len(self._seen) >= MAX_TRACKED:
                self._seen.pop(next(iter(self._seen)))
            times = self._seen[handle] = deque()
        while times and now_m - times[0] >= self._window:
            times.popleft()
        if len(times) >= self._limit:
            return max(self._window - (now_m - times[0]), 1.0)
        times.append(now_m)
        return None
