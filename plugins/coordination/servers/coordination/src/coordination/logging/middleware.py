"""ASGI middleware that takes the `Authorization` header out of the request scope (S1-OBS).

After this middleware runs, nothing downstream sees the credential unless it asks for it:

- every `Authorization` header in `scope["headers"]` carries the value `[redacted]`, so a
  handler, an error page or a debug dump of the headers cannot leak it;
- the first header's value is kept in `scope["coordination.credential"]` as a `Credential`
  (repr and str are `[REDACTED]`). S1-AUTH reads it with `credential_from_scope`.

It must be the outermost user middleware (first in the list) so that every other layer, the
authentication middleware included, runs after it.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Receive, Scope, Send

from coordination.logging.redact import Credential

SCOPE_KEY = "coordination.credential"
_PLACEHOLDER = b"[redacted]"


def credential_from_scope(scope: Scope) -> Credential | None:
    """The request's credential, or None when it sent no `Authorization` header."""
    value = scope.get(SCOPE_KEY)
    return value if isinstance(value, Credential) else None


class AuthorizationRedactionMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = []
        credential: Credential | None = None
        for name, value in scope.get("headers", []):
            if name.lower() == b"authorization":
                if credential is None:
                    credential = Credential(value.decode("latin-1"))
                headers.append((name, _PLACEHOLDER))
            else:
                headers.append((name, value))
        scope = dict(scope)
        scope["headers"] = headers
        # A client cannot plant a credential: the key is ours and is overwritten or removed here.
        scope.pop(SCOPE_KEY, None)
        if credential is not None:
            scope[SCOPE_KEY] = credential
        await self.app(scope, receive, send)
