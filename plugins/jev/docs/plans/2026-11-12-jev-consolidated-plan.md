# Jev consolidated plan (2026-11-12)

Living plan; the latest status is in sections 18 and 19. Sources:

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
