# Wake endpoint, pending count and budget as built (S1-WAKE)

Status 2026-11-18: built on branch `feat/coordination-wake`, stacked on `feat/coordination-id` (S1-ID), which is stacked on `main` at `503fb93`; not on `main` until the user merges both. Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 7 (7.1 to 7.6), 1.3 (`wakes`), 1.5 (`A2A_WAKE_ROUND_S`, `A2A_WAKE_BUDGET_PER_H`), 3.5 and 5.5; plan section S1-WAKE; decisions D8, R5, R12, BP1 to BP5 and BP7.

Labels: **spec** is written in `server-api.md`. **[design]** is a choice made where the spec is silent or contradicts itself; any of it can change without reopening a decision. **[verified]** was run and read in this stream's tests. **[unverified]** was not run.

## 1. What is in the code

- `coordination/wake/table.py`: `ListenerTable`, one parked `/wake/listen` request per handle, in process memory. It is the `ListenerView` of the task service, the identity service (`GET /sessions`), the MCP tools and the A2A session lister, so one table serves all of them.
- `coordination/wake/service.py`: `WakeService`. Parks a listener, decides a wake, confirms wakes, answers `/wake/pending`. It is also the task service's `Notifier` (`notify_pending(handle)`).
- `coordination/wake/routes.py`: `WakeEndpoint`: `POST /wake/listen`, `GET|POST /wake/pending`.
- `coordination/wake/store.py`: `WakeStore`, the `wakes` table as the budget and the confirmation use it.
- `coordination/wake/rules.py`: the anti-loop rule, the announce dedupe, the park limiter.
- `coordination/wake/outcomes.py`: `Release`, how a parked request ends. The only body it can carry is the integer of a 200.
- `coordination/wake/build.py`: `build_wake`.
- `coordination/service/service.py`, `types.py`, `protocol.py`, `store/task_store.py`: `CoordinationService.wake_snapshot` (and `wake_pending_set`, `held_count`) and `CoordTaskStore.wakeable_task_ids`, the queries the wake decision needs (section 8).
- `coordination/mcp/`: `a2a_inbox`, `a2a_wait` and `a2a_hello` call the wake confirmation (`build_endpoint(..., confirm=...)`).
- `coordination/app.py`: `create_app(..., wake=...)` adds the routes; `build_server_app` does all the wiring (section 7); `make_server` is the SIGTERM answer.

One migration: `m0004` adds `wakes.set_hash` (nullable `VARCHAR(16)`, the hash of the pending set a wake was for; rows from before it have none and never count toward a stop). No new index: the anti-loop read takes a handle's newest three rows, which `ix_wakes_handle_at` serves. The schema is at version 4 (user decision Z19, Fork 2).

## 2. `POST /wake/listen` (spec 7.1)

Headers: `Authorization` (a `local-harness` key), `X-Coord-Session` (required), `X-Coord-Handle` (optional), `X-Coord-Wait` (optional), `X-Coord-Again` (read for the log only). The spelling is `X-Coord-*` only; the spike's `X-Session`, `X-Wait` and `X-Again` are not accepted [verified: a request with only those is `400`].

Order of checks after the access-control middleware (size, Host, Origin, key, scope):

1. The principal must be a `local-harness` key with a card (else `401` or `403`; the middleware has already done it).
2. Shutdown has begun: `503` with `Retry-After: 5`.
3. `X-Coord-Session` must be a session id (`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`), else `400` `application/problem+json` **[design]**: the table of spec 7.1 has no `400`.
4. `X-Coord-Wait` is a whole number of seconds, at least 1, else `400` **[design]**. It is capped at `A2A_WAKE_ROUND_S`; absent means the cap.
5. The session is looked up under the key's own card: a registered session, or an agy sub-invocation conversation recorded under its root (the lookup is shared with `/wake/pending`, but a listen under a sub-invocation id is `403`, section 13). Unknown: `410` with `X-Coord-Reason: unregistered`. Ended: `410` with `X-Coord-Reason: ended`.
6. `X-Coord-Handle`, if present, must equal the session's handle, else `403` **[design]**.
7. The park limiter: more than 30 parks in 60 s for one handle is `429` with `Retry-After` **[design: the spec names the status and no number]**.
8. The listener parks. An older listener for the same handle is answered `409` with `X-Coord-Reason: superseded` at once.

