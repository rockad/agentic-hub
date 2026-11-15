# Jev & Orchestrator Augmentation Plan (2026-11-15)

- **Status:** Draft plan for pre-implementation review (`@Doc-Cr` / Claude Code)
- **Repository scope:** `plugins/jev/` in `agentic-hub` (primary) and companion hooks/scripts in `doppelganger`
- **Target releases:** `v2.3.16` and `v2.3.17` (after merging PR `#54` and PR `#55` on top of `origin/main` `291b88e`, where `plugins/jev` currently declares `2.3.12`)
- **Related plan:** [2026-11-12-jev-consolidated-plan.md](./2026-11-12-jev-consolidated-plan.md) (section 32)
- **Evidence conventions used below:**
  - **Verified:** directly observed in repository files, git state, GitHub API (`gh`), or local config/state snapshots on `2026-11-15`
  - **Reported:** documented in existing plan files, PR descriptions, or prior session logs without re-running the underlying test suite in this branch
  - **Unverified:** inferred or pending runtime inspection during implementation

---

## 1. Orchestrator vs. `plugins/jev` Architectural Evaluation

**Antigravity Orchestrator** (`gemini-pro-orchestrator-g1-pro`) and **`plugins/jev`** both aim to capture frontier reasoning quality while keeping top-tier quota burn low, yet they operate on orthogonal layers:

- **Orchestrator is a vertical, intra-session temporal split:**
  - **Planning turn:** Runs on the deeper planning model while the Antigravity harness disables all write/edit tools. The planner reads files, resolves architectural forks, defines verification steps and `Re-plan if:` triggers, and invokes `exit_plan_mode`.
  - **Execution turn:** The harness switches the *same conversation* to a faster execution model. The executor inherits the planner's read context with zero serialization loss and hands back via `[plan review]` (`enter_plan_mode`) only when blocked, when plan assumptions diverge, or when a scheduled review checkpoint fires.
- **`plugins/jev` is a horizontal System 1 coprocessor and policy firewall:**
  - Scores and calibrates task tiers out-of-band via the OpenRouter Decisions API (`~typesafe/jev-latest`, router latency typically sub-second) and deterministic local heuristics in `plugins/jev/src/core/governance.ts`.
  - Governs child delegations (`invoke_subagent`, Claude `Agent`/`Task`, `Workflow`, `run_workflow`) via `PreToolUse` and `PostToolUse` lifecycle hooks.
  - Drops mechanical text work to **\$0.00 / 0% subscription quota** on `openrouter/free` (`jev_execute_free`, `jev_agent_free`, `commit.ts`) and verifies diffs with `jev_judge`.

### Head-to-Head Evaluation Matrix

| Dimension | Antigravity Orchestrator | `plugins/jev` (`v2.3.12` + PR `#58`) | Combined Target Architecture |
|---|---|---|---|
| **Routing Granularity** | Binary per-turn split (Planner vs. Executor) | 4 calibrated tiers (`openrouter_free`, `flash_lite`, `flash`, `pro`) + thinking effort (`low`, `medium`, `high`) | Orchestrator splits turn phases; Jev calibrates parallel child fan-outs (`jev_batch_dispatch`) and subagent models |
| **Minimum Cost Floor** | Paid subscription tier (Executor still spends Gemini/3p quota) | **\$0.00** / **0 subscription quota** via `openrouter/free` | Mechanical summaries, boilerplate, and commit generation offload to `jev_execute_free` |
| **Shared-Context Efficiency** | **Zero re-read overhead** on single-stream edits inside the execution turn | Subagent calls spawn fresh conversations that must re-read files | Single-stream planned edits (up to 6 files) stay in-context under Orchestrator; true multi-stream work fans out via Jev |
| **Enforcement Boundary** | Hard runtime lock removing write tools during planning turns | Lifecycle `PreToolUse`/`PostToolUse` hooks (`deny` + `[jev-elevate:*]`, `ask`, AST/static analysis) | Harness enforces read-only planning; Jev enforces subagent/workflow ceilings and free-only/conserve throttles |
| **Quota Awareness** | Blind to remaining 5h / weekly pool percentages | Reads `$HOME/.gemini/antigravity-cli/quota-state.json` (`normal`, `conserve`, `free_only`) | Orchestrator `gemini-argon-wtu-weekly` bucket mapped cleanly into `readQuotaView()` |
| **Mid-Run Verification** | `[plan review]` hands architectural pivots back to Planner | Fast binary diff/output checks via `jev_judge` | `jev_judge` gates diffs before completion or `[plan review]` hand-back |
| **Cross-Harness Scope** | Antigravity-only | Antigravity, Claude Code, and OpenCode | Unified `jev_batch_dispatch` stage rubric (`kind`, `needsEdit`) and parallel hook parity across harnesses |

---

## 2. Repository Pull Requests & Issues Audit (`rockad/agentic-hub`)

Checked directly against GitHub (`gh`) and `origin` on `2026-11-15` against `origin/main` (`291b88e`).

### Pull Request & Worktree State (**Verified**)

