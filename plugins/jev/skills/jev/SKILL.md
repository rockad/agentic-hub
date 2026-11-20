---
name: jev
description: Switch or inspect TypeSafe Jev operating modes (off, on-demand, on) directly from chat or with slash command /jev.
when_to_use: Switch Jev operational mode (off, on-demand, on), query Jev quota/status, calibrate task execution tier via jev_dispatch, or manage free-tier coprocessor offloading.
argument-hint: "[status | on | on-demand | off]"
metadata:
  author: aleksandr
  requires: jev-mcp
---

# TypeSafe Jev Mode Controller

Use this skill when the user or agent needs to inspect or switch TypeSafe Jev operating modes (`off`, `on-demand`, `on`) in Antigravity CLI or Claude Code.

## Operating Modes

| Mode | State | Description | Behavior |
| --- | --- | --- | --- |
| **`off`** | MCP Server Disabled | Zero token overhead, zero OpenRouter calls. | Antigravity runs strictly with built-in native tools. Background decisions, pre-flight routing, and free-tier offloading are completely disabled. |
| **`on-demand`** | MCP Server Enabled | Passive System 1 coprocessor. | MCP server remains active. Invoked selectively by user or agent for complex multi-role workflows (`jev_dispatch`), condition checks (`jev_judge`), or ad-hoc free tier generation (`jev_execute_free`). Telemetry rows are written, and one informational quota line is injected only when a pool is `conserve`, `free_only` or exhausted. **No decisions** (no deny, ask, clamp, approvals, downgrade or guards) and **no routing advice** (no router call, directive or tier advice), in Claude Code and Antigravity alike. |
| **`on`** | MCP Server Enabled | Aggressive System 1 enforcement. | Active coprocessor with mandatory execution guards: (1) **Pre-flight dispatch** via `jev_dispatch` on non-trivial tasks to calibrate subagent role and tier; (2) **Free-tier offloading** to `openrouter/free` via `jev_execute_free`; (3) **Automated quality gates** via `jev_judge`; (4) **Subagent tier clamping** to flash/flash_lite or free tier to conserve Pro quota. |

> **In on-demand Jev enforces nothing: a pro (Claude Code: opus) subagent runs without any approval prompt from Jev. The pro-approval rule then depends only on the agent following its instructions. Use mode `on` to have Jev enforce it.**

Every mode is defined once in `src/core/mode-policy.ts` (`modeBehaviour`, `lowQuotaNotice`) and every harness adapter, including any later one (OpenCode, Codex), must consult it.

---

## Instructions for Agent & User

### 1. View Current Status

To inspect the active operating mode, configuration state, and mode characteristics:

- **Via MCP Tool (Chat Interface)**:
  Call `jev_get_mode` (or `call_mcp_tool` with `ServerName: "jev_jev"` or `"jev"`, `ToolName: "jev_get_mode"`, `Arguments: {}`).
- **Via Configuration**:
  Inspect `~/.config/jev/config.json`.

### 2. Switch Operating Modes

To switch modes directly:

> **Every mode change must be stamped.** Prefer `jev_set_mode`: it writes the mode and `modeChangedAt` together. When you edit `~/.config/jev/config.json` yourself, set `defaults.modeChangedAt` to the current time as an ISO UTC string in the same edit (for example `jq --arg m on --arg t "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '.defaults.mode = $m | .defaults.modeChangedAt = $t'`). A pending Jev denial or question issued before that time is never approved by a later answer (an answer given in `on-demand` cannot approve a mode-`on` denial after switching back); a config without the stamp puts no restriction on anything.

#### Switching to `on` (Aggressive System 1):
- **Via Skill / Command**:
  Update `defaults.mode: "on"` and `defaults.modeChangedAt` (now, as an ISO UTC string) in `~/.config/jev/config.json`. In Antigravity, run `agy mcp enable jev` via `run_command` if disabled.
- **Via MCP Tool (When enabled)**:
  Call `jev_set_mode` with argument `{"mode": "on"}`.