| status | when, as built | body and headers |
| --- | --- | --- |
| 200 | a wake is due (section 4) | `text/plain`, the pending count, one to four digits, nothing else |
| 408 | the round ended with nothing to deliver; also an over-budget or stopped listener at the round end | empty |
| 409 | a newer listener for this handle parked | empty, `X-Coord-Reason: superseded` |
| 401 | key missing, malformed, unknown, revoked, expired (the middleware) | `WWW-Authenticate: Bearer` |
| 403 | scope (the middleware), a key revoked while parked, a mismatched `X-Coord-Handle`, an agy sub-invocation conversation id (section 13) | empty for the parked case |
| 410 | session ended while parked, or at park; or not registered | empty, `X-Coord-Reason: ended` or `unregistered` |
| 429 | parking faster than the limiter allows | empty, `Retry-After` |
| 503 | SIGTERM or lifespan end, parked or new | empty, `Retry-After: 5` |
| 400 | a missing or malformed header **[design]** | `application/problem+json` |

[verified] One test per row in `tests/test_wake.py` (`test_status_*`).

The 200 body is the pending count: the same figure `/wake/pending` shows, clamped to 1 to 9999. It is never anything else. `Release` refuses to be built with any other body, a static test checks that nothing under `coordination/wake/` reads task text (no `inbox`, `get_task`, `.parts`, MCP frame import), and a test sends 25 hostile task bodies (control and bidi characters, digits in other scripts, a 30 KB body, text that looks like an approval, text that looks like the response itself) and checks every 200 body against `[0-9]{1,4}`, the response headers, the `wakes` and `audit` rows and the log records [verified].

A client that hangs up leaves the table (the handler watches the connection) and is not woken [verified, real sockets, `tests/test_wake_e2e.py`].

## 3. The listener table (spec 7.2)

- One parked request per handle; newest wins (`409 superseded`). The table lives in memory; after a restart clients see `503` or a refused connection and re-park, and task state, which is in the database, is untouched.
- `close_key(key_id)`: answers every listener that key parked with `403`; returns the count.
- `close_session(handle)`: answers that handle's listener with `410 ended`; returns the count.
- `begin_shutdown()`: refuses new listeners and answers every parked one `503` with `Retry-After: 5`.
- `is_listening(handle)` and `newest_listening(card)` are the `ListenerView` the rest of the server reads. A listener that has been answered is not listening, even for the instant before its request handler removes it.
- A parked listener looks again every `RECHECK_S` (20 s) **[design]**: the session must still be live (else `410 ended`; a session ended without the end hook firing is caught here, and the idle expiry fires the hook since Z18), the session's `last_seen_at` is refreshed through the registry's throttled `touch` (so a session with a parked listener never expires by the idle TTL, as identity.md section 6 asks), and a wake that no notification announced is looked for (a re-offer that became due, a queued card task, a wake that just counted as lost).

## 4. The wake decision (spec 7.3, 7.4, 7.5)

`WakeService.try_wake(entry)` answers a parked listener `200` only if every step holds, in this order. It runs when a task arrives (the task service calls `notify_pending`), when a listener parks, and at each look.

