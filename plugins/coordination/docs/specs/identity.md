# Identity and binding as built (S1-ID)

Status 2026-11-18: built on branch `feat/coordination-id`, from `main` at `503fb93` (S1-AUTH, S1-STATE, S1-MCP, S1-A2A and S1-ADMIN merged); not on `main` until the user merges it. Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 3.5, 4.2, 5.1 to 5.5; plan section S1-ID; decisions D6, D9, D30 and X1.

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
- **[design, open] The unnamed session.** Spec 3.5 has two readings. Built: reading B, the suffix is always present and the default name is the `<sid8>`, so an unnamed session is `<card>/<sid8>~<sid8>` (for agy, `antigravity@<host>/<c8>~<c8>`). It keeps the decided grammar as the only form, with one regex and no second shape to validate or route. Reading A (`<card>/<sid8>`, no suffix) would need a second regex in `HANDLE_RE`, the routing code and the wake endpoint.
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
- Response `201` (new) or `200` (known): `{"handle", "card", "created", "bind_with": "a2a_hello", "aliases": []}`. `bind_with` is always `a2a_hello` as in the spec; for agy the call confirms and the binding is by conversation id (section 4). `aliases` is an addition **[design]**.
- Idempotent on (card, harness session id) [verified, also for six concurrent registrations of one session: one row, one `registration` audit row]. A repeat refreshes `last_seen_at` at once.
- Two Claude sessions with the same requested name get different handles (different `<sid8>`) and two independent bindings [verified]. `--resume` keeps the session id and so the handle; `/clear` is a new session id and a new handle [verified].
- Errors: `400 invalid_request`, `401`, `403 wrong_card` or `forbidden`, `409 handle_collision`, `409 session_ended` (below). Bodies are `application/problem+json` with an extra member `code`. **[design]** `404` and `409` are additions to the spec's list (`400`, `401`, `403`, `429`); `429` is the rate limiter's (S3-LIMITS), not built.
- One `registration` audit row per new session, actor the key id, subject the handle.

### 3.1 Aliases (spec 5.4.1, D30)

- A later registration (or `a2a_hello` in `name` mode) of an already registered session whose hint derives a name other than the handle's own records that name as an alias. The handle never changes [verified: an agy conversation auto-registered on its first call as `<c8>~<c8>`, then its late `SessionStart` named it `refactor-1`; same handle, alias `refactor-1`, one registration row].
- At most 8 aliases per handle **[design]**; a repeat and the handle's own name add nothing [verified].
- An alias is a second name for display and lookup (`SessionRegistry.by_alias(card, alias)`, `GET /sessions` `aliases`). **[design]** It is not a routing key: several sessions can share a name, so `coord.to` still takes the full handle. Making an alias addressable is not decided.
- A conversation that was grouped under a root as a sub-invocation gets no alias; registering its id returns the root's handle with `created: false` [verified].

### 3.2 Ended sessions and resume

- **[design, open] Does a resumed ended session revive?** The spec disagrees with itself: 5.2 says "if the same harness session resumes, the same handle comes back and the task is offered again", and the S1-MCP build refuses an ended agy session. Built, the conservative default: no revival. A registration of an ended (card, harness session id) is `409 session_ended`, `a2a_hello` and an agy call are refused the same way, and a task addressed to the handle stays orphaned (accepted, offered to nobody, never redirected, spec 5.2) [verified].
- The flip is one constant, `identity.service.REVIVE_ENDED_SESSIONS` (default `False`). With `True` a registration of an ended session clears `ended_at`, refreshes `last_seen_at` and writes a second `registration` audit row [verified with a monkeypatch; the default is also pinned].
- The cost of the default: a session expired by the idle TTL (`A2A_SESSION_IDLE_TTL_H`, default 12 h) and then resumed cannot register again; the user starts a new session. The SessionEnd hook is not reliable (spec 3.5), so an expiry is the common way a session ends.
- An agy `/clear` is a new conversation and a new handle; the old handle stays addressable until it ends [verified].

## 4. The Claude and agy paths