#### Switching to `on-demand` (Passive Coprocessor):
- **Via Skill / Command**:
  Update `defaults.mode: "on-demand"` and `defaults.modeChangedAt` (now, as an ISO UTC string) in `~/.config/jev/config.json`. In Antigravity, run `agy mcp enable jev` via `run_command` if disabled.
- **Via MCP Tool**:
  Call `jev_set_mode` with argument `{"mode": "on-demand"}`.

#### Switching to `off` (Zero Overhead):
- **Via Skill / Command**:
  Update `defaults.mode: "off"` and `defaults.modeChangedAt` (now, as an ISO UTC string) in `~/.config/jev/config.json`. In Antigravity, run `agy mcp disable jev` via `run_command`.
- **Via MCP Tool**:
  Call `jev_set_mode` with argument `{"mode": "off"}`.

### 3. Model Tier Selection & Pro Tier User Approval Guardrail

Pro tier models (`pro`) are **never invoked automatically**. They are strictly gated behind manual user approval to protect the user's Gemini Pro quota:
- If `jev_dispatch` recommends `pro` (`requiresUserApproval: true`), the agent **must not** spawn a subagent on `pro` automatically.
- The agent must solicit explicit user approval before spawning any agent on `pro`, providing the reasoning returned by dispatch.
- If the user declines or does not explicitly approve `pro`, spawn the designated subagent on `flash` (or `flash_lite` / `openrouter_free`). The agent **must never bypass the subagent and do the task itself sequentially**.
- Lifecycle pre-tool hooks will actively intercept and block (`force_ask`) any `invoke_subagent` call requesting `Model: "pro"`.

### 4. In Claude Code

