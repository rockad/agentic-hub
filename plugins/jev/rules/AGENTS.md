# TypeSafe Jev: Rules & Guidelines

This document governs System 1 decision-making, model tier governance, thinking effort, and quota preservation for AI agents using the `jev` plugin.

## 1. Operating Modes

- **`off`**: MCP disabled (`agy mcp disable jev`), zero token overhead, zero OpenRouter calls. Nothing runs and nothing is written.
- **`on-demand`**: MCP enabled. Passive System 1 coprocessor for multi-role workflows and ad-hoc routing. The tools are available and telemetry rows are written; a one-line informational quota notice appears only when a pool is `conserve`, `free_only` or exhausted. **No decisions** (no deny, ask, clamp, approvals, downgrade or guards) and **no routing advice** (no router call at prompt time, no directive, no tier advice), in every harness.
- **`on`**: Aggressive System 1 enforcement: mandatory pre-flight dispatch, free-tier offloading, thinking effort governance, and automated quality gates.
- **In on-demand Jev enforces nothing**: a pro (Claude Code: opus) subagent runs without any approval prompt from Jev. The pro-approval rule then depends only on the agent following its instructions. Use mode `on` to have Jev enforce it.
- **One definition for every harness**: what each mode does lives in `src/core/mode-policy.ts` (`modeBehaviour`, `lowQuotaNotice`). Every harness adapter, including any later one (OpenCode, Codex), must consult it rather than compare the mode itself.
- **Every telemetry row records its mode** (2.3.19): `mode` is `on` or `on-demand`, the mode the hook acted under (`telemetryMode` in `mode-policy.ts`); `off` writes no row. A row with a suggested or applied downgrade also carries `costSaving`, the cost difference to the downgrade target at the same effort (the downgrade stays model-only).
- **Primary Switch Mechanism**: Managed directly via the in-chat `/jev` slash command / skill (`/jev on`, `/jev on-demand`, `/jev off`, `/jev status`) and the `jev_set_mode` / `jev_get_mode` MCP tools. The legacy shell script (`scripts/jev-mode`) is retired. `~/.config/jev/config.json` is the single canonical configuration store for global defaults (`defaults.mode`) and per-harness overrides (`harnesses.<harness>.mode`). Drift between `config.json` and `agy mcp` is automatically healed during pre-flight.

## 2. Pre-Flight Dispatch & Routing

- **Pre-Flight Dispatch (`jev_dispatch`)**:
  - Run before executing non-trivial tasks, refactors, or spawning subagents.
  - Evaluates calibrated probability distributions over candidate subagents and execution tiers (`openrouter_free`, `flash_lite`, `flash`, `pro`).
  - If `recommendedTier` is `openrouter_free`, execute immediately via `jev_execute_free` rather than spawning a paid subagent.
- **Post-Approval Execution Transition Gate (`jev_batch_dispatch`)**:
  - Upon plan approval or completion of `/grill-me` (`clarify`), the main orchestrator MUST immediately call `jev_batch_dispatch` and `manage_subagents(Action: "list")` to decompose and delegate independent workstreams in parallel rather than editing multiple files sequentially in the main context.
  - Enforced by `PreToolUse` (`jev-pre-tool.sh`), which checks `jev_telemetry.jsonl` and blocks consecutive direct edits (>3 files) in the session window if no recent dispatch (`jev_dispatch` / `jev_batch_dispatch`) or subagent delegation occurred.
- **Fast Option Routing (`jev_route`)**:
  - Use when a discrete choice between 2–8 options needs a fast calibrated probabilistic verdict (~800ms) via OpenRouter Decisions API.

## 3. Free-Tier Offloading & Quota Preservation

- **Zero-Cost Offloading (`jev_execute_free`)**:
  - Offload mechanical work—boilerplate scaffolding, markdown formatting, text transformations, log distillations, and draft summaries—to `openrouter/free` at **$0.00 cost** and **zero Gemini quota**.
  - Subagents performing bulk transformations or formatting must call `jev_execute_free` directly.
- **Concurrency Cap**:
  - Cap concurrent tasks targeting `openrouter_free` at **maximum 10 simultaneous instances** to respect OpenRouter rate limits.
- **Quota Exhaustion & 429 Fallback**:
  - If a subagent returns `RESOURCE_EXHAUSTED` (HTTP 429), never fall back to generating the task in the main agent context. Retry on the free tier via `jev_agent_free` or `jev_execute_free`.

## 4. Session Model Alignment & Thinking Effort Governance

- **Session Model Ceiling**:
  - The model running in the main agent session defines the absolute upper-bound model tier and version ceiling for all delegated subagents and tasks.
- **Subagent Tier Clamping**:
  - Subagents default to `Model: "inherit"` or lower (`flash`, `flash_lite`, `openrouter_free`).
- **Low-Quota Protocol (<20% Remaining)**:
  - When `gemini-weekly` or `gemini-5h` is under 20% remaining (as reported in `quota-state.json` or `jev_quota`):
    - All new subagents MUST be clamped strictly to `Model: "flash_lite"` (the lowest token-weight model available in Antigravity).
    - Pro tier is strictly prohibited.
    - All non-essential text formatting, markdown transformations, and scaffolding boilerplate must be offloaded to `jev_execute_free` or `jev_agent_free` ($0.00 cost, 0 Gemini quota).
    - When `jev off` and quota is `<20%`, pre-flight and pre-invocation hooks inject a native-only warning clamping subagents to `Model: "flash_lite"` without referencing disabled `jev_*` MCP tools, and advise running `jev on` to re-enable free-tier offloading.
