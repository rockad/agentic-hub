# Antigravity Guards, Workflow Analysis & Served Models Reference

Detailed rules for Jev lifecycle hooks (`hooks.json`) in Antigravity when `mode == "on"`.

## Downgrade Choice (`invoke_subagent`)

Configured via `models.downgrade.mode` in `~/.config/jev/config.json` or `JEV_DOWNGRADE=ask|auto|off`:

- An `invoke_subagent` call with `Model: "flash"` (or `Model` omitted / `"inherit"` on a standard `flash` session when a downgrade mode is configured) is rated on its role and the start of its prompt.
- When a cheaper model is enough:
  - **`ask` mode**: Denied once; the reason prescribes one `ask_question` whose text **starts with** the exact marker named in the denial (`[jev-downgrade:flash_lite:<sig8>]`, one per delegation), with **exactly three options** in this order:
    1. `Yes, flash_lite`
    2. `No, keep flash`
    3. `No, and don't ask again this session`
  - Relaunch `invoke_subagent` with `Model: "flash_lite"` on `Yes`, or `Model: "flash"` on either `No`. Ask in no other form; a retry that skips the question passes.
  - **`auto` mode**: Rewrites `Model` to `flash_lite` automatically (`allow` + `overwrite`).
  - **`off` / `on-demand`**: Does nothing. A router failure never blocks a call.

## `run_workflow` Guard

Agents launched by a workflow script never reach the `invoke_subagent` hook, so the `run_workflow` hook reads the script (`Script` or `ScriptPath`) and analyses it statically:

- **Literal `model="pro"` above session ceiling**: Denied with a prescribed `ask_question` starting with `[jev-elevate:pro]` and naming `(sha256:<12hex>)` of the script. Ask it exactly as written, then retry the same `run_workflow`; never retry without asking.
- **Unverifiable scripts** (model from a variable or f-string, `**kwargs`, aliasing `agent`, `exec`/`eval`/`importlib`, relative import or import of a local sibling file/package, unreadable `ScriptPath`, omitted `model` under an Orchestrator session): Denied with the offending sites and what to fix — inline `agent(...)` calls or remove the local import, and write a literal `model` on every `agent(...)` call (or ask the user).
- Never opens a permission dialog unless `JEV_ELEVATION=dialog`.
- A model named by the user in the prompt passes. `on-demand` and `off` make no decision.
- After the run, the hook logs `workflow_changed` if a script file changed since the analysis (no prompt).

## Tier Check for Full Model IDs (2.3.19)

- In both cost gate modes (`shadow` and `enforce`), an `invoke_subagent` or `run_workflow` `agent(...)` call specifying a full model id whose tier exceeds the session's ceiling (`gemini-4-argon-*`, `claude-opus-5-5-*` above a flash-class session; under the Orchestrator the flash ceiling applies to full ids by tier so a pro-class full id always asks even when the planner runs at max) takes the `[jev-elevate:<model>]` question regardless of effort.
- An enum `Model` (`inherit | flash_lite | flash | pro`) is priced by the model it is served on (`pro` is Hydrogen, flash class) and follows the cost gate (`enforce`) or rank ceiling (`shadow`). Telemetry rows record `cost_gate_shadow` or `cost_gate`.

## Served Model Mapping (Verified on Antigravity 1.5.14)

`invoke_subagent`'s `Model` enum (`inherit | flash_lite | flash | pro`) maps under every parent as:

| `Model` argument | Served model |
| --- | --- |
| `flash_lite` | `gemini-3.5-flash-lite` |
| `flash` | `gemini-4-hydrogen-tiered-high` (Hydrogen at high) |
| `pro` | `gemini-4-hydrogen-tiered-xhigh` (Hydrogen at xhigh, flash class) |
| `inherit` / omitted | Parent session's own model |

- **Cost pricing**: `Model: "pro"` costs as Hydrogen at `xhigh` (`flash` weight × 2); `inherit` costs as the parent's model. Telemetry rows add `servedModelExpected` next to `requested_model`.
- **Argon / Pro-class subagents**: Because `Model: "pro"` serves Hydrogen (flash class), a subagent on Argon needs the session itself on Gemini 4 Argon with `Model: "inherit"`. Both the `[jev-elevate:pro]` question and Orchestrator rules make this explicit and never tell you to request `pro` for a pro-class model.
- **Served-below-tier notice**: In mode `on`, one short `[jev]` line (shown by the next pre-flight) notes when a subagent was served below the tier it requested, once per conversation per requested/served pair (`on-demand` and `off` show nothing). Claude Code serves what it is asked and is unchanged.
