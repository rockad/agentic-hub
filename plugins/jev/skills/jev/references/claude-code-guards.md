# Claude Code Guards, Cost Gate & Downgrade Reference

Detailed rules for Jev `PreToolUse` / `PostToolUse` hooks in Claude Code when `mode == "on"`.

## Model Tier Mapping

- `openrouter_free` and `flash_lite` → `haiku`
- `flash` → `sonnet`
- `pro` → `opus`

## Elevation Choice & Approval Modes

The session model is the ceiling. In mode `on`, `PreToolUse` handles `Agent`, `Task`, and `Workflow` calls that exceed the session ceiling (a `pro` rating in turn context is advice, not a dialog, so a call pinned to the session model or below starts without a prompt).

### Default Mode (Elevation Choice)

- A call naming a stronger model with no user prompt instruction naming it and no covering approval is **denied** with a reason; the turn does not stop.
- Ask the user with `AskUserQuestion`: one question whose text **starts with** `[jev-elevate:<model>]` followed by a short question naming `subagent_type`, the requested model, the session model, and a ~10-word task summary, with **exactly four options** in this order:
  1. `Yes, once`
  2. `Yes, for this session`
  3. `No, proceed on <session model>`
  4. `No, don't ask again this session`
- Do not ask in any other form: a Jev hook records the user's answer only from that question.
- On a `Yes`, relaunch the delegation with the same model (the approval covers that model and anything below it). On either `No`, launch it on the session model or do the work directly, and do not stop.
- The user's answer counts as given regardless of whether Jev denied first or how long after, and the hook prints a one-line status (`[jev] Recorded: opus, once (this turn) up to high. Relaunch now.`, or `[jev] Not recorded: <reason>. <what to do>.`). Read it and act accordingly.
- Scope of each answer:
  - `Yes, once`: current turn only (no clock; a new user message drops it).
  - `No, proceed on <session model>`: this delegation only.
  - `No, don't ask again this session`: Jev runs every later launch of that model on the session model itself; do not ask again.