- **Claude.** `SessionStart` calls `POST /sessions` (the hook sends `session_id` as `harness_session_id` and `session_title` as `name_hint`); the model then calls `a2a_hello(handle)`, which binds the `Mcp-Session-Id` to the handle in memory (S1-MCP, unchanged). `a2a_hello(handle)` requires an existing, live handle of the key's own card [verified]. A resume gets a new `Mcp-Session-Id` and binds the same handle again [verified].
  - Spec 3.5 also says `a2a_hello` "refuses a handle that another live registration holds". Not built **[design]**: spec 5.1 and decision D-H accept that sessions sharing a key may assert each other's handles, and refusing a second binding would break a resume (the old `Mcp-Session-Id` is still in the map until its TTL). The card check stands.
- **agy.** `SessionStart` registers the conversation id the same way (`conversationId` as `harness_session_id`). On every `tools/call`, `params._meta["antigravity.google/conversation_id"]` is mapped to the session of the key's card (`IdentityService.resolve_conversation`). `Mcp-Session-Id` is never agy identity [verified: one shared `Mcp-Session-Id` over two conversations gives two handles and separate inboxes].
  - Registered conversation: its handle.
  - Unseen conversation, on a `local-harness` key of an `antigravity@` card only: registered on its first call (D30), one `registration` row.
  - Sub-invocation (`root_conversation_id` differs from `conversation_id`): grouped under the root's handle, with the root registered if it is unseen (the subagent never becomes a top-level handle). Depth does not matter: a subagent of a subagent groups under the root [verified].
  - `parent_conversation_id` is recorded for provenance in `session_conversations` (section 7). First sight wins; a later call with a different parent changes nothing [verified]. A malformed parent id is dropped, not stored [verified].
  - A resumed conversation (same ids in a new process) gets the same handle, and a known sub-invocation id is found from its recorded link [verified].
  - An ended root refuses its subagents too (`session_ended`) [verified].
- The replay of the recorded `_meta` shapes of SP2 A4 (artifacts directory, conversation id, root, parent on subagents, a progress token) is in `tests/test_identity.py::test_agy_replay_of_the_recorded_meta_shapes`. It is built from the shapes in the results file with placeholder ids, not from a captured agy session; no agy was run (rules). **[unverified]** against a live agy.

### 4.1 `_meta` trust (spec 5.4.1)

- `_meta` is read in one place, `McpTools._conversation`, only for a `local-harness` key of an `antigravity@` card, after the middleware's scope check. A Claude key sending the same `_meta` is not bound by it, a `remote-peer` or `status-client` key never reaches `/mcp` (403), and the function returns nothing for any scope but `local-harness` [verified, with a unit test over four principals].
- Every lookup is scoped to the key's card: the same id string under another card is never matched [verified].
- A static test pins that no module outside `identity/` and `mcp/` mentions the agy `_meta` keys.
- The ids are client-supplied assertions of a key holder. Binding is not authentication of a session (spec 5.4.1).

## 5. `GET /sessions`

- `GET /sessions[?handle=][&card=][&include_ended=0|1][&limit=1..200]` returns `{"sessions": [{"handle", "card", "liveness", "registered_at", "last_seen_at", "pending", "aliases"}]}`, newest `last_seen_at` first. `aliases` is an addition **[design]**.
- A `local-harness` key sees every card on the server (spec 3.5: own machines only). `include_ended` defaults to `1` (the spec lists `ended` as a liveness value) and `limit` to 100 **[design]**. A bad parameter is `400`; an unknown handle is an empty list.
- `pending` is `CoordinationService.pending_count` (0 for an ended session).

## 6. `POST /sessions/end` and the hook WAKE registers