| PR / Worktree | Ref / Path | State | Relationship to This Plan |
|---|---|---|---|
| **PR `#58`** | `feat/jev-antigravity-hook` -> `main` | **MERGED** (`5ce432b86222b12d49af3f63ca904321656b3437`, `2026-11-15T09:10:15Z`) | Landed initial Antigravity `invoke_subagent` `PreToolUse`/`PostToolUse` guard and `Hydrogen`/scoped `Argon` ceiling tests |
| **PR `#54`** | `feat/jev-tool-validation` -> `main` (`2fb323f4bd45af9101fe882767cfd798c6c35114`) | **OPEN**, `MERGEABLE`, CI `Run Test Suites` **SUCCESS** | `v2.3.14`: strict MCP Zod validation, hints, semantic DAG checks, `@modelcontextprotocol/sdk` `^1.23.0` (`@Doc-Cr` review addressed; **reported** 2,093 tests) |
| **PR `#55`** | `feat/jev-agent-guard-parity` -> `feat/jev-tool-validation` (`b27937b390b85c076f732cf358e3d7d71451d3c0`) | **OPEN**, `MERGEABLE`, CI `Run Test Suites` **SUCCESS** | `v2.3.15`: Claude `Agent` parity with `Workflow` guard, `.claude/agents/*.md`, YAML cross-checks (`@Doc-Cr` Round 4 & Opus Round 5 addressed; **reported** 2,298 tests) |
| **PR `#10`** | `fix/jev-small-tails` (`d4d89186f33e604ddd09e638772fa65c1b49af10`) | **CLOSED** (remote branch `refs/heads/fix/jev-small-tails` still on `origin`) | Superseded by `main`; branch deletion tracked in Issue `#27` |
| **Stale Jev Worktrees** | `.claude/worktrees/ag-hook`, `.claude/worktrees/guard-parity`, `.claude/worktrees/jev-install`, `.claude/worktrees/validation` | Local worktrees still attached | Clean up in WS0 once PR `#54` and PR `#55` merge |

### Open Issues Audit (`#13`–`#40`, **Verified**)

| Issue | Title | Impact on Jev + Orchestrator Work | Planned Action |
|---|---|---|---|
| **`#13`** | `subagents plugin names and tools for Claude Code; Apache-2.0 attribution for chrome-devtools skills` | **Directly related (persona names & tool names):** notes display names (`Code Engineer`) and old Antigravity tool names (`replace_file_content`, `write_to_file`) vs. hyphenated Claude IDs | Accounted for in WS1 (`resolveEditCapableSubagent` accepts both `code-engineer` and `Code Engineer`) and WS4 (`write_file` / `edit_file` plus fallback compatibility names) |
| **`#23`** | `Subagents plugin for Claude Code, Antigravity and Codex (generator + drift check)` | **Directly related:** confirms `plugins/subagents/` will emit per-harness agent definitions | Keep `jev_batch_dispatch` edit-capable fallback lookup resilient across display-name and kebab-case rosters (WS1) |
| **`#24`** | `RFC 005 Phase A deprecation notices and Phase C removal checklist` | **Guardrail constraint:** specifies any future `plugins/jev` Phase A notice must read `"relocating to cognitive-engine"` rather than `"retired"` | Preserve clean relocation framing in `plugins/jev/README.md` edits (WS5); active development continues in `plugins/jev` per `2026-11-12` "plugins first" decision |
| **`#27`** | `Delete stale remote branches superseded by main` | **Directly related (WS0 cleanup):** `feat/jev-modular-sqlite-ram-cache` and `rfc/harness2-jev-unified-cognitive-substrate` are already absent from `origin`, while `refs/heads/fix/jev-small-tails` (`d4d89186f33e604ddd09e638772fa65c1b49af10`) remains | Record SHA `d4d89186f33e604ddd09e638772fa65c1b49af10` in Consolidated Plan section 32 and Issue `#27`, delete `origin/fix/jev-small-tails`, and close Issue `#27` in WS0 |
| **`#28`** | `Coordination S1 follow-ups: spikes, sanitising, ntfy, S1b` | **Related post-S1 follow-up (deferred):** includes future `commit.ts` trailers (`A2A-Task:`, `Session:`) | Explicitly out of scope until Coordination S1 opens |
| **`#25`**, **`#26`**, **`#39`**, **`#40`** | `basic-memory` migration, Coordination docs links, `memory@agentic-hub` bump, `ghcr.io/rockad/lookup` CI check | **Unrelated** (`plugins/memory` and `plugins/coordination` only) | Leave untouched |

---

## 3. Verified Root Causes: 5 Bugs & Parity Gaps

All five defects below were directly **verified** in workspace source files and live hook behavior on `2026-11-15`:

1. **Bug 1 — Orchestrator Model ID Misclassified in Quota Pool & Subagent Ceiling**
   - **Live observation (`Verified`):** When Antigravity runs on Orchestrator, hook stdin passes `modelName: "gemini-pro-orchestrator-g1-pro"`, while `$HOME/.gemini/antigravity-cli/quota-state.json` still contained stale `active_model: "Gemini 4 Hydrogen (Medium)"` alongside `gemini-5h: 0.8581`, `gemini-argon-wtu-weekly: 0.3384`, and `gemini-weekly: 0.4856`.
   - **Stale model precedence (`plugins/jev/antigravity/hook.ts:132-146`):** `quotaView?.active_model` is resolved first via `ceilingModelForHarness('antigravity', quotaView?.active_model)` and `input.modelName` is used only if `activeModel` is empty, masking mid-session UI model switches.
   - **Missed Argon/Orchestrator weekly bucket (`plugins/jev/src/core/governance.ts:240`):** `isArgonActive` checks only `/argon/i.test(activeModel)`, missing `orchestrator` and misreading `gemini-weekly` instead of `gemini-argon-wtu-weekly`.
   - **Permissive `pro` ceiling (`plugins/jev/src/core/governance.ts:316-323`):** `modelTierRank("gemini-pro-orchestrator-g1-pro")` matches `"pro"` and returns rank `3` (`pro`). Consequently, `evaluateAntigravitySubagentCall()` sets `sessionCeilingRank === 3`, letting Orchestrator's execution turn invoke `Model: "pro"` subagents without `[jev-elevate:pro]`.

