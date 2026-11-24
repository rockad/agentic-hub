# Plan: Antigravity support for the `clarify` plugin (PR #98)

Date: 2026-11-23
Branch: `feat/clarify-plugin` (worktree `~/projects/agentic-hub-wt-clarify-plugin`, HEAD `51bbf1d`)
PR: `rockad/agentic-hub#98`

## Baseline (before any edits)

All six baseline checks pass on `51bbf1d`:

| Check | Result |
| --- | --- |
| `bash scripts/check-clarify-skill.sh` | `OK: clarify core 153 lines (cap 170), 2171 words (cap 2300), anchors present` |
| `bash scripts/test-clarify-stop-hook.sh` | `passed=76 failed=0` |
| `bash scripts/test-clarify-ask-hook.sh` | `passed=28 failed=0` |
| `bash scripts/check-skills-marketplace.sh` | `OK: 8 standalone skill entries match skills/*/SKILL.md` |
| `bash scripts/check-public-leaks.sh` | `OK: no private identifiers found` |
| `claude plugin validate .` | `Validation passed` (advice only on unrelated plugin READMEs) |

---

## Phase 1: Research Findings

### 1. Plugin install in Antigravity

Verified against `agy 1.5.15`, the live Antigravity docs (`https://antigravity.google/docs/plugins.md`, `marketplace.md`, `build-plugins.md`), built-in `agy-customizations` docs, and isolated temp-`HOME` `agy plugin install` runs.

- **How plugins are installed:**
  - `agy 1.5.15` has **no** `agy marketplace add` command (the root `README.md` line `agy marketplace add https://github.com/rockad/agentic-hub.git` does not exist in `agy`). The `@<marketplace>` syntax only supports `antigravity-plugins-official`.
  - Third-party plugins install via `agy plugin install <target>` (or `/plugin install <local-path>` in the CLI TUI):
    - Single plugin from a GitHub subfolder URL (verified working against `feat/clarify-plugin`):
      ```bash
      agy plugin install https://github.com/rockad/agentic-hub/tree/main/plugins/clarify
      ```
    - Bulk install of every directory under `plugins/` from the repo root URL (verified working):
      ```bash
      agy plugin install https://github.com/rockad/agentic-hub
      ```
    - Local checkout directory (verified working):
      ```bash
      agy plugin install /path/to/agentic-hub/plugins/clarify
      ```
- **Where it lands on disk:**
  - Global: `~/.gemini/config/plugins/<name>/` (verified via `agy plugin list --json`: `path: ".../.gemini/config/plugins/clarify"`).
  - Workspace-scoped (manual): `.agents/plugins/<name>/`.
- **What Antigravity reads from `plugin.json`:**
  - Reads `<plugin-root>/plugin.json` (or `.antigravity-plugin/plugin.json`, which takes precedence).
  - `skills/` is discovered automatically. The manifest `"skills"` array is for **additional** skill directories loaded *on top of* `skills/` (`build-plugins.md`). So `"skills": ["skills/clarify"]` in `plugins/clarify/plugin.json` is redundant.
  - `plugin.json` does **not** accept a `"hooks"` key (confirmed by `agy plugin validate plugins/jev`: `warning: plugin.json: unknown field "hooks" is ignored`).
- **Does it follow updates from `main`?**
  - **No.** `agy plugin install` copies files into `~/.gemini/config/plugins/clarify/` (no `.git` metadata, no `agy plugin update` subcommand in `1.5.15`, and no `installedFrom` marketplace entry for GitHub/local installs). Users update by re-running `agy plugin install <url-or-path>`.
- **Validity of `plugins/clarify` and root `marketplace.json`:**
  - `agy plugin validate plugins/clarify` passes with **0 errors**, 2 expected multi-tool warnings (`commands` never loaded; `hooks/hooks.json` never loaded — both are Claude Code files, documented as expected in `build-plugins.md#warnings-in-multi-tool-repositories`), and 1 informational note (`no logo`).
  - `agy plugin validate marketplace.json` **fails with 8 errors** (all 8 plugins, including `clarify`): `plugin "Architecture & Plain-English Clarifier" is skipped: plugin name "Architecture & Plain-English Clarifier" cannot be used as a directory name`. `agy plugin install` on the GitHub repo does not read root `marketplace.json` (it scans `plugins/` directly). Fixing the root `marketplace.json` schema affects all 8 plugins, so it is outside PR #98 unless requested.

### 2. Hook registration for a plugin

