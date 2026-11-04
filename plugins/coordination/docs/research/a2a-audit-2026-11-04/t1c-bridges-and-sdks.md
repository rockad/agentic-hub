# T1c audit: MCP bridges, Docker Agent A2A server, official A2A SDKs

Date of audit: 2026-11-04. Method: shallow clones (depth 200) under `/tmp/claude-1000/-home-rockad-projects-agents-bridge/98480dc1-8bea-40bd-bd24-5519ebd285d6/scratchpad/audit/<owner>-<repo>`, read with `rg`/`fd`/`jq`/`gh api`. Nothing was built, installed or executed. No missing tools (`jq`, `rg`, `fd`, `gh` present). Labels: **verified** = read in the clone; **reported** = from README/docs/GitHub metadata only; **unverified** = not checked.

Spec note: the local spec clone `/home/rockad/projects/A2A` has a `LICENSE` byte-identical (sha1 2b8b8152...) to the a2a-python and a2a-js LICENSE files (verified). The user-facing names of the 11 core operations match the dispatcher tables of the SDKs below.

---

## 0. Headline findings

- hieuntg81/a2a-bridge does not exist.
  - `gh api repos/hieuntg81/a2a-bridge` returns 404; `curl https://github.com/hieuntg81/a2a-bridge` returns 404; the user `hieuntg81` exists with 33 public repos, none named a2a-bridge or similar (verified via `gh api users/hieuntg81/repos`). Repo search for "hieuntg81 a2a" returns nothing.
  - Likely private, deleted, renamed, or a wrong owner. Status: **unverified, unauditable**. Ask the user for the correct URL.
- Docker Agent's A2A server is a poor reuse base: its SQLite DB holds agent chat sessions, not A2A tasks. The A2A handler runs with the SDK default in-memory task store.
- mcp-a2a-bridge is a client-only MCP bridge; it has no A2A server. It also ships example adapters that spawn `claude -p` per task, which is the prohibited one-shot pattern if used as transport.
- GongRzhe/A2A-MCP-Server is archived and implements pre-1.0 A2A (`tasks/send`). Reject.
- Both official SDKs (Python, JS) cover all 11 operations and ship SQLite-capable persistent task stores. The Python SDK is the more mature persistent-store and multi-process story (versioned store with compare-and-swap plus a DB event stream, "cluster mode").
- No license riders found in any candidate (full Apache-2.0 / MIT texts, no Anthropic/Google/agent-restricting language; verified by `rg` over LICENSE files and README license sections).
- Recommendation: build on a2a-python (`a2a-sdk`), do not fork any bridge. Borrow patterns listed under each verdict.

---

## 1. TonPC64/mcp-a2a-bridge

- Identity and metadata
  - Repo: https://github.com/TonPC64/mcp-a2a-bridge (verified by `gh api`).
  - License: MIT, 21-line standard text, copyright 2026 TonPC64 (`LICENSE:1-21`, verified). No NOTICE file. README line 9 only references the MIT license. No riders (verified `rg` for anthropic/claude/restrict/prohibit in LICENSE returned nothing).
  - Language: Python >=3.11 (`pyproject.toml:5`), plus a React/Vite dashboard (`dashboard/`).
  - Size: GitHub size 1339 KB; about 12.9k lines including a lockfile and a PNG; src is roughly 1.9k lines of Python (`src/mcp_a2a_bridge/*.py`, verified by `wc -l`).
  - Tests: pytest suite in `tests/` (about 3.3k lines across ~16 files incl. `tests/test_integration.py` in-process A2A agent end-to-end) and vitest tests for the dashboard. Count of test functions not tallied.
  - Maintenance: created 2026-08-27, last commit 2026-09-04 (`45bc63a`), 83 commits, 0 stars, 0 forks, 0 open issues, no releases. Single-author, young, unproven.
- A2A spec version
  - Depends on `a2a-sdk[http-server]>=1.1,<2` (`pyproject.toml:9`) and imports `a2a.types.a2a_pb2` (`sqlite_task_store.py:12`, `client.py`): so it speaks the 1.0 protobuf-typed SDK (verified). Spec-version header handling is delegated to the SDK.
