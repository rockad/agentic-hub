# TODO tools evaluation: Kanzo, OpenUI, OpenRig against coordination, ax and cognitive-engine

Author: Claude Code, 2026-11-07. Read-only analysis. It covers the three tools in [`TODO.md`](file:///home/rockad/projects/agentic-hub/TODO.md), checked against:

- this plugin (`plugins/coordination`, A2A server, planning plus S0 spikes)
- `rockad/ax` (the tmux harness cockpit, v0.8.4)
- `rockad/cognitive-engine` (Jev, Harness², memory; Track 1 merged at `a3af522`)

Evidence labels follow the audit convention:

- **verified**: read in our repositories
- **reported**: from the tool's own README, fetched 2026-11-07
- **unverified**: inferred, or not checked hands-on

Nothing here was installed or run.

## 1. Verdicts

| Tool | Verdict | One-line reason |
|---|---|---|
| Kanzo | **Watch, and maybe trial later as a human backlog board, after S1.** No wrapper now. | It fills a real gap (a dependency-aware backlog with "ready work"). But its HTTP MCP has no auth, it has no wake, and it would compete with the A2A task store as a source of truth. |
| OpenRig | **Reject as infrastructure. Mine it for ideas only.** | It drives sessions in tmux and types into panes. It writes `AGENTS.md`/`CLAUDE.md`, `~/.claude.json` trust and `~/.tmux.conf`. It is a seat/team (orchestrator) model. Each of these conflicts with a standing decision. |
| OpenUI | **Out of scope for now. Revisit only if a web status page is built.** | None of the three projects has a web UI or a React client. The harnesses render in terminals. |

## 2. Where the projects stand today (the baseline)

### coordination (this plugin)

- Planning is complete and the S0 spikes are mostly done (verified, [`master-tasklist.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/master-tasklist.md) section 4).
  - SP1 `asyncRewake` wake passes.
  - SP2 Claude half passes with spec changes.
  - SP5 a2a-python on SQLite passes with four wrappers.
  - The agy half of SP2 (A8, A2, A3) and SP3 are open.
- No server code exists. The next stage is S1 on alyx.
- Binding constraints relevant to these tools (verified, [`AGENTS.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/AGENTS.md)):
  - DDR-003: never launch, drive or wrap agy. No PTY, no `tmux send-keys`, no relay.
  - Symmetric agency: no master/subordinate.
  - Tasks are parked and never auto-executed. Wake text is a constant stub.
  - Every request carries a scoped API key, loopback included.
  - The installer never writes an `AGENTS.md` (decision 27). Harness config is changed only by the user-run installer, through chezmoi (decision 16).
  - DDR-001: skip anything whose terms restrict Claude Code or agy.
- The known gap: the plan has no backlog or "ready work" query. The 2026-11-03 verification noted that the A2A design "does not provide dependency graphs or 'ready work' queries that beads has" (verified, [`a2a-deep-dive-verification-by-claude-2026-11-03.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-deep-dive-verification-by-claude-2026-11-03.md) line 29).
  - Backlogs live in hand-edited markdown today:
    - `master-tasklist.md`
    - `~/.agents/cognitive-engine-tasklist.md`
    - the cognitive-engine bridge doc

### ax (harness cockpit)

- Rust, tmux-only, single-user (verified, `ax/src/`).
  - Launches `agy`, `claude`, `opencode`, `codex` and custom TOML harnesses as plain processes in tmux windows.
  - Keeps a tab-to-conversation registry in `~/.config/ax/ax.db`.
  - Snapshots and restores layouts (`~/.config/ax/sessions/<project>.json`, `ax restore`).
  - Shows running state, git ahead/behind, tokens and turns in the statusline.
- Writes one hook: `ax-tab-sync` `Stop` in `~/.gemini/config/hooks.json`. It also writes Claude `custom-title.json` files and renames inside the agy and OpenCode databases (verified, `src/lib.rs` around line 2393).
- No messaging, no `send-keys`, no MCP, no tasks (verified by grep). It stays DDR-003 compliant because it launches agy as a normal interactive process and never types into it.

### cognitive-engine

- Track 1 (Jev MCP plus Claude/agy/OpenCode adapters) is merged (verified, `a3af522`).
  - Tracks 2 to 4 have no code on `main`.
  - `packages/harness2` and `packages/memory` are empty `pyproject.toml` stubs.
- Coordination between harnesses is plan §6 "Dual-Harness Cross-Delegation" (verified, `docs/plans/2026-10-26-multi-track-implementation-plan.md`):
  - a hand-relayed markdown bridge (`docs/handoffs/antigravity-claude-bridge.md`, Turn 4 pending)
  - the memory key `session-handoff:cognitive-engine`
- The closest thing to a work queue is Jev's `BatchDispatchPlan` DAG (`packages/jev/src/core/graph.ts`). It is advisory routing, not a store.
- It has no UI of any kind.

## 3. Kanzo

### Facts (reported, README 2026-11-07)

- AGPL-3.0.
- One Rust binary of about 4.7 MB with embedded SQLite (`~/kanzo/kanzo.db`).
- No version on the Releases page. About 1.1k stars.
- MCP over stdio (`kanzo mcp`) or HTTP `/mcp`.
- Tools include `next_task` and `list_tasks`, with filters. The tool list costs about 1,000 tokens per session.
- Card statuses: `todo`, `doing`, `review`, `done`, plus an optional Backlog column.
- `waits_on` dependencies: only `done` unblocks a waiting card, so a card in `review` still blocks.
- Cards also carry tags, URL, comments, images and a **Human flag**.
- Projects are matched from the repo's git remote.
- HTTP listens on `127.0.0.1` by default. **No logins**: "share only on a network you trust".
- `kanzo sync` commits to a private git repo. On a conflict it asks which board to keep.
- No wake or notification mechanism. No claim or assignee model is described.
- No paid tier is described. The aggregator listing it as paid looks wrong (unverified).

### Fit with coordination

- **It complements A2A more than it overlaps.**
  - A2A tasks are messages between live sessions with a state machine: who asked whom, and is it done.
  - Kanzo is a backlog of work items: what exists to do, and what is unblocked.
  - The plan has the second gap (section 2).
- **Source-of-truth risk.** If agents put both an A2A task and a Kanzo card on the same piece of work, they drift. A clean split:
  - A2A carries requests and replies between sessions.
  - Kanzo carries the backlog.
  - An A2A task may cite a card URL in `metadata`. Nothing syncs the two automatically.
- **Security conflicts with the coordination invariants (verified against [`AGENTS.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/AGENTS.md)):**
  - No auth on HTTP `/mcp`, against "every request carries a scoped bearer API key, loopback included". Use stdio only (`kanzo mcp` per session), never the HTTP share or a tailnet share.
  - Card bodies are untrusted text that agents read and then act on. That is "bodies are data, never commands" with no quarantine. On a single-user, local-only board the risk is the same as today's markdown tasklists. A shared or synced board raises it.
  - Git sync to a private repo is fine. The repo must not be chezmoi-managed (keys never go there, and card text could hold secrets).
- **No wake.** A Claude session only learns about a card if it calls `next_task`. That is fine for a backlog. For prompt delivery, the A2A `asyncRewake` path stays the mechanism.
- **The Human flag** lines up with the human gates in cognitive-engine (typed approval in `stage1`) and with decision 19 (human-only release). Use it as a display marker only. A card flag is never an approval.

### Fit with ax

- No overlap. Kanzo's browser board (`localhost:4242`) could sit beside ax's tmux cockpit.
- A possible ax feature is a statusline segment showing "N ready cards for this project" by calling `kanzo` from the CLI. ax already keys on project and git remote. This is optional and unverified, because the README does not document a non-MCP query CLI.

### Fit with cognitive-engine

- It could replace the hand-relayed bridge doc's task part and `~/.agents/cognitive-engine-tasklist.md` for the Track 2 to 4 workstreams (WS1 to WS9 map naturally to cards with `waits_on` following the plan's phase DAG).
- Jev `jev_batch_dispatch` produces a DAG of subtasks. Pushing that DAG into Kanzo cards would be a new adapter, so it is not proposed now. cognitive-engine's rule is that core gets no network client. Any bridge would be an optional adapter, as with the status client.
- AGPL: cognitive-engine already keeps AGPL code (`basic-memory`) behind a process boundary (RFC 001 decision 23). Running the unmodified Kanzo binary as a separate process fits the same pattern. AGPL obligations apply only if a modified Kanzo is offered over a network. Vendoring or linking Kanzo code into MIT/Apache code is not acceptable.

