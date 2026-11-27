"""`/sessions` (spec 3.5): the HTTP face of `IdentityService`.

- `POST /sessions`: register or refresh a session (the `SessionStart` hook of both harnesses). A
  session that had ended is revived (decision Z17); there is no `409 session_ended`.
- `GET /sessions`: list sessions with liveness and pending counts; live sessions only unless
  `include_ended=1` (Z17).
- `POST /sessions/end`: end a session and close its parked listener (the `SessionEnd` hook).

The access-control middleware has already checked size, Host, Origin, the API key and its scope
(`/sessions` is `local-harness` only). These handlers fail closed anyway: no principal is `401`, a
principal that is not a `local-harness` key with a card is `403`.

Bodies are strict: unknown fields are `400`, so a hook cannot send (and the server cannot be asked
to store) a working directory, a path or a process id (spec 3.5: "no working directory, hostname
beyond the card, process id or file path is accepted or stored"). `harness_version` is accepted
and not stored.

Errors are `application/problem+json` (spec 2.1) with an extra member `code` (constant).
"""

from __future__ import annotations

import json
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import BaseRoute, Route

from coordination.auth.middleware import principal_from_scope
from coordination.auth.records import LOCAL_HARNESS
from coordination.identity.errors import IdentityError, InvalidRequest, WrongCard
from coordination.identity.handles import CARD_RE, HANDLE_RE, SESSION_ID_RE
from coordination.identity.registry import MAX_LIST
from coordination.identity.service import IdentityService
from coordination.text_sanitize import sanitize_preview

_TITLES = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
}

_REGISTER_FIELDS = frozenset({"card", "harness_session_id", "name_hint", "harness_version"})
_END_FIELDS = frozenset({"handle", "card", "harness_session_id"})
MAX_HARNESS_VERSION = 64
DEFAULT_LIST = 100


