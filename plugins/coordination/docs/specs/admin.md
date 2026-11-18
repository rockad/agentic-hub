# Admin socket and `a2a-coord` as built (S1-ADMIN)

Status 2026-11-16: built on branch `feat/coordination-admin`, stacked on S1-AUTH, S1-STATE, S1-MCP and S1-A2A; not on `main` until the user merges it. Source: [`server-api.md`](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/server-api.md) 3.7 and 8.3; master plan section 4.2, heading S1-ADMIN; decisions D15, D17, D18, D19, D23, D24, Z14.

Labels: **spec** is written in `server-api.md`. **[design]** is a choice made where the spec is silent; any of it can change without reopening a decision. **[unverified]** was not run or read. **verified** means the test named next to it ran and passed.

## 1. What is in the code

Server side, `coordination/admin/`:

- `server.py`: `AdminServer`, the one `AF_UNIX` listener.
- `protocol.py`: the one-line JSON request and reply, the command list, the typed phrase.
- `ops.py`: the command table; every failure becomes a short `AdminError`.
- `keyadmin.py`, `keystore.py`: `key create|list|rotate|revoke`; the two table operations `ApiKeyStore` lacks (list, rotate).
- `review.py`: `review list|show|release|deny`.
- `status.py`: `status` and `card check`.
- `hooks.py`: what a key revocation closes besides the database write.
- `wiring.py`: `build_admin`, called by `build_server_app`.

Client side, `coordination/cli/` (was the single file `cli.py`; `coordination.cli:main` is unchanged):

- `__init__.py`: the parser, `main`, the command flows.
- `tty.py`: the real-terminal rules. `client.py`: the socket client. `render.py`: plain-text output.
- `db init-dump-role` (S1-PG) is kept as it was, still a host command that does not use the socket.

Wiring in files of other streams (minimal, and nothing else of theirs changed):

- `app.py`: `create_app(admin=...)` keeps the admin server on `app.state.admin`; `build_server_app` builds it and starts and stops it in its lifespan, after the cards are written to the `cards` table. If the socket cannot open, the exception stops the server: there is no fallback.
- `tests/mcp_helpers.py` and `tests/conftest.py`: the e2e tests that serve the real app now give it a writable socket path (`/run/a2a` exists only in the container), and one fixture makes a short socket directory.
- `auth/`, `mcp/`, `a2a/`, `service/` are untouched. `admin/keystore.py` subclasses S1-AUTH's stores and imports one private helper of `auth/store.py` (`_from_row`) so the row-to-record mapping stays in one place.

No table and no migration changed. Migration numbers m0003 to m0005 are unused by this stream.

## 2. The socket (spec 3.7, D15)

- Path `A2A_ADMIN_SOCKET`, default `/run/a2a/admin.sock`, on the tmpfs of `docker-compose.yml` (`mode=0700`, owned by the server user). The server creates the file mode 0600 (the umask is narrowed while it is bound) and removes it when the app stops. A stale socket file from a crashed run is replaced; a file that is not a socket is never touched and stops the start.
- One request and one reply per connection, each one JSON line (`protocol.py`), at most 256 KiB, 30 s to send the request. The reply is an object with `ok` and `result`, or `ok: false` and an `error` with a constant `code` and a message made of constants and identifiers. No trace, no SQL and no argument comes back. Requests and replies are never logged (a `key create` reply holds a secret); the log line is the command name, the outcome code and the duration.
- **No TCP, no HTTP route, no admin scope.** The only listener this code opens is `asyncio.start_unix_server`. Verified by `tests/test_admin_socket.py`: the server's sockets are all `AF_UNIX`; no file under `admin/` names `start_server`, `AF_INET`, `uvicorn` or a listen address; any `/admin...` path answers 404 for every method, with each kind of valid key and without one; `SCOPES` is the three scopes of spec 8.1. `tests/test_admin_pg.py::test_build_server_app_opens_the_socket_with_its_lifespan_and_serves_no_admin_route` repeats the 404 on the assembled app.
- The audit actor of an admin action is `admin:uid<N>` from `SO_PEERCRED`, or `admin` where the kernel gives none **[design]**. It says which operating-system user ran the command, not that a human did (spec 8.3 says the same of the terminal rules).

## 3. Commands