- Role and operations
  - Role: client only, for the MCP-facing package (`src/mcp_a2a_bridge/client.py`). It has no A2A server in `src/`.
  - Client operations used (verified `client.py:260-300`): SendMessage (via `client.send_message`, consumed as a stream, `consume_stream`), GetTask, CancelTask.
  - Not implemented: ListTasks, SubscribeToTask as an MCP tool, push-notification config CRUD, GetExtendedAgentCard. No push-notification support in the bridge (verified `rg push` in `src` hits nothing relevant). Polling model: `a2a_send_message` waits up to `timeout_s` (60 s) then returns `done:false` plus `task_id` (README:192-195).
- MCP transport and tools
  - Stdio only (`server.py:13`, `stdio_server`), with a "legacy stdio handshake" shim for MCP 2.0 hosts (`server.py:216-255`). No HTTP/streamable MCP.
  - Tools (`server.py:66-194`): `a2a_list_agents`, `a2a_send_message`, `a2a_get_task`, `a2a_cancel_task`, `a2a_add_agent`.
  - Agent registry is a JSON file with per-agent `url` and `headers` (so static `Authorization: Bearer` headers) (`config.py:24,75-102`; README:73-105).
  - Dashboard: separate FastAPI service, read-only, shared SQLite activity DB, optional bearer token, cookie login; README:250-275. HTTPS only via external reverse proxy (README:260-275).
- Spawns or wraps agent CLIs (examples only, not the core bridge)
  - `examples/run_claude_reviewer.py:178-225`: `asyncio.create_subprocess_exec(claude --bare ... -p ... --dangerously-skip-permissions --no-session-persistence)`. This is a one-shot `claude -p` spawn per task. Prohibited as a transport by AGENTS.md ("one-shot ephemeral subprocess execution is prohibited").
  - `examples/run_copilot_main_dev.py:65`: `copilot -p ... --allow-all-tools` one-shot.
  - `examples/run_codex_co_developer.py:156`: per-task subprocess.
  - `examples/run_codex_interactive_a2a.py:40-46`: `codex app-server --stdio`, a long-lived stdio process with a persistent thread. Closest to "live session" semantics, but it starts its own app-server process, not an existing TUI (README:174-176 says so explicitly).
  - No reference to `agy` / Antigravity anywhere in the repo (verified `rg -i "agy|antigravity"` over the tree returned nothing in code). DDR-003 not violated by the core bridge; the example adapters are the problem class DDR-003 forbids if copied.
- Persistence
  - `src/mcp_a2a_bridge/sqlite_task_store.py:15-109`: `SQLiteTaskStore(TaskStore)` storing protobuf bytes in a single `tasks` table with TTL plus LRU eviction. Implements save/get/list/delete against the SDK `TaskStore` ABC (verified).
  - Weaknesses (verified): `list` ignores all `ListTasksRequest` filters, pagination, status and context filtering (`:84-100`); a new `sqlite3.connect` per call under an `asyncio.Lock` (blocking IO on the event loop); no `PRAGMA journal_mode=WAL` in this store (WAL is only mentioned for the activity store, `activity_store.py:27`); no owner/tenant scoping. The examples that use it are only the Claude reviewer and Codex co-developer; the Copilot and Codex-interactive examples use `InMemoryTaskStore`.
- Auth: outbound static headers per agent; inbound auth for the dashboard only (bearer/cookie). The example A2A servers bind loopback with no token (README:170-178, 303).
- Docker: none (no Dockerfile or compose; `rg` for Dockerfile/compose returned nothing outside node_modules). launchd plists only.
- Verdict: **borrow pattern, do not adopt or fork.**
  - Borrow: the `TaskStore` subclass shape (a 100-line reference for the 4-method ABC), legacy-stdio handshake shim for MCP-version skew, the "send waits N seconds then returns task_id; poll with get_task" MCP ergonomics, the registry-with-headers model.
  - Reject for our case: client-only (no symmetric inbound path), stdio-only MCP, and the example adapters embody `claude -p` one-shot spawning.

---

## 2. GongRzhe/A2A-MCP-Server