- Tiers map onto Claude models: `openrouter_free` and `flash_lite` → `haiku`, `flash` → `sonnet`, `pro` → `opus`.
- The session model is the ceiling. In mode `on`, a `PreToolUse` hook handles an `Agent` call that names a model stronger than the session model, and nothing else: a `pro` rating is advice in the turn context, not a dialog, so a call pinned to the session model or below starts without a prompt.
  - Default (elevation choice): a call that names a stronger model, with no instruction naming it and no approval, is **denied** with a reason; the turn does not stop. Ask the user with `AskUserQuestion`, one question whose text STARTS with the marker `[jev-elevate:<model>]` followed by a short question naming the subagent_type, the requested model, the session model and a 10-word task summary, with exactly four options in this order and with these labels: `Yes, once`, `Yes, for the next 5 minutes`, `Yes, for this session`, `No, proceed on <session model>`. Do not ask in any other form: a Jev hook records the user's answer from that question, and only that question. On a Yes launch the delegation again with the same model (the approval covers it and anything below it); on No launch it on the session model or do the work directly, and do not stop. Ask this question before the first `Agent` call when the turn context says to. If you do not, every attempt is denied again (never a permission dialog), and from the third attempt of the same delegation in one prompt the reason tells you to stop retrying that model: proceed with an explicit model at or below the session model, or ask the user again with `AskUserQuestion`. A new prompt (a background agent's completion notification is one) resets that count.
  - `JEV_ELEVATION=dialog` (2.3.4 behaviour, the only mode that asks): the user is asked in a permission dialog on every such call (the hook logs `auto_approve_warning` when the permission mode approves without a dialog, `bypassPermissions` or `auto`). Yes runs it on the stronger model. No cancels the call and stops the turn; a comment typed with No lets you continue (for example "continue on sonnet"), so carry on with the work on the session model rather than retrying on a cheaper model.
  - A model the user named in their prompt (`use opus`, `run an opus subagent`), or a stronger one, passes unchanged with no dialog: that instruction is the approval, so do not ask separately.
  - Opt-in clamp (`JEV_ELEVATION=clamp` in the environment, off by default): every such call runs on the session model instead, with no dialog, and a note says so. Do not call it again on your own; report the result and, if the stronger model is really needed, ask the user in chat (a reply naming that model passes). A repeat in the same prompt is clamped the same way: the clamp never asks.
  - If the session model's alias is remapped (`ANTHROPIC_DEFAULT_*_MODEL`), the clamp cannot be done: in `clamp` mode the call is **denied** (never asked) with `re-invoke with an explicit model at or below the session model`; do exactly that (or `inherit`). `dialog` mode asks.
  - Calls Jev cannot rank or read are denied with guidance, never asked (only `dialog` mode asks). A model not in the catalogue and of no known family: re-invoke with `opus`, `sonnet` or `haiku`, or omit `model` / `inherit`. An agent definition that is unreadable or ambiguous: re-invoke with an explicit `model` on the call (it does not read the definition). A forced subagent model (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`) is the user's own environment and passes.
  - Effort `xhigh` or `max` on an `Agent` call, its definition, or a `"higher"` that reaches one (the interim effort rule) is denied with a reason that prescribes one question: `AskUserQuestion`, one question whose text STARTS with the marker `[jev-elevate-effort:<level>]` (`xhigh` or `max`) followed by a short question naming the subagent_type, the requested effort and a 10-word task summary, with exactly four options in this order and with these labels: `Yes, once`, `Yes, for the next 5 minutes`, `Yes, for this session`, `No, run at high`. On a Yes launch the delegation again with the same effort; on No launch it with `effort: "high"` (or do the work directly), and do not stop. Do not ask in any other form. A prompt that names the effort (`use max effort`) is the approval: do not ask. A model verdict comes first; the effort question follows on the retry. From the third attempt of the same delegation the reason tells you to stop retrying: proceed with an explicit `effort` of `high`, or ask the user again.
  - A `Workflow` whose script Jev cannot verify (a model or effort from a variable, aliasing, a spread, a parse error, an unknown agent type) is denied with the sites and what to change: make every `agent()` call name a literal model at or below the session model (or inherit) and a literal effort of `low`, `medium` or `high`, then call it again. A literal model above the session model takes the `[jev-elevate:<model>]` question like an `Agent` call, in `clamp` mode too.
- Downgrade choice (mode `ask`, the default; `models.downgrade.mode` in the config or `JEV_DOWNGRADE=ask|auto|off`): Jev rates **each delegation** on its own text (the `Agent` call's description and the start of its prompt). When a cheaper model is enough, it is strictly cheaper by list price, and no user instruction names the requested model, the call is **denied once** with a reason; the turn does not stop. A call with no `model` counts as the session model. Ask the user with `AskUserQuestion`, one question whose text STARTS with the marker `[jev-downgrade:<needed alias>]` followed by a short question naming the subagent_type, the requested model, the cheaper candidates, and stating what the reason says to state (Jev's rating with its probability, both list prices, and the advisory effort, for example "Jev suggests low effort; session effort is high"); at most four options in this order: `Yes, <cheapest sufficient model>`, at most one more `Yes` alternative, `No, keep <requested model>`, `No, and don't ask again this session`. Then launch the delegation again with the chosen model (on either No keep the requested model, set explicitly); any answer lets the retried call through, the same delegation is not asked about again for 10 minutes, and the last answer stops the question for the rest of the session. An option written `<id> via jev-ladder-<id>` is a subagent_type (a general-purpose clone pinned to that model id, made by `bun scripts/jev-models.ts ladder-agents --dir <directory>`): launch it with that `subagent_type` and no `model`. The `Agent` tool's `model` takes only `haiku`, `sonnet`, `opus` and `fable`, so a version inside an alias cannot be chosen any other way. The question is asked at the call only, never before it, and in no other form. In mode `auto` Jev runs such a call on the cheapest alias itself and says so; in `off` it does nothing. A router failure never blocks a call. Effort is advice only: no hook can set it.
- Antigravity downgrade choice (Jev mode `on`, same settings `models.downgrade.mode` / `JEV_DOWNGRADE`): an `invoke_subagent` call with `Model: "flash"` (or `Model` omitted/`inherit` on a standard `flash` session, when a downgrade mode is configured) is rated on its role and the start of its prompt. When a cheaper model is enough, the call is **denied once** and the reason prescribes one `ask_question` whose text STARTS with the exact marker the denial names (`[jev-downgrade:flash_lite:<sig8>]`, one per delegation), with exactly three options in this order: `Yes, flash_lite`, `No, keep flash`, `No, and don't ask again this session`. Then call `invoke_subagent` again with `Model: "flash_lite"` on Yes, or with `Model: "flash"` on either No. Ask in no other form; a retry that skips the question passes. In mode `auto` Jev rewrites the model to `flash_lite` itself (`allow` + `overwrite`); in `off` and `on-demand` it does nothing. A router failure never blocks a call.
- Antigravity `run_workflow` guard (Jev mode `on`): the agents a workflow script launches never reach the `invoke_subagent` hook, so the hook reads the script (`Script` or `ScriptPath`) and analyses it. A literal `model="pro"` (keyword or positional) above the session model is **denied** with a prescribed `ask_question` whose text starts with `[jev-elevate:pro]` and names `(sha256:<12hex>)` of the script: ask it exactly as written, then retry the same `run_workflow`; never retry without asking. A script Jev cannot verify (a model from a variable or f-string, `**kwargs`, aliasing `agent`, `exec` / `eval` / `importlib`, an unreadable `ScriptPath`, an omitted `model` under an Orchestrator session) is **denied with the sites and what to change**: write a literal `model` on every `agent(...)` call, or ask the user. It never asks through a dialog except with `JEV_ELEVATION=dialog`. A model the user named in the prompt passes. `on-demand` and `off` make no decision. After the run the hook logs `workflow_changed` if a script file changed since the analysis (no prompt).
- A `[JEV]` line added to the turn carries the recommended subagent, model and effort. It is advice: follow it unless the task clearly needs more, and say so when you deviate.
- Mode state is read directly from `~/.config/jev/config.json`.

---

## Slash Command Usage

When invoked via `/jev` or `/jev <mode>`:
- `/jev` or `/jev status`: Inspect current mode from `~/.config/jev/config.json`.
- `/jev on`: Sets mode to `on` (and stamps `modeChangedAt`) in `~/.config/jev/config.json` and ensures MCP server is enabled (`agy mcp enable jev`).
- `/jev on-demand`: Sets mode to `on-demand` (and stamps `modeChangedAt`) in `~/.config/jev/config.json` and ensures MCP server is enabled (`agy mcp enable jev`).
- `/jev off`: Sets mode to `off` (and stamps `modeChangedAt`) in `~/.config/jev/config.json` and disables MCP server (`agy mcp disable jev`) for zero overhead.

## Underlying State & Files

- **Config File**: `~/.config/jev/config.json` (canonical configuration store, defaults to `mode: "off"`)
- **Telemetry Log**: `~/.gemini/antigravity-cli/jev_telemetry.jsonl`

---

## Operational Rules (when `jev on`)

The following rules apply when `mode == "on"` (Aggressive System 1). They are enforced by lifecycle hooks and must be followed by any agent running in this mode.

### 1. Pre-Flight Dispatch (`jev_dispatch`)
- Before executing non-trivial tasks, refactors, or spawning subagents, call `jev_dispatch` to calibrate the task.
- Jev returns probability distributions over candidate subagents and model tiers (`openrouter_free`, `flash_lite`, `flash`, `pro`).
- If `recommendedTier` is `openrouter_free`, execute immediately via `jev_execute_free` — do not spawn a paid subagent.
- If a Gemini tier is recommended, spawn the subagent with the designated tier (subject to the Pro Tier rule in the main Skill section above).

### 1b. Post-Approval Execution Transition Gate (`jev_batch_dispatch`)
- Upon plan approval or completion of `/grill-me` (`clarify`), the main orchestrator MUST immediately call `jev_batch_dispatch` and `manage_subagents(Action: "list")` to decompose and delegate independent workstreams in parallel rather than editing multiple files sequentially in the main context.
- On Claude Code, give each task in `jev_batch_dispatch` an optional `kind` (`mechanical` gives haiku, `settled-edit` gives sonnet, `judgement` gives opus) and `needsEdit: true` when the stream edits files. `needsEdit` keeps `Plan`, `Explore` and the free tier (`jev_execute_free` returns text and cannot edit files) off that stage; without it the task wording decides, and `needsEdit: false` overrides the wording. Without `kind` the router picks the tier under the same rubric. Follow each task's `executionGuidance` (`Agent(subagent_type, model)`, or `agent({ agentType, model })` inside a Workflow); a `judgement` stage on a session below opus is asked about by the Jev guard before it runs. Other harnesses ignore both fields.
- Tool inputs are validated strictly. Each task takes exactly `id` and `task` (both required, non-empty), and optionally `dependencies` (ids of other tasks), `kind` and `needsEdit`; the call also takes optional `availableSubagents`. An unknown key (`description` for `task`, `dependsOn` for `dependencies`), a missing field, duplicate ids, a dependency on a missing id, a self-dependency or a cycle comes back as an error result (`Invalid arguments for tool jev_batch_dispatch: ...`, one issue per line, with a "did you mean" hint); fix the call and send it again. The same holds for every `jev_*` tool.
- `PreToolUse` (`jev-pre-tool.sh`) checks `jev_telemetry.jsonl` and blocks consecutive direct edits (`>=2` files) in the session window if no recent `jev_dispatch`, `jev_batch_dispatch`, or subagent delegation occurred.

### 2. Free-Tier Offloading (`jev_execute_free`)
- **Main agent**: Offload boilerplate scaffolding, markdown formatting, log distillations, and draft summaries to `openrouter/free` at **$0.00** cost and **zero Gemini quota**.
- **Subagents**: Subagents performing bulk transformations, formatting, or log distillations must call `jev_execute_free` directly rather than consuming subscription quota on long text outputs.
- **Concurrency cap**: Max **10 concurrent tasks** targeting `openrouter_free` simultaneously (OpenRouter's 20 RPM global limit).

### 3. 429 / Quota-Exhausted Fallback
- If a subagent returns `RESOURCE_EXHAUSTED` (HTTP 429 / "Individual quota reached"):
  1. **Do NOT fall back to doing the work in the main agent context** — that wastes Pro quota on the exact task being delegated.
  2. **Retry on free tier** via `jev_agent_free` (backend `auto`, model `openrouter/free`).
  3. **Gate the result** with `jev_judge` before committing or presenting to the user.
  4. Only fall back to main context if `jev_agent_free` also fails (network/timeout), and say so explicitly.

### 4. Quality Gates (`jev_judge`)
- Run `jev_judge` after major file edits or refactors before presenting results to the user.
- If `passed: false`, self-correct before presenting.
- Pre-commit: never commit diffs containing merge conflict markers (`<<<<<<<`, `=======`).

### 5. Rubric Scoring (`jev_score`)
- Use `jev_score` for multi-criteria evaluation (CV-to-job matching, code readability rubrics) without generating verbose LLM essays.

---

## Autonomous Free-Tier Agent (`jev_agent_free`)

For multi-step coding or workspace tasks that would consume significant Gemini quota:
- Executes autonomous agent loops on free models at **$0.00 cost**.
- **Backends**:
  - `opencode` — Full workspace agent via OpenCode CLI, with file read/write and command execution.
  - `openrouter` — Direct OpenRouter Chat Completions API (single-turn).
  - `auto` (default) — OpenCode with automatic fallback to OpenRouter on failure.
- **Primary model**: `openrouter/free` (200k context, supports tool calls). Fallback pool: `google/gemma-4-31b-it:free`, `cohere/north-mini-code:free`, `nvidia/nemotron-3.5-lightning:free`.
- Returns: completed content, backend used, model used, tokens saved, cost ($0.00), latency.

---

## Proactive Quota Guard

When Gemini quota remaining falls below 20%:
- Route ALL complex generation, boilerplate edits, and code transformations to free models via `jev_execute_free` or `jev_agent_free`.
- The main agent acts as orchestrator only — consuming trivial input tokens while free models handle bulk output.
- This guard fires independently of Jev mode and protects quota even when `jev off`.

---

## Observability

- **OpenRouter Dashboard**: Real-time token usage, latencies, and costs.
- **Local telemetry**: Execution events appended to `~/.gemini/antigravity-cli/jev_telemetry.jsonl`.