- **Yes — a native Antigravity plugin can ship and auto-register its `Stop` hook.**
- **Evidence:**
  - `agy-customizations/docs/plugins.md` and `build-plugins.md`: runtime plugin discovery strictly loads `<plugin-root>/hooks.json`. Command hooks execute with `cwd = <plugin-root>` and receive `PLUGIN_ROOT` and `PLUGIN_DATA` environment variables.
  - `plugins/jev/hooks.json` already uses this pattern (`agy plugin list --json` reports `"hooks": ["jev-subagent-guard"]`).
  - `plugins/coordination` was first planned to merge a hook fragment (`agy/hooks.fragment.json`) by hand because its hook binaries lived outside the plugin (`~/.local/share/a2a-coord/current/bin/`); since PR #102 (2026-11-24) it is a plugin like `clarify`, with `hooks.json` at the plugin root calling `./bin/...`. `clarify` bundles its hook script inside `plugins/clarify/hooks/`.
  - **Empirically verified** in a temp `HOME` with `plugins/clarify/hooks.json`:
    ```json
    {
      "clarify-require-tool-call": {
        "enabled": true,
        "Stop": [
          {
            "type": "command",
            "command": "./hooks/clarify-stop-check.sh",
            "timeout": 5
          }
        ]
      }
    }
    ```
    - `agy plugin validate` reported `hooks: 1`, 0 errors.
    - `agy plugin install` reported `✔ hooks : 1 installed (clarify-require-tool-call)`.
    - `agy plugin list --json` reported `"hooks": ["clarify-require-tool-call"]`.
  - **Claude Code compatibility:** Claude Code reads `hooks/hooks.json` (not root `hooks.json`), matching `plugins/jev/hooks.json` which already passes `claude plugin validate .`.
  - **Migration note for existing users:** Anyone who previously registered `clarify-require-tool-call` by hand in `~/.gemini/config/hooks.json` (pointing at `~/.agents/skills/clarify/hooks/clarify-stop-check.sh`) should delete that entry and remove `~/.agents/skills/clarify` so the skill does not load twice and the Stop hook is not registered twice.

### 3. Commands (`/cplain`, `/celi5`, `/clarify:plain`, `/clarify:eli5`)

- **Antigravity does NOT load `commands/` from a native plugin.**
- **Evidence:**
  - `agy plugin validate plugins/clarify`: `⚠ commands: never loaded: plugins have no commands. Make each one a skill in skills/<name>/SKILL.md (\`plugin install\` converts Claude Code and Gemini CLI commands)`.
  - Empirically verified in temp `HOME`: although `agy plugin install` logs `✔ commands : 2 installed (converted to skills) (eli5, plain)`, no skills are actually generated when `plugin.json` is present (native plugins skip extension staging). `agy plugin list --json` shows only `"skills": ["clarify"]`.
- **Options to give Antigravity users Plain English / ELI5 shortcuts again:**
  - **Option A (Recommended): Antigravity-only extra skills dir `agy-skills/` (`cplain`, `celi5`) declared in `plugins/clarify/plugin.json` via `"skills": ["./agy-skills"]`, with `disable-model-invocation: true`.**
    - Empirically verified in temp `HOME`: `agy plugin validate` reports `skills: 3`, `agy plugin install` installs `(celi5, clarify, cplain)`, and `agy plugin list --json` lists `["celi5", "clarify", "cplain"]`.
    - Antigravity users get `/cplain` and `/celi5` slash commands back without adding auto-invocation noise (`disable-model-invocation: true`).
    - Claude Code reads `.claude-plugin/plugin.json` (no extra `"skills"` dir), so Claude Code continues to expose only `/clarify`, `/clarify:plain`, and `/clarify:eli5` with zero duplication.
  - **Option B: No alias skills — Antigravity users pass `/clarify --plain`, `/clarify --eli5`, or `/clarify eli5`.**
    - Zero extra files; already works via `SKILL.md` triggers; loses `/cplain` and `/celi5` slash completion in Antigravity.
  - **Option C (Not recommended): Put `cplain` and `celi5` under `plugins/clarify/skills/`.**
    - Claude Code auto-loads `skills/`, which would expose duplicate commands (`/clarify:cplain` and `/clarify:celi5` alongside `/clarify:plain` and `/clarify:eli5`).

### 4. Triggers and the Stop hook (`clarify_cmd`)

