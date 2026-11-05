# Claude Code workstream: A2A coordination server research (2026-11-04)

Owner: Claude Code (session `agents-bridge-52`). Scope: research and planning only until the user lifts the scope rule (see "Open decisions" below).

## Direction from the user (2026-11-04)

- Explore the A2A path further.
- Build an MCP facade plus harness hooks plus a Docker container with persistent volumes for the data.
- Expose it to the web later, so other agents can connect over HTTPS or another protocol.

## Tasks

- [x] **T1: Third-party audit** (read-only clones in the session scratchpad, no code executed, Sonnet subagents in parallel).
  - Per candidate the audit checked:
    - license and any terms rider (standing rule)
    - whether it spawns or wraps agent CLIs (DDR-003, live-session rule)
    - A2A spec version and which of the 11 core operations it implements
    - MCP transport, wake mechanism, persistence, auth, Docker support, maintenance
    - verdict: adopt, fork, borrow pattern, reject
  - [x] T1a: A2A bridges with an MCP facade ([report](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1a-a2a-mcp-bridges.md)):
    - `toshiotomikawa/a2a-bridge`: REJECT (spawns `agy -p`, `claude -p`, `codex exec`)
    - `mgcrea/mcp-a2a`: BORROW PATTERNS (no spawning, parks inbound tasks as SUBMITTED; single shared queue, JSON-file store, stdio only)
  - [x] T1b: Idle-session wake mechanisms ([report](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1b-wake-mechanisms.md)):
    - `amahpour/switchboard`, `interlink-mcp`, `zb-ss/agent-group-mcp`, official Antigravity hooks page, Claude Code `asyncRewake` and Channels docs
    - Claude wake: borrow switchboard's `asyncRewake` long-poll
    - agy: no documented compliant wake; `PreInvocation` surfacing at the next model call, background watcher started by the agy session as fallback
    - Channels: optional accelerator only
  - [x] T1c: Remaining bridges and infrastructure ([report](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t1c-bridges-and-sdks.md)):
    - `TonPC64/mcp-a2a-bridge`: BORROW (examples spawn `claude -p`)
    - `GongRzhe/A2A-MCP-Server`: REJECT (archived, pre-1.0)
    - `hieuntg81/a2a-bridge`: 404, unauditable
    - Docker Agent: BORROW (in-memory A2A task store, `claude --print` sub-agents)
    - `a2a-python` 1.3.0: recommended build base (all 11 ops, `DatabaseTaskStore`, multi-process cluster mode)
    - `a2a-js`: second choice
- [x] **T2: cognitive-engine integration input** ([reply](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/t2-cognitive-engine-integration.md)):
  - external peer only; cognitive-engine is a one-way status client, never a task provider
  - reuse `audit.jsonl` and the approval gate, never duplicate them
  - ports outside 8100-8110 and 11434
- [x] **T3: Synthesis**: [`a2a-mcp-wake-audit-2026-11-04.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-mcp-wake-audit-2026-11-04.md); reports copied to [`a2a-audit-2026-11-04/`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/research/a2a-audit-2026-11-04/).
- [x] **T4: Research plan update** in [`consolidated-bridge-v2-plan.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/consolidated-bridge-v2-plan.md) and [`master-tasklist.md`](file:///home/rockad/projects/agentic-hub/plugins/coordination/docs/plans/master-tasklist.md):
  - [x] DDR-004 draft (status PROPOSED, awaiting the user): A2A coordination server in a container, MCP facade, hook-based wake, staged exposure (localhost, tailnet, public HTTPS).
  - [x] Revised roadmap as proposed stages inside DDR-004; current Phases 0-4 kept until accepted. Wake asymmetry recorded (Claude: `asyncRewake` hook; agy: `PreInvocation` surfacing, watcher fallback).
  - [x] Pending message-29 edits: "A2A-aligned, not a conforming binding" label; Agent Card required fields; `roster/` and `contexts/` in the directory plan; swarmail agy-hook finding as a user decision; unchecked items.
  - [x] Removed the duplicated Phase 2 exit-criteria / kill-switch / installer block.
- [x] **T5: Channel note** (message 1, 2026-11-04T14:22) to Antigravity in [`bridge-v2-coordination-channel.md`](file:///home/rockad/.agents/bridge-v2-coordination-channel.md) (one append).
- [x] **T6: Final verification** on the highest available tier (`opus`; `message.model` confirmed `claude-opus-5-5`). 13 findings; 12 applied (exit-code semantics, DDR-002/003 impact listed in DDR-004, Risk 3 section reference, GongRzhe license, mgcrea patterns vs limits, port-check attribution, spawn count, labels, a2a-go verdict, formatting). One skipped: it cited the retired Fable rule. Then commit.

## Open decisions for the user

All resolved in DDR-004 decisions 1-36 ([`consolidated-bridge-v2-plan.md`](consolidated-bridge-v2-plan.md)).

## S0 spikes and stacked PRs (2026-11-05)

- [x] **P1: Implementation plan** ([`implementation-plan.md`](implementation-plan.md)), committed `963d3b0`; decisions 25-36 committed `420bc27`.
- [x] **P2: Branch** `feat/coordination-s0` from `420bc27`.
- [x] **P3: Spike workflow** `wf_bf52f70a-49b` (relaunched after the 5-hour limit killed the first run):
  - [x] S0-SCAF stub on 127.0.0.1:18120, SP1 offline listener test, C9 header check ([results](../research/spike-results-2026-11-05-s0-scaf-sp2-c9.md))
  - [x] SP5 SQLite/WAL stress (D1-D12): PASS with four wrappers, one open defect for S1 (session reuse across keys) ([results](../research/spike-results-2026-11-05-sp5.md))
  - [x] Runbooks for SP1, SP2, SP3 and SP4 ([runbooks](../research/spike-runbooks-2026-11-05.md))
  - [x] Opus verification pass
  - [x] Apply verification fixes (3 low findings skipped with reasons and recorded in runbook section 6.3)
- [x] **P4: Cleanup check**: no `a2a-spike-*` containers, volumes or images, no `a2a-stub` in `~/.claude.json`, nothing on 18120-18129, no spike code in the repo. Known residuals: an inert empty `projects` entry for the sp2c scratch path in `~/.claude.json`, and empty `/tmp/err.*` and `/tmp/x.out` files.
- [x] **P5: Commit** spike results and runbooks on `feat/coordination-s0`, rebased onto the new `feat/coordination`.
- [x] **P6: Stacked PRs** on `rockad/agentic-hub`, both merged into `main` on 2026-11-05. From then on, docs work commits and pushes directly to `main` until consolidation ends (user direction, 2026-11-05).
  - [x] `feat/coordination` → `main`: [#15](https://github.com/rockad/agentic-hub/pull/15), rebased onto `origin/main` and dropping the stray `e320efc` clarify commit, which is kept as `backup/clarify-e320efc`
  - [x] `feat/coordination-s0` → `feat/coordination`: [#16](https://github.com/rockad/agentic-hub/pull/16), retargeted to `main` before merge
- [ ] **P7: Hand-off**: the user and Antigravity run SP1, SP2 (both halves), SP3 and SP4 from the runbooks.
