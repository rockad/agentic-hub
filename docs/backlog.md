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

- [x] **Port 8120 owner.** Decided 2026-11-08: Harness² moves to 8125; coordination keeps 8120; 8121 stays free for the S3 listener. Record it in the coordination docs, and change the default in cognitive-engine #5 when it is restacked. See [pr-plan-2026-11-08.md](pr-plan-2026-11-08.md).
- [?] **Backlog approach.** Build "S1b" (a ready-work backlog inside the A2A server) directly, or first trial beads (stealth mode) or Kanzo (stdio only) for two weeks.
- [?] **Third coordination peer.** Codex or OpenCode needs a ChatGPT plan; OpenCode or Copilot CLI needs a Copilot plan. Without one, stay at Claude Code plus agy.
- [?] **`codex queue` stub wake for Codex.** Is it allowed under the "no external driver" stance?
- [?] **DDR-003a.** Extend never-launch, never-drive to Google-account-authenticated Gemini CLI?
- [x] **RFC 005 scope.** Decided 2026-11-08: amend RFC 005 so agentic-hub keeps coordination and subagents; only `jev` and `memory` retire. The edit rides on a cognitive-engine docs PR (#7 or #11).
- [?] **cognitive-engine roles.** Replace the fixed Orchestrator and Builder roles with symmetric peers once the bridge moves onto A2A?
- [?] **Blocked research hosts.** Allow these in the environment's network settings to re-check the remaining unverified points:
  - `antigravity.google`
  - `opencode.ai`
  - `github.blog`
  - `docs.ntfy.sh`
  - `geminicli.com`
  - `discuss.ai.google.dev`

## Order of work

**Coordination (`plugins/coordination`, S0 close and S1) comes before the cognitive-engine PR queue.** The full sequence, decisions and workstreams are in [pr-plan-2026-11-08.md](pr-plan-2026-11-08.md). Sections below marked "after coordination S1" wait for it. The owner still has points to clarify before this plan starts, and cognitive-engine work resumes with a `/clarify` pass on Phase 2.

## Now: documentation and small fixes

### ax

- [ ] Make `ensure_hook_installed` safe. **Prerequisite for coordination's agy hooks**, which live in the file it can wipe:
  - refuse invalid JSON instead of starting from `{}`
  - back up before writing
  - write atomically
  - do not write through symlinks
  - preserve key order
- [ ] Remove or rename the `"gemini"` → Antigravity alias in `src/core/harness.rs:38`.
- [ ] Shell-quote the branch name in the "New Worktree Tab" palette command.
- [ ] Parse `--resume <id>` for Claude tabs. Today the id lands in the initial prompt.
- [ ] Bind Claude session ids to tabs. The `Stop` hook only looks ids up in agy's database, so Claude tabs never get `@conversation_id`.
- [ ] Update CHANGELOG (stops at 0.7.0; tags already exist up to v0.8.4).

### plugins/coordination

- [ ] Decide the handle grammar and record it. The spike used `name#sid8`; the spec (`server-api.md:472`) forbids `#` and appends `-` plus 4 hex on collision. Record why `#sid8` was rejected, or adopt it. **Needs your decision.**
- [ ] Fix `server-api.md` 11.2 to agy's named-group flat hooks.json form.
- [ ] State explicitly that the "no `Stop` entry" scan (`implementation-plan.md:602`) covers coordination's own group only, since ax adds a `Stop` entry to the user-level file.
- [ ] Refresh the README status, the branch name and the `DatabaseTaskStore` line. Fix the plan §7 C9 label.
- [ ] Correct `bridge-v2-ecosystem-analysis.md`:
  - line 71: agy cannot join Claude agent teams
  - beads storage is Dolt
  - the `mcp_agent_mail_rust` pairing is excluded

### cognitive-engine (after coordination S1; order and decisions in [pr-plan-2026-11-08.md](pr-plan-2026-11-08.md))

- [ ] Advisory CI workflow on `main` (`tsc`, `bun test`, `pytest`), after #4 and #18 and before the restacks.
- [ ] Restack #5, #7, #8 and their children with `rebase --onto main` and a `range-diff` comment. Merge parents without squash.
- [ ] Review: slice #5 and #8 for `@Doc-Cr` with an Opus pre-pass; the owner reads #7.
- [ ] Merge #13 (BuildSlot) after #5 and #6. Link the spec at `plugins/coordination/docs/specs/buildslot-spec.md`.
- [ ] Change the Harness² port default to 8125 in #5 (decision 2026-11-08).
- [ ] Amend RFC 005 to keep coordination and subagents.
- [ ] Record the coordination status-client contract and "sbx never reaches the coordination server" in RFC 001/004.
- [ ] Land PR #4 (Workflow guard). It also fixes `hook.ts` activation in `on-demand` and `plugin:agent` lookup (verified 2026-11-08).
- [ ] Jev guard (not covered by PR #4):
  - read `CLAUDE_CODE_SUBAGENT_MODEL` and `_FORCE`
  - resolve managed agent definitions, or fail closed
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
- [x] Root README and AGENTS.md: add the celi5, cplain and mcp-toggle skills (README already had mcp-toggle). Remove the references to `plugins/jev/opencode/`, which does not exist (2026-11-08, uncommitted).
- [x] Jev README: hooks path is `./claude/hooks.json`; removed the missing `opencode/` tree entry. `package.json` version aligned to `plugin.json` (2.3.0) (2026-11-08, uncommitted).
- [ ] Coordination docs link to `/home/rockad/...`, which resolves only on alyx. Consider repo-relative links.
- [ ] Subagents plugin for Claude Code, Antigravity and Codex (decided 2026-11-08; closes the subagents half of issue #13):
  - canonical source in `plugins/subagents/src/`
  - `scripts/build-agents.ts` with a `--check` drift test
  - verify the Codex agent TOML schema before emitting `codex/agents/*.toml`
  - update the plugin README and the Claude marketplace entry
  - reply to `@Doc-Cr` on issue #13
- [x] Memory compose: bind 8110 and 8100 to `127.0.0.1` (2026-11-08, uncommitted). Takes effect after `docker compose up -d`; check that nothing reaches these ports from another host first.
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