2. **Bug 2 — Companion Workspace Hook (`doppelganger/.agents/hooks/jev-pre-tool.sh`) Has Stale Schemas & Auto-Allows Calls**
   - **Dead subagent inspection (`jev-pre-tool.sh:71-115`):** Parses only `.toolCall.args.Subagents // []` and never checks flat `.toolCall.args.Model`, making all subagent lockout/conserve/escalation logic no-ops on modern Antigravity `invoke_subagent` payloads.
   - **Unsafe `{"decision":"allow"}` pass-through (`jev-pre-tool.sh:18,34,117,195,199`):** Emits JSON `"allow"` instead of exiting `0` with empty stdout, bypassing normal Antigravity user permission prompts and deviating from the verified empty-stdout pass-through contract documented in Consolidated Plan section 31.
   - **Legacy write tool names (`doppelganger/.agents/hooks.json:13`, `jev-pre-tool.sh:121-122`):** Matches `write_to_file|replace_file_content` and reads `.toolCall.args.TargetFile`, missing Antigravity's native `write_file` and `edit_file` (`.toolCall.args.Path`).
   - **Ignored per-harness override (`jev-pre-tool.sh:11`, `jev-pre-invocation.sh:29`):** Reads `.defaults.mode` only instead of `.harnesses.antigravity.mode // .defaults.mode // "off"`.

3. **Bug 3 — Prompt Snippet Leak in Workspace Preflight Telemetry (`doppelganger/scripts/jev-preflight.ts:348`)**
   - **Finding (`Verified`):** Line `348` writes `task: cleanTask.slice(0, 120)` into `$HOME/.gemini/antigravity-cli/jev_telemetry.jsonl`, bypassing PR `#43`'s privacy rule (`taskFingerprint()` emitting `taskLen` and 12-hex `taskHash` only).

4. **Gap 4 — `jev_batch_dispatch` Stage Rubric Restricted to Claude Code (`plugins/jev/src/tools/dispatch.ts`)**
   - **Finding (`Verified`):** `resolveEditCapableSubagent` returns early whenever `harness !== 'claude-code'` (line `209`), read-only agent stripping skips non-Claude harnesses (line `499`), and `kind` (`mechanical`, `settled-edit`, `judgement`), `needsEdit`, `keepEditsOffFreeTier`, and `tierSource` run inside `if (isClaude)` branches only (lines `523`, `569-588`, `634`).
   - **Impact:** Antigravity `jev_batch_dispatch` callers cannot declare `kind` or `needsEdit`, falling back to text keywords and potentially routing file-editing tasks to `openrouter_free` or read-only personas (`research`).

5. **Gap 5 — Antigravity Missing Subagent Downgrade Choice & Python `run_workflow` Static Guard**
   - **Finding (`Verified`):** `plugins/jev/hooks.json` registers only `PreToolUse: invoke_subagent` and `PostToolUse: ask_question`. Antigravity lacks:
     - `[jev-downgrade:flash_lite]` choice/auto/off flow matching Claude Code
     - Static analysis of `run_workflow` scripts (`Script` / `ScriptPath`) calling `agent(..., model=...)` without triggering child `invoke_subagent` hooks

---

## 4. Clarified Architectural Decisions & Contracts

All seven design forks were resolved explicitly during the `/clarify` design walkthrough on `2026-11-15`:

