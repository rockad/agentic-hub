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

## Open decisions for the user (blocking implementation, not research)

- Lift the "zero daemons" and "planning only" rules for this component?
- Home: `agents-bridge` or `agentic-hub/plugins/coordination`?
- Language: Python (`a2a-python`) or TypeScript/Bun (`a2a-js`)?
- Antigravity side: hooks allowed, or MCP tools only?
- ACP: keep as a future carrier or drop?
