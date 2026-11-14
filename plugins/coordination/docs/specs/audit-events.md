# Audit events and observability (S1-OBS)

Status 2026-11-14: built on branch `feat/coordination-obs`, not merged. Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 1.3 (audit rules), 1.5 (`A2A_LOG_LEVEL`), 2.1, 3.6 (`dump_age_h`), 3.7 (`/healthz`); implementation plan section S1-OBS.

Labels: **spec** is written in `server-api.md`. **[design]** is a choice S1-OBS made where the spec is silent; any of it can change without reopening a decision.

## 1. What is in the code

- `coordination/audit/`: the event types, the writer, the storage interface it needs and an in-memory test double.
- `coordination/logging/`: JSON-lines logging, credential scrubbing, and the `Authorization` redaction middleware.
- `coordination/app.py`: the middleware, `POST /status` (off unless `A2A_STATUS_ENABLED=1`) and `/healthz`.
- `coordination/backup_status.py`: `status_fields`, the `dump_age_h` field of the `/status` response.

## 2. The audit table is not created here

S1-STORE owns the `audit` table and the migration. S1-OBS adds no table and no migration.

- The writer talks to the `AuditStore` protocol in `coordination/audit/protocol.py`: one method, `append_audit(row)`.
- `store/protocol.py` is outside the S1-OBS file scope, so the protocol is declared in the audit package. **Dependency for S1-STORE:** its store (or an adapter) must provide `append_audit`, writing the columns `at`, `actor`, `event`, `subject`, `detail_json` of spec 1.3. `AuditRow.detail_json()` gives the last one.
- **Dependency for S1-STATE:** "exactly one audit row per state transition" holds only if the transition and its row commit together. `append_audit` alone does not give that. A transaction-scoped variant is a decision for S1-STORE and S1-STATE [design]; the writer does not need it.

### Acceptance "every state transition has exactly one audit row naming its actor": the split

The plan's S1-OBS acceptance line has two halves. Only the first can be shown in this stream.

| half | what it shows | where it is shown | status |
| --- | --- | --- | --- |
| OBS half | `AuditLog.state_transition` makes exactly one append per call, requires and records the actor, refuses unknown states, and lets a failed append reach the caller: no swallow, no buffer, no retry, no stray row | `tests/test_audit.py`: `test_one_state_transition_call_makes_exactly_one_append`, `test_state_transition_names_its_actor_and_is_one_row_each`, `test_failed_transition_append_leaves_no_row_and_is_never_retried_behind_the_caller`, `test_store_failure_propagates` | tested against the in-memory double only |
| end-to-end half | the transition and its audit row commit in one transaction, against the real state machine and the Postgres test container: a failed audit insert leaves the task state and version unchanged and no row; a normal transition leaves exactly one row naming the actor | not in this stream: it needs S1-STATE and the `audit` table from S1-STORE | **handed over**, unverified; a skipped placeholder test marks it (`test_transition_and_its_audit_row_commit_together_against_postgres`) |

- The end-to-end half is an exit test of S1-STATE and S1-STORE (see the acceptance lists in `implementation-plan.md`). It is a gap in how the acceptance list was assigned, not a defect found in S1-OBS.
- S1-OBS does not claim the guarantee. What S1-OBS promises is narrower: given a store whose `append_audit` joins the caller's transaction, the writer adds nothing that would break atomicity.
- Open for S1-STORE and S1-STATE [design]: how `append_audit` joins the transaction (a connection or session argument, a unit-of-work object, or an `AuditLog` bound to the current transaction). S1-OBS does not choose.

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

- The audit writer against a real Postgres `audit` table: the table does not exist yet (S1-STORE). Tested against the in-memory double only.
- "Transition and audit row commit together" against the real state machine and Postgres (section 2, end-to-end half): not shown here, handed over to S1-STATE and S1-STORE.
- The `/status` scope check, because S1-AUTH does not exist yet.
- Behaviour behind the Docker image: the unit tests and one scratch uvicorn run on the workstation were run; the container image was not rebuilt for this stream.