- Body: `{"handle": "..."}` or `{"card": "...", "harness_session_id": "..."}`; both forms or neither is `400`. The session must belong to the key's own card (`403 wrong_card` otherwise); an unknown one is `404 unknown_handle`.
- It sets `ended_at` (the row stays), then fires the end hooks, and answers `{"handle", "card", "ended": true, "already_ended": <bool>, "listeners_closed": <n>}`.
- Idempotent: ending an ended session succeeds, keeps the first end time, and fires the hooks again so a listener that raced the first call is not left parked [verified].
- **Hand-over to S1-WAKE.** `/wake/listen` does not exist yet, so nothing here parks or closes a listener. The hook registry is the interface, the same shape as the revoke hooks of `admin/hooks.py`:

  ```python
  app.state.identity.end_hooks.register("wake", table.close_session)
  ```

  `close_session(handle)` answers every parked request of that handle with `410` and returns how many it closed (a plain function or a coroutine function). A hook that raises is logged and does not undo the end. The `listening` liveness state reads the same table through the `ListenerView` port (`build_endpoint(..., listeners=...)`), so WAKE should pass one table to both. [verified] with a stub table: ending closes only that session's parked request with `410`, leaves another session's request parked, a failing hook does not undo the end, and the response counts the closed requests (`tests/test_identity.py`). The real table is WAKE's.
- Not wired here: the service layer's idle expiry (`Directory.end_idle`) marks sessions ended without naming them, so it does not fire these hooks. A session with a parked listener refreshes `last_seen_at`, so this should not occur; if WAKE finds it does, the sweep needs to return the handles.
- Audit: the `audit` module has no event for a session end or an alias, and `audit/` is outside this stream, so the end is written to the application log only (a count, no handle text). See section 9.

## 7. Schema (migration m0003)

- `session_aliases(handle, alias, card_id, created_at)`, primary key (handle, alias), index (card_id, alias).
- `session_conversations(card_id, conversation_id, handle, root_conversation_id, parent_conversation_id, first_seen_at)`, primary key (card_id, conversation_id), index (handle).
- The frozen DDL is in `store/migrations/m0003_session_aliases_conversations.py`, the head schema in `store/tables.py`; the existing test that compares the two covers the new tables [verified]. `sessions` is unchanged. Neither new table holds a message body, a path or a working directory.
- `coord_schema_version` goes to 3. An older server refuses this database (`SchemaTooNew`), as designed.

## 8. Liveness (spec 5.5)

- `listening`: a parked listener exists (the `ListenerView`; `NoListeners` until WAKE). `active`: a call in the last 15 minutes. `registered`: known, not ended. `ended`: `ended_at` is set; it wins over everything [verified for all four, with a hand-moved clock].
- Any authenticated tool call refreshes `last_seen_at` (at most once per 30 s per handle, S1-MCP); a registration refresh is immediate [verified].
- The idle expiry is the service layer's sweep (`A2A_SESSION_IDLE_TTL_H`, S1-STATE) [verified through `service.sweep()`]. The sweep loop is still not started by any stream (see `mcp.md` section 7).
- `a2a/cards.py` (`SessionLister`) still computes the same states by itself; it could call `identity.liveness_state`. Not touched: it is S1-A2A's file.

## 9. Not built here, and handed on

- A `session_ended` audit event and a `via` detail on `registration` (hook, auto-registered, hello): `audit/` is outside this stream. Today an auto-registration and a hook registration look the same in `audit`.
- Routing by alias; a bind code (spec 5.1: not needed); the per-key rate limit on `/sessions` (S3-LIMITS).
- The listener table, the `410` itself and `410` on idle expiry: S1-WAKE.
- The hook scripts that call these routes (`a2a-register`, the agy `SessionStart`): S1-CLAUDE and S1-AGY. The routes are tested over HTTP, not through those scripts.
- Claude Code and agy themselves were not run against this server (rules: no agy, no helper claude). **[unverified]** against both.

## 10. Evidence

- `tests/test_identity_grammar.py` (no database): the handle regex against the spec text, valid and refused handles, name derivation, `sid8`, the session-id check, the four liveness states, the end hooks.
- `tests/test_identity.py`: the real middleware over the SQL key store, the real service layer, the real routes and `/mcp`, the pinned Postgres image. Registration, strict bodies, card and scope checks, equal names, concurrent registration, the collision, resume and `/clear`, the Claude path, aliases, end and the stub listener table, no-revive and the revive switch, listing and filters, the agy replay, provenance, sub-invocations, the `_meta` trust rules, the new tables.
- Five mutants were run against the tests and each was caught: no card check on end, `_meta` read for a non-`local-harness` key, the end hooks not fired, sub-invocations registered as their own sessions, and no card check on register.