| command | needs a terminal | what it does |
| --- | --- | --- |
| `key create --scope S --agent A [--tailnet-node N] [--cards C...] --expires D` | yes | issue a key, print the secret once |
| `key list [--json]` | no | every key; never a secret or a hash |
| `key rotate KEY_ID [--grace G] [--expires D]` | yes | issue a replacement, print its secret once; the old key ends after the grace |
| `key revoke KEY_ID` | no | revoke now and close the key's live connections |
| `review [list] [--json]` | no | held tasks: id, peer, card, received, size; no body |
| `review show TASK_ID` | yes | the held body inside the untrusted frame |
| `review release TASK_ID` | yes, plus the typed phrase | `QUARANTINED` to `SUBMITTED` |
| `review deny TASK_ID` | yes, plus the typed phrase | `QUARANTINED` to `REJECTED`, reason `denied_by_human` |
| `status [--json]` | no | section 7 |
| `card check [--json]` | no | section 8 |
| `db init-dump-role` | no | host command, unchanged |
| `expose check`, `admin-apply` | no | say "not available at this stage" (S3-EXPOSE-CHECK, GL-IMPORT) and exit 2 |

Exit codes: 0 done; 1 refused or failed; 2 the server could not be reached, the database did not answer (`unavailable`), the command is not available yet, or the arguments are wrong. `card check` exits 0 with no problem and 1 with at least one, like `expose check`. `key revoke` exits 1 if a revoke hook failed (the key is revoked anyway).

`--json` on the read-only commands prints the server's answer. `key revoke` and the read-only commands are allowed without a terminal on purpose: they print no secret and no body, and an operator may script them.

## 4. Keys (spec 8.2, 8.3; D17, D18, D24, Z14)

Key generation, hashing and verification are S1-AUTH's (`auth.keys`); this stream only decides what may be issued.

- `--scope` is one of `local-harness`, `remote-peer`, `status-client`. There is no admin scope.
- `--expires` is required, `<n>d` or `<n>h`, at least 1 h. The ceiling is **365 days at `s1` and 90 days at `s2` and `s3`** (Z14). A larger value is refused, not clamped.
- `local-harness`: `--agent` is the owner card and must exist in the `cards` table (the cards file, loaded at start) **[design]**. `--tailnet-node` is required at `s2` and `s3` and optional at `s1`. `--cards` is refused.
- `remote-peer`: `--agent` is the peer label `^[a-z0-9][a-z0-9._-]{0,63}$` **[design]**; `--cards` is the allowlist and needs at least one existing card **[design]**; `--tailnet-node` is refused. Repeat `--cards` or separate with commas.
- `status-client`: `--agent` is a label (for example `cognitive-engine`); no cards, no node.
- `--tailnet-login` is not built (Z14): the option does not exist on the command line, and a request that carries it is refused.
- A failed audit write issues no key: the new record is withdrawn before the secret is shown **[design]**.
- `key list` row: key id, status (`active`, `expired`, `revoked`), scope, env, owner (card, peer or label), card allowlist, tailnet node, created, expires, last used, revoked. The row is built field by field, so the hash cannot get in; a test searches the listing for the secret, the hash and the token.
- `key rotate` (spec: "issue a replacement and let the old key expire after the grace period"): the replacement copies scope, owner, allowlist and node. The old key's expiry becomes the sooner of its own and now plus `--grace` (default 24 h; `0h` ends it now) **[design: the sooner-of rule]**. The replacement lives as long as the old key was issued for, never past the stage ceiling, unless `--expires` says otherwise **[design]**. The two writes are one transaction. A revoked or expired key cannot be rotated.
- `key revoke`: the access-control middleware reads the database on every request, so the key is refused at once. Then the revoke hooks run (section 6) and an audit row is written. A hook that fails is reported and does not undo the revoke.
- Audit rows: `key_created`, `key_rotated`, `key_revoked`, from S1-OBS, with the admin actor and the key id. No secret is in any row (verified, `test_admin_pg.py::test_key_lifecycle_over_the_socket_on_real_rows` searches the whole `audit` table).

## 5. Held tasks and the one release path (spec 8.3, D19)

- `review show` returns the held body inside the S1-MCP frame (`mcp.frame.build_frame`): control characters and escape sequences stripped, parts capped at 32 KiB and the result at 64 KiB, only `text/plain` and `application/json` inlined, URLs never fetched. The CLI strips control characters a second time and prints a header saying the text is untrusted data.
- **Typed phrase.** `release` needs `release <last 6 characters of the task id>`; `deny` needs `deny <last 6 characters>` **[design: the spec fixes only the first]**. The CLI reads it from `/dev/tty`. The server checks it too, so a request without the right phrase (a hand-written one on the socket, a stale client) does nothing. One task per request: there is no list argument, no `all`, no batch command and no option that skips the phrase.
- **The only code path that moves a held task to `SUBMITTED`** is `ReviewAdmin.release`, which calls `CoordinationService.release_hold`.
  - Static test (`tests/test_admin_release_path.py`, verified): parses every module under `src/coordination` and finds exactly one call of `release_hold`, inside `admin/review.py` `ReviewAdmin.release`; finds no other mention of the name (attribute, name or string); finds the `ADMIN` actor named only by `release_hold`, `deny_hold` and the transition table; checks that only the admin actor has a `QUARANTINED` to `SUBMITTED` row; finds one command name, `review.release`; finds that `mcp/`, `a2a/`, `auth/` and `wake/` never import `coordination.admin`.
  - Runtime test (`tests/test_admin_pg.py`, verified against the pinned Postgres image): the wrong phrase in many forms, the deny phrase, no terminal, an agent-session marker, hand-written socket requests (no phrase, a short id, an extra `all` field), a recipient's get, claim, respond and inbox, an originator's follow-up, a cancel and a TTL expiry leave the task held, cancelled or `REJECTED`, never `SUBMITTED`; then the exact phrase releases exactly that one task and writes `hold_released` and a `state_transition` row naming the admin actor.