| # | Decision Topic | Approved Design Choice |
|---|---|---|
| 1 | **Release Sequencing & Housekeeping** | Merge PR `#54` (`v2.3.14`) then PR `#55` (`v2.3.15`) into `main`; delete `origin/fix/jev-small-tails` (`d4d89186f33e604ddd09e638772fa65c1b49af10`) and close Issue `#27`; prune `.claude/worktrees/*`; land Orchestrator integration in isolated worktrees off merged `main` |
| 2 | **Orchestrator Ceiling & `inherit` Semantics** | Map `orchestrator` / `argon` active models to `gemini-argon-wtu-weekly` in `readQuotaView()`; set Orchestrator subagent ceiling rank to `2` (`flash`) for explicit `Model` checks and `clampTierToSessionCeiling`; let omitted/`inherit` subagent `Model` pass through with empty stdout (`decision: "pass"`) on normal quota |
| 3 | **Hook Responsibility Boundary** | Consolidate all `invoke_subagent` checks (`openrouter_free`/invalid model rejection, `<10%` lockout, `<=20%` `flash_lite` throttle, upward `[jev-elevate:pro]`, downward `[jev-downgrade:flash_lite]`) into `plugins/jev/antigravity/`; slim `doppelganger/.agents/hooks/jev-pre-tool.sh` to `run_command` and write tools with empty-stdout pass-through and `.harnesses.antigravity.mode` precedence |
| 4 | **Multi-File Write Guard Under Orchestrator** | Update `jev-pre-tool.sh` & `doppelganger/.agents/hooks.json` for `write_file\|edit_file\|write_to_file\|replace_file_content` via `.toolCall.args.Path // .toolCall.args.TargetFile`; scope counters by `.conversationId`; allow up to **6** distinct edited files on Orchestrator (**3** on standard sessions), reset for 15m after `jev_batch_dispatch`, `jev_dispatch`, or `invoke_subagent` |
| 5 | **`jev_batch_dispatch` Stage Rubric Parity** | Enable `kind`, `needsEdit`, `keepEditsOffFreeTier`, `tierSource`, and read-only persona swaps (`research` / `knowledge-researcher` -> `code-engineer` / `Code Engineer` / `self`) across Antigravity and OpenCode **additively** whenever `kind` or `needsEdit` is present on a task item; emit unchanged legacy schema when omitted |
| 6 | **Antigravity Subagent Downgrade Flow** | Add full `[jev-downgrade:flash_lite]` parity (`ask` / `auto` / `off` via `models.downgrade.mode` and `JEV_DOWNGRADE`, router cumulative $P(\text{openrouter\_free} + \text{flash\_lite}) \ge 0.6$, 10-minute normalized signature cache, `PostToolUse` `ask_question` recorder via `transcriptPath` at `stepIdx`, session disable option) |
| 7 | **Antigravity Python `run_workflow` Static Guard** | Add fail-closed static Python analyzer (`plugins/jev/antigravity/workflow-guard.ts`) wired to `PreToolUse` (`invoke_subagent\|run_workflow`) and `PostToolUse` (`ask_question\|run_workflow`): literal `model="pro"` routes via `[jev-elevate:pro]` keyed by `workflow:<sha256>`; dynamic `model=`, `**kwargs`, or unreadable `ScriptPath` triggers `decision: "ask"`; `PostToolUse` checks `ScriptPath` hash drift |

### Target Control-Flow Architecture

```text
+---------------------------------------------------------------------------------------+
|                          ANTIGRAVITY + ORCHESTRATOR + JEV                             |
|                                                                                       |
|  [1] PreInvocation: doppelganger/scripts/jev-preflight.ts (+ jev-pre-invocation.sh)   |
|      |-- Reads $HOME/.config/jev/config.json (.harnesses.antigravity.mode // defaults)|
|      |-- Reads quota-state.json (orchestrator|argon -> gemini-argon-wtu-weekly)       |
|      |-- Logs taskFingerprint ONLY (taskLen + 12-hex taskHash; zero prompt substrings)|
|      '-- Injects Phase-Aware Orchestrator Directive:                                  |
|            * Planner turn: read in-context; single-stream <=6 files -> exit_plan_mode; |
|              multi-stream -> jev_batch_dispatch(kind, needsEdit) before exit_plan_mode|
|            * Executor turn: jev_execute_free ($0), flash subagent ceiling, jev_judge  |
|                                                                                       |
|  [2] Workspace PreToolUse: doppelganger/.agents/hooks/jev-pre-tool.sh                 |
|      |-- Matcher: run_command|write_file|edit_file|write_to_file|replace_file_content |
|      |-- run_command (git commit): deny staged conflict markers                       |
|      |-- Write tools: read .Path // .TargetFile; allow <=6 files on Orchestrator      |
|      |   (<=3 standard) unless recent dispatch/subagent reset counter (<15m)          |
|      '-- Pass-through: exit 0 with EMPTY stdout (never {"decision":"allow"})          |
|                                                                                       |
|  [3] Plugin PreToolUse & PostToolUse: agentic-hub/plugins/jev/antigravity/hook.ts     |
|      |-- Active model: input.modelName (when non-empty) || quotaView.active_model     |
|      |-- Subagent ceiling: subagentCeilingRank("...orchestrator...") === 2 ("flash")  |
|      |-- invoke_subagent (logic.ts):                                                  |
|      |     * Reject Model: "openrouter_free" or invalid tier strings                  |
|      |     * Quota lockout (<10% free_only) & conserve throttle (<=20% flash_lite)    |
|      |     * Elevation: Model "pro" > ceiling "flash" -> [jev-elevate:pro] / 3rd ask  |
|      |     * Downgrade: Model "flash"|"inherit" & P(<=flash_lite)>=0.6 -> ask | auto  |
|      |-- run_workflow (workflow-guard.ts):                                            |
|      |     * Tokenizes Script / FIFO-safe ScriptPath for agent(..., model=...) calls  |
|      |     * Literal model="pro" -> [jev-elevate:pro] keyed by workflow:<sha256>      |
|      |     * Dynamic model=var / **kwargs / unreadable -> decision: "ask"             |
|      '-- PostToolUse (ask_question | run_workflow):                                   |
|            * Reads bounded 1 MB transcript tail at stepIdx                            |
|            * Records [jev-elevate:*] scope (once | 5min | session)                    |
|            * Records [jev-downgrade:*] decision & session-off                         |
|            * Re-hashes ScriptPath after run_workflow -> logs workflow_changed if dirty |
+---------------------------------------------------------------------------------------+
```

