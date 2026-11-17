"""`/mcp`: MCP streamable HTTP, stateful, as one ASGI app (spec 3.4, SP5 D12).

This is the whole transport. It is written here instead of mounting the `mcp` SDK because every
point the SP5 D12 spike had to patch around is a line of this file:

- sessions are stateful, and `Mcp-Session-Id` is tied to the API key that initialised it, so key B
  with key A's session id is `403` (the SDK accepted it);
- `server/discover` answers with the stateful protocol versions only (`2025-11-25`, `2025-06-18`,
  `2025-03-26`), so a discover-first client (Claude Code, agy) falls back to `initialize` and gets
  a session id (the SDK's default advertised only the sessionless `2026-07-28`);
- there is no lifespan, no session-manager task and no private SDK attribute to depend on.

The wire shape is the one the S0 stub served to Claude Code 2.1.319 and agy 1.5.3 (SP2): every POST
is answered with `application/json` (no SSE stream), a notification gets `202`, `GET` gets `405` (no
server-initiated stream), `DELETE` ends a session, an unknown session is `404` (the client
re-initialises and re-sends), a request with no session header is `400`. That the stub worked with
both clients is reported by the SP2 results; this server has not been run against either client.

The transport sits behind the shared access-control middleware (S1-AUTH), which has already
checked size, Host, Origin, the API key and its scope (`/mcp` is `local-harness` only; a
`remote-peer` or `status-client` key gets `403` before this app runs). It fails closed anyway: no
principal means `401`.

JSON-RPC batches are refused (the 2025-06-18 revision removed them). A running tool call is cancelled
when the client disconnects or sends `notifications/cancelled` for it, so a parked `a2a_wait` does
not outlive its caller.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from typing import Any

from starlette.types import Receive, Scope, Send

import coordination
from coordination.auth.middleware import principal_from_scope
from coordination.auth.records import LOCAL_HARNESS
from coordination.mcp.sessions import McpSession, McpSessions
from coordination.mcp.tools import CallContext, McpTools

log = logging.getLogger("coordination.mcp")

#: Newest first. These are the stateful protocol versions; the sessionless 2026-07-28 is never
#: advertised (SP5 D12 finding 2).
SUPPORTED_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26")
SERVER_INFO = {"name": "a2a-coordination", "version": coordination.__version__}

# JSON-RPC error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
REQUEST_CANCELLED = -32800

SESSION_HEADER = b"mcp-session-id"


def _rpc_error(rid: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _rpc_result(rid: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "result": result}


async def _send_json(
    send: Send, status: int, body: Any | None, headers: dict[str, str] | None = None
) -> None:
    raw = b"" if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    out: list[tuple[bytes, bytes]] = [(b"content-length", str(len(raw)).encode())]
    if body is not None:
        out.append((b"content-type", b"application/json"))
    for name, value in (headers or {}).items():
        out.append((name.lower().encode(), value.encode()))
    await send({"type": "http.response.start", "status": status, "headers": out})
    await send({"type": "http.response.body", "body": raw})


async def _read_body(receive: Receive) -> bytes:
    chunks = []
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            raise _Disconnected
        chunks.append(message.get("body", b""))
        if not message.get("more_body", False):
            return b"".join(chunks)


class _Disconnected(Exception):
    pass


async def _until_disconnect(receive: Receive) -> None:
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return


class McpEndpoint:
    """The ASGI app for the `/mcp` path."""

    def __init__(self, tools: McpTools, sessions: McpSessions) -> None:
        self._tools = tools
        self._sessions = sessions
        self._inflight: dict[tuple[str, Any], asyncio.Task[Any]] = {}

    @property
    def sessions(self) -> McpSessions:
        """The `Mcp-Session-Id` map, for the code that revokes keys (`drop_key`) and for tests."""
        return self._sessions

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        principal = principal_from_scope(scope)
        if principal is None:
            await _send_json(
                send, 401, _rpc_error(None, INVALID_REQUEST, "Authentication required."), {"WWW-Authenticate": "Bearer"}
            )
            return
        if principal.scope != LOCAL_HARNESS or not principal.card_id:
            await _send_json(send, 403, _rpc_error(None, INVALID_REQUEST, "Access denied."))
            return
        method = scope["method"]
        if method == "POST":
            await self._post(scope, receive, send, principal)
        elif method == "DELETE":
            await self._delete(scope, send, principal)
        elif method == "GET":
            # No server-initiated stream (spec 3.4, verified with the stub): 405 says so.
            await _send_json(send, 405, None, {"Allow": "POST, DELETE"})
        else:
            await _send_json(send, 405, None, {"Allow": "POST, DELETE"})

    # -- sessions ------------------------------------------------------------------------

    @staticmethod
    def _session_header(scope: Scope) -> str | None:
        values = [v.decode("latin-1") for k, v in scope.get("headers", []) if k.lower() == SESSION_HEADER]
        return values[0] if len(values) == 1 else None

    def _lookup(self, scope: Scope, principal: Any) -> tuple[McpSession | None, tuple[int, str] | None]:
        """(session, None) for a good one, else (None, (http status, message))."""
        sid = self._session_header(scope)
        if not sid:
            return None, (400, "Mcp-Session-Id header required.")
        session = self._sessions.get(sid)
        if session is None:
            return None, (404, "Unknown session.")  # also after a restart: the client re-initialises
        if session.key_id != principal.key_id:
            return None, (403, "Access denied.")  # another key's session id (SP5 D12 finding 1)
        return session, None

    async def _delete(self, scope: Scope, send: Send, principal: Any) -> None:
        session, refusal = self._lookup(scope, principal)
        if refusal is not None:
            await _send_json(send, refusal[0], _rpc_error(None, INVALID_REQUEST, refusal[1]))
            return
        assert session is not None
        self._sessions.remove(session.session_id)
        await _send_json(send, 200, None)

    # -- POST ----------------------------------------------------------------------------

    async def _post(self, scope: Scope, receive: Receive, send: Send, principal: Any) -> None:
        try:
            raw = await _read_body(receive)
        except _Disconnected:
            return
        try:
            message = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            await _send_json(send, 400, _rpc_error(None, PARSE_ERROR, "Parse error."))
            return
        if isinstance(message, list):
            await _send_json(send, 400, _rpc_error(None, INVALID_REQUEST, "Batches are not supported."))
            return
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            await _send_json(send, 400, _rpc_error(None, INVALID_REQUEST, "Not a JSON-RPC 2.0 message."))
            return
        if "method" not in message:
            # A response to a server request. We send none, so there is nothing to match; accept it.
            await _send_json(send, 202, None)
            return
        method = message["method"]
        if not isinstance(method, str):
            await _send_json(send, 400, _rpc_error(None, INVALID_REQUEST, "method must be a string."))
            return
        params = message.get("params")
        if params is None:
            params = {}
        is_request = "id" in message
        rid = message.get("id")
        if is_request and (isinstance(rid, bool) or not isinstance(rid, (str, int))):
            await _send_json(send, 400, _rpc_error(None, INVALID_REQUEST, "id must be a string or an integer."))
            return
        if not isinstance(params, dict):
            await _send_json(send, 200 if is_request else 400, _rpc_error(rid, INVALID_PARAMS, "params must be an object."))
            return

        if method == "server/discover":
            await _send_json(send, 200, _rpc_result(rid, self._discover()))
            return
        if method == "initialize":
            await self._initialize(send, principal, rid, params)
            return

        session, refusal = self._lookup(scope, principal)
        if refusal is not None:
            await _send_json(send, refusal[0], _rpc_error(rid if is_request else None, INVALID_REQUEST, refusal[1]))
            return
        assert session is not None

        if not is_request:
            if method == "notifications/cancelled":
                self._cancel(session, params.get("requestId"))
            await _send_json(send, 202, None)
            return
        if method == "ping":
            await _send_json(send, 200, _rpc_result(rid, {}))
        elif method == "tools/list":
            await _send_json(send, 200, _rpc_result(rid, {"tools": self._tools.listing()}))
        elif method == "tools/call":
            await self._tools_call(receive, send, principal, session, rid, params)
        else:
            await _send_json(send, 200, _rpc_error(rid, METHOD_NOT_FOUND, "Method not found."))

    @staticmethod
    def _discover() -> dict[str, Any]:
        """The SP5 D12 override: the stateful versions only, so the client falls back to `initialize`."""
        return {
            "cacheScope": "private",
            "capabilities": {"tools": {"listChanged": False}},
            "resultType": "complete",
            "supportedVersions": list(SUPPORTED_VERSIONS),
            "ttlMs": 0,
            "_meta": {"io.modelcontextprotocol/serverInfo": SERVER_INFO},
        }

    async def _initialize(self, send: Send, principal: Any, rid: Any, params: dict[str, Any]) -> None:
        wanted = params.get("protocolVersion")
        if not isinstance(wanted, str):
            await _send_json(send, 200, _rpc_error(rid, INVALID_PARAMS, "protocolVersion is required."))
            return
        version = wanted if wanted in SUPPORTED_VERSIONS else SUPPORTED_VERSIONS[0]
        session_id = uuid.uuid4().hex  # 32 hex characters: the `<sid8>` of a name-mode handle comes from it
        self._sessions.create(session_id, principal.key_id, principal.card_id)
        result = {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
        }
        await _send_json(send, 200, _rpc_result(rid, result), {"Mcp-Session-Id": session_id})

    # -- tools/call ----------------------------------------------------------------------

    def _cancel(self, session: McpSession, request_id: Any) -> None:
        if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
            return
        task = self._inflight.get((session.session_id, request_id))
        if task is not None:
            task.cancel()

    async def _tools_call(
        self, receive: Receive, send: Send, principal: Any, session: McpSession, rid: Any, params: dict[str, Any]
    ) -> None:
        name = params.get("name")
        if not isinstance(name, str) or not self._tools.known(name):
            # An unknown tool, and a write tool while writes are off, are the same answer.
            await _send_json(send, 200, _rpc_error(rid, INVALID_PARAMS, "Unknown tool."))
            return
        meta = params.get("_meta")
        ctx = CallContext(principal, session, meta if isinstance(meta, dict) else {})
        key = (session.session_id, rid)
        call = asyncio.ensure_future(self._tools.call(name, params.get("arguments"), ctx))
        self._inflight[key] = call
        gone = asyncio.ensure_future(_until_disconnect(receive))
        try:
            await asyncio.wait({call, gone}, return_when=asyncio.FIRST_COMPLETED)
            if call.done():
                try:
                    result = call.result()
                except asyncio.CancelledError:
                    await _send_json(send, 200, _rpc_error(rid, REQUEST_CANCELLED, "Request cancelled."))
                    return
                await _send_json(send, 200, _rpc_result(rid, result))
            else:
                # The client went away while the tool was running.
                call.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await call
        finally:
            self._inflight.pop(key, None)
            if not call.done():  # this handler was itself cancelled (shutdown)
                call.cancel()
            gone.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await gone