- A task the sweep has rejected, or one that is not held, answers `invalid_transition`; the CLI says "no held task" first because `review.show` only finds held tasks.
- `review show` and `list` look at the oldest 200 held tasks; the quota is 20 held per peer (spec 3.3.2).

## 6. Revoke hooks (the WAKE hand-over)

`admin/hooks.py` is a registry: `server.hooks.register(name, fn)` where `fn(key_id)` returns the number of things it closed. `build_admin` registers `mcp` (S1-MCP's `McpSessions.drop_key`), so revoking a key drops its `Mcp-Session-Id` entries at once (verified, with a second key's session left alone).

**Handed to S1-WAKE:** `/wake/listen` does not exist yet, so nothing here parks or closes a listener. When WAKE builds the parked-listener table it registers `hooks.register("wake", table.close_key)` (reachable as `app.state.admin.hooks`), where `close_key` answers every parked request of the key with `403` and returns the count. The acceptance line "revoking a key closes its parked `/wake/listen` request (403)" is therefore half done: the MCP half is built and tested, the listener half is the hook WAKE registers. WAKE also passes `listener_count=` to `build_admin` so `status` can show parked listeners.

**Done by S1-WAKE (2026-11-18):** `build_server_app` registers `admin.hooks.register("wake", table.close_key)` and passes `listener_count=table.count`. Revoking a key answers its parked `/wake/listen` requests `403`, and `status` shows the parked count; both are tested in-process and over the real admin socket against a running server. See [wake.md](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/specs/wake.md).

## 7. `status` (spec 3.7)

Counts and identifiers only; no body, no secret, no hash. Fields, and what is filled today:

| field | source | today |
| --- | --- | --- |
| `sessions` | `sessions` table (registered, active within 15 min, ended, by card); `mcp_bound` is the in-memory `Mcp-Session-Id` map | real; the table stays empty until S1-ID registers sessions |
| `listeners.parked` | the parked-listener table | real since S1-WAKE (`null` only where `build_admin` is given no `listener_count`, as in the admin tests) |
| `pending` | `task_index` joined to the SDK `tasks` table: submitted, in a card queue, held, working, submitted by card | real |
| `budgets` | `wakes` table, last hour, against `A2A_WAKE_BUDGET_PER_H`, per handle | real; has rows since S1-WAKE writes one per wake |
| `stale_offers` | `SUBMITTED` tasks offered `A2A_REOFFER_MAX` times and still unconfirmed **[design: the meaning of "stale"]**, count and up to 20 ids | real |
| `schema` | `coord_schema_version` and the SDK's Alembic revision | real |
| `backup` | `dump_age_h` from the sidecar's `last_ok` file (`null` = unknown) **[design: an addition]** | real |

## 8. `card check` [design]

The spec names the command and nothing else. It is read-only and checks:

- every card in the cards file builds and says only what the server does: streaming off, push as `A2A_PUSH_ENABLED`, extended card advertised, the 60 s deviation sentence, interface URLs equal to `A2A_PUBLIC_URL` plus `/a2a/v1` and never the listen address, the tenant equal to the card id, the required fields present;
- every defined card is in the `cards` table (a card missing there needs a server restart);
- every live key's card and every card in a `remote-peer` allowlist is defined.

Output: `problems` (each makes the exit code 1) and `notes` (a card in the table that is no longer in the file, which spec 1.3 keeps on purpose; a defined card with no live session).

## 9. Terminal rules (spec 8.3, D10, D11, D19)

`key create`, `key rotate`, `review show`, `review release` and `review deny` refuse unless both standard input and standard output are a terminal (over `docker compose exec` that means `-it`) and no agent-session marker is set. The check runs before the socket is opened, so a refused command never reaches the server. The typed confirmation is read from `/dev/tty`, not stdin; with no controlling terminal the command refuses and does nothing.

