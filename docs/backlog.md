# Backlog: tools to evaluate and actions from reviews

This file replaces the old root `TODO.md`. It holds two things:

- tools still waiting for an evaluation or a decision
- actions that came out of a review and have not landed yet

Finished evaluations move to a review document under `docs/`, with their evidence in `docs/research/`. Keep each item to a few lines, and link to where the reasoning lives.

Status markers:

- `[ ]` open
- `[~]` in progress
- `[x]` done (keep for one review cycle, then delete)
- `[?]` waiting on a decision by the user

## Waiting on a decision

From [adoption review 2026-11](adoption-review-2026-11.md), section 9.

- [?] **Port 8120 owner.** Coordination's A2A server and cognitive-engine's Harness² both claim `127.0.0.1:8120`. Pick one to move. Keep 8121 free for the proposed S3 listener.
- [?] **Backlog approach.** Build "S1b" (a ready-work backlog inside the A2A server) directly, or first trial beads (stealth mode) or Kanzo (stdio only) for two weeks.
- [?] **Third coordination peer.** Codex or OpenCode needs a ChatGPT plan; OpenCode or Copilot CLI needs a Copilot plan. Without one, stay at Claude Code plus agy.
- [?] **`codex queue` stub wake for Codex.** Is it allowed under the "no external driver" stance?
- [?] **DDR-003a.** Extend never-launch, never-drive to Google-account-authenticated Gemini CLI?
- [?] **RFC 005 scope.** cognitive-engine's split leaves agentic-hub with four plugins and drops coordination and subagents. Accept that, or amend RFC 005?
- [?] **cognitive-engine roles.** Replace the fixed Orchestrator and Builder roles with symmetric peers once the bridge moves onto A2A?
- [?] **Blocked research hosts.** Allow these in the environment's network settings to re-check the remaining unverified points:
  - `antigravity.google`
  - `opencode.ai`
  - `github.blog`
  - `docs.ntfy.sh`
  - `geminicli.com`
  - `discuss.ai.google.dev`

## Now: documentation and small fixes

### ax

- [ ] Make `ensure_hook_installed` safe:
  - refuse invalid JSON instead of starting from `{}`
  - back up before writing
  - write atomically
  - do not write through symlinks
  - preserve key order
- [ ] Remove or rename the `"gemini"` → Antigravity alias in `src/core/harness.rs:38`.
- [ ] Shell-quote the branch name in the "New Worktree Tab" palette command.
- [ ] Parse `--resume <id>` for Claude tabs. Today the id lands in the initial prompt.
- [ ] Bind Claude session ids to tabs. The `Stop` hook only looks ids up in agy's database, so Claude tabs never get `@conversation_id`.
- [ ] Update CHANGELOG (0.8.x) and start tagging releases.

### plugins/coordination

- [ ] Reconcile the handle grammar. The spike used `name#sid8`; the spec regex forbids `#`.
- [ ] Fix `server-api.md` 11.2 to agy's named-group flat hooks.json form.
- [ ] Scope the "no `Stop` entry" scan (`implementation-plan.md:602`) to coordination's own group.
- [ ] Refresh the README status, the branch name and the `DatabaseTaskStore` line. Fix the plan §7 C9 label.
- [ ] Correct `bridge-v2-ecosystem-analysis.md`:
  - line 71: agy cannot join Claude agent teams
  - beads storage is Dolt
  - the `mcp_agent_mail_rust` pairing is excluded

### cognitive-engine

- [ ] Record the coordination status-client contract and "sbx never reaches the coordination server" in RFC 001/004.
- [ ] Land PR #4 (Workflow guard).
- [ ] `hook.ts`: activate in `on-demand` as well as `on`.
- [ ] Jev guard:
  - read `CLAUDE_CODE_SUBAGENT_MODEL` and `_FORCE`
  - resolve plugin and managed agent definitions, or fail closed
  - handle `plugin:agent` names
- [ ] OpenCode adapter:
  - delegation tool `subagent`, not `task`
  - read `event.input.prompt`
  - update the restart guidance (`opencode reload`)
- [ ] Jev Recall URL: stop hard-coding `:8110` (`telemetry.ts:65`) before RFC 005 retires it.
- [ ] Give native lookup a staging port. It and the legacy lookup both want 8100 during migration (unverified clash).
- [ ] Jev OpenCode tier map: replace the `~anthropic/...-latest` OpenRouter slugs (pay-per-token) with `openai/...` or `github-copilot/...` models if OpenCode runs on a subscription. Never `claude-agent/*`.
- [ ] agy guard: check whether a model set in `define_subagent` front matter bypasses the `invoke_subagent` guard.
- [ ] Defence in depth: have the user's installer add a native Claude deny rule `Agent(model:opus)`.
- [ ] Any future Codex adapter must return `deny` (Codex fails open on `ask`). Any Copilot guard fails open on hook timeout.

