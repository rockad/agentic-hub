# Spike results: SP5b — a2a-python on Postgres (D-D)

Written 2026-11-10 on `alyx`. Results of the rerun of SP5 on Postgres with backup sidecar, crash resilience, steady-state own-table writes, and handle separator check. Gates stage S1 entry.

Status: **passed** (all gates met).

---

## 1. Summary of findings

| Test | Question | Gate | Result | Verdict |
|---|---|---|---|---|
| D3 | CAS lost update prevention | 0 lost updates, 0 double takes | 300 rounds cancel vs complete (299 complete, 1 cancel, 0 lost); 300 double takes (all 300 single take); 0 inconsistent acks; transition p50 7.06 ms, p99 10.13 ms | pass |
| D7 | Dump sidecar (-Fc, dump_ro) & restore integrity | pg_restore --list ok, restored row counts match dump time | Dump completed in 0.73 s under load; pg_restore --list verified (71 entries); restored into scratch DB with 100% matching counts (tasks 722, task_index 722, sessions 210, wakes 258, 0 orphans); Alembic migration verified at head (b5e3d1c8a2f7) | pass |
| D8 | Crash resilience under load | 0 lost acked writes after kill -9 and Postgres restart | 2x kill -9 of server container (healthy in ~2.0 s); Postgres container restart mid-load with connection pool recovery; 336 acked creates (0 missing), 296 acked completions (0 missing), 40 acked cancels (0 missing); 0 orphan tasks; level-triggered park re-offer verified on SUBMITTED tasks (http 200 in ~5 ms) | pass |
| D2 | 10-minute mixed load (10x, 200 parked listeners, 5 agents) | p99 write < 200 ms, 0 unhandled db errors, lag < 100 ms, wake p99 < 500 ms, 0 deadlocks | 1,986 tasks created, 1,766 completed, 0 unhandled db errors; loop lag p50 0.53 ms, p99 2.41 ms; wake server p50 1.9 ms, p99 2.8 ms (e2e p99 21.8 ms); store.save p99 17.25 ms; transition.versioned p99 18.66 ms; own.session_register p99 9.68 ms; own.wake_confirm p99 6.42 ms; 0 deadlocks during 10-min run with SEED_VERSION=1 | pass |
| Sep | Handle separator (# vs ~) | URL, shell, JSON, storage validation | Both # and ~ pass all checks; raw # begins URL fragment if unencoded and requires standard percent-encoding (%23) in query paths; adopted name#sid8 | pass |

---

## 2. Environment, versions, and pins

- Host: `alyx` (WSL2, Debian GNU/Linux 12).
- Container base: `python:3.12-slim` (Python 3.12.13).
- Postgres image pinned: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (D-B, R3).
- `a2a-sdk`: `1.3.0`.
- `asyncpg`: `0.32.0`.
- `sqlalchemy`: `2.1.8`.
- `alembic`: `1.20.1`.
- `mcp`: `2.3.0`.
- `uvicorn`: `0.54.0`.
- Scratch ports: loopback `18130` (server), database internal only (`5432` on `sp5b-net`, no published port on host).
- Secrets: `POSTGRES_PASSWORD_FILE` and `A2A_DB_PASSWORD_FILE` mounted via compose secret files (mode 0600 on host, never printed or written to git).

---

## 3. D3: Same-task race on versioned store

- Configuration: `TXN_MODE=deferred`, `CAS_MODE=versioned`, `VISIBILITY=index`, `SEED_VERSION=1`.
- 300 rounds of cancel versus complete:
  - Only complete ok: 299.
  - Only cancel ok: 1.
  - Both told success (lost update): 0.
  - Inconsistent acknowledgements: 0.
- 300 rounds of double take on `a2a_inbox`:
  - `taken_total=1`: 300 (0 double takes).
- Database errors: 0.
- CAS conflict retries handled by SDK: 599.
- Transition latency: p50 7.06 ms, p99 10.13 ms (max 79.85 ms).

---

## 4. D7: Backup sidecar & restore verification

- Dump sidecar run via `docker compose --profile backup run --rm dump` as `dump_ro` role (R11, R14).
- Dump format: custom format (`-Fc`, R12).
- Time to dump under active load: 0.73 s.
- Dump archive verification: `pg_restore --list` verified 71 TOC entries without error.
- Restore into fresh database `sp5b_restore`:
  - Tasks count: 722 at dump time, 722 restored (100% match).
  - Task index count: 722 at dump time, 722 restored (100% match).
  - Sessions count: 210 at dump time, 210 restored (100% match).
  - Wakes count: 258 at dump time, 258 restored (100% match).
  - Orphan tasks (tasks without index row): 0.
  - Orphan index rows: 0.
  - Alembic migration head: `b5e3d1c8a2f7 (head)` confirmed on restored database.

---

## 5. D8: Crash recovery under load

- Load: 10x realistic traffic with 200 parked wake listeners.
- Server container killed twice with `kill -9`:
  - Kill #1: server killed (exit 137), container restarted, healthy in 2.07 s.
  - Kill #2: server killed (exit 137), container restarted, healthy in 2.04 s.
- Postgres container restart:
  - Cycled mid-load; server connection pool gracefully reconnected once Postgres resumed readiness.
- Reconciliation of acknowledged writes:
  - Acknowledged creates: 336 (0 missing).
  - Acknowledged completions: 296 (0 missing).
  - Acknowledged cancels: 40 (0 missing).
  - Orphan tasks: 0.
  - Orphan index rows: 0.
- Level-triggered re-offer check on SUBMITTED tasks:
  - Checked parked listeners against unconfirmed submitted tasks after final restart.
  - Both test handles immediately received HTTP 200 wake payload in 4.7 ms and 6.1 ms.

---

## 6. D2: 10-minute mixed load benchmark

- Duration: 603.0 s (10 minutes) at 10x realistic load, 200 parked listeners, 5 agents.
- Traffic summary:
  - Tasks created: 1,986.
  - Tasks completed: 1,766.
  - Tasks canceled: 220.
  - Parked wake listeners: 200 sustained (2,247 park events, 1,985 wake 200s, 265 expected 408 round expirations).
  - Unhandled database errors: 0 (`db_errors: {}`).
- Latency breakdown:
  - Event-loop lag: p50 0.53 ms, p99 2.41 ms (max 79.12 ms) — passes < 100 ms gate.
  - Wake latency (server-side): p50 1.9 ms, p99 2.8 ms (max 4.8 ms) — passes < 500 ms gate.
  - Wake latency (e2e): p50 9.4 ms, p99 21.8 ms (max 94.7 ms).
  - Store write latency:
    - `store.save`: p50 4.92 ms, p99 17.25 ms (max 41.90 ms) — passes < 200 ms gate.
    - `transition.versioned`: p50 6.05 ms, p99 18.66 ms (max 105.46 ms) — passes < 200 ms gate.
    - `own.session_register`: p50 2.34 ms, p99 9.68 ms (max 78.68 ms).
    - `own.wake_insert`: p50 4.44 ms, p99 15.32 ms (max 43.71 ms).
    - `own.wake_confirm`: p50 2.19 ms, p99 6.42 ms (max 32.59 ms).
    - `own.audit`: p50 2.36 ms, p99 10.40 ms (max 43.12 ms).
  - Read latency:
    - `store.get`: p50 2.00 ms, p99 6.05 ms.
    - `store.list`: p50 8.46 ms, p99 15.22 ms.
- Deadlock count: 0 deadlocks occurred during the benchmark. The `SEED_VERSION=1` creation-time version row seeding completely cured the 22 deadlocks observed in SP5 D10.

---

## 7. Handle separator check (# vs ~)

- Evaluated `#` and `~` in `claude-code@alyx/c6-same#3f2a9c1d` and `claude-code@alyx/c6-same~3f2a9c1d`.
- Domains tested:
  - JSON-RPC: `coord.to` parameter in `SendMessage` — both pass.
  - REST: `coord.to` in `message:send` — both pass.
  - HTTP headers: `X-Coord-Handle` in `/wake/listen` — both pass.
  - URL query parameters: `%23` percent-encoding works transparently; unencoded `#` truncates as a URL fragment, as expected by RFC 3986.
  - Shell quoting: quoted arguments in `curl` and bash variables pass cleanly.
  - JSON serialization: round-trips as value and dictionary key without alteration.
  - Postgres storage: indexed lookups on `task_index.to_handle` and unique key lookups on `sessions.handle` pass without alteration.
- Decision: Adopted `name#sid8` as designed. Raw `#` in URL query paths must be encoded as `%23`.

---

## 8. S1 storage conclusions & decisions confirmed

1. **Gate status**: SP5b is **PASSED**. S1 entry gate is satisfied.
2. **Pinned Postgres image**: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (D-B, R3).
3. **Seeded version row rule**: Server must initialize tasks with `SEED_VERSION=1` in `store.save` inside the initial creation transaction to guarantee 0 deadlocks on Postgres.
4. **Backup sidecar profile**: Real sidecar with profile `backup` using `dump_ro` role with `pg_dump -Fc` verified and approved for S1 compose topology.
