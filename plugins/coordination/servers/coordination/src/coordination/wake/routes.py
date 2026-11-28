"""`POST /wake/listen` and `GET|POST /wake/pending` (spec 7.1, 7.5): the HTTP face of `WakeService`.

The access-control middleware has already checked size, Host, Origin, the API key and its scope
(`/wake` is `local-harness` only; a `remote-peer` or `status-client` key is `403` before this code
runs). These handlers fail closed anyway: no principal is `401`, a principal that is not a
`local-harness` key with a card is `403`.

`/wake/listen` answers with a `Release` and nothing else: `200` with an integer body, `408`,
`409` with `X-Coord-Reason: superseded`, `403`, `410` with `X-Coord-Reason: ended` or
`unregistered`, `429` with `Retry-After`, `503` with `Retry-After`. The header spelling is
`X-Coord-*` only (spec 7.1: the spike's short `X-Session`, `X-Wait` and `X-Again` are not accepted).
Errors that the table of spec 7.1 does not list (a missing or malformed header) are `400`
`application/problem+json` [design].

`/wake/pending` is the busy-session path. `GET ?session=<id>[&announce=1]` returns
`{"pending", "announce", "held_for_review", "listening", "wake_opted_in", "rearm"}` (the last three are
AW1, Z23: a listener is parked now, the session has opted in to idle wake, and with `announce=1` it
should re-arm its listener now, at most once per announce window). `POST` takes the Claude Code `UserPromptSubmit` HTTP
hook input and returns the hook output: only `session_id` is read from the body (the body also
carries the prompt text, which is never read, stored or logged), and the answer is `{}` unless
there is something to announce, then the `hookSpecificOutput` form SP1 T11 recorded as the only
one the harness accepts.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import BaseRoute, Route

from coordination.auth.middleware import principal_from_scope
from coordination.auth.records import LOCAL_HARNESS
from coordination.identity.handles import valid_session_id
from coordination.wake.outcomes import GONE, Release
from coordination.wake.service import WakeService

log = logging.getLogger("coordination.wake")

_TITLES = {400: "Bad Request", 401: "Unauthorized", 403: "Forbidden"}


def _problem(status: int, detail: str, headers: dict[str, str] | None = None) -> Response:
    response = JSONResponse(
        {"type": "about:blank", "title": _TITLES.get(status, "Error"), "status": status, "detail": detail},
        status_code=status,
        media_type="application/problem+json",
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers.update(headers or {})
    return response


def _bare(status: int, headers: dict[str, str] | None = None) -> Response:
    """An empty answer, as the status table of spec 7.1 shows them."""
    response = Response(status_code=status)
    response.headers["Cache-Control"] = "no-store"
    response.headers.update(headers or {})
    return response


def response_for(release: Release) -> Response:
    """The HTTP answer for a `Release`. The only body is the 200's integer."""
    headers: dict[str, str] = {}
    if release.reason:
        headers["X-Coord-Reason"] = release.reason
    if release.retry_after is not None:
        headers["Retry-After"] = str(release.retry_after)
    if release.status == 200:
        response = Response(release.body, status_code=200, media_type="text/plain")
        response.headers["Cache-Control"] = "no-store"
        return response
    if release == GONE:
        return _bare(408)  # the client is not there to read it
    return _bare(release.status, headers)


