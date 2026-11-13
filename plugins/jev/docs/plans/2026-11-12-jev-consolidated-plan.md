# Jev consolidated plan (2026-11-12)

Living document; the latest status is in section 24. Sources:

- `plugins/jev/docs/case-studies/2026-11-09-model-tier-for-multi-stream-workflow.md` (case 1, on `main`)
- `plugins/jev/docs/case-studies/2026-11-11-pretooluse-dialog-on-pinned-model.md` (case 2, on PR #33)
- Reply from the cognitive-engine session, 2026-11-12 (verified there against `origin/main` `58e81e4` and PR #22)

Labels: **verified**, **reported**, **unverified**, as in the case studies.

## 1. Where things stand

- **agentic-hub `main` (`83f50bd`):** Jev 2.3.1. Case 1's whole-word tier keywords and explicit-model instructions (5.1) landed in 2.3.1 (commit `57d2f88`, verified from its title; not re-read in code).
- **PR #33 (open):** Jev 2.3.2, removes the pro-rating dialog on a pinned model. Not merged, not installed, no live check yet.
- **PR #34 (open):** two-line wording change in the case 1 handoff. Harmless.
- **cognitive-engine (`~/projects/cognitive-engine`):** `packages/jev` is 1.0.0 on `main`. Jev 2.4.0 exists only in PR #22 (stacked on #20, merge order #20 then #22, both wait for the owner's go). #22 implements 5.1 to 5.7, 5.9 to 5.11. 5.8 is already on `main` (#4 and #18). A follow-up branch `feat/jev-followup` is docs only so far.
- **Settled decisions (reported):** decision 14, the Jev version line continues in cognitive-engine at 2.4.0 while agentic-hub gets 2.3.x patches until RFC 005 Phase C. Decision 15, Jev is not retired; only the agentic-hub copy retires.
- **Deliberate difference:** cognitive-engine does not port the "skip the prompt on an explicit request" variant. Its guard prompt counts as the user's approval.

## 2. Work, in order

### Phase 0: cleanup (agentic-hub) — done 2026-11-12

- `main` is checked out in the shared checkout at `65849ee` (#33 and #34 merged).
- Removed: worktrees `wt-case`, `wt-jev`, `wt-jevfix`, `wt-hookfix`, `wt-main`; local branches `pr-5`, `pr-7`, `pr-8`, `case-study-fixes`, `docs/jev-case-study-notes`, `fix/jev-case-study-2-3-1`, `fix/jev-case-study-fixes`, `fix/jev-pretooluse-pinned-model`, `feat/jev-remediation-and-decoupling`, `feat/jev-dynamic-agents-and-mode-hardening`, `docs/chrome-devtools-attribution`. The matching `origin` branches were already gone.
- Still open: the two old branches (decision 6 below).

### Phase 1: ship 2.3.2 (agentic-hub) — done, one item open

1. Merged #33 (2.3.2) and #34 (case 1 handoff wording).
2. Installed 2.3.2 (`65849ee`) and restarted. Live check 2026-11-12 (decisions log, verified): a pinned-`sonnet` delegation launched with no dialog and logged `requested_model: sonnet`, tier and recommended model; a `model: opus` delegation logged the new guard wording. Open: whether the opus dialog was approved by hand or auto-allowed (the log's `decision` field is null).
3. Open: the 5 tests that also fail on `main` (custom-agent discovery, per-harness mode isolation, three Stage 2 workspace-agent discovery tests): fix or record as unrelated.
4. Optional tag `jev-v2.3.2`.

### Phase 2: cognitive-engine 2.4.0

1. You decide the merge of #20 then #22 (the cognitive-engine session says both wait for the owner's go).
2. Add the test the cognitive-engine session proposed: a pro rating plus a call pinned to the session model must produce no ask. This is case 2's contract test (case 2, section 9).
3. Map handoff items 1 to 6 of case 1 (section 8) one by one against #22. Only items 2, 4 and 5 are mapped so far (5.1/5.9, 5.11, 5.3).
4. Re-run `jev_dispatch` on one stream description to see whether the ceiling clamp fired (case 1, section 6, first bullet), then confirm 5.11 fixes it in the 2.4.0 build.
5. Follow-up PR `feat/jev-followup` (`JEV_RECALL_URL`, warn-only notice for env remaps, `JEV_HARNESS` set by each adapter), after #22.

### Phase 3: documents

1. Move case 2 into `packages/jev/docs/case-studies/` in cognitive-engine next to case 1. Not known there yet.
2. Leave pointers in agentic-hub's case study files once #22 merges. The cognitive-engine session will notify `claude-cp`.
3. Fix the case 1 status line ("outcome section open") when the verdict is filled.

### Phase 4: close the loop

1. Fill the case 1 outcome verdict after an independent check on the highest tier of the coordination diff (the one final gate under the standing rule). This needs your go on Opus.
2. Retire the agentic-hub copy of Jev at RFC 005 Phase C (owner decision, RFC 005 and 006 in PRs #7 and #11 are open).

### Phase 1b: 2.3.x backports (mandatory)

Cognitive-engine is not live and this plugin is published and used by others, so the fixes below ship here as patch releases, not only in 2.4.0. Section 5 holds the item-by-item state; section 6 holds the decisions that fix the order.

Order, per the clarified decisions (section 6):

1. Executable audit (WS1): port #22's test cases, run on 2.3.2, failures define the 2.3.3 scope. Parity table in section 7.
2. 2.3.3: one bundled release with every missing item except the tool-schema change (5.5, 5.6, 5.2 one-sentence test, 5.9 rule label, repeat-turn marker, 5.10 `agent_call` and reminder in the existing matcher, `Workflow` matcher only if the 5.8 check shows `PreToolUse` fires for workflow agents, exit flush, file permissions, `editsFiles`, plus whatever the audit finds).
3. 2.3.4: 5.3 rubric and 5.4 `kind` and `needsEdit` on `jev_batch_dispatch`, optional fields only (absent means output identical to 2.3.3). Ships after 2.3.3 has been live for a while.
4. One Opus gate after 2.3.4 (with `jev_judge` alongside): backport diff against the parity table, plus the case 1 verdict on the coordination diff. 2.3.3 and 2.3.4 get Sonnet review and the parity tests only.

## 3. Cleanup proposal (awaiting approval)

Delete locally, safe (all merged on GitHub or into `main`):

- `pr-5`, `pr-7`, `pr-8`: PRs #5, #7, #8 merged
- `docs/jev-case-study-notes` (local and `origin/`): PR #29 merged
- `case-study-fixes`: stale, would delete 90 files, content is already on `main` or in #34
- `fix/jev-case-study-2-3-1`, `fix/jev-case-study-fixes`, `feat/jev-remediation-and-decoupling`, `feat/jev-dynamic-agents-and-mode-hardening`, `docs/chrome-devtools-attribution`: merged into `main`

Keep for now:

- `fix/jev-pretooluse-pinned-model` (#33) and `docs/case-study-stale-handoff` (#34): open PRs
- `feat/jev-modular-sqlite-ram-cache` and `rfc/harness2-jev-unified-cognitive-substrate`: unmerged on `origin`, not matched in cognitive-engine by commit subject (weak test). The RFC branch is the origin of RFC 001 (reported), which cognitive-engine #1 merged under another name. Decide after a content check.

Worktrees to remove after their branches go: `wt-case`, `wt-jev`, `wt-jevfix`, `wt-main`; and `wt-hookfix` after #33 merges.

Not touched (not Jev): `wt-pg` (11 uncommitted coordination files), `wt-agy` (one untracked spike file), `wt-scaf`, `wt-harden`, `wt-clean`.

## 4. Open questions

- Is the shared checkout in use by another session? It is now detached at `origin/main`.
- Do the two old unmerged branches carry anything not in cognitive-engine?
- Does the 5-failure test baseline (agentic-hub) need fixing before 2.3.2, or only recording?

## 5. Backport matrix: agentic-hub 2.3.2 versus cognitive-engine #22

Source: the cognitive-engine session's backport notes (reported) checked against the 2.3.2 source in `agentic-hub-wt-hookfix` by symbol search (verified that a symbol exists or not; behaviour not re-run). That session did not inspect 2.3.2 and believed more was missing than is.

Already in 2.3.2 (symbol present in `claude/` or `src/`):

- 5.1 explicit instruction: `parseUserIntent`, `INTENT_SCAN`. Hardening from #22 (ignore code, quotes, questions, pasted speaker lines, statements of intent, negators; two models in one clause is ambiguous) is unverified here.
- 5.7 one key: `turnId`, `recommended_model`, `modelRecommended`.
- 5.9 precedence: `resolveModel`. The visible rule label ("per your instruction | guard | standing rule") and the lowering of the ceiling to the project ceiling are absent (`appliedRule`, `lowerModel` not found).
- 5.10 partly: pre-flight reminder, `hasRecentDispatch`, a `turn.json` marker. Absent: `Workflow` matcher (`hooks.json` matches `Agent|Task`), the `agent_call` record, the failed-dispatch filter, the staged third-call rule.
- 5.3 whole-word keywords and 5.6 edit swap: `isFreeTierMechanicalTask`, `taskNeedsEdit`, `editCapableSubagent` (2.3.1).
- 5.11 harness-aware dispatch: `buildExecutionGuidance` in `src/tools/dispatch.ts:95-129` gives Claude Code `Agent(subagent_type, model)` wording and no Antigravity ceiling (2.3.1, verified in `origin/main` source). The Antigravity branch keeps `invoke_subagent`, as in #22. An earlier version of this plan listed 5.11 as missing; that was wrong. Not checked: `activeSessionModel` reports the Claude session model.

Missing in 2.3.2 (symbol not found):

- 5.2 one ceiling sentence: partly. A resolved single sentence exists (`claude/logic.ts:263`) but the old two-sentence text is still emitted on another path (`claude/logic.ts:295`, `:312`). Needs a test that proves one sentence on every path.
- 5.3 stage rubric (`STAGE_RUBRIC`) and 5.4 `kind` and `needsEdit` on `jev_batch_dispatch`, plus `isStagedPrompt`.
- 5.5 silence on host-injected turns (`<task-notification>` and similar), paste cap, trim to 2000 characters. The hook still emits for any prompt of 8 characters or more (`claude/hook.ts:110`).
- 5.6 display-name dedupe (`withoutDisplayNames`).
- `editsFiles` in the free-tier guard (the batch tool uses the caller flag only).
- Exit race: `process.exit(0)` at `claude/hook.ts:374` with no flush of async telemetry (#22 saw 3 of 5 telemetry lines written).
- 0700 and 0600 permissions on the advice and turn files and the decisions log (only the cache has them).

Not copied: the cognitive-engine guard module (`lowerModel`, project ceiling), the acorn workflow guard (#4, #18), the package layout. The agentic-hub variant that skips the prompt on an explicit request stays in 2.3.x (cognitive-engine chose the opposite deliberately).

### Backport order (superseded)

Superseded by the clarified decisions in section 6 (one bundled 2.3.3, then a separate additive 2.3.4). Kept for the item grouping only.

1. 2.3.3, small and independent:
   - 5.5 silence and trim
   - 5.6 display-name dedupe
   - exit flush, file permissions
   - failed dispatch filter, intent-parser hardening (if the check shows it missing)
   - 5.2 one-sentence test on every path
2. 2.3.4, small to medium:
   - 5.9 rule label
   - repeat-turn marker (advice must be written at or after the turn marker)
   - ceiling lowering, only if the agentic-hub guard has a project ceiling
3. 2.3.5, medium:
   - 5.10 `Workflow` matcher (check 5.8 first: PreToolUse may not fire for workflow agents) and the `agent_call` record, inside the existing `onPreToolUse`
   - `editsFiles` guard fix
4. 2.3.6, largest (changes MCP tool schemas):
   - 5.3 rubric, 5.4 `kind` and `needsEdit` (5.11 is already in 2.3.1)

Each item: its own branch off `origin/main` in a temporary worktree, not in the shared checkout, a test that fails on the old code, a PR, no merge without your go.

### Gate before starting

- Read the 2.3.2 intent parser and `resolveModel` against the #22 behaviour list (one read, not a rewrite), to confirm the "already in" items are behaviourally equal, not just present by name.
- Merge #33 first so each patch starts from 2.3.2.

## 6. Decisions (clarified 2026-11-12)

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Release shape | One bundled 2.3.3 (everything except the tool-schema change) |
| 2 | Alignment with #22 | Port #22's test cases as the spec; keep a parity table (section 7) |
| 3 | Audit of "already in" items | Executable: port the tests, run on 2.3.2, failures define the 2.3.3 scope |
| 4 | Tool-schema change (5.3, 5.4) | Separate additive 2.3.4; `kind` and `needsEdit` optional; absent means unchanged output |
| 5 | Where docs live | Stay in agentic-hub; plan committed by PR; outcome notes added to both case studies; case 2 copied to cognitive-engine after #22 merges, pointers left here |
| 6 | Old unmerged branches (`feat/jev-modular-sqlite-ram-cache`, `rfc/harness2-jev-unified-cognitive-substrate`) | Content check against cognitive-engine, then delete or keep; deleting on `origin` needs a separate go |
| 7 | Final gate | One Opus gate after 2.3.4 with `jev_judge` alongside: backport diff against the parity table plus the case 1 verdict on the coordination diff |

Rules for every release: own branch off `origin/main` in a temporary worktree (never edit `plugins/jev` in the shared checkout: the marketplace entry is a local directory source, so an edit there changes the installed plugin for every session; verified from case 2 section 8 and a peer report), a test that fails on the old code, a PR, no merge or push without a go.

## 7. Parity table

Filled by the audit (WS1). Report: `parity-audit-2026-11-12.md` on branch `test/jev-parity-audit` (not pushed yet).

| Item | #22 test | 2.3.x test | Result on 2.3.2 |
| --- | --- | --- | --- |
| _pending_ | | | |

## 8. Workstreams (2026-11-12)

| Stream | Scope | Model | State |
| --- | --- | --- | --- |
| WS1 | Port #22 tests, run on 2.3.2, gap list | sonnet (`qa-engineer`, isolated worktree) | running |
| WS2 | 2.3.3 fixes for the gaps | sonnet (`code-engineer`) | waits for WS1 |
| WS3 | This document | main session | done |
| WS4 | Old-branch content check, read-only | sonnet (`general-purpose`) | running |
| WS5 | 2.3.4 schema change | sonnet (`code-engineer`) | after 2.3.3 |
| Gate | Opus review plus `jev_judge` | opus (`general-purpose`) | after 2.3.4 |

`jev_batch_dispatch` for WS1, WS3 and WS4 returned sonnet for all three, in parallel (verified). The display-name personas it suggested (`QA Engineer`, `Vault Librarian`, `Code Engineer`) are not Claude Code `subagent_type` values; kebab-case types were used.

## 9. Old branches: analysis and disposal (2026-11-12)

Both branches are deleted locally and on `origin`. Tips, for recovery from a clone or the reflog: `feat/jev-modular-sqlite-ram-cache` = `e8b1707`, `rfc/harness2-jev-unified-cognitive-substrate` = `3ff4a6a`.

`rfc/harness2-jev-unified-cognitive-substrate`: superseded. Its single file is the pre-cognitive-engine draft of RFC 001, whose descendant lives in cognitive-engine (337 lines, 17 commits later). The decisions it reversed (unified-SQLite memory daemon, breaking `memory_*` cutover, `/tmp` worktree fallback, clean-slate v1.0.0) exist only in this branch and were rejected (verified by the content check, WS4).

`feat/jev-modular-sqlite-ram-cache`: the earlier history is already in `main`; only commit `e8b1707` (6 files, +148/-34) was unique. Each change checked against current `main`:

| Change in `e8b1707` | Verdict | Reason (verified against `origin/main` source) |
| --- | --- | --- |
| OpenCode model aliases (`~anthropic/...-latest`) | Skip | `main` already has them; the branch's `~google/gemini-flash-latest` for "standard" is less consistent with the Claude tiers |
| `resolveAgentKey` in batch dispatch | Skip | The hard-coded persona `if` chain it patches no longer exists; `main` routes by router or keyword and already honours `availableSubagents` |
| `normSa` casing in the effort rule | Skip | Moot on `main` |
| snake_case agent aliases in `registerAgent` | Skip | Adds a third duplicate key per agent; case 1 finding 4.5 and item 5.6 want fewer duplicate persona names offered to the router, not more |
| `requiresApproval` from `config.tiers` and `defaults.requireUpgradeApproval` | Skip (would regress) | The default config sets `defaults.requireUpgradeApproval: true` (`src/core/config.ts:88`), so every task without a tier-level entry would be marked as needing approval; today only `pro` or `deep` is |
| `getQuotaThresholds()` via `loadJevConfigSync()` | Skip (would regress) | The loader merges default thresholds (`src/core/config.ts:129`), so the file-threshold branch would always be set and would shadow the generic env fallbacks such as `JEV_QUOTA_NORMAL_MIN`; the branch's test only covers explicit file values |
| Batch dispatch reads `config.tiers.free.concurrencyCap` | Adopt | The field is parsed (`src/core/config.ts:344`) and never consumed; default stays 10 (`src/tools/dispatch.ts:503`). Goes into the 2.3.3 bundle (task #3) with a test |

Not verified: the branch's own regression tests were not run against current `main`.

## 10. Cognitive-engine update (reported by ce-research, 2026-11-12)

- #20 and #22 are merged to cognitive-engine `main` (`0f58554`, `c260bf5`, CI green). `packages/jev` is 2.4.0 on `main`: the advisor port (5.1 to 5.11; 5.8 was merged earlier via #4 and #18) plus the guard hardening. Section 2 Phase 2 steps 1 and 5 above are therefore about a merged state; the case 1 relocation (copy case 2, pointers here) is now unblocked.
- Follow-up branch `feat/jev-followup` (not yet opened, docs only): `JEV_RECALL_URL` override, a warn-only notice when `ANTHROPIC_DEFAULT_*_MODEL` remaps or `CLAUDE_CODE_EFFORT_LEVEL` is set (the guard's alias ranking and effort threshold cannot see through them), each adapter sets `JEV_HARNESS`, log rotation deferred.
- Candidates for the agentic-hub 2.3.x line, to check against this code before adding to 2.3.3 (unverified here):
  - `detectActiveHarness()` checking Claude markers before OpenCode ones, so an OpenCode launched from a Claude shell reads as `claude-code`. The same function is used here (`src/core/config.ts`).
  - The warn-only remap and effort notice.
  - The mismatch of harness labels in telemetry (advisor says `claude`, MCP tools say `claude-code`).
- Known limits left open in 2.4.0 (so not backported): free-tier guard on non-Claude harnesses, unbounded decisions log and telemetry, short-prompt turn hash guessable.
- Not ported on purpose: the agentic-hub `PreToolUse` ask on a stronger model; in cognitive-engine the guard's single prompt counts as the approval.

## 11. Direction change (user, 2026-11-12)

- Jev code work happens in agentic-hub (the published plugin). Cognitive-engine hosts docs only for Jev: no Jev code PRs there, including the `feat/jev-followup` items. The cognitive-engine session was told to send improvement requests to this session as text.
- The `feat/jev-followup` items (`JEV_RECALL_URL`, warn-only remap and effort notice, `JEV_HARNESS` set per adapter, harness label alignment) become candidates for the 2.3.x line, to be checked against this code and added to 2.3.3 where they apply (task #3).
- This supersedes the "advisor port lands in cognitive-engine 2.4.0" assumption in the case 1 handoff for new work; the merged #20 and #22 stay as they are.
- `ce-research` (reported, from cognitive-engine `packages/jev/src/guard.ts` at `c260bf5`, nothing run against Antigravity) holds back from Jev code and the case 2 copy in cognitive-engine until the user confirms the reversal of decisions 14 and 15 there. A peer message does not settle it; the user's answer to that session does.

## 12. Candidate: Antigravity `define_subagent` model bypass

- Reported by `ce-research` for the cognitive-engine guard: the Antigravity hook matches only `invoke_subagent`, so a model set in a `define_subagent` front matter is never read, and an empty or `inherit` model passes. Unverified: whether Antigravity applies the definition's model when the invoke call leaves it empty; needs a live Antigravity run.
- Not checked here: whether the agentic-hub Antigravity path (`src/core/governance.ts`, `src/tools/dispatch.ts` clamp) has the same gap. Check before adding to 2.3.3; if real, the fix is to resolve the defined subagent's model when the call sets none (the Claude guard's `agentDefinitionModel` is the shape).

## 13. Audit result (WS1, 2026-11-12)

Branch `test/jev-parity-audit` (`09edb8d` tests, `67cb2e6` report; not pushed), in a temporary worktree. Full table: `plugins/jev/docs/plans/parity-audit-2026-11-12.md` on that branch.

- 289 ported cases: 175 pass, 114 fail (shared causes, not 114 gaps); about 50 more cases are not portable (need `guard.ts`, project ceiling, `stage-rubric.ts`, `advisor-state.ts`).
- Baseline on `main`: 6 failing tests plus 1 unhandled error (not 5): the five listed earlier plus "OpenCode binary and runner exports are completely removed from `src/index.ts`"; the unhandled error is a missing `@modelcontextprotocol/sdk` import in a worktree without `node_modules`.
- Correction of section 5: items listed there as "already in 2.3.2" were present by name but not by behaviour. Parser hardening (5.1) fails 40 of about 90 cases, precedence (5.9) 5 of 10, pre-flight reminder (5.10) 5 of 9, silence (5.5) 4 of 6, telemetry key (5.7), turn marker, and the 4.11 substring sites all have gaps. Only 5.6 persona dedupe, the 5.11 non-Claude wording and the batch end-to-end tier cases pass cleanly.
- Main root causes: `Workflow` not handled by the hook; parser ignores quote, code, question and negation context; the stored turn has no `mode`; dispatch tools unaware of the Claude session (2.3.4 scope).
- Caution from the auditor: many failures are wording only (exact #22 text asserted); two passes are vacuous.
- Decision taken by this session (for review): the log key choice is additive, `session_id` alongside `session`; #22's wording is adopted where a parity test asserts it.

## 14. Conflict resolved (reported by ce-research, 2026-11-12)

- The owner confirmed in the cognitive-engine session: until cognitive-engine work is done, all Jev and other plugin fixes go into the agentic-hub plugins ("plugins first"). Section 11's reversal stands; the open question in section 11 is closed.
- Cognitive-engine commit `fbba1c8` (docs only, reported): decisions 14 and 15 revised, new decision 19 "plugins first" in `docs/plans/2026-11-10-delivery-plan.md`; Jev follow-up code dropped there (`feat/jev-followup` keeps docs commits only); case 2 copied to `packages/jev/docs/case-studies/` with a relevance note (its guard makes no network call and its advisor never asks, so the dialog path is absent there; no test covers that exact case).
- Still open and ours: whether Antigravity applies a defined subagent's model when `invoke_subagent` leaves `Model` empty or `inherit` (section 12; needs a live Antigravity run).
- Reference for the backport: cognitive-engine #22 (jev 2.4.0) is the reference implementation of 5.1 to 5.11.
- Left to do here: add pointers in the two agentic-hub case studies to the cognitive-engine copies once we decide to (docs PR).

## 15. Elevation design (user decision, 2026-11-12)

Problem (verified from the 2.3.2 dialog text and the live check): a `PreToolUse` "ask" on a model above the session model gives Yes or No, and in Claude Code No rejects the call and the assistant waits. The user wants No to mean "continue on the session model".

Decision: **Option A, ask in chat, hook clamps.**

- The hook stops opening a dialog for elevation. It rewrites an elevating `Agent` call to the session model and tells the assistant to ask the user in chat (Yes/No) before ever using the stronger model. No then needs no further action: the work already continues on the session model.
- Yes: the assistant relaunches on the stronger model. The hook must recognise the approval from something it can trust: an explicit user instruction in the current prompt (5.1 parser), or the user's answer to the chat question found in the transcript (the hook receives `transcript_path`; unverified).
- Open checks (delegated, result pending): that Claude Code accepts a rewritten model from a `PreToolUse` hook (`updatedInput`, with allow and no dialog), which version, and that `additionalContext` reaches the model.
- Where it lands: 2.3.4 or a dedicated 2.3.5, not in 2.3.3; WS2 was told not to touch the dialog. Supersedes the 2.3.2 wording "Yes runs it on the stronger model. No cancels...".
- Tests to add: an elevating call is rewritten and no `permissionDecision` is returned; an explicit "use opus" prompt passes unchanged; a chat Yes in the transcript passes unchanged; a call at or below the session model is untouched.
- Risk: if the harness ignores `updatedInput`, fall back to Option B (keep the dialog, standing rule to relaunch on the session model after No) and say so in the README.

### 15.1 Docs check result (reported by a docs-lookup agent from code.claude.com hooks, permissions and changelog pages; not run here)

- `hookSpecificOutput.updatedInput` rewrites tool input (since 2.0.10) and replaces the whole input object, so the full original `Agent` input must be returned with `model` changed. `permissionDecision: "allow"` plus `updatedInput` runs with no dialog; deny and ask rules still apply; rules are checked against the rewritten input.
- Since 2.1.300 unknown keys are dropped and input the tool rejects denies the call: return only valid `Agent` fields and test the exact value.
- `additionalContext` is supported in `PreToolUse` output and reaches the model as a system reminder next to the tool result (cap 10,000 characters).
- Stdin carries `session_id`, `transcript_path`, `permission_mode`, `tool_name`, `tool_input`. `transcript_path` is written asynchronously and may lag the current turn, so reading the user's chat Yes from it is unreliable.
- Native alternative: in the interactive dialog, "No" with a typed comment sends the comment to the assistant as the denial reason and Claude continues; "No" without a comment stops the turn. No hook can turn a plain No into "continue".
- Unverified: how a hook-set `model` interacts with agent front matter and `CLAUDE_CODE_SUBAGENT_MODEL`; whether `allow` plus `updatedInput` on `Agent` avoids the auto-mode denial ("a hook changed this call's input after auto mode reviewed it").

Consequences for Option A:

- Feasible: clamp with `allow` plus `updatedInput`, no dialog, and `additionalContext` telling the assistant to ask in chat.
- The Yes path needs a different trusted signal than the transcript: an explicit instruction in the user's current prompt (5.1 parser), with a best-effort transcript scan as a bonus, and a rule that when approval cannot be confirmed the hook clamps again rather than loops (the assistant then says so and the user types "use opus").
- A live test is required before release: clamp an `opus` call on a Sonnet session, confirm the agent starts on sonnet with no dialog, and repeat in auto mode.

### 15.2 Live test result (run 2026-11-12, Claude Code 2.1.322, headless, isolated settings; verified from `modelUsage`)

Throwaway hook (scratchpad, not in the repo): on an `Agent` call with `model: "opus"` it returned `permissionDecision: "allow"`, `updatedInput` (full input, `model` set to `sonnet`) and `additionalContext`. Runs used `claude -p --model sonnet --setting-sources project`, so no Jev plugin was loaded.

| Run | Permission mode | Hook | Models used |
| --- | --- | --- | --- |
| Control | default | none | `claude-opus-5-5` and `claude-sonnet-5-5` |
| Clamp | default | clamp | `claude-sonnet-5-5` only, no permission denials |
| Clamp | auto | clamp | `claude-sonnet-5-5` only, no permission denials; hook saw `permission_mode: "auto"` |

- Confirmed: a `PreToolUse` hook can rewrite an `Agent` call's `model` with `updatedInput`; the harness uses the rewritten model, including in auto mode.
- Stdin carried `session_id`, `transcript_path`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`, `effort`, `prompt_id`.
- Not tested: that the assistant read and acted on the `additionalContext` text (the test prompt did not depend on it); a dialog in an interactive session (the runs used `--allowedTools Agent` / auto, so no dialog would have appeared either way); agent front-matter models; `CLAUDE_CODE_SUBAGENT_MODEL`.
- Verdict: Option A is workable. Build it as planned (task #6), with an interactive check after install.

## 16. WS2 result: Jev 2.3.3 (2026-11-12)

Branch `fix/jev-2-3-3-backport`, 5 commits over the audit branch (`c12387f`, `4188559`, `25ba1f8`, `cd5c86c`, `fa2fc06`), in a temporary worktree; not pushed. Verified by the orchestrator: `bun test` 583 pass, 18 skip, 5 fail (the 5 baseline failures), `tsc --noEmit` exit 0, branch not on `origin`.

Release numbering changed: 2.3.3 (done), **2.3.4 elevation clamp** (section 15, in progress, branch `fix/jev-2-3-4-elevation`), **2.3.5 additive batch schema** (5.3, 5.4, 5.11 tool output; formerly "2.3.4").

Skipped parity cases (marked `it.skip` with a reason): 2.3.5 (rubric, staged reminder, batch `needsEdit: false`, 11 dispatch-harness cases); 2 cases about `resolveEditCapableSubagent` outside Claude Code need a decision (see below); not portable cases were left out by the audit.

Review points reported by the implementing agent (not yet reviewed by a second model):

1. 5.9: a sonnet session plus a pro recommendation advises opus with approval (`mode-guard`), following #22's test, not capped at sonnet as the brief said. Two older assertions were updated.
2. Behaviour changes by design in existing tests: a named haiku on a pro recommendation gives sonnet (one-step cap); an opus session plus a pro recommendation is the standing rule, no approval; "You asked for opus" wording; pre-flight tests now use a Workflow or staged turn; `hasRecentDispatch` lines carry `harness: 'claude-code'`.
3. Log keys: `session_id` added next to `session`; turn state gets `mode`, `at`, `staged`, `rec.by`; `user_intent` stored without the phrase (no prompt text).
4. `hasRecentDispatch` ignores dispatch lines without a `harness` field (older telemetry no longer counts); window 30 minutes; 10 minutes for reminded and agent-call counts.
5. "Third Agent call" counts this session's `agent_call` records via a new optional `recentAgentCalls` dependency.
6. `detectActiveHarness` already checks Claude markers before OpenCode ones, as #22 does; no change. The warn-only env notice is one `env_notice` field on the prompt log (names, never values).
7. `PreToolUse` matcher now includes `Workflow`; whether Claude Code fires it for workflow agents is unverified. Workflow calls are never gated (no model).
8. The process-level flush test passes even without the flush on bun 1.4.3; the unit tests are what would fail.
9. Decision needed: `resolveEditCapableSubagent` outside Claude Code: #22 keeps the persona, the 2.3.1 test says it falls back to `self`. Left unchanged.
10. Not verified: a live run inside Claude Code; the installed plugin was not touched.

## 17. Opus review, PR #38 and cognitive-engine cross-check (2026-11-12)

- PR #38 (Jev 2.3.3) opened from `fix/jev-2-3-3-backport` (9 commits over `origin/main`), review requested from Doc-Cr. Tests 623 pass, 18 skip, 5 fail (same 5 as `main`), `tsc` exit 0, verified by the orchestrator. The single highest-tier review found 5 should-fix items and several nits, all fixed on the branch (directive no longer promises a guard prompt for a named model; prose false positives in the intent parser; remove, modify, patch, amend and create-file kept as edit verbs; existing state files tightened to 0700/0600; 5.9 advice kept capped at the session model until the clamp ships).
- Release order: 2.3.3 (PR #38) then 2.3.4 elevation clamp (stacked, being rebased) then 2.3.5 (5.3, 5.4, 5.11 tool output).
- Cognitive-engine cross-check (reported by ce-research, who ran `parseUserIntent` and read `packages/jev`): the same four defects apply there (directive premise changes with the clamp; parser prose false positives; state-file modes apply only on creation; edit verbs narrowed, safe only where `needsEdit` wins). Extra finding there: `core/telemetry.ts` sets no file mode at all. Cognitive-engine docs carry the audit and corrections (`78ca1a8`); no code changes there, per the "plugins first" decision.

### 17.1 Backlog for 2.3.5 and later (from the review, not in PR #38)

- `jev_telemetry.jsonl` (`~/.gemini/antigravity-cli/`, written by `src/core/telemetry.ts` and `src/tools/dispatch.ts:331`) is 0644 and holds `task.slice(0,100)` prompt text: set 0600 and consider dropping the prompt text. Unverified for the agentic-hub copy beyond the reviewer's reading of this machine's files.
- Free-tier guard in `jev_batch_dispatch` uses `needsEdit` only, so a wording-only edit stage ("Remove the stale files") can still be routed to `jev_execute_free`, which cannot edit: use `editsFiles` in both places (cognitive-engine #22 fix, Doc-Cr review).
- `resolveEditCapableSubagent` outside Claude Code: decide fallback to `self` versus keeping the persona.
- Interactive check of the 2.3.4 elevation flow after install; Antigravity `define_subagent` bypass (section 12); whether Claude Code fires `PreToolUse` for `Workflow` agents (unverified since 2.3.3).
- The 5 baseline test failures (real `~/.agents` personas and `~/.config/jev` leak into the tests): make the tests hermetic.

## 18. Status 2026-11-12 (late): 2.3.3 merged, 2.3.4 reviewed, clarified next steps

- PR #38 (Jev 2.3.3) was merged by the owner as a rebase merge (tip `f57f6a8`); the shared checkout was fast-forwarded to it (installed version 2.3.3 after `claude plugin update jev@agentic-hub`).
- Highest-tier review of 2.3.4 (elevation clamp, commit `1de1173`): verdict "ship after fixes", no blocker. Verified by probes: 6 parallel hooks on one prompt give exactly 1 clamp and 5 asks; path traversal in `prompt_id` is neutralised; invalid stdin exits 0 with no output; clamp keeps every original field. Should-fix items:
  1. The ask reason claims "the earlier run on <model> has already happened" on paths where no clamp happened (claim store failed, no prompt key, parallel calls, different task): only say it when a clamp ran for the same `subagent_type` and description.
  2. What No does is misstated across the reason, SKILL.md and plan 15.1: per the docs a plain No stops the turn; a typed comment with No lets the assistant continue.
  3. The clamp target is an alias, so with `ANTHROPIC_DEFAULT_*_MODEL` remapped it can resolve to a different or stronger model: ask instead of clamping when a remap is set for the session alias.
  4. A loop: uncapped advice makes the assistant request opus on every pro-rated prompt on a sonnet session, the call is clamped, the clamp note invites a second call, which opens the dialog, so a yes runs the task twice. Fix: keep the advice capped at the session model (as in 2.3.3) and make the note say "report the result and ask the user in chat; a reply naming opus passes".
- Reviewer nits kept as notes: fail-open on crash or timeout (README wording), instruction check widened from equal to at-least (kept, a named stronger model covers a weaker one), stale intent on host-injected turns (fix: store `prompt_id` in the turn state and require a match), front-matter `model` on a call with no `model` is never seen (README note), marker replacement wording.
- Not verified: real dialog on the second call and what a plain No does; whether the assistant follows the clamp note; front-matter `model` and `CLAUDE_CODE_SUBAGENT_MODEL` against the rewritten model; hook "ask" under auto and bypass modes; whether task notifications get a new `prompt_id`.

### 18.1 Clarified decisions (user, 2026-11-12)

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Review of 2.3.4 | Opus review of the 2.3.4 diff only (done, see above) |
| 2 | 2.3.4 PR timing | Opened when the review fixes are in; against `main` now that #38 is merged |
| 3 | Where this plan lives | In the 2.3.4 PR (user choice) |
| 4 | Telemetry privacy fix | Own patch, 2.3.5 (branch `fix/jev-telemetry-privacy`, started); the batch rubric, `kind`/`needsEdit`, 5.11 tool output and the `editsFiles` guard become 2.3.6 |
| 5 | Interactive elevation check | Before merge, by the user with `claude --plugin-dir <2.3.4 worktree>/plugins/jev`: launch `Agent` on opus with no instruction (expect: runs on the session model, no dialog), then again in the same prompt (expect: dialog; a No with a typed comment lets the assistant continue) |

Release order: 2.3.3 (merged) then 2.3.4 clamp then 2.3.5 telemetry privacy then 2.3.6 batch schema. Version bumps and release notes for 2.3.5 are done at merge time to avoid conflicts.

## 19. Doc-Cr post-merge review of PR #38 (2026-11-12, reported from the PR; probe results are Doc-Cr's)

- Should fix (also in 2.3.2 and in cognitive-engine `packages/jev/src/advisor-logic.ts`): a typographic apostrophe (U+2019) defeats the negators. "Don’t use opus for this, refactor the parser." gives `models: ["opus"]` and the guard lifts its ask, while the ASCII apostrophe and "Do not use opus" give `[]` and ask. Fix: normalise `[‘’]` to `'` at the top of `parseUserIntent` and in `taskNeedsEdit` (`NEGATED_EDIT`), with the U+2019 row as a test. Assigned to the 2.3.4 branch (item 9).
- Gate run by Doc-Cr (`oven/bun:1`, bun 1.4.4, no network, clean HOME): `tsc --noEmit` exit 0 on both the base and the merge; `bun test` 625 pass, 18 skip, 1 fail on the merge. The one failure is `commit-script.test.ts` (no `git` in that image). The 5 baseline failures do not reproduce with a clean HOME, which supports the reading that the real `~/.agents` and `~/.config/jev` leak into the tests. Suggested a test preload pointing HOME at a temp directory: assigned to the 2.3.5 branch.
- Checked and fine: `telemetryHarness()` (the MCP server processes carry `CLAUDECODE` and `CLAUDE_PROJECT_DIR`), telemetry flush bounded at 1 s, `tailLines` partial-record handling, `concurrencyCap` fallback.
- Nits: stale `PRIVATE_DIR_MODE` comment (2.3.5 branch); the PR body said status turns get "no Jev call", but `isStatusTurn` runs after `deps.dispatch`, so only host-injected turns and pastes over 20,000 characters skip the call (README wording, 2.3.4 branch item 10); the review request and the merge were 12 minutes apart (process note).
- Not run by Doc-Cr: a live session with the hook installed; whether `Workflow` fires the matcher.

## 20. Headless check of the 2.3.4 plugin build (2026-11-12, verified from `modelUsage` and the decisions log)

Run as the real plugin via `claude -p --plugin-dir <worktree>/plugins/jev` with the installed `jev@agentic-hub` disabled (`enabledPlugins`), session model sonnet seeded. Clamp: ran on sonnet only, assistant followed the note and did not retry. Repeat in the same prompt: `asked` (denied headless). Prompt "Use opus.": `instructed`, ran on opus. Result posted on PR #41.

Open: the rendered dialog and plain No versus No with a typed comment (needs a person in an interactive session); the session model is `null` in headless runs because `SessionStart` did not store it, so the guard is off whenever the session model is unknown (fail-open, also in 2.3.2 and 2.3.3): follow-up to learn the model from another event; `--plugin-dir` does not override an installed plugin of the same name.

## 21. New requirements from the interactive test (user, 2026-11-12)

- **Interactive finding (verified from the decisions log, user's session `be8a1bda`):** the clamp restarts on every new prompt (a background agent's completion notification starts a new prompt with its own `prompt_id`), so both opus calls in B1 and B2 were clamped and no dialog appeared. The default in PR #41 was changed to "always the dialog", with the clamp opt-in (`JEV_ELEVATION=clamp`).
- **Requirement 1 (elevation choice):** when an agent or subagent tries to elevate, or Jev suggests elevation (model or effort), the user wants two choices, "Yes, proceed on the elevated model/effort" and "No, proceed without elevation", and never "No, stop the turn". Claude Code's permission dialog cannot do that (a plain No rejects the call and stops the turn).
- **Verified (headless, throwaway hook, Claude Code 2.1.322):** a `PreToolUse` hook `deny` with a reason does NOT stop the turn: the assistant received the reason, did not launch the agent, and asked the user in chat (3 turns, no opus used). So a deny-then-choose flow is possible; the open part is how the hook learns the user's Yes safely (the assistant's chat question is untrusted; candidate: a `PostToolUse` hook on `AskUserQuestion` writes an approval marker from the user's actual answer; docs check running).
- **Requirement 2 (downgrade evaluation):** Jev should evaluate whether lower models than the session model would do the work, for example sonnet 5 instead of sonnet 5.5, or haiku. Today the hook only guards upward, `modelRank` ignores versions, and the per-stage rubric (mechanical to haiku, settled edit to sonnet, judgement to opus) is only planned for 2.3.6. Open: whether `Agent` accepts full model ids such as `claude-sonnet-5`, whether a downgrade is applied automatically or offered as a choice, and effort levels (the hook can only gate the model; effort is advisory).
- Next: a short `/clarify` on these two once the docs result is in; PR #41 stays open (do not merge) until the elevation design is settled.

### 21.1 Docs check and diagnostic result (2026-11-12)

- Docs (reported by a docs-lookup agent): a hook `deny` shows the model the reason (turn continues, inferred from the documented `continueOnBlock` equivalence and confirmed by the headless test above); no documented way for a hook to present its own Yes/No picker; the permission dialog's No stops the turn unless a comment is typed.
- Diagnostic (verified from the user's interactive session `jev-test-2`, `permission_mode: auto`, log of a throwaway hook): `PostToolUse` fires for `AskUserQuestion` after the user picks; `tool_response.answers` and `tool_input.answers` both map the question text to the chosen option label, e.g. `"Run the delegation on opus?": "Yes, proceed on opus"`; the stdin also carries `session_id`, `prompt_id`, `transcript_path`, `permission_mode`.
- Consequence: the elevation choice flow is buildable: `PreToolUse` deny with a prescribed question, a `PostToolUse` hook on `AskUserQuestion` records the user's actual answer as an approval marker, the retried call is allowed or not.
- Not verified: how Claude Code treats a hook `ask` dialog in `auto` mode (the user's default mode); the `PostToolUse` record for a multi-select or "Other" answer.

## 22. Clarified design: elevation choice and downgrade evaluation (user, 2026-11-12)

Verified facts behind it: a hook `deny` keeps the turn going (headless test); `PostToolUse` on `AskUserQuestion` fires with `tool_response.answers` mapping question text to the chosen option label (user's interactive session, section 21.1); the `Agent` tool's `model` parameter accepts only the aliases `sonnet`, `opus`, `haiku`, `fable` (`InputValidationError: Invalid option: expected one of "sonnet"|"opus"|"haiku"|"fable"` for `claude-haiku-5-5`, `claude-sonnet-5`, `claude-sonnet-4-5`, `haiku-5`, headless, Claude Code 2.1.322).

| # | Decision |
| --- | --- |
| 1 | PR #41 (2.3.4: intent fixes, clearer dialog, opt-in clamp) is merged after review; the choice flow is 2.3.5; telemetry privacy becomes 2.3.6; batch schema 2.3.7 |
| 2 | Approval scope: per model, with a choice question of four options: Yes once (one launch, 10 minutes to use it), Yes for the next 5 minutes, Yes for this session, No (this launch runs on the session model, the turn continues, the next elevation asks again). An approval covers the approved model and anything below it |
| 3 | If the assistant does not ask the prescribed question: deny twice with the question format, then open the permission dialog on the third elevating attempt in the same prompt (backstop; its No stops the turn) |
| 4 | Downgrade: offered as a choice, evaluating all available lower models with versions: the router picks the cheapest sufficient step from a version-aware ladder, the question lists the recommended model, up to two alternatives and "No, keep the session model"; approval applies to that call; a standing preference (ask, auto, off) lives in config |
| 5 | Effort: advisory text in the question and the turn directive; logged as `effort_suggested` next to `effort_session`; not enforced (a hook cannot set effort) |

Constraint found after decision 4: because the `Agent` call accepts only aliases, a version step inside one alias (sonnet 5 versus 5.5) cannot be chosen per call. Options to be settled before building the ladder: (a) alias-level ladder only in 2.3.5 (haiku, sonnet, opus, fable), with versions left to session-level settings; (b) route through a subagent definition whose front matter sets a full model id (unverified that front matter accepts one); (c) set per-session remaps via `ANTHROPIC_DEFAULT_*_MODEL` (session-start only, not per call).

Workstreams (Sonnet unless noted, each in its own temporary worktree, after #41 merges): hook flow (deny, question prescription, `PostToolUse` recorder, approval store, backstop dialog); router ladder and evaluation (advice text, log fields); tests and docs; one highest-tier review, then the user's interactive check.

### 22.1 Version routes tested (headless, Claude Code 2.1.322, Jev disabled; verified from `modelUsage`)

| Route | Result |
| --- | --- |
| Subagent definition with `model: haiku` (alias) in front matter | ran on `claude-haiku-5-5` |
| Subagent definition with `model: claude-haiku-5-5` (full id) | ran on `claude-haiku-5-5` |
| Subagent definition with `model: claude-sonnet-5` (an older sonnet) | ran on `claude-sonnet-5` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5`, `Agent` with `model: sonnet` | ran on `claude-sonnet-5` (the control without the env var ran on `claude-sonnet-5-5`) |
| `Agent` call with a full id (`model: claude-haiku-5-5`, `claude-sonnet-5`, `claude-sonnet-4-5`, `haiku-5`) | rejected by input validation, only `sonnet`, `opus`, `haiku`, `fable` are accepted |

Consequences: a version-aware ladder is possible through definitions that pin a full model id in front matter (the call selects a definition, not a model), or through a session-level remap (not per call). Proposed: the plugin ships a small set of ladder definitions (general-purpose clones, one per ladder step); the hook can only select one by rewriting `subagent_type`, which replaces the original type's persona, so version-precise downgrades apply to `general-purpose` calls and other types stay at alias level. Not tested: whether a plugin-shipped agent definition accepts a full id the same way, what happens to a definition's tool access when substituted for a built-in type, and the set of model ids available on the user's account (the ladder must come from config, not from a hard-coded list).

### 22.2 The three open points, tested (headless, Claude Code 2.1.322, Jev disabled, 2026-11-12; verified from `modelUsage` and the agents' own reports)

1. **Plugin-shipped definition with a full model id: works.** A throwaway plugin (`--plugin-dir`) with `agents/ladder-sonnet5.md` (`model: claude-sonnet-5`) was launched as `subagent_type ladder-test:ladder-sonnet5`; usage shows `claude-sonnet-5`. The agent is addressed as `<plugin>:<name>`.
2. **Tool access of a substituted definition.**
   - A definition with no `tools` field inherits the full tool set (the agent listed Agent, Bash, Edit, Read, Skill, ToolSearch, Write and more; Bash and Write both worked and the file was created).
   - A definition with `tools: Read` is restricted (Bash unavailable, Read worked).
   - So a ladder definition without `tools` behaves like `general-purpose`; substituting it for a more restricted built-in type (for example a read-only explorer or planner) would widen that agent's tools. Version-precise downgrades therefore apply to `general-purpose` calls only, or each restricted type gets its own ladder family with a matching `tools` list.
3. **Which model ids the account can use** (probe: `claude -p --model <id> "Reply OK"`, then the id in `modelUsage`):
   - Available: `claude-haiku-5-5`, `claude-haiku-4-5`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-4-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-5`, `claude-fable-5-2`. Aliases resolve to `haiku` = `claude-haiku-5-5`, `sonnet` = `claude-sonnet-5-5`, `opus` = `claude-opus-5-5`, `fable` = `claude-fable-5-2`.
   - Not available: `claude-haiku-5`, `claude-sonnet-4`.
   - Caveat: the user's standing rule says a `fable` request is silently served by another model on this plan; the probe shows `claude-fable-5-2` in `modelUsage`, which contradicts it. Not investigated further; treat as unverified.
   - Cost of the probe: about 15 one-word calls, a few tens of cents at most (the larger models cost more because of the cached system prompt, not the answer).

Design consequence: the ladder comes from `~/.config/jev/models.json`, written by an explicit probe command (`jev models probe`) and refreshed on demand; the plugin ships only alias-level defaults and a few `general-purpose` ladder definitions for the ids found by the probe (generated, not hard-coded). Ordering and capability tiers per id stay in config (the router rates a task; the ladder says which step is cheapest and sufficient).

## 23. Clarified design: model catalogue and aliasing (user, 2026-11-12)

Grounding (verified in the code): today a static tier-to-model map per harness (`harnesses.<h>.models`: free, cheap, standard, deep; Claude Code uses the aliases `haiku`, `sonnet`, `opus`, OpenCode uses OpenRouter "latest" names) and a regex rank list in `claude/logic.ts` that knows families but not versions. Nothing updates automatically.

| # | Decision |
| --- | --- |
| 1 | Discovery: a discoverer per harness, results in a cached file `~/.config/jev/models/<harness>.json`. Claude Code: an on-demand probe over a candidate list (`claude -p --model <id>` with isolated settings and Jev disabled, so no recursion); OpenCode: the OpenRouter models list; Antigravity: its known config. Hooks read only the cache, never the network. Periodic refresh from a `SessionStart` hook (detached background process, lock file, atomic write, hard cap on probe calls, off when Jev mode is off, opt-out in config), a manual `/jev-refresh` skill, and a warning with a refresh hint when a suggested model is not in the catalogue |
| 2 | Naming: stable capability tiers (free, cheap, standard, deep) in the router; the catalogue maps each tier, per harness, to an ordered list of concrete ids plus the native alias where one exists; latest is resolved at refresh; pins in config override |
| 3 | Ordering: tier from the family name (haiku cheap, sonnet standard, opus and fable deep), order inside a tier from the version number; config can pin or override any id; an unknown family goes to a needs-review list and a warning and is not used |
| 4 | Refresh: time-based (default 7 days, at `SessionStart`) plus failure-triggered (model-not-found or an unknown suggested id marks the id suspect and starts a refresh), manual `/jev-refresh`. A failing id is skipped at once and deleted after three consecutive failed probes |
| 5 | Hook failure behaviour: missing or corrupt cache uses the shipped alias defaults and says "run /jev-refresh"; a stale cache (older than three times the interval) is used with one warning per session; an unknown id is treated as unranked (the elevation guard asks, the downgrade logic ignores it); never blocks |

Open, to settle during the build: the candidate list for the Claude Code probe (families and versions Jev knows, user additions in config); the probe's cost cap per refresh; how the OpenCode and Antigravity discoverers map their lists to tiers; the interaction with the ladder definitions from section 22.2 (generated from the catalogue for `general-purpose`).

Release: part of 2.3.5 with the choice flow (sections 22 and 22.1), or split as 2.3.5 (choice flow) and 2.3.6 (catalogue), to be decided at the build; telemetry privacy and the batch schema move accordingly.

## 24. Status 2026-11-13: sections 20 to 23 built, in review

Release routes were decided as split releases (the open choice at the end of section 23). Four stacked PRs, merge in this order; each is based on the one before and GitHub retargets to `main` as they merge. Doc-Cr is requested as reviewer on each.

| PR | Version | Content |
| --- | --- | --- |
| #43 | 2.3.5 | Telemetry privacy (0600 files, no prompt text) and hermetic tests |
| #44 | 2.3.6 | Elevation choice flow (section 22): deny with a prescribed question, PostToolUse recorder, per-delegation counter, dialog backstop |
| #45 | 2.3.7 | Model catalogue and background refresh (section 23): catalogue core, discoverers, `jev-models` CLI, `/jev-refresh`; not read by the hooks yet |
| #46 | 2.3.8 | Downgrade choice (section 22) and catalogue-backed ranking; `ladder-agents` with `--max-tier` |

Gate: one Opus review of the combined diff (the user's choice in section 22) found 8 issues and no crash, invalid-JSON or endless-deny path. All are fixed: fable ranked below opus under a catalogue (classifyElevation and claimApproval now rank by family first), the generated `jev-ladder-<opus|fable>` agents bypassed the ceiling (a launch with no `model` is now checked against the pinned id), the attempt counter was per prompt instead of per delegation, a No to an elevation was followed by a downgrade question, free text from a downgrade answer was stored, an alias was lost in a probe merge, and two stale comments.

Unverified until an interactive session: that the assistant follows the prescribed questions, the real dialog behaviour on No, the hook's effort field shape, plugin-qualified ladder agent names, a refresh on an account that serves `fable`, and the Antigravity discoverer and `define_subagent` model bypass (section 12).

Next: the batch schema (5.3 rubric, 5.4 kind and `needsEdit`, 5.11 tool output, `editsFiles`) as 2.3.9, after the stack merges.

## 25. Verification results (2026-11-13, Claude Code 2.1.323, Claude Pro account)

**Headless (reported by a Sonnet agent, tree = #46 branch, installed jev disabled; evidence from `modelUsage`, the decisions log and stream-json; about $1.45 spent).**

| Check | Result |
| --- | --- |
| H1 choice deny | Pass for the deny: an opus call in a sonnet session is denied, the reason prescribes the `[jev-elevate:opus]` question with the four labels, the turn goes on. The ask itself is untestable headless: `AskUserQuestion` does not exist in `claude -p` (the reason now says to launch on the session model when it is unavailable). |
| H2 recorder | Pass with the recorded fixture. An answer only in `tool_input`, an approval for a model never denied, and an approval with no denial record nothing. |
| H3 downgrade | Pass, run directly with a seeded turn (live rating did not recommend a cheaper model): deny with `[jev-downgrade:haiku]`, retry passes, a No answer lets the relaunch pass, `auto` rewrites to haiku, `off` does nothing. |
| H4 ladder agents | Pass: `jev-ladder-claude-sonnet-5` ran on `claude-sonnet-5` (modelUsage); `jev-ladder-claude-opus-5-5` is denied in a sonnet session; `--max-tier standard` writes no deep agents. Project agents are bare `jev-ladder-<id>`; a plugin-shipped one is `<plugin>:<name>` and the hook handles both. |
| H5 refresh | Pass: 8 models probed, aliases resolved (haiku 5-5, sonnet 5-5, opus 5-5, fable 5-2), ranking follows the family ladder, no stray directories or processes. |
| H6 hook timing | Pass: pre-tool-use about 26 ms, user-prompt-submit about 262 ms, the refresh starts only at `SessionStart` and detached. |

Findings fixed from it (PRs #45 and #46): the refresh probe cost about $0.015 to $0.03 each because it loaded the user's plugins and MCP servers; with an empty MCP config, no tools, no slash commands, plugins off and a one-line system prompt it is about 600 input tokens and about 84% cheaper. The downgrade recorder read `tool_input`; `planDowngrade` used the raw catalogue order (so fable asked with opus recommended never offered the downgrade).

**Interactive (the user, session `jev-test-3`, sonnet session, `--plugin-dir` on the #46 tree; verified from the Jev decisions log and the session and subagent transcripts).**

- Choice flow, No: an opus call was denied, the assistant asked the prescribed question (four labels), the user chose "No, proceed on sonnet", the subagent ran on `claude-sonnet-5-5`, the turn did not stop and no second question followed (an `elevation declined` entry was recorded).
- Choice flow, Yes for 5 minutes: denied, asked, approved; the subagent ran on `claude-opus-5-5`, and a second opus call inside the window passed with no question (decisions log `elevation: approved`, `approval_scope: 5min`).
- Downgrade, live: not exercised, because Jev rated the task `flash` (sonnet), the same as the session model. Needs a session above the recommendation (for example an opus session and a trivial task).

Still unverified: the live downgrade question, a refresh on an account that serves `fable`, the Antigravity discoverer and `define_subagent` model bypass (section 12). Open design point: an Agent call with no `model` is never evaluated for downgrade.

## 26. Downgrade design (decided with the user via /clarify, 2026-11-13) and status

Why it was reworked: in the interactive test of section 25 the downgrade question never appeared. The first implementation rated the user's prompt once per turn as a single winning tier and asked only when an explicit Agent alias was above it; the router returns per-tier probabilities that it did not use, and calls with no model, `self` ratings and same-alias version steps were never evaluated.

| # | Decision |
| --- | --- |
| 1 | Rate each delegation: `PreToolUse` on `Agent` sends the call's own description and the first 1000 characters of its prompt to the router (about 280 ms, fail-open, cached per call signature for 10 minutes; only length and hash logged) |
| 2 | Needed tier: the cheapest tier whose cumulative probability reaches 0.6 (config `models.downgrade.minProbability`, env `JEV_DOWNGRADE_MIN_PROBABILITY`, clamped 0.5 to 0.95). Calibrated on 12 delegations with the real router: no hard task was offered haiku at any threshold from 0.5 to 0.9 |
| 3 | Version steps: offered only when strictly cheaper by list price. Facts behind it: in this lineup older versions are never cheaper (haiku 5.5 $0.10/$0.50 vs 4.5 $1/$5; sonnet 5.5 and 5 both $2/$10, 4.5 $3/$15; opus 5.5 $4/$20 vs 5 and 4.5 $5/$25; fable 5.2 $8/$40 vs 5 $10/$50). Prices are recorded in the catalogue from the OpenRouter list; list price is a proxy because the user's cost is subscription quota |
| 4 | Coverage: every delegation, including calls with no model (judged against the session model), `self` ratings and restricted subagent types (alias level only) |
| 5 | Ask at the call only (the turn directive no longer offers downgrades); answer remembered per call signature for 10 minutes |
| 6 | Default mode `ask`, with a "No, and don't ask again this session" answer that writes a session-scoped off |

Verified: the real hook process denies a trivial delegation with the question in a seeded sonnet session; interactive session `jevt-test-4` (verified from the Jev state file, decisions log and transcripts): the question with evidence, both list prices and the advisory effort appeared, "Yes, haiku" ran the subagent on `claude-haiku-5-5` and the relaunch passed with no second question, "don't ask again" skipped the next delegation, a hard task got no downgrade question. A model-less delegation was not produced by the assistant live (covered by unit and end-to-end tests and a direct hook run).

Shipped: PRs #43 (2.3.5), #44 (2.3.6), #45 (2.3.7) and #46 (2.3.8) are merged; `main` is 2.3.8. Doc-Cr round 2 on #45 and #46 (probe env without `ANTHROPIC_API_KEY` unless `models.refresh.useApiKey`, tests never start refreshes, ask mode skips a remapped alias) is applied. #48 is the 2.3.9 batch schema. Open: whether the batch schema gets its own highest-tier review; the two skipped persona parity cases; the Antigravity `define_subagent` bypass and `fable` refresh remain unverified.

## 27. Antigravity: `invoke_subagent` guard and the `define_subagent` question (2026-11-13)

**Workflow (Claude Code), verified and tracked separately.** Agents launched by the `Workflow` tool do not pass through `PreToolUse` (live probe, Claude Code 2.1.323, Jev 2.3.8: a one-agent workflow asking for `model: 'sonnet'` ran with no decision-log entry). cognitive-engine already built the answer (`packages/jev/src/workflow-guard.ts` and `workflow-pin.ts`, acorn, fail-closed; merged there via #18, #20, #22); the agentic-hub port is the "workflow guard" PR after 2.3.10.

**Antigravity findings (reported by a Sonnet agent; agy 1.5.8, temp project, `--sandbox`, session `gemini-3.8-flash-low`, about 6 short flash runs; evidence is stated per line).**

| Finding | Evidence |
| --- | --- |
| Jev's Antigravity tier ceiling is advisory text only: `clampTierToSessionCeiling` (`src/core/governance.ts:327-364`) shapes what `jev_dispatch` and `jev_batch_dispatch` return; nothing intercepts the later `invoke_subagent` call | code reading |
| agentic-hub ships no Antigravity hook (`plugin.json` registers only `./claude/hooks.json`); `rules/AGENTS.md:20` and `skills/jev/SKILL.md:108` cite `jev-pre-tool.sh`, which is not in this repo; the only copy is in doppelganger (`.agents/hooks/jev-pre-tool.sh`) | code reading |
| That hook matches only `invoke_subagent`, reads `.toolCall.args.Subagents[].Model` with `(.Model // "")`, and lets an empty Model through unless quota is at or below 25% | script reading |
| The real `invoke_subagent` schema is flat (`TypeName`, `Role`, `Prompt`, `Workspace`, `Model` enum `inherit`/`flash_lite`/`flash`/`pro`, default inherit) with no `Subagents` array, so that hook probably sees an empty list and allows everything, `pro` included. Not run against a live call | live schema, reported; hook not run |
| `define_subagent` has no Model parameter (Name, Description, SystemPrompt, EnableMCPTools, EnableSubagentTools, EnableWriteTools); `model:` front matter in an `agent.md` is not a supported field (`--agent` with `model: flash` or `flash_lite` front matter answered on the session model) | live, weak evidence for the front matter |
| File definitions load only as `.agents/agents/<name>/agent.md` plus an `agents.json` entry `{"agents":[{"path":"agents"}]}`; a flat `<name>.md` is not discovered | live |
| A subagent invoked with Model omitted ran on a different model enum (`MODEL_PLACEHOLDER_M198`) than the session (`M320`); whether that is Antigravity's default for an omitted Model or something else is **not settled**: the control was blocked by the auto-mode classifier | live, inconclusive |

**Verdict.** The original question ("does Antigravity apply a definition's model when the invoke call leaves it empty") is moot in the form asked, because a definition carries no model. The real gap is wider: agentic-hub has no guard on `invoke_subagent` at all, and an omitted or `inherit` Model may run on a model other than the session model.

**Planned work (a later stacked PR, "Antigravity hook").** An Antigravity `PreToolUse` hook for `invoke_subagent`, registered like `claude/hooks.json`: read the flat `args.Model` (and `args.Subagents[].Model` for older shapes); treat omitted and `inherit` as the session model (`active_model` in `quota-state.json`, resolved by the existing ceiling helpers); apply the existing tier-rank check from `governance.ts`; deny or ask for a model above the ceiling with the Yes/No choice the Claude flow uses where the harness allows it. Do not read a model from definition front matter. Test against the real payload shape recorded from agy, not the shape the doppelganger hook assumes.

**Control to include in that work (the evaluation by agy).** Before and with the hook, run the four-call control in a fresh temp project with `--sandbox` and the cheapest model, and record the subagent's generation-model enum for each: `plain` with Model omitted, a definition with front matter `model: flash` with Model omitted, `plain` with `Model: flash_lite`, `plain` with `Model: flash`. The comparison settles whether an omitted Model follows the session model or a default, and it maps the `M…` enums to tier names (the subagent conversation DB under `~/.gemini/antigravity-cli/conversations/` records the enum). The evaluation also covers the downgrade question: whether a rated-cheap delegation can be offered `flash_lite` through the same prescribed question (`AskUserQuestion` equivalent is `ask_question` there). Needs the user's approval for the live calls, since the classifier blocks them by default.

**Side note for doppelganger.** The `jev-pre-tool.sh` hook there should be re-checked against a recorded real `invoke_subagent` payload; if it reads `Subagents[]` only, it never fires on agy 1.5.8.
