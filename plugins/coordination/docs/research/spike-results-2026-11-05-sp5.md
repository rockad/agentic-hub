# Spike results: SP5, a2a-python on SQLite (2026-11-05)

- Spike: [`spikes.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/spikes.md) section 8 (SP5), steps D1 to D12.
- Run by: a helper Claude Code session on <workstation> (WSL2). No harness session of the user's was involved. No harness config file was touched.
- Run date: 2026-11-05, about 08:20 to 09:50 EET.
- Labels: **verified** (observed by this run), **reported** (a project or doc claim, not reproduced), **unverified** (not tested).
- Scratch code and raw logs (kept, outside every git repo): `~/scratch/a2a-spikes/sp5/` (`spike/` server, `driver/` load and test drivers, `tests/` in-container tests, `logs/` raw output, `Dockerfile`, `pyproject.toml`, `uv.lock`).

## 0. Verdict

- **SP5 passes** (every "must pass" criterion is met), **but only with four named wrappers of ours** on top of the SDK as published. The plain `DatabaseTaskStore` as the spec describes it (decision 4 wording: "WAL, busy_timeout, via `DatabaseTaskStore`") is **not sufficient** on its own.
- The four wrappers:
  - a write engine that begins every write transaction with `BEGIN IMMEDIATE` and has a single connection (`pool_size=1`), plus a separate read engine
  - compare-and-swap task transitions through the SDK `VersionedDatabaseTaskStore` with a version row seeded at task creation (the plain get-modify-save loses updates 100% of the time under a race)
  - a `TaskStore` subclass (`CoordTaskStore`) that writes the task and our `task_index` row in one transaction, and implements index-based visibility and a visibility-aware `ListTasks`
  - a custom `RequestHandler` for parked tasks (the SDK `DefaultRequestHandler` needs an `AgentExecutor`)
- Three new findings that were not in the spike plan and that change S1 work:
  - an `mcp` request with API key B's token but API key A's `Mcp-Session-Id` was **accepted (200)** and ran with A's session binding. Not fixed in the spike; the server must bind `mcp_session_id` to the key and reject a mismatch (section 13, D12, Finding 1).
  - the `mcp` SDK that installs today is **2.3.0**, whose default `server/discover` answer advertises only the sessionless era `2026-07-28`. A discover-first client then gets **no `Mcp-Session-Id`** and the `a2a_hello` binding never works. Fix verified (section 13, D12).
  - a plain `uvicorn` process **does not stop** while `/wake/listen` requests are parked (`docker stop` ends in SIGKILL, exit 137). Fix verified (section 13, D12).
- D2 load caveat: the load deviates from spikes.md D2. There were no steady-state session-register or budget-counter writes (own-table writes were wake and audit rows only); rerun with them before S1 if the budget table is a separate write path.
- Decision 4 consequence is in section 14. Server-api section 10 gaps are in section 15.

## 1. Summary table

| step | criterion | threshold | measured | result |
| --- | --- | --- | --- | --- |
| D1 | pragmas applied on every connection | WAL, busy_timeout, synchronous NORMAL, foreign_keys ON | read back on every connection: `wal`, 5000, 1 (NORMAL), 1 | pass |
| D1 | busy_timeout matters | informational | with `busy_timeout=0`: 1499 of 2000 saves failed `database is locked`; with 5000: 0 | recorded |
| D2 | unhandled `SQLITE_BUSY` in 10 min at 10x | 0 | 0 in three 10-min runs (configs A, B, C) and in three 90-s runs at 100x | pass |
| D2 | p99 write latency | < 200 ms | config C (recommended): `store.save` 20.3 ms, transition 35.0 ms, audit 16.6 ms, wake row 26.0 ms; load deviates from spikes.md D2: no steady-state session-register or budget-counter writes (own-table writes were wake and audit rows only); rerun with them before S1 if the budget table is a separate write path | pass (with load caveat) |
| D2 | event-loop lag | < 100 ms | p99 2.17 ms, max 64 to 71 ms (all three runs) | pass |
| D2 | wake latency p99, 200 parked listeners | < 500 ms | end to end 22.7 ms (A), 27.7 ms (B), 25.9 ms (C); server side p99 2.2 to 2.5 ms | pass |
| D3 | no lost update, or a named cure that passes | 0 lost updates | plain store: 300 of 300 lost, 300 of 300 double takes. Cure: versioned store + `BEGIN IMMEDIATE` write engine (0 and 0), or own CAS (0 and 0) | pass with cure |
| D4 | extension data round-trips; handle lookup plan chosen | round-trip, plan | all 36 checks pass; side table `task_index` chosen | pass |
| D5 | no cross-owner read or cancel | 0 leaks | 20 of 20 checks pass (GetTask, ListTasks, CancelTask, JSON-RPC and REST, two foreign keys) | pass |
| D6 | migrations idempotent, newer-than-code refused, own tables alongside | all three | 21 of 21 checks pass; both newer-than-code cases refuse to start (exit 3) | pass |
| D7 | restored backup passes integrity check, consistent counts | ok, equal counts | `integrity_check` ok; 156 tasks = 156 index rows = count at backup time | pass |
| D8 | no committed task lost after `kill -9` | 0 lost | 3 kills under load: 347 of 347 acked creates, 315 of 315 acked completions, 32 of 32 acked cancels present | pass |
| D9 | filesystem supports WAL shm | record only | `/data` named volume is ext4 on `/dev/sdd`; `/mnt/c` is 9p/drvfs | recorded |
| D10 | Postgres by URL change only | record only | D4, D5, D6 pass by URL change; D2 mix (3 min, not 10) ran with no errors surfaced but transition p99 1031 ms from 22 retried deadlocks, cured by seeding the version row at creation (p99 13.8 ms); our SQLite CAS does not survive (259/300 lost); stress, backup, crash not run. Record only (section 12) | recorded |
| D11 | parked-task handler, visibility wrapper, held task | work as published or thin wrapper named | work with the wrappers named in section 0 | pass |
| D12 | mcp app and a2a app in one process, shared middleware | one process or fallback shown | one process, one Starlette app, one middleware stack; 19 checks pass; 1 recorded check shows a defect (a foreign API key re-using another key's `Mcp-Session-Id` was accepted, 200), not fixed in the spike, so the server must bind session to key; two caveats (discover era, graceful stop) found and fixed | pass (with one open defect to fix in S1) |

## 2. Environment, versions, exact setup

- Host: <workstation>, WSL2, kernel 6.18.54.1-microsoft-standard-WSL2, 16 cores, 16 GB. Docker 29.9.3 rootless (overlayfs). `uv` 0.11.31.
- Server image: `a2a-spike-sp5:latest`, built from `python:3.12-slim` (pulled for this spike), with `sqlite3` CLI added by `apt`. Single uvicorn worker, pure `asyncio` loop and `h11` (no `uvloop`, no `httptools`), so the numbers are pessimistic.
- Versions as run in the container [verified]:
  - Python 3.12.16
  - SQLite library 3.46.1
  - `aiosqlite` 0.22.1
  - SQLAlchemy 2.1.8
  - `a2a-sdk` 1.3.0
  - `mcp` 2.3.0 (and `mcp-types` 2.3.0; the client library uses `httpx2` 2.16.0)
  - `uvicorn` 0.54.0
  - `starlette` 1.10.0
  - `alembic` 1.20.1
  - Postgres 17.11 (alpine) and `asyncpg` 0.32.0 for D10
- Load driver on the host: Python 3.12.13 in the scratch uv venv, `httpx` 0.28.1, talking to the container through the rootless port forward (adds some latency to every number; not measured separately).
- Package extras, read from the SDK `METADATA` [verified]:
  - `http-server` = `sse-starlette`, `starlette`
  - `sqlite` = `sqlalchemy[aiosqlite,asyncio]`
  - `db-cli` = `alembic` (needed for the `a2a-db` command and the migrations)
  - `sql` = SQLAlchemy plus **aiomysql and asyncpg** (too broad for production; it was kept in the scratch project only for D10)
  - Production line to use: `a2a-sdk[http-server,sqlite,db-cli]==1.3.0` (plus `asyncpg` only when Postgres is used). The scratch project resolves `a2a-sdk[db-cli,http-server,sql,sqlite]>=1.3.0`, `mcp>=2.3.0`, `uvicorn>=0.54.0`, locked in `uv.lock`.
- SDK signatures read from the installed source [verified]:
  - `DatabaseTaskStore(engine, create_table=True, table_name='tasks', owner_resolver=resolve_user_scope, core_to_model_conversion=None, model_to_core_conversion=None)`; `save` is `session.merge(...)` (a SELECT then INSERT or UPDATE); `get`, `list`, `delete` filter by `owner`; `list` filters only `context_id`, `status`, `status_timestamp_after`.
  - `VersionedDatabaseTaskStore(engine, create_table, table_name, owner_resolver, ..., event_table_name='task_events', version_table_name='task_versions', max_attempts=5, retry_delay_s=0.02)`; `save(task, *, event, prev, prev_version, context)` does a compare-and-swap on `task_versions` and raises `ConcurrentTaskModificationError`. It relies on `SELECT ... FOR UPDATE`.
  - `RequestHandler` is an ABC with 11 abstract methods; `create_jsonrpc_routes(request_handler, rpc_url, context_builder=None, enable_v0_3_compat=False, shutdown_grace_period=0)`; `create_rest_routes(request_handler, context_builder=None, enable_v0_3_compat=False, path_prefix='', shutdown_grace_period=0)`. The default context builder takes the user from `scope["user"]` (Starlette convention).
  - Migration CLI: `a2a-db --database-url URL upgrade|downgrade|current` (also `DATABASE_URL`). Revisions `6419d2d130f6` (owner, last_updated) then `38ce57e08137` (protocol_version) then `b5e3d1c8a2f7` (task_versions, task_events; head). Version table `a2a_alembic_version`.
- Docker objects created and removed (all prefixed `a2a-spike-`): containers `a2a-spike-sp5` (server), `a2a-spike-sp5-tools` (in-container tests), `a2a-spike-sp5-pg`, short-lived `-restore`, `-mount`, `-boot`; volumes `a2a-spike-sp5-data` (mounted at `/data`), `a2a-spike-sp5-restore`, `a2a-spike-sp5-pgdata`; network `a2a-spike-sp5-net`; image `a2a-spike-sp5:latest`; base images `python:3.12-slim` and `postgres:17-alpine` (pulled by this run).
- Ports: **18125** for the server container, **18127** for the restore and mount probes, **18126** for one host dev process (stopped). Loopback only (`-p 127.0.0.1:...`). **Deviation:** port 18120 was already held by another spike's `stub.py` when this run started (not touched), so SP5 used 18125 to 18127, which the plan allows ("18120 and 18121.. if you need more"). Key: only the throwaway tokens `spike-token` (principal `key-a`), plus `spike-token-b` and `spike-token-c` (principals `key-b`, `key-c`) for the owner and visibility tests. `key-c` is "remote-peer only" (denied `/mcp`, `/wake`, `/sessions`).
- Server layout of the spike (one Starlette app, one process):
  - shared ASGI middleware: Host check, Origin check, bearer auth, scope check
  - `create_jsonrpc_routes` at `/a2a/v1` and `create_rest_routes(path_prefix="/a2a/v1")` on our `ParkedHandler`
  - the official `mcp` app routes (`MCPServer`, stateful) with five fake tools `a2a_hello`, `a2a_send`, `a2a_inbox`, `a2a_respond`, `a2a_wait`
  - `POST /wake/listen` with an in-process listener table
  - our tables via SQLAlchemy Core (`sessions`, `task_index`, `wakes`, `audit`, `coord_schema_version`) with numbered migrations
  - boot order: `DatabaseTaskStore(create_table=True).initialize()`, then `a2a-db upgrade`, then our migrations

## 3. Realistic rate used for D2

- Assumed realistic traffic [assumption, stated as the spec asks]: 5 agents, each creating 4 tasks per minute, so 20 tasks per minute (0.33 per second); each agent also does 6 `ListTasks` and 6 `GetTask` per minute.
- 10x: 200 tasks per minute (3.3 per second), 300 `ListTasks` per minute, 300 `GetTask` per minute, 10% of tasks cancelled by the originator. Observed: 1937 to 1952 tasks created in 603 s.
- Each task is created through one of three paths in rotation (A2A JSON-RPC `SendMessage`, A2A REST `message:send`, MCP `a2a_send`), woken to a random one of 200 parked listeners, taken by `a2a_inbox` (SUBMITTED to WORKING), completed by `a2a_respond` (WORKING to COMPLETED).
- About 23 write transactions per second at 10x (create with index, audit rows, wake rows, two transitions with audit).
- Limits of this load (honest):
  - session-register writes happen only at start (205 registrations); in steady state our own-table writes are wake rows and audit rows
  - the wake budget (20 per hour per handle) is not enforced, the wake rows are only written
  - the load driver runs on the host, in one Python process
  - no streaming or push

## 4. D1: engine setup [verified]

- Engine: `create_async_engine("sqlite+aiosqlite:////data/a2a.db")`. A `connect` event runs `PRAGMA journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON` and reads each value back. Read back on every connection: `{"journal_mode":"wal","synchronous":1,"foreign_keys":1,"busy_timeout":5000}`.
- `BEGIN IMMEDIATE` recipe: in the `connect` event set `dbapi_conn.isolation_level = None`; in a `begin` event run `conn.exec_driver_sql("BEGIN IMMEDIATE")`. It works on the `aiosqlite` adapter.
- Test: 50 concurrent workers, 2000 calls of the **unmodified SDK `DatabaseTaskStore.save`** over 20 task ids, on the named volume (`logs/d1-hazard.log`):

| engine | busy_timeout ms | pool | ok of 2000 | failures | p50 ms | p99 ms | duration s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deferred | 5000 | default (15) | 1989 | 11 `IntegrityError: UNIQUE constraint failed: tasks.id` | 93.8 | 619.8 | 4.97 |
| deferred | 0 | default | 501 | 1499 `database is locked` | 142.9 | 307.5 | 6.11 |
| deferred | 5000 | 1 | 2000 | 0 | 114.4 | 126.8 | 4.60 |
| IMMEDIATE | 5000 | default | 2000 | 0 | 105.8 | 821.4 | 5.64 |
| IMMEDIATE | 5000 | 1 | 2000 | 0 | 123.0 | 144.4 | 5.06 |
| IMMEDIATE | 0 | default | 70 | 1930 `database is locked` | 72.3 | 180.0 | 3.26 |

- Observed behaviour:
  - the classic "read then upgrade to write returns BUSY at once" hazard did **not** appear. Python's `sqlite3` legacy transaction control starts the transaction only at the first INSERT, UPDATE or DELETE, so the SELECT inside `merge` runs outside any transaction.
  - the real hazard is **atomicity, not busy**: the SELECT and the write are not in one isolated transaction, so two concurrent `merge` calls on a new id both INSERT and one dies with `IntegrityError` (11 of 2000 deferred). `BEGIN IMMEDIATE` removes it (0).
  - `busy_timeout` is mandatory (75% failures without it).
  - many connections contending for the write lock behave worse than one: p99 620 to 820 ms with the default pool against 127 to 144 ms with `pool_size=1`. A single write connection is the better queue.
  - single-connection write ceiling on this host: about 430 saves per second (2000 in 4.6 s).
  - `synchronous=NORMAL` in WAL: a process crash loses nothing (D8), but an OS or VM crash can lose the last commits [reported by SQLite docs, not tested here].
- Passing configuration: the four PRAGMAs above on every connection, `BEGIN IMMEDIATE` on the write engine, `pool_size=1, max_overflow=0` on the write engine (mode `queue` in the scratch server), a separate default-pool engine for reads.

## 5. D2: mixed load in one process [verified]

Three 10-minute runs at 10x, 200 parked listeners, all at once, zero `SQLITE_BUSY`:

- **A**: `TXN_MODE=deferred` (one shared engine, spec as written), plain get/save transitions. Log `logs/d2-A.out`, `logs/d2-A-final.json`.
- **B**: `split` (write engine IMMEDIATE with default pool, read engine deferred), own atomic CAS. Log `logs/stress10-split-atomic.out`.
- **C**: `queue` (write engine IMMEDIATE, one connection), `VersionedDatabaseTaskStore` with seeded version rows. This is the recommended configuration. Log `logs/stress10-queue-versioned.out`.

| measure | A deferred/naive | B split/atomic | C queue/versioned |
| --- | --- | --- | --- |
| duration s | 603 | 603 | 603 |
| tasks created | 1937 | 1951 | 1952 |
| `database is locked` / unhandled busy | 0 | 0 | 0 |
| wake latency e2e p50 / p99 / max ms | 8.2 / 22.7 / 72.3 | 8.8 / 27.7 / 90.1 | 9.4 / 25.9 / 98.1 |
| wake latency server side p99 ms | 2.5 | 2.2 | 2.2 |
| event-loop lag p99 / max ms | 2.17 / 70.7 | 2.20 / 69.6 | 2.17 / 64.2 |
| `store.save` p50 / p99 ms | 3.9 / 16.3 | 4.8 / 23.7 | 5.5 / 20.3 |
| transition p50 / p99 ms | 6.4 / 28.0 | 3.5 / 25.3 | 6.7 / 35.0 |
| audit row p99 ms | 13.0 | 36.4 | 16.6 |
| wake row p99 / max ms | 35.1 / 74.0 | 56.3 / 107.6 | 26.0 / 104.0 |
| `SendMessage` JSON-RPC client p50 / p99 ms | 11.3 / 45.5 | 14.2 / 68.4 | 11.9 / 42.5 |
| `message:send` REST client p99 ms | 39.0 | 56.2 | 39.5 |
| `GetTask` client p50 / p99 ms (JSON-RPC) | 6.8 / 17.7 | 6.9 / 16.8 | 7.0 / 17.4 |
| `ListTasks` client p50 / p99 ms (JSON-RPC) | 15.0 / 26.5 | 15.2 / 27.7 | 15.3 / 27.1 |
| `CancelTask` client p99 ms (JSON-RPC / REST) | 65.7 / 114.4 | 65.7 / 74.7 | 93.9 / 89.0 |
| MCP `a2a_inbox` / `a2a_respond` client p99 ms | 49.9 / 43.2 | 58.6 / 49.5 | 69.8 / 51.0 |
| WAL file, max bytes | 4.19 MB | 4.21 MB | 4.19 MB |
| database file at end | 3.3 MB | 3.2 MB | 3.4 MB |

- Raw lines (config C), server side: `{"db_errors": {}, "loop_lag": {"n": 11899, "p50_ms": 0.49, "p99_ms": 2.17, "max_ms": 64.22}, "wal": {"samples": 119, "max_wal_bytes": 4190072, ...}}`.
- Notes:
  - the WAL file stays flat at about 4.2 MB (automatic checkpoints keep up); it does not grow between checkpoints.
  - config B showed one `session_register` write of 1035 ms (7 samples), a tail typical of many connections waiting on the write lock; config C shows 24 ms max.
  - "expected" client errors: `wake.408` (round ended, 267 to 295 per run) and refused `a2a_respond` on cancelled tasks (150 to 160). No 5xx anywhere.
  - the `respond_refused` and `transition.*.error` counters are the cancel races the load creates on purpose.
- Idle resource use [record only]: container at idle after start 93 MiB, 0.25% CPU, 2 processes.
- Headroom (not required by the spec): three 90-second runs at nominal 100x (`logs/stress100-*.out`). The server was CPU-bound in the single Python process (`docker stats` mid-run: 112.8% CPU, 115 MiB), delivering only 13 to 15 tasks per second (about 40 to 50x realistic), not the nominal 33.

| config at 100x | tasks created in 93 s | busy errors | write p99 ms | `SendMessage` p99 ms | wake e2e p99 ms | loop lag p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| deferred / naive | 1206 | 0 | 872 | 943 | 780 | 34.4 |
| split / atomic | 1205 | 0 | 860 | 1159 | 750 | 40.4 |
| queue / atomic | 1410 | 0 | 200 | 359 | 231 | 34.1 |

  The single-connection write queue gives the best tail and the most throughput under overload, and still no `SQLITE_BUSY`.
- Decision consequence (D2): the D2 gate passes with margin at 10x: write p99 3.5x to 12x under the limit, wake p99 about 18x, loop-lag p99 about 46x (max 64 to 71 ms against 100 ms); the real limit is Python CPU at roughly 40 to 50x, not SQLite.

## 6. D3: same-task race [verified]

Test (`driver/d3_race.py`, 300 rounds each, over HTTP, two concurrent requests per round):

- cancel versus complete: originator `CancelTask` against recipient `a2a_respond`, on a WORKING task. A **lost update** is "both callers were told success", because only one final state can exist.
- double take: two concurrent inbox takes of the same SUBMITTED task. A **duplicate delivery** is "both takes returned the task".

| store and engine | cancel vs complete: lost updates | double take: duplicate deliveries | notes |
| --- | --- | --- | --- |
| plain `DatabaseTaskStore`, get/modify/save, deferred (SQLite) | **300 of 300** | **300 of 300** | final state CANCELED in 297, COMPLETED in 3 |
| plain store, write engine `BEGIN IMMEDIATE` | **300 of 300** | **300 of 300** | IMMEDIATE alone does not help: the read and the write are separate transactions |
| `VersionedDatabaseTaskStore`, deferred (SQLite) | **136 of 300** | 0 of 300 | the cancel path "overwrites a non-terminal task without a version check" and its `SELECT ... FOR UPDATE` guard is a no-op on SQLite; 300 handled first-writer `IntegrityError`s (these show in `db_errors`) |
| `VersionedDatabaseTaskStore`, IMMEDIATE write engine (SQLite) | 0 of 300 | 0 of 300 | 335 CAS retries |
| `VersionedDatabaseTaskStore` + version row seeded at create, IMMEDIATE (SQLite) | 0 of 300 | 0 of 300 | 347 CAS retries, transition p99 27.6 ms |
| own CAS in one `BEGIN IMMEDIATE` transaction (SQLite) | 0 of 300 | 0 of 300 | fastest: transition p50 4.4 ms, p99 11.5 ms |

- Cure named and passing: **compare-and-swap through the SDK versioned store on an IMMEDIATE write engine** (portable, see D10) or our own single-transaction CAS (SQLite only, see D10). The plain store must not be used for read-modify-write.
- Decision consequence: transitions (`a2a_inbox` take, `a2a_respond`, `CancelTask`) must go through a CAS path. Cluster mode (events, event stream) is still not needed; only the version side table is.

## 7. D4: extension round trip [verified]

36 of 36 checks pass on SQLite (`logs/d4d11-index.out`), the same 36 on Postgres (D10).

- Addressed handle: `Message.metadata.coord.to` round-trips unchanged through `SendMessage`, `GetTask` and `ListTasks`, JSON-RPC and REST.
- Sender: `Task.metadata.coord.from` is set by the server (`key-a`). Client-supplied `coord.from`, `coord.hold` and extra `coord.*` keys on the message are dropped (server rebuilds the message metadata with only `to`).
- `context_id`: generated as `uuid5(namespace, "<originator>|<recipient card>")`. Two sends from the same originator to the same card share one `context_id`; a different card gets a different one; `ListTasks` with `context_id` returns exactly the pair's tasks.
- Held task: sent with a test flag, stored as `TASK_STATE_INPUT_REQUIRED` plus `coord.hold="quarantine"` in `task_index.hold` and in the SDK `tasks.metadata` (checked in the database: `TASK_STATE_INPUT_REQUIRED|quarantine`). The sender sees `INPUT_REQUIRED` and **no `coord.hold`**: the SDK returns stored metadata as is, so our `sender_view()` strips it on every outgoing task. A follow-up message to a held task returns the task unchanged (history length stays 1). The held task is not delivered by the inbox take.
- `interrupted_task_timeout`: read in code and tested (section 13, D11 experiment E4). It only releases the in-memory `ActiveTask` of the SDK handler; the stored state stays `INPUT_REQUIRED`. Our own handler has no such timer. So held tasks are not auto-released in either design.
- What `ListTasks` can filter by: `context_id`, `status`, `status_timestamp_after` only. An unknown filter such as `toHandle` is **silently ignored** over both REST and JSON-RPC (a superset comes back), so a client believes it was filtered. **Plan chosen: side table `task_index`** with an index on `to_handle` (also on `from_principal`, `to_card`). Pending-count query joins it to `tasks` on the JSON state path (`tm.status["state"].as_string()`, the same construct the SDK uses). `EXPLAIN QUERY PLAN` shows `ix_task_index_to_handle` is used.
- Decision consequence: no change to the extension design (server-api 5.3, 6.1, 10); the side table is confirmed, and `sender_view()` is a required output filter.

## 8. D5: owner scoping [verified]

20 of 20 checks pass on SQLite (`logs/d5-owner.out`) and on Postgres. Server started with the SDK's own resolver (owner = API key principal):

- key A creates a task. Key B (another local key) and key C (remote-peer key):
  - `GetTask` JSON-RPC gives `-32001` task not found; REST gives 404
  - `ListTasks` (JSON-RPC and REST, also filtered by A's `context_id`) returns `totalSize: 0`
  - `CancelTask` (JSON-RPC and REST) gives not found, and A's task is still SUBMITTED afterwards
- A cannot read B's task either. No key and a wrong key give 401.
- Structural limit [verified, and the reason for D11]: owner scoping gives one owner per task, so the **recipient cannot see a task addressed to it**. "Originator or recipient" visibility needs our own index (D11).
- Decision consequence: the SDK owner resolver is enough to keep a remote-peer key away from local tasks; recipient visibility is ours.

## 9. D6: migrations [verified]

21 of 21 checks pass on SQLite (`logs/d6.out`), 5 of 5 on Postgres (`logs/d10-migrations.out`).

- **Empty database, CLI first:** `a2a-db upgrade` exits 0, prints `Table 'tasks' does not exist. Skipping upgrade for this table.`, creates only `task_versions`, `task_events` and `a2a_alembic_version` (stamped `b5e3d1c8a2f7`), and **does not create the `tasks` table**. The `tasks` table comes from `DatabaseTaskStore(create_table=True).initialize()`. So the boot order must be: create the table, then `a2a-db upgrade`, then ours.
- **Boot order used by the server** (create_all, then CLI, then ours): works; the second `a2a-db upgrade` is a no-op (same revision, same table set); `a2a-db current` reports `b5e3d1c8a2f7 (head)`. The column and index guards print `already exists ... Skipping`.
- **Oldest shape with data** (a `tasks` table with no `owner`, `last_updated`, `protocol_version`; 50 legacy rows): upgrade exits 0, three columns added, 50 rows kept, every legacy row gets owner `legacy_v03_no_user_info`, so it is invisible to real owners. A legacy row is readable through `DatabaseTaskStore.get` for that owner (v0.3 conversion path), and invisible for `key-a`. Stepwise upgrade (to `6419d2d130f6`, then head) with data also works.
- **Newer than code:**
  - SDK stream: unknown revision in `a2a_alembic_version` gives exit 1 and `alembic.util.exc.CommandError: Can't locate revision identified by 'ffff0000ffff'`. The spike server boot fails with `RuntimeError: a2a-db upgrade failed: ...` and the container exits 3.
  - our stream: `coord_schema_version=99` gives `SchemaTooNew: database coord schema version 99 is newer than this code knows (2); refusing to start`, container exit 3.
- **Our tables alongside the SDK's:** our numbered migrations run 0 to 1 to 2 in the same file, a re-run applies nothing, our rows survive; two version tables (`a2a_alembic_version`, `coord_schema_version`) do not clash; `a2a-db upgrade` after our tables exist leaves them alone; `a2a-db downgrade base` removes only SDK objects (`task_events`, `task_versions`; it leaves the `tasks` table and all of ours). No second SQLite file is needed.
- The SDK stamps `task_versions` and `task_events` on every database even when cluster mode is unused (harmless, but the tables exist).
- Decision consequence: server-api 1.3 holds as written with one correction: the SDK stream does not create `tasks`; start-up must create it first.

## 10. D7: backup and restore [verified]

Run while the 10x load was live (`driver/d7_backup.sh`, `logs/d7.log`). At backup time the WAL was 4,152,992 bytes and the database file 339,968 bytes (most recent commits only in the WAL).

- `sqlite3 /data/a2a.db ".backup /data/backup/backup.db"`: 0.059 s, consistent snapshot, `integrity_check` ok, 156 tasks and 156 index rows, no orphans in either direction.
- `sqlite3 /data/a2a.db "VACUUM INTO '/data/backup/vacuum.db'"`: 0.062 s, same result.
- **Unsafe:** `cp /data/a2a.db` alone while WAL is active: `integrity_check` says **ok** yet the copy holds **124** tasks where 156 had been committed (32 recent commits silently missing). Copying `.db` then `-wal` one after the other happened to open consistently (158 of 158) in this run; that is luck, not a guarantee.
- Restore: new volume `a2a-spike-sp5-restore`, `cp backup.db /dst/a2a.db`, then `pragma integrity_check` ok and counts tasks 156, task_index 156, sessions 205, wakes 156, audit 461, `coord_schema_version` 2, `a2a_alembic_version` `b5e3d1c8a2f7`. A server started on the restored volume answered healthy, returned the right task state (`GetTask`), `ListTasks totalSize 156`, and accepted a new `SendMessage`.
- Procedure to write down:
  - backup, while the server runs: `sqlite3 /data/a2a.db ".backup /data/backup/a2a-<timestamp>.db"` (or `VACUUM INTO`), then `sqlite3 <file> "pragma integrity_check"`
  - restore, with the server stopped: copy the backup into an empty volume as `a2a.db` (no stale `-wal` or `-shm`), start the server
  - never `cp` the live `.db`
  - the image needs the `sqlite3` CLI (installed here with `apt`), or use the Python `sqlite3` backup API
- Decision consequence: server-api 1.2 backup sentence is confirmed; add the integrity check and the "copy loses commits but still says ok" warning.

## 11. D8: crash with `kill -9` [verified]

Run under the 10x load, three `docker kill --signal=KILL` of the container, restart each time (`driver/d8_crash.sh`, `logs/d8.log`).

- Per kill: container `exited exit=137`; files left `a2a.db` 340 to 410 KB, `-shm` 32 KB, `-wal` 4.15 MB; restart healthy after 1.76 to 2.04 s; boot log shows `a2a-db upgrade rc=0` and `coord migrations applied: []`. Acked-but-missing tasks after each restart: 0.
- Final check after the load: acked creates 347, present 347, missing 0; acked completions 315, present as COMPLETED 315; acked cancels 32, present as CANCELED 32; `integrity_check` ok; tasks 347, task_index 347, no orphan either way (the task and its index row commit in one transaction in `CoordTaskStore.save`).
- Re-offer after restart (separate probe): a listener was woken (200) for handle `ro1`, five tasks created and left SUBMITTED, container killed and restarted. The listener table is empty after restart (0, in memory). A new `/wake/listen` for each of the five handles returned 200 in about 5 ms because the park does one database count of SUBMITTED tasks for the handle first (level-triggered). All five tasks were still SUBMITTED.
- Limits: `kill -9` kills the process, not the VM. With `synchronous=NORMAL` the WAL is flushed to the OS only, so a power or VM crash can lose the last commits [reported]; not tested. Task and index in separate transactions would leave a crash window; ours avoids it by construction (not tested separately).
- Decision consequence: no committed task lost on process crash; re-offer needs no stored offer state beyond "task SUBMITTED for handle", which is already in the database.

## 12. D9 and D10

### D9: filesystem facts [verified]

- `/data` is a Docker named volume: `stat -f -c %T /data` prints `ext2/ext3` (the ext family magic), and `mount` shows `/dev/sdd on /data type ext4 (rw,relatime,discard,errors=remount-ro,data=ordered)`. Host path `~/.local/share/docker/volumes/a2a-spike-sp5-data/_data` (rootless Docker root `~/.local/share/docker`). WAL and shared memory work there (every run above).
- `/mnt/c` is `9p` (`drvfs`). **The spec's blanket "WAL does not work on a Windows path" was not reproduced as a hard failure:** host `sqlite3` and a container bind mount of a `/mnt/c` directory both accepted `journal_mode=WAL` (`wal`), a second connection read the rows, and the D1 50-worker test ran with `integrity_check` ok. But it was **about 2x slower** (IMMEDIATE, one connection: p50 274 ms and p99 316 ms against 123 and 144 ms on the volume; deferred p99 1224 ms against 620 ms) and cross-process shared-memory locking over 9p was not tested. Keep the rule "database on a named volume only" as policy, but the reason is speed and unproven locking, not a verified failure.
- The temporary directory `/mnt/c/Users/Public/a2a-spike-sp5-wal` was created twice and removed; verified gone.

### D10: Postgres by URL change [verified, stretch]

Postgres 17.11 container on a user network, `A2A_DB_URL=postgresql+asyncpg://spike:spike@a2a-spike-sp5-pg:5432/<db>` (throwaway credentials); the only change in the server is the URL (our `make_engine` returns a plain engine for non-SQLite URLs).

- D4 and D11 suite: 36 of 36 pass. D5 suite: 20 of 20 pass.
- D6: `a2a-db upgrade` empty (no `tasks` table), create_all then upgrade (twice, idempotent), our migrations 0 to 2 then no-op, newer-than-code refusal: 5 of 5 pass. SDK `tasks` columns on Postgres use `json`, `timestamp without time zone`, `varchar`.
- D2 mix, 3 minutes at 10x with 200 listeners (shortened from 10 minutes), `CAS_MODE=versioned`: 593 tasks, zero database errors, wake e2e p99 15.4 ms, `SendMessage` p99 22.7 ms, loop lag p99 2.18 ms. **But** transition p99 was 1031 ms: the Postgres log holds 22 `ERROR: deadlock detected` (the 1 s default `deadlock_timeout`), each retried by the SDK store. Cause (inferred; the Postgres log shows `INSERT INTO task_versions` in one transaction waiting on `UPDATE tasks` in another, and the cure below removes it): tasks created **outside** the versioned store (our create path wrote no version row) let the two writers take locks in opposite orders.
- **Cure verified:** insert the `task_versions` row (version 1) in the same transaction as the task at creation (`SEED_VERSION=1`). Re-run on Postgres: no new deadlock, transition p99 13.8 ms; D3 on Postgres 0 lost updates, 0 double takes, transition p99 10.2 ms. The same seeding passes on SQLite (D3 table).
- D3 on Postgres:

| CAS path | cancel vs complete: lost updates | double take: duplicates |
| --- | --- | --- |
| `VersionedDatabaseTaskStore` (unseeded) | 0 of 300 | 0 of 300 |
| `VersionedDatabaseTaskStore` + seeded version row | 0 of 300 | 0 of 300 |
| our single-transaction CAS (relies on `BEGIN IMMEDIATE`) | **259 of 300** | **300 of 300** |
| plain get/save | 299 of 300 | 300 of 300 |

- **Decision consequence for decision 4:** "Postgres later by URL change only" holds for the SDK store, our Core tables, migrations and the whole HTTP surface. It does **not** hold for any concurrency control that depends on SQLite `BEGIN IMMEDIATE` (our own CAS). The portable CAS is the SDK versioned store plus a seeded version row; the SQLite-only part (IMMEDIATE, single write connection) must live in a dialect-aware engine factory. Not tested on Postgres: stress, backup, crash.

## 13. D11 and D12

### D11: SDK fit [verified]

- **Parked-task handler:** the SDK `DefaultRequestHandler` assumes an `AgentExecutor` in the request. We wrote `ParkedHandler(RequestHandler)` (11 methods, about 100 lines): `SendMessage` creates the task and returns it; `GetTask`, `ListTasks`, `CancelTask` go to our service layer; streaming and push raise `UnsupportedOperationError` / `PushNotificationNotSupportedError`. It plugs into the SDK `create_jsonrpc_routes` and `create_rest_routes` unchanged, so the SDK keeps the wire code, the validation and the error mapping. A task created over A2A moved SUBMITTED, WORKING, COMPLETED through changes made **outside the request** (MCP tools or spike endpoints), and the sender's `GetTask` saw each state. Without patching the SDK. Streaming `SendStreamingMessage` returned an error (the check expects `-32004` UnsupportedOperation but also accepted a non-200 status, so the exact code was not pinned).
- **Visibility "originator or recipient card":** the owner resolver is made constant (`coord`) and visibility is enforced from `task_index` (`from_principal` or `to_card`). Verified: recipient card sees a task addressed to it; a third card does not; a third key cannot read or cancel; the recipient cannot cancel (originator only); the originator can; cancelling a terminal task gives `-32002`; `ListTasks` as a wrapper (join of `tasks` and `task_index`, own pagination) lists exactly the visible tasks, paginated without duplicates, with a correct `totalSize`. This wrapper uses four SDK-private members: `DatabaseTaskStore._to_orm`, `_from_orm`, `_after_cursor`, `_cursor_for`, plus the `async_session_maker` attribute. Pin the SDK exactly and re-run this suite on every bump.
- **Held task** as `INPUT_REQUIRED` plus `coord.hold`: works, returned to the sender as plain `INPUT_REQUIRED` once `sender_view()` strips the hold (section 7).
- **Atomic task plus index write:** `DatabaseTaskStore.save` opens its own session, so the index row needs a subclass that overrides `save` (done: `CoordTaskStore.save`, one transaction).
- **Status-event publication from our service layer (S2 streaming, record only)**, in-process experiment on the SDK 1.3.0 `DefaultRequestHandlerV2` with a thin "parking" `AgentExecutor` (`tests/d11_v2_experiment.py`, `logs/d11-v2.out`):
  - E1 default `SendMessage` with an executor parked in SUBMITTED: the call blocked until my own 3 s cancellation (returned the SUBMITTED task at 3004 ms), so the client must send `return_immediately=true`.
  - E2 `return_immediately=true`: SUBMITTED task in 8 ms.
  - E3 `SubscribeToTask` received `Task:SUBMITTED`, `TaskStatusUpdateEvent:WORKING`, `TaskStatusUpdateEvent:COMPLETED` when our code pushed commands into the executor's queue from outside. So SDK event fan-out **can** be driven by our service layer through an executor shim.
  - E4 `interrupted_task_timeout=1s` on a task parked `INPUT_REQUIRED`: stored state after 3 s still `INPUT_REQUIRED`; the in-memory `ActiveTask` is released (True before, False after). A follow-up (needs matching `context_id`) re-creates it and calls `execute` again (2 calls).
  - E5 a direct store write (COMPLETED) while an `ActiveTask` is parked, then an executor event: the final stored state was WORKING, so **the terminal state was overwritten**. All state changes must go through one path; direct store writes and the executor shim must not be mixed for the same task.
- Decision consequence: server-api 3.3.1 and 10 hold: our own request handler plus our own status fan-out (or the executor shim, routing every transition through it) for S2; nothing in S1 needs the SDK handler.

### D12: MCP mount [verified]

19 of 20 recorded checks pass (`logs/d12-routes.out`); the 20th (line 13, `PASS D12 [record] foreign API key re-using another key's Mcp-Session-Id :: status=200`) is a record-only probe that shows a defect, Finding 1 below, not fixed in the spike. Three findings below.

- Mount form that works: extract the routes of `mcp.streamable_http_app(streamable_http_path="/mcp", transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))` into the same Starlette `routes` list as the A2A routes, and enter `mcp.session_manager.run()` in the application lifespan. One process, one app, one middleware stack.
- The `Mount("/mcp", app=mcp_app)` form did not work out of the box: `POST /mcp` answered `307` to `/mcp/`, and `/mcp/` answered 404 (with `streamable_http_path="/"`). Not pursued; route extraction is the working form. The mounted sub-app's lifespan is not run by Starlette, so the session manager must be entered by us either way.
- Start and stop: lifespan and session manager start cleanly together (`StreamableHTTP session manager started`, then `READY`). Stop works cleanly only with the fix below.
- `Mcp-Session-Id` is issued at `initialize` (stateful), echoed on every response, a request without it gets 400, an unknown one gets 404 (client must re-initialize), a session lost to a restart gets 404 (so "Not bound. Call a2a_hello." is the normal recovery).
- Shared middleware sees `/mcp`: no bearer gives 401, the remote-peer key gives 403 (scope check), bad `Host` gives 421, bad `Origin` gives 403; the middleware counters recorded the `/mcp` requests. The `mcp` app's default DNS-rebinding protection (allowed hosts `127.0.0.1:*`, `localhost:*`) is on for host `127.0.0.1`; it was switched off because our middleware does the Host and Origin checks (inside a container the `Host` header carries the published port).
- Identity in tools (mcp 2.3.0 API): `Context` has no `session_id` attribute. Per request, `ctx.headers` gives `authorization` and `mcp-session-id` (client-supplied, but the session manager only accepts ids it issued).
- **Finding 1, session reuse across keys [verified]:** a request carrying API key B's token but API key A's `Mcp-Session-Id` was **accepted (200)** and executed with A's session binding. The `mcp` app's own owner check (`_session_owners`) is tied to the SDK's own auth context, which our middleware does not populate. The server must keep `mcp_session_id -> (key_id, handle)` itself (as server-api 3.4 already says) and reject a mismatch.
- **Finding 2, protocol era [verified]:** the default `server/discover` of `mcp` 2.3.0 answers `supportedVersions: ["2026-07-28"]` only (`logs/d12-agy-discover.txt`). The official client in auto mode (its discover probe carries the same `_meta` shape the SP2 A4 log recorded for agy; my hand-made curl probe needed the `MCP-Protocol-Version` and `Mcp-Method` headers or the server answered 400) connected at **2026-07-28**, got **no `Mcp-Session-Id`**, and `a2a_hello` followed by `a2a_inbox` returned `Not bound` (the binding fell back to an object id). Overriding `server/discover` to advertise only legacy versions (`["2025-11-25","2025-06-18","2025-03-26"]`, `MCP_DISCOVER=legacy`) made the same client fall back to `initialize`, negotiate `2025-11-25`, receive a session id, and bind correctly (`logs/d12-client-auto-legacy.txt` against `-default.txt`). agy probes discover first (recorded in the SP2 A4 and A6 results; agy was not run here, so that it would pick the sessionless era against the default answer is **inferred, unverified**), so this override is needed for session-bound tools unless identity is carried another way (agy: `_meta` conversation id, decision 6; Claude Code: the `handle` argument fallback in server-api 3.4). Pinning `mcp<2` was **not** tested.
- Protocol versions accepted by `initialize`: `2025-03-26`, `2025-06-18`, `2025-11-25` all negotiate as asked and issue a session id.
- Official client check: `mcp` 2.3.0 `ClientSession` over `streamable_http_client` with a bearer header: initialize, `list_tools` (5 tools), `call_tool` all work against the mounted app.
- Long-poll starvation: 200 parked `/wake/listen` requests in the same process did **not** starve MCP calls: `a2a_inbox` p50 4.3 ms and p99 5.7 ms idle against 4.7 and 6.6 ms with 200 parked. A 5 s blocking `a2a_wait` on one session left another session's calls at p99 7.9 ms, and a second call on the same session during a 3 s `a2a_wait` returned in 7 ms (the server does not serialise calls per session). This is the server side only; the client-side tool timeout is SP2 C8 and A7.
- **Finding 3, graceful stop [verified]:** with plain `uvicorn`, 20 parked listeners block shutdown (`Waiting for connections to close`); `docker stop -t 30` took 30.3 s and the container died with exit 137 (SIGKILL). With `--timeout-graceful-shutdown 3` it exits in 3.7 s but the listeners get 500s and tracebacks. The fix that works: a `uvicorn.Server` subclass whose `handle_exit` first answers every parked listener with `503 Retry-After` (spike: `spike/run.py`). Result: `docker stop` 0.64 s, exit 0, all 20 listeners received 503, log `SIGTERM: released 20 parked listeners with 503`, then clean `Application shutdown complete`. This matches the 503 row of server-api 7.1.
- Fallback for D12 was not needed.

## 14. Decision consequences

- **Decision 4 (storage):** stands, with these amendments to the wording:
  - SQLite in WAL on a named volume, one process, one uvicorn worker: **confirmed fit** at 10x with huge margin; the ceiling is Python CPU (about 40 to 50x), not SQLite.
  - "via `DatabaseTaskStore`" becomes "via our `CoordTaskStore`, a thin subclass of it, plus the SDK `VersionedDatabaseTaskStore` for transitions".
  - engine: WAL, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`; write engine on `BEGIN IMMEDIATE` with one connection; reads on a separate pool. Without IMMEDIATE the plain store is unsafe (11 `IntegrityError`s in 2000 saves under concurrency).
  - "Postgres later by URL change only": **true for the HTTP surface, SDK store, our Core tables and migrations** (D10); **not true for any CAS built on SQLite `BEGIN IMMEDIATE`**. Use the versioned store with a seeded version row, and keep SQLite engine tweaks in a dialect-aware factory.
  - durability: `synchronous=NORMAL` survives process death (verified), not necessarily OS death (not tested); say so in the doc.
  - the user's confirmation for "moving the starting engine to Postgres" is **not** triggered; SQLite is fit.
- **Decision 5 and 6 (MCP at `/mcp`, identity):** the stateful-session requirement needs the discover override (or a `mcp<2` pin, untested), and the server must bind `Mcp-Session-Id` to the API key. The agy route (conversation id in `_meta`) does not depend on a session id; the Claude Code route does until SP2 C settles what Claude Code negotiates.
- **Decision 8 (wake):** server-side long-poll scales (200 parked, no starvation, p99 wake 26 ms); needs the shutdown hook; the level-triggered park-time count makes restart recovery free.

## 15. server-api section 10 gaps (changes)

- Confirmed as written:
  - SQLite hardening on the engine (1.2): needed, and now specified more strictly (IMMEDIATE write engine, one write connection)
  - MCP facade in-process with stateful sessions (3.4): works, with the three findings above (section 13, D12)
  - request handler for parked tasks: written, works as a thin handler (11 methods)
  - visibility over `owner_resolver` plus `task_index`: works with a `TaskStore` subclass and a `ListTasks` wrapper
  - `QUARANTINED` as `INPUT_REQUIRED` plus `coord.hold`: works; needs the outgoing `sender_view()` strip
  - `interrupted_task_timeout`: irrelevant to our handler; in the SDK handler it frees memory only
  - two migration streams and newer-schema refusal (1.3): work and refuse with exit 3
- **New gaps to add:**
  - transitions must be compare-and-swap; the get/save pattern loses updates 100% under a race (D3). Use `VersionedDatabaseTaskStore` with a version row seeded at creation, in the same transaction as the task and index row.
  - `VersionedDatabaseTaskStore` relies on `SELECT ... FOR UPDATE`, which SQLite ignores: safe on SQLite only with an IMMEDIATE write engine (136 of 300 lost updates without it).
  - task and `task_index` must commit in one transaction (subclass `save`).
  - `a2a-db upgrade` does not create the `tasks` table: boot order create, upgrade, ours (D6). Add `a2a-sdk[http-server,sqlite,db-cli]` (not `sql`) to the dependency line.
  - graceful shutdown with parked listeners needs a `handle_exit` hook that releases them with 503, otherwise `docker stop` ends in SIGKILL (D12).
  - `mcp` 2.x: `MCPServer` replaces `FastMCP`; `Context` has no `session_id`; default discover advertises only the sessionless era; DNS-rebinding defaults interact with our Host check (D12).
  - MCP session id must be bound to the API key by us (D12).
  - `ListTasks` silently ignores unknown filters: wrap it, and never rely on a filter the SDK does not implement (D4).
  - the `ListTasks` wrapper depends on four SDK-private members: pin `a2a-sdk` exactly and re-run `driver/d4_d5_d11.py` on each bump.
  - the image needs the `sqlite3` CLI (or a Python backup step); document the backup and restore procedure of section 10.
  - REST `ListTasks` without `pageSize` must not fail: guard `validate_page_size` (my first handler rejected 0).
- Versions to pin in the real server: `a2a-sdk==1.3.0` (the spike resolved exactly 1.3.0), `mcp` decision pending (2.3.0 with discover override verified; `mcp<2` untested).

## 16. What was not run or not tested

- D10: Postgres stress, backup and crash; the D2 mix ran 3 minutes, not 10.
- Power or VM loss with `synchronous=NORMAL`.
- `mcp<2` (1.x) against the same checks.
- `uvicorn[standard]` (`uvloop`, `httptools`) numbers.
- Any real harness (Claude Code, agy) against this server; agy was never started by this run, no Claude session was started.
- Cross-process WAL locking on 9p (`/mnt/c`).
- `A2A-Version` missing-header behaviour (every request in this run sent `A2A-Version: 1.0`).

## 17. Touched files and restore check

- Host configuration touched: **none**. No `~/.claude.json`, no `claude mcp` command, no `~/.claude/settings*`, no `~/.gemini/*`, no chezmoi-managed file. Nothing to restore; nothing backed up.
- Created or modified, all outside every git repo except the one result file:
  - `~/scratch/a2a-spikes/sp5/` (scratch project; its `pyproject.toml` and `uv.lock` pre-existed and were extended by `uv add` with `mcp` and `uvicorn` and the `db-cli` extra; `.venv`, `spike/`, `driver/`, `tests/`, `logs/`, `Dockerfile`, `srv.sh`, `srv-pg.sh`, `stress.sh` are new). Kept on purpose.
  - `/mnt/c/Users/Public/a2a-spike-sp5-wal` (temporary, removed, verified gone)
  - this file: `plugins/coordination/docs/research/spike-results-2026-11-05-sp5.md` (new, untracked; no commit, push or branch switch was made in `agentic-hub`, branch stays `feat/coordination-s0`)
- Processes: no leftover `uvicorn`, `load.py` or driver process; no listener on 18125 to 18127 (checked with `ss`).

## 18. Cleanup confirmation

- Removed and verified absent (`docker ps -a`, `docker volume ls`, `docker network ls`, `docker images` filtered on `a2a-spike`, `python` and `postgres`): all `a2a-spike-*` containers, the volumes `a2a-spike-sp5-data`, `a2a-spike-sp5-restore`, `a2a-spike-sp5-pgdata`, the network `a2a-spike-sp5-net`, the image `a2a-spike-sp5:latest`, and the base images this run pulled (`python:3.12-slim`, `postgres:17-alpine`). The images `alpine:3` and `ubuntu:26.04` pre-existed and were not touched. No other container was touched.
- Not removed: the Docker build cache from the `a2a-spike-sp5` builds (shared BuildKit cache; pruning it could affect other builds).
- Kept: the scratch project and all logs under `~/scratch/a2a-spikes/sp5/logs/`.
- Note: `logs/d4d5d11-index.json` and `logs/d4d5d11-owner.json` hold the Postgres runs (overwritten); the SQLite outputs are `logs/d4d11-index.out` and `logs/d5-owner.out`.
