# TypeSafe Jev: Rules & Guidelines

Governs System 1 decision-making, model tier governance, thinking effort, and quota preservation for `jev`.

## 1. Operating Modes & Telemetry

- **`off`**: MCP disabled (`agy mcp disable jev`), zero token overhead, zero OpenRouter calls, nothing runs or writes.
- **`on-demand`**: MCP enabled; telemetry written; 1-line quota notice only when a pool is `conserve`, `free_only`, or exhausted. **No decisions** (no deny, ask, clamp, approvals, downgrade, or guards) and **no routing advice** (no prompt-time router call, directive, or tier advice) in any harness; `pro`/`opus` subagents run without a Jev prompt (agent rules only).
- **`on`**: Aggressive enforcement (pre-flight dispatch, free-tier offloading, effort/cost-gate governance, pro-approval guard, quality gates).
- **Single Mode Policy**: Mode behavior lives canonically in `src/core/mode-policy.ts` (`modeBehaviour`, `lowQuotaNotice`). All harness adapters (Claude Code, Antigravity, OpenCode, Codex) must consult it rather than comparing mode strings directly.
- **Telemetry (`2.3.19`)**: Every row logs `mode` (`on` | `on-demand` via `telemetryMode`; `off` writes nothing). Downgrade rows add `costSaving` (cost diff to target at same effort; downgrade stays model-only).
- **Switching & Config**: Use `/jev <on|on-demand|off|status>` or `jev_set_mode` / `jev_get_mode` (`scripts/jev-mode` retired). `~/.config/jev/config.json` (`defaults.mode`, `harnesses.<harness>.mode`) is canonical; drift vs `agy mcp` auto-heals in pre-flight.

## 2. Pre-Flight Dispatch & Routing

- **`jev_dispatch`**: Run before non-trivial tasks, refactors, or spawning subagents (`openrouter_free`, `flash_lite`, `flash`, `pro`). If `recommendedTier === "openrouter_free"`, call `jev_execute_free` immediately.
- **`jev_batch_dispatch`**: After plan approval or `/grill-me` (`clarify`), call `jev_batch_dispatch` + `manage_subagents(Action: "list")` immediately to delegate parallel workstreams. `PreToolUse` (`jev-pre-tool.sh`) inspects `jev_telemetry.jsonl` and blocks `>3` consecutive direct edits without recent dispatch or subagent delegation.
- **`jev_route`**: Fast (~800ms) discrete routing among 2–8 options via OpenRouter Decisions API.

## 3. Free-Tier Offloading & Quota Preservation

- **`jev_execute_free`**: Offload boilerplate, markdown formatting, text transforms, log distillation, and summaries to `openrouter/free` ($0.00 cost, 0 Gemini quota). Subagents doing bulk formatting must call it directly.
- **Concurrency & 429 Fallback**: Cap `openrouter_free` at **10** concurrent instances. On `RESOURCE_EXHAUSTED` (429), never fall back to main-context generation; retry via `jev_agent_free` or `jev_execute_free`.

## 4. Session Ceiling, Subagents & Effort/Cost Gate