- Identity and metadata
  - https://github.com/GongRzhe/A2A-MCP-Server, PyPI `a2a-mcp-server` 0.1.5 (`pyproject.toml:3`).
  - License: Apache-2.0 full text (`LICENSE`, 201 lines); no riders (verified). README:515 states `common/` is copied from google/A2A, also Apache-2.0.
  - Language: Python >=3.11; about 3.2k lines (`a2a_mcp_server.py` 1081 lines plus vendored `common/`).
  - Tests: none found (`fd -i test` returned nothing; verified).
  - Maintenance: **archived** (GitHub `archived: true`), created 2025-05-19, last commit 2025-06-18, 13 commits, 146 stars, 6 open issues, no GitHub releases found. Effectively dead.
- A2A spec version: pre-1.0 draft. `common/types.py:176-234` defines `tasks/send`, `tasks/sendSubscribe`, `tasks/get`, `tasks/cancel`, `tasks/pushNotification/set|get`, `tasks/resubscribe` (verified). None of the 1.0 method names (SendMessage, etc.) exist. Incompatible with spec 1.0.1 on the wire.
- Role and operations: client bridge (plus a vendored server skeleton in `common/server/`, not wired as our need). Of the 11 core ops, 0 are implemented under their 1.0 names; the legacy equivalents cover send, stream, get, cancel, resubscribe, push set/get; no ListTasks, no push list/delete, no extended card.
- MCP transport and tools: FastMCP; stdio, streamable-http, SSE via `MCP_TRANSPORT` env (README:54-56, 100-109). Tools (`a2a_mcp_server.py:310-754`): `register_agent`, `list_agents`, `unregister_agent`, `send_message`, `get_task_result`, `cancel_task`, `send_message_stream`.
- Spawns or wraps agent CLIs: no (`rg subprocess|os.system` returned nothing; verified).
- Persistence: JSON files (`persistence_utils.py`, `registered_agents.json`, `task_agent_mapping.json`) saved on exit and periodically (`a2a_mcp_server.py:78-89`). No task store interface, no SQLite.
- Auth: vendored `common/utils/push_notification_auth.py` (JWK/JWT for push); no inbound auth on the MCP server.
- Docker: `Dockerfile` (generated by Smithery; `python:3.11-slim`, `pip install -r requirements.txt`, EXPOSE 8000), `smithery.yaml`. No compose, no volume.
- Verdict: **reject** (archived, wrong protocol generation, no tests, JSON persistence).

---

## 3. hieuntg81/a2a-bridge (Go)

- **Not found.** See headline finding. All fields: unverified.
- Nearby Go results from repo search (not the requested candidate, not audited): `nisimpson/a2a-gateway-mcp` (1 star), `kaisoz/sam-a2a-bridge`, `deeparchi-ai/macs-chronicle-bridge-go`. Names only; not assessed.
- Verdict: **cannot assess; request the correct URL.** No recommendation depends on it.

---

## 4. Docker Agent (formerly cagent) A2A server

- Identity and metadata
  - Repo: https://github.com/docker/docker-agent (`gh api repos/docker/cagent` redirects to `docker/docker-agent`; verified). Docs source in-repo: `docs/features/a2a/index.md`, canonical https://docs.docker.com/ai/docker-agent/features/a2a/.
  - License: Apache-2.0 full text (`LICENSE`, 201 lines). `rg` for restrict/prohibit/anthropic found nothing beyond standard Apache wording. No riders (verified).
  - Language: Go (go 1.27 toolchain per Dockerfile `GO_VERSION="1.27.3"`); GitHub size about 90 MB.
  - Maintenance: very active; 4651 stars; 76 open issues; 3491 commits in the clone; releases v1.156.2 (2026-11-02), v1.156.1, v1.155.0, v1.154.0 (several per week) (verified `gh api releases`).
  - A2A tests: `pkg/a2a/*_test.go` (adapter, routing, resume limits, server security/invoke), `cmd/root/a2a_test.go`, `e2e/a2a_test.go` with recorded cassettes (verified file list).
