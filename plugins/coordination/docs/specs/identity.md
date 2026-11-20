# Identity and binding as built (S1-ID)

Status 2026-11-18: built on branch `feat/coordination-id`, from `main` at `503fb93` (S1-AUTH, S1-STATE, S1-MCP, S1-A2A and S1-ADMIN merged); not on `main` until the user merges it. The open questions of the first build were decided the same day (Z17, master plan 12.3) and are built in a follow-up commit: revive on resume, rebind on `a2a_hello`, the lifecycle audit events, idle expiry by name, and a live-only `GET /sessions`. Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 3.5, 4.2, 5.1 to 5.5; plan section S1-ID; decisions D6, D9, D30 and X1.

Labels: **spec** is written in `server-api.md`. **[design]** is a choice made where the spec is silent or contradicts itself; any of it can change without reopening a decision. **[verified]** was run and read in this stream's tests. **[unverified]** was not run.

## 1. What is in the code

- `coordination/identity/handles.py`: the handle grammar and the name derivation (`derive_name`, `sid8_of`, `build_handle`, `name_part`), the agy `_meta` key names, and the session-id shape check.
- `coordination/identity/registry.py`: `SessionRegistry`. It is the class S1-MCP built in `mcp/sessions.py`, moved here and extended; `coordination.mcp.sessions` re-exports it. There is one registry, not two.
- `coordination/identity/service.py`: `IdentityService`, the one place that registers, resolves, lists and ends sessions. The HTTP routes and the MCP tools both call it.
- `coordination/identity/routes.py`: `POST /sessions`, `GET /sessions`, `POST /sessions/end` (`SessionsEndpoint`).
- `coordination/identity/liveness.py`: `listening`, `active`, `registered`, `ended` as one function.
- `coordination/identity/hooks.py`: `SessionEndHooks`, the registry S1-WAKE plugs its parked-listener close into (section 6).
- `coordination/identity/errors.py`: constant-coded errors shared by the routes and the tools.
- `coordination/mcp/tools.py`, `server.py`, `__init__.py`: `a2a_hello` (`name` mode) and the agy conversation binding now call `IdentityService`; `build_endpoint` takes an optional `identity`; `McpEndpoint.identity` exposes it.
- `coordination/app.py`: `create_app(..., identity=...)` adds the three routes and keeps the service on `app.state.identity`; `build_server_app` passes the one `/mcp` uses.
- `coordination/store/`: migration m0003, two tables (section 7).

## 2. Handle grammar (spec 5.1, X1)

- `<card-id>/<name>~<sid8>`. The server builds it from the card, the name hint and the harness session id; a model never composes one.
- Session part `^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$`, so the whole part is at most 48 characters. `~` is outside the name charset, so the split is exact. [verified] A test reads the regex out of `server-api.md` 5.1 and compares it with the code.
- Refused by the regex [verified]: no suffix, a `#` separator, uppercase (name or hex), a name over 39 characters, 7 or 9 hex characters, a name that starts with a symbol, an empty name.
- `<sid8>` is the first 8 hex characters of the harness session id, lowercased. An id that is not hex gives the first 8 of its SHA-256, so the regex always holds.
- Name derivation: lower-case, reduce to `[a-z0-9._-]`, strip leading `.`, `_` and `-`, at most 39 characters. **[design]** The spec leaves a hint whose first character is not `[a-z0-9]` open (strip or unnamed); built: strip, and an empty result means unnamed.
- **The unnamed session: decided (Z17), reading B.** The suffix is always present and the default name is the `<sid8>`, so an unnamed session is `<card>/<sid8>~<sid8>` (for agy, `antigravity@<host>/<c8>~<c8>`). It keeps the decided grammar as the only form, with one regex and no second shape to validate or route. Reading A (`<card>/<sid8>`, no suffix) is not built and would have needed a second regex in `HANDLE_RE`, the routing code and the wake endpoint. No code changed for the decision.
- A same-`<sid8>` collision under one card and one name is `409 handle_collision`, never suffixed; the first session keeps its handle [verified]. Note that two sessions that share the first 8 hex characters but have different names do not collide: the names differ, so the handles differ. Only an equal name plus an equal `<sid8>` collides. The placeholder ids `00000000-...` that the spike records use share one `<sid8>`; a test that uses them as real ids would collide.
- A handle is never reused for another harness session, in any state: `sessions.handle` is the primary key and nothing deletes a row [verified].

## 3. `POST /sessions`

Request, strict (an unknown field is `400`; names are listed in the error, values never are):

