"""Liveness states (spec 5.5; S1-ID).

- `listening`: a parked `/wake/listen` request exists for the session (the WAKE listener table,
  through the `ListenerView` port).
- `active`: an authenticated call from the session in the last 15 minutes [design, spec 5.5].
- `registered`: known and not ended.
- `ended`: `POST /sessions/end`, an idle expiry (`A2A_SESSION_IDLE_TTL_H`, the service layer's
  sweep) or a `410` served to its listener.

An ended session is `ended` whatever a listener table says. Not stored: `listening` lives in
memory, `active` is computed from `last_seen_at`, `ended` is `ended_at`.
"""

from __future__ import annotations

from datetime import datetime

from coordination.service.directory import ACTIVE_WINDOW

LISTENING = "listening"
ACTIVE = "active"
REGISTERED = "registered"
ENDED = "ended"
STATES = (LISTENING, ACTIVE, REGISTERED, ENDED)


def liveness_state(*, ended: bool, last_seen_at: datetime, now: datetime, listening: bool) -> str:
    if ended:
        return ENDED
    if listening:
        return LISTENING
    return ACTIVE if now - last_seen_at <= ACTIVE_WINDOW else REGISTERED
