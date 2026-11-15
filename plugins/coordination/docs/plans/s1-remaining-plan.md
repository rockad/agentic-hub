# S1 remaining: workstreams, waves and dynamic workflows (drafted 2026-11-13, decisions Z1 to Z5 recorded 2026-11-14)

Source: `plugins/coordination/docs/plans/implementation-plan.md` sections 3.1, 4.2, 5 (origin/main).
Done: S1-SCAF (PR #32), S1-PG (PR #37), S1-BKP (PR #42), S1-STORE (PR #61), S1-OBS (PR #62); W3a finished 2026-11-15. The user decided Z1 to Z5 on 2026-11-14 and Z6 to Z9 on 2026-11-15 (section 6). Wave W4a (AUTH and STATE) is running; W4b to W6 have not started.

## 1. Remaining streams and their dependencies

| stream | needs | hours | notes |
| --- | --- | --- | --- |
| STORE | SCAF, PG | 16-24 | critical path; creates the migration dir and the `api_keys`/`task_index` schema first |
| OBS | SCAF | 4-6 | edits `app.py` middleware; also owns wiring `dump_age_h` into `/status` (api 3.6) |
| TEST-skel | SCAF | part of 14-22 | main tree, no worktree; reuses SP5 load driver |
| AUTH | STORE schema | 10-16 | `auth/`, `app.py` middleware |
| STATE | STORE | 14-22 | `service/` |
| ADMIN | AUTH, STATE | 12-18 | admin socket, `a2a-coord`; USER tests TTY paths |
| A2A | AUTH, STATE | 16-24 | `/a2a/v1`, card, push |
| MCP | AUTH, STATE | 12-18 | `/mcp` facade |
| ID | MCP | 8-12 | identity, binding, `/sessions` |
| WAKE | ID | 12-18 | wake, pending, budget |
| CLAUDE | WAKE | 6-10 | hooks in `bin/`, `hooks/`; USER runs live checks |
| AGY | ID, WAKE | 6-10 | agy live checks by USER in own agy session; helper never drives agy |
| INST | CLAUDE, AGY, ADMIN | 12-18 | USER runs it; A8c result sets how the plugin is placed |
| SEC | A2A, MCP, WAKE, ADMIN, OBS | 10-16 | sonnet suite, opus adversarial review |
| DOC | INST | 6-10 | |
| TEST (full) | A2A | rest of 14-22 | TCK, e2e; USER for live e2e |
| GATE | SEC, TEST, DOC, BKP, OBS | 6-10 | USER + CC + AGY; opus final verification |

Critical path (from the plan): STORE, STATE, MCP, ID, WAKE, CLAUDE, INST, DOC, GATE.

## 2. Waves (sequence, not time)

- **W3a** STORE alone, plus OBS beside it. STORE goes first because the schema and migration directory are the shared hot spot (`app.py`, `pyproject.toml`, `uv.lock`, migrations). TEST-skel in the main tree.
- **W4a** AUTH + STATE, two worktrees in parallel (different modules). Start only after STORE is merged.
- **W4b** ADMIN + A2A + MCP, three worktrees. Start after AUTH and STATE are merged.
- **W5a** ID, then WAKE (sequential, same session surface).
- **W5b** CLAUDE + AGY in parallel (own files, no worktree). USER live checks follow.
- **W6** INST, DOC, SEC suite, TEST full; then opus review of SEC; then GATE.

Merge rule: one PR per stream to main, user merges ("merge it"), next wave branches from the merged main. Same as S1-PG and S1-BKP.

## 3. Dynamic workflow, one script, reused per wave

`Workflow` scripts are plain JS and take `args`, so one script runs any wave: `args = {wave, streams:[{id, planSection, base}]}`.

Per stream, pipeline (no barrier between streams):
1. **build** (sonnet, `isolation: 'worktree'`): reads the stream section of the plan and the interface protocols from SCAF, builds, runs its own unit tests, commits on `feat/coordination-<id>`. Brief says "do not touch files outside your scope".
2. **check** (separate sonnet, no edit rights beyond throwaway files): re-runs the stream's acceptance list from the plan with throwaway secrets, own project name and port, canary scans with pattern files, a positive control. Returns structured `{criterion, pass, evidence}`.
3. **repair loop** (sonnet, max 2 rounds): only for failed criteria. Still failing after 2 rounds, the stream returns `blocked` and stops; no silent third try.
4. Return `{stream, branch, sha, passed, failed, filesOutsideScope}`; a diff-scope check flags edits outside the stream's files.

Dynamic parts, decided in script code from results, not by a model:
- a stream whose `filesOutsideScope` touches another stream's module is held, not merged;
- STORE reporting a schema change makes the script mark AUTH and STATE `needsRebase` before they start;
- the wave list shrinks to the streams whose dependencies show `passed`.

Orchestrator (this session) after each workflow: read each diff, re-run acceptance myself (as for S1-PG and S1-BKP), `jev_judge` as a weak signal, open the PR, disclose caveats. Agents inside the workflow do not replace that review.

Opus: SEC review only (adversarial, 3 independent skeptics, majority refutes), and the single final verification at GATE. Everything else sonnet. Quota under 20% means ask before any opus.

Size: the session guideline is "under 5 agents" per workflow. One stream is build + check (+ repair) = 2 to 4 agents, so W3a (2 streams) and W4a (2 streams) fit roughly; W4b (3 streams) is about 6 to 9 and exceeds it. Options: run W4b as two workflows, or the user allows more.

## 4. User-bound steps (not automatable)

- ADMIN: TTY paths (`key create`, `review release`) by hand.
- CLAUDE: live hook checks in your Claude sessions.
- AGY: live checks in your own agy session; A8c (staged, waiting on you) decides placement for INST and the health check.
- INST: you run the installer.
- GATE: live sessions with CC and AGY; opus final verification.

## 5. Open items to carry into S1

- `A2A_UID`/`A2A_GID` must match the secret owner (rootless Docker uses 0); `/data` not writable when overridden, so GL-IMPORT needs an answer (before S2).
- `dump_age_h` into `/status`: done by OBS (PR #62, merged 2026-11-15).
- The A8c stub still listens on `127.0.0.1:18120` for the staged A8c run; acceptance runs use another port until A8c cleanup. The A8c result gates the S1-INST placement and the S1-AGY health check.
- User-owned hygiene: restic password file on `<storage-host>` before S2; the history-rewrite window and the GitHub Support purge decision; the attended tests inside S1 (A8c, `asyncRewake`, GUI-launched Claude).
- State-volume dir is mode 0777 so the sidecar can write `last_ok`.
- Non-root `A2A_UID` other than 0 untested under rootless Docker.
- Issues #39 (memory@agentic-hub 1.0.1) and #40 (lookup package visibility) are unrelated but open.

## 6. Decisions of 2026-11-14 (sixth clarify round, Z1 to Z5)

| # | Question | Decision |
| --- | --- | --- |
| Z1 | First wave | W3a: STORE and OBS in parallel, two worktrees (`feat/coordination-store`, `feat/coordination-obs`); TEST-skel in the main tree. |
| Z2 | PR granularity | One PR per stream to `main`, merged on the user's word; the next wave branches from the merged `main`. |
| Z3 | Execution engine | One `Workflow` script reused per wave (section 3). The user's choice counts as the opt-in for the `Workflow` tool. |
| Z4 | Plan PR | Open the docs PR with this plan, the ticked tasklist and the handoff; the user merges it before STORE and OBS start. |
| Z5 | agy side | The user runs A8c now in agy, in parallel with W3a, with the signed-out run last. A helper never drives agy. |

Decided 2026-11-15 (after W3a, STORE PR #61 and OBS PR #62 merged):

| # | Question | Decision |
| --- | --- | --- |
| Z6 | S1-OBS acceptance 3b ("every state transition has exactly one audit row naming its actor") | Ratify the split. OBS keeps the writer half (done, merged). The atomic half (transition and its audit row commit in one transaction; a failed audit insert leaves state and version unchanged and no row) is an exit test of S1-STATE, on the `audit` table STORE built. S1-STATE adds the transaction-joining `append_audit` [design]. S1-SEC and S1-GATE cannot pass without it. |

Decided 2026-11-15 (open items round):

| # | Question | Decision |
| --- | --- | --- |
| Z7 | Secret files for a real stack run | The user provides the database password and `dump_ro` secret files at W6 (INST and GATE); never before. |
| Z8 | W4b agent count | One stream at a time, each branching from the previous merge. Proposed order (critical path first): MCP, A2A, ADMIN [not yet confirmed]. |
| Z9 | Jev PRs #54, #55, #58 | Left alone; not part of this work. |

No question is open now except the W4b order confirmation.