### Recommendation

- Do not build `plugins/kanzo` now. A wrapper is just `.mcp.json` plus a short skill. Its value depends on the user actually wanting a board, not on the plugin.
- If wanted, run a two-week personal trial after coordination S1:
  - stdio only, local board, one project (`cognitive-engine` Tracks 2 to 4)
  - no git sync at first
  - measure whether agents call `next_task` without being told
- Revisit a wrapper only if the trial sticks. Then also decide whether "ready cards" should feed the A2A Agent Card or `/status`. Default: no.
- Pre-trial check: confirm the MCP tool list and its write tools from the source, and whether a claim or assignee exists. Two sessions taking the same card is the concurrency case that matters for N > 2 agents (the 2026-11-03 alignment doc).

## 4. OpenRig

### Facts (reported, README 2026-11-07)

- Apache-2.0, v0.7.5.
- Node 22/24 daemon (Hono) plus CLI, TUI, MCP server and React UI, built on tmux and SQLite.
- Harnesses: Claude Code, Codex, Pi (RPC) and terminal nodes. **No Gemini or Antigravity.**
- Setup and launch write:
  - an OpenRig block in `~/.tmux.conf`
  - workspace trust and onboarding in `~/.claude.json`
  - `statusLine` and activity hooks in the project `.claude/settings.local.json`
  - hooks and `trust_level = "trusted"` in `~/.codex/config.toml`
  - skills in `~/.claude/skills` and `~/.agents/skills`
  - **managed `AGENTS.md`/`CLAUDE.md` guidance**