1. **A wake is pending (spec 7.4).** `CoordinationService.wake_snapshot(handle)` returns the ids of the tasks that make a wake pending and the pending count. The rule is the one `has_wake_pending` already had: a `SUBMITTED` task bound to the handle that is new, or due for a re-offer under `A2A_REOFFER_MAX`; an unread follow-up on a `WORKING` task; an unclaimed card task that is due, only when this handle is the newest parked listener of its card. Held, orphaned and expired tasks are never wakeable. [verified] by a test that holds `has_wake_pending` and `wake_pending_set` equal through the life of a task (new, offered, due again, past the cap, held, denied, session ended), and by tests for the follow-up and the card queue.
2. **No wake of its own is in flight [design].** The handle's newest `wakes` row, if it is unconfirmed and younger than 120 s, blocks a second `200`. The listener stays parked and is looked at again when that wake would count as lost. Spec 7.5 says an unconfirmed wake counts as lost after 120 s and "the next listener then gets an immediate 200"; this is the same rule read from the other side, and it is what stops the immediate-`exit 2` loop of spec 7.3 from re-waking a session once a second.
3. **Inside the budget (spec 7.3).** The handle's `wakes` rows of the last rolling hour are counted; at `A2A_WAKE_BUDGET_PER_H` the listener stays parked and is answered `408` at the round end. One `budget_exhausted` audit row per exhaustion (not per refused listener); the pending-count path keeps working.
4. **The anti-loop rule (spec 7.4).** After three consecutive wakes of a handle for the same pending set that were not confirmed, wakes for that set stop until the set changes or one hour passes. "Same pending set" is the SHA-256 (first 16 hex characters) of the sorted ids from step 1. The rule has no state of its own: each `wakes` row stores its set's hash, and `anti_loop_blocked` reads the handle's newest three rows. The set is stopped when all three are for this hash, unconfirmed, each under an hour after the one before, and the newest is under an hour old. A row for another set, a confirmed row or an hour's gap ends the run. So a stop survives a restart, like the budget (user decision Z19, Fork 2) [verified].
5. **The wake is recorded, then delivered.** The `wakes` row (handle, time, count; no task content) is written first, then the listener is answered, then `wake_sent` is written to `audit`. A client that dies between the row and the response leaves an unconfirmed wake that counts as lost after 120 s, which is the re-delivery the acceptance asks for. Decisions for one handle are serialised by a per-listener lock, so two tasks arriving together write one row.

Confirmation (spec 7.5): `WakeService.confirm(handle)` marks the handle's unconfirmed wakes of the last 120 s confirmed, and ends the anti-loop streak. It is called by `a2a_inbox`, `a2a_wait` and `a2a_hello` (the MCP tools, after the handle is resolved) and by `/wake/pending` (GET and POST). Other tools (`a2a_peers`, `a2a_get`, and so on) do not confirm [verified]. A confirmation after 120 s confirms nothing [verified]. A wake that is never confirmed is re-delivered to the next listener after 120 s, and the task is offered again to whoever asks (`a2a_inbox`) [verified].

The wake count in the 200 body is `max(pending count, wake set size)`, clamped. Note that the pending count includes tasks already offered that are not due again, so the number can be larger than the number of tasks a `wake` is about. It is the number `/wake/pending` and `a2a_hello` show too.

## 5. `GET|POST /wake/pending` (spec 7.5)

`GET /wake/pending?session=<harness_session_id>[&announce=0|1]` returns `{"pending", "announce", "held_for_review", "listening", "wake_opted_in", "rearm"}` (the last three are AW1, Z23, see section 13). `pending` is `CoordinationService.pending_count` (the number `a2a_hello` shows), no bodies, and no offer is recorded [verified]. The call counts as showing up: it refreshes `last_seen_at` (the session is `active`, spec 5.5) and confirms an in-flight wake. An unregistered or ended session is `410` with `X-Coord-Reason`; a missing or malformed `session` or an `announce` that is not 0 or 1 is `400` **[design]**.

`announce` (spec 7.5): true only when `pending > 0` and the count differs from the last announcement to this handle or ten minutes passed. It is recorded only with `announce=1`; without it (or with `announce=0`) the endpoint is read-only [verified]. **[design]** A count of zero observed with `announce=1` clears the memory, so new work after an empty inbox is announced even if it has the same count as before.

