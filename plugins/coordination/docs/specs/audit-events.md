# Audit events and observability (S1-OBS)

Status 2026-11-15: merged to `main` (PR #62, `d09799f`). The acceptance split in section 2 was ratified by the user on 2026-11-15 (decision Z6). Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 1.3 (audit rules), 1.5 (`A2A_LOG_LEVEL`), 2.1, 3.6 (`dump_age_h`), 3.7 (`/healthz`); implementation plan section S1-OBS.

Labels: **spec** is written in `server-api.md`. **[design]** is a choice S1-OBS made where the spec is silent; any of it can change without reopening a decision.

## 1. What is in the code

- `coordination/audit/`: the event types, the writer, the storage interface it needs, an in-memory test double and (S1-STATE) `audit/sql.py`, the `audit` table writer with its transaction-joining variant (section 2).
- `coordination/logging/`: JSON-lines logging, credential scrubbing, and the `Authorization` redaction middleware.
- `coordination/app.py`: the middleware, `POST /status` (off unless `A2A_STATUS_ENABLED=1`) and `/healthz`.
- `coordination/backup_status.py`: `status_fields`, the `dump_age_h` field of the `/status` response.

## 2. The audit table, and how a row joins a transaction

S1-STORE owns the `audit` table and the migration. S1-OBS added no table and no migration. S1-STATE (decision Z6, 2026-11-15) added the writer that puts a row on a database transaction, and no table.

- The writer (`AuditLog`) builds validated rows. `AuditStore` in `coordination/audit/protocol.py` is the one-method interface `append_audit(row)`; `coordination.audit.sql.SqlAuditStore` implements it over the `audit` table, in its own transaction, for the events that do not ride on a task write (registration, wake sent, key lifecycle, a guess-counter trip).
- **The transaction-joining variant [design, chosen by S1-STATE]:** `coordination.audit.sql.insert_audit(tx, row)` writes one row on a connection or session the caller already holds, and `SqlAuditStore.append_audit_in(tx, row)` (the `TransactionalAuditStore` protocol) is the same call as a method. It opens and closes no transaction of its own. There is no unit-of-work object and no `AuditLog` bound to a transaction: the writer only builds rows (`AuditLog.state_transition_row`, `hold_entered_row`, `hold_released_row`, `hold_denied_row`, which write nothing), and the store writes them.
- **Who writes a transition's row:** `CoordTaskStore.transition(..., audit=builder)` and `CoordTaskStore.create(..., audit_rows=...)` (`store/task_store.py`). One database transaction holds the version compare-and-swap, the task row, the `task_index` change and the audit rows. If any of them fails, all of them roll back. The service layer (`coordination/service/service.py`) is the only caller that passes rows.
- The creation of a task is a transition from nothing: its row has `from_state` null and is written in the creating transaction. A follow-up message that changes no state writes no `state_transition` row. A transition that also enters or leaves a hold writes a second row in the same transaction (`hold_entered`, `hold_released` or `hold_denied`, actor the human at the admin socket for the last two).

### Acceptance "every state transition has exactly one audit row naming its actor": the split

The plan's S1-OBS acceptance line has two halves.

| half | what it shows | where it is shown | status |
| --- | --- | --- | --- |
| OBS half | `AuditLog.state_transition` makes exactly one append per call, requires and records the actor, refuses unknown states, and lets a failed append reach the caller: no swallow, no buffer, no retry, no stray row | `tests/test_audit.py`: `test_one_state_transition_call_makes_exactly_one_append`, `test_state_transition_names_its_actor_and_is_one_row_each`, `test_failed_transition_append_leaves_no_row_and_is_never_retried_behind_the_caller`, `test_store_failure_propagates` | tested against the in-memory double |
| end-to-end half (S1-STATE, Z6) | the transition and its audit row commit in one transaction, against the real state machine and the Postgres test container: a failed audit insert leaves the task state, version and index unchanged and no row; a normal transition leaves exactly one row naming the actor | `tests/test_audit.py`: `test_transition_and_its_audit_row_commit_together_against_postgres` (replaces the skipped placeholder of the same name), `test_a_forced_audit_insert_failure_rolls_back_state_version_and_index_with_no_row` (a real database error from the INSERT), `test_an_audit_insert_that_raises_anything_leaves_nothing_behind`, `test_a_failed_audit_insert_on_creation_leaves_no_task_version_or_index_row`, `test_sql_audit_store_appends_alone_and_inside_a_transaction`; the audit chain per task is also checked after every step of the random-sequence property test, `tests/test_service_property.py` | tested against Postgres, see the S1-STATE report for the run |

- The end-to-end half is an exit test of S1-STATE (decision Z6, 2026-11-15; see its acceptance list in `master-plan.md`), built on the `audit` table S1-STORE created. It closes a gap in how the acceptance list was assigned, not a defect found in S1-OBS. S1-SEC and S1-GATE depend on it.
- Not covered by this guarantee: events that do not ride on a task write are appended by `SqlAuditStore.append_audit` in their own transaction. A crash between such an event's cause (for example a registration) and its row can lose the row. Those events are not state transitions, and no stream has claimed an atomic guarantee for them.

## 3. Event types

Only `handle_probe_limited` and its two fields are fixed by the spec. The other names, the required fields and the subject are [design].

| event | actor | subject | required detail |
| --- | --- | --- | --- |
| `key_created` | admin caller | key id | `key_id`, `scope` |
| `key_rotated` | admin caller | key id | `key_id`, `new_key_id` |
| `key_revoked` | admin caller | key id | `key_id` |
| `auth_failure_sampled` | `system` | none | `count`, `window_s`, `window_started_at` |
| `registration` | the registering key | handle | `card_id` |
| `wake_sent` | `system` | handle | `pending_n` |
| `hold_entered` | the sending key | task id | `origin` |
| `hold_released` | the releasing human | task id | none |
| `hold_denied` | the denying human | task id | none |
| `state_transition` | who caused it | task id | `task_id`, `from_state`, `to_state` |
| `budget_exhausted` | `system` | handle | `budget_per_h` |
| `handle_probe_limited` (spec) | the limited key | key id | `key_id`, `window_count` (spec) |

State names are the A2A 1.0.1 enum names plus `QUARANTINED`; `TASK_STATE_AUTH_REQUIRED` is refused. `from_state` is `null` for the row that records a task's creation [design].

## 4. What a row may hold

Decisions only, never content (spec 1.3). `events.validate` refuses a row, before it reaches the store, when:

- the actor is empty;
- a detail key is not `lower_snake_case`, or names content: `body`, `message`, `text`, `content`, `parts`, `history`, `artifact`, `secret`, `authorization`, `token`, `password`, `prompt`, `transcript`, `headers`, `credential`, `api_key` (as a word in the key; `key_id` is allowed);
- a detail value is not a string, number, bool or null (no nested objects, lists or bytes);
- any string (actor, subject, detail value) is longer than 256 characters;
- any string looks like a credential: an `a2ak_...` API key, a `Bearer` or `Basic` value, or an `Authorization` header value.

A refused row raises `AuditError`. Nothing is written and nothing is logged with the offending value.

## 5. Auth failures: one row per window

Spec 2.1: "Auth failures are logged in `audit` as a sampled count, not one row per request."

- `AuditLog.auth_failure()` counts a failure. It writes nothing until the window closes.
- The window is 60 s [design, `DEFAULT_AUTH_FAILURE_WINDOW_S`]. The row for a window is written when the next failure arrives after the window closed, or when `flush_auth_failures()` is called.
- The server should call `flush_auth_failures()` on a timer and with `force=True` at shutdown, so the last window of a burst is not left pending. That wiring belongs to the stream that owns the app lifespan; S1-OBS provides the call.
- A burst of 500 failures inside one window produces zero rows during the window and one row (`count: 500`) after it.

## 6. Logging

- `A2A_LOG_LEVEL`: `debug`, `info` (default), `warning`, `error`, `critical`. Case-insensitive, stored lower-case. Any other value (including `trace`, `warn`, empty) stops the server at start with a `ConfigError` that names the variable [design: the spec gives only the default].
- `app.main` calls `configure_logging(level)` once and runs uvicorn with `log_config=None`, so uvicorn's own logs go through the same handler.
- Output is one JSON object per line: `ts`, `level`, `logger`, `msg`, and optional `fields` (pass `extra={"fields": {...}}`) and `exc`.
- Scrubbing (`coordination.logging.redact`): `a2ak_...` keys, `Bearer` and `Basic` values and the value after an `Authorization` name are replaced by `[REDACTED]` in the message, the fields and the traceback. The configured `A2A_KEY_PEPPER` and `A2A_PUSH_ENC_KEY` values are removed by exact match as well.
- Scrubbing is the last line of defence. The server code does not log bodies or keys in the first place.

## 7. The `Authorization` redaction middleware

`AuthorizationRedactionMiddleware` is the outermost user middleware in `create_app`.

- Every `Authorization` header in `scope["headers"]` gets the value `[redacted]`, so a handler, an error page or a debug dump cannot show the key.
- The first header's value is kept as a `Credential` object in `scope["coordination.credential"]`. `repr`, `str` and `format` of a `Credential` are `[REDACTED]`, and it cannot be pickled or copied.
- **Contract for S1-AUTH [design]:** read the credential with `credential_from_scope(scope)`, then `.bearer()` (the token of a `Bearer <token>` value, or `None`) or `.reveal()`. Do not read the `Authorization` header from `scope["headers"]` or `request.headers`: it holds the placeholder. The middleware removes any client-supplied `coordination.credential` key, so a request cannot plant one.

## 8. `/healthz`

`GET /healthz` returns `200` with exactly `{"ok":true}` (spec 3.7). The container healthcheck (`python3 -m coordination.healthcheck`) prints nothing on success or failure, and treats an invalid configuration as unhealthy instead of printing a traceback.

## 9. `dump_age_h` in `/status`

Spec 3.6. `POST /status` is registered only when `A2A_STATUS_ENABLED=1` (default 0, so the route does not exist and answers 404).

- The response carries `dump_age_h`: hours since the last good dump, two decimals, from the `last_ok` file (`A2A_DUMP_LAST_OK_FILE`). `null` before the first successful dump, or when the file is empty, unparsable or has no UTC offset.
- Stale means older than 36 h (`STALE_AFTER_H`). The spec's response has the one numeric field and "nothing else", so there is no separate stale flag in the body: a client compares the number with 36. The server also writes a `warning` log line (`database dump is stale`, with `dump_age_h`) on each `/status` call while the dump is stale. Exactly 36.0 is not stale; `null` is never stale.
- **Not built here:** the status intake (body schema, `status_runs`, `applied`, `run_id` in the acknowledgement) belongs to the later status-client build. S1-OBS reads no body and stores nothing, and the response today is only `{"dump_age_h": ...}`.
- **Fail closed [design]:** the real scope check (`status-client` API key) is S1-AUTH's. Until `create_app(status_authorizer=...)` is given an async callable that approves the request, `/status` answers `401` with `application/problem+json` and `WWW-Authenticate: Bearer`, and never reveals `dump_age_h`. S1-AUTH replaces this hook with its path-table scope check.
- The response carries `Cache-Control: no-store` (spec 2.1).

## 10. Not verified

- The audit writer against the real Postgres `audit` table and "transition and audit row commit together" against the real state machine (section 2, end-to-end half): written in S1-STATE on branch `feat/coordination-state` and run there against the pinned Postgres image; not on `main` until that branch merges.
- The `/status` scope check, because S1-AUTH does not exist yet.
- Behaviour behind the Docker image: the unit tests and one scratch uvicorn run on the workstation were run; the container image was not rebuilt for this stream.
