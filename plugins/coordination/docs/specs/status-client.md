# Status client contract: cognitive-engine to the coordination server

Status: DRAFT SPEC, planning only (2026-11-04). Implements binding decision 13 of the 2026-11-04 /clarify session. Nothing in this document is built. The cognitive-engine side is built only after stage S1 is live and only with an explicit user go.

Inputs:

- [`t2-cognitive-engine-integration.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t2-cognitive-engine-integration.md): reply from the `cognitive-engine` session. It read origin refs, not PR #13. Everything it says about the cognitive-engine repo is **reported**, not verified here.
- [`a2a-mcp-wake-audit-2026-11-04.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md): synthesis, section 5.
- A2A `TaskState` enum: **verified** in [`a2a.proto`](https://github.com/a2aproject/A2A/blob/4735f4876449c6f381825d8a841b31b16c6ad0c4/specification/a2a.proto#L187-L208) at commit `4735f48` (lines 187 to 208). The wire names carry the `TASK_STATE_` prefix (for example `TASK_STATE_INPUT_REQUIRED`); section 5 lists the seven this contract uses.

## 1. Purpose and direction

- **Purpose**: let the live coding-agent sessions (Claude Code, Antigravity) see, without asking the human, that a harness2 sweep exists, what phase it is in, and where its report is.
- **Direction is one-way**: cognitive-engine sends, the server stores. The server never sends anything back that a sender could act on, never offers cognitive-engine a task, and never reaches into cognitive-engine.
- **Not a coordination peer**: cognitive-engine has no Agent Card, no inbox, no handle, and no wake listener. Agent Cards belong to the long-lived harness sessions, not to cognitive-engine's contained short-lived sessions (T2, reported).
- **Not an approval path**: `stage1 run` requires a human to type an approval phrase on a controlling terminal, and the gate refuses pipes, scripts and agent environments (T2, reported). The status contract reports that gate's outcome. It can never trigger, replace or relay it.
- **Source of truth stays outside**: `audit.jsonl` (keyed by `run_scope`) and `report.json` remain authoritative. A status record is a pointer plus a state. If the two disagree, the audit log wins.

## 2. Who sends, and when

- **Sender**: `stage1` (harness2), after each sweep and at each lifecycle transition (section 5).
- **Where the client code lives**: an optional adapter package in the cognitive-engine repo, off by default, on the existing adapter seam next to `adapters/claude` and `adapters/antigravity`. The core stays free of network clients (T2, reported).
  - Package path is **unverified**. T2 says to check whether a deterministic-core rule exists beyond RFC 001 before naming a path. This spec uses `adapters/coordination` as a placeholder only (see open question Q1).
- **When it is built**: after S1 is live (see the exposure gates in the plan), and only with an explicit user go. Until then, nothing in cognitive-engine changes. The contract can be exercised by hand with `curl` against S1 (example in section 4).
- **Off by default**: the adapter is inactive unless both an explicit enable setting and an API key are present. Missing either means no network call at all, and no warning on every run.
- **Where it runs**: in the host-side `stage1` process only. It is never imported into, or reachable from, a model session (section 9).
- **API key** (decision 24; "token" is the retired word): scope `status-client`, issued by `a2a-coord key create --scope status-client --agent cognitive-engine --expires <dur>` (run inside the container, on core in production: `ssh core`, then `docker compose exec -it coordination a2a-coord key create ...`, over the unpublished admin socket, decisions 15 and 23; shown once, stored hashed by the server). Suggested label: `cognitive-engine@alyx`. The label appears in the server's audit log. It is not an Agent Card name.
  - In production the status client posts to core over the tailnet (decision 23). Where the cognitive-engine host is one of the user's machines, the key can carry the same tailnet node binding as a harness key (`--tailnet-node`, decisions 17 and 24); whether the binding is applied to `status-client` keys is not decided.
  - On the sender side the key lives in a mode-0600 file read by the host process, or in one environment variable of the host process, like any client key (decision 24). It is never written into a run dir, a report, an audit line, a sandbox mount or a chezmoi-managed file.
  - Loopback (S1) still requires the key (decision 11).
  - Proposal, not yet decided: `--allow-from <cidr>` on `key create` so a status-client key only works from `127.0.0.1/32` (S1) or the sender's tailnet address (S2). It overlaps with the tailnet node binding above; one of the two is enough.

## 3. Endpoint

- **`POST /status`** on the coordination server (port 8120, decision 5).
- **Auth**: `Authorization: Bearer <api-key>`. Only an API key with scope `status-client` is accepted. Constant-time compare, Host and Origin checks, as for every endpoint (decision 11).
- **A `status-client` API key can do exactly this one thing**: `POST /status`. It is refused with 403 on:
  - `/mcp`
  - `/wake/listen`
  - `/sessions`
  - `/a2a/v1`
  - any `GET`
- **Content type**: `application/json`. Maximum body 4 KiB (413 above that).
- **No Agent Card entry**: `/status` is not advertised in `/.well-known/agent-card.json`. It is not part of A2A.
- **Not routed at S3**: the public front door (the Cloudflare Tunnel on core, decision 20) forwards only `/a2a/v1` and the Agent Card path. `/status`, `/mcp`, `/wake/listen` and `/sessions` are never publicly routed. A status sender is always a local or tailnet machine, and in production it reaches core over the tailnet (decision 23); sbx model sessions still never reach the service on any address.

## 4. Request schema

Strict: unknown fields are rejected (422). All five fields are required.

| Field | Type | Rule |
| --- | --- | --- |
| `run_id` | string | 1 to 128 chars, `[A-Za-z0-9._-]`. Identifies one sweep run. |
| `run_scope` | string | 1 to 128 chars, same charset. The audit scope id used in `audit.jsonl`. |
| `state` | string | One of the seven values in section 5. A2A wire names. |
| `report_path` | string | Absolute path on the sender's host, 1 to 1024 chars, no control characters, no whitespace other than space, must not contain `://`. Pointer to `report.json` or its run dir parent. **Opaque to the server**: stored and echoed, never opened, resolved, fetched or normalised. |
| `ts` | string | RFC 3339 UTC with `Z`, the moment the transition happened on the sender. Rejected if more than 5 minutes in the future of the server clock. |

Fields considered and left out (add only with a stated need):

- **`sweep_id`**: left out. It would duplicate `run_id` or `run_scope`. The relation between those two is an open question (Q2). If a run has several scopes, the right fix is one post per scope, not a new field.
- **`harness`**: left out. The sender identity is the API key (label and scope). A self-declared `harness` string is untrusted data that adds nothing.
- **`seq`**: left out. Ordering uses `ts` plus the terminal-state rule in section 7. A counter would force the sender to persist state.
- **`reason` or free-text `detail`**: left out. Free text from a sweep is where prompts, model text and paths leak. If a reason code is wanted later, it must be a closed enum, for example `gate_refused`, `user_interrupt`, `budget_exceeded`.

Example (a sweep that just ended well):

```json
{
  "run_id": "h2s1-20261104T141207Z-3f9a",
  "run_scope": "h2s1-20261104T141207Z-3f9a-s0",
  "state": "TASK_STATE_COMPLETED",
  "report_path": "/home/rockad/.local/state/cognitive-engine/harness2-stage1/h2s1-20261104T141207Z-3f9a/report.json",
  "ts": "2026-11-04T14:31:55Z"
}
```

The identifiers above are illustrative. The real id format is an open question (Q2). The `report.json` location under `~/.local/state/cognitive-engine/harness2-stage1` follows T2 (reported).

Illustrative manual call, usable at S1 before any adapter exists:

```sh
curl -sS -m 3 -X POST http://127.0.0.1:8120/status \
  -H "Authorization: Bearer $COORD_STATUS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"run_id":"manual-1","run_scope":"manual-1-s0","state":"TASK_STATE_SUBMITTED","report_path":"/tmp/none","ts":"2026-11-04T14:00:00Z"}'
```

### Response

The response carries an acknowledgement and one numeric operational field, `dump_age_h` (hours since the last good database dump, [server-api.md](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/server-api.md) 3.6, round-2 decision R5, 2026-11-09). A status client may display it and a stale flag (older than 36 h). Before the first successful dump the field is `null` (round-3 decision R12, 2026-11-09, default applied by the assistant; the user may veto), so a client must accept `null` and show it as "no dump yet"; a mis-set `backup` compose profile (R14) shows up as a stale value, or as `null` if no dump has ever succeeded. Nothing else: no pending messages, no instructions, no text a model could mistake for a command.

```json
{ "ok": true, "run_id": "h2s1-20261104T141207Z-3f9a", "applied": true }
```

- **200**: accepted. `applied` is `false` for a duplicate, an out-of-order older update, or a post after a terminal state (section 7). Still 200, so the sender never needs to treat it as an error.
- **400**: malformed JSON.
- **401**: missing or unknown API key.
- **403**: API key valid but not scope `status-client`, or source not allowed.
- **413**: body over 4 KiB.
- **415**: wrong content type.
- **422**: schema violation. The response names the field, never echoes the offending value.
- **429**: rate limit (proposal: 60 posts per minute per API key). `Retry-After` is set.
- **5xx**: server fault.

## 5. State mapping

The sender maps the harness2 sweep lifecycle (T2, reported; refs `packages/harness2/README.md` near ExecutionGrant, `session_runner.py`, `sbx_session.py`) onto A2A states. Names are the A2A vocabulary only. The sender decides the state, the server does not drive it.

| Sweep lifecycle moment | `state` | Terminal |
| --- | --- | --- |
| Plan produced | `TASK_STATE_SUBMITTED` | no |
| Waiting for the typed approval phrase on the TTY | `TASK_STATE_INPUT_REQUIRED` | no (interrupted) |
| Sessions running | `TASK_STATE_WORKING` | no |
| Sweep ends, ok | `TASK_STATE_COMPLETED` | yes |
| Sweep ends, failed | `TASK_STATE_FAILED` | yes |
| Approval gate refused | `TASK_STATE_REJECTED` | yes |
| Human Ctrl-C | `TASK_STATE_CANCELED` | yes |

Rules:

- **Allowed values**: the seven above. `TASK_STATE_AUTH_REQUIRED` and `TASK_STATE_UNSPECIFIED` are refused with 422, because nothing in a sweep maps to them.
- **First post may be any state**: a gate refusal can happen before a plan is stored. If no `run_id` exists yet at that point, the sender must mint one for the refusal post (open question Q8).
- **`INPUT_REQUIRED` is a report, not a request**: it means "a human is being asked at a terminal". Nobody can answer it through the coordination server. No tool, endpoint or wake path resolves it.
- **Ctrl-C and teardown**: T2 reports teardown is non-interruptible. The `CANCELED` post is sent after teardown completes, within the timeout budget of section 8. On SIGKILL or a host crash no terminal post is sent. See staleness in section 6.
- **`COMPLETED` is not a clean bill of health**: it means the sweep ended without a failure. It says nothing about denials. Nothing in the status record may be read as "no denials" (section 10, R-18).
- **Minimum viable sender**: one post at sweep end with the terminal state. The full lifecycle (five posts per sweep at most) is the target.

## 6. How the server stores it: status records, not A2A tasks

**Decision**: store status as plain records in their own tables in the same SQLite file on the `a2a-data` volume (`/data`). Do not create A2A `Task` objects, and do not use `DatabaseTaskStore` for them. Do not create a `cognitive-engine@alyx` Agent Card.

Why not tasks under a card `cognitive-engine@alyx`:

- **A task implies a provider that takes work.** A card with tasks on it invites `SendMessage` to that card. Decision 13 says cognitive-engine never receives tasks. A card that exists but refuses everything is a misleading honest-card problem at S3 and a needless attack surface.
- **Tasks expose control operations.** The core operations include `CancelTask` and `SubscribeToTask`. A mirrored task would look cancelable. Cancelling a mirror would not stop a sweep, and a user or peer could believe it did. Any future wiring of such a cancel to the real sweep would be a second control path, which is forbidden.
- **Tasks are listed.** `ListTasks` on `/a2a/v1` would show sweep records to anyone with an `a2a` scope API key, including a remote peer, unless every listing path is filtered. A separate table cannot leak through an A2A listing.
- **The sender drives the state.** A2A task stores assume the server's own agent executor advances the state. Here a remote sender posts at-least-once, possibly out of order, so it needs upsert semantics with sticky terminals (section 7). Fitting that into the task store would fight it.
- **The cost of separate tables is small.** Two tables, a few dozen lines.

Why still use the A2A state names: a read-only A2A projection can be added later without a schema change, if the user ever wants sweeps visible through A2A tooling. That is not planned and would be local-scope only.

Tables (illustrative; the server's own SQLAlchemy models, so a Postgres URL change still works):

- **`status_runs`**: one row per `run_id`.
  - `run_id` (primary key), `run_scope`, `state`, `report_path`, `first_ts`, `last_ts`, `received_at`, `key_id`, `terminal` (boolean).
- **`status_events`**: append-only, one row per valid post.
  - `id`, `run_id`, `state`, `ts`, `received_at`, `key_id`, `applied` (boolean).
- **Retention**: proposal, keep events 90 days and runs 365 days. Pruning is a server job, not a sender concern.

Reads:

- **Local sessions** read through one read-only MCP tool, working name `a2a_runs`, behind the local-harness scope at `/mcp`. It lists recent runs with state, `run_scope`, `report_path` and `last_ts`.
- **No `GET /status`**. Decision 11 gives `status-client` write-only on `POST /status`, and `/status` has no read role defined elsewhere. Reads go through the MCP tool only. If a plain HTTP read is wanted later, it needs its own scope decision.
- **Rendering**: every field is untrusted data. The tool result frames it as data, like any inbound body. `report_path` is shown as text and never auto-opened, read or fetched by the server or suggested as an action.
- **Staleness is derived, not stored**: a run in a non-terminal state with `last_ts` older than a threshold (proposal: 6 hours, configurable) is displayed as `stale (no update since <ts>)`. The stored state is never rewritten to `FAILED` or `CANCELED` by the server, because the server cannot know what happened.
- **No wake on status**: default is silent. Local sessions notice runs when they call `a2a_runs` or when a human asks. If a wake is added later, it uses the constant stub only ("[a2a] N status updates") and carries no run data, per decision 10. T2 (reported) says a Stop-hook wake is acceptable for status as long as it never carries an approval or a command.

## 7. Idempotency and ordering (server side)

- **Duplicate**: same `run_id`, `state` and `ts` as a stored event. Returns 200 with `applied: false`. No second event row is needed.
- **Update rule**: a post is applied if the run has no terminal state yet and `ts` is not older than `last_ts`. Otherwise it is stored in `status_events` with `applied: false` and the run row is untouched.
- **Terminal is sticky**: after `COMPLETED`, `FAILED`, `CANCELED` or `REJECTED`, the run row never changes. A late `WORKING` from a retry cannot reopen a finished run.
- **Same `run_id`, different `run_scope` or `report_path`**: the first value stays. A conflicting later value is recorded in the event row only. This stops a later post from silently repointing a record at another path.
- **No server-side ordering guarantees across runs.**

## 8. Sender behaviour: fire-and-forget

The status post must never block, slow, fail or alter a sweep.

- **Never raises into `stage1`**: every call is wrapped. Any exception, timeout, DNS, TLS or HTTP error is swallowed and logged as one short line to the stage1 log (run id, state, HTTP status or exception class). The log line contains no API key, no body and no `report_path`.
- **Short timeouts**: connect 1 s, total 3 s per attempt, hard cap 3 s for the whole post including retry.
- **Off the critical path**: send from a daemon thread or after the phase it reports. The gating phases (typed approval, session start, teardown) never wait for the network. At most 2 posts are queued; a full queue drops the oldest non-terminal post.
- **Retries**: one immediate retry on connection error or 5xx, only if time remains in the 3 s budget. Never retry 4xx. Honour `Retry-After` only if it fits the budget; otherwise drop.
- **No spool, no persistence**: a lost post is acceptable because `audit.jsonl` is the source of truth. After 3 consecutive failures in one process the adapter skips non-terminal posts for the rest of the run and tries the terminal post once.
- **Terminal post is best effort, once**: sent after teardown, including on Ctrl-C. If the process is killed hard, nothing is sent and the run shows as stale.
- **Disabled means silent**: adapter off, no API key, or server down, none of these may change an exit code, a report or an audit line.
- **No new heavy dependency**: use the standard library HTTP client in `stage1` if the repo allows it (open question Q9).
- **No sweep behaviour reads the response**: nothing in the response body or headers is parsed except the status code. The response cannot influence the sweep.

## 9. What must never be sent

Allowed on the wire: the five fields in section 4. Nothing else, ever. Explicitly forbidden:

- **Prompts**, system prompts, task text, or any part of a proposer's input.
- **Model text**: completions, reasoning, tool-call arguments, error messages that quote them.
- **Transcripts**, session logs, run directory contents, diffs, file contents.
- **Credentials**: the OpenRouter key, the RFC 006 credential route, Claude or agy tokens, the status API key itself in any body or log, cookies, environment dumps.
- **Denial counts or any denial summary**. R-18 (T2, reported): `sessions_summary.denied_requests` counts path denials only, while model-pin denials live in `results/*/metrics.json`. No status field may carry it, and no server view may derive a "denied = 0" or "clean" indicator from the status data.
- **Free-text failure reasons**, stack traces, hostnames of sandboxes, sandbox ids, network policy details, budget figures.
- **Anything that identifies a model session** (sbx id, container id, session id).

Server-side guard: the schema is strict (unknown fields refused), values are length- and charset-bounded, and no field is ever interpolated into a prompt, a wake text or a command. A compromised sender can at worst store 5 bounded strings.

## 10. What the server must never offer back

- **No task intake**: `SendMessage`, `SendStreamingMessage` and all other A2A operations are unreachable with a `status-client` API key. No `cognitive-engine@alyx` handle or card is ever registered. Messages addressed to such a name are rejected (unknown agent), never queued.
- **No approval path**: nothing on the server resolves, grants or forwards an `INPUT_REQUIRED` for a sweep. No tool starts a sweep, schedules one, releases a gate, or writes into a sweep's run dir.
- **No return channel**: the `POST /status` response is the fixed acknowledgement of section 4 (plus the numeric `dump_age_h`). The server never pushes into a sweep, never returns pending items, never sets headers a client would act on.
- **No second approval path by wake**: wake text is a constant stub. A status record never produces a message to a session that says "approve", "run" or "execute".
- **Quarantine is separate**: the `a2a-coord review` release flow (decision 10) is for remote tasks. It does not touch status records, and there is no review of a status record because it carries no instruction.
- **Credentials and run data are not exposed through any server tool**: no tool reads cognitive-engine's run dirs, transcripts, config or credentials. The server never opens `report_path`.
- **Jev config tools are not proxied**: `jev_set_mode` and similar are never reachable through this server.

## 11. sbx network rule

- **Model sessions (sbx) must never reach `:8120` or `:8121`** (decision 13; the 8121 public listener is live on host loopback from stage s2, round-2 decision R8, 2026-11-09). T2 (reported): sandboxes reach exactly one host:port via a sandbox-scoped allow rule, and the coordination server must not be on that allow list.
- **Rules**:
  - The sbx allow list never names the coordination server, on any stage, any address (loopback, tailnet, public).
  - The status API key is held only by the host-side `stage1` process. It is not mounted into, passed to or readable from a sandbox. The RFC 006 credential rule applies: nothing the sandbox can read may contain it.
  - Model-written code must never reach the server (internal-only network plus filtering proxy, T2 reported).
- **Acceptance test (not yet run, needs the cognitive-engine session)**: from inside a real sbx session, a connection to the host's `:8120` or `:8121` fails on every address the sandbox can use for the host (loopback, docker bridge gateway, `host.docker.internal`-style names). At S1 the server listens on `0.0.0.0` inside its container and is published only on host `127.0.0.1:8120` ([server-api.md](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/server-api.md) 1.4). The acceptance test must also try the coordination container's own IP on its compose network and the Docker bridge gateway, and must confirm that sbx networks are not attached to the compose network. Whether any of these routes is reachable from an sbx session is unverified (open question Q6).
- **If the server ever sits in a container on a shared Docker network**: the sbx network must not be attached to it. Re-run the acceptance test after any network change.
- **Fuzz scope at S3**: `/status` is not publicly routed (section 3), so it is outside the S3 header-smuggling, request-splitting and SSRF fuzz pass for the public surface. The `report_path` field is stored opaque, with no server-side fetch, so SSRF through it is excluded by design. Still add one test that confirms the server never opens a path it was given.

## 12. Acceptance checks for the later implementation

- **Schema**: each rejected case in section 4 returns 422 and never echoes the value.
- **Scope**: `status-client` API key is 403 on `/mcp`, `/wake/listen`, `/sessions`, `/a2a/v1` and on `GET /status`. A `remote-peer` or `local-harness` API key is 403 on `POST /status`.
- **Idempotency**: replaying one post 10 times leaves one event row. A `WORKING` after `COMPLETED` is stored with `applied: false` and the run row unchanged.
- **Sender isolation**: with the server stopped, a full sweep run has the same exit code, report and audit content as with the adapter off. Timing difference stays under the 3 s cap per post, and no gating phase waits on it.
- **Leak test**: grep the stage1 log and the wire capture for the API key, any prompt text, and any `denied_requests` value. Zero hits.
- **No return**: nothing from the response reaches a session, wake text or tool result other than through `a2a_runs`, and that output carries only stored fields as data.

## 13. Open questions for the cognitive-engine session

- **Q1, deterministic-core rule**: is the rule that the core has no network clients written anywhere beyond RFC 001 (an RFC, a lint, a test)? What is the exact path for an optional adapter package, and does an existing adapter's packaging pattern (extras, entry points) apply?
- **Q2, ids**: what is the relation between `run_id` and `run_scope` in `audit.jsonl`? One scope per run, or one per session? What are the exact format and charset? The 128-char `[A-Za-z0-9._-]` rule is a guess.
- **Q3, hook points**: where in `stage1` and `session_runner.py` do the five lifecycle moments occur? Is there a code path that runs after teardown even on Ctrl-C, and what happens on SIGKILL?
- **Q4, report ordering**: is `report.json` written before the terminal post would be sent? Is its path absolute and stable? Is it per run or per scope?
- **Q5, host and credentials**: does `stage1` always run as a host process, never in a container? Where may a status API key file live without crossing the RFC 006 credential rule or being visible to any sandbox mount?
- **Q6, sbx reachability**: can an sbx session reach host loopback `:8120` by any route (bridge gateway, host-gateway alias, proxy)? Who runs the acceptance test in section 11?
- **Q7, sweep duration**: what is the typical and the worst-case sweep length, to set the staleness threshold (6 hours is a guess)?
- **Q8, gate refusal before a run exists**: does a run id exist when the approval gate refuses (pipe, script, agent environment)? If not, is minting one for a `REJECTED` post acceptable, or should the adapter skip that case?
- **Q9, HTTP client**: may `stage1` use the standard library client, or is any outbound network call from the host process restricted by a harness2 rule?
- **Q10, scope of the first release**: does the cognitive-engine session prefer the minimum sender (terminal post only) or the full five-post lifecycle?
- **Q11, PR #13**: T2 did not read BuildSlot (PR #13). Does BuildSlot (the `rootless-docker` slot) need its own status field, or should it stay out of this contract? This spec says out, because slots are enforcement, not coordination (T2, reported).

## 14. Open points on the server side

- **Retention and rate limit values** in sections 4 and 6 are proposals.
- **`--allow-from` on API keys** is a proposal that touches the key design in decisions 11 and 24; it overlaps with the tailnet node binding of decision 17.
- **Reads**: only through the `a2a_runs` MCP tool for now. The tool name and its output shape belong to the MCP surface spec, not this one.
- **Plain `GET /status`** is not defined and not planned.
