# Go-live migration: frozen file channels into the plugin store

Status: PLANNING ONLY. Written 2026-11-04. Nothing in this document is built, and nothing in `~/.agents` was modified while writing it (read-only inspection).

Scope: implements decision 7 of the 2026-11-04 /clarify session, with the timing and exception set by decision 14 of the same day's /cplain session. The file channels are frozen. **Go-live is after S3 (the public stage)**, not after S1. Until then the channel stays frozen with one exception: Antigravity may still use it for research on this work. After S3, a one-time migration imports them into the coordination store, a tar backup of the originals is taken, and the channel files are deleted.

Build timing (decision 36, 2026-11-05): the importer (GL-IMPORT) is built during S2 and S3 against copies of the channel files, so it is ready when S3 exits. The S3 final gate (FG) covers the server and the importer together; there is no separate go-live gate. After S3 exit the order is: dress rehearsal (GL-REHEARSE), the user's go, the real import (GL-APPLY), then retirement (GL-RETIRE). Because Antigravity may append research messages after the copies were taken (decision 14), the importer must tolerate messages appended after the freeze, and the dry run is rerun at go-live on the live files.

Timing consequences (decision 14):

- The server is live at S1, S2 and S3 before this migration runs. The migration is the last step of the roadmap, not an S1 follow-on.
- The channel files can grow between now and go-live, because Antigravity may append research blocks. Every number in section 10.2 is a 2026-11-04 measurement and must be re-measured at go-live. The parser treats those late blocks like any other (same fence grammar, section 4).
- Late Antigravity appends are expected, not "post-freeze appends". The freeze instant for the import (section 2, open point 1) is therefore the start of go-live day, when the user tells Antigravity to stop.

Related documents:

- [Evidence synthesis](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md)
- [Consolidated plan with DDR-001 to DDR-004 and decisions 1 to 22](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/plans/consolidated-bridge-v2-plan.md)
- [Master tasklist](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/plans/master-tasklist.md)
- [a2a-python and bridges audit (TaskStore, DatabaseTaskStore)](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1c-bridges-and-sdks.md)

Evidence labels used below:

- `[verified]`: measured by reading the files on <workstation>-wsl on 2026-11-04.
- `[inferred]`: my reading of the evidence, not directly stated anywhere.
- `[reported]`: taken from the audit documents, not re-checked here.
- `[unverified]`: needs a spike or a user answer.

## 1. What this is and what it is not

- It is a one-time, idempotent, reviewable import of historical messages. The history becomes searchable A2A data.
- It is not a live bridge. Imported data never reaches a session as work: no wake, no inbox entry, no re-offer (section 6.4).
- It is a CLI subcommand, `a2a-coord import-channels`, written at go-live. It is not written now, and this document does not authorise any code.
- Bodies in the old channel are untrusted data like any other body (decision 10). Old instructions inside them ("to: claude, do X") are history, never commands.

## 2. Preconditions (the go-live gate for this migration)

- The S3 exit gate has passed (decision 14) and the user declares go-live. The server runs with the spikes done and the store in the compose project's Postgres service (named volume `a2a-pgdata`, user decision 2026-11-09 D-A, replacing the earlier SQLite file on `a2a-data`); the import goes through the in-container admin socket (section 7).
- Between 2026-11-04 and go-live the channel is frozen for everyone except Antigravity's research use (decision 14). On go-live day the user stops that too. The last write seen on 2026-11-04 was the final block of the coordination channel (conversation `01VA3JtCyASmfR8Q7Vcvehe7`, message 1, 14:22:23+02:00) `[verified]`; later blocks are expected.
- The user records the exact freeze instant in the run manifest (open point 1). Blocks that begin after it are reported as post-freeze appends. Blocks between 2026-11-04 and the freeze instant are ordinary imported content.
- No watcher is running (section 11). A running watcher is only a warning, but a stale one should be stopped before deletion.
- Explicit user go for the apply step, and a second explicit go (typed, on a real TTY) for the deletion step.
- Dress rehearsal done on a scratch store (section 12) before touching the real database.

## 3. Inventory and scope

Inventory of `~/.agents` on 2026-11-04 `[verified]`:

| File | Size (bytes) | What it is | Decision |
| --- | --- | --- | --- |
| `bridge-v2-coordination-channel.md` | 146056 | Live channel, 51 fenced blocks, 2026-11-03 13:50 to 2026-11-04 14:22 | IN SCOPE |
| `antigravity-claude-bridge-cognitive-engine.md` | 177834 | Live channel, 65 live fenced blocks plus 3 archived blocks, 2026-10-28 to 2026-11-03 | IN SCOPE |
| `cognitive-engine-bridge-turns-archive-2026-10.md` | 50249 | Older transcript in a different format ("### Turn N"), 10 turns, no conversation ids, no year | OUT (default) |
| `handoff/*.md` (3 files) | 3624 to 6274 | Kickoff prompts for fresh sessions | OUT |
| `cognitive-engine-tasklist.md`, `bridge-v2-coordination-tasklist.md` | 44763, 8768 | Hand-edited trackers | OUT |
| `agent-bridge-protocol.md` and the `bridge-v2-*-draft.md` files | various | Protocol notes and spec drafts (already copied into this repo as specs and research) | OUT |
| `session-registry.json` | 1573 | Two-entry registry of transcript paths (2026-10-28) | OUT, retire (section 11) |
| `watch-bridge.sh` | 1278 | Old watcher | OUT, retire (section 11) |
| `cognitive-engine-docker-tests.lock` | 0 | Docker/GPU contention lock | OUT, keep: BuildSlot (DDR-001..003 scope) is still in force |
| `cognitive-engine-stage*.md`, `cognitive-engine-wsb-threat-model.md` | various | cognitive-engine design notes | OUT |

Why each OUT decision:

- Turns archive: no author id, no conversation id, no year, no message numbers. Parsing it would need a second, guess-based parser for a file that is already an inert archive. It stays on disk, is included in the backup tar as a courtesy, and is not deleted by this tool. Optional later import is open point 2.
- Handoff prompts: documents addressed to a future session, no delimiters, no author, no per-message timestamp. They are not messages. The old watcher also counted files in that directory, so the mechanism retires with the watcher, but the files themselves are the user's to keep or delete.
- Tasklists and drafts: living documents, not a message stream. Their content is either already in this repo or is cognitive-engine's own tracker.
- `session-registry.json`: only two agent entries from 2026-10-28. The importer does not need it, because author and conversation id are in every fence. It is superseded by `POST /sessions`.

Two regions inside one in-scope file need a rule:

- `antigravity-claude-bridge-cognitive-engine.md` has a section `## ARCHIVE (inert copy of the blocks exchanged in the old hub file; fences indented, not counted)` at line 16, ending at `## LIVE BLOCKS` at line 127 `[verified]`. It holds 3 blocks (claude 317124a3 messages 1 and 2, antigravity 0e89deec message 1) with a 4-space indent.
- Default: import them, flagged `region: archive`. They are the only on-disk copy of those messages in the live file, and live `reply-to` fields point at them (for example `claude:317124a3-...:1`).
- Flag `--no-archive-region` skips them. Their reply-to targets then stay unresolved.

## 4. Observed format and the quirks the parser must tolerate

Fence grammar as actually used `[verified]`:

- Begin: `---<author> conversation <conv-id> message <n> [reply-to <harness>:<conv-id>:<m>[,<m2>...]] begin <ISO-8601>---`
- End: `---<author> conversation <conv-id> message <n> [reply-to ...] end <ISO-8601>---`
- Fences start at column 0 in live regions. All 119 observed timestamps carry the offset `+02:00`.
- First body line is `to: <list>`. Second line is usually `about: <one line>` (111 of 116 live blocks); 5 blocks in the cognitive channel use `status:` there instead. A `MODEL SERVING:` line appears inside the body of 63 blocks and is kept as body text.
- Observed `to:` values: `claude`, `antigravity`, `all`, and comma lists such as `antigravity, all`, `claude, all`, `antigravity, claude`.
- Authors observed: `claude` and `antigravity`. The watcher script accepts any `[a-zA-Z0-9_-]+`, so the parser accepts the same class.

Quirks measured on 2026-11-04 `[verified]`. The parser must handle each without failing:

- The end fence drops `reply-to` in 36 blocks (30 coordination, 6 cognitive). The begin fence is authoritative.
- Begin and end timestamps differ by 30 seconds in 4 blocks (conversation 0e89deec, messages 15 to 18). Both are kept.
- Begin timestamps are not monotonic once in the cognitive channel (12:54:49 after 12:55:00 on 2026-10-29). File order is the sequence; timestamps are data.
- `reply-to` can list several message numbers (`...:4,5`, `...:8,9`, `...:12,13`).
- `reply-to` can point into the other channel file. Examples: `claude:012hq2t73Akvdk6rcqPug6ea:8` and `antigravity:8343b610-...:26` are cited from the coordination channel but live in the cognitive channel.
- Message numbers have gaps: conversation 0e89deec has no 12 to 14 and no 25 to 28 in the files, and 317124a3 has no 16. Gaps are reported as information, not errors.
- The pair (conversation, message number) is not unique across files: antigravity 0e89deec message 2 exists in both channels with different content. The idempotency key therefore includes the source file.
- `to:` can contain several recipients, and some blocks address `all`.
- Fence-looking lines at deeper indent (rule examples, the archive section) are inert text and are never fences.
- No CRLF, no NUL, no fence inside a ``` code block at column 0, and no stray text between blocks were found `[verified]`. The importer still checks for all of them.
- Largest block 8087 bytes, total body bytes 131987 (coordination) and 148249 (cognitive) `[verified]`.
- A scan of both files for four credential patterns (`sk-or-`, `ghp_`, `AKIA...`, PEM headers) found no match `[verified]`. The words "token" and "secret" appear only in discussion. The importer repeats a scan and refuses to import a block that matches (section 7).

## 5. Parse rules

Inputs: a fixed profile per channel file, not discovered at run time. The profile names the file, a slug, and optional region markers. Profiles for this migration:

- `coordination-channel`: file `bridge-v2-coordination-channel.md`, no archive region.
- `cognitive-engine-channel`: file `antigravity-claude-bridge-cognitive-engine.md`, archive region from the line matching `^## ARCHIVE` up to the line matching `^## LIVE BLOCKS`, with a 4-space indent.

Algorithm, per file:

- Read as strict UTF-8. Reject NUL. Reject a file larger than 16 MiB. Normalise CRLF to LF for hashing and record that a normalisation happened.
- Pass 1, scan lines in order, state machine with three states: preamble, between blocks, inside block.
  - In the live region only a column-0 line that matches the begin regex opens a block.
  - In the archive region, strip exactly 4 leading spaces from every line before matching. A line with more than 4 spaces keeps its remaining indent and cannot be a fence.
  - Inside a block, a second begin fence is an error (nested begin). The matching end fence must repeat author, conversation id and message number, otherwise error.
  - A reply-to on the end fence must equal the begin fence's if present. Absent is fine.
  - End of file inside a block is an error (unterminated).
  - Non-blank text outside any block after the first fence is an error (stray text). Blank lines are ignored.
  - Text before the first fence (the preamble) and the archive section heading are not messages. They are recorded in the run manifest by line range and sha256, and preserved in the backup. They are not stored as A2A objects.
- Block fields:
  - `author_harness`, `conversation_id`, `message_number` from the begin fence.
  - `begin_ts` and `end_ts` as the original strings, plus UTC-normalised values. A timestamp without an offset is a warning and is read as `+02:00`; none exist today.
  - `reply_to_raw` from the begin fence, split into `(harness, conversation_id, [numbers])`.
  - `inner` = the lines strictly between the fences joined with LF, no trailing LF, no stripping (de-indented in the archive region).
  - `to_raw` = text after `to:` on the first inner line. If the first line is not `to:`, warning and `to_raw` is empty.
  - `about` = text after `about:` on the second line when present. `status_header` = text after `status:` there when present.
  - `seq` = zero-based index in file order, archive region first.
  - `line_begin` and `line_end` = source line numbers.
  - `content_sha256` = sha256 of the UTF-8 bytes of `inner`.
- Pass 2, resolve `reply-to` (section 6.3) across both files, because refs cross files.
- Strict by default: any error aborts before anything is written, with a full report. Warnings never abort. `--allow-errors` is deliberately not provided (a bad parse must be fixed in the profile or the tool, not skipped).

## 6. Mapping to A2A objects