### Core Interface Contracts

```ts
// plugins/jev/src/core/governance.ts
export function isOrchestratorOrArgon(model?: string | null): boolean;
export function isOrchestratorModel(model?: string | null): boolean;
export function subagentCeilingRank(sessionModel?: string | null): number;

// plugins/jev/antigravity/logic.ts
export const DOWNGRADE_MARKER_PREFIX = '[jev-downgrade:';

// plugins/jev/antigravity/workflow-guard.ts
export interface PythonWorkflowAnalysis {
  status: 'ok' | 'unverifiable';
  scriptHash: string;
  literalModels: string[];
  unverifiableSites: string[];
}
```

### Architectural Invariants

1. **Empty-Stdout Pass-Through (`Antigravity`):** Any non-intervening `PreToolUse` exit MUST terminate with code `0` and `0` stdout bytes (`decision: "pass"`). Emitting `{"decision":"allow"}` is reserved strictly for intentional Jev interventions (approved elevation or intentional parameter overwrite) where allowed by Antigravity hook semantics.
2. **Zero Prompt Text in Telemetry:** Neither `plugins/jev` nor `doppelganger/scripts/jev-preflight.ts` may persist raw prompt substrings to `jev_telemetry.jsonl`, `antigravity_decisions.jsonl`, or `claude_decisions.jsonl`. Only `taskLen` and 12-hex `taskHash` are written, under `0600` files / `0700` dirs.
3. **Additive Batch Schema:** On Antigravity and OpenCode, `jev_batch_dispatch` activates `kind`, `needsEdit`, `keepEditsOffFreeTier`, `tierSource`, and edit-persona swaps only when `kind` or `needsEdit` is supplied on a task item, preserving exact pre-existing output structure otherwise.
4. **Fail-Open Hook Runtime, Fail-Closed Static Workflow Parsing:** Unexpected runtime errors, missing API keys, or router timeouts in hooks exit `0` with empty stdout. Inside `workflow-guard.ts`, ambiguous or dynamic `model=` expressions and unreadable `ScriptPath` targets fail closed to `decision: "ask"` (the native permission prompt) rather than silently passing or trapping the model in an infinite `deny` loop.

---

## 5. Implementation Workstreams (WS0–WS5)

Release slicing separates core Orchestrator fixes (`v2.3.16`, small diff for fast review alongside `doppelganger` WS4) from Antigravity parity extensions (`v2.3.17`), keeping each PR tightly scoped:

- **Pre-requisite gate (`WS0`):** Merge PR `#54` and PR `#55`; delete stale remote branch and local worktrees.
- **Release `v2.3.16` (`WS1` + `WS2-Core` + `WS4`):** Branch `feat/jev-orchestrator-integration` in `agentic-hub` plus companion `doppelganger` hook/preflight fixes.
- **Release `v2.3.17` (`WS2-Downgrade` + `WS3` + `WS5`):** Branch `feat/jev-antigravity-downgrade-and-workflow` for `[jev-downgrade:flash_lite]`, `run_workflow` guard, and final docs/version synchronization.

### WS0 — Merge Queue, Branch Cleanup & Worktree Hygiene

- **Targets:** `rockad/agentic-hub` PR `#54`, PR `#55`, Issue `#27`, `.claude/worktrees/*`
- **Steps:**
  - Confirm user/maintainer merge of PR `#54` (`feat/jev-tool-validation` -> `main`, `v2.3.14`).
  - Retarget/rebase PR `#55` (`feat/jev-agent-guard-parity`) onto updated `main`, confirm green CI, and merge (`v2.3.15`).
  - Comment SHA `d4d89186f33e604ddd09e638772fa65c1b49af10` on Issue `#27` confirming `refs/heads/fix/jev-small-tails` is superseded by `main`, delete the remote branch (`git push origin --delete fix/jev-small-tails`), and close Issue `#27`.
  - Prune local detached/merged Jev worktrees (`.claude/worktrees/ag-hook`, `.claude/worktrees/guard-parity`, `.claude/worktrees/jev-install`, `.claude/worktrees/validation`).
  - Create clean worktree `../agentic-hub-wt-jev-orch` on branch `feat/jev-orchestrator-integration` off merged `main`.

### WS1 — Orchestrator Ceiling Separation & Universal Batch Rubric (`agentic-hub/plugins/jev`, `v2.3.16`)

- **Targets:**
  - `plugins/jev/src/core/governance.ts`
  - `plugins/jev/src/tools/dispatch.ts`
  - `plugins/jev/tests/governance-argon.test.ts`
  - `plugins/jev/tests/parity-dispatch-harness.test.ts` (new hermetic suite)
- **Changes in `governance.ts`:**
  - Add `isOrchestratorModel(model)` matching `/\borchestrator\b/i` and `isOrchestratorOrArgon(model)` matching `/\b(?:argon|orchestrator)\b/i`.
  - Update `readQuotaView()` so `isArgonActive` (and pool labeling for `gemini-argon-wtu-weekly`) activates when `active_model` matches `isOrchestratorOrArgon`. Ensure `"Argon"` override checks remain distinct from raw `"orchestrator"` subagent ceiling behavior.
  - Introduce `subagentCeilingRank(sessionModel)`:
    - Returns `2` (`flash`) when `isOrchestratorModel(sessionModel)` is true, keeping Orchestrator's planning model (Tier 3) separate from the subagent ceiling (`flash`).
    - Delegates all other models to `modelTierRank(sessionModel)` (preserving raw `Gemini Pro` / `argon` / `opus` rank `3` when non-Orchestrator).
  - Route `clampTierToSessionCeiling()` (when clamping subagent recommendations), `selectModel()`, and `antigravity/logic.ts` ceiling evaluation through `subagentCeilingRank()`.
  - Keep existing explicit user-override bypasses (`isExplicitProOverride(promptText)`) functioning only on deliberate user instruction phrases.