- **Ceiling & Defaults**: Main session model is the upper-bound ceiling. Default subagents to `Model: "inherit"` or cheaper (`flash`, `flash_lite`, `openrouter_free`). Native `invoke_subagent` runs Gemini; free-tier autonomous tasks use `jev_agent_free` / `jev_execute_free`.
- **Low-Quota (`<20%` `gemini-weekly` or `gemini-5h` in `quota-state.json` / `jev_quota`)**: Clamp new subagents to `Model: "flash_lite"`, ban Pro, and offload text/scaffolding to `jev_execute_free` / `jev_agent_free`. Under `jev off` and `<20%`, hooks inject a native `flash_lite` clamp warning without citing disabled `jev_*` tools and advise `jev on`.
- **Lifecycle & Pro Rules**: Inspect `manage_subagents(Action: "list")` and reuse idle `flash`/`flash_lite` workers via `send_message`; **never reuse idle `Model: "pro"` workers** for quota-conservation or routine tasks. Never auto-spawn `pro`/`opus`; ask user if `jev_dispatch` recommends `pro` (else fall back to `flash` or cheaper).
- **Antigravity `run_workflow` Guard (mode `on`)**: Statically checks `Script`/`ScriptPath` on every call (workflow `agent(...)` calls bypass `invoke_subagent` hooks) and binds decisions to read-text `sha256`. Literal `model` above ceiling denies with `[jev-elevate:<model>]` `ask_question` (`(sha256:<12hex>)`). Unverifiable scripts (non-literal `model`, or relative/sibling/Cwd local imports) deny with guidance to inline `agent(...)`, use literal `model`s, or drop imports. Only `JEV_ELEVATION=dialog` asks; `on-demand`/`off` decide nothing. Post-run drift logs `workflow_changed` and marks pin `drifted` (pins are never verdicts; each call re-analyzes live text).
- **Thinking Effort & Cost Gate (`2.3.19`–`2.3.21`)**:
  - Match effort to complexity (high for ambiguous architecture; minimal/zero for routine transforms).
  - **Stronger Model Always Asks (`2.3.19`, both modes)**: Subagents above session tier (`opus`/`fable` > `sonnet`/`haiku` in Claude Code; tier-higher full IDs e.g. `gemini-4-argon-*` / `claude-opus-5-5-*` > flash in Antigravity, and any pro-class full ID under Orchestrator) require `[jev-elevate:<model>]` approval regardless of effort unless named in prompt. Antigravity enum `Model` prices by served model (`pro` = Hydrogen, flash class).
  - **Cost Gate Mode (`2.3.19`)**: `costGate` in `~/.config/jev/config.json` (`defaults.costGate` / `harnesses.<harness>.costGate`; `JEV_COST_GATE` overrides). `shadow` (default) uses rank-ceiling + `xhigh`/`max` rule and logs `cost_gate_shadow` (`pass`, `denied`, `clamped`, `fallback`); `enforce` decides via cost gate and logs `cost_gate`. State active mode when explaining a held delegation.
  - **Enforce Behavior (mode `on`)**: Holds `Agent`, `Task`, `Workflow` `agent()`, `invoke_subagent`, or `run_workflow` only when `costEstimate > sessionCost` (opus@high=22.5: sonnet@max passes, opus@xhigh asks). Asks `[jev-elevate:<model>]` or `[jev-elevate-effort:<level>]` (Yes once [this turn, no clock]; Yes this session; No proceed on session model / highest fitting effort [this call]; No do not ask again this session [runs later launches on session model]; `2.3.21`: answer applies immediately, no window/denial needed, 1-line confirmation) unless prompt names that model/effort; approval covers that model at that effort and lower. Missing cost inputs (absent/relative effort, unranked model) fall back to rank ceiling + `xhigh`/`max` approval (including literal `xhigh`/`max` in Claude Code `Workflow`, 1 answer/script). Rows log `costEstimate`, `sessionCost`, `costRatio`, `costWeightsVersion`, `cost_gate` (`pass`, `denied`, `approved`, `clamped`, `fallback`), plus (`2.3.20`) `toolUseId`/`callKey` (if valid) and `effortSource`/`effortRequested` (omitted on Workflow/`run_workflow`). Never use a permission dialog outside `JEV_ELEVATION=dialog` for cost gate, unranked model, unreadable agent def, or unverifiable Workflow.
  - **Unknown / Unplaced Session Model (`2.3.19`, fails closed)**: Claude Code assumes `sonnet` (+ `high` effort if unset) when unknown (`The session model is not known yet, so Jev assumes sonnet.`) or unplaced (`The session model <id> is not one Jev knows, so Jev assumes sonnet.`, adds `sessionModelReported`), logging `session_model_source: "assumed"` and `sessionModelAssumed: true` with no downgrade (`on-demand`/`off` silent). Antigravity holds unknown models at flash (`gemini-3.8-flash-low`).
  - **Antigravity `Model` Enum (`2.3.19`, verified `1.5.14`)**: `inherit | flash_lite | flash | pro` is NOT a quality ladder: `flash_lite`->`gemini-3.5-flash-lite`, `flash`->`gemini-4-hydrogen-tiered-high`, `pro`->`gemini-4-hydrogen-tiered-xhigh` (flash-class Hydrogen, never Argon/Neon/Opus); `inherit`/omitted->parent's model. For Argon subagents, run parent on Gemini 4 Argon with `Model: "inherit"`. Cost gate prices `pro` as Hydrogen@xhigh (`flash`/`flash_lite` pass). Mode `on` emits 1 `[jev]` line per conversation per requested/served pair when served below requested tier (`on-demand`/`off` silent). Claude Code serves what is requested.

## 5. Quality Gates (`jev_judge`)

- Gate non-trivial diffs, refactors, and test outcomes with `jev_judge`; reject diffs with merge markers or unresolved lint failures.