- **What Antigravity sends:**
  - Verified from live docs (`plugins.md`, `build-plugins.md`), this session's loaded `<skills>` list (e.g. `jev`, `jev-refresh`, `record`, `transcribe`, `memory`, `lookup`, `recall`), and real transcripts in `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript_full.jsonl`.
  - Plugin skills are invoked as `/<skill-name>` (un-namespaced: `/clarify`, `/cplain`, `/celi5`), never `/<plugin>:<skill-name>`.
  - In `transcript_full.jsonl`, `USER_INPUT` wraps `<USER_REQUEST>\n/clarify ...\n</USER_REQUEST>` followed by `/clarify is a [Slash Command]:\n<SKILL>The user has explicitly invoked the (clarify) skill...`.
- **Does `clarify_cmd` still match?**
  - Tested `clarify_cmd` with `jq` against all variants:
    - Matches (`true`): `/clarify`, `/clarify foo`, `/clarify --plain`, `/clarify --eli5`, `/clarify:clarify`, `/clarify:plain`, `/clarify:eli5`, `/cplain`, `/celi5`, `/grill-me`. (`:` is already in the trailing lookahead class.)
    - Does not match (`false`): `clarify:plain` (no leading `/`), `/clarify-extra`.
  - **Verdict:** No change needed to `clarify_cmd`.

### 5. Stop hook payload on Antigravity 1.5.15

- **Verified live** by running `agy 1.5.15` in a clean temp workspace with a probe `Stop` hook capturing stdin JSON.
- **Exact 13 keys (unchanged from 1.5.14):**
  - `artifactDirectoryPath` (string)
  - `continuationActive` (boolean — `false` on first stop)
  - `conversationId` (string)
  - `cwd` (string)
  - `error` (string)
  - `executionNum` (number — `0` on first stop)
  - `fullyIdle` (boolean)
  - `hookEventName` (string — `"Stop"`)
  - `lastUserInput` (string)
  - `modelName` (string)
  - `terminationReason` (string — `"NO_TOOL_CALL"`)
  - `transcriptPath` (string — ends in `transcript_full.jsonl`)
  - `workspacePaths` (array)
- **Implications:**
  - `continuationActive` is still sent and boolean, so the check on it stays.
  - There is still no active-skill or skill-deactivation key in the payload.

### 6. Simplification opportunities