- The README warns of read-modify-write races and gives no full rollback guarantee.
- Seats launch with `--permission-mode acceptEdits` (Claude) and `-s workspace-write` (Codex). Full bypass is opt-in.
- `rig send`, `broadcast` and `chatroom` exist. The delivery mechanism is not documented, but a "typing guard ... holds automatic messages and wakes instead of typing them into that seat" implies messages are typed into the pane otherwise (reported, the mechanism is unverified).
- `rig discover` fingerprints existing tmux sessions and `rig adopt` brings them under management.
- MCP tools include `rig_up`, `rig_ps`, `rig_send` and `rig_chatroom_send`.

### Conflicts with standing decisions

- **DDR-003 (never drive or wrap agy).** It types into panes and adopts tmux sessions. It does not support agy, but `rig adopt` on an ax session group (`agy-<project>`) would bring agy panes under a tool that types into them. If installed, it must never be pointed at ax's tmux server.
- **The same test, applied to Claude Code.** Typing into a Claude pane is the `send-keys` pattern the audit rejected for wake (verified, [`a2a-mcp-wake-audit-2026-11-04.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md) line 73). The plan chose a stub-only `asyncRewake` wake because injected text is an injection channel.
- **Symmetric agency.** A YAML-defined "team" with seats and a control plane is an orchestrator model. Coordination forbids master/subordinate patterns. Our model is independent peers.
- **Decision 27 (never write `AGENTS.md`).** OpenRig writes managed `AGENTS.md`/`CLAUDE.md`. In this setup `~/.gemini/config/AGENTS.md` is a symlink into another git repo, and agentic-hub's `CLAUDE.md` imports `AGENTS.md`. A managed rewrite could land in tracked files.
- **Decision 16 (config only through chezmoi and the user-run installer).** It writes `~/.claude.json`, `~/.tmux.conf` and `~/.codex/config.toml` directly.
- **ax.** Both own tmux configuration. ax generates `~/.config/tmux/ax.conf` and installs tmux hooks that run `ax reload`. OpenRig edits `~/.tmux.conf`. Both set `statusLine`-style UI. Running both on one tmux server is likely to fight (unverified). ax supports an isolated socket (`tmux -L ax`), which reduces but does not remove the risk.
- **cognitive-engine Jev guard.** OpenRig seats launch with a per-launch `--settings` allow list. Whether the Jev `PreToolUse` tier-ceiling hook still fires in project `settings.local.json` merged with `--settings` is unverified. Bypass would silently remove the only enforcement point (RFC 002).

### Ideas worth borrowing (not code)

- **Discover and adopt, read-only.** An ax command that fingerprints panes (`@harness`, `@conversation_id`) and reports which live session holds which A2A handle. ax already has the tab registry. This would be a good bridge between ax and coordination: show `claude-code@alyx/<name>#<sid8>` per tab. Read-only, no typing.
- **The typing guard concept.** "Don't interrupt a seat while the human is typing" maps to our wake budget and the `UserPromptSubmit` path. Our design already avoids typing, so this is only a UX note for ax (show "A2A pending" in the tab strip instead of interrupting).
- **Context-usage state** (`state/context-usage`). ax already shows tokens. This is a reminder that per-session context pressure is useful in a cockpit.
- **Activity hooks that exclude prompt text and tool arguments.** This matches our status contract (no model data).

### Recommendation

- Do not wrap or install it.
- If the user wants to see it, run it only in a throwaway VM or container with a separate `$HOME`, never on alyx's real tmux server or home directory. Codex-only or Claude-only pods.
- Close the TODO item with "overlap analysed, rejected on DDR-003, decision 27 and symmetric agency, ideas filed for ax".

## 5. OpenUI

### Facts (reported, README 2026-11-07)

- MIT.
- OpenUI Lang is a streaming, line-oriented UI language. A system prompt is generated from a Zod-defined component library.
- Runtimes: React (most complete), Vue, Svelte and Angular. A browser bundle exists for CDN, iframe or no-build use. `lang-core` has no framework dependency.
- No terminal renderer.
- Ships an Agent Skill (`npx skills add thesysdev/skills --skill openui`).
- Token claim: "up to 67% fewer tokens than JSON". Its own seven-scenario table shows about 52% less than the JSON alternatives. This is self-reported.

### Fit

- **ax** is a terminal UI (ratatui plus tmux). OpenUI does not apply.
- **The harnesses** (Claude Code, agy) render markdown in a terminal. An agent emitting OpenUI Lang there just prints text.
- **coordination**: the only UI-shaped need is a status view.
  - Pending tasks per handle, quarantine count, cognitive-engine run states from `/status`.
  - Decision 19 makes quarantine release TTY-only. A web UI must never release or approve.
  - A static read-only page is simpler than generative UI. OpenUI adds value only if an agent should compose the view on the fly.
- **cognitive-engine**: no UI planned. Harness² reports (`report.json`) and Jev telemetry could one day be a dashboard. Again, static beats generative for a fixed schema.
- **As a standalone skill** in agentic-hub: only useful when building a React or Vue chat app, which none of the current projects is.

### Recommendation

- Drop from the TODO list for now. Re-open if a web front end for coordination `/status` or Harness² reports is ever planned. Even then, compare it with a plain static page first.
- Do not install its skill globally (`~/.agents/skills`). It adds trigger noise to every session for a framework not in use.

## 6. Cross-project findings surfaced during this review

These are not about the three tools, but they came up and need an owner.

- **Port clash on 8120 (verified).**
  - coordination decision 5 puts the A2A server on `:8120` ([`consolidated-bridge-v2-plan.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/consolidated-bridge-v2-plan.md) line 131).
  - cognitive-engine RFC 001 and plan WS3 put the Harness² FastMCP daemon on `127.0.0.1:8120` (`docs/plans/2026-10-26-multi-track-implementation-plan.md` lines 209 and 258). Track 3 Slice 1 is reported done there.
  - Both are planned for the same machines. One must move before coordination S1. Ports in use or reserved: 8100, 8101, 8105, 8110, 8115 (Jev HTTP) and 11434. Candidate free ports to evaluate: 8125 and 8130.
- **cognitive-engine does not know the coordination plugin exists (verified).** Its RFCs and plans have no reference to it. Coordination's status client contract ([`status-client.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/specs/status-client.md)) and the "sbx must never reach the server" rule should be recorded in cognitive-engine RFC 001 or 004. Otherwise Track 3 may open the sbx allow rule to the wrong port.
- **The cognitive-engine bridge doc duplicates the frozen file channel.** `docs/handoffs/antigravity-claude-bridge.md` is a new hand-relayed turn file, the pattern the coordination plan replaces. The A2A server at S1 is the intended replacement. Until then it is fine, but the bridge doc should be added to the go-live importer's scope or retired explicitly.
- **ax is the natural surface for coordination state, and nothing plans it.**
  - ax already has per-tab `@conversation_id` and `@harness`, plus Stop hooks for both agy and Claude-shaped stdin.
  - A read-only `ax` segment showing the A2A handle and "N pending" (calling `GET /sessions` with the `local-harness` key) would make the asymmetric agy path visible to the human. agy has no idle wake, so the human is its wake.
  - This must stay read-only: no typing, no task taking.
- **ax hook placement versus coordination decision 26.** Both write entries into the user-level `~/.gemini/config/hooks.json` (`ax-tab-sync` `Stop`, and coordination's `SessionStart`/`PreInvocation`). Each uses its own key, so they should coexist. The coordination installer must merge, never replace, and the S1 checklist should test with ax's entry present.
- **The cognitive-engine PR #3 remediation list is not in the code (verified by the survey).**
  - There is no `Workflow` matcher in `adapters/claude/hooks/hooks.json`.
  - There is no `workflow-guard.ts`.
  - `hook.ts` activates the guard only in mode `on`.
  - Not related to the TODO, but it is the open Track 1 debt.

## 7. Proposed TODO.md outcome

- Kanzo: keep, re-labelled "trial after coordination S1, stdio only, cognitive-engine Tracks 2 to 4 backlog". No plugin yet.
- OpenUI: remove, with a one-line note to re-open with a web status page.
- OpenRig: remove, with a note that it was rejected on DDR-003, decision 27 and symmetric agency, ideas filed for ax.
- Add:
  - Resolve the 8120 port clash between coordination and Harness².
  - Read-only ax segment for the A2A handle and pending count (after S1).
  - Record the coordination status contract and the sbx exclusion in cognitive-engine RFC 001/004.
