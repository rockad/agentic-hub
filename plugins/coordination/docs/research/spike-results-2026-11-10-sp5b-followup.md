# Spike results: SP5b follow-up on <workstation> (2026-11-10)

Claude Code's independent check of this file against the scratch logs is in section 7 (2026-11-10); sections 1 to 6 are agy's text and are unchanged.

Follow-up checks on <workstation> following the 2026-11-10 SP5b spike, covering:
- (a) `dump_ro` role creation and rotation through the host-command route (`a2a-coord db init-dump-role`, decision X2)
- (b) handle separator evidence for `~` (`card/name~sid8`, decision X1)
- (c) investigation of the D7 1,036.82 ms `transition.versioned` latency outlier

Status: **COMPLETED**. Non-gating spike (S1 entry gate is NOT yet satisfied (SP3 and SP4 are still open)). Labels: **verified** (observed in this run), **reported**, **unverified**.

---

## 1. Environment, versions, and pins

- Host: `<workstation>` (WSL2, Debian GNU/Linux 12) (verified).
- Image pin: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (verified by `docker image inspect`).
- Python container / venv packages (`uv.lock` in `sp5b/`):
  - `a2a-sdk`: `1.3.0` (verified)
  - `asyncpg`: `0.32.0` (verified)
  - `sqlalchemy`: `2.1.8` (verified)
  - `alembic`: `1.20.1` (verified)
  - `mcp`: `2.3.0` (verified)
  - `uvicorn`: `0.54.0` (verified)
- Scratch loopback ports: `18130` (server), `5432` (internal `sp5b-net` only, no published host port) (verified).

---

## 2. (a) `dump_ro` role through the host-command route (decision X2)

### Compose topology modification
- Fresh data volume: started from a freshly created named volume `sp5b_sp5b-pgdata` (verified).
- Secret mounts:
  - Postgres container mounts `db_password` only (verified).
  - Secret `dump_ro_password` is mounted **only into the sidecar** container (`dump.secrets: [dump_ro_password]`) (verified).
  - Init script route removed: `./init-scripts:/docker-entrypoint-initdb.d:ro` removed from compose (verified).

### Host command execution (`init-dump-role.sh`)
- Implementation: Stand-in script `init-dump-role.sh` reads the secret on the host and feeds SQL over stdin to `docker compose exec -T postgres psql -U spike -d sp5b -v ON_ERROR_STOP=1`.
- SQL delivered:
  - `SET log_statement = 'none';`
  - `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'dump_ro') THEN CREATE ROLE dump_ro LOGIN; END IF; END $$;`
  - `ALTER ROLE dump_ro WITH PASSWORD '<secret>';`
  - `GRANT pg_read_all_data TO dump_ro;`
- Idempotency:
  - Run 1 (fresh volume): Role created, password set, privileges granted (`SET, DO, ALTER ROLE, GRANT ROLE`, exit 0) (verified).
  - Run 2 (immediate rerun): Role existed, password updated, privilege check emitted `NOTICE: role "dump_ro" has already been granted membership in role "pg_read_all_data"` and exited 0 (verified).
- Password rotation:
  - Rotated password file generated (`dump_ro_password_rotated.txt`) and applied via `init-dump-role.sh` (verified).
  - Over the Docker network (`sp5b-net`): connection with the new rotated password succeeded (`current_user: dump_ro`); connection with the old password failed (`FATAL: password authentication failed for user "dump_ro"`) (verified).
  - Secret file restored and re-applied (verified).

### Secret leakage and process visibility
- Postgres server logs: `docker logs a2a-spike-sp5b-pg` inspected for password content; 0 occurrences found (verified).
- Server `log_statement` setting: Verified as `none` (`SHOW log_statement;` -> `none`). In addition, the stdin payload sets session `log_statement = 'none'` explicitly (verified).
- Process command lines: `psql` receives the SQL statement strictly via stdin (`docker compose exec -T postgres psql -U spike -d sp5b`); no passwords appear in process arguments (`ps aux` safe) (verified).