- **Changes in `dispatch.ts`:**
  - Expose stage-rubric processing across Antigravity, OpenCode, and Claude Code whenever any task item supplies `kind` (`mechanical`, `settled-edit`, `judgement`) or boolean `needsEdit`.
  - Apply `STAGE_RUBRIC[kind]` defaults and `keepEditsOffFreeTier` (`openrouter_free` promoted to `flash_lite` when `editsFiles(item) === true`).
  - Mark `judgement` stages with `requiresUserApproval: true` when routed above subagent ceiling (`pro`), including under Orchestrator (`ceiling = flash`).
  - Update `resolveEditCapableSubagent(harness, subagent, taskText)` for Antigravity and OpenCode:
    - When `editsFiles(item)` is true and router assigns a read-only persona (`research`, `knowledge-researcher`), remap to an edit-capable agent from the workspace roster in priority order (`code-engineer`, `Code Engineer`, `self`), handling both kebab-case and display-name definitions per Issues `#13` and `#23`.
  - Add strict Zod validation checks in `plugins/jev/src/tools/dispatch.ts` / server schemas (matching PR `#54` conventions) so `kind` and `needsEdit` accept valid values cleanly on every harness.

### WS2 — Antigravity Guard Consolidation, Live Model Precedence & Downgrade Choice

- **Targets:**
  - `plugins/jev/antigravity/hook.ts`
  - `plugins/jev/antigravity/logic.ts`
  - `plugins/jev/antigravity/approvals.ts`
  - `plugins/jev/src/core/quota-policy.ts` or shared quota helper (as appropriate)
  - `plugins/jev/tests/antigravity-hook.test.ts`
- **Part A (`v2.3.16` — Ceiling, Precedence & Policy Consolidation):**
  - **Live model precedence (`antigravity/hook.ts`):** Resolve active session model as `const rawModel = (typeof input.modelName === 'string' && input.modelName.trim()) ? input.modelName.trim() : quotaView?.active_model;` then apply `ceilingModelForHarness('antigravity', rawModel)`. This immediately detects UI switches to or from `gemini-pro-orchestrator-g1-pro` even while `quota-state.json` still reports `Gemini 4 Hydrogen (Medium)`.
  - **Omitted/`inherit` subagent policy:** Keep omitted or `Model: "inherit"` passing through with empty stdout (`decision: "pass"`) during normal quota and normal ceiling checks, matching Fork 2.
  - **Consolidated `invoke_subagent` guards (`antigravity/logic.ts`):** Move the safety checks previously fragmented into shell hooks directly into `evaluateAntigravitySubagentCall()`:
    - Reject `Model: "openrouter_free"` and unknown model enum values with actionable `deny` guidance pointing to `jev_execute_free` / `jev_agent_free`.
    - Enforce quota `<10%` emergency lockout (`free_only`: deny paid `invoke_subagent` tiers unless user explicitly overrides via `[jev-elevate:*]` or prompt directive) and `<=20%` conserve throttle (`flash` / `pro` downgraded or gated to `flash_lite`).
    - Enforce `subagentCeilingRank` (`flash` under Orchestrator) so `Model: "pro"` triggers `[jev-elevate:pro]` (`once`, `5min`, `session`) with the 3rd-attempt permission dialog backstop (`decision: "ask"`).
- **Part B (`v2.3.17` — `[jev-downgrade:flash_lite]` Parity):**
  - Mirror Claude Code's downgrade flow in `antigravity/logic.ts`, `antigravity/hook.ts`, and `antigravity/approvals.ts`:
    - Trigger condition: `invoke_subagent` with `Model: "flash"` (or omitted/`inherit` on a non-conserve `flash`/Orchestrator session when explicitly configured), mode is `ask` or `auto` (`models.downgrade.mode` in `config.json`, overridden by `JEV_DOWNGRADE=ask|auto|off`), and not disabled for the conversation in `approvals.ts`.
    - Rating: call OpenRouter Decisions router (`~typesafe/jev-latest`, 1,500ms timeout, fail-open on timeout/missing key/error) using `Role` + first 1,000 characters of `Prompt`. Cache verdict by SHA-256 signature for 10 minutes.
    - Threshold: when cumulative router probability $P(\text{openrouter\_free} + \text{flash\_lite}) \ge 0.6$:
      - In `ask` mode: deny once on the first attempt with `[jev-downgrade:flash_lite]` instructions for `ask_question` offering `"Yes, flash_lite"`, `"No, keep flash"`, and `"No, and don't ask again this session"`.
      - In `auto` mode when `Model` was explicitly supplied: emit `"allow"` + `overwrite: { Model: "flash_lite" }` (when `Model` was omitted/`inherit`, verify live whether Antigravity accepts injected `Model` overwrite; until verified live, log telemetry and test contract hermetically).
    - `PostToolUse` on `ask_question`: scan bounded 1 MB transcript tail (`readRegularFileTail`) around `stepIdx` for `[jev-downgrade:<alias>]`, record choice (`Yes` -> cache short approval or guidance; `No, keep` -> waive this signature; `don't ask again` -> disable downgrade prompts for the conversation), and record event in `antigravity_decisions.jsonl`.

