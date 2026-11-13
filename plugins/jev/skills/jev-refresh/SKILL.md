---
name: jev-refresh
description: Refresh the Jev model catalogue (which concrete model ids the harness can use, per tier) with slash command /jev-refresh, and report what changed.
when_to_use: The user runs /jev-refresh, a Jev notice says to run /jev-refresh, a new model was released, or the catalogue is stale, missing, or lists an id that no longer works.
argument-hint: "[--harness claude-code|opencode|antigravity] [--max-calls N]"
metadata:
  author: aleksandr
  requires: bun
---

# Jev Model Catalogue Refresh

Use this skill to rebuild the per-harness model catalogue in `~/.config/jev/models/<harness>.json`. The catalogue lists the concrete model ids a harness can use (`claude-sonnet-5-5`, `claude-opus-5`, ...) with a tier and a version, so Jev can pick the cheapest sufficient model without a hard-coded list.

## Cost

For Claude Code the refresh makes real, paid calls: one tiny prompt (`claude -p "Reply OK"`) per candidate id, run one after another with hooks disabled and Jev switched off so a probe never triggers Jev itself. The run is capped:

- Default cap: 20 calls (`models.refresh.maxCalls` in `~/.config/jev/config.json`, or `--max-calls N`, at most 100).
- The four aliases (`haiku`, `sonnet`, `opus`, `fable`) are probed first; each one also verifies the concrete id it resolves to. The rest of the candidates follow in order and anything past the cap is skipped and listed.
- Expect a few tens of cents for a full run, more for the larger models. Say so before running when the user has not asked for it by name.

OpenCode (the public OpenRouter model list) and Antigravity (the configured tier map) refresh for free.

## Instructions

1. Run the refresh with bun. Pass through any arguments the user gave:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/jev-models.ts" refresh $ARGUMENTS
   ```

   If `CLAUDE_PLUGIN_ROOT` is not set, use the path of this plugin's `scripts/jev-models.ts`. If `bun` is missing, say so and stop; do not substitute another runtime.

2. If the output says another refresh is running, report that and stop: a background refresh already holds the lock and nothing was probed.

3. Summarise the output for the user in a short vertical list:

   - **new**: ids added to the catalogue
   - **missing**: ids that failed a probe (skipped at once, deleted after three failed probes in a row)
   - **recovered**: ids that were missing and work again
   - **removed**: ids deleted from the catalogue
   - **needs review**: ids from a family Jev does not know; they are not used until the user assigns a tier under `models.overrides` in `~/.config/jev/config.json`
   - **not probed (call cap)** and **no answer**: what was left out and why
   - the number of probe calls and their cost

4. To look without refreshing, run `bun "${CLAUDE_PLUGIN_ROOT}/scripts/jev-models.ts" status` (age, source, counts) or `list` (the ladder per tier).

## Background refresh

When Jev mode is `on`, a Claude Code session start refreshes the catalogue by itself in a detached process, at most once per `models.refresh.maxAgeDays` (default 7). To stop that, set `models.refresh.enabled` to `false` in `~/.config/jev/config.json`. `/jev-refresh` still works when it is disabled.