class WakeEndpoint:
    def __init__(self, wake: WakeService, *, round_s: int) -> None:
        self._wake = wake
        self._round_s = max(1, round_s)

    def routes(self) -> list[BaseRoute]:
        return [
            Route("/wake/listen", self._listen, methods=["POST"]),
            Route("/wake/pending", self._pending, methods=["GET", "POST"]),
        ]

    @staticmethod
    def _who(request: Request) -> tuple[str, str] | Response:
        """(key id, card id) of a `local-harness` key, or the refusal."""
        principal = principal_from_scope(request.scope)
        if principal is None:
            return _problem(401, "Authentication required.", {"WWW-Authenticate": "Bearer"})
        if principal.scope != LOCAL_HARNESS or not principal.card_id:
            return _problem(403, "Access denied.")
        return principal.key_id, principal.card_id

    # -- POST /wake/listen -----------------------------------------------------------------

    def _round(self, request: Request) -> float | Response:
        """`X-Coord-Wait`: the requested round in seconds, at most `A2A_WAKE_ROUND_S`."""
        raw = request.headers.get("x-coord-wait")
        if raw is None:
            return float(self._round_s)
        if not raw.isdigit() or len(raw) > 6 or int(raw) < 1:
            return _problem(400, "X-Coord-Wait must be a whole number of seconds, at least 1.")
        return float(min(int(raw), self._round_s))

    async def _listen(self, request: Request) -> Response:
        who = self._who(request)
        if isinstance(who, Response):
            return who
        key_id, card_id = who
        if self._wake.table.closing:
            return response_for(Release(503, retry_after=5))
        hsid = valid_session_id(request.headers.get("x-coord-session"))
        if hsid is None:
            return _problem(400, "X-Coord-Session is required and must be a session id.")
        wait = self._round(request)
        if isinstance(wait, Response):
            return wait
        session = await self._wake.resolve(card_id, hsid)
        if session is None:
            return _bare(410, {"X-Coord-Reason": "unregistered"})
        if session.ended:
            return _bare(410, {"X-Coord-Reason": "ended"})
        claimed = request.headers.get("x-coord-handle")
        if claimed is not None and claimed != session.handle:
            return _problem(403, "X-Coord-Handle does not match the session.")
        again = request.headers.get("x-coord-again", "")
        delay = self._wake.park_delay(session.handle)
        if delay is not None:
            return _bare(429, {"Retry-After": str(max(1, int(delay + 0.999)))})
        entry = self._wake.table.park(session.handle, card_id, key_id)
        # AW1 (Z23): a listener's first round is its opt-in. Later rounds (`X-Coord-Again` above 1)
        # do not set it, so a listener that outlives `a2a_wake_off` does not undo it.
        if again in ("", "1"):
            await self._wake.opt_in(session)
        log.debug("listener parked", extra={"fields": {"again": again[:8] if again.isdigit() else None}})
        release = await self._wake.listen(entry, wait, request.receive)
        return response_for(release)

    # -- GET|POST /wake/pending ------------------------------------------------------------

    async def _pending(self, request: Request) -> Response:
        who = self._who(request)
        if isinstance(who, Response):
            return who
        _key_id, card_id = who
        if request.method == "POST":
            return await self._pending_hook(request, card_id)
        hsid = valid_session_id(request.query_params.get("session"))
        if hsid is None:
            return _problem(400, "session is required and must be a session id.")
        flag = request.query_params.get("announce")
        if flag not in (None, "0", "1"):
            return _problem(400, "announce must be 0 or 1.")
        session = await self._wake.resolve(card_id, hsid)
        if session is None:
            return _bare(410, {"X-Coord-Reason": "unregistered"})
        if session.ended:
            return _bare(410, {"X-Coord-Reason": "ended"})
        view = await self._wake.pending(session, announce=flag == "1")
        response = JSONResponse(
            {
                "pending": view.pending,
                "announce": view.announce,
                "held_for_review": view.held_for_review,
                "listening": view.listening,
                "wake_opted_in": view.wake_opted_in,
                "rearm": view.rearm,
            }
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    async def _pending_hook(self, request: Request, card_id: str) -> Response:
        """The `UserPromptSubmit` HTTP hook. Fails open: an unknown or ended session gets `{}`, so
        a prompt is never held up by the registration race."""
        try:
            body: Any = json.loads(await request.body())
        except (ValueError, UnicodeDecodeError):
            return _problem(400, "The body is not valid JSON.")
        if not isinstance(body, dict):
            return _problem(400, "The body must be a JSON object.")
        hsid = valid_session_id(body.get("session_id"))  # the only field read: never the prompt
        if hsid is None:
            return _problem(400, "session_id is required.")
        session = await self._wake.resolve(card_id, hsid)
        if session is None or session.ended:
            return _hook_output(None)
        view = await self._wake.pending(session, announce=True)
        return _hook_output(self._wake.pending_stub(view.pending) if view.announce else None)


def _hook_output(context: str | None) -> Response:
    payload: dict[str, Any] = {}
    if context is not None:
        payload = {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": context}}
    response = JSONResponse(payload)
    response.headers["Cache-Control"] = "no-store"
    return response