### D7 rerun with sidecar
- Sidecar invocation: Executed `docker compose --profile backup run --rm dump` using the sidecar's mounted secret (verified).
- Dump file created: `/backups/a2a-20261110T091123Z.dump` in 0.70 s (verified).
- Restore list verification: `pg_restore --list` verified 71 catalog entries (verified).
- Scratch database restore: Restored into scratch database `sp5b_restore` via `pg_restore` (verified).
- Row count validation:
  - Tasks: 226 (live count at dump time) == 226 (restored) (verified).
  - Task index: 226 (live count at dump time) == 226 (restored) (verified).
  - Sessions: 210 == 210 (restored) (verified).
  - Wakes: 223 == 223 (restored) (verified).
  - Orphan tasks: 0 (verified).
- Migration head: `a2a-db current` executed against `sp5b_restore` reported `b5e3d1c8a2f7 (head)` (verified).

---

## 3. (b) Handle separator evidence for `~` (decision X1)

Handle evaluated: `claude-code@<workstation>/c6-same~3f2a9c1d`.
Session-part regex: `^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$`.

### Verification checklist
- **Unencoded URL query via `curl`**:
  - Quoted: `curl -s -H "Authorization: Bearer spike-token" "http://127.0.0.1:18130/spike/metrics?session=claude-code@<workstation>/c6-same~3f2a9c1d"` -> HTTP 200, parsed cleanly (verified).
  - Unquoted: `curl -s -H "Authorization: Bearer spike-token" http://127.0.0.1:18130/spike/metrics?session=claude-code@<workstation>/c6-same~3f2a9c1d` -> HTTP 200, parsed cleanly without shell error (verified).
- **HTTP client query encoding (`httpx` / `urllib.parse`)**:
  - When query parameters are serialized (`params={"session": "claude-code@<workstation>/c6-same~3f2a9c1d"}`), `httpx` and `urllib` encode `@` to `%40` and `/` to `%2F`, but preserve `~` unencoded: `session=claude-code%40alyx%2Fc6-same~3f2a9c1d` (verified).
  - `~` is an RFC 3986 unreserved character (`ALPHA / DIGIT / "-" / "." / "_" / "~"`), so standard HTTP clients never percent-encode it (verified).
  - Starlette query parser (`request.query_params["session"]`) decodes the parameter to the exact handle `claude-code@<workstation>/c6-same~3f2a9c1d` (verified).
- **API `coord.to` handling**:
  - JSON-RPC `SendMessage` with `metadata.coord.to: "claude-code@<workstation>/c6-same~3f2a9c1d"` -> HTTP 200, task created (verified).
  - REST `messages:send` with `metadata.coord.to: "claude-code@<workstation>/c6-same~3f2a9c1d"` -> HTTP 200, task created (verified).
- **Database storage & indexed lookups**:
  - `sessions.handle`: inserted and queried via `SELECT handle WHERE handle = '...'` -> exact match (verified).
  - `task_index.to_handle`: inserted, indexed, and retrieved -> exact match (verified).
- **Shell tilde expansion rules**:
  - In bash and zsh, tilde expansion (`~` -> `$HOME`) occurs ONLY when `~` is the first character of an unquoted word or immediately following `:` in an assignment (verified).
  - Because handles start with a card id starting with `[a-z0-9]` (`claude-code@...`, `antigravity@...`), `~` is strictly internal to the token and can never trigger shell word expansion (verified).

Verdict: `~` works universally across URL query strings, shell environments, JSON payloads, and Postgres indexing without requiring `%23` encoding.

---

## 4. (c) Investigation of the 1,036.82 ms outlier

### Instrumentation and load setup
- Server parameters configured:
  - `log_lock_waits = on` (logs any lock wait exceeding 1 s) (verified).
  - `log_min_duration_statement = 100` (logs any statement execution exceeding 100 ms) (verified).
  - `log_checkpoints = on` (logs checkpoint start, write, sync times) (verified).