```json
{"card": "claude-code@<workstation>", "harness_session_id": "<id from the hook>", "name_hint": "optional", "harness_version": "optional"}
```

- The key must be `local-harness` and `card` must equal its card, else `403 wrong_card`. A Claude key cannot register under `antigravity@...`, and the reverse [verified]. The body is checked first (`400`), then the card.
- `harness_session_id` matches `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` (it is stored in a 128-character column); anything else is `400`.
- `harness_version` is accepted (at most 64 characters) and not stored. No working directory, path, process id or hostname is accepted: such a field is `400` and nothing is stored [verified: the `sessions` row has exactly its six columns].
- Response `201` (new) or `200` (known, including a revived session): `{"handle", "card", "created", "bind_with": "a2a_hello", "aliases": []}`. `bind_with` is always `a2a_hello` as in the spec; for agy the call confirms and the binding is by conversation id (section 4). `aliases` is an addition, kept by Z17.
- Idempotent on (card, harness session id) [verified, also for six concurrent registrations of one session: one row, one `session_registered` audit row]. A repeat refreshes `last_seen_at` at once.
- Two Claude sessions with the same requested name get different handles (different `<sid8>`) and two independent bindings [verified]. `--resume` keeps the session id and so the handle; `/clear` is a new session id and a new handle [verified].
- Errors: `400 invalid_request`, `401`, `403 wrong_card` or `forbidden`, `404 unknown_handle` (`/sessions/end` only), `409 handle_collision`. There is no `409 session_ended`: an ended session that registers again is revived (section 3.2) [verified]. Bodies are `application/problem+json` with an extra member `code`. `404` and `409` are additions to the spec's list (`400`, `401`, `403`, `429`), kept by Z17; `429` is the rate limiter's (S3-LIMITS), not built.
- One `session_registered` audit row per new session or revival, actor the key id, subject the handle, detail `card_id`, `via` (`hook` here) and `revived` (section 9.1). The S1-OBS name for this event was `registration`; it was renamed, see section 9.1.

### 3.1 Aliases (spec 5.4.1, D30)

- A later registration (or `a2a_hello` in `name` mode) of an already registered session whose hint derives a name other than the handle's own records that name as an alias. The handle never changes [verified: an agy conversation auto-registered on its first call as `<c8>~<c8>`, then its late `SessionStart` named it `refactor-1`; same handle, alias `refactor-1`, one `session_registered` row].
- At most 8 aliases per handle **[design]**; a repeat and the handle's own name add nothing [verified]. Each alias that is added writes one `alias_added` audit row, and nothing else does [verified].
- An alias is a second name for display and lookup (`SessionRegistry.by_alias(card, alias)`, `GET /sessions` `aliases`). It is not a routing key (decided, Z17): several sessions can share a name, so `coord.to` takes the full handle only.
- A conversation that was grouped under a root as a sub-invocation gets no alias; registering its id returns the root's handle with `created: false` [verified].

### 3.2 Ended sessions and resume

- **A resumed ended session revives (decided, Z17).** Spec 5.2 says "if the same harness session resumes, the same handle comes back and the task is offered again", and that is the only behaviour: the first build's switch `REVIVE_ENDED_SESSIONS` and its `409 session_ended` answer are removed, not defaulted off [verified: a test registers an ended session and reads `200`, never `409`].
- A revived session keeps its handle, has `ended_at` cleared and `last_seen_at` set to now, and the tasks that were addressed to its handle while it was ended (orphaned: accepted, offered to nobody, never redirected, spec 5.2) are offered again: `pending` counts them and the inbox returns them [verified for `POST /sessions`, `a2a_hello(handle)` and the agy path].
- It applies on three routes, all through `IdentityService`, so they cannot drift:
  - `POST /sessions` of an ended (card, harness session id): `200`, `created: false` [verified].
  - `a2a_hello(handle)` of an ended handle of the key's own card: revives and binds [verified]. The card check stands: an ended handle of another card is `wrong_card`.
  - an agy `tools/call` whose conversation (or whose root, for a subagent) has an ended session: the call revives it and proceeds [verified]. S1-MCP refused this with `session_ended`; that is changed.