- A2A spec version and operations
  - Built on `github.com/a2aproject/a2a-go/v2 v2.6.0` (spec 1.0) with ADK glue `google.golang.org/adk/v2/server/adka2a/v2` (`go.mod:16-17`, `pkg/a2a/server.go:12-24`; verified). `go.mod` also keeps the older `a2a-go v0.3.15` for the client-side tool (`pkg/tools/a2a`).
  - Server: `a2asrv.NewJSONRPCHandler(a2asrv.NewHandler(executor))` on a single `POST /invoke`, plus `GET /.well-known/agent-card.json` (`server.go:192-203`). Because it uses the SDK handler with no custom options, all handler ops are available through a2a-go (including push config and ListTasks), but nothing in docker-agent wires a persistent task store or push store (see persistence). Docs list limitations: tool calls not exposed as A2A events, no artifacts, no memory (docs lines "Current Limitations").
  - Card: `Capabilities{Streaming:true}`, one skill, `SupportedInterfaces` JSON-RPC only; **no `securitySchemes` or `security` declared** (`server.go:160-171`; `rg securitySchemes pkg/a2a` shows no server-side hit). So bearer auth is enforced but not advertised in the card, which is the gap we must close.
- Persistence (key finding)
  - `--session-db` / `sessionDBPath` (`cmd/root/a2a.go:51-56`) opens `sqlitestore.New` (`pkg/session/sqlitestore`, modernc.org/sqlite) and holds **docker-agent conversation sessions** (message history, workspace, safety policy), with a migration catalogue (`pkg/session/migrations.go`; docs describe migration 027 and `ErrNewerDatabase` downgrade guard).
  - The A2A layer itself runs `adksession.InMemoryService()` and the default in-memory a2a-go task store (`server.go:174-181`). A2A task state is therefore lost on restart; A2A `contextId` maps to a stored session, which is how resume works (docs "Resuming conversations").
  - So it is not a reusable persistent A2A task store. It is a useful example of a DB-migration discipline and context-to-session resume.
- Auth and TLS
  - `--auth-token` bearer; constant-time compare via `subtle.ConstantTimeCompare` (`pkg/httpsec/httpsec.go:16-29`, verified); applied as echo middleware to **all** routes including the agent card (docs: "for both agent-card discovery and JSON-RPC invocation").
  - Non-loopback listeners are refused unless `--auth-token` or `--insecure-no-auth` (`cmd/root/a2a.go:76-78`), a good fail-closed default. CORS allowlist with literal or `~regex` origins (`server.go:208-225`).
  - TLS: none in-process; the server builds `http://` base URLs (`server.go:90`, `baseURL` scheme "http"). TLS must come from a reverse proxy; the card URL would be wrong behind HTTPS without override.
- Container patterns
  - `Dockerfile` (multi-stage, xx cross-compile, static musl build, zig). `docker-compose.yaml` only starts Jaeger for tracing (verified); no compose service for the A2A server and no documented volume for the session DB.
  - Observability: otelhttp wraps card and invoke handlers for W3C trace propagation (`server.go:182-197`). Worth copying.
- Spawns or wraps agent CLIs
  - Yes, in a different feature: "Coding Harnesses" delegates to `claude`, `codex`, `opencode`, `pi`, `cmd` as sub-agents (`docs/features/harnesses/index.md:9-30`; `pkg/codingharness/claudecli.go:116-256` uses `exec.CommandContext` and `claude --print --output-format json`). That is one-shot CLI spawning (prohibited pattern for transport) and an orchestrator/sub-agent (master/dependent) model, which violates symmetric agency. No `agy`/Antigravity references (verified).
  - The A2A server itself hosts docker-agent's own agents (caller-to-agent), not peers; it has no mechanism to originate tasks to another peer except through a separate client tool (`pkg/tools/a2a`).
- Verdict: **borrow pattern only; do not adopt or fork.**
  - Borrow: fail-closed bind rule (`non-loopback requires token`), constant-time bearer middleware, CORS allowlist shape, otel propagation on card and RPC, versioned SQLite migration discipline with a newer-schema refusal, card client-side normalization of `securitySchemes` for older cards (`pkg/tools/a2a/card.go:54-91`, compat tests `compat_test.go`).
  - Avoid: copying its Go-only stack; its "session DB" is not a task store.

---

## 5. Official A2A SDKs

### 5.1 a2a-python (`a2a-sdk`)