- Background sampler: Async monitor queried `pg_stat_activity` and `pg_locks` every 100 ms during load (verified).
- Workload: 10x mixed load (`load.py --mult 10 --secs 180 --listeners 200`) running against the server (verified).
- Repeated dumps: 4 sequential D7 sidecar dumps executed while `tasks_created >= 150` (verified).

### Dump execution timings under load
- Dump #1: duration 0.736 s (`a2a-20261110T091104Z.dump`), 71 restore entries (verified).
- Dump #2: duration 0.712 s (`a2a-20261110T091110Z.dump`), 71 restore entries (verified).
- Dump #3: duration 0.715 s (`a2a-20261110T091117Z.dump`), 71 restore entries (verified).
- Dump #4: duration 0.697 s (`a2a-20261110T091123Z.dump`), 71 restore entries (verified).

### Latency results across 4 dumps
- Operations executed during test: 1,246 versioned transitions, 597 task creations, 537 completions, 60 cancellations (verified).
- `transition.versioned` latencies:
  - `n`: 1,246
  - `p50`: 6.5 ms
  - `p99`: 19.5 ms
  - `max`: 100.27 ms (verified).
- `CancelTask` client latencies:
  - JSON-RPC: `n=27`, `p50=24.3 ms`, `p99=39.8 ms`, `max=39.8 ms` (verified).
  - REST: `n=33`, `p50=22.9 ms`, `p99=42.4 ms`, `max=42.4 ms` (verified).
- Outlier reproduction: The 1,036.82 ms latency was **not reproduced** across 4 consecutive dumps (verified).

### Analysis and root-cause ruling
- **ACCESS SHARE table lock hypothesis**: **Ruled out**. In Postgres, `ACCESS SHARE` (acquired by `pg_dump` on tables) conflicts only with `ACCESS EXCLUSIVE` (e.g. `ALTER TABLE`, `DROP TABLE`). It does not conflict with `ROW EXCLUSIVE` locks taken by `INSERT`, `UPDATE`, or `DELETE`. Zero lock waits were recorded in `pg_locks` and zero lock waits appeared in Postgres logs (`log_lock_waits=on`) (verified).
- **Slow database query hypothesis**: **Ruled out**. Postgres logged zero statements exceeding 100 ms (`log_min_duration_statement=100`) throughout the entire 180 s run (verified).
- **Checkpoint sync correlation**: A timed checkpoint started at `09:10:49` and completed at `09:11:14` (write=24.95 s, sync=0.025 s), overlapping Dump #1. No query or transition exceeded 100.27 ms during this period (verified).
- **Probable mechanism**: The `transition.versioned` timer in `TimedBlock` measures wall-clock time on the Python process. In a virtualized WSL2 environment, initial Docker container fork/exec (`docker compose run`) can momentarily contend for host CPU/disk scheduling threads, causing a transient pause in the single-threaded asyncio event loop.
- **Verdict**: **Cause unverified**. Lock contention and database-level query pauses are ruled out; host-level scheduling pause is the probable cause, but since it did not reproduce under monitoring, it remains unverified.

---

## 5. Teardown verification

Executed full compose teardown: `docker compose down -v` and removed scratch networks.
Final system inspection:
- Containers (`docker ps -a`):
  - `memory-lookup-1` (Up 12 hours) (verified)
  - `memory-recall-1` (Up 12 hours) (verified)
  - 0 scratch containers (verified).
- Volumes (`docker volume ls`):
  - `memory_lookup_data`, `memory_recall_default`, `memory_recall_state`, and anonymous volume `1c1441a6...` (verified)
  - 0 scratch volumes (`sp5b_sp5b-pgdata` removed) (verified).
- Networks (`docker network ls`):
  - `bridge`, `host`, `memory_default`, `none` (verified)
  - 0 scratch networks (`sp5b_sp5b-net` removed) (verified).
- Ports:
  - `ss -ltn | rg '1813[0-2]'` returned 0 listeners (verified).

---

## 6. What Claude Code should change in the docs