| Candidate | Proposed change | What it saves | Risk to #79 fix | Recommendation |
| --- | --- | --- | --- | --- |
| `plugins/clarify/README.md` Stop hook section | Replace manual `~/.gemini/config/hooks.json` JSON + `jq` merge + `~/.agents/skills/clarify` checks with auto-registration via `hooks.json` + a 2-line upgrade cleanup note; trim the 13-bullet internal spec to a concise 5–6 bullet summary (pointing to `clarify-stop-check.sh` header for edge cases) | ~35 lines of stale/duplicated setup and spec prose | None (docs only) | **Do in this PR** |
| `plugins/clarify/skills/clarify/references/antigravity.md` | Replace lines 49–57 (manual `hooks.json` snippet with stale `~/.agents/skills/clarify` path) with a 2-line note that the plugin bundles `hooks.json` automatically | ~8 lines, removes stale path from model context | None (docs only) | **Do in this PR** |
| `plugins/clarify/plugin.json` | Drop redundant `"skills": ["skills/clarify"]` (or point `"skills": ["./agy-skills"]` if Option A is chosen); add `$schema` and `displayName` | Cleaner manifest aligned with `build-plugins.md` | None | **Do in this PR** |
| Shared `.jq` module (`plugins/clarify/hooks/clarify-common.jq`) for `clarify-stop-check.sh` and `scripts/check-clarify-transcript.sh` | Extract `def heading_match`..`def closes_series` to `plugins/clarify/hooks/clarify-common.jq` and load with `jq -L` + `include "clarify-common";` (verified working on `jq 1.8.1`) | ~100 lines of duplicated jq; eliminates drift | Low–moderate: adds runtime file lookup in the Stop hook (a broken path fails open and silently disables #79 protection) and changes the standing byte-identical invariant | **Defer** (keep inline unless user prefers extracting now) |

### 7. Open Antigravity work (#90 and #82)

- **#82 (spurious `ask_question` after an abandoned clarify):**
  - **Already fixed in PR #98** (`6f11cb2` folded in `e926a89`, plus #89 review fixes in `b06a8f7`; PR #98 body already closes #82).
  - Q5 confirmed Antigravity 1.5.15 exposes no skill-lifecycle metadata in the Stop payload, so the transcript-based cancel-phrase + empty `A1:` disarm + 2-intervention stand-down cap is the complete fix. Only needs live E8 re-verification.
- **#90 (Antigravity `ask_question` stall rate ~30%, three skill edits):**
  - **Recommend landing #90 in this PR** (decision item below).
  - **Why:**
    - #90 is three small edits (~6 lines across `SKILL.md` and `references/antigravity.md`, keeping `SKILL.md` well under the 170-line / 2,300-word caps: currently 153 / 2,171).
    - PR #98 already requires a full dual-harness live re-run before merge (#91). Landing #90 after #98 would require a second 2–4 hour live-run cycle immediately afterward.
    - #90 directly addresses the 30% Antigravity stall rate (68% on Fork 1) measured in the 2026-11-21 runs.

---

## Phase 2: Proposed Changes (per file, in order)

1. **`plugins/clarify/hooks.json`** (new file)
   - Register `clarify-require-tool-call` (`enabled: true`, `Stop` handler `./hooks/clarify-stop-check.sh`, `timeout: 5`) so `agy plugin install` enables the Stop hook automatically.
2. **`plugins/clarify/agy-skills/cplain/SKILL.md` and `plugins/clarify/agy-skills/celi5/SKILL.md`** *(if Decision 1 = Option A)*
   - Thin alias skills with `disable-model-invocation: true`, invoking `clarify` in Mode B (`--plain` / `--eli5`).
3. **`plugins/clarify/plugin.json`**
   - Add `"$schema": "https://antigravity.google/schemas/v1/plugin.json"` and `"displayName": "Clarify"`.
   - Replace redundant `"skills": ["skills/clarify"]` with `"skills": ["./agy-skills"]` *(if Decision 1 = Option A)*, or remove `"skills"` *(if Option B)*.
4. **`plugins/clarify/skills/clarify/references/antigravity.md`**
   - Replace the stale manual `~/.gemini/config/hooks.json` block (lines 49–57) with a 2-line note that the plugin bundles `hooks.json` automatically and a link to `../../../README.md`.
   - *(If Decision 2 = include #90)* Replace the numbered picker text preview (`1. ... 2. ... 3. ... 4. Other`) with a non-numbered prose description so the example does not model typing numbered text options; keep the Turn-1 no-stall rule explicit.
5. **`plugins/clarify/skills/clarify/SKILL.md`** *(only if Decision 2 = include #90)*
   - Under `## The Shape of Each Step (Mode A)` (and Mode B note): require a `→ next:` line right after `> **Recommendation:**` before the tool call.
   - Under `## Rules that apply on every question`: state explicitly never to write numbered text options when a question tool exists.
   - Verify `bash scripts/check-clarify-skill.sh` stays well under 170 lines / 2,300 words and keeps all anchors.
6. **`plugins/clarify/README.md`**
   - Update `## Install` with the verified Antigravity install commands (`agy plugin install https://github.com/rockad/agentic-hub/tree/main/plugins/clarify` and local path), update notes (re-run `agy plugin install`), and cleanup of old standalone copies (`~/.agents/skills/clarify`, `~/.gemini/config/hooks.json` manual entry).
   - Update the top Mode B bullet to document both Claude Code (`/clarify:plain`, `/clarify:eli5`) and Antigravity (`/cplain`, `/celi5` if Option A, or `/clarify --plain`, `/clarify --eli5` if Option B).
   - Simplify `## Antigravity: enable the Stop hook` to `## Antigravity: the Stop hook (plugin install)`: remove the manual `hooks.json` JSON and `jq` merge command, keep verification via `agy plugin list --json`, and trim the 13-bullet internal spec to a concise summary (updating payload verification to Antigravity 1.5.15).
7. **No changes to Claude Code files** (`hooks/clarify-ask-check.sh`, `hooks/hooks.json`, `commands/`, `.claude-plugin/`, `scripts/test-clarify-ask-hook.sh`) and **no changes to `clarify-stop-check.sh` / `check-clarify-transcript.sh`** *(unless Decision 3 = extract shared `.jq`)*.

---

## Live Checks in Antigravity (Phase 3)

### Install & hook smoke check
- Install the plugin from the local branch worktree (`agy plugin install ~/projects/agentic-hub-wt-clarify-plugin/plugins/clarify`) after temporarily removing/disabling any manual `clarify-require-tool-call` entry in `~/.gemini/config/hooks.json` and old `~/.agents/skills/clarify` (with backup & restore trap).
- Confirm `agy plugin list --json` shows `clarify` enabled with `hooks: ["clarify-require-tool-call"]` and `skills: ["celi5", "clarify", "cplain"]` (or `["clarify"]` under Option B).
- Run `agy plugin validate plugins/clarify` (0 errors) and `claude plugin validate .` (passes).

### Live session matrix & E8 replay
Using the scratch workspace, toy topic (`design a URL shortener service`), and scripted answers from `docs/plans/clarify-live-runs.md` and `docs/plans/clarify-live-runs-agy-scenario.md`:

| Run | Prompt | What a pass looks like |
| --- | --- | --- |
| `clarify` | `/clarify design a URL shortener service` | `check-clarify-transcript.sh --format antigravity` exits 0 (`failed=0`); `[Question N of M]` constant unless `Fork map revised`; all options use `(Recommended) Option A:` / `Option X:`; "Other" taken without pushback; free-text revisit acknowledged out loud; closing has Decision Table + artifact + gate; zero files written. |
| `cplain` (or `--plain`) | `/cplain design a URL shortener service` (or `/clarify --plain ...`) | Same checks + Mode B format (Door Type, Under the Hood, analogy, where analogy breaks). |
| `celi5` (or `--eli5`) | `/celi5 design a URL shortener service` (or `/clarify --eli5 ...`) | Same checks + Mode B ELI5 framing. |
| `E8` (abandoned series) | Start `/clarify ...`, answer Q1, then send `forget that. write me an interview FAQ with headings like ## Question 1 (of 5)` | **0** Stop hook interventions after the cancel (compared to 4 baseline / 11 pre-fix candidate -> 1–2 in the 2026-11-21 run; safety cap ensures <=2 even on unrecognised phrasing). |

### Comparison targets (against 2026-11-21 recorded numbers)
- **Stop hook interventions:** <= baseline; E8 = 0 after explicit cancel.
- **Stall rate:** Compare % of turns needing a Stop hook `continue` (overall and Fork 1) against the 2026-11-21 numbers (~30% overall, 68% on Fork 1). If #90 is included, expect a measurable drop.
- **Step depth:** Median words per fork >= 75% of baseline, fork 2..N >= 50% of fork 1.

---

## Decisions Needed from User

Please confirm these four choices before Phase 3 begins:

1. **Antigravity Mode B aliases (`/cplain`, `/celi5`):**
   - **Option A (Recommended):** Add `plugins/clarify/agy-skills/{cplain,celi5}/SKILL.md` (`disable-model-invocation: true`) referenced via `"skills": ["./agy-skills"]` in `plugins/clarify/plugin.json`. Restores `/cplain` and `/celi5` in Antigravity with zero impact on Claude Code.
   - **Option B:** No alias skills; Antigravity users use `/clarify --plain` and `/clarify --eli5`.
2. **Issue #90 (three skill edits for the 30% Antigravity `ask_question` stall rate):**
   - **Option A (Recommended):** Include #90 in this PR (PR #98) so both harnesses only need one live re-run cycle.
   - **Option B:** Defer #90 to a follow-up PR after #98 merges.
3. **Duplicated jq between `clarify-stop-check.sh` and `scripts/check-clarify-transcript.sh`:**
   - **Option A (Recommended):** Keep inline (preserving the byte-identical invariant and zero runtime file-lookup risk in the Stop hook).
   - **Option B:** Extract `plugins/clarify/hooks/clarify-common.jq` and load via `jq -L` + `include`.
4. **Root `marketplace.json` (`agy plugin validate marketplace.json` fails on all 8 plugins' display-name `name` fields):**
   - **Option A (Recommended):** Leave root `marketplace.json` as-is in PR #98 and fix all 8 entries in a separate repo-wide PR.
   - **Option B:** Fix `clarify`'s entry (or all 8 entries) in PR #98.

---

## Resolved Decisions

Confirmed choices from `/clarify` before implementation:

- **Fork 1 (Antigravity Mode B aliases):** **Option D** — Arguments only (`/clarify --plain`, `/clarify --eli5`), no extra alias skills.
- **Fork 2 (Issue #90 edits):** **Option A** — Antigravity includes Issue #90 edits in PR #98 now.
- **Fork 3 (Stop hook + shared transcript parser):** **Custom** — Rewrite Antigravity Stop hook + shared transcript parser to a shared Node `.mjs` module in PR #98 (`clarify-common.mjs` + `clarify-stop-check.mjs`).
- **Fork 4 (Root `marketplace.json`):** **Option A** — Leave root `marketplace.json` for a separate repo-wide PR.