- Ask before the first `Agent` call when turn context says to. Otherwise every attempt is denied again (never a permission dialog), and from the third attempt of the same delegation in one prompt the reason tells you to stop retrying that model: proceed with an explicit model at or below the session model, or ask the user again with `AskUserQuestion`. A new prompt (including a background agent's completion notification) resets that count.

### Alternative Elevation Modes & Overrides

- **Prompt approval**: A model named by the user in their prompt (`use opus`, `run an opus subagent`), or a stronger one, passes unchanged with no dialog. Do not ask separately.
- **`JEV_ELEVATION=dialog`** (2.3.4 behaviour, the only mode that triggers a permission dialog): Asks in a permission dialog on every such call (logs `auto_approve_warning` under `bypassPermissions` or `auto`). `Yes` runs on the stronger model; `No` cancels the call and stops the turn unless a typed comment lets you continue (e.g., `"continue on sonnet"`), in which case carry on on the session model rather than retrying a cheaper model.
- **`JEV_ELEVATION=clamp`** (opt-in, off by default): Runs the call on the session model with no dialog and emits a note. Do not retry on your own; report the result and ask the user in chat if the stronger model is truly needed. Repeats in the same prompt are clamped the same way.
- **Remapped aliases (`ANTHROPIC_DEFAULT_*_MODEL`)**: Clamping cannot be done safely; in `clamp` mode the call is **denied** (never asked) with `re-invoke with an explicit model at or below the session model` (or `inherit`). `dialog` mode asks.
- **Unranked / unreadable calls**: Denied with guidance, never asked (except `dialog` mode).
  - Model not in catalogue and of no known family: re-invoke with `opus`, `sonnet`, `haiku`, or omit `model` / `inherit`.
  - Unreadable or ambiguous agent definition: re-invoke with an explicit `model` on the call.
  - `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`: User's own environment override; passes.

## Cost Gate & Model Rank Ceiling (2.3.19)

- **Stronger model always asks (both cost gate modes)**: A subagent whose model tier is above the session's (`opus`/`fable` above `sonnet`/`haiku`, including `agent()` calls in a `Workflow`) is denied with `[jev-elevate:<model>]` regardless of effort (e.g., `opus` at `low` under `sonnet` at `max` still asks), unless a covering approval exists or the prompt names the model.
- **Cost gate mode**: Configured via `costGate` in `~/.config/jev/config.json` (`defaults.costGate` or `harnesses.<harness>.costGate`; `JEV_COST_GATE` overrides):
  - `shadow` (default when unset): Rank ceiling and interim `xhigh`/`max` effort rule decide; each `agent_call` row records `cost_gate_shadow` with what the gate would have done.
  - `enforce`: One cost gate decides where cost can be computed.
- **One cost gate (`enforce` mode)**:
  - A delegation (`Agent` call or `Workflow` `agent()` call) needs approval only when `model weight * effort weight` exceeds the session's own model at the session's effort (e.g., session `opus` at `high` is `22.5`: `sonnet` at `max` passes, `opus` at `xhigh` does not).
  - Markers: `[jev-elevate:<model>]` (`[jev-elevate:<model>:<effort>]` above `high`) when the model exceeds the session's; `[jev-elevate-effort:<level>:<model>]` when only the effort does. The `No` option is `No, proceed on <session model>` or `No, run at <effort>` (highest that fits, at most `high`).
  - An approval covers that model at that effort and lower.
  - A prompt naming the model or effort raises what the call is held to.
  - `JEV_ELEVATION=clamp` lowers the call to the most expensive `(model, effort)` that fits, logged as `clamped_to` and `clamped_effort`.
  - Where cost cannot be computed (no session effort, relative effort, unranked model), the fallback rules below decide.

## Unknown Session Model (Fails Closed, 2.3.19)

- When Claude Code has not reported the session model yet (brand-new or headless session, no `SessionStart` record, no transcript to learn from), Jev assumes `sonnet` (and `high` effort if effort is unreported).
- `opus` subagents or `xhigh`/`max` effort receive the normal elevation flow; the deny reason ends with `The session model is not known yet, so Jev assumes sonnet.` Applies to `Agent`, `Task`, and `Workflow` `agent()` literals.
- Telemetry rows carry `session_model_source: "assumed"` and `sessionModelAssumed: true`. As soon as the real model is known, it takes effect. No downgrade is offered against an assumed model.
- A stored or learned model id Jev cannot place (no rank, no alias, not in catalogue) is also assumed `sonnet`; the deny reason ends with `The session model <id> is not one Jev knows, so Jev assumes sonnet.`, and rows keep their real `session_model_source` plus `sessionModelAssumed: true` and `sessionModelReported`.

## Interim Effort Rule (`xhigh` / `max`)

Used when cost cannot be computed:

- Effort `xhigh` or `max` on an `Agent` call, its definition, or a `"higher"` that reaches one is denied with a reason prescribing one `AskUserQuestion` whose text **starts with** `[jev-elevate-effort:<level>]` (`xhigh` or `max`), naming `subagent_type`, requested effort, and a ~10-word summary, with **exactly four options**:
  1. `Yes, once`
  2. `Yes, for this session`
  3. `No, run at high`
  4. `No, don't ask again this session`
- On `Yes`, relaunch with the same effort; on `No`, relaunch with `effort: "high"` (or do the work directly) and do not stop.
- A prompt naming the effort (`use max effort`) is approval; do not ask.
- Model verdict comes first; the effort question follows on retry. From the third attempt in one prompt, stop retrying and proceed with `effort: "high"` or ask the user again.

## `Workflow` Script Verification

- A `Workflow` whose script Jev cannot verify (model/effort from a variable, aliasing, spread, parse error, unknown agent type, or local import) is denied with the offending sites and what to fix: make every `agent()` call name a literal model and literal effort (or inherit) that Jev can read, import no local file, then retry.
- Each `agent()` call is evaluated by the cost gate on `(model, effort)` together (or by the fallback rank ceiling + `xhigh`/`max` rules if session effort is unknown).
- Held scripts use the same markers (`[jev-elevate:<model>]` or `[jev-elevate-effort:<level>:<model>]`), naming the number of held agents; one answer covers the whole script at its model and effort or lower. Works in `clamp` mode too (scripts cannot be clamped).

## Downgrade Choice (`models.downgrade.mode` / `JEV_DOWNGRADE`)

Modes: `ask` (default), `auto`, `off`.

- Jev rates **each delegation** on the `Agent` call's description and start of its prompt (an omitted `model` counts as the session model).
- When a cheaper model is enough, strictly cheaper by list price, and no user instruction names the requested model:
  - **`ask` mode**: Denied once with a reason; turn does not stop. Ask with `AskUserQuestion`, starting with `[jev-downgrade:<needed alias>]`, naming `subagent_type`, requested model, cheaper candidates, and what the reason states (rating probability, both list prices, and advisory effort, e.g. `"Jev suggests low effort; session effort is high"`). Up to four options in this order:
    1. `Yes, <cheapest sufficient model>`
    2. (Optional) one more `Yes` alternative
    3. `No, keep <requested model>`
    4. `No, and don't ask again this session`
  - Relaunch with the chosen model (`No` keeps the requested model set explicitly). Any answer lets the retry through, suppresses re-asking for the same delegation for 10 minutes, and the last option suppresses the question for the rest of the session.
  - **Version-pinned clones (`<id> via jev-ladder-<id>`)**: Pass that `subagent_type` with no `model` (generated by `bun scripts/jev-models.ts ladder-agents --dir <directory>`), since `Agent`'s `model` accepts only `haiku`, `sonnet`, `opus`, and `fable`.
  - Ask at the call only, never before it, and in no other form.
- **`auto` mode**: Runs on the cheapest alias automatically and notes it.
- **`off` mode**: Does nothing. A router failure never blocks a call. Effort is advice only (no hook can set it).