`POST /wake/pending` is the `UserPromptSubmit` HTTP hook (SP1 T11). Only `session_id` is read from the body. The body also holds `prompt`, `cwd` and `transcript_path`; none of them is read, stored or logged [verified: a unique marker in the prompt and the paths never reach a log record]. The answer is `{}` with status 200 unless there is something to announce, and then:

```json
{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "[a2a] 2 pending. Call a2a_inbox."}}
```

The string is a server constant with one integer in it, clamped to 1 to 9999. An unknown, ended or another card's session answers `{}` with 200 so a prompt is never held up by the registration race **[design]**; a body that is not a JSON object, or has no valid `session_id`, is `400` (a client bug). The POST form always behaves as `announce=1`.

The hook body is subject to `A2A_MAX_BODY_BYTES` (65536): a prompt longer than that makes the middleware answer `413`, which the harness shows as a non-blocking hook error, and the prompt proceeds (SP1 T11: fail open). **[unverified]** against a live Claude Code; this stream did not run one (rules).

## 6. Shutdown (SIGTERM)

uvicorn runs the lifespan shutdown only after every open request has finished, and a parked request lasts up to 900 s, so by default the listeners would be cut at the graceful-shutdown timeout. `app.make_server` returns a uvicorn `Server` whose `handle_exit` first schedules `table.begin_shutdown()` on the event loop (thread-safe, and it wakes the loop), then runs uvicorn's own handler. Parked listeners are answered `503` with `Retry-After: 5`, new ones are refused the same way, and uvicorn then finishes its graceful shutdown. The app's lifespan also calls `begin_shutdown()` as it stops, so every other way the app ends (a test, a programmatic stop) does the same [verified].

[verified] on a real process: `python -m coordination` against the test Postgres, a session registered through the real route, a listener parked, SIGTERM sent: the listener got `503`, `Retry-After: 5`, an empty body, in under 5 s, and the process ended (uvicorn re-raises the signal it captured after its graceful shutdown, so the exit status is "killed by SIGTERM", as it was before this stream; `tests/test_wake_e2e.py`).

## 7. The hand-overs, done

| hand-over | where it came from | done as |
| --- | --- | --- |
| key revoke closes parked listeners with `403` | admin.md section 6 | `admin.hooks.register("wake", table.close_key)` in `build_server_app` [verified: through the real `key.revoke` command in-process, and over the real admin socket with `a2a-coord key revoke` against a running server] |
| `status` shows parked listeners | admin.md section 7 | `build_admin(..., listener_count=table.count)`; `listeners.parked` is a number, no longer `null` [verified over the socket]. The `budgets` part was already real and now has rows |
| session end closes a parked listener with `410` | identity.md section 6 | `identity.end_hooks.register("wake", table.close_session)` [verified through `POST /sessions/end`, which answers `listeners_closed: 1`] |
| replace MCP's `NoListeners` stand-in | mcp.md section 8 | `build_server_app` passes the table to the task service, the identity service, `build_endpoint` and `build_a2a`. `NoListeners` stays as the default for a caller that builds those parts alone (tests) [verified: `GET /sessions` and `a2a_peers` show `listening`, `a2a_send` says `recipient_listening: true`] |
| the wake confirmation | mcp.md section 6 ("Not done") | `build_endpoint(..., confirm=wake.confirm)` |
| a change notifier | mcp.md and service-layer.md | the task service already calls `Notifier.notify_pending` after every new or re-offered task, a follow-up, a release and a requeue; `WakeService` is that notifier. `a2a_wait` still polls once a second (its own loop is unchanged) |

Two small changes to S1-STATE's code, both in `service/service.py` and both [design]:

- `_new_task` builds the task's view before it tells the wake machinery. Before, `recipientListening` was computed after the wake had taken the listener out of the table, so a send that woke its recipient said `false`. Now it says whether the recipient was parked when the task arrived [verified through `a2a_send`].
- `wake_snapshot`, `wake_pending_set` and `held_count` are new, next to `has_wake_pending`, which is unchanged (section 8).

