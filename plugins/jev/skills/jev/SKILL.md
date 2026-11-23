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
- On Antigravity, `Model: "pro"` is not a pro-class model: it runs on Gemini 4 Hydrogen (xhigh), a flash-class model. The lifecycle pre-tool hook holds an `invoke_subagent` call requesting it only when it costs more than the session's own model (it is priced as Hydrogen at xhigh), with the prescribed `[jev-elevate:pro]` question, and otherwise lets it pass. A subagent on Argon needs the session itself on Gemini 4 Argon with `Model: "inherit"`.

### 4. In Claude Code

- Tiers map onto Claude models: `openrouter_free` and `flash_lite` → `haiku`, `flash` → `sonnet`, `pro` → `opus`.
- The session model is the ceiling. In mode `on`, a `PreToolUse` hook handles an `Agent` call that names a model stronger than the session model, and nothing else: a `pro` rating is advice in the turn context, not a dialog, so a call pinned to the session model or below starts without a prompt.
  - Default (elevation choice): a call that names a stronger model, with no instruction naming it and no approval, is **denied** with a reason; the turn does not stop. Ask the user with `AskUserQuestion`, one question whose text STARTS with the marker `[jev-elevate:<model>]` followed by a short question naming the subagent_type, the requested model, the session model and a 10-word task summary, with exactly four options in this order and with these labels: `Yes, once`, `Yes, for this session`, `No, proceed on <session model>`, `No, don't ask again this session`. Do not ask in any other form: a Jev hook records the user's answer from that question, and only that question. On a Yes launch the delegation again with the same model (the approval covers it and anything below it); on either No launch it on the session model or do the work directly, and do not stop. The user's answer counts as given: it is recorded whether or not Jev denied first and however long after, and the hook tells you in one line what it stored (`[jev] Recorded: opus, once (this turn) up to high. Relaunch now.`, or `[jev] Not recorded: <reason>. <what to do>.`: read it and relaunch, or ask again as it says). `Yes, once` is for the current turn only (no clock; a new user message drops it), `No, proceed on <session model>` is for this delegation, and after `No, don't ask again this session` Jev runs every later launch of that model on the session model itself, so do not ask again. Ask this question before the first `Agent` call when the turn context says to. If you do not, every attempt is denied again (never a permission dialog), and from the third attempt of the same delegation in one prompt the reason tells you to stop retrying that model: proceed with an explicit model at or below the session model, or ask the user again with `AskUserQuestion`. A new prompt (a background agent's completion notification is one) resets that count.
  - `JEV_ELEVATION=dialog` (2.3.4 behaviour, the only mode that asks): the user is asked in a permission dialog on every such call (the hook logs `auto_approve_warning` when the permission mode approves without a dialog, `bypassPermissions` or `auto`). Yes runs it on the stronger model. No cancels the call and stops the turn; a comment typed with No lets you continue (for example "continue on sonnet"), so carry on with the work on the session model rather than retrying on a cheaper model.
  - A model the user named in their prompt (`use opus`, `run an opus subagent`), or a stronger one, passes unchanged with no dialog: that instruction is the approval, so do not ask separately.
  - Opt-in clamp (`JEV_ELEVATION=clamp` in the environment, off by default): every such call runs on the session model instead, with no dialog, and a note says so. Do not call it again on your own; report the result and, if the stronger model is really needed, ask the user in chat (a reply naming that model passes). A repeat in the same prompt is clamped the same way: the clamp never asks.
  - If the session model's alias is remapped (`ANTHROPIC_DEFAULT_*_MODEL`), the clamp cannot be done: in `clamp` mode the call is **denied** (never asked) with `re-invoke with an explicit model at or below the session model`; do exactly that (or `inherit`). `dialog` mode asks.
  - Calls Jev cannot rank or read are denied with guidance, never asked (only `dialog` mode asks). A model not in the catalogue and of no known family: re-invoke with `opus`, `sonnet` or `haiku`, or omit `model` / `inherit`. An agent definition that is unreadable or ambiguous: re-invoke with an explicit `model` on the call (it does not read the definition). A forced subagent model (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`) is the user's own environment and passes.
  - A stronger model always asks (2.3.19, in both cost gate modes): a subagent whose model tier is above the session's (`opus`/`fable` above `sonnet`/`haiku`; an `agent()` call in a `Workflow` too) is denied with the `[jev-elevate:<model>]` question whatever its effort (opus at low under sonnet at max asks), unless a covering approval exists or the prompt names the model. This is the model rank ceiling, not part of the cost gate.
  - Cost gate mode (2.3.19): `costGate` in `~/.config/jev/config.json` (`defaults.costGate`, `harnesses.<harness>.costGate`, `JEV_COST_GATE` overrides) is `shadow` (the default when unset) or `enforce`. In shadow the rules of before the gate decide (the rank ceiling and the interim `xhigh`/`max` effort rule) and each `agent_call` row records `cost_gate_shadow`, what the gate would have done. The next item describes enforce.
  - One cost gate (2.3.19, enforce mode): where the cost can be computed, a delegation (an `Agent` call, or an `agent()` call in a `Workflow`) needs approval only when it costs more than the session's own model at the session's effort (model weight times effort weight; session opus at high is 22.5: sonnet at max passes, opus at xhigh does not). The deny reason states the cost and prescribes the same one question with the markers below; `[jev-elevate:<model>]` (`[jev-elevate:<model>:<effort>]` above `high`) when the model is above the session's, `[jev-elevate-effort:<level>:<model>]` when only the effort is, and the No option is `No, proceed on <session model>` or `No, run at <effort>` (the highest that fits, at most `high`). An approval covers that model at that effort and lower. A prompt that names the model or the effort raises what the call is held to. `JEV_ELEVATION=clamp` lowers the call to the most expensive (model, effort) that fits, logged `clamped_to` and `clamped_effort`. Where the cost cannot be computed (no session effort, a relative effort, a model with no tier) the rules below decide.
  - An unknown session model fails closed (2.3.19): when Claude Code has not reported the session model yet (a brand-new or headless session, no `SessionStart` record, no transcript to learn it from), Jev holds the session as `sonnet`, and as `high` effort when the effort is not reported either. An `opus` subagent (or an `xhigh`/`max` effort) then gets the normal question (deny with the marker, or the dialog, or the clamp to `sonnet`), and approvals work as usual; the deny reason ends with `The session model is not known yet, so Jev assumes sonnet.` The same holds for the `agent()` literals of a `Workflow`. The rows carry `session_model_source: "assumed"` and `sessionModelAssumed: true`. As soon as the model is known, the real one is used (nothing sticks). No downgrade is offered against an assumed model. `on-demand` and `off` decide nothing, as always. A stored or learned model id Jev cannot place (no rank, no alias, not in the catalogue) is treated the same way: assumed `sonnet`, the reason ends with `The session model <id> is not one Jev knows, so Jev assumes sonnet.`, and the rows keep their real `session_model_source` and add `sessionModelAssumed: true` and `sessionModelReported`.
  - Effort `xhigh` or `max` on an `Agent` call, its definition, or a `"higher"` that reaches one (the interim effort rule, used when the cost cannot be computed) is denied with a reason that prescribes one question: `AskUserQuestion`, one question whose text STARTS with the marker `[jev-elevate-effort:<level>]` (`xhigh` or `max`) followed by a short question naming the subagent_type, the requested effort and a 10-word task summary, with exactly four options in this order and with these labels: `Yes, once`, `Yes, for this session`, `No, run at high`, `No, don't ask again this session`. On a Yes launch the delegation again with the same effort; on No launch it with `effort: "high"` (or do the work directly), and do not stop. Do not ask in any other form. A prompt that names the effort (`use max effort`) is the approval: do not ask. A model verdict comes first; the effort question follows on the retry. From the third attempt of the same delegation the reason tells you to stop retrying: proceed with an explicit `effort` of `high`, or ask the user again.
  - A `Workflow` whose script Jev cannot verify (a model or effort from a variable, aliasing, a spread, a parse error, an unknown agent type) is denied with the sites and what to change: make every `agent()` call name a literal model and a literal effort (or inherit) that Jev can read, import no local file, then call it again. Since 2.3.19 each `agent()` call is judged on its model and effort together by the cost gate: it is held only when it costs more than the session's own model at the session's effort, with the same questions as an `Agent` call (marker `[jev-elevate:<model>]` for a model above the session's, `[jev-elevate-effort:<level>:<model>]` when only the effort is; naming the number of held agents; one answer covers the whole script at its model and effort or lower; a prompt that names the model or the effort passes), once nothing else is unverifiable; in `clamp` mode too (a script cannot be clamped). Where the cost cannot be computed (no session effort) the older rules judge the call: a literal model above the session model, a literal `xhigh` or `max` effort.
- Downgrade choice (mode `ask`, the default; `models.downgrade.mode` in the config or `JEV_DOWNGRADE=ask|auto|off`): Jev rates **each delegation** on its own text (the `Agent` call's description and the start of its prompt). When a cheaper model is enough, it is strictly cheaper by list price, and no user instruction names the requested model, the call is **denied once** with a reason; the turn does not stop. A call with no `model` counts as the session model. Ask the user with `AskUserQuestion`, one question whose text STARTS with the marker `[jev-downgrade:<needed alias>]` followed by a short question naming the subagent_type, the requested model, the cheaper candidates, and stating what the reason says to state (Jev's rating with its probability, both list prices, and the advisory effort, for example "Jev suggests low effort; session effort is high"); at most four options in this order: `Yes, <cheapest sufficient model>`, at most one more `Yes` alternative, `No, keep <requested model>`, `No, and don't ask again this session`. Then launch the delegation again with the chosen model (on either No keep the requested model, set explicitly); any answer lets the retried call through, the same delegation is not asked about again for 10 minutes, and the last answer stops the question for the rest of the session. An option written `<id> via jev-ladder-<id>` is a subagent_type (a general-purpose clone pinned to that model id, made by `bun scripts/jev-models.ts ladder-agents --dir <directory>`): launch it with that `subagent_type` and no `model`. The `Agent` tool's `model` takes only `haiku`, `sonnet`, `opus` and `fable`, so a version inside an alias cannot be chosen any other way. The question is asked at the call only, never before it, and in no other form. In mode `auto` Jev runs such a call on the cheapest alias itself and says so; in `off` it does nothing. A router failure never blocks a call. Effort is advice only: no hook can set it.
- Antigravity downgrade choice (Jev mode `on`, same settings `models.downgrade.mode` / `JEV_DOWNGRADE`): an `invoke_subagent` call with `Model: "flash"` (or `Model` omitted/`inherit` on a standard `flash` session, when a downgrade mode is configured) is rated on its role and the start of its prompt. When a cheaper model is enough, the call is **denied once** and the reason prescribes one `ask_question` whose text STARTS with the exact marker the denial names (`[jev-downgrade:flash_lite:<sig8>]`, one per delegation), with exactly three options in this order: `Yes, flash_lite`, `No, keep flash`, `No, and don't ask again this session`. Then call `invoke_subagent` again with `Model: "flash_lite"` on Yes, or with `Model: "flash"` on either No. Ask in no other form; a retry that skips the question passes. In mode `auto` Jev rewrites the model to `flash_lite` itself (`allow` + `overwrite`); in `off` and `on-demand` it does nothing. A router failure never blocks a call.
- Antigravity `run_workflow` guard (Jev mode `on`): the agents a workflow script launches never reach the `invoke_subagent` hook, so the hook reads the script (`Script` or `ScriptPath`) and analyses it. A literal `model="pro"` (keyword or positional) above the session model is **denied** with a prescribed `ask_question` whose text starts with `[jev-elevate:pro]` and names `(sha256:<12hex>)` of the script: ask it exactly as written, then retry the same `run_workflow`; never retry without asking. A script Jev cannot verify (a model from a variable or f-string, `**kwargs`, aliasing `agent`, `exec` / `eval` / `importlib`, an import of a local sibling file or package or a relative import (inline the `agent(...)` calls or remove the import), an unreadable `ScriptPath`, an omitted `model` under an Orchestrator session) is **denied with the sites and what to change**: write a literal `model` on every `agent(...)` call, or ask the user. It never asks through a dialog except with `JEV_ELEVATION=dialog`. A model the user named in the prompt passes. `on-demand` and `off` make no decision. After the run the hook logs `workflow_changed` if a script file changed since the analysis (no prompt).
- Antigravity tier check (2.3.19, both cost gate modes): an `invoke_subagent` (or `run_workflow` `agent(...)`) call with a full model id whose tier is above the session's ceiling (`gemini-4-argon-*`, `claude-opus-5-5-*` above a flash-class session; under the Orchestrator the flash ceiling applies to full ids by tier, so a pro-class full id always asks even when the planner runs at max) takes the `[jev-elevate:<model>]` question whatever its effort. An enum `Model` is priced by the model it is served on (`pro` is Hydrogen, flash class) and follows the cost gate (enforce) or the rank ceiling (shadow). `costGate` shadow/enforce works as on Claude Code; the rows say `cost_gate_shadow` or `cost_gate`.
- Antigravity served model (2.3.19, verified on Antigravity 1.5.14): `invoke_subagent`'s `Model` is an enum, `inherit | flash_lite | flash | pro`, served under every parent as `gemini-3.5-flash-lite`, `gemini-4-hydrogen-tiered-high` (Hydrogen at high) and `gemini-4-hydrogen-tiered-xhigh` (Hydrogen at xhigh); `inherit` or an omitted `Model` is served on the parent's own model. The cost gate and the cost fields price a call by the model it is served on (`Model: "pro"` costs as Hydrogen at xhigh, flash weight times 2; `inherit` as the parent's model), and rows add `servedModelExpected` next to `requested_model`. The `[jev-elevate:pro]` question must say that Model "pro" is served on Gemini 4 Hydrogen (xhigh), flash class; the deny reasons and the Orchestrator explicit-`Model` rule say that a subagent on Argon needs the session itself on Gemini 4 Argon with `Model: "inherit"`, and never tell you to request `pro` for a pro-class model. In mode `on`, one short `[jev]` line (shown by the next pre-flight) says when a subagent was served below the tier it asked for, once per conversation per requested/served pair; `on-demand` and `off` show nothing. Claude Code serves what it is asked and is unchanged.
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
- **Telemetry Log**: `~/.gemini/antigravity-cli/jev_telemetry.jsonl`. Every row carries `mode` (`on` or `on-demand`, the mode the hook acted under; `off` writes nothing). An `agent_call` row with a suggested or applied downgrade also carries `costSaving` (the cost difference to the downgrade target at the same effort, `null` when unknown).

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