- Marker: any environment variable whose name starts with `CLAUDE`, `ANTIGRAVITY` or `AGY_`, or is exactly `CI`, whatever its value (`CLAUDE_CODE_SESSION_ATTENDED=0` counts). The message names the variable, never a value. The Antigravity names are a guess that errs towards refusing **[unverified]**.
- `docker compose exec` does not pass the host environment into the container unless asked (`-e VAR`), so the marker check sees the container's environment. It is friction, not proof, as spec 8.3 says; the invariants of server-api section 9 do not rely on it.
- No `--yes`, no `-y`, no `--force`, no batch form, no "release all": the parser has none (a test walks every option of every command), and the two terminal functions take no "skip" parameter.
- Automated tests use a pseudo-terminal only under `tests/test_admin_pty.py`, only for refusals: a pipe on stdin, a pipe on stdout, each of five markers on a real terminal, and wrong phrases typed at `/dev/tty` (verified). The success paths are the user's, section 11.

## 10. Tests

- `test_admin_keys.py` (30): create rules, ceilings at each stage, rotate and grace, revoke and hooks, no secret in list or audit. In-memory, no Docker.
- `test_admin_socket.py` (16): mode 0600 whatever the umask, Unix only, stale socket, malformed requests, no admin route or scope.
- `test_admin_cli.py`: terminal and marker refusals for the five commands, the phrase, output, exit codes, the stubs.
- `test_admin_pty.py`: the refusals on a real pseudo-terminal.
- `test_admin_release_path.py`: the static half of the release-path acceptance.
- `test_admin_pg.py` (10): the CLI over the real socket against Postgres; the runtime half of the release path; status and card check on real rows; the assembled app.

## 11. Hand-run steps (the user; the real terminal paths)

Run from the host that runs the stack, with the stack up. Use a throwaway `--agent` card that exists in your cards file. Do not paste a secret on a command line or into a chat.

1. `docker compose exec -it coordination a2a-coord key create --scope local-harness --agent <card> --expires 30d`: the secret is printed once. Put it in a mode-0600 file. Run `... a2a-coord key list`: the key is there, no secret.
2. The same `key create` with `-T` instead of `-it`: it refuses and creates nothing. With `-it -e CLAUDE_CODE_SESSION_ATTENDED=0` it refuses and names the variable.
3. Make a held task: create a `remote-peer` key (`--scope remote-peer --agent <label> --cards <card> --expires 30d`), then send that peer's `SendMessage` to the card (key from a file with `curl -K -`).
4. `docker compose exec -it coordination a2a-coord review` lists it with no body; `review show <task-id>` shows the body under the untrusted-data header.
5. `review release <task-id>` and type something else: nothing happens. Type `release <last 6 characters>`: the task goes to `SUBMITTED` (`status` shows it under pending, `held` goes down). Try `deny` on a second held task with its own phrase.
6. Whether `/dev/tty` opens inside `docker compose exec -it`: **verified 2026-11-17**. The prompt appears there and the typed phrase is read.
7. `key rotate <key-id>` prints a new secret once; both keys work until the grace ends. `key revoke <key-id>`: the next call with that key is `401`, and an open `/mcp` session of that key is gone.
8. `docker compose exec coordination ls -l /run/a2a` shows `srw-------`; no port is published for the admin socket.
9. `a2a-coord expose check` says it is not available and exits 2.

**Hand run, 2026-11-17 (the user, rootless Docker, stage s1):** steps 1 to 9 all passed.
- The marker refusal names the variable.
- Two held tasks were made by a `remote-peer` key over REST.
- `review` lists no body. `show` frames the body as untrusted data.
- A wrong phrase leaves the task held; the exact phrase releases it (`status`: 1 submitted, 1 held). `deny` rejects with `denied_by_human`.
- After `rotate`, both keys work during the grace, and the old key expires 24 h out. After `revoke`, the old key gets `401` and the new one still works.
- Not exercised by hand: the revoke dropping an open `/mcp` session. No session was open (`closed: mcp 0`); the tests cover it.

## 12. Not done here

- Closing parked `/wake/listen` requests on revoke, and the parked count in `status`: done by S1-WAKE (section 6). `cli/render.py` still prints "(null until S1-WAKE)" beside the count; that text is stale and `cli/` was outside S1-WAKE.
- `expose check` (S3-EXPOSE-CHECK) and `admin-apply` (GL-IMPORT): named, not built.
- `--tailnet-login`: waits for the real identity source (S2-TS, Z14).
- `a2a-coord install` (S1-INST).
- The compose file is unchanged: `/run/a2a` was already a tmpfs.