## 8. What the service layer and the store gained

- `CoordinationService.wake_snapshot(handle) -> WakeSnapshot(ids, pending)`: 3 queries when nothing is wakeable, 4 when something is (the session, the counts, the `WORKING` tasks for unread follow-ups, and the ids only when the counts say something is wakeable). Before it was combined the decision made 8 queries before it answered the listener (the pending set and the pending count each read the session, the counts and the `WORKING` tasks); it makes 6 now (the 4 of the snapshot, the recent wakes, the wake row), and one more for the audit row after the answer.
- `CoordinationService.wake_pending_set(handle)`: the ids of the snapshot.
- `CoordinationService.held_count(card)`: the `held_for_review` number, without loading the tasks.
- `CoordTaskStore.wakeable_task_ids(...)`: the ids query, with the same conditions as `count_pending`'s wakeable counts. Capped at 1000.
- `TaskService` (the protocol) lists the three new methods; `ServiceLayer` (what the wake needs, `pending_count`) is unchanged.

## 9. Numbers, and what they were measured on

Measured on the development workstation, the pinned Postgres container, a real uvicorn server in a thread of the test process, real sockets, 200 listeners parked (`tests/test_wake_e2e.py::test_200_parked_listeners_wake_latency_p99_is_under_500_ms`, run with `-s`). Wake latency is measured from the moment the wake machinery is told about a task (`notify_pending` is entered) to the moment the client has its `200`; send-to-200 includes creating the task.

| load | wake p50 | wake p99 | wake max | send-to-200 p99 |
| --- | --- | --- | --- | --- |
| 200 wakes at 100 per second, 200 listeners parked, five agents sending, reading and answering tasks meanwhile (about 1,800 service calls) | 43.8 ms | 70.1 ms | 119.1 ms | 144.8 ms |
| a burst: all 200 listeners woken in the same instant (a stress figure, not a gate) | 1,414 ms | 2,367 ms | 2,461 ms | 3,552 ms |

- The gate is p99 under 500 ms (SP5 D2: "200 parked listeners, wake p99 under 500 ms") and it is asserted on the second row, for both the wake figure and the send-to-200 figure. SP5 D2 ran at about 3.3 tasks per second (1,986 tasks in 10 minutes), so the gated load is about 30 times that rate. SP5b measured a server-side p99 of 2.8 ms with its own wake path; that path had no database work per wake, this one writes a `wakes` row and an audit row and reads the task tables, so the figures are not comparable beyond "inside the gate".
- The burst is not a gate because it is not a real event: a task wakes one listener, and a card-addressed task wakes one listener of the card. It is here so the figure is known. Two hundred decisions at once queue behind one database connection pool (SQLAlchemy defaults, 5 and 10 overflow) and one Python thread; the figure is the queue, and the burst finishes inside 30 s (asserted) with every wake row written once [verified].
- Three runs of the gated load gave a wake p99 of 69.3, 70.1 and 114.4 ms and a send-to-200 p99 of 142.4, 144.8 and 180.3 ms; the burst gave a wake p99 of 2.27 to 2.37 s. The table shows the first run. The figures vary with the machine and its load (the third run was the full suite, with Docker busy). The gated figure has a margin of about 4 against the gate.
- Re-run after decision Z19 (Fork 2: one more read of the newest three `wakes` rows per decision), 2026-11-21: gated load wake p99 111.5 ms, send-to-200 p99 166.0 ms; burst wake p99 2.54 s. Inside the gate, in the range of the earlier runs.

## 10. Open [design] choices, with what was built