- Metadata: https://github.com/a2aproject/a2a-python; Apache-2.0 (LICENSE byte-identical to the spec repo's; no riders); 2226 stars; 95 open issues; created 2025-05-09; last commit 2026-11-04 (`f666ba3`); **30 releases**, latest v1.3.0 (2026-10-27), cadence about one release every 1-2 weeks (v1.1.3 08-18, v1.1.4 09-08, v1.1.5 09-21, v1.2.0 09-29, v1.2.1 09-30, v1.2.2 10-05, v1.2.3 10-19, v1.3.0 10-27; verified `gh api releases`). Requires Python >=3.10 (`pyproject.toml:8`). release-please plus conventional commits.
- Spec version: A2A 1.0 native (protobuf types `a2a.types.a2a_pb2`), plus a v0.3 compat layer (`src/a2a/compat/v0_3/`, `PROTOCOL_VERSION_1_0`/`_0_3` in `utils/constants.py:31-32`). README has a v0.3 to 1.0 migration guide.
- 11 core operations (verified): `jsonrpc_dispatcher.py:115-125` maps all of SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask, CreateTaskPushNotificationConfig, GetTaskPushNotificationConfig, ListTaskPushNotificationConfigs, DeleteTaskPushNotificationConfig, SubscribeToTask, GetExtendedAgentCard. `RequestHandler` ABC has the 11 `on_*` methods (`request_handler.py:42-228`). Bindings: JSON-RPC, REST, gRPC (`routes/jsonrpc_routes.py`, `rest_routes.py`, `request_handlers/grpc_handler.py`); also a client with JSON-RPC/REST/gRPC transports (`src/a2a/client/transports/`).
- Server and client roles: both. This matters for symmetric agency: one process can host `AgentExecutor` + routes and also use `ClientFactory` to open tasks to a peer (`src/a2a/client/client_factory.py`, `card_resolver.py`).
- Persistence (verified)
  - `TaskStore` ABC: `save`, `get`, `list`, `delete`, all taking `ServerCallContext` (`tasks/task_store.py:7-32`).
  - Implementations: `InMemoryTaskStore`, `DatabaseTaskStore` (SQLAlchemy async; extras `sqlite` (aiosqlite), `postgresql`, `mysql`; `pyproject.toml` optional-dependencies; README:80), `DatabasePushNotificationConfigStore` (optional Fernet encryption via `encryption` extra), `CopyingTaskStore`.
  - `DatabaseTaskStore` first added 2026-04-20 (git log), so about 6 months old; `ListTasks` filters including legacy state values fixed in v1.3.0 (#1337).
  - Alembic migrations shipped in-package (`src/a2a/migrations/versions/*`, three revisions) with `a2a_db_cli.py` ("db-cli" extra); migration tests in `tests/migrations/`.
  - **Cluster mode** (`src/a2a/server/cluster/`, added 2026-09-29): `VersionedDatabaseTaskStore` with optimistic concurrency (CAS) and `DatabaseTaskEventStream` so any replica can send/subscribe/cancel (sample `samples/clustermode/README.md`: uses a shared file-backed SQLite by default, Postgres/MySQL via DSN). Directly relevant to our hooks/MCP-facade/server being separate processes sharing one DB.
  - Owner scoping: `owner_resolver.py` plus `owner` column (migration 6419d2d130f6); per-user task isolation.
  - Gap (verified `rg WAL|busy|check_same_thread` in `src` and `tests`: no hit): no SQLite PRAGMA/WAL/busy-timeout handling. We must configure the SQLAlchemy engine ourselves (WAL, busy_timeout, foreign keys) for a multi-process SQLite volume.
- Streaming and push
  - SSE via `sse-starlette` (extra `http-server`); streaming and SubscribeToTask dispatch at `jsonrpc_dispatcher.py:328-385`.
  - Push: `BasePushNotificationSender` with per-config auth headers/token (`base_push_notification_sender.py:199-205`); SSRF screening is **opt-in** (`push_url_validator=None` default; pass `validate_push_notification_url` from `a2a.utils.push_url_validator`) (`default_request_handler.py:121-127`). We must enable it before HTTPS exposure.
  - v1.3.0 adds `interrupted_task_timeout` to release parked `input-required` tasks (`default_request_handler_v2.py:110-145`), relevant to idle-session waits.
- Auth
  - Server: SDK does not authenticate; it builds a `ServerCallContext` with `user`, `tenant`, `state` from the Starlette request (`routes/common.py:77-109`, `server/context.py:14-25`). Auth is a Starlette `AuthenticationMiddleware` we supply; declare `securitySchemes`/`security` on the `AgentCard` ourselves. `GetExtendedAgentCard` supported with `extended_agent_card` and `extended_card_modifier`.
  - Client: `AuthInterceptor` and `CredentialService` (`client/auth/`), plus agent-card signing (`signing` extra, `samples/agent_card_signing.py`).
  - TLS: none in-process; run behind a reverse proxy.
- Tests and quality: 112 test files, about 1700 test functions (`rg` count of `def test_`; approximate), suites for server, client, compat, routes, migrations, cluster, plugins; CI includes unit tests, TCK (`tck/`, `.github/workflows/run-tck.yaml`), ITK (`itk/`), ACTS, security, spelling, install-smoke workflows (verified file list). Plugin system (`src/a2a/plugins/`) with request-handler hooks.
- Docker: SDK repo has no Dockerfile. Cluster sample uses subprocess replicas (`run_cluster.py`). Container and volume are ours to author.
- Verdict: **adopt as the build base.**

### 5.2 a2a-js (`@a2a-js/sdk`)

- Metadata: https://github.com/a2aproject/a2a-js; Apache-2.0 (LICENSE identical to spec repo; no riders); 649 stars; 62 open issues; created 2025-05-27; last commit 2026-10-27 (`9a28d50`); 302 commits; releases v1.0.0-beta.0 (2026-07-01), v1.0.0 (07-22), v1.0.1, v1.1.0 (08-26), v1.2.0 (09-18), v1.2.1 (09-24), v1.3.0 (09-29). 1.0 GA is about 3.5 months old. Node >=20 (`package.json` engines).
- Spec version: 1.0 native (`A2A_PROTOCOL_VERSION='1.0'`, `constants.ts:13`), v0.3 compat layer (`docs/compatibility-v0_3.md`), `A2A-Version` header dispatch (CHANGELOG 1.2.1).
- 11 core operations (verified): `A2ARequestHandler` (`src/server/request_handler/a2a_request_handler.ts:24-64`) has `getAuthenticatedExtendedAgentCard`, `sendMessage`, `sendMessageStream`, `getTask`, `cancelTask`, `createTaskPushNotificationConfig`, `getTaskPushNotificationConfig`, `listTaskPushNotificationConfigs`, `deleteTaskPushNotificationConfig`, `resubscribe` (= SubscribeToTask), `listTasks`. All 11. Transports: Express JSON-RPC and REST handlers (`src/server/express/`), gRPC (`src/server/grpc/`). Server and client both.
- Persistence: `TaskStore` interface; `InMemoryTaskStore` (`src/server/store.ts:48`); **`DatabaseTaskStore` and `DatabasePushNotificationStore` via Kysely, added only in v1.3.0 (2026-09-29, one month old)** (`src/server/database/task/store.ts:64`, `push_notification/store.ts:48`; CHANGELOG 1.3.0). SQLite via `better-sqlite3` (tested on 12 and 13), also Postgres and MySQL, D1 via community dialect (`docs/persistent-stores.md:10-38`). Migration CLI (`a2a-db`; tests in `test/cli/`). DatabaseTaskStore integration test with the request handler was only added 2026-10-27 (#800). No equivalent of Python's cluster mode (versioned CAS store and DB event stream): `rg cluster|versioned` in `src` finds nothing relevant; the event bus is in-process (`events/execution_event_bus*.ts`). So a second process (hook CLI, MCP facade) cannot observe or cancel a live stream through the SDK; only through DB polling.
- Streaming/push: SSE in the handlers; push sender with serializers and auth headers (`default_push_notification_sender.ts:199`); SSRF validation: none found in the sender (`rg ssrf|private|allowlist` no hit), left to the app (unverified depth).
- Auth: `UserBuilder` callback per request (`express/common.ts`, `UserBuilder.noAuthentication` default shown in docs), `owner_resolver.ts` for ownership; client has interceptors and `jose` is the only hard dependency (agent-card signing). TLS: via proxy.
- Tests: about 1560 `it(`/`test(` cases in 83 spec files (approximate `rg` count), vitest unit, integration, edge-runtime configs; TCK/ITK/ACTS workflows (verified workflow list).
- Docker: none in repo.
- Verdict: **credible alternative, not chosen** (see section 7).

### 5.3 a2a-go (`github.com/a2aproject/a2a-go/v2`)

- https://github.com/a2aproject/a2a-go; Apache-2.0; 498 stars; 37 open issues; created 2025-05-30; last push 2026-11-04; releases v2.7.0 (2026-10-21), v2.6.0 (09-25), v2.5.0 (08-18), v2.4.0 (07-28), v2.3.1 (05-13); Go >=1.26 (`go.mod:3`). README states A2A v1.0 spec, gRPC/REST/JSON-RPC.
- Operations: handler interface has all of GetTask, ListTasks, CancelTask, SendMessage, SubscribeToTask, SendStreamingMessage, Get/List/Create/Delete TaskPushConfig, GetExtendedAgentCard (`a2asrv/handler.go:43-66`; verified). Client in `a2aclient/`, compat in `a2acompat/`.
- Persistence: `a2asrv/taskstore` has in-memory in the library; a SQL task store exists only in `examples/clustermode/server/taskstore.go` (`newDBTaskStore(db *sql.DB, ...)`); also work-queue/lease/heartbeat abstractions (`a2asrv/workqueue`) for distributed execution. 96 test files. Mature and actively released.
- Fit: our codebase is Python/uv; Go would be a language fork of the stack. Docker Agent proves production use of a2a-go v2. Not chosen.

### 5.4 a2a-rs (`a2a-lf` crates)

- https://github.com/a2aproject/a2a-rs; Apache-2.0 (`LICENSE.md`); 110 stars; 52 open issues; created 2026-04-03; Rust 1.85+, edition 2024; workspace crates `a2a-lf 0.4.x`, `a2a-server-lf 0.5.x`, `a2a-client-lf 0.2.x`, grpc, SLIMRPC (`Cargo.toml`, README:12-60).
- Bindings: JSON-RPC, REST, gRPC, SLIMRPC; SSE; axum server; own TLS module (`a2a-server/src/tls.rs`).
- Persistence: `TaskStore` trait (`a2a-server/src/task_store/store.rs:19`, versioned create returning `TaskVersion`) but only `inmemory.rs` is shipped (verified file list). No SQLite store.
- Maturity: about 7 months old, 0.x crate versions, in-memory only. Not suitable. Operation coverage per method not verified.

---

## 6. Constraint check summary

| Candidate | Licence riders | agy launched/wrapped | Spawns CLIs one-shot | Symmetric agency possible |
| --- | --- | --- | --- | --- |
| TonPC64/mcp-a2a-bridge | none (MIT) | no | examples: `claude -p`, `copilot -p`; core bridge none | client-only core; servers only via example adapters |
| GongRzhe/A2A-MCP-Server | none (Apache-2.0) | no | no | client-only, obsolete protocol |
| hieuntg81/a2a-bridge | not assessable | not assessable | not assessable | not assessable |
| docker/docker-agent | none (Apache-2.0) | no | yes: harness feature runs `claude --print` | no: orchestrator/sub-agent model, server hosts its own agents |
| a2a-python / a2a-js / a2a-go / a2a-rs | none (Apache-2.0) | no | no | yes: SDKs provide both server and client |

- Violations found (each is a finding for the plan):
  - mcp-a2a-bridge examples and docker-agent harnesses use one-shot `claude -p`/`--print` spawns: prohibited as transport; do not copy those files.
  - docker-agent harness model is master/dependent: violates symmetric agency as an architecture, not as a library.
- No candidate violates the licensing rule or references `agy`.

---

## 7. Build-base recommendation

Recommendation: **build a new server on a2a-python (`a2a-sdk` >=1.3, extras `http-server`, `sqlite`, `signing`, optionally `telemetry`), do not fork any bridge.** Implement the MCP facade as a separate thin MCP server (or same process, second route) that calls the A2A server through the SDK client or the shared handler.

Comparison

| Criterion | a2a-python | a2a-js | a2a-go | a2a-rs |
| --- | --- | --- | --- | --- |
| 11 core ops (server) | yes, verified | yes, verified | yes, verified | not verified |
| Spec 1.0 native | yes (+0.3 compat) | yes (+0.3 compat) | yes | yes (per README) |
| Persistent task store (SQLite) | `DatabaseTaskStore` (aiosqlite), 6 months | `DatabaseTaskStore` (better-sqlite3 via Kysely), 1 month | example only | none |
| Push-config persistence | DB store with optional encryption | DB store | store interface | in-memory only |
| Multi-process correctness | versioned CAS store + DB event stream (cluster mode) | none; in-process event bus | work-queue and lease abstractions | none |
| Migrations | Alembic, `a2a-db` CLI | `a2a-db` CLI | n/a | n/a |
| Streaming (SSE) | yes | yes | yes | yes |
| Push notifications | yes; SSRF validator opt-in | yes; no validator found | yes | yes |
| Auth model | Starlette middleware -> `ServerCallContext`; client `AuthInterceptor`; card signing | `UserBuilder` callback; client interceptors; jose | middleware/interceptors | middleware |
| Test breadth | about 1700 tests, TCK/ITK/ACTS | about 1560 tests, TCK/ITK/ACTS | 96 test files | newer, smaller |
| Release maturity | 30 releases; weekly cadence | 7 releases since 1.0.0-beta | 2.x, monthly | 0.x |
| Language fit | Python/uv, same as cognitive-engine | TypeScript/Bun (Node-targeted, better-sqlite3 native addon) | Go | Rust |

Reasons

- Multi-process SQLite is the decisive requirement. Hooks that wake idle sessions, the MCP facade, and the server will be separate processes. Only a2a-python ships the versioned task store (CAS) and DB-backed event stream so a subscriber or canceller in another process works against one SQLite file (`src/a2a/server/cluster/`, `samples/clustermode/README.md`). a2a-js has no equivalent.
- Persistence is older and deeper in Python: DB task and push stores, owner scoping, Alembic migrations with tests, encryption for stored push credentials.
- Language fit: cognitive-engine is Python/uv; reuse of its models/tooling, one `uv`-managed container image, and the same test runner. Bun cannot load `better-sqlite3` (native addon) without caveats; this was not tested here (unverified), so treat as a risk, not a fact.
- Symmetric agency is supported in one process: `AgentExecutor` + routes (server) and `ClientFactory` (client) coexist in a2a-python.
- JS is a legitimate second choice if the MCP facade must be TypeScript, since the facade can be a client-only consumer of either server over HTTP; the wire contract is the same.

Gaps to build ourselves on a2a-python (verified as absent in the SDK)

- SQLite hardening on the SQLAlchemy engine: `journal_mode=WAL`, `busy_timeout`, `synchronous`, single volume path; test with concurrent writers (no WAL/busy handling in the SDK).
- Inbound auth middleware (bearer/API key or mTLS-at-proxy) and matching `securitySchemes`/`security` entries in the Agent Card; docker-agent shows the fail-closed bind pattern and constant-time compare; neither SDK advertises auth in the card for us.
- Push URL SSRF policy: pass `push_url_validator=validate_push_notification_url` (default is off).
- Hook-wake mechanism: nothing in any candidate wakes a live idle Claude Code or Antigravity session; that is our own design (consistent with DDR-003: no launching or driving `agy`). The cluster event stream can feed a long-poll or SSE endpoint the hooks read.
- Reverse-proxy TLS: card `url`/`supportedInterfaces` must carry the public HTTPS origin (docker-agent builds `http://` card URLs from the listener; watch for the same trap).
- Version pinning: the SDK releases roughly weekly and cluster mode is only 5 weeks old; pin exact versions, track the CHANGELOG, and run the SDK's TCK against our server in CI.

Items worth borrowing from other candidates

- From mcp-a2a-bridge: the "wait up to N seconds then return task_id" MCP tool semantics and the legacy-stdio MCP handshake shim.
- From docker-agent: otel propagation on card plus RPC, constant-time bearer middleware, CORS allowlist, migration-numbered SQLite schema with newer-schema refusal, client-side normalization of older cards' `securitySchemes`.

Open questions for the user

- Correct URL for the hieuntg81 Go candidate (404 as given).
- Whether the MCP facade must run in the same container as the A2A server (shared SQLite file) or in each session's host (then it is an HTTP client only).