- `plugins/coordination/docs/specs/server-api.md`:
  - Section 8.3: Document `a2a-coord db init-dump-role` as the host command using `docker compose exec -T postgres psql -U spike -d sp5b` over stdin with `SET log_statement = 'none';`. Confirm `dump_ro_password` is mounted only into the sidecar.
  - Section 5.1 & 3.5: Confirm `~` handle grammar (`card/name~sid8`) with regex `^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$` requires zero percent-encoding in query strings.
- `plugins/coordination/docs/specs/spikes.md`:
  - Section 8b ("SP5b follow-up"): Mark follow-up checks complete: (a) `init-dump-role` verified idempotent with rotation; (b) `~` separator evidence recorded; (c) D7 outlier investigated and classified as unverified (lock contention and slow queries ruled out).
- `plugins/coordination/docs/plans/implementation-plan.md`:
  - Mark task `S0-SP5B-FU` complete.

---

## 7. Independent check by Claude Code (2026-11-10)

Claude Code checked this file against the scratch logs in `~/scratch/a2a-spikes/sp5b/` (<workstation>-local, not in git). Labels in this section are Claude Code's: **verified** (read or observed by Claude Code), **reported** (agy's claim with no saved log), **unverified** (a guess).

### (a) `dump_ro` role through the host-command route (X2)

[verified] by Claude Code:
- The scratch script `~/scratch/a2a-spikes/sp5b/init-dump-role.sh` matches X2:
  - SQL goes over stdin through `docker compose exec -T postgres psql`.
  - `SET log_statement = 'none'` is set.
  - The role is created if missing.
  - `ALTER ROLE ... PASSWORD` sets the password.
  - `GRANT pg_read_all_data` follows.
- The compose file mounts the `dump_ro` secret only into the dump sidecar service; there is no init-script mount into Postgres.
- A scan of all saved logs for the secret value found 0 files.
- The sidecar produced four more dumps with 71 `pg_restore --list` entries each (`logs/d7_investigation_dumps.json`).
- All sp5b containers, volumes and networks are gone and ports 18130 to 18132 are free.

[reported] by agy, no saved log (the containers were removed before Claude Code looked; the only saved D7 log, `logs/d7.log`, belongs to the overnight run with 722 tasks):
- Idempotency over repeated runs.
- Password rotation with the old credential rejected.
- Restored row counts: 226 of 226 tasks and index, 210 sessions, 223 wakes, orphan tasks 0.
- The Postgres container log scan.

[design] These reported items are covered again by the real S1 exit tests of S1-PG and S1-BKP, which should assert:
- the command is idempotent on a fresh and on an existing volume
- rotation works and the old password is rejected
- the secret value is absent from container logs and process arguments
- restore row counts match

Verdict: PASS for the mechanism. Not gating.

### (b) Separator evidence for `~` (X1)

[verified] `logs/separator_tilde_evidence.json` records, for the handle `claude-code@<workstation>/c6-same~3f2a9c1d`:
- `curl` with the handle unencoded in a query string, quoted and unquoted, succeeds.
- `httpx` serialises `@` and `/` as `%40` and `%2F`, leaves `~` unchanged, and the server decodes the same string.
- JSON-RPC and REST `coord.to` succeed.
- The database insert and the exact select succeed.
- `~` cannot expand in a shell because names start with `[a-z0-9]`.

Verdict: PASS.

### (c) The 1,036.82 ms outlier (C2)

[verified] `logs/d7-investigate.out` shows, over 4 consecutive sidecar dumps under the 10x load, `transition.versioned` n=1246, p50 6.5 ms, p99 19.5 ms, max 100.27 ms. The 1,036.82 ms event did not reproduce. agy ruled out `ACCESS SHARE` lock contention (`pg_locks`) and slow queries (`log_min_duration_statement=100`: none over 100 ms).

[unverified] agy's hypothesis of a host-level scheduling pause under WSL2 is a guess.

Verdict: the cause remains UNVERIFIED. No further work is planned unless it recurs.

### Overall

The SP5b follow-up is complete and non-gating. The S1 entry gate is still NOT open: SP3 and SP4 are open.
