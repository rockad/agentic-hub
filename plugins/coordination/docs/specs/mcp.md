# `/mcp` facade as built (S1-MCP)

Status 2026-11-16: built on branch `feat/coordination-mcp`, from `main` plus S1-AUTH (PR #65) and S1-STATE (PR #67); not on `main` until the user merges it. Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 3.4, 4 (4.1 to 4.10), 5.4 and 5.4.1; plan section S1-MCP; decisions D5, D6, D10, D30, Z15.

Labels: **spec** is written in `server-api.md`. **[design]** is a choice made where the spec is silent or contradicts itself; any of it can change without reopening a decision. **[verified]** was run and read in this stream's tests. **[unverified]** was not run.

## 1. What is in the code

- `coordination/mcp/server.py`: the streamable-HTTP transport, one ASGI app (`McpEndpoint`).
- `coordination/mcp/tools.py`: the nine-tool catalogue and the handlers. Every handler is one call into the S1-STATE `CoordinationService` plus the framing of its result. No task logic is here.
- `coordination/mcp/frame.py`: the untrusted-data frame of spec 4.1 (`UNTRUSTED_NOTICE`, per-part and per-result caps, part rules).
- `coordination/mcp/sanitize.py`: escape-sequence and control-character stripping, UTF-8 truncation.
- `coordination/mcp/sessions.py`: `McpSessions` (the `Mcp-Session-Id` map) and `SessionRegistry` (the `sessions` table, as far as MCP needs it).
- `coordination/mcp/schema.py`: the argument checker for the tool schemas.
- `coordination/app.py`: `create_app(..., mcp=endpoint)` adds `Route("/mcp", ...)` behind the shared redaction and access-control middleware; `build_server_app` builds the endpoint.

No table and no migration changed. Migration numbers m0003 and m0004 are still unused, m0005 is not taken.

## 2. Transport (spec 3.4, SP5 D12)

- **Hand-written, no `mcp` SDK in the runtime image.** Spec 3.4 names the SDK as [design, unverified]. The SDK was left out because each defect the SP5 D12 spike found is a line of this file instead of a patch: the key check on `Mcp-Session-Id`, the `server/discover` era, and no private attribute (`_lowlevel_server`) to depend on. The official `mcp` 2.3.0 is a dev dependency only, used as a test client.
- Mounted as a `Route("/mcp", endpoint)` in the main Starlette app, not a `Mount` (SP5 D12: `Mount("/mcp")` answered 307 then 404). There is no lifespan and no session-manager task. It is "the second ASGI app" of SP5 D12 in the sense that `McpEndpoint` is its own ASGI callable; it shares the process and the middleware, which the spike showed works.
- Wire shape: the one the S0 stub served to Claude Code 2.1.319 and agy 1.5.3 (reported by the SP2 results, not re-run here).
  - `POST`: one JSON-RPC message, answered with `application/json` (no SSE). A notification or a response gets `202`. A batch is `400`.
  - `GET`: `405`, `Allow: POST, DELETE` (no server-initiated stream).
  - `DELETE`: ends the session (`200`).
  - No `Mcp-Session-Id` on a message other than `initialize` and `server/discover`: `400`. Unknown or expired session: `404` (the client re-initialises and re-sends). Another key's session id: `403`.
- `server/discover` answers with `supportedVersions: ["2025-11-25", "2025-06-18", "2025-03-26"]` only, in the result shape the SDK's override had in SP5 D12, so a discover-first client falls back to `initialize`. [verified] with the official client in auto mode, which sent `server/discover` and then `initialize` against the running app (`tests/test_mcp_e2e.py`).
- `initialize` negotiates the requested version when it is one of those three, else the newest. It issues a 32-hex `Mcp-Session-Id`. [design] `serverInfo` is `{"name": "a2a-coordination", "version": <package version>}`; no `instructions`.
- The endpoint fails closed: no principal on the request scope is `401`, a principal that is not `local-harness` with a card is `403`. A `remote-peer` or `status-client` key never reaches it: the middleware answers `403` first (S1-AUTH scope matrix, unchanged).
- A running tool call is cancelled when the client disconnects, when the handler is cancelled (shutdown), or on `notifications/cancelled` for its request id in the same session. A cancelled request answers `-32800`.
- [design] Idle sessions expire after `A2A_SESSION_IDLE_TTL_H` and the map holds at most 4096; the oldest-idle goes first. The client then gets `404` and the normal "Not bound" recovery.
- [design] `MCP-Protocol-Version` on later requests is not checked; `Accept` is not enforced.

## 3. Identity (spec 5.4, 5.4.1)

Per call, in this order (`McpTools._handle`):

- **agy** (a `local-harness` key whose card is `antigravity@...`): `params._meta["antigravity.google/conversation_id"]`, mapped through the durable `sessions` table with the conversation id stored as `harness_session_id`, matched only within the key's own card. `Mcp-Session-Id` is never agy identity. [verified] by tests: a registered conversation works with no `a2a_hello` after a server restart; one `Mcp-Session-Id` shared by two conversations gives two handles that do not merge; a conversation id registered under another card is never matched.
  - Unseen conversation (D30): registered on its first call, handle `antigravity@<machine>/<c8>~<c8>` with `<c8>` the first 8 hex characters of the conversation id (a SHA-256 prefix when the id is not hex), one `session_registered` audit row with `via` `auto_agy`. The unnamed form is decided (Z17, reading B, `<sid8>~<sid8>`): one handle form and one `HANDLE_RE`.
  - Sub-invocation (`root_conversation_id` differs from `conversation_id`): grouped under the root's handle, and if the root is unknown the root is registered, not the subagent. `parent_conversation_id` was not recorded by S1-MCP (no place to put it without a table change); S1-ID has since added the table and records it ([identity.md](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/identity.md) section 4).
  - A conversation id that is not `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}` is no identity at all.
  - `_meta` is read only for a `local-harness` key of an `antigravity@` card. A Claude key sending the same `_meta` is not bound by it [verified].
  - `a2a_hello` for agy is a confirmation: it returns the conversation's handle and ignores the `handle` and `name` arguments (a model cannot move a conversation to another handle). Without a conversation id it is the error `no_conversation_id` [design].
  - An ended agy session is revived by the call (Z17; S1-MCP refused it with `session_ended`): the same handle comes back, `ended_at` is cleared, the orphaned tasks addressed to it are offered again, and one `session_registered` audit row (`via` `auto_agy`, `revived` true) is written. A call of one of its subagents revives the root the same way [verified].
- **Every other client** (Claude Code): the handle `a2a_hello` bound to its `Mcp-Session-Id`, kept in `McpSessions` as `(key_id, handle)`.
  - `a2a_hello(handle)`: the handle must exist (`unknown_handle`) and belong to the key's card (`wrong_card`). An ended handle is revived and bound (Z17; it was `session_ended`), with a `session_registered` row (`via` `hello`, `revived` true) [verified].
  - Rebind (Z17): if another live `Mcp-Session-Id` of the same card is bound to the handle, this call takes the binding and the older one is dropped: its next identity-bound call returns the constant `Not bound. Call a2a_hello.` One `session_rebound` audit row per binding dropped, with the first 8 characters of the two `Mcp-Session-Id` values. `CallContext.bindings` is the `McpSessions` map, `McpSessions.unbind_others` does the move [verified].
  - A call of any other tool by a session bound to a handle that has since ended (or the `handle` argument fallback naming an ended handle) is still `session_ended` [design]; `a2a_hello(handle)` brings it back.
  - `a2a_hello(name)`: registers a session whose `harness_session_id` is the `Mcp-Session-Id`, so `<sid8>` is its first 8 hex characters; the name goes through the spec 3.5 derivation (lower-case, `[a-z0-9._-]`, 39 characters, must start with `[a-z0-9]`). A name that reduces to nothing becomes the `<sid8>` itself [design]. Idempotent on the same `Mcp-Session-Id`. One `session_registered` audit row (`via` `hello`, `revived` false).
  - After a server restart the map is empty: a call with the old session id is `404`; after the client re-initialises, an identity-bound tool returns the constant `Not bound. Call a2a_hello.` [verified]. A resume gets a new `Mcp-Session-Id` and binds the same handle again [verified].
- **Fallback** (spec 3.4): every identity-bound tool takes an optional `handle`, used only when nothing else identifies the caller and only for a live session of the calling key's card. It is not remembered.
- Every identity-bound call refreshes the session's `last_seen_at`, at most once per 30 s per handle [design].

The constant error: the tool result has `isError: true`, its text is exactly `Not bound. Call a2a_hello.`, and `structuredContent` is `{"error": "not_bound", "message": ...}`.

## 4. Tools (spec section 4)

The set is closed: six always, three with `A2A_ALLOW_WRITES=1`. With writes off a write tool is not listed and a `tools/call` for it is the JSON-RPC error `-32602 Unknown tool.`, the same answer as for any other unknown name. Annotations: reads `readOnlyHint: true`; writes `readOnlyHint: false, destructiveHint: false`; `a2a_hello` `readOnlyHint: false, destructiveHint: false, idempotentHint: true`; all `openWorldHint: false`. Arguments are checked against the published schema (`additionalProperties: false`); a failed check is a tool error `invalid_params: <argument> ...` that never repeats the value.

Results: `structuredContent` and one JSON text block of the same object. A failure is `isError: true` with `<code>: <message>`; a service error keeps its constant `code` (`task_not_found`, `invalid_transition`, `already_claimed`, `forbidden`, `session_ended`, ...). An unexpected exception is `internal_error` with no detail.

| tool | as built |
| --- | --- |
| `a2a_hello` | spec 4.2. Output as spec. `pending` is `pending_count`; `held_for_review` is the count of held tasks of the card. |
| `a2a_inbox` | spec 4.3, framed. Lists through `service.inbox`, so each listed task records an offer and a queued card task is claimed. Held tasks are counted only: `held_for_review` plus a constant `held_hint` when it is above 0. |
| `a2a_get` | spec 4.4, framed, with artifacts. `history_length` default 20. [design] The frame has `tasks` with one entry, so every framed result parses the same way. |
| `a2a_wait` | spec 4.5. See section 6. |
| `a2a_peers` | spec 4.6, not framed: handle names built by the server and liveness. Ended sessions are not listed, nor is the caller's own handle (it is in `self`) [design]. `listening` comes from the `ListenerView` (none until WAKE). |
| `a2a_runs` | spec 4.7, framed, `runs` always empty. The `status_runs` table belongs to LT-SRV and does not exist, so it is empty with the status client on or off. |
| `a2a_send` | spec 4.8. `to` is a handle or a card id; the sender is the bound handle; `data` at most 16 KiB serialised; `text` at most 32 KiB in bytes. Output: `task_id`, `context_id`, `state`, `delivery`, `recipient_listening`. A follow-up is `task_id` plus `context_id`. A send to the caller's own handle is refused by the service as `invalid_params`. |
| `a2a_respond` | spec 4.9 through `service.respond`: `working` on `SUBMITTED` confirms, any other state confirms and moves, `canceled` and `auth_required` are not in the enum, a session the task is not bound to is `forbidden`, the loser of a claim race is `already_claimed`. Output: `task_id`, `context_id`, `state`, `delivery`. |
| `a2a_cancel` | spec 4.10 through `service.cancel_task`; output is the framed task (so the sender sees what the other side wrote). |

## 5. The result frame (spec 4.1)

- `untrusted: true` and `notice` (the constant `UNTRUSTED_NOTICE`) on every result that carries peer text. A test reads the notice out of `server-api.md` 4.1 and compares it with the constant, so the two cannot drift.
- `origin` is server-derived: each task has `origin: {"kind": "local" | "remote" | "import", "from": <coord.from>, "verified_by_server": true}` from the `coord` block the service stamped at creation (it drops every client `coord.*`). [design] The top-level `origin` is that value when every task shares it, `{"kind": "mixed"}` when they differ and `{"kind": "none"}` when there is no task: the spec shows one top-level origin and a result can hold tasks from several senders.
- Stripped: terminal escape sequences whole (CSI, OSC, DCS, PM, APC, SOS, other ESC sequences, the 8-bit C1 forms), C0 controls except line feed and tab, DEL, C1, bare carriage returns. [design] Also the bidirectional override and isolate characters (U+202A to U+202E, U+2066 to U+2069). Applied to message text, data strings and keys, artifact names, file names and URL strings.
- Caps: 32 KiB per part (UTF-8 bytes, after stripping), 64 KiB per result measured on the rendered JSON text. A cut part has `truncated: true`; the result has `truncated: true`; if whole tasks had to be dropped, `omitted_tasks` says how many.
- Inlined: `text/plain` (or no media type) text parts and `application/json` (or none) data parts. A raw part, any other media type and a data part over 32 KiB are `{"type", "omitted": true, "media_type", "size"}`. A URL part is its string, never fetched.
- [verified] by `tests/test_mcp_frame.py` (no database) and, on the wire against Postgres, `tests/test_mcp_tools.py::test_result_frame_on_the_wire_strips_truncates_and_flags`: a body with ANSI and OSC sequences, text that claims approval, and a 100 KiB part comes back stripped, truncated, flagged, inside `untrusted: true`, under 64 KiB, with the notice byte-identical.

## 6. `a2a_wait`, `a2a_send` waits and the cap (Z15)

- `A2A_MAX_WAIT_S` (default 50, decision Z15 of 2026-11-15; the old 240 is gone from the code and the schemas) caps both `a2a_wait.timeout_seconds` and `a2a_send.wait_seconds`. A larger request is capped to it, not refused; below the minimum is `invalid_params`. The advertised `maximum` in `tools/list` is the configured value. `a2a_wait` defaults to 30 s (or the cap if that is lower).
- Inside the recorded limits (SP2 C8 and A7, [verified] there): Claude Code 60 s per call by default, agy 180 s. 30 s and 50 s are both under 60 s. A test pins the default numbers.
- [design] The wait polls the database once a second (`WAIT_POLL_S`) through `has_wake_pending`, `inbox` and `get_task`. There is no change notifier yet (service-layer.md section 4); polling sees changes from every writer (the A2A binding, the admin socket, the TTL sweep) without each of them signalling. WAKE may add a notifier and replace the poll.
- `a2a_wait` returns the inbox shape when something is wakeable (a new task, a re-offer that is due, an unread follow-up) and records the offer, or when a watched task (`task_ids`) changed state, or was already finished when the wait began. Otherwise `{"timed_out": true}`. [design] At most 20 watched ids.
- `a2a_send` with `wait_seconds` waits for a terminal or interrupted state (`INPUT_REQUIRED`, `AUTH_REQUIRED`) and returns the latest state.
- Tests run the waits in virtual time (a hand-moved clock and a `sleep` that advances it), so a 50 s cap is exact and fast. [verified] The wait sums to exactly 50 s for a request of 240 and to 30 s by default.
- "Marks the most recent wake confirmed" (spec 4.3 and 4.5, 7.5): done by S1-WAKE (`McpTools` takes a `confirm` callable; [wake.md](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/wake.md) section 4).

## 7. Wiring in `app.py`

- `create_app(..., mcp=endpoint)`: the route is added only when an endpoint is passed, so a bare `create_app` serves what it always did.
- `build_server_app` now builds the SQL audit log (`SqlAuditStore`) and the `CoordinationService`, passes the audit log to the middleware and the service, and mounts `/mcp`. This is the audit wiring S1-AUTH listed as not done (auth failures are now sampled into `audit`); it is minimal wiring in a file this stream may change.
- `app.state.mcp` is the endpoint, so S1-ADMIN can call `app.state.mcp.sessions.drop_key(key_id)` when it revokes a key. Not wired here: a revoked key is refused by the middleware on its next request in any case.
- Not started here: the service's TTL sweep (`run_forever`) and the audit auth-failure flush timer. The sweep is started by the app lifespan since Z18 (identity.md section 6); the flush timer is still not started by any stream.

## 8. Not built here (handed on)

- S1-ID: `POST /sessions`, `GET /sessions`, `POST /sessions/end`; aliases for a later `SessionStart` name; `parent_conversation_id` provenance; the decision on the unnamed form; whether a resumed ended session revives. `SessionRegistry` registers and finds sessions only as far as the MCP acceptance needs. **Done by S1-ID (2026-11-18)**: see [identity.md](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/identity.md). The registry moved to `coordination/identity/registry.py` and `coordination.mcp.sessions` re-exports it; `a2a_hello` in `name` mode and the agy binding call `IdentityService`. The two open questions were decided the same day (Z17) and built in a follow-up commit: the unnamed form is `<sid8>~<sid8>`, and a resumed ended session revives (agy path and `a2a_hello` included), with rebind and lifecycle audit events.
- S1-WAKE: the parked-listener table (`ListenerView`; `NoListeners` stands in), the wake confirmation, a change notifier. **Done by S1-WAKE (2026-11-18)**, see [wake.md](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/wake.md) section 7: `build_server_app` passes the real table, `a2a_inbox`, `a2a_wait` and `a2a_hello` confirm the handle's wake, and the task service's existing notifier hook is the wake service. `NoListeners` remains the default for a caller that builds the parts alone.
- S1-ADMIN: calling `drop_key` on revoke.
- LT-SRV: `status_runs`, so `a2a_runs` has data.
- The rate limiter and the handle-guess counter (S3-LIMITS, S2-LISTEN) are unchanged; the tools add no limiter of their own beyond the service layer's.

## 9. Evidence

- `tests/test_mcp_frame.py` (no database): sanitising table and a fuzz of every code point below U+3000, truncation on character boundaries, the frame caps (including a text made of JSON escapes and 400 tasks), part rules, the schema checker, the notice against the spec, the session helpers.
- `tests/test_mcp_transport.py`, `test_mcp_tools.py`, `test_mcp_cancel.py`: the real middleware over the SQL key store, the real service layer and the pinned Postgres image; the scope matrix, sessions, identity for both harnesses, every tool, the cap, cancellation.
- `tests/test_mcp_e2e.py`: a real uvicorn server on a socket serving `build_server_app`, driven by the official `mcp` client: discover-first handshake, a Claude-style and an agy-style client exchanging a task through the real stack, and the scope checks over real HTTP.
- Four mutants were run against the tests and each was caught: no key check on the session id, `_meta` read for any card, no wait cap, and discover advertising the 2026 version.
- **[unverified]** Claude Code and agy themselves were not run against this server (rules: no agy, no helper claude). The wire shape is the stub's, which the SP2 results report worked with both. S1-GATE and the user's live checks cover it.
