""""Offered until confirmed" arithmetic (spec 6.3).

`next_offer_at` after the n-th offer is `last_offered_at + A2A_REOFFER_AFTER_S * 3^(n-1)`. After
`A2A_REOFFER_MAX` offers a task stops causing wakes; it stays in the inbox and the pending count.
The count stops at the cap and the window length stays at its last value, so a task offered
beyond the cap neither grows its window without bound nor loses its card-queue fallback.
"""

from __future__ import annotations

from datetime import datetime, timedelta


def offer_delay(n: int, reoffer_after_s: int) -> timedelta:
    """The wait after the n-th offer (n counts from 1): `reoffer_after_s * 3^(n-1)` seconds."""
    if n < 1:
        raise ValueError("offers are counted from 1")
    return timedelta(seconds=reoffer_after_s * 3 ** (n - 1))


def next_offer_at(last_offered_at: datetime, n: int, reoffer_after_s: int) -> datetime:
    return last_offered_at + offer_delay(n, reoffer_after_s)


def after_offer(
    offer_count: int, now: datetime, reoffer_after_s: int, reoffer_max: int
) -> tuple[int, datetime]:
    """The (offer_count, next_offer_at) a task has once it is offered at `now`."""
    n = min(offer_count + 1, reoffer_max)
    return n, next_offer_at(now, n, reoffer_after_s)


def wakes_stopped(offer_count: int, reoffer_max: int) -> bool:
    """True once the task has been offered `A2A_REOFFER_MAX` times: no further wakes for it."""
    return offer_count >= reoffer_max
