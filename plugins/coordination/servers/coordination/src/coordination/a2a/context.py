"""What both bindings do before they run an operation: the version check and the caller.

The access-control middleware (S1-AUTH) has already authenticated the request and scoped the path
by the time a handler runs. The caller is built here from the principal it left in the scope, never
from the body (spec 3.3.2, step 1):

- `local-harness`: the key's card, plus a session handle when `X-Coord-Handle` names a live,
  registered session of that same card. A header that does not (unknown, ended, another card,
  malformed, repeated) is ignored and the caller acts at card level [design]: the handle is only
  ever a display and routing hint, and a stale one from a hook script should not break a call.
- `remote-peer`: `peer:<peer_id>` and the key's `cards_allowed`. The handle header is not read.

A request that reaches a handler without a principal (the app was built without a key store) is
refused, not served.
"""

from __future__ import annotations

from starlette.requests import Request

from coordination.a2a import errors as E
from coordination.auth.middleware import principal_from_scope
from coordination.auth.records import LOCAL_HARNESS, REMOTE_PEER
from coordination.service import Caller
from coordination.service.directory import Directory
from coordination.service.types import HANDLE_RE, card_of

VERSION_HEADER = "A2A-Version"
HANDLE_HEADER = "X-Coord-Handle"
SERVED_VERSION = "1.0"


def check_version(value: str | None) -> None:
    """D33: `A2A-Version: 1.0` is required. A missing header, `0.3` and anything else is
    `VersionNotSupportedError` (-32009). A patch level (`1.0.1`) is accepted; `1.1` is not, because
    this server serves 1.0 only."""
    seen = (value or "").strip()
    if seen == SERVED_VERSION or seen.startswith(SERVED_VERSION + "."):
        return
    raise E.version_not_supported(seen or None)


async def caller_from_request(request: Request, directory: Directory) -> Caller:
    principal = principal_from_scope(request.scope)
    if principal is None:
        raise E.A2AProblem(-32600, 401, "UNAUTHENTICATED", "UNAUTHENTICATED", "Authentication required.", rpc_http_status=401)
    if principal.scope == LOCAL_HARNESS and principal.card_id:
        return Caller(
            LOCAL_HARNESS,
            principal.key_id,
            card_id=principal.card_id,
            handle=await _live_handle(request, directory, principal.card_id),
        )
    if principal.scope == REMOTE_PEER and principal.peer_id:
        return Caller(
            REMOTE_PEER,
            principal.key_id,
            peer_id=principal.peer_id,
            cards_allowed=frozenset(principal.cards_allowed or ()),
        )
    raise E.forbidden("This key cannot use this endpoint.")


async def _live_handle(request: Request, directory: Directory, card_id: str) -> str | None:
    values = request.headers.getlist(HANDLE_HEADER)
    if len(values) != 1:
        return None
    handle = values[0].strip()
    if not HANDLE_RE.match(handle) or card_of(handle) != card_id:
        return None
    session = await directory.session(handle)
    if session is None or session.ended or session.card_id != card_id:
        return None
    return handle