### plugins/coordination (cross-repo)

- [ ] `status-client.md` cites `packages/harness2/README.md`, `session_runner.py` and `sbx_session.py`, which do not exist on cognitive-engine `main`. Re-point the citations once Track 3 merges.

### agentic-hub

- [x] Root README and AGENTS.md trees: add `docs/`, coordination and subagents (2026-11-07).
- [ ] Root README and AGENTS.md: add the mcp-toggle skill. Remove the references to `plugins/jev/opencode/`, which does not exist.
- [ ] Jev README: it says hooks are at `hooks/hooks.json`; the real path is `./claude/hooks.json`. Align the `package.json` version (2.0.0) with `plugin.json` (2.3.0).
- [ ] Coordination docs link to `/home/rockad/...`, which resolves only on alyx. Consider repo-relative links.
- [ ] Memory compose: bind 8110 and 8100 to `127.0.0.1`.
- [ ] RFC 005 Phase A deprecation notices on `plugins/jev` and `plugins/memory`, once the scope decision above is made.

## Next: alongside coordination S1

- [ ] Add spike **SP6**: Claude inbox-socket wake from an `async: true` hook. Vary the stub so the duplicate filter does not drop it.
- [ ] Add spike **SP7**: Claude plugin monitor as a session-long listener.
- [ ] S1 exit gate:
  - `a2a-tck --level must` against loopback
  - `a2a-inspector` on 127.0.0.1 for debugging
- [ ] Sanitize peer text in previews and status: strip control, format and bidi characters, and cap the length.
- [ ] Self-hosted ntfy on core (tailnet) for `INPUT_REQUIRED` and `QUARANTINED`:
  - stub text only
  - no action buttons
  - never a release path
- [ ] ax: "needs input" tab state from the Claude `Notification` hook, plus jump to newest waiting.
- [ ] ax: Claude `rate_limits` meters from the statusline JSON. Optionally feed `jev_quota`.
- [ ] ax: `CopilotDriver` (`--session-id`, `--resume`, `--continue`).
- [ ] ax: Codex history (`state_5.sqlite`) and `codex resume`.
- [ ] ax: OpenCode title sync through `PATCH /api/session/:id`. Honour `OPENCODE_DB`.
- [ ] ax: keep Claude `teammateMode` in-process. Skip panes without `@harness` when snapshotting.
- [ ] ax: register worktrees made outside ax through Claude's `WorktreeCreate` and `WorktreeRemove` hooks.
- [ ] ax: restore re-runs only allowlisted commands and asks before anything else (the cmux idea).
- [ ] ax: read-only discovery of Claude sessions it did not launch (`claude agents --json`, reported).

## Later: after S1 runs

- [ ] **S1b backlog** in the A2A server, using the beads model:
  - dependency edges
  - a ready view
  - compare-and-set claim
  - lease and heartbeat
  - auto-unblock

  Ready is a query, never a trigger.
- [ ] ax read-only coordination segment (`@a2a_handle`, `@a2a_pending` per pane, set by the harness's own hook).
- [ ] ax worktree lifecycle:
  - close and prune
  - optional expiry
  - pinned flag
  - divergence badge
  - `git worktree lock --reason` as the lease
- [ ] Commit trailers `A2A-Task:` and `Session:` (Jev `commit.ts`).
- [ ] Gitea plugin: read-only issue dependency tools plus a ready query.
- [ ] Third peer spike, depending on the decision above, one of:
  - `codex queue` stub wake
  - OpenCode V2 plugin wake (restricted task-taking agent, `delivery: "queue"`)
  - Copilot `agentStop` stub wake
- [ ] Move the cognitive-engine bridge onto coordination.
- [ ] S3 gate: smugglex against the staging tunnel; `mcp-scanner` static on the `/mcp` tool list.

## Tools to evaluate

Watch items. Each was looked at briefly, and none needs action now.

- **Codex `wake_on_agent_messages` and the agent message board** (in development). Could become a native mailbox with idle wake.
- **agent-bus** (already a coordination watch item). Hash-chained event log; can emit to ntfy.
- **ccusage.** Historical per-block usage from local transcripts, if Jev reporting needs history.
- **Copilot `write_agent` / session tools.** Watch whether they gain an external entry point.

## Closed

- [x] **Kanzo, OpenUI, OpenRig** (the original TODO, 2026-11-07). Evaluated in [adoption review 2026-11](adoption-review-2026-11.md):
  - Kanzo: optional trial only.
  - OpenUI: skip.
  - OpenRig: skip, with ideas borrowed.
- [x] **beads, vibe-kanban, Claude agent teams, native harness features** (Claude Code, Antigravity, Codex, OpenCode, Gemini CLI, Copilot CLI). Same review.