| question | built (the most conservative reading) |
| --- | --- |
| Does a wake in flight (unconfirmed, under 120 s) block a second `200`? | Yes; the listener stays parked and is looked at again when the wake would count as lost (section 4) |
| Where does anti-loop state live? | In the `wakes` rows (`set_hash`, migration 4), so it survives a restart (section 4; decision Z19) |
| `X-Coord-Handle` that does not match the session | `403`, nothing parked |
| A missing or malformed header, query or hook body | `400` `application/problem+json`; the hook form fails open for an unknown session |
| The park limiter | 30 parks per 60 s per handle, `429` with `Retry-After` |
| The parked listener's look interval | 20 s (`RECHECK_S`), fixed in code, not an environment variable (spec 1.5 is closed) |
| The 200 body's number | the pending count, clamped to 1 to 9999 |
| `announce` after an empty inbox | a zero count clears the memory, so the next non-zero count announces |
| Card mismatch on `X-Coord-Session` | looks like an unregistered session (`410 unregistered`); the lookup is scoped to the key's card, so a key never learns whether another card holds that id |
| Is the TTL sweep started? | Yes since Z18: the app lifespan runs it every 60 s (section 11) |

## 11. Not built here, and handed on

- **BP7 (the `410 unregistered` client retry).** The SP2 C7 result (hooks run in parallel, the first park came before the registration in 5 of 5 sessions) says to keep the 15 s retry. It is the client's: `a2a-listen` (S1-CLAUDE) retries a `410 unregistered` for 15 s and then treats it as final. The server answers `410 unregistered` at once and changed nothing for it.
- **The TTL sweep loop (`service.run_forever`): started by the app lifespan since Z18.** It runs every 60 s and is cancelled first on shutdown. It puts a card task that was routed to a session and not confirmed back in the card queue, rejects expired tasks, and ends sessions idle for `A2A_SESSION_IDLE_TTL_H`. Idle sessions end through `IdentityService.end_idle`, so the end hooks fire and a parked listener of an expired session gets `410` at once instead of at its next look (identity.md section 6).
- **`a2a-coord status` text.** Fixed with Z18: `cli/render.py` no longer prints "(null until S1-WAKE)" next to the parked count (it still prints `null` where no counter is wired).
- **Cross-host wake** is S2-WAKE. The table is single-process (spec 1.1), as is the rate limiter.
- **The `/wake/*` per-key rate limiter** of the middleware (S3-LIMITS) is not built; the park limiter above covers the one case the spec 7.1 table names.
- **A client run.** Claude Code's `asyncRewake` listener and `UserPromptSubmit` hook, and agy's `PreInvocation` hook, were not run against this server (rules: no agy, no helper `claude`). The wire shapes are the ones SP1 recorded. **[unverified]** against both; S1-CLAUDE, S1-AGY and the user's live checks cover it.

## 12. Evidence

- `tests/test_wake_units.py` (no database): `Release` (a 200 body is one to four ASCII digits, nothing else has a body), the response builder, the listener table (newest wins, `close_key`, `close_session`, shutdown, the `ListenerView` answers), the anti-loop rule (three then stop, set change, one hour, confirmation, late confirmation), the announce dedupe, the park limiter, and the static check that the wake package cannot reach task text.
- `tests/test_wake.py`: the real app against the pinned Postgres image, in one event loop. One test per row of the 7.1 status table; the 21st wake in an hour is not a `200` (with the 20 before it really delivered, the budget audit event, and the budget freeing after an hour); the integer-only body under hostile task text; the in-flight rule, redelivery after 120 s and the four confirmation paths; the anti-loop stop, its set-change and one-hour exits and a confirmed wake never tripping it; every wake row carrying its set hash; the stop surviving a restart, and a changed set or a confirmation after a restart ending it; two handles' wakes never counting toward each other's streak; the card queue and the newest-listener rule; a held task never waking and its release waking; an unread follow-up waking; `wake_pending_set` against `has_wake_pending`; `announce`; the hook form and its fail-open answers; the session shown as `listening` in `GET /sessions` and `a2a_peers`; the admin `status` count; a parked listener keeping its session alive; an MCP send waking a parked listener and the woken session reading the body through `a2a_inbox` only.
- `tests/test_wake_e2e.py`: a real server on sockets (the p99 test of section 9, a hung-up client, revocation over the real admin socket) and a real server process (SIGTERM).
- Nine mutants were run against these tests and each was caught: no wake confirmation from `a2a_inbox`; no budget check; no in-flight check; the anti-loop never blocking; the session-end hook not registered; the revoke hook not registered; `listener_count` not passed to `build_admin`; the wake service not given to the task service as its notifier (the first version of the tests missed this one, because the 50 ms look of the test server woke the listener anyway; `test_a_new_task_wakes_the_parked_listener_by_notification_not_by_the_periodic_look` pushes the look out to 60 s and caught it); the SIGTERM handler removed from the server class (the first mutant of this one only changed which branch ran, and the second removed the call).
- Existing tests changed: `tests/test_admin_pg.py` asserted the revoke hooks were `["mcp"]` ("WAKE adds its own"); it now asserts `["mcp", "wake"]`.