- A concurrent revive happens once: the registry update succeeds for one caller only, and only that caller writes the `session_registered` row with `revived` true [verified with six concurrent registrations].
- **[design]** Only those three routes revive. A call by an `Mcp-Session-Id` that is bound to a handle which has since ended (for example expired by the idle TTL) and the `handle` argument fallback of the other tools still answer `session_ended`; the model recovers by calling `a2a_hello(handle)`, which revives. Reviving on every authenticated call was not part of Z17.
- This also closes the cost of the first build's default: a session expired by the idle TTL (`A2A_SESSION_IDLE_TTL_H`, default 12 h) and then resumed registers again under its old handle. The SessionEnd hook is not reliable (spec 3.5), so an expiry is the common way a session ends.
- An agy `/clear` is a new conversation and a new handle; the old handle stays addressable until it ends, and revives if that conversation resumes [verified].

## 4. The Claude and agy paths

- **Claude.** `SessionStart` calls `POST /sessions` (the hook sends `session_id` as `harness_session_id` and `session_title` as `name_hint`); the model then calls `a2a_hello(handle)`, which binds the `Mcp-Session-Id` to the handle in memory (S1-MCP, unchanged). `a2a_hello(handle)` requires an existing handle of the key's own card (`unknown_handle`, `wrong_card`); an ended one is revived (section 3.2) [verified]. A resume gets a new `Mcp-Session-Id` and binds the same handle again [verified].
  - **Rebind (decided, Z17).** Spec 3.5 said `a2a_hello` "refuses a handle that another live registration holds"; that sentence is replaced. When `a2a_hello(H)` arrives from `Mcp-Session-Id` M2 while another live M1 of the same card is bound to `H`, then after the card check M2 is bound to `H` and M1's binding is dropped: the newest binding wins. M1's next identity-bound call finds itself unbound and gets the constant "Not bound. Call a2a_hello." error [verified]. This is what a resume needs, since the old `Mcp-Session-Id` stays in the map until its TTL, and it matches spec 5.1 and decision D-H (sessions sharing a key may assert each other's handles). "Same card" means the card of the binding, so a second key of the same card can take the handle too, and a key of another card cannot: it is refused `wrong_card` before any binding moves [verified]. A binding idle past the `Mcp-Session-Id` TTL is not live and is not a rebind. Each binding dropped writes one `session_rebound` row (section 9.1). A repeated `a2a_hello` by the holder moves nothing and writes nothing [verified]. The binding map is in process memory (`McpSessions.unbind_others`), so a restart loses all bindings, as before.
- **agy.** `SessionStart` registers the conversation id the same way (`conversationId` as `harness_session_id`). On every `tools/call`, `params._meta["antigravity.google/conversation_id"]` is mapped to the session of the key's card (`IdentityService.resolve_conversation`). `Mcp-Session-Id` is never agy identity [verified: one shared `Mcp-Session-Id` over two conversations gives two handles and separate inboxes].
  - Registered conversation: its handle.
  - Unseen conversation, on a `local-harness` key of an `antigravity@` card only: registered on its first call (D30), one `session_registered` row with `via` `auto_agy`.
  - Sub-invocation (`root_conversation_id` differs from `conversation_id`): grouped under the root's handle, with the root registered if it is unseen (the subagent never becomes a top-level handle). Depth does not matter: a subagent of a subagent groups under the root [verified].
  - `parent_conversation_id` is recorded for provenance in `session_conversations` (section 7). First sight wins; a later call with a different parent changes nothing [verified]. A malformed parent id is dropped, not stored [verified].
  - A resumed conversation (same ids in a new process) gets the same handle, and a known sub-invocation id is found from its recorded link [verified].
  - An ended root is revived by a call of the root or of any of its subagents (Z17): the same handle comes back, one `session_registered` row with `revived` true, and the subagent is grouped under it as before [verified]. This replaces the first build's `session_ended` refusal.
- The replay of the recorded `_meta` shapes of SP2 A4 (artifacts directory, conversation id, root, parent on subagents, a progress token) is in `tests/test_identity.py::test_agy_replay_of_the_recorded_meta_shapes`. It is built from the shapes in the results file with placeholder ids, not from a captured agy session; no agy was run (rules). **[unverified]** against a live agy.

### 4.1 `_meta` trust (spec 5.4.1)

- `_meta` is read in one place, `McpTools._conversation`, only for a `local-harness` key of an `antigravity@` card, after the middleware's scope check. A Claude key sending the same `_meta` is not bound by it, a `remote-peer` or `status-client` key never reaches `/mcp` (403), and the function returns nothing for any scope but `local-harness` [verified, with a unit test over four principals].
- Every lookup is scoped to the key's card: the same id string under another card is never matched [verified].
- A static test pins that no module outside `identity/` and `mcp/` mentions the agy `_meta` keys.
- The ids are client-supplied assertions of a key holder. Binding is not authentication of a session (spec 5.4.1).

## 5. `GET /sessions`

- `GET /sessions[?handle=][&card=][&include_ended=0|1][&limit=1..200]` returns `{"sessions": [{"handle", "card", "liveness", "registered_at", "last_seen_at", "pending", "aliases"}]}`, newest `last_seen_at` first. `aliases` is an addition **[design]**.
- A `local-harness` key sees every card on the server (spec 3.5: own machines only). `include_ended` defaults to `0`, live sessions only (Z17, changed from the first build's `1`); `include_ended=1` adds the ended ones, with liveness `ended` [verified]. `limit` defaults to 100 **[design]**. A bad parameter is `400`; an unknown handle, or an ended one without `include_ended=1`, is an empty list.
- `pending` is `CoordinationService.pending_count` (0 for an ended session).

## 6. `POST /sessions/end` and the hook WAKE registers

- Body: `{"handle": "..."}` or `{"card": "...", "harness_session_id": "..."}`; both forms or neither is `400`. The session must belong to the key's own card (`403 wrong_card` otherwise); an unknown one is `404 unknown_handle`.
- It sets `ended_at` (the row stays), then fires the end hooks, writes one `session_ended` audit row with `via` `explicit` (only for the call that ended it; a repeat writes none), and answers `{"handle", "card", "ended": true, "already_ended": <bool>, "listeners_closed": <n>}`.
- Idempotent: ending an ended session succeeds, keeps the first end time, and fires the hooks again so a listener that raced the first call is not left parked [verified].
- **Hand-over to S1-WAKE.** `/wake/listen` does not exist yet, so nothing here parks or closes a listener. The hook registry is the interface, the same shape as the revoke hooks of `admin/hooks.py`:

  ```python
  app.state.identity.end_hooks.register("wake", table.close_session)
  ```

  `close_session(handle)` answers every parked request of that handle with `410` and returns how many it closed (a plain function or a coroutine function). A hook that raises is logged and does not undo the end. The `listening` liveness state reads the same table through the `ListenerView` port (`build_endpoint(..., listeners=...)`), so WAKE should pass one table to both. [verified] with a stub table: ending closes only that session's parked request with `410`, leaves another session's request parked, a failing hook does not undo the end, and the response counts the closed requests (`tests/test_identity.py`). The real table is WAKE's. **Done by S1-WAKE (2026-11-18):** `build_server_app` registers `identity.end_hooks.register("wake", table.close_session)` and passes the one table to the identity service and the MCP tools; `POST /sessions/end` now answers `listeners_closed: 1` for a parked listener, which gets `410` with `X-Coord-Reason: ended` (tested through the real route).
- **Idle expiry ends sessions by name (Z17).** `IdentityService.end_idle(last_seen_before)` selects the live sessions idle since that time and ends each one on its own: it sets `ended_at` (only while the session is still idle, so one that called in after the scan is left alone), fires the end hooks for that handle (WAKE answers its parked listener `410`), and writes one `session_ended` row with `via` `idle_ttl` and actor `system`. It returns what it ended, oldest first, and a second call ends nothing and writes nothing [verified]. The registry methods behind it are `SessionRegistry.idle_handles` and `end(handle, idle_before=...)`.
  - **Not started: built (Z18).** The app lifespan starts the sweep loop (`CoordinationService.run_forever`, every 60 s) and stops it first on shutdown, so `end_idle` now runs on a timer in a running server.
  - **Gap, handed on: closed (Z18).** `CoordinationService.sweep` calls `IdentityService.end_idle` when one is bound (`service.bind_idle_ender`, done by `build_server_app` once the identity service exists), so the sweep fires the end hooks and writes the audit row. A service built without the binding (a caller that builds the parts alone, such as most service tests) still uses `Directory.end_idle`, which marks sessions ended in one statement without naming them and so fires no hooks and writes no audit row. [verified] through the real wiring: a parked listener of a session idle past the TTL gets `410` with `X-Coord-Reason: ended` from `service.sweep()`, one `session_ended` row (`via` `idle_ttl`, actor `system`) is written, and a second sweep ends nothing and writes nothing (`tests/test_wake_sweep.py`).
- Audit: the end is written by `AuditLog.session_ended` (section 9.1).

## 7. Schema (migration m0003)

- `session_aliases(handle, alias, card_id, created_at)`, primary key (handle, alias), index (card_id, alias).
- `session_conversations(card_id, conversation_id, handle, root_conversation_id, parent_conversation_id, first_seen_at)`, primary key (card_id, conversation_id), index (handle).
- The frozen DDL is in `store/migrations/m0003_session_aliases_conversations.py`, the head schema in `store/tables.py`; the existing test that compares the two covers the new tables [verified]. `sessions` is unchanged. Neither new table holds a message body, a path or a working directory.
- `coord_schema_version` goes to 3. An older server refuses this database (`SchemaTooNew`), as designed.

## 8. Liveness (spec 5.5)

- `listening`: a parked listener exists (the `ListenerView`; `NoListeners` until WAKE). `active`: a call in the last 15 minutes. `registered`: known, not ended. `ended`: `ended_at` is set; it wins over everything [verified for all four, with a hand-moved clock].
- Any authenticated tool call refreshes `last_seen_at` (at most once per 30 s per handle, S1-MCP); a registration refresh is immediate [verified].
- The idle expiry is the service layer's sweep (`A2A_SESSION_IDLE_TTL_H`, S1-STATE) [verified through `service.sweep()`], and `IdentityService.end_idle`, which also fires the end hooks and writes the audit row (section 6). The app lifespan runs the sweep loop, and the sweep calls `IdentityService.end_idle` (Z18).
- `a2a/cards.py` (`SessionLister`) still computes the same states by itself; it could call `identity.liveness_state`. Not touched: it is S1-A2A's file.

## 9. Audit events and what is not built here

### 9.1 Lifecycle events (Z17)

Written through the S1-OBS writer (`AuditLog`); the full table is in [audit-events.md](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/audit-events.md) section 3. Each is written exactly once per action [verified], and a failed audit write is logged without the value and never undoes the action.

- `session_registered`: `card_id`, `via` (`hook` for `POST /sessions`, `hello` for `a2a_hello` in `name` mode and for the revival by `a2a_hello(handle)`, `auto_agy` for an unseen or ended agy conversation) and `revived` (false for a new session, true for one that came back).
- `session_ended`: `via` `explicit` (`POST /sessions/end`) or `idle_ttl` (`end_idle`, actor `system`).
- `session_rebound`: subject the handle, detail `from_binding` and `to_binding`, the first 8 characters of the two `Mcp-Session-Id` values (the same 8 characters that form `<sid8>` of a `name`-mode handle; the full value is never stored).
- `alias_added`: subject the handle, detail `alias`.
- **Renamed.** The first build wrote `registration` (S1-OBS). It is now `session_registered`: nothing but `IdentityService` wrote it, and no other stream, script or table depends on the old name, so no alias is kept. The tests that named it (`test_audit.py`, `test_obs_app.py`, and the audit assertions of `test_identity.py` and `test_mcp_tools.py`) were updated. A database that already holds `registration` rows keeps them as written; this branch is unmerged, so none exist outside test databases.

### 9.2 Not built

- Routing by alias; a bind code (spec 5.1: not needed); the per-key rate limit on `/sessions` (S3-LIMITS).
- The listener table and the `410` itself: done by S1-WAKE ([wake.md](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/wake.md)). `410` on idle expiry: since Z18 the sweep ends idle sessions by name, so the end hook answers the parked listener `410` at once; the listener's own look (every 20 s) stays as the backstop for an end that fired no hook.
- The hook scripts that call these routes (`a2a-register`, the agy `SessionStart`): S1-CLAUDE and S1-AGY. The routes are tested over HTTP, not through those scripts.
- Claude Code and agy themselves were not run against this server (rules: no agy, no helper claude). **[unverified]** against both.

## 10. Evidence

- `tests/test_identity_grammar.py` (no database): the handle regex against the spec text, valid and refused handles, name derivation, `sid8`, the session-id check, the four liveness states, the end hooks.
- `tests/test_identity.py`: the real middleware over the SQL key store, the real service layer, the real routes and `/mcp`, the pinned Postgres image. Registration, strict bodies, card and scope checks, equal names, concurrent registration, the collision, resume and `/clear`, the Claude path, aliases, end and the stub listener table, revive on resume (three routes, orphaned tasks offered again, concurrent revive), rebind, the lifecycle audit events (each once per action), idle expiry by name, listing and filters (live only by default), the agy replay, provenance, sub-invocations, the `_meta` trust rules, the new tables.
- Five mutants were run against the tests and each was caught: no card check on end, `_meta` read for a non-`local-harness` key, the end hooks not fired, sub-invocations registered as their own sessions, and no card check on register.