### WS3 — Fail-Closed Python `run_workflow` Static Guard (`agentic-hub/plugins/jev`, `v2.3.17`)

- **Targets:**
  - `plugins/jev/antigravity/workflow-guard.ts` (new)
  - `plugins/jev/hooks.json`
  - `plugins/jev/antigravity/hook.ts`
  - `plugins/jev/tests/antigravity-workflow-guard.test.ts` (new)
- **Design (`Fail-Closed Static Python Analyzer`):**
  - Wire `hooks.json` matchers to:
    - `PreToolUse`: `"invoke_subagent|run_workflow"`
    - `PostToolUse`: `"ask_question|run_workflow"`
  - Extract Python source from `toolCall.args.Script` (inline) or `toolCall.args.ScriptPath` read safely via FIFO/size-bounded `readRegularFile` (fail-closed `decision: "ask"` if `ScriptPath` is missing, unreadable, directory/FIFO, or truncated beyond limit).
  - Tokenize Python source deterministically in pure TypeScript (no subprocess `python3` invocation on untrusted strings):
    - Skip comments (`# ...`) and string literals (`'''...'''`, `"""..."""`, `'...'`, `"..."`) when locating `agent(...)` call sites and balancing parentheses cleanly.
    - Inspect every `agent(...)` call for:
      - Keyword arg `model=...` or positional argument matching Antigravity's `agent(prompt=None, schema=None, role=None, type_name="self", workspace="inherit", model=None)` parameter slot (index 5).
      - Unpack operators (`**kwargs`, `*args`) inside `agent(...)` or helper wrappers around `agent(...)` if detected -> mark `unverifiable`.
  - Enforcement table:
    - **`status: 'ok'`, all literal models $\le$ ceiling (`flash` under Orchestrator):** exit `0` with empty stdout (`pass`).
    - **`status: 'ok'`, any literal `model` above ceiling (e.g., `"pro"`):** route through `[jev-elevate:pro]` approval store keyed by `workflow:<sha256(scriptSource)>` (`once` / `5min` / `session`, plus 3rd-attempt `ask` backstop).
    - **`status: 'unverifiable'` (dynamic variable `model=tier`, `**kwargs`, or unreadable `ScriptPath`):** immediately emit `decision: "ask"` (Antigravity native confirmation dialog), avoiding silent bypass and avoiding infinite `deny` retries.
  - **`PostToolUse` on `run_workflow`:** recompute SHA-256 of `ScriptPath` (if file-based); if different from `PreToolUse` pin, log `workflow_changed` to `antigravity_decisions.jsonl` and invalidate cached `session` approval for that script.
  - **Marked Unverified Live:** exact live runtime shape of Antigravity `run_workflow` `PreToolUse` / `PostToolUse` JSON envelope (verified against documented skill parameter names `Script`, `ScriptPath`, `Cwd`, `Args`, with casing tolerance for `script` / `script_path`).

### WS4 — Companion Workspace Hooks & Preflight Privacy Fix (`doppelganger`)

- **Targets (separate PR in sibling `doppelganger` repository, coordinated with `v2.3.16`):**
  - `doppelganger/scripts/jev-preflight.ts`
  - `doppelganger/.agents/hooks/jev-pre-invocation.sh`
  - `doppelganger/.agents/hooks/jev-pre-tool.sh`
  - `doppelganger/.agents/hooks.json`
- **Changes:**
  - **Fix privacy leak (`jev-preflight.ts`):** Import `taskFingerprint` from `plugins/jev` shared module (or compute identical `taskLen` + 12-hex `taskHash`) and remove `task: cleanTask.slice(0, 120)`.
  - **Config lookup consistency:** Read `.harnesses.antigravity.mode // .defaults.mode // "off"` in `jev-preflight.ts`, `jev-pre-invocation.sh`, and `jev-pre-tool.sh`.
  - **Orchestrator-aware preflight (`jev-preflight.ts`):**
    - Detect Orchestrator via `modelName`.
    - Skip unnecessary single-task `callJev` round-trips when turn is a short prompt or `[plan review]` hand-back.
    - Inject phase-aware Orchestrator directives (Planner: keep single-stream edits up to 6 files in-context, run `jev_batch_dispatch` with `kind` + `needsEdit` only for genuine multi-stream workstreams; Executor: offload mechanical text with `jev_execute_free`, obey `flash` subagent ceiling, gate diff with `jev_judge`).
  - **Clean `jev-pre-tool.sh` & `hooks.json`:**
    - Remove `invoke_subagent` from `doppelganger/.agents/hooks.json` matcher and remove dead `.Subagents[]` inspection from `jev-pre-tool.sh`.
    - Update `hooks.json` matcher to `run_command|write_file|edit_file|write_to_file|replace_file_content`.
    - Replace all `echo '{"decision":"allow"}'` outputs with `exit 0` and `0` stdout bytes.
    - Read `.toolCall.args.Path // .toolCall.args.TargetFile` and track distinct edited files per `.conversationId` / session.
    - Enforce write threshold of **6** distinct files on Orchestrator sessions (matching `modelName` or `exit_plan_mode` marker in `transcriptPath`) and **3** on standard sessions; reset counter within a 15-minute window after `jev_batch_dispatch`, `jev_dispatch`, or `invoke_subagent`.