## 13. AW1: the opt-in idle wake of Antigravity (decision Z23)

Built on `feat/coordination-agy-idle-wake` (single PR for AW1 to AW4). The `/wake/listen` contract of section 2 is **unchanged**: a `200` body is still one integer, and the status table is the same. What changed is around it.

- **`sessions.wake_opted_in`** (migration `m0005_sessions_wake_opted_in`, nullable `DateTime(timezone=True)`, `store/tables.py` in step with it, checked by `test_schema_at_head_equals_tables_py`). NULL is "never opted in" and is every row from before the step. It is set to the time of the session's **first successful park** of a listener: a `POST /wake/listen` that passed every refusal (`410`, `429`, `403`) and entered the listener table, and whose `X-Coord-Again` is absent or `1`, on an `antigravity@` card only (Claude Code's `a2a-listen` also sends `X-Coord-Again: 1`, and a Claude session never opts in). A later round of the same listener (`X-Coord-Again` of 2 or more) does not set it, so a listener that outlives `a2a_wake_off` cannot undo the switch-off. A failure to write the column is logged and never fails the park.
- **`GET /wake/pending`** adds three booleans: `listening` (a listener of the handle is parked now), `wake_opted_in` (the column is set) and `rearm`. `rearm` is true only with `announce=1`, when the session is opted in, not listening, and the server has not said so inside the announce window (10 minutes, the same `Announcer` and `ANNOUNCE_REPEAT` as the count, keyed `<handle>|rearm`). A parked listener, or no opt-in, clears that memory, so a later lapse is told afresh. Without `announce=1` it is false and records nothing. It is computed only for `GET`: the `POST` form (Claude's `UserPromptSubmit` HTTP hook) is unchanged and never writes a `<handle>|rearm` key.
- **Sub-invocation conversations never arm (Z23 decision 7), enforced by the server.** `WakeService.resolve` reports whether a session id went through the conversation link (`Resolved.linked`). `POST /wake/listen` with a linked id is `403` (`application/problem+json`, no body of the session, nothing parked, no opt-in): a subagent that is told to re-arm cannot park under the root handle or supersede the root's listener. `GET /wake/pending` with a linked id still answers the count, `listening` and `wake_opted_in` of the root, but `rearm` is always false. The prompt text in the skill and `rules/AGENTS.md` stays as the first line; this is the second.
- **MCP `a2a_wake_off`** (always listed, not a write tool, idempotent, like `a2a_hello`): clears `wake_opted_in` for the calling session and returns `{"handle", "wake_opted_in": false, "cleared": <bool>}`. It does not stop a running listener: the session stops its own background command first (skill `a2a-wake`).
- **Tests:** `tests/test_wake_opt_in.py` (first park, Claude listener never opts in, refused park (410 and 429), later round, `a2a_wake_off`, `rearm` window, sub-invocation id is 403 and never re-armed, the `POST` hook records no re-arm key), `tests/test_store_migrations.py`, and the tool lists in `tests/test_mcp_frame.py`, `tests/test_mcp_transport.py` and `tests/test_mcp_e2e.py` (ten tools with writes on, seven with them off).