def _problem(status: int, code: str, detail: str, headers: dict[str, str] | None = None) -> Response:
    response = JSONResponse(
        {"type": "about:blank", "title": _TITLES.get(status, "Error"), "status": status, "detail": detail, "code": code},
        status_code=status,
        media_type="application/problem+json",
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers.update(headers or {})
    return response


def _json(body: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


class SessionsEndpoint:
    """The three routes of spec 3.5 over one `IdentityService`."""

    def __init__(self, identity: IdentityService) -> None:
        self._identity = identity

    def routes(self) -> list[BaseRoute]:
        return [
            Route("/sessions", self._collection, methods=["GET", "POST"]),
            Route("/sessions/end", self._end, methods=["POST"]),
        ]

    # -- shared --------------------------------------------------------------------------

    @staticmethod
    def _card(request: Request) -> tuple[str, str] | Response:
        """(key id, card id) of a `local-harness` key, or the refusal."""
        principal = principal_from_scope(request.scope)
        if principal is None:
            return _problem(401, "unauthorized", "Authentication required.", {"WWW-Authenticate": "Bearer"})
        if principal.scope != LOCAL_HARNESS or not principal.card_id:
            return _problem(403, "forbidden", "Access denied.")
        return principal.key_id, principal.card_id

    @staticmethod
    async def _body(request: Request, allowed: frozenset[str]) -> dict[str, Any]:
        try:
            body = json.loads(await request.body())
        except (ValueError, UnicodeDecodeError):
            raise InvalidRequest("The body is not valid JSON.") from None
        if not isinstance(body, dict):
            raise InvalidRequest("The body must be a JSON object.")
        extra = sorted(set(body) - allowed)
        if extra:  # names only, never the values
            raise InvalidRequest(f"Unknown field: {', '.join(k[:40] for k in extra[:5])}.")
        return body

    @staticmethod
    def _text(body: dict[str, Any], name: str, *, required: bool = False) -> str | None:
        value = body.get(name)
        if value is None:
            if required:
                raise InvalidRequest(f"{name} is required.")
            return None
        if not isinstance(value, str):
            raise InvalidRequest(f"{name} must be a string.")
        return value

    def _fail(self, exc: IdentityError) -> Response:
        return _problem(exc.status, exc.code, exc.message)

    # -- POST /sessions, GET /sessions ---------------------------------------------------

    async def _collection(self, request: Request) -> Response:
        who = self._card(request)
        if isinstance(who, Response):
            return who
        key_id, card_id = who
        try:
            if request.method == "POST":
                return await self._register(request, key_id, card_id)
            return await self._list(request)
        except IdentityError as exc:
            return self._fail(exc)

    async def _register(self, request: Request, key_id: str, card_id: str) -> Response:
        body = await self._body(request, _REGISTER_FIELDS)
        card = self._text(body, "card", required=True)
        hsid = self._text(body, "harness_session_id", required=True)
        hint = self._text(body, "name_hint") or ""
        version = self._text(body, "harness_version")
        if hsid is None or not SESSION_ID_RE.match(hsid):
            raise InvalidRequest("harness_session_id is not a valid session id.")
        if version is not None and len(version) > MAX_HARNESS_VERSION:
            raise InvalidRequest("harness_version is too long.")
        if card != card_id:
            raise WrongCard("card does not match the API key.")
        result = await self._identity.register(card_id, key_id, hsid, hint)
        session = result.session
        aliases = await self._identity.registry.aliases(session.handle)
        payload = {
            "handle": session.handle,
            "card": session.card_id,
            "created": result.created,
            "bind_with": "a2a_hello",
            "aliases": aliases,
        }
        return _json(payload, 201 if result.created else 200)

    async def _list(self, request: Request) -> Response:
        params = request.query_params
        unknown = sorted(set(params) - {"handle", "card", "include_ended", "limit"})
        if unknown:
            raise InvalidRequest(f"Unknown parameter: {unknown[0][:40]}.")
        handle = params.get("handle")
        if handle is not None and not HANDLE_RE.match(handle):
            raise InvalidRequest("handle is not a valid handle.")
        card = params.get("card")
        if card is not None and not CARD_RE.match(card):
            raise InvalidRequest("card is not a valid card id.")
        include_raw = params.get("include_ended", "0")
        if include_raw not in ("0", "1"):
            raise InvalidRequest("include_ended must be 0 or 1.")
        limit_raw = params.get("limit", str(DEFAULT_LIST))
        if not limit_raw.isdigit() or not 1 <= int(limit_raw) <= MAX_LIST:
            raise InvalidRequest(f"limit must be an integer from 1 to {MAX_LIST}.")
        rows = await self._identity.list_sessions(
            handle=handle, card_id=card, include_ended=include_raw == "1", limit=int(limit_raw)
        )
        return _json(
            {
                "sessions": [
                    {
                        "handle": sanitize_preview(r.view.handle),
                        "card": sanitize_preview(r.view.card_id),
                        "liveness": r.liveness,
                        "registered_at": r.view.registered_at.isoformat(),
                        "last_seen_at": r.view.last_seen_at.isoformat(),
                        "pending": r.pending,
                        "aliases": [sanitize_preview(a) for a in r.view.aliases],
                    }
                    for r in rows
                ]
            }
        )

    # -- POST /sessions/end --------------------------------------------------------------

    async def _end(self, request: Request) -> Response:
        who = self._card(request)
        if isinstance(who, Response):
            return who
        key_id, card_id = who
        try:
            body = await self._body(request, _END_FIELDS)
            handle = self._text(body, "handle")
            card = self._text(body, "card")
            hsid = self._text(body, "harness_session_id")
            if handle is not None:
                if card is not None or hsid is not None:
                    raise InvalidRequest("Give either handle or card with harness_session_id.")
            elif card is None or hsid is None:
                raise InvalidRequest("Give either handle or card with harness_session_id.")
            elif card != card_id:
                raise WrongCard("card does not match the API key.")
            elif not SESSION_ID_RE.match(hsid):
                raise InvalidRequest("harness_session_id is not a valid session id.")
            result = await self._identity.end(card_id, handle=handle, harness_session_id=hsid, key_id=key_id)
        except IdentityError as exc:
            return self._fail(exc)
        return _json(
            {
                "handle": result.handle,
                "card": result.card_id,
                "ended": True,
                "already_ended": not result.ended_now,
                "listeners_closed": result.report.total_closed,
            }
        )