### WS5 — Documentation, Version Sync & Release Finalization (`agentic-hub`)

- **Targets:**
  - `plugins/jev/README.md`
  - `plugins/jev/skills/jev/SKILL.md`
  - `plugins/jev/package.json`
  - `plugins/jev/.claude-plugin/plugin.json`
  - `.claude-plugin/marketplace.json` (verify plugin version entry aligns)
  - `plugins/jev/docs/plans/2026-11-12-jev-consolidated-plan.md`
- **Deliverables:**
  - Document Orchestrator subagent ceiling (`flash`), cross-harness `jev_batch_dispatch` stage rubric (`kind`, `needsEdit`), `[jev-downgrade:flash_lite]`, and Python `run_workflow` guard behavior.
  - Keep any RFC 005 phrasing consistent with Issue `#24` (`"relocating to cognitive-engine"`, never `"retired"`).
  - Update consolidated plan section 32+ with observed verification evidence and merged PR SHAs.

---

## 6. Verification Matrix & Review Checklist

### Automated Checks (`agentic-hub/plugins/jev`, Hermetic Env)

1. TypeScript type-check:
   - `bun x tsc --noEmit -p plugins/jev/tsconfig.json`
2. Full test suite under isolated `HOME` (no leakage from `$HOME/.config/jev`):
   - `env -i PATH="$PATH" HOME="$(mktemp -d)" bun test --cwd plugins/jev`
3. Marketplace & skill layout gate (repo root):
   - `bash scripts/check-skills-marketplace.sh`
4. Semantic diff quality gate before commit:
   - Run `jev_judge` against staged diffs to verify zero conflict markers, zero unapproved raw prompt logs, and complete invariant compliance.

### Live / Stdin Hook Envelope Verification (`agentic-hub` + `doppelganger`)

1. **Orchestrator ceiling enforcement:** Pipe `invoke_subagent` payload with `modelName: "gemini-pro-orchestrator-g1-pro"` and `args.Model: "pro"` (even when fixture `quota-state.json` says `Gemini 4 Hydrogen (Medium)`) -> expect `decision: "deny"` containing `[jev-elevate:pro]` and telemetry reporting `ceilingTier: "flash"`.
2. **Omitted / `inherit` pass-through:** Pipe `invoke_subagent` with `modelName: "gemini-pro-orchestrator-g1-pro"` and `Model: "inherit"` (normal quota, downgrade off) -> expect exit `0` and **0 bytes** on stdout.
3. **Python `run_workflow` literal & dynamic checks:**
   - Literal `agent(..., model="pro")` -> expect `decision: "deny"` with `[jev-elevate:pro]` and `workflow:<sha256>`.
   - Dynamic `agent(..., model=tier)` -> expect `decision: "ask"`.
4. **`jev-pre-tool.sh` pass-through & write threshold:**
   - Pipe 4th distinct `edit_file` under standard session -> expect exit `0`, `deny` mentioning `jev_batch_dispatch`.
   - Pipe 4th distinct `edit_file` under Orchestrator session -> expect exit `0`, **0 bytes** on stdout (`allow` up to 6).
5. **Telemetry privacy check:** Execute `jev-preflight.ts` on a synthetic prompt -> confirm `$HOME/.gemini/antigravity-cli/jev_telemetry.jsonl` records `taskLen` and `taskHash` with **zero** raw prompt substrings.

### Open Review Questions for `@Doc-Cr` / Claude Code

- **Q1 (PR split):** Does splitting `v2.3.16` (WS1 + WS2 Part A: Orchestrator ceiling, live `modelName`, consolidated `invoke_subagent` guard, additive `jev_batch_dispatch` rubric) and `v2.3.17` (WS2 Part B + WS3: Antigravity downgrade choice + Python `run_workflow` guard) give the cleanest review chunks, or do you prefer one combined PR after `#54` and `#55` land?
- **Q2 (`inherit` downgrade semantics):** When `Model` is omitted or `"inherit"` under Antigravity, Antigravity `PreToolUse` pass-through normally uses empty stdout. When `[jev-downgrade:flash_lite]` triggers in `auto` mode on an omitted/`inherit` call, should Jev inject `overwrite: { Model: "flash_lite" }` directly or restrict `auto` overwrite to explicit `Model: "flash"` calls if Antigravity ignores `overwrite` on omitted fields? (To be verified live during WS2 testing.)
- **Q3 (Python tokenizer scope):** Are there known multi-line / helper-factory idioms in `$HOME/.gemini` workflow scripts beyond direct `agent(...)` keyword/positional `model=` and `**kwargs` that `antigravity/workflow-guard.ts` should treat as `unverifiable` -> `ask` from Day 1?
- **Q4 (Issue `#24` timing):** Should `plugins/jev/README.md` include the `"relocating to cognitive-engine"` Phase A note in WS5 now, or wait for the dedicated `cognitive-engine` RFC 005 PR?