A2A objects follow `a2a.proto` (`Task`, `TaskStatus`, `Message`, `Part`, `Role`) `[verified]` against [`a2a.proto`](https://github.com/a2aproject/A2A/blob/4735f4876449c6f381825d8a841b31b16c6ad0c4/specification/a2a.proto) at commit `4735f48`. The handle and card names follow decision 6.

### 6.1 Identity

- Author card: `claude` maps to `claude-code@<workstation>`, `antigravity` maps to `antigravity@<workstation>`. The machine part is `<workstation>` per the decisions; the host reports `<workstation>-wsl` `[verified]`, so the machine name is a profile setting and not read from the OS (open point 4).
- Author handle: `<card>/<lowercased conversation_id>`, for example `claude-code@<workstation>/012hq2t9cjjjdcy9jysndaej`. The name charset in server-api.md 5.1 is lowercase only (`[a-z0-9._-]`), and some conversation ids contain uppercase letters, so the handle uses the lowercased id (this option, not a hash). An imported handle is a historical author label, not a live session: it carries no `~<sid8>` suffix, so it does not fit the session part regex of 5.1 (`^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$`, round-4 X1); whether imported handles are exempt from that regex is [design, open]. The raw conversation id is kept only in metadata (`coord.import.conversation_id`). The dry-run aborts if two distinct raw ids collide after lowercasing. Handles are our extension (decision 6). Imported handles are never registered as live sessions: no `/sessions` row, no listener, no card routing.
- `to:` mapping: `claude` to `claude-code@<workstation>`, `antigravity` to `antigravity@<workstation>`, `all` to the literal `*`. Unknown tokens are kept as raw strings and reported.

### 6.2 Containers

- One A2A context per channel file. `context_id` = `uuid5(NS, "context|" + slug)`.
- `NS` is a fixed namespace uuid5 derived from the string `urn:agentic-hub:coordination:import:v1`, documented in the tool, never random. This is what makes ids reproducible and the import idempotent.
- One Task per channel message. Rationale `[inferred]`: `reply-to` refers to individual messages, and A2A's native cross-reference (`Message.reference_task_ids`) refers to tasks, so a per-message task is the smallest unit that keeps the reply graph queryable. `ListTasks` by `context_id` returns the thread.
- `task_id` = `uuid5(NS, "task|" + slug + "|" + region + "|" + author + "|" + conversation_id + "|" + message_number)`, where `region` is `live` or `archive`.
- `message_id` = `uuid5(NS, "msg|" + the same key)`.

### 6.3 Task and Message fields

Task:

- `id`, `context_id` as above.
- `status.state` = `TASK_STATE_COMPLETED`. `status.timestamp` = `end_ts` in UTC. No `status.message`.
- `history` = the single Message below. `artifacts` = empty.
- `metadata.coord.origin` = `"import"` and `metadata.coord.import` = the compact import record (below). Both sit under the server-set `coord` key defined in server-api.md 5.3.

Message:

- `role` = `ROLE_AGENT` for every imported message `[inferred]`. A2A's `ROLE_USER` means "the client side of a request"; imported items are historical statements by agents, not requests, and giving them `ROLE_USER` would make old text look like a user instruction. Open point 3 asks the user to confirm.
- `parts` = one text Part with `inner` verbatim (including the `to:` and `about:` lines, so the body is lossless and the hash is checkable from the store).
- `context_id`, `task_id` as above.
- `reference_task_ids` = the resolved target task ids of `reply-to` (A2A-native).
- `metadata.coord.origin` = `"import"`, and `metadata.coord.import` with these keys:
  - `run_id`, `source_slug`, `source_file` (basename only), `region`, `seq`, `line_begin`, `line_end`
  - `content_sha256`, `begin_ts`, `end_ts`
  - `author_harness`, `author_card`, `author_handle`, `conversation_id`, `message_number`
  - `to_raw`, `to` (mapped list), `about`, `status_header`
  - `reply_to_raw` and `reply_to`, a list of objects `{harness, conversation_id, number, resolved_task_id|null, resolution}`
- `extensions` is left empty. Declaring an extension URI requires the card to declare it too, which belongs to the handle-mapping document.

Reply-to resolution:

- Look for the target `(harness, conversation_id, number)` among parsed blocks in the same channel file (live first, then archive). If none, look in the other file.
- If both files match, take the same-file match and record `resolution: "ambiguous-same-file"` with the other candidate id.
- Exactly one match: `resolution: "resolved"`. None: `resolved_task_id: null`, `resolution: "unresolved"`. No id is ever invented.
- Known on 2026-11-04 `[verified]`: every distinct `reply-to` target (including each number in a comma list) exists as a block in one of the two files, archive region included. Unresolved refs appear only if `--no-archive-region` is used.

### 6.4 Never offered, never woken

- Terminal `COMPLETED` tasks are not offered by `a2a_inbox` (which lists SUBMITTED and queued items only). A2A forbids restarting a terminal task, so a stray `SendMessage` with an imported `task_id` fails by protocol.
- The apply path writes through the server's admin path directly into the task store. It does not publish queue events, does not touch the wake logic, and does not count against the 20/h wake budget.
- Imported tasks carry `metadata.coord.origin = "import"` (the trust field from decision 10; server-api.md 5.3 defines the value and 3.3.3 the visibility rule). They are visible to `local-harness` API keys only. The `remote-peer` and `status-client` scopes never see them, because the old channel discusses internal paths, plans and unreleased work.
- Imported tasks are exempt from any TTL or retention sweep the server later adds.
- Bodies reach a model only through tool results, framed as untrusted data like any other body. They are never placed in a wake stub or in injected context.

## 7. Import safety

- The import path is not network-reachable. It is an admin operation of the `a2a-coord` CLI (same family as `key create` and `review`), reached the way every admin command is (decision 15): inside the container, over the in-container Unix socket, with no admin HTTP endpoint and no admin API-key scope. No API-key scope grants it, including `local-harness`. Docker access on the host that runs the container is the credential.
- Packaging (the route is decided by decision 15; the exact wiring is `[unverified]` until built): the CLI parses and plans on the host (`uv run`), then sends the bundle on stdin to `docker compose exec -T coordination a2a-coord admin-apply -`. In production the container runs on <storage-host> (decision 23), so the command is `ssh <storage-host> docker compose exec -T coordination a2a-coord admin-apply -` with the bundle piped through the SSH session. The channel files live on <workstation> (`~/.agents`), so parse, plan, tar backup and deletion happen on <workstation>; the store is the Postgres service's, `/data/imports/<run_id>/` is on <storage-host>'s `a2a-data` volume, and the pre-apply store snapshot goes to `<media-root>/backup/a2a/` on <storage-host>'s host (R6, R9, section 13.1) (the service name `coordination` follows server-api.md 1.4 and stays a placeholder until S1 settles the layout). `-T` is correct here because `admin-apply` needs no TTY; the typed confirmations (`retire-channels`) run in the host-side part on a real TTY. `a2a-coord` has two parts, as server-api.md 3.7 states: the host-side wrapper does parse, plan, backup, retire and the TTY confirmation, and the in-container admin-socket client does `admin-apply`. The server process talks to the store, so decision 4 (one server process owns the store; Postgres since D-A) holds. No bind mount of `~/.agents` into the container is needed.
- The server re-validates every record from the bundle: recomputes the uuid5 ids, recomputes `content_sha256` from the text Part, checks `state == COMPLETED`, checks `coord.origin == "import"`. A bundle that disagrees with itself is rejected whole.
- Credential scan on every `inner` (same four patterns plus the generic `Bearer <long token>` form). A match aborts with the line number and never prints the matched text.
- Hard limits: block under 1 MiB, file under 16 MiB, at most 10,000 blocks per run. The current data is far below all of them.
- Parsing is plain text. No URL, `file://` link or path inside a body is fetched, opened or resolved.

## 8. CLI shape (specified now, built at go-live)

One entry, no flags needed for the safe default:

- `a2a-coord import-channels`: dry-run. Parses both profiles, resolves replies, diffs against the store, prints and writes the report. Changes nothing. Writes a plan file `plan-<plan_id>.json` holding source sha256 values and the full task-id list.
- `a2a-coord import-channels --apply --plan <plan_id>`: writes. Refuses if any source file hash changed since the plan, if the plan is older than 24 hours, or if the store now holds a conflict (section 9).
- `a2a-coord import-channels --verify --run <run_id>`: read-back verification (section 10). Also runs automatically at the end of `--apply`.
- `a2a-coord import-channels --rollback --run <run_id>`: removes exactly what that run created (section 13.3).
- `a2a-coord retire-channels --run <run_id>`: backup, verify the tar, confirm, delete (section 13). Separate command on purpose, so import and deletion can never be one keystroke.

Options:

- `--source-dir` (default `~/.agents`), `--no-archive-region`, `--report-dir`.
- `--batch-size` (default 50 tasks per transaction).

Exit codes:

- 0 success.
- 2 parse error.
- 3 idempotency conflict.
- 4 verification mismatch.
- 5 precondition failure (server down, plan stale, source changed, wrong TTY).

Run artefacts live on the server volume under `/data/imports/<run_id>/`: `manifest.json`, `report.md`, `plan.json`. They contain hashes, counts and keys, never message bodies. The `a2a-data` volume holds these import run artefacts only and is not part of the backup scope (server-api.md 1.2, R6).

## 9. Idempotency

- Identity: the uuid5 task id (section 6.2). Same source block gives the same id on every run.
- Content hash: `content_sha256` of `inner`.
- Per block, the apply step compares against the store:
  - id absent: insert.
  - id present with the same hash and `coord.origin == "import"`: skip, count as `unchanged`.
  - id present with a different hash: conflict. The run aborts before writing anything, with both hashes in the report. It never overwrites. (Channels are append-only; a changed block means the file was edited or the key collided.)
  - id present but without `coord.origin == "import"`: conflict, same handling. This protects live tasks from a bad key.
- Duplicate content under different keys (same hash, different ids) is reported, not merged.
- Writes go in batches of 50 inside one transaction each. A crash leaves complete batches only, and a re-run finishes the rest. No partial task exists.
- Running the apply twice must report `inserted: 0` the second time. This is a required test.

## 10. Dry-run report and verification

### 10.1 Dry-run report (always produced, markdown plus json)

- Source files: path, size, mtime, sha256, line count.
- Counts per file, per region, per author, per conversation.
- First and last `begin_ts` per file (by file order) and the overall min and max in UTC.
- Warnings: end-fence reply-to dropped, begin/end timestamp differences, non-monotonic timestamps, message-number gaps, unknown `to:` tokens, post-freeze appends.
- Errors: nested, unterminated, mismatched, stray text, credential match, encoding.
- `reply-to` resolution table: resolved, ambiguous, unresolved counts.
- Store diff: would insert N, unchanged N, conflicts N.
- A sample of 3 mapped objects, bodies truncated to 200 characters.

### 10.2 Expected numbers on 2026-11-04 `[verified]`, to re-measure at go-live

| File | Region | antigravity | claude | Total |
| --- | --- | --- | --- | --- |
| coordination channel | live | 18 | 33 | 51 |
| cognitive-engine channel | live | 27 | 38 | 65 |
| cognitive-engine channel | archive | 1 | 2 | 3 |

Per conversation:

- Coordination channel: `012hq2t73Akvdk6rcqPug6ea` 3, `012hq2t9CJjJdCY9JySndAEj` 29, `01VA3JtCyASmfR8Q7Vcvehe7` 1, `0e89deec-98b6-48fc-8c5d-fd210899c0d1` 1, `8343b610-a41a-4ee9-a2e5-0f1dde92f456` 17.
- Cognitive-engine channel, live: `012hq2t73Akvdk6rcqPug6ea` 13, `317124a3-9df0-4a5a-b6d0-df42be2cc6ea` 25, `0e89deec-98b6-48fc-8c5d-fd210899c0d1` 23, `8343b610-a41a-4ee9-a2e5-0f1dde92f456` 4.

First and last begin timestamps (file order):

- Coordination: 2026-11-03T13:50:00+02:00 to 2026-11-04T14:22:23+02:00.
- Cognitive live: 2026-10-28T23:11:32+02:00 to 2026-11-03T16:03:43+02:00.
- Cognitive archive: 2026-10-28T23:06:08+02:00 to 2026-10-28T23:10:00+02:00.

Total imported tasks expected: 119 with the archive region, 116 without.

### 10.3 Verification (after apply, and on demand)

Verification reads back over the server's HTTP surface (`ListTasks` by `context_id`, `GetTask`), not from the manifest, so it tests the real path.

- Count per context equals parsed count. Count per author equals parsed count. Count per conversation equals parsed count.
- Independent cross-check of the parser: for each file, `rg -c '^---<author> conversation .* end '` (the same primitive the old watchers used) equals the parsed live count per author. The archive region is checked with a 4-space-anchored pattern.
- First and last `begin_ts` read from the store (ordered by `metadata.coord.import.seq`) equal the report values, as exact strings.
- Every stored task re-hashed: sha256 of the text Part equals `metadata.coord.import.content_sha256` equals the source hash from the plan. All 119, not a sample; the data is small.
- Every task is `TASK_STATE_COMPLETED` with `coord.origin == "import"`.
- `reference_task_ids` count equals the number of resolved reply-to targets in the report.
- No wake side effects: for every registered handle, `a2a_inbox` shows nothing new, the wake budget counters did not move, and the server log window of the run contains no wake event.
- Verification result is written to the manifest. `--verify` exit code 4 means any mismatch, with a line per mismatch.

## 11. Retirement list (listed here, not touched by this document)

To retire after the import is verified, on the user's decision:

- `~/.local/bin/watch-bridge-coordination.sh`: watches `bridge-v2-coordination-channel.md`, inotify loop, state file `bridge-watch-coordination.seen` `[verified]`.
- `~/.agents/watch-bridge.sh`: watches the cognitive-engine channel and the `handoff/` directory `[verified]`.
- State files under `~/.local/state`: `bridge-watch.seen`, `bridge-watch-cognitive-engine.seen`, `bridge-watch-cognitive-engine-claude.seen`, `bridge-watch-coordination.seen`, `handoff-watch.seen` `[verified]`.
- `~/.agents/session-registry.json`: superseded by `POST /sessions`.
- Session-only loops that die with their sessions: the Claude Code Monitor (30-minute limit) and one-shot cron fallbacks, as described in `agent-bridge-protocol.md`. Nothing to delete, but they should not be re-armed.
- The Antigravity persistent watcher mentioned in the channel text (daemon task, PID 3444326, 2026-10-28) `[reported]`. No `watch-bridge` process was running on <workstation>-wsl at inspection time `[verified]`; other machines were not checked (open point 6).
- Copies of `watch-bridge.sh` under the Antigravity `brain/*/scratch` directories are session scratch and out of our control. Ignore.

Not retired:

- `~/.agents/cognitive-engine-docker-tests.lock`: BuildSlot contention lock, still in force.

References that will dangle once the channel files are deleted (annotate as historical, do not rewrite history):

- Outside the repo: `bridge-v2-coordination-tasklist.md`, `cognitive-engine-tasklist.md`, `agent-bridge-protocol.md`, `bridge-v2-heartbeat-spec-draft.md`, `handoff/2026-11-02-next-session-kickoff.md`.
- Inside the repo: `file://` links to the channel in [the consolidated plan](https://github.com/rockad/agentic-hub/blob/main/plugins/coordination/docs/plans/consolidated-bridge-v2-plan.md) (the baseline table row and the "Operational Channel" references).
- User-scope config: none found. A search of `~/.claude/CLAUDE.md` and `~/.claude/settings.json` found no reference to the channel files `[verified]`.

## 12. Dress rehearsal and tests (before the real run)

- Synthetic fixtures only. Real channel files stay out of the repo, since they contain internal paths and plans.
- Unit fixtures, one per quirk in section 4: end fence without reply-to, 30-second timestamp gap, non-monotonic timestamps, comma `reply-to`, cross-file reply-to, number gap, key collision across files, indented archive region with a deeper-indented fake fence, nested begin, unterminated block, stray text, mismatched end, CRLF, NUL, oversize block, credential-like string.
- Property tests: parse then render then re-parse is stable; applying twice inserts zero the second time; any one-byte change in a block produces a conflict.
- Dress rehearsal: copy the two real files read-only into a scratch directory, run the full dry-run and apply against a scratch Postgres database (a scratch compose project with its own volume), check the section 10.3 list, then drop the scratch database and its volume.
- Wake canary on the scratch server: park a listener on a throwaway handle, run the apply, expect no 200 on the listener (it must stay in 408 rounds).
- Run only the real store after the user's go.

## 13. Backup, deletion, rollback

### 13.1 Backup before deletion

- Pre-apply store snapshot [R6, R9, R12]: a `pg_dump` of the coordination database in custom format (`-Fc`), taken while the server runs, named `pre-import-<run_id>.dump` and written into the same directory as the nightly dumps, `<media-root>/backup/a2a/` on <storage-host> (server-api.md 1.2), so the second restic job on `<storage-host>` (own script `~/.local/share/a2a-coord/<version>/bin/a2a-restic-backup.sh`, own repository `rclone:<gdrive-remote>:backups/restic-a2a`, tag `a2a-dumps`, user-crontab line `45 5 * * *` in <storage-host>'s local time; server-api.md 1.2, X4, user decision 2026-11-10) collects it. The host-side importer runs it through the compose stack; the exact command, and which database role it runs as, are [design]. It no longer goes to `/data`: `a2a-data` is for import run artefacts only and is not backed up. It is the rollback anchor for the store. Its restore into a scratch database is checked the way the nightly dump restore is, with `pg_restore` (server-api.md 1.2, D-B, R12). The nightly dump (`a2a-<UTC timestamp>.dump`) is written by the dump sidecar into the same directory and is not this snapshot. The daily prune never deletes `pre-import-*` files [R12, default applied by the assistant; the user may veto]; removing old ones is manual. Whether the restic job covers the directory is confirmed on <storage-host> in task S2-DEPLOY (S1-BKP writes the job's text; the second job is a new job, not an addition to the existing one, R9), so the runbook confirms the snapshot file is present in that directory before apply.
- Source backup: a tar of exactly the following, taken after verification and before deletion:
  - the two in-scope channel files
  - `cognitive-engine-bridge-turns-archive-2026-10.md`
  - the `handoff/` directory
  - `session-registry.json`
  - `watch-bridge.sh` and `~/.local/bin/watch-bridge-coordination.sh`
  - the five state files from section 11
  - the freeze manifest and the run manifest
- Format: gzip tar with paths relative to `$HOME` (for example `.agents/bridge-v2-coordination-channel.md`), mtimes and modes preserved. Default location `${XDG_DATA_HOME:-$HOME/.local/share}/a2a-coord/backups/channels-<run_id>.tar.gz` (outside `~/.agents`, which is being cleaned).
- The tar is verified, not trusted: list it, extract into a temporary directory, compare sha256 of every member against the plan. A mismatch aborts deletion.
- The tar's own sha256 goes into the run manifest. The tool never deletes a backup. The user decides retention.

### 13.2 Deletion, only after confirmation

Preconditions the tool checks, in order. Any failure stops with exit 5:

- Verification for this run passed and is recorded.
- The backup tar verified.
- Each file still has the sha256 recorded in the plan (nothing was appended after backup).
- stdin and stdout are a real TTY. Agents cannot run this step, the same rule as `a2a-coord review`.
- The user types the exact phrase `delete 2 channel files after verified import <run_id>`. A bare `yes` is not accepted.

Deleted: the two in-scope channel files, nothing else. Everything else in section 11 is the user's manual decision. The tool prints the paths it removed and records them in the manifest.

### 13.3 Rollback

- Store only (before file deletion): `a2a-coord import-channels --rollback --run <run_id>` deletes exactly the task ids listed in that run's manifest, and only those whose stored `content_sha256` and `coord.origin == "import"` still match. Anything that differs is left and reported. Uses `TaskStore.delete` `[reported]` (audit t1c). A full `pg_restore` of the `pre-import-<run_id>.dump` file from `<media-root>/backup/a2a/` is the heavy alternative.
- Files (after deletion): extract the tar back over `$HOME` with `tar -C "$HOME" -xzf <tar> --keep-old-files`, so an existing file is never overwritten. Then re-run the dry-run, which must again report the same hashes.
- Both: restore files first, roll the store back, then re-import from a fresh plan. Idempotency makes this safe to repeat.
- Rollback never touches live tasks, API keys or sessions.

## 14. Runbook (go-live day)

- Confirm the S3 exit gate has passed and the user has declared go-live (decision 14).
- Confirm the channel is frozen, including Antigravity's research use, which stops now. Record the freeze instant and the sha256 of both files.
- Stop any watcher still running (section 11).
- Dry-run. Read the report. Compare against the section 10.2 numbers. Resolve every error and every ambiguous reply-to.
- User go. Take the pre-apply store snapshot (`pre-import-<run_id>.dump` in `<media-root>/backup/a2a/`, section 13.1) and confirm the file is there. Apply with the plan id. Let the automatic verify finish.
- Read the verify output. Spot-check three tasks through a normal MCP `a2a_get` call.
- Run `retire-channels`: backup, tar verification, typed confirmation on a real TTY, delete.
- User retires the section 11 items by hand and annotates the dangling references.
- Record completion in the master tasklist with the run id and the tar path.

## 15. Open points

Not resolvable from the evidence, in rough priority:

- 1. Freeze instant. The decision says "frozen now" without a time, and decision 14 allows Antigravity research appends until go-live. The last write seen is 2026-11-04T14:22:23+02:00 `[verified]` and is no longer the last write that will exist. The user fixes the instant on go-live day (when Antigravity stops) so that only appends after it are flagged.
- 2. Turns archive. Import it with a second, guess-based parser (year inferred as 2026, no ids), or leave it as a plain file in the tar. Default here is leave it.
- 3. Role for imported messages. `ROLE_AGENT` for all (recommended) or `ROLE_USER` for the sender side. Needs user confirmation.
- 4. Machine name in handles. Decisions say `<workstation>`, the host name is `<workstation>-wsl`. Profile setting; confirm.
- 5. Closed by decision 15 (2026-11-04, /cplain): admin path is `docker compose exec -it` over an in-container Unix socket, no TCP, no API key scope. Defined in server-api.md 3.7.
- 6. Other machines. Only <workstation>-wsl was inspected. Whether the Mac or <storage-host> hold their own copies of the channel files, watcher scripts or state files was not checked. Closer to go-live this matters more, since mac and <storage-host> will be tailnet peers by then (S2).
- 7. Does `DatabaseTaskStore` let the importer set its own created and updated timestamps? Not confirmed in the audit. If it does not, ordering and dates come from `metadata.coord.import.seq` and `begin_ts`, and the store's own timestamps will show the import time. Needs a spike on a scratch store.
- 8. Closed: visibility is `metadata.coord.origin = "import"`, visible to local-harness API keys only (server-api.md 5.3 and 3.3.3).
- 9. Retention of the backup tar. The tool never deletes it; how long to keep it is the user's call.
- 10. Whether to keep the three `handoff/` prompts. They are untouched by this plan and backed up.
