# Verification of the A2A deep-dive (Antigravity) against the A2A spec repository (a2aproject/A2A at 4735f48), and R8 candidate terms check

Author: Claude Code (macp), 2026-11-03. Read-only. Source checked: [`a2aproject/A2A`](https://github.com/a2aproject/A2A/tree/4735f4876449c6f381825d8a841b31b16c6ad0c4) (a local clone at the time, HEAD 4735f48, 2026-10-30; spec 1.0.1; the clone is now deleted): [`specification/a2a.proto`](https://github.com/a2aproject/A2A/blob/4735f4876449c6f381825d8a841b31b16c6ad0c4/specification/a2a.proto) and [`docs/specification.md`](https://github.com/a2aproject/A2A/blob/4735f4876449c6f381825d8a841b31b16c6ad0c4/docs/specification.md). Labels: **verified** (read in the repo by me), **partly** (true but incomplete), **overstated**, **unverified**.

## Part 1: verification of `a2a-deep-dive-side-by-side-coordination.md`

| claim in the deep dive | result | evidence |
| --- | --- | --- |
| Eight TaskState values with numbers 1 to 8 and the terminal/interrupted split | **verified** | proto lines 189 to 207: SUBMITTED 1, WORKING 2, COMPLETED 3, FAILED 4, CANCELED 5, INPUT_REQUIRED 6 (interrupted), REJECTED 7 (terminal), AUTH_REQUIRED 8 (interrupted); UNSPECIFIED is 0 |
| Terminal tasks cannot restart; follow-on work uses a new task referencing the old | **verified (partly)** | messages to terminal tasks return `UnsupportedOperationError`; `reference_task_ids` exists on Message (proto line 276) |
| "Section 12 defines Custom Protocol Bindings that preserve the data model" | **partly** | Section 12 exists ("Custom Binding Guidelines") and allows custom bindings, but it sets four MUSTs (12.1), not one; see below |
| "A custom binding preserves 100% of the canonical data model, so the file binding is standards-compliant today" | **overstated** | 12.1 also requires the binding to "Implement All Core Operations" of Section 3, to document data type mappings (12.2), service-parameter transmission (12.3), error mapping (12.4), streaming support or a stated limitation in the Agent Card (12.5), authentication handling (12.6) and the Agent Card declaration with a binding URI (12.7). The deep dive covers only the data model |
| Agent Card fields listed | **partly** | the proto marks as required: name, description, supported_interfaces, version, capabilities, default_input_modes, default_output_modes, skills. The document omits default_input_modes, default_output_modes and treats skills and supported_interfaces as optional extras |
| Agent Cards in `~/.agents/roster/` for peer discovery | **our convention, not A2A** | the spec's discovery is `GET /.well-known/agent-card.json` over HTTP (spec line 1826). A roster directory is a sensible local analogue, but it is not defined by A2A |
| Message roles ROLE_USER and ROLE_AGENT | **verified** | proto lines 249 and 251 |

### What the @@C@@ operations require (the missing part)

The proto defines 11 operations: SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask, SubscribeToTask, CreateTaskPushNotificationConfig, GetTaskPushNotificationConfig, ListTaskPushNotificationConfigs, GetExtendedAgentCard, DeleteTaskPushNotificationConfig. A conforming custom binding must support all of them or document what it does not (12.1 says MUST implement all). A file-based binding can plausibly map SendMessage, GetTask, ListTasks and CancelTask to appends and reads, and SubscribeToTask to the inotify watcher. Push-notification config operations and GetExtendedAgentCard have no obvious file equivalent. Result: calling the file channel "an A2A binding" would need either a full mapping or an honest label such as "A2A-aligned data model, not a conforming binding".

### Symmetry caveat

A2A is request and response between a client agent and a server agent: one side sends a Message (ROLE_USER), the other works the Task and replies (ROLE_AGENT). Two peers can each play both roles, which fits side by side sessions, but inside one task there is still a requester and a worker. The deep dive's phrase "without caller/subordinate hierarchies" is true of the pair, not of an individual task. Whether that meets the user's "no master or dependent" requirement is the user's judgement; I read it as acceptable only if either side can open tasks to the other.

### Other points

- Proposed ledger (`tasks.jsonl` under flock, one folder per context) is a design choice; A2A defines the Task object and its history but not a storage format. A JSONL of Task snapshots or status events needs a stated rule for which record is current.
- Proposed directory names (`roster/`, `contexts/`) are new and need to be added to the heartbeat's directory plan so the two do not overlap with `~/.agents/heartbeat/`.
- Deep dive claim "removes the need for beads": it removes the Dolt dependency; it does not provide dependency graphs or "ready work" queries that beads has. If the user wants those, A2A alone does not supply them.
- Suggested wording for the plan: "Phase 2: A2A-aligned local task ledger (data model from a2a.proto 1.0.1; file transport; not a conforming binding unless the 12.1 operations are mapped)".

## Part 2: R8, what each candidate would run on the Antigravity side, against the FAQ and terms

Official lines that matter (R1): Terms item 6 ("Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement."); FAQ entry on third-party software naming Claude Code, OpenClaw and OpenCode; FAQ entry on headless mode ("Wrapping `agy` inside third-party coding agents or applications" not supported under consumer plans). User decisions: never wrap `agy`; the rule covers Antigravity-related options (DDR-003).

| candidate | what runs on the Antigravity side | contact with the FAQ lines | label |
| --- | --- | --- | --- |
| Current file channel plus watcher | The user's own interactive `agy` session appends to a file and runs a background task for the watcher script | No third-party process drives agy; no OAuth handling. Whether two products exchanging files counts as "third-party tools to access the Service" is not established by any source; user decided to keep it (DDR-003) | verified (our setup), compliance unestablished |
| swarmail | Its installer (`scripts/configure-hooks.ts`) writes Antigravity hook entries: a `PreInvocation` hook and a `Stop` hook that run `swarmail hook context agy` with a 2 s timeout (lines 280 and 281). The hooks use Antigravity's own documented hooks feature and run inside the user's own session. I found no code in `src` or `scripts` that launches `agy`. Its docs say its Antigravity `send_message` test used a separate `agy -p` process, and that agy `send_message` needs an address variable that the docs do not explain | The hook path is an official extension surface (antigravity.google/docs/hooks, listed in its docs), so I read it as lower risk, but a third-party daemon that edits agy's hook config and reads session data is closer to the FAQ's "third-party software" entry than the plain file channel. The `agy -p` test in its docs is the wrapping pattern the user ruled out | verified for hook entries and absence of spawns; risk reading is opinion |
| beads | `bd setup gemini` installs hooks into `~/.gemini/settings.json` and a section in `~/.gemini/GEMINI.md` for Gemini CLI, and `bd` is a CLI that an agy session could call. Nothing in the docs I read sets up `agy` itself (Antigravity's CLI is not the Gemini CLI) | `bd setup gemini` targets Gemini CLI config, not agy; do not run it. An agy session running `bd` as a normal shell command is ordinary tool use inside the user's session | verified for what the docs say; whether `~/.gemini` paths are shared with agy is not checked (unverified) |
| agent-bus | Nothing; no agy or Antigravity mention in its README | None found | verified (grep) |
| A2A-aligned local ledger (proposed) | Files and a lock written by the user's own session | Same as the file channel | design, not built |
| ACP carrier for agy | A wrapper or adapter that launches or drives `agy` | Directly the wrapping the user ruled out and the FAQ calls unsupported | excluded by DDR-003 |

### Conclusions for the plan (opinion)

- Options that only exchange files from inside each user-run session (file channel, A2A-aligned ledger) stay clear of the "wrap agy" line. Anything that installs hooks into Antigravity (swarmail) needs the user's explicit decision under the rule-scope answer, because its Antigravity integration is third-party software attached to the product.
- Do not run `bd setup gemini` anywhere.
- Re-check the live Antigravity hooks page before relying on hook behaviour; I did not read it.

## Not done

- I did not read the full A2A spec (about 3,000 lines); I read Sections 3.1 headings, 5.8, 12 and the proto's TaskState, operations and AgentCard.
- I did not read antigravity.google/docs/hooks or the Gemini CLI settings layout.