- **Subagent Lifecycle & Pro Reuse Prohibition**:
  - Before invoking any new subagent, inspect active and idle workers with `manage_subagents(Action: "list")` and reuse idle workers via `send_message`.
  - **Never reuse an idle subagent originally spawned on `Model: "pro"`** during quota-conservation or routine tasks, as messaging it continues consuming Pro quota. Only reuse workers originally spawned on `flash` or `flash_lite`.
- **Execution Parameters vs. Dispatch Recommendations**:
  - Distinguish pre-flight `jev_dispatch` recommendations from actual execution parameters.
  - Native `invoke_subagent` runs exclusively on Gemini (`inherit`, `flash_lite`, `flash`, `pro`). Autonomous free-tier workspace tasks execute via `jev_agent_free` or `jev_execute_free` (`openrouter/free`).
- **Pro Tier Manual Approval Workflow**:
  - Pro tier models (`pro`, `opus`) must NEVER be used automatically.
  - If `jev_dispatch` recommends `pro`, prompt the user for explicit approval. If declined, execute on `flash` or cheaper.
- **Antigravity `run_workflow` guard (mode `on`)**:
  - The agents a `run_workflow` script launches never reach the `invoke_subagent` hook, so the hook analyses the script (`Script` or `ScriptPath`) statically on every call and binds its decision to the sha256 of the text it read.
  - A literal `model` above the session ceiling is denied with the `[jev-elevate:<model>]` `ask_question` (with `(sha256:<12hex>)`); ask it as prescribed and retry. A script Jev cannot verify is denied with guidance; write a literal `model` on every `agent(...)` call. Only `JEV_ELEVATION=dialog` ever asks.
  - A local import (a sibling `.py` file or package next to the script or under its Cwd, or a relative import) is unverifiable: inline the `agent(...)` calls or remove the import.
  - `on-demand` makes no decision and `off` does nothing. Drift of a script file after the run is logged as `workflow_changed` and the pin is marked `drifted`; a pin is never a verdict, every call re-analyses the file as it is.
- **Thinking Effort**:
  - Match reasoning effort to task complexity. High thinking effort should be reserved for ambiguous architectural decisions, while routine transformations run with minimal or zero thinking overhead.
  - Claude Code, mode `on`: a delegation (`Agent`, `Task`, or an `agent()` call in a `Workflow`; Antigravity: `invoke_subagent` and `run_workflow`) needs approval only when it costs more than the session's own model at the session's effort (2.3.19, one cost gate; session opus at high is 22.5: sonnet at max passes, opus at xhigh does not). It is denied until the user approves it with the prescribed question (marker `[jev-elevate:<model>]` for a model above the session's, `[jev-elevate-effort:<level>]` when only the effort is; Yes once, Yes for the next 5 minutes, Yes for this session, No proceed on the session model or run at the highest effort that fits), or the prompt names that model or effort. An approval covers its model at its effort and lower. Where the cost cannot be computed (no session effort, a relative effort, a model with no tier), the older rules apply: the model ceiling by rank, and an effort of `xhigh` or `max` is denied until approved the same way. The same applies to a literal `xhigh`/`max` `effort` in a Claude Code `Workflow` script (one answer covers the whole script). Every `agent_call` row carries `costEstimate`, `sessionCost`, `costRatio` and `costWeightsVersion` (model weight times effort weight against the session's) and, in a mode that decides, `cost_gate` (`pass`, `denied`, `approved`, `clamped`, `fallback`). Outside `JEV_ELEVATION=dialog` Jev never uses a permission dialog for it, or for an unranked model, an unreadable agent definition or an unverifiable Workflow: those are denied with guidance.
  - Claude Code, unknown session model (2.3.19, fails closed): when the session model is not known yet (a brand-new or headless session before its transcript is written, no `SessionStart` record), Jev holds the session as `sonnet`, and as `high` effort when the effort is not reported either. An `opus` delegation, or an `xhigh`/`max` effort, takes the same question as on a known sonnet session (the deny reason says `The session model is not known yet, so Jev assumes sonnet.`), for `Agent`, `Task` and `Workflow` `agent()` literals alike; approvals work as usual and the real model is used as soon as it is known. Rows carry `session_model_source: "assumed"` and `sessionModelAssumed: true`; no downgrade is offered against an assumed model. `on-demand` and `off` decide nothing. Antigravity already did this: an unknown session model is held at the flash tier (`gemini-3.8-flash-low`).
  - Antigravity, what `Model` really is (2.3.19, verified on Antigravity 1.5.14): `invoke_subagent`'s `Model` is an enum, `inherit | flash_lite | flash | pro`, and it is not a quality ladder. Under every parent `flash_lite` is served on `gemini-3.5-flash-lite`, `flash` on `gemini-4-hydrogen-tiered-high` and `pro` on `gemini-4-hydrogen-tiered-xhigh` (Gemini 4 Hydrogen at xhigh, a flash-class model, never Argon, Neon or Opus); `inherit` or an omitted `Model` is served on the parent's own model. So do not request `pro` to get a pro-class model: a subagent on Argon needs the session itself on Gemini 4 Argon, with `Model: "inherit"`. The cost gate prices a call by the model it is served on (`pro` costs as Hydrogen at xhigh), so `pro` is held only when that exceeds the session's own cost and simply passes otherwise; the `flash` / `flash_lite` ceiling alias always passes. In mode `on`, when a subagent is served below the tier its `Model` named, one short `[jev]` line says so (once per conversation per requested/served pair); `on-demand` and `off` show nothing. Claude Code serves what it is asked and is unchanged.

## 5. Quality Gates (`jev_judge`)

- Gate non-trivial diffs, code refactors, and test outcomes using `jev_judge`.
- Pre-commit: reject diffs containing merge conflict markers or unresolved lint failures.
