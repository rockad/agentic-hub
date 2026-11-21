"""How a parked `/wake/listen` request ends (spec 7.1): one `Release` per way out.

A `Release` is data, not a response: the listener table hands one to the parked request, and the
route turns it into the HTTP answer. Nothing here ever carries task text. The one body this module
produces is `woken(n)`, an integer of one to four digits (spec 7.1: "the 200 body is an integer
only"), so the wake path has no way to carry anything else.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: The only body a wake answer may have. A test pins that every release matches it or is empty.
COUNT_BODY_RE = re.compile(r"[0-9]{1,4}")  # use `fullmatch`: `$` would also accept a trailing newline
#: Largest count written into a wake answer; a bigger real count is shown as this [design].
MAX_COUNT = 9999
#: `Retry-After` for a listener answered during shutdown (spec 7.1, deliverable "SIGTERM").
SHUTDOWN_RETRY_AFTER_S = 5


@dataclass(frozen=True)
class Release:
    """The answer to a parked listener: status, the optional `X-Coord-Reason`, `Retry-After`, and
    the body (empty except for a 200, which is the count)."""

    status: int
    reason: str | None = None
    retry_after: int | None = None
    body: str = ""

    def __post_init__(self) -> None:
        if self.status == 200:
            if not COUNT_BODY_RE.fullmatch(self.body):
                raise ValueError("a 200 wake answer is one integer and nothing else")
        elif self.body:
            raise ValueError("only a 200 wake answer has a body")


#: 408: the round ended with nothing to deliver. The client loops at once.
ROUND_END = Release(408)
#: 409: a newer listener for this handle took over.
SUPERSEDED = Release(409, reason="superseded")
#: 403: the API key the listener parked with was revoked while it was parked.
KEY_REVOKED = Release(403)
#: 410: the session ended while the listener was parked.
ENDED = Release(410, reason="ended")
#: 503: the server is shutting down; back off and re-park.
SHUTDOWN = Release(503, retry_after=SHUTDOWN_RETRY_AFTER_S)
#: Internal: the client hung up. Nothing is sent to anybody.
GONE = Release(499)


def woken(count: int) -> Release:
    """200 with the pending count as the whole body, clamped to 1..9999 (spec 7.1)."""
    n = min(max(int(count), 1), MAX_COUNT)
    return Release(200, body=str(n))
