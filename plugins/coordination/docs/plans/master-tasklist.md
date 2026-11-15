# Coordination plugin: master tasklist

This is one of the two live planning documents (the other is [`master-plan.md`](master-plan.md)). It holds how to pick up the work, the status, the milestones, the stream status tables, the todo and the open items for the whole coordination plugin (S0 to S3, go-live and the later tracks). The plan holds the design: stream deliverables and acceptance (plan section 4), decisions (sections 11 and 12), waves and workflow process (section 13). New status goes here; new design goes there; do not add a third planning document.

The full text of the old tasklist (decision records, workstream checklist, every ticked box) is kept as [`../archive/master-tasklist-through-2026-11-14.md`](../archive/master-tasklist-through-2026-11-14.md). Labels: **verified** (read or observed), **reported** (a claim not reproduced), **unverified**. No dates are given for work that has not started. Items marked (user) are user-only: an agent must not do them.

## 0. How to pick up

### 0.1 Start here (copy this into a new Antigravity or Claude Code session)

```
You are continuing the A2A coordination plugin work (repo agentic-hub, folder plugins/coordination). Planning is done and S1 implementation is under way: streams S1-SCAF (PR #32, commit 11f7e0f), S1-PG (PR #37, cff63c9) and S1-BKP (PR #42, c3dd5ad) are merged (2026-11-11 and 2026-11-12), and S1-STORE (PR #61) and S1-OBS (PR #62) since 2026-11-15. Wave W4a (S1-AUTH and S1-STATE) was launched on 2026-11-15: S1-AUTH is built and in PR #65 (open, merge only on the user's word); S1-STATE is built on branch feat/coordination-state (commits 724167d and the repair 42f9fa2, pushed to origin, no PR, the workflow was stopped on 2026-11-15 to save quota: its independent check did not finish, so the repair is unconfirmed, and your review is still to do). The docs were reorganised on 2026-11-15 into two live documents (commit 7db293c). The weekly Claude quota was 95 percent used on 2026-11-15 and resets on 2026-11-20 15:00 (Europe/Helsinki): section 0.7 says how to continue without the original session. The plan is docs/plans/master-plan.md (streams in section 4, waves and workflow in section 13); the status and todo are docs/plans/master-tasklist.md (this file). Check a PR's state with `gh pr view`, not with `git merge-base --is-ancestor`: squash-merged PRs report "not merged" there.
1. Read plugins/coordination/AGENTS.md, docs/README.md, then this file, sections 1 to 5.
2. Verify the state before acting: git fetch; git log --oneline -8 origin/main; git status; gh pr list. Check every claim in a doc against its evidence file. The S1 entry gate is satisfied (2026-11-11, docs/research/spike-results-2026-11-10-sp3-sp4.md); the user approved the S1 kickoff on 2026-11-11 (Y10). The decision tables Y1 to Y10 and Z1 to Z9 are final (master-plan section 12).
3. Work only in your own git worktree: git worktree add ../agentic-hub-wt-<you> -b <branch> origin/main. Never commit in ~/projects/agentic-hub (it is shared with another session) and never touch the worktrees of a running build (agentic-hub-wt-auth, agentic-hub-wt-state). Stage explicit paths only. Never push main, tag or release without the user's go.
4. First action: read section 0.7 (resuming without the original session), then check where W4a (streams AUTH and STATE) stands (gh pr list; read-only git status and git log in the two worktrees). AUTH is PR #65: check its CI and wait for the user's merge word. STATE has two commits on its pushed branch and no PR yet: run its independent check (nobody has confirmed the repair commit), review its diff, re-run its acceptance yourself (section 0.7 lists the checks), and open one PR (no merge without the user's word). The next wave is W4b (decisions Z8 and Z10 to Z15, master-plan 12.3): MCP, then A2A, then ADMIN, one stream at a time on stacked branches, full verification for MCP and A2A and lean for ADMIN; the exact brief is in section 0.7 ("W4b plan"). Nothing about W4b is open for the user except merge words. Tests use throwaway secrets; running the real stack needs two secret files from the user at W6 (database password and dump_ro secret, each mode 0600 and outside the repo; ask for them, never print or create their values). Then take the first unticked item of section 4 that needs no user input. Ask the user before anything marked (user): agy runs, attended tests, the <storage-host> crontab, hygiene items and the other user-only actions.
5. Decisions in the plan's decision tables are final: do not reopen them. Anything the docs leave open stays marked [design] or [unverified]; do not invent it.
6. Label every statement verified, reported or unverified. Never print a secret or a token. Use vertical lists, absolute dates, and the editor's Edit tool for file changes.
7. Never launch, drive or probe the Antigravity CLI (agy) as a helper; the user starts agy and agy answers prompts. In Claude Code, run Jev's pre-flight before delegating non-trivial work.
8. When you finish a step: update sections 1 to 4 of this file (status, milestones, stream tables, todo), commit, then tell the user what changed and what is next. Docs updates go straight to main (user decision, 2026-11-15; no PR for docs); stream code goes one PR per stream.
9. Quota rule (user, 2026-11-15): when a workflow finishes, or when the weekly quota reaches 3 percent remaining (statusline 7d gauge, `~/.cache/claude-quota.json` on <workstation>, or `jev_quota`), stop starting new agents and update sections 0.1, 1, 3.2 and 4.2 with the exact state (branches, shas, uncommitted files, what to run next), then commit to main.
```

### 0.2 Read in this order

1. `plugins/coordination/AGENTS.md` and `README.md` (orientation and rules), then `docs/README.md` (the doc map, section 6).
2. This file, sections 1 to 5.
3. `docs/plans/master-plan.md`: section 4 (the stream you work on), section 13 (waves and the workflow process), sections 11 and 12 (decisions). The full text of decisions D1 to D40 (4, 6, 8, 16, 20, 24, 26 and 37 to 40 matter most), the risks and the open-decision list is in `docs/archive/consolidated-bridge-v2-plan.md`.
4. `docs/specs/spikes.md`: sections 8 and 8b (SP5 and SP5b), section 11 (the S1 entry gate and its status), the A8b and A8c entries.
5. `docs/specs/server-api.md`: 1.2 and 1.4 (storage and compose), 5.2 (handle addressing), 5.4 (session binding), 8.4.1 (public listener), 11 (installer and hooks), 12.2 (S1 design details).
6. Spike evidence under `docs/research/spike-results-*` (especially `spike-results-2026-11-10-sp5b.md`) and the runbooks `spike-runbooks-2026-11-05.md`, `spike-runbook-a8b-*.md`, `spike-runbook-a8c-*.md`. The independent audit of the overnight SP5b work is `docs/research/audit-2026-11-10-sp5b-s1-gate.md` (not rewritten; its findings are applied as C1 to C5, master-plan 11.4).

### 0.3 Environment facts

- **<workstation>** (WSL2 workstation): spikes and dev. Docker, `uv`, `bun` are installed. Scratch ports: stub 18120, SP5 18125 to 18127, SP5b 18130 to 18132 (loopback only). SP5 and SP5b are torn down. The A8c stub on `127.0.0.1:18120` stays up until A8c cleanup, done with the user [reported by the session that staged it; the listening port was checked on 2026-11-15]: S1 acceptance runs must not use port 18120. Rootless Docker needs `A2A_UID=0` and `A2A_GID=0` so the server user matches the secret file owner; with them overridden `/data` is not writable, which GL-IMPORT must answer before S2 (a non-root `A2A_UID` other than 0 is untested under rootless Docker).
- **<storage-host>** (`<storage-host-ip>`, verified over ssh on 2026-11-09): Raspberry Pi 5 Model B Rev 1.0, 4 cores at 2.4 GHz, 8 GB RAM, Debian 12 aarch64, Docker 29.x, user in the docker group. Read-only ssh is fine; ask the user before anything needing root or a restart on <storage-host>. The existing restic job is `<media-root>/knowledge-archive/ops/restic-backup.sh` (user crontab, 05:30, single source). Verified read-only on 2026-11-10: the rclone remotes are `<gdrive-remote>:` and `<odrive-remote>:`, <storage-host>'s time zone is Europe/Helsinki (cron runs in local time) and `<media-root>/knowledge-archive` is a clean git repo. Speed is not a concern (user, 2026-11-09).
- Ports in the design: 8120 tailnet listener, 8121 public listener (loopback only; the tunnel route is the exposure gate).
- Shell tools: prefer `jq`, `yq`, `rg`, `fd`, `sd`; edit files with the editor's Edit tool, never a script read-replace-write. In zsh a variable holding several lines is not word-split; loop with `while read`.

### 0.4 Repository and commit rules

- The `agentic-hub` checkout at `~/projects/agentic-hub` is **shared** with another Claude session (`ce-research`, owner of the cross-repo plan and the cognitive-engine port) that switches branches in it. Always run `git branch --show-current` before committing. Commit `main` from a worktree (for example `git worktree add ../agentic-hub-wt-main main`), stage explicit paths only (no `git add -A`, no `commit -a`), `git fetch` before pushing.
- Never edit `ce-research`'s branch (`docs/clarify-decisions-2026-11-09`, PR #20), its files or the pr-plan; send it a message instead (`SendMessage` to `ce-research`).
- Commit and push only when the user asks. End commit messages with the attribution lines the harness gives.
- Check a branch against `origin/main` only after `git fetch`; a stale local `main` caused one wrong conclusion on 2026-11-09.
- Vertical lists only in docs, absolute dates, no secrets, no invented facts: mark open items `[design]` or `[unverified]`. The repository is public: placeholders `<workstation>` and `<storage-host>` only, no names, emails, hostnames, IPs or secrets.

### 0.5 Models and delegation

- Claude Code: subagents default to Sonnet; Opus only for judgements whose error is expensive (the SEC adversarial review) and for the single final verification (GATE); pass the model explicitly. Antigravity: inherit the session model; the `pro` tier needs the user's approval. The mapping table is in the user-level `AGENTS.md` (`~/.gemini/config/AGENTS.md` and `~/.claude/CLAUDE.md`).
- Jev mode is `on`: call `jev_batch_dispatch` before delegating non-trivial work and `jev_judge` on diffs, and say so. Known defects of the dispatch tool (a substring keyword rule, Antigravity vocabulary, wrong session model) are in the case study `2026-11-09-model-tier-for-multi-stream-workflow.md` (now in `rockad/cognitive-engine`, `packages/jev/docs/case-studies/`; a pointer stays under `plugins/jev/docs/case-studies/`); treat its output as advice, not an instruction. `jev_batch_dispatch` takes, per task: `id`, `task`, `dependencies` (an array of task ids), `kind` (`mechanical`, `settled-edit` or `judgement`) and `needsEdit`. The old server silently ignored unknown keys such as `description` or `dependsOn`, which gave empty task text and a single stage; Jev PR #54 (open, not part of this plugin) makes it reject them [reported by the session that hit it].
- Docs workflows that edit many files should give each agent a disjoint file set and finish with a consistency pass: cross-file races produced stale references twice.

### 0.6 How spikes are run (process rules)

- Roles: the **helper** is an attended Claude Code session that never launches, drives or probes agy; the **user** starts agy and copies files; **Antigravity** answers prompts and writes its results file; the helper reads logs.
- Scratch work lives under `~/scratch/a2a-spikes/` (<workstation>-local, not in git): helper briefs, `stub/`, `sp1/` to `sp5b/`, `agy-operator/` prompts, `runlogs/`. Borrow and put back (decision 25): back up before touching user config, verify the restore, never print a token (the string `spike-token` is allowed).
- A background Claude Code job has `CLAUDE_CODE_SESSION_ATTENDED=0`, which breaks the wake-listener tests; those need an attended session.
- Listener owner pid is `$CLAUDE_PID`, not `$PPID`. Details are in `docs/research/spike-results-2026-11-05-sp1.md`.

### 0.7 Resuming without the original session (state of 2026-11-15, 18:10 Europe/Helsinki)

Why this section exists: the main session that ran W3a and W4a may stop (quota). Anything not written here or in git is lost. Labels: [verified] was observed by the main session, [reported] comes from a build agent.

How a wave runs (master-plan section 13), so another account or Antigravity can repeat it:

- The original session drove each wave with one Claude Code `Workflow` script (not in the repo; it only chains agents). The same steps work by hand with subagents (Claude Code `Agent`, Antigravity `invoke_subagent`; the tier rule in section 0.5):
  1. Build: one agent per stream in its own worktree and branch `feat/coordination-<id>` (`git worktree add ../agentic-hub-wt-<id> -b feat/coordination-<id> origin/main`), told which files are in scope, to commit with explicit paths, never push.
  2. Check: a separate agent re-runs the stream's acceptance list from master-plan section 4.2 with throwaway secrets, its own compose project name and a free port (not 18120), canary scans with pattern files and a positive control.
  3. Repair: at most two rounds, only for failed criteria.
  4. Scope check: `git diff --name-only origin/main...HEAD` must stay inside the stream's files.
  5. Review by the main session: read the diff, re-run `A2A_TEST_REQUIRE_DOCKER=1 uv run pytest -q` in `plugins/coordination/servers/coordination` (Docker needed), push, open one PR per stream with caveats, no merge without the user's word.
- Quota note: the 5-hour limit cut agents off twice on 2026-11-15 (a cut-off agent's work stays in its worktree; resume it with a prompt that says to inspect `git log`, `git status` and `git diff` first). With little quota left, run one stream at a time.

Where things are [verified 2026-11-15, 18:10]:

- Merged to `main`: SCAF, PG, BKP, STORE, OBS, the docs (head `7db293c`). Suite on merged `main`: 313 passed, 3 skipped.
- S1-AUTH: PR #65, branch `feat/coordination-auth`, commit `a0967d7`, worktree `agentic-hub-wt-auth`. 611 passed, 3 skipped, re-run by the main session. CI was pending at 18:09. The caveats and the two design calls to review are in the PR body (a bare `create_app` is unauthenticated; auth failures are not audited until the SQL audit store lands with STATE).
- S1-STATE: branch `feat/coordination-state`, commits `724167d` (about 4,200 added lines: `service/`, `audit/sql.py`, `store/task_store.py`, tests, `docs/specs/service-layer.md`) and `42f9fa2` (repair: the loser of a claim race gets `already_claimed`), worktree `agentic-hub-wt-state`, tree clean, **pushed to origin (head `42f9fa2`, 2026-11-15 18:25), no PR**. The workflow `wf_4f76062e-a5e` was stopped by the main session on 2026-11-15 at 4 percent weekly quota left, during the check and repair of this stream: the independent check found at least one failed criterion (that is why the repair commit exists) and **never confirmed the repair**; the full suite and the Z6 atomic test have not been re-run by the main session. `git diff --name-only origin/main...HEAD` touches only `docs/specs/` (audit-events, server-api, service-layer), nothing under `docs/plans`. Briefed design (decision Z6, user chose "one transaction in the store"): `CoordTaskStore.transition` writes the task, its audit row and its `task_index` update in one database transaction (this also closes the crash window STORE documented); the skipped test `tests/test_audit.py::test_transition_and_its_audit_row_commit_together_against_postgres` becomes a real Postgres test (a normal transition leaves exactly one `state_transition` row naming the actor; a forced audit-insert failure leaves state, version and index unchanged and no row); the guess counter is left to S2-LISTEN; the service layer is a plain API and is not wired into `app.py`; migration number m0004 is reserved for STATE, m0003 for AUTH (AUTH used none).
- Review checklist for STATE: run the full suite with Docker; confirm the placeholder test is no longer skipped; `git diff --stat origin/main...HEAD` shows nothing under `docs/plans` (an earlier stray edit to the old `implementation-plan.md`, now `master-plan.md`, must not land; drop it and move any content that is still valid into `master-plan.md` on `main`); check `docs/specs/audit-events.md` section 2 and the as-built note in `server-api.md` 1.3 match the code.
- After AUTH and STATE are merged: update this file, then start W4b (below).

W4b plan (decisions Z10 to Z15, 2026-11-15; the brief for the account or Antigravity session that runs it):

1. First, S1-STATE: run its independent check (branch `feat/coordination-state`, head `42f9fa2`; the repair commit was never confirmed), re-run the full suite with Docker, confirm the Z6 atomic test is real and green, review the diff, open its PR. Do not start W4b code before AUTH and STATE are merged on the user's word, or branch W4b from the merged `main` once they are.
2. Branches (Z11): MCP `feat/coordination-mcp` from merged `main`; A2A `feat/coordination-a2a` from the MCP branch; ADMIN `feat/coordination-admin` from the A2A branch. One PR per stream targeting `main`, opened in that order, each rebased after the one before it merges. Merge only on the user's word.
3. S1-MCP (full verification): deliverables and acceptance in master-plan section 4.2. `wait_seconds` is capped by `A2A_MAX_WAIT_S` (default 50), not 240 (Z15). Mount `/mcp` as a second ASGI app behind the shared AUTH middleware (SP5 D12). Use the STATE service layer API; do not reimplement task logic.
4. S1-A2A (full verification): wire tests per operation against the pinned spec commit `4735f48`. Front desk (Z13): a generic public root card, per-member authenticated cards, and a root `SendMessage` rejected with an error pointing to the member card path; no member listing extension field, no `metadata.target` routing. Streaming and push stay off (`-32004`, `-32003`).
5. S1-ADMIN (lean: build plus main-session re-run; SEC reviews it at W6): admin socket on tmpfs, mode 0600, no TCP; `a2a-coord key create|list|rotate|revoke`, `review`, `status`, `card check`, `db init-dump-role` (exists since S1-PG). `key create` requires `--expires` with ceilings 365 days at `s1` and 90 at `s2` and `s3`; no `--tailnet-login` (Z14). TTY rules and the human-only release path as in the plan. The user tests the TTY paths by hand.
6. Per stream: scope = its own module plus `app.py` mounting, `config.py`, tests, `docs/specs/`; nothing under `docs/plans` (status goes in this file, committed to `main`). Migration numbers: m0005 and up, one per stream, in branch order (m0003 and m0004 were reserved for AUTH and STATE and are unused unless STATE added one: check `store/migrations/`).
7. After each stream: update sections 0.1, 1, 3.2 and 4.2 of this file and commit to `main`. Next wave after W4b: W5a (ID, then WAKE), master-plan section 13.
- Quota [reported by `~/.cache/claude-quota.json`, 2026-11-15 18:25]: weekly 96 percent used (4 percent left), weekly reset on 2026-11-20 15:00. Under the user's rule (section 0.1, item 9) this section was refreshed and the running workflow stopped (`TaskStop`; a stopped `Workflow` run can be resumed only in the session that ran it, so another session starts the check by hand). No agents are running. No test containers were left behind [verified with `docker ps -a`].
- Peers: `claude-cp` (Remote Control, built SCAF, PG and BKP; offline most of the time), `ce-research`, `jev-update`. Do not edit their branches. The scratch status file `~/scratch/a2a-spikes/s1-todo.md` on <workstation> is only an agent log; this file is the status.
- Antigravity pickup: the user starts agy; a helper never drives or probes it (A8c, hooks and any live agy check are the user's). The session model is the ceiling for subagents; `pro` needs the user's approval.

## 1. Status at a glance (as of 2026-11-15)

- Stage S0 (spikes) is closed for the S1 entry gate (2026-11-11). Open from it: A8c, and two attended tests that run inside S1.
- Stage S1: five of the 19 streams are merged to `main` (SCAF, PG, BKP, STORE, OBS). The full suite on merged `main` gave 313 passed, 3 skipped [verified, main session, 2026-11-15].
- Wave W4a (AUTH and STATE) was launched on 2026-11-15. S1-AUTH is in PR #65 (open; 611 passed, 3 skipped, re-run by the main session [verified]). S1-STATE is on its pushed branch (`42f9fa2`, two commits, no PR); its workflow was stopped before the independent check finished, so it needs the check and your review. Nothing from W4a is merged.
- Weekly quota 96 percent used on 2026-11-15 (4 percent left), resets 2026-11-20 15:00 [reported by the quota file]. The main session stopped launching agents at that point (user's quota rule); see section 0.7.
- Not started: TEST-skel (planned beside W3a, not done), the rest of S1 (W4b to W6), all of S2, S3, go-live and the later tracks.
- Docs updates go straight to `main` from 2026-11-15 (user decision, no PR for docs); stream code goes one PR per stream, merged on the user's word.
- W4b is decided (Z10 to Z15, 2026-11-15, /clarify round): another Claude account or Antigravity runs it from section 0.7; order MCP, A2A, ADMIN; stacked branches merged in order.
- Open for the user: merge words (AUTH PR #65, STATE once its PR exists, then each W4b PR), A8c in agy, the attended tests, and the user-only items in section 4. No design question is open for the agents.

## 2. Milestones

Done:

| date | milestone | reference |
| --- | --- | --- |
| 2026-11-03 | Option 4 hybrid accepted (DDR-001), then the `phone-a-friend` half withdrawn the same day; BuildSlot half implemented (cognitive-engine PR #13) | master-plan 11.1 |
| 2026-11-04 | DDR-004 accepted (A2A coordination server); research clones deleted; `agents-bridge` repo retired and copied here | master-plan 11.4 |
| 2026-11-05 | S0 scaffolding, SP1 offline, SP5 on SQLite (passes with four wrappers) | `docs/research/spike-results-2026-11-05-*.md` |
| 2026-11-06 | SP1 interactive pass (go for decision 8); SP2 Claude half pass with spec changes | `docs/research/spike-results-2026-11-05-sp1.md`, `-2026-11-06-sp2-claude.md` |
| 2026-11-08 | SP2 agy half pass | `docs/research/spike-results-2026-11-08-sp2-agy.md` |
| 2026-11-09 | SP2 A8b pass with the unique-name caveat; the 2026-11-09 clarify rounds (D-A to D-J, R1 to R14) | `docs/research/spike-results-2026-11-09-a8b-agy.md` |
| 2026-11-10 | SP5b (Postgres) pass; SP5b follow-up; round 4 (X1 to X5, C1 to C5); docs commits `db17ada`, `946f198`, `c17402b`, `3a2bea8`, `74f6c0e` | `docs/research/spike-results-2026-11-10-sp5b.md` |
| 2026-11-11 | S0 gate satisfied: SP1 to SP5b passed, SP3 passed, SP4 recorded (SP3 and SP4 results commit `1213787`) | `docs/research/spike-results-2026-11-10-sp3-sp4.md`; `docs/specs/spikes.md` section 11 |
| 2026-11-11 | S1 kickoff approved by the user | decision Y10, master-plan 12.1 |
| 2026-11-11 | S1-SCAF merged | PR #32, `11f7e0f` |
| 2026-11-12 | S1-PG merged | PR #37, `cff63c9` |
| 2026-11-12 | S1-BKP merged | PR #42, `c3dd5ad` |
| 2026-11-14 | S1 plan and handoff merged | PR #60, `d94d289` |
| 2026-11-15 | S1-STORE merged | PR #61, `0397b6f` |
| 2026-11-15 | S1-OBS merged | PR #62, `d09799f` |
| 2026-11-15 | Z6 docs merged | PR #63, `2d9dd83` |
| 2026-11-15 | Docs updates committed straight to `main` (user decision, no PR for docs) | `7f0cb6d` |
| 2026-11-15 | Wave W4a (AUTH, STATE) launched and running | section 3.2 |

Planned, in order (a sequence, not dates), with the gate condition of each:

- **S1 remaining waves:** W4b (MCP, then A2A, then ADMIN, one at a time on stacked branches, Z8 and Z10 to Z15), W5a (ID, then WAKE), W5b (CLAUDE and AGY, then the user's live checks), W6 (INST, DOC, SEC, TEST full, opus review of SEC).
- **S1 exit gate (S1-GATE), dev on <workstation>:** two-way task round trip, Claude idle wake, agy surfacing, API key refusal, quarantine end to end; the `asyncRewake` re-arm and GUI-launched Claude tests pass; a `pg_dump -Fc` backup restores into a scratch Postgres with equal counts; `dump_age_h` shows in `/status`; one opus final verification.
- **S2 deploy and gate, production on <storage-host>:** API keys and scopes live, cross-host wake works, and the public-listener tests on the loopback 8121 listener pass (R8). S2-LISTEN and the S3-FUZZ run against it come before the S2 gate.
- **S3 gate, public front door:** quarantine live, rate limits and fuzz pass, honest card, final extension URI, then the user's explicit go. Order after the gate: `a2a-coord expose check` (exit 0), the user flips `A2A_EXPOSURE_STAGE=s3` and restarts, then the user creates the tunnel route. The GL-IMPORT code must be finished before S3-GATE (D36).
- **Go-live:** after the S3 exit and the user's declaration (D14): rehearsal, the user's go, the real import, the retirement of the frozen channel.
- **Later tracks (LT):** the cognitive-engine status adapter, built after S1 exit and only on the user's go (D13), off by default.

## 3. Stream status

Deliverables and acceptance of each stream are under its heading in [`master-plan.md`](master-plan.md) section 4 (4.1 S0, 4.2 S1, 4.3 S2, 4.4 S3, 4.5 go-live, 4.6 LT); they are not copied here. Hours are the plan's estimates (section 8 of the plan); "not estimated" is the plan's own wording. "Depends on" is taken from the plan's DAG (3.1) and sections 5.1 and 5.2.

### 3.1 S0: spikes (status 2026-11-11)

| stream | status | PR or commit | depends on | hours | notes |
| --- | --- | --- | --- | --- | --- |
| S0-SCAF | done 2026-11-05 | none (scratch) | none | 3-5 | stub on `127.0.0.1:18120`, results convention |
| S0-SP1 | done, pass 2026-11-05 to 06 | none (scratch) | S0-SCAF | 5-8 | go for decision 8; `asyncRewake` idle wake 0.4 s, overnight park woke in 0.3 s |
| S0-SP2C | done, pass with spec changes 2026-11-06 | none (scratch) | S0-SP1 | 6-9 | handle binding, Claude half; C9 `${A2A_API_KEY}` expansion verified in project scope |
| S0-SP2A | done, pass 2026-11-08 (A8b 2026-11-09) | none (scratch) | S0-SCAF | 3-4 | agy half incl. A8b user-level plugin pass with the unique-name caveat |
| S0-SP3 | done, pass 2026-11-10 | none (scratch) | S0-SP2A | 1.5-2.5 | agy `PreInvocation`; results below |
| S0-SP4 | done, recorded 2026-11-10 and 2026-11-11 | none (scratch) | S0-SP3 | 2-3 | held `Stop` park, record only, non-gating |
| S0-SP5 | done, pass with four wrappers 2026-11-05 | none (scratch) | none | 8-12 | SQLite run; no longer gates (D-D) |
| S0-SP5B | done, pass 2026-11-10 | none (scratch) | S0-SP5 | not estimated | Postgres; satisfied the S1 storage gate |
| S0-SP5B-FU | done 2026-11-10 | none (scratch) | S0-SP5B | not estimated | (a) and (b) pass; (c) cause of the 1,036.82 ms outlier stays [unverified], closed without further work |
| S0-RES | done 2026-11-11 | `1213787` | SP1 to SP5b | 2-3 | S1 entry gate satisfied |
| S0-A8C (agy: user-level `.mcp.json`, `agy plugin install`, signed-out tool use) | open, staged; the user has not started step 1 [reported] | none | none | S, not estimated | not blocking; the user runs it in agy, signed-out run last; the result gates the S1-INST placement and the S1-AGY health check |
| `asyncRewake` on `UserPromptSubmit`, re-arm after Esc | open, runs inside S1 (Y10) | none | S1-CLAUDE | not estimated | attended; own exit test [design] |
| GUI-launched Claude seeing `A2A_API_KEY` (decision 34) | open, runs inside S1 (Y10) | none | S1-CLAUDE | not estimated | attended; own exit test [design]; fallback in decision 34 |
| S0-SP6 (inbox socket, optional) | not run | none | none | 2-3 | only if BP1 fails; SP1 passed, so not needed now |

### 3.2 S1: dev on <workstation>

| stream | status | PR or commit | depends on | hours | notes |
| --- | --- | --- | --- | --- | --- |
| S1-SCAF | done (W1) | PR #32, `11f7e0f` | none | 6-10 | delivered scope in 3.8 |
| S1-PG | done (W2) | PR #37, `cff63c9` | S1-SCAF | not estimated | acceptance a to g re-run by the main session [verified]; 70 tests pass, 1 skipped |
| S1-BKP | done (W2) | PR #42, `c3dd5ad` | S1-PG | not estimated | 159 tests pass, 2 skipped [verified 2026-11-12]; the second restic script is open for S2; runbook `docs/runbooks/backup.md` |
| S1-STORE | done (W3a) | PR #61, `0397b6f` | S1-SCAF, S1-PG | 16-24 | critical path; owns the migration directory; caveats in section 5 |
| S1-OBS | done, writer half (W3a) | PR #62, `d09799f` | S1-SCAF | 4-6 | acceptance 3b split (Z6); also owns `dump_age_h` in `/status` |
| S1-TEST (skeleton) | not started | none | S1-SCAF | part of 14-22 | planned in the main tree beside W3a, not done; reuses the SP5 load driver |
| S1-AUTH | built, PR open (W4a) | PR #65, `a0967d7` | S1-STORE schema | 10-16 | worktree `agentic-hub-wt-auth`; 611 passed, 3 skipped, re-run by the main session [verified]; checker 8 of 8; no schema change; not wired: production audit store (STATE), rate-limit numbers (S3-LIMITS), real tailnet identity source (S2-TS), key commands (ADMIN) [reported by its build agent] |
| S1-STATE | built, repair unconfirmed, awaiting check and review (W4a) | branch `feat/coordination-state`, `42f9fa2`, pushed, no PR | S1-STORE | 14-22 | worktree `agentic-hub-wt-state`; owns the atomic exit test of Z6; main-session review and PR still to do (section 0.7) |
| S1-MCP | not started (W4b, first) | none | S1-AUTH, S1-STATE | 12-18 | `/mcp` facade; critical path; full verification (Z12); wait cap is `A2A_MAX_WAIT_S` (Z15) |
| S1-A2A | not started (W4b, second) | none | S1-AUTH, S1-STATE | 16-24 | `/a2a/v1`, card, push; branches from the MCP branch (Z11); full verification (Z12); front-desk scope per Z13 |
| S1-ADMIN | not started (W4b, third) | none | S1-AUTH, S1-STATE | 12-18 | admin socket, `a2a-coord`; the user tests TTY paths; branches from the A2A branch (Z11); lean verification (Z12); key-create scope per Z14 |
| S1-ID | not started (W5a) | none | S1-MCP | 8-12 | identity, binding, `/sessions` |
| S1-WAKE | not started (W5a, after ID) | none | S1-ID | 12-18 | wake, pending, budget |
| S1-CLAUDE | not started (W5b) | none | S1-WAKE | 6-10 | hooks in `bin/` and `hooks/`; the user runs live checks |
| S1-AGY | not started (W5b) | none | S1-ID, S1-WAKE | 6-10 | live checks by the user in own agy session; a helper never drives agy |
| S1-INST | not started (W6) | none | S1-CLAUDE, S1-AGY, S1-ADMIN | 12-18 | the user runs it; the A8c result sets how the plugin is placed |
| S1-DOC | not started (W6) | none | S1-INST | 6-10 | |
| S1-SEC | not started (W6) | none | S1-A2A, S1-MCP, S1-WAKE, S1-ADMIN, S1-OBS | 10-16 | sonnet suite, opus adversarial review; cannot pass without the Z6 atomic test |
| S1-TEST (full) | not started (W6) | none | S1-A2A | rest of 14-22 | TCK, e2e; the user for live e2e |
| S1-GATE | not started (W6) | none | S1-SEC, S1-TEST, S1-DOC, S1-BKP, S1-OBS | 6-10 | the user with CC and AGY; opus final verification |

Critical path of S1 (from the plan): S1-SCAF, S1-PG, S1-STORE, S1-STATE, S1-MCP, S1-ID, S1-WAKE, S1-CLAUDE, S1-INST, S1-DOC, S1-GATE; the plan sums its estimates to 98 to 152 h.

### 3.3 S2: production on <storage-host>

All not started. The same image runs with `A2A_ENV=live`, `A2A_DEPLOY_HOST=<storage-host>` and `A2A_EXPOSURE_STAGE=s2`. Host changes on <storage-host> are done by the user; CC drafts the runbook.

| stream | status | PR or commit | depends on | hours | notes |
| --- | --- | --- | --- | --- | --- |
| S2-DEPLOY | not started | none | S1 exit | 6-10 | the user on <storage-host>: Postgres, dump sidecar (`COMPOSE_PROFILES=backup`), `a2a-coord db init-dump-role`, restic password file, second restic job |
| S2-LISTEN | not started | none | S1 exit (plan 5.1: built on <workstation> beside the user-bound steps) | 8-14 | 8121 public listener on loopback from stage `s2`, public-listener tests, guess counter (was S3-LISTEN); BP19 |
| S2-TS | not started | none | S2-DEPLOY (plan W7: sequential) | 6-10 | `tailscale serve`, tailnet identity binding; the user installs Tailscale; L1, BP18 |
| S2-ONBOARD | not started | none | S2-TS (plan W7: sequential) | 4-8 | per-machine keys, installer on <workstation> and mac; the user |
| S2-WAKE | not started | none | S2-ONBOARD (plan W7: sequential) | 4-8 | cross-host wake; L4, BP22 |
| S2-STREAM (optional, unscheduled) | not started | none | a real peer's need (D35) | 12-20 | streaming and push, deferred |
| S2-GATE | not started | none | all S2 streams | 3-5 | the user; API keys and scopes live, cross-host wake works, 8121 loopback tests pass |

### 3.4 S3: public via the existing Cloudflare Tunnel

All not started. Preconditions that never change: no route exists before the S3 gate; the service is never started on <storage-host> while a route is present. S3-LISTEN moved to S2-LISTEN.

| stream | status | PR or commit | depends on | hours | notes |
| --- | --- | --- | --- | --- | --- |
| S3-LISTEN | moved to S2-LISTEN (round-2 R8) | none | none | moved | no work left under this id |
| S3-LIMITS | not started | none | S2-LISTEN (per-key part built with it, tested in S2) | 8-12 | rate limits and client IP; client-IP part confirmed by L2 at the S3 go; BP19, BP20 |
| S3-CARD | not started | none | S2 gate (plan 5.1) | 3-5 | honest public card; BP21 |
| S3-PEER | not started | none | S2 gate (plan 5.1) | 8-12 | remote-peer flow; the user releases |
| S3-FUZZ | not started | none | S2-LISTEN (runs against the 8121 listener before the S2 gate, R8) | 12-20 | opus adversarial review; gate: all S3 streams |
| S3-EXPOSE-CHECK | not started | none | S1-ADMIN, S1-AUTH | not estimated | read-only `a2a-coord expose check` and the `s3` start-up checks (R13, X5) |
| S3-GATE | not started | none | all S3 streams, GL-IMPORT finished (D36) | 6-10 | the user; opus for the final verification of server and importer together; the user's go, then the stage flip |
| S3-CF | not started | none | S3-GATE, the stage flip | 4-8 | the user creates the route to `127.0.0.1:8121`; L2, L3; BP20, BP21 |
| S3-EXIT | not started | none | S3-CF | 2-4 | exit evidence through the public route |

### 3.5 Go-live migration (master-plan section 9)

All not started. Real steps begin only after the S3 exit and the user's declaration (D14); there is no separate go-live gate (D36).

| stream | status | PR or commit | depends on | hours | notes |
| --- | --- | --- | --- | --- | --- |
| GL-IMPORT | not started | none | none for the build (D36: beside S2 and S3, own worktree) | 16-24 | importer and fixtures against copies of the channel files; finished before S3-GATE; needs the `A2A_UID`, `A2A_GID` and `/data` answer (section 5) |
| GL-REHEARSE | not started | none | GL-IMPORT, S3-EXIT | 6-10 | dress rehearsal on a scratch volume; the user approves |
| GL-APPLY | not started | none | GL-REHEARSE, the user's explicit go | 4-6 | freeze record, snapshot, apply, verify; the user with CC |
| GL-RETIRE | not started | none | GL-APPLY | 6-10 | tar backup, typed deletion on a TTY, watcher retirement; code built with GL-IMPORT |

### 3.6 LT: cognitive-engine status adapter (later)

Off by default; contract in `docs/specs/status-client.md`. `status_runs` and `status_events` tables belong to LT-SRV, not to S1.

| stream | status | PR or commit | depends on | hours | notes |
| --- | --- | --- | --- | --- | --- |
| LT-SRV | not started | none | S1 exit, the user's go (D13) | 8-12 | `POST /status`, tables, `a2a_runs` |
| LT-ADP | not started | none | S1 exit, LT-SRV, the user's go | 10-16 | adapter package in the cognitive-engine repo posting `{run_id, run_scope, state, report_path, ts}` to `/status`, built in that session; opus review of the leak and sbx tests; answers to Q1 to Q11 first |

### 3.7 Parallel tracks outside the plugin streams

- BuildSlot (cognitive-engine PR #13, branch `feat/buildslot-protocol`, stacked on #5, open): independent track, still in force; its open items are in section 4.
- The frozen file channel stays frozen until go-live (decision 14); the exception is that Antigravity may use it for research on this work. The turn watcher is obsolete and is stopped in go-live (GL-RETIRE).

### 3.8 Delivered results kept from the handoff

- S1-SCAF (PR #32, `11f7e0f`, merged 2026-11-11) [verified by the main session, acceptance re-run on a fresh `--no-cache` build]:
  - Delivered: `plugins/coordination/plugin.json`; `docker-compose.yml` with the single service `coordination` (`read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp` and `/run/a2a`, `127.0.0.1:8120` only, named volume `a2a-data` at `/data`, healthcheck, non-root uid 10001); `servers/coordination` (multi-stage Dockerfile running pytest in the build stage, `a2a-sdk[http-server]==1.3.0`, `uv.lock`, one config module reading the 35 `A2A_*` variables of api 1.5, `/healthz`, `a2a-coord` CLI skeleton, typed protocols for store, service, notifier and clock, 25 tests); `AGENTS.md` and `README.md` status text.
  - Acceptance [verified]: 25 tests passed in the build stage; container healthy; `/healthz` 200; non-root; writes outside `/data`, `/tmp` and `/run/a2a` fail; `docker port` shows only `127.0.0.1:8120`; no host-name or memory-plugin hits; `uv.lock` present; 35 of 35 config variables match the api 1.5 table.
  - Design choices where the spec was silent: `A2A_DEPLOY_HOST` defaults to `local`; unknown `A2A_*` variables are ignored; base image `python:3.14-slim` with uv 0.11.31.
  - Not included, left to later streams: Postgres (S1-PG), dump sidecar (S1-BKP), the `./config` bind mount (the cards file read is S1-AUTH), CI, marketplace entry.
  - The delivered list names only `/healthz` as an endpoint; storage, auth and the other endpoints belong to the later S1 streams [unverified whether the skeleton registers any other route].
- S1-PG (PR #37, merged 2026-11-12): implemented, reviewed and re-verified by the main session (acceptance a to g re-run with throwaway secrets, all pass [verified]; 70 tests pass, 1 skipped; the canary scan was checked with a planted canary). Decisions of its brief: secrets dir `${A2A_SECRETS_DIR:-$HOME/.config/a2a-coord/secrets}` (files `a2a_db_password` and `pg_dump_password`, mode 0600), exact tag plus digest, no trust authentication, a minimal startup connect probe in `store/connect.py` (S1-STORE replaced it), `init-dump-role` feeding SQL over stdin.
- S1-BKP (PR #42, merged 2026-11-12): dump sidecar; acceptance re-run by the main session with throwaway secrets, 159 tests pass, 2 skipped [verified]; runbook `docs/runbooks/backup.md`.
- S0 gate satisfied 2026-11-11 (`docs/specs/spikes.md` section 11): SP1, SP2 (Claude and agy halves, A8b), SP5 (SQLite) and SP5b (Postgres on <workstation>) passed with spec changes folded in; SP3 and SP4 were run on 2026-11-10 and 2026-11-11 (agy 1.5.4 then 1.5.5, run by a helper with the user attending) and recorded in `docs/research/spike-results-2026-11-10-sp3-sp4.md` (tracked since commit `1213787`). The earlier C1 wording (gate NOT satisfied) was correct on 2026-11-10 and is superseded. S0 is not "complete" in the sense of every open item: A8c and the non-gating SP5b follow-up items stay open, and the `asyncRewake` and GUI-launched Claude tests run inside S1.
- SP3 gate items passed [verified]: P1 5 of 5 trials (the model called `a2a_inbox` unprompted), P3 p50 28 ms and p95 33 ms over 186 runs, P4 dedupe rule works, P5 all 6 failure modes fail open (0 blocked turns, 0 errors, 0 orphans). Record-only items: P1b, P1r (resume does not re-fire `SessionStart`; `PreInvocation` does fire), P2 (once per model call), P6 (no `timeout` key: agy proceeded after about 31.5 s, hook not killed), P7 (both wordings read as system text), P8 (user-level hooks ran in a trusted workspace; `.a2a-optout` honoured with no network call; an untrusted workspace stopped at the trust dialog).
- SP4 recorded, non-gating: K1 to K6 (`Stop` once per user turn; typing queued; `continue` capped at 10; UI released at about 60 s on `timeout: 30` with the hook not killed; Esc, Ctrl-C and `/exit` leave an orphan; a finished background command wakes an idle agy). Reading: usable with serious caveats at best. Not tested [unverified]: a held park of 300 s to 1800 s, and user-level hooks in an untrusted workspace past the trust dialog.
- SP5b (2026-11-10, <workstation>) passed all acceptance gates (`docs/research/spike-results-2026-11-10-sp5b.md`, commit `946f198`; corrections C1 to C3 added):
  - Pinned Postgres image: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (D-B, R3).
  - D3 (lost-update CAS): 300 rounds, 0 lost updates, 0 double takes, transition p99 10.13 ms.
  - D7 (backup sidecar under load): `pg_dump -Fc` via `dump_ro` in 0.73 s, `pg_restore --list` verified 71 entries, restore into a scratch DB with 100% count match (722/722), Alembic at head (`b5e3d1c8a2f7`).
  - D8 (crash resilience under load): 2x `kill -9` of server and Postgres container restart, 0 lost acked writes (336 creates, 296 completions, 40 cancels), level-triggered park re-offer verified.
  - D2 (10-minute mixed load): 1,986 tasks, 0 unhandled DB errors, loop lag p99 2.41 ms, wake p99 2.8 ms, store.save p99 17.25 ms, transition.versioned p99 18.66 ms, 0 deadlocks inferred from an empty `db_errors` count (no separate deadlock counter, C3). A 1,036.82 ms `CancelTask` outlier during the D7 dump has an unverified cause (C2); the 200 ms p99 gate was evaluated on D2 only.
  - Separator check: `#` and `~` validated across URL query (`%23` for `#`), shell quoting, JSON and Postgres; verdict X1: `#` needs `%23` in URL queries, `~` adopted by user decision 2026-11-10.
- SP5b follow-up (2026-11-10, non-gating, `docs/research/spike-results-2026-11-10-sp5b-followup.md`, Claude Code's check in its section 7): (a) PASS for the mechanism, (b) PASS, (c) cause UNVERIFIED. The agy-reported items without a saved log are carried as exit tests of S1-PG and S1-BKP (section 4).
- The docs commits of 2026-11-10 on `main`: `db17ada` (`name#sid8` grammar, separator replaced by `~` in round 4, X1), `946f198` (SP5b pass; the message predates C1: SP5b satisfies the S1 storage gate only), `c17402b` (S1 design items; values replaced by X2 to X5), `3a2bea8` (handoff update; its gate wording and "settled" statements corrected by C1 and C5), `74f6c0e` (round-4 decisions X1 to X5 and corrections C1 to C5).
- State 2026-11-14: S1-SCAF, S1-PG and S1-BKP merged; no later stream had started; the lost `claude-cp` session left no code beyond these. State 2026-11-15: S1-STORE (PR #61) and S1-OBS (PR #62) merged; the main-session suite on merged `main` gave 313 passed, 3 skipped [verified].

## 4. Todo

Tick a box when it is done and say so in the commit that changes it. Items marked (user) are user-only.

### 4.1 S0 and attended tests

- [x] S0 gate satisfied 2026-11-11 (SP1 to SP5b passed, SP3 passed, SP4 recorded)
- [ ] (user) A8c in agy, signed-out run last (runbook `docs/research/spike-runbook-a8c-agy-open-items-2026-11-09.md`); not started [reported]. It tests the three items A8b left open, same labels and borrow-and-put-back rules as the A8b runbook; the helper never starts or drives agy:
  - [ ] (1) `.mcp.json` at user level in `~/.gemini/config/plugins/<name>/`
  - [ ] (2) `agy plugin install <path>` and uninstall
  - [ ] (3) tool use while signed out of agy; this changes the real agy login, so it is the LAST run: back up the agy credential files explicitly, put them back, check; the user signs out, the helper never does
- [ ] A8c cleanup with the user: stop the stub on `127.0.0.1:18120`, remove the agy MCP cache entries for it
- [ ] (user) `asyncRewake` on `UserPromptSubmit` with re-arm after Esc, inside S1 (Y10; design in `server-api` 11.1). [design] Exit test to write: after Esc, the next prompt re-arms the listener and a parked wake still reaches the turn
- [ ] (user) GUI-launched Claude seeing `A2A_API_KEY`, inside S1 (Y10; decision 34). [design] Exit test to write: a GUI-launched session reads the variable; if not, the `~/.claude.json` fallback of decision 34 applies
- [ ] Open from A8b, untested (not blocking): whether agy tool use needs a live sign-in (every successful call was signed in; the startup sign-in warning is harmless); covered by A8c item (3)

### 4.2 S1: now running

- [x] W3a done (STORE PR #61, OBS PR #62, both merged 2026-11-15)
- [ ] W4a: AUTH built (PR #65 open, awaiting the user's merge word); STATE built and pushed on its branch (`42f9fa2`, workflow stopped at 4 percent weekly quota): independent check (unconfirmed repair), main-session review and PR still to do (section 0.7)
- [ ] TEST-skel (planned beside W3a, not done; no dependency blocks it)

Main-session steps after each workflow (no user needed):

- [ ] Read each diff and re-run each stream's suite and acceptance itself
- [ ] `jev_judge` on each diff (weak signal)
- [ ] Push each branch and open one PR per stream, with caveats in the PR body (no merge)
- [ ] Update this file (docs go straight to `main`)

Waiting on the user:

- [ ] (user) Merge word per stream PR (AUTH, STATE, then each later stream)
- [x] W4b order MCP, A2A, ADMIN confirmed by the user on 2026-11-15 (Z8, Z10 to Z15)
- [ ] (user) Provide the secret files (database password, `dump_ro` secret; mode 0600, outside the repo) at W6 (Z7); nothing earlier needs them
- [ ] (user) ADMIN TTY paths, CLAUDE and AGY live checks, run the installer (W4b to W6)
- [x] Housekeeping checked 2026-11-15 [verified by the main session]: nothing left to prune in the agy trusted workspaces or the Claude project entry; the Obsidian bearer rotation was decided unnecessary by the user
- [x] Jev PRs #54, #55, #58 left alone (Z9)

Blocked until their dependencies merge:

- [ ] W4b: MCP, then A2A, then ADMIN (after AUTH and STATE)
- [ ] W5a: ID, then WAKE (after MCP)
- [ ] W5b: CLAUDE and AGY (after WAKE; AGY also after ID)
- [ ] W6: INST, DOC, SEC suite, TEST full, opus review of SEC, then GATE
- [ ] S1 exit gate (S1-GATE) passed: two-way task round trip, Claude idle wake, agy surfacing, API key refusal, quarantine end to end

S1 items carried from the old tasklist (the stream that owns each is in brackets; acceptance is in master-plan section 4.2):

- [ ] [STATE, then SEC and GATE] Z6 atomic exit test: a transition, its audit row and its `task_index` update commit in one transaction; a failed audit insert leaves state and version unchanged and no row
- [ ] [MCP] Tool `a2a_runs`: read-only status, scoped to the caller (kept 2026-11-09, D-I)
- [ ] [A2A, MCP, ID, WAKE] Endpoints `/mcp`, `/a2a/v1`, `/wake/listen`, `/sessions`, `/status`, Agent Card (contract in `docs/specs/server-api.md`)
- [ ] [ID] Session handle grammar `name~sid8` (decisions 2026-11-09 and 2026-11-10, X1; `server-api` 3.5 and 5.1, evidence SP2 C6 pair 3): `register` and `a2a_hello(name=...)` build `<card-id>/<name>~<sid8>` on the server, `~` plus the first 8 hex characters of the session id always present; session-part regex `^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$`; handle validation in `coord.to`, `a2a_hello(handle)` and the hook scripts' check of the returned handle; server-side uniqueness, a same-`<sid8>` collision rejected by a clear error [design]; the SessionStart text and the register call show the new form. Open [design]: the unnamed-session form (`server-api` 3.5, two readings)
- [ ] [AUTH, ADMIN] API keys (`a2a-coord key create|list|rotate|revoke`, `a2ak_<env>_<keyid>_<secret>`) and `a2a-coord review`, run inside the container over the unpublished admin socket (decisions 15 and 24)
- [ ] [CLAUDE, AGY] Claude Code hooks (`a2a-listen`, `UserPromptSubmit`) and agy hooks (user-level `~/.gemini/config/hooks.json`, decision 26), MCP entries, and the agy inbox instruction through `SessionStart` `injectSteps` (decision 27; no `AGENTS.md` is written). Hook scripts copied to `~/.local/share/a2a-coord/<version>/bin/` with a `current` symlink (decision 28)
- [ ] [INST] Installer `a2a-coord install --claude --agy`: non-secret parts of chezmoi-managed files through chezmoi; Claude key from the unmanaged 0600 `~/.config/a2a-coord/api-key`, exported as `A2A_API_KEY` by one non-secret chezmoi-managed shell line, with a `~/.claude.json` fallback if the GUI test shows no env expansion (decision 34); agy key literal in the unmanaged `~/.gemini/config/plugins/<name>/mcp_config.json` (mode 0600); no key in any chezmoi-managed file (decisions 16, 24, 34); never writes an `AGENTS.md`, refuses to write through symlinks (decision 27); `a2a-coord install --rotate-key` rotates the key file
- [ ] [INST] Installer agy placement rules from SP2 A8b (decision 24, `server-api.md` 11.0): the plugin `<name>` is unique across user and workspace scopes; never ship a workspace plugin with the same name; the post-install health check makes a real tool call (`a2a_hello` or `a2a_inbox`), not only a connection check; fallback if the placement breaks is the `agy mcp add` global entry, which reopens decision 24 with the user. The A8c result sets the final placement
- [ ] [INST] Y9 installer rules: merge into `~/.gemini/config/hooks.json` by its own key only, byte-copy backup first, re-read right before writing, atomic write
- [ ] [AGY] Y5 and Y6 hook shape: `systemMessage` with the tested dedupe, connect timeout about 200 ms, always exit 0 with `{}`, no throttle
- [ ] [MCP, A2A, STATE] S1 backlog from the spikes: key-bound `Mcp-Session-Id` with `403` on mismatch; `server/discover` advertising only stateful versions; uvicorn `handle_exit` releasing parked listeners with `503`; the storage wrappers that remain after D-A (`VersionedDatabaseTaskStore` CAS with a seeded version row, `CoordTaskStore` with `task_index`, the custom parked-task `RequestHandler`); `POST /sessions` requires the key and makes handles unique; listener guard accepts `clear`, owner is `$CLAUDE_PID`
- [ ] [PG, BKP] Exit tests for the items the SP5b follow-up only [reported] (no saved log) [design]: `a2a-coord db init-dump-role` idempotent on a fresh and an existing volume; rotation works and the old password is rejected; the secret value is absent from container logs and process arguments; restore row counts match
- [ ] [OBS, status client] `dump_age_h` in `/status`: server side delivered by S1-OBS (PR #62, covered by that stream's tests, suite re-run on merged `main` [verified]); this box stays open for the status client display and the live stale check, not verified: the server reads `last_ok` through a read-only mount; null before the first successful dump; stale when older than 36 h (this also catches a mis-set compose profile, R14); the status client shows it
- [ ] [BKP, S2] Second restic script text and crontab line for <storage-host> (R9, X4): script `~/.local/share/a2a-coord/<version>/bin/a2a-restic-backup.sh` (same style as `<media-root>/knowledge-archive/ops/restic-backup.sh`; never written into the knowledge-archive git repo), repository `rclone:<gdrive-remote>:backups/restic-a2a`, password file `~/.config/a2a-coord/restic-password` (mode 0600, created by the user), tag `a2a-dumps`, source `<media-root>/backup/a2a/`, retention `restic forget --keep-last 3 --prune --tag a2a-dumps`, one user-crontab line `45 5 * * *` in <storage-host>'s local time (Europe/Helsinki), after the existing 05:30 job; the installer prints both and never edits the crontab. The script is not on `main`
- [ ] [TEST] Rerun the SP5 D2 load with session-register and budget writes (done as SP5b; the S1-TEST load skeleton reuses the driver)
- [ ] Not adopted, for the record: WAL archiving and point-in-time restore; host-installed Postgres
- [ ] (user) Decide whether to commit the SP5 and SP5b scratch drivers into the repo so a session on another machine can run them (today only on <workstation>, `~/scratch/a2a-spikes/`)

### 4.3 S2: production on <storage-host>

- [ ] S2-DEPLOY, S2-LISTEN, S2-TS, S2-ONBOARD, S2-WAKE (not started)
- [ ] (user) Install Tailscale on <storage-host> and the workstations; the server checks the Tailscale identity matches the machine the key was issued for, for all harness keys including <workstation> (decisions 17 and 23; delivery mechanism unverified, `spikes.md` section 13)
- [ ] Deploy the image on <storage-host> (`A2A_ENV=live`, `A2A_DEPLOY_HOST=<storage-host>`); one `local-harness` API key and card per machine (`claude-code@<workstation>`, `antigravity@<workstation>`, `claude-code@mac`, ...)
- [ ] Wake latency and tailnet dependency measured in the cross-host wake test (plan Risk 12)
- [ ] Dump sidecar and Postgres deploy on <storage-host> (R4, R5, R9, R11, R14): the same image tag plus digest as S1; `COMPOSE_PROFILES=backup`; `dump_age_h` shown in `/status`; restore drill into a scratch Postgres with `pg_restore`
- [ ] (user) Create the directory `<media-root>/backup/a2a/` (user-owned, next to `<media-root>/backup/gitea/`, no root needed) and the `dump_ro` secret file on <storage-host>, then run `a2a-coord db init-dump-role`
- [ ] (user) Create the restic password file `~/.config/a2a-coord/restic-password` (mode 0600) on <storage-host>, before S2 (X4); never written in any doc
- [ ] (user) Install the second restic script and its crontab line on <storage-host> from the text the installer prints (X4); the installer never edits the crontab; record whether `restic snapshots --tag a2a-dumps` shows a dump from `<media-root>/backup/a2a/`
- [ ] 8121 public listener from stage `s2` (R8): the server binds `127.0.0.1:8121` only, remote-peer rules active, off at `s1`; start-up checks and the stage table in `server-api.md` consistent (api 1.4, 1.5, 1.6, 8.4.1)
- [ ] S2 public-listener tests on <storage-host>'s loopback (R8, spikes L6): `remote-peer` keys only, only `/a2a/v1` and the public card, `CF-Connecting-IP` believed only on 8121, per-key rate limits, the fuzz pass, no route created
- [ ] Guess counter (R1, R10, X3): per-API-key limit on handle-addressed "not available" responses (card-addressed sends are outside it, `403 CardNotAllowed` not counted, they stay under the per-key `SendMessage` limit of 10 per minute): 10 within 60 s trips it; while tripped, a handle-addressed `SendMessage` from that key gets `429` with `Retry-After: 60`; one audit row per trip (event `handle_probe_limited`, fields `key_id` and `window_count`); clears by itself after 60 s without further misses; no key quarantine, no human release. A handle inside `cards_allowed` yields a held task; an unknown, ended or disallowed handle yields the uniform "not available" `REJECTED` task
- [ ] Guess counter tests (R1, R10; fake clock): the 10th miss within 60 s trips and the 9th does not; the next handle-addressed `SendMessage` gets `429` with `Retry-After: 60`; exactly one `handle_probe_limited` audit row per trip with `key_id` and `window_count`; clears after 60 s; another key unaffected; a card-addressed send to an unknown card gets `403 CardNotAllowed` and is not counted (X3); responses never reveal handle existence outside `cards_allowed`; the sbx isolation test covers ports 8120 and 8121; loopback tests of the 8121 listener send `Host: 127.0.0.1:8121`
- [ ] S3-FUZZ and the per-key S3-LIMITS part run against the 8121 loopback listener before the S2 gate
- [ ] Answer the `A2A_UID`, `A2A_GID` and `/data` question for GL-IMPORT before S2
- [ ] S2-GATE passed
- [x] No public route exists (the route was created and deleted on 2026-11-04, plan Risk 13, historical); rule revised by R8: no route before the S3 gate

### 4.4 S3: public front door

- [ ] S3-LIMITS, S3-CARD, S3-PEER, S3-FUZZ, S3-EXPOSE-CHECK (not started)
- [ ] Implement the read-only `a2a-coord expose check` (R13, X5, S3-EXPOSE-CHECK): exit 0 all conditions met, 1 at least one unmet (itemised report), 2 could not evaluate (admin socket or database error); changes nothing. Runtime checks now: quarantine enforced for remote-peer keys, per-key rate limits and the guess counter enabled, `dump_age_h` below 36 h (null counts as unmet), port 8121 bound to host loopback only. Manual items until S3 [design]: fuzz report green, honest card, extension URI fixed
- [ ] Server start-up checks for `A2A_EXPOSURE_STAGE=s3` (R13): the server refuses to start if a condition fails; no runtime admin command changes the stage and the stage is not derived from other configuration
- [ ] `CF-Connecting-IP` from `cloudflared` on the same host, told apart from `tailscale serve` traffic by the listener port; Host and Origin checks, rate limits; Cloudflare timeout (about 100 s, reported) versus the 60 s `SendMessage` cap (decision 22)
- [ ] Per-peer `remote-peer` API keys, delivered out of band (hashed, revocable, rate-limited), optional mTLS later (decision 18); human-only release (decision 19); fuzz pass per RFC 006 section 3; create the route only after the gate
- [ ] Peer handles (D-G, D-H, R1): every remote-peer key may address session handles; sessions sharing one API key may claim each other's handles (accepted risk, no bind code; "accepted by the user 2026-11-09, mitigated by the guess counter")
- [ ] Uniform-error enumeration test (D-H, R1), in the fuzz pass (run against the 8121 listener in S2): an unknown, an ended and a disallowed handle give the same "not available" error class and response shape; a handle inside `cards_allowed` yields a held task; the handle list is never returned to remote-peer keys
- [ ] Final extension URI replaces the placeholder `urn:agentic-hub:coordination:v1` before the public card goes live (D-J, S3 gate); open point 13 stays open until then
- [ ] GL-IMPORT finished before S3-GATE (D36)
- [ ] S3-GATE with the opus final verification (quarantine live, rate limits and fuzz pass, honest card, final extension URI)
- [ ] (user) The S3 go; then, in order: run `a2a-coord expose check` (must exit 0; the user confirms the manual items), set `A2A_EXPOSURE_STAGE=s3` and the public host in the compose environment, restart the stack (the `s3` start-up checks pass), then create the Cloudflare Tunnel route to `127.0.0.1:8121` (S3-CF); then L2 and L3 run
- [ ] S3-EXIT evidence through the public route
- [x] Front end chosen: the user's existing Cloudflare Tunnel on <storage-host> (decision 20); hostname `<a2a-host>`; listener decided (D-F): the tunnel targets loopback 8121 (remote-peer keys only, only `/a2a/v1` and the public card, `CF-Connecting-IP` trusted only there), 8120 stays tailnet-only

### 4.5 Go-live

- [ ] GL-IMPORT built during S2 and S3 against copies of the channel files (decision 36)
- [ ] Pre-apply snapshot (R6, R9, R12): `pg_dump -Fc` named `pre-import-<run_id>.dump` into `<media-root>/backup/a2a/` (collected by the second restic job), run by the host-side importer through the compose stack; run artefacts under `/data/imports/<run_id>/` (not in the backup scope); the daily prune never deletes `pre-import-*` files (R12 default, the user may veto); removing them is manual
- [ ] GL-REHEARSE after the S3 exit
- [ ] (user) Declare go-live and give the go for GL-APPLY
- [ ] GL-APPLY: import the `~/.agents` channel files (including Antigravity's research appends, so the dry run is rerun at go-live), verify
- [ ] GL-RETIRE: tar backup, typed deletion on a real TTY, stop the watcher and the retirement list (master-plan 9.11)
- [ ] Go-live open points of master-plan 9.15 answered by the user (freeze instant, role for imported messages, machine name in handles, turns archive, other machines, backup tar retention, `handoff/` prompts)

### 4.6 Later tracks and the cognitive-engine track

- [ ] (user) The go for LT-SRV and LT-ADP, after S1 exit (D13)
- [ ] LT-SRV, then LT-ADP (status adapter)
- [ ] A1: clean alternative survey; keep the watch list (for example `agent-bus`, plain MIT, for audit log hashing)
- [ ] C2: call-site mapping in `cognitive-engine` (`packages/harness2` call sites: `model_gate.py`, the Docker test wrapper, `stage1.py`)
- [ ] C2 follow-on: BuildSlot adoption call sites (spec section 7: `GATE`, the Docker suite wrapper, `stage1.py` teardown), a separate step after the review and the user's PR go
- [ ] C6 BuildSlot (cognitive-engine PR #13, branch `feat/buildslot-protocol`, fix at `da1b199`, ruff items at `2c814eb` with 6 SIM117 left on purpose): README not updated; optional re-run of the full suite at `da1b199` (measured at `6c0ac4d` only)
- [ ] C6 spec decisions taken by the implementer, for review: only `rootless-docker` is predefined (`~/.agents/cognitive-engine-docker-tests.lock`); other slot names use a private file under `$XDG_STATE_HOME/cognitive-engine/slots`; slot names restricted to lower-case letters, digits and `-`; an all-invalid sidecar reads as unknown; a failed sidecar write never fails a hold

### 4.7 User-only hygiene and decisions

- [ ] (user) Schedule the history-rewrite window and run the owner force-push (Y4; master-plan section 10; not scheduled; nothing has been run)
- [ ] (user) The GitHub Support purge decision
- [ ] (user) Delete the old `ghcr.io/rockad/lookup:latest` tag in the package settings (Y2; the helper's token has no package scope)
- [ ] (user) Delete the finished SP3 and SP4 scratch folder
- [ ] (user) Remaining history-rewrite owner decisions (master-plan 10.7): window date and duration, forks and clones check, dependent repositories and notes to update, retention of the offline mirror

## 5. Open items, risks and caveats

- **OBS acceptance 3b split (Z6).** S1-OBS keeps the writer half (merged). The atomic half (a transition and its audit row commit together; a failed audit insert leaves state and version unchanged and no row) is an exit test of S1-STATE, built as one transaction in `CoordTaskStore.transition`. That transaction also closes the crash window between the SDK task save and the `task_index` update. S1-SEC and S1-GATE cannot pass without it.
- **STORE caveats (PR #61).**
  - The migration directory is `src/coordination/store/migrations/`.
  - The store is a composition over the SDK `VersionedDatabaseTaskStore` and calls private SDK helpers; this is safe only while `a2a-sdk` is pinned to 1.3.0.
  - The Docker image build and the p99 latency benchmark were not verified.
  - `status_runs` and `status_events` belong to LT-SRV, not to S1.
- **TEST-skel not started.** It was planned in the main tree beside W3a; nothing blocks it.
- **A8c stub.** It still listens on `127.0.0.1:18120` until A8c cleanup [reported by the session that staged it; port checked 2026-11-15]. Acceptance runs must use another port. Stop the stub and remove the agy MCP cache entries for it only at cleanup, with the user.
- **A8c result** gates the S1-INST placement and the S1-AGY health check. A8c was staged by the `claude-cp` session and the user has not started step 1 [reported, not verified by the main session].
- **`A2A_UID`, `A2A_GID` and `/data` (GL-IMPORT).** They must match the secret owner (rootless Docker uses 0); `/data` is not writable when they are overridden, so GL-IMPORT needs an answer before S2. A non-root `A2A_UID` other than 0 is untested under rootless Docker. The server container cannot read a 0600 secret file unless they match the file owner [reported by the S1-PG build agent].
- The state-volume directory is mode 0777 so the sidecar can write `last_ok`.
- **Second restic script and password file:** the second restic script is not on `main`; the restic password file on <storage-host> is the user's, before S2.
- **S1-PG and S1-BKP exit tests** for the items only [reported] by the SP5b follow-up are open (section 4.2).
- **SP5b caveats:** the 1,036.82 ms `CancelTask` outlier during the D7 dump has an unverified cause (C2); the 200 ms p99 gate was evaluated on D2 only; "0 deadlocks" is inferred from an empty `db_errors` count (C3).
- **Not tested [unverified]:** a held `Stop` park of 300 s to 1800 s; user-level agy hooks in an untrusted workspace past the trust dialog; GUI-launched Claude seeing `A2A_API_KEY`; the delivery mechanism of the Tailscale identity through `tailscale serve`; `CF-Connecting-IP` from `cloudflared` on the same host; tunnel traffic told apart from `tailscale serve` traffic; the Cloudflare timeout (about 100 s, reported) (`spikes.md` section 13).
- **S1 scoping result:** whether one exists is [unverified] (carried from the old tasklist).
- **Out of scope, observed in A8b:** `lookup` and `recall` time out at startup in every agy session and delay MCP startup by about 2 minutes (memory plugin setup, not this plugin).
- **Issues #39 and #40** (memory plugin version bump, lookup package visibility) are unrelated to coordination and still open [verified with `gh issue list`, 2026-11-15].
- **Jev PRs #54, #55 and #58** are left alone (Z9).
- **Shared checkout.** `ce-research` switches branches in `~/projects/agentic-hub`; the worktrees of running builds (`agentic-hub-wt-auth`, `agentic-hub-wt-state`) must not be touched by another session. The STATE build edits plan, spec and audit docs in its own worktree [reported by `git status` in that worktree, 2026-11-15], so its PR will conflict with the 2026-11-15 docs reorganisation (the plan was renamed from `implementation-plan.md` to `master-plan.md`); rebase it onto the new names.
- **Plan status text.** The status paragraph at the top of `master-plan.md` section 1 was written 2026-11-11 and is kept as written; this file is the live status.

## 6. Doc map

Same as [`../README.md`](../README.md). There are exactly two live planning documents. Everything else is reference or archive.

- [`plans/master-plan.md`](master-plan.md): the whole plan. Workstreams and acceptance (section 4), the dependency DAG, parallelisation, traceability, effort, the go-live migration (9), the git history rewrite (10), decision records (11), decision rounds (12), and the waves and workflow process (13).
- [`plans/master-tasklist.md`](master-tasklist.md): this file, the status and todo.
- [`specs/`](../specs/): contracts and spike plans. `server-api.md` (the API), `spikes.md`, `audit-events.md`, `status-client.md`, `buildslot-spec.md`, and `heartbeat-spec.md` (historical).
- [`research/`](../research/): evidence. Audits, spike results and spike runbooks. Read-only records.
- [`runbooks/`](../runbooks/): operations. `backup.md`.
- [`archive/`](../archive/): superseded history, see [`archive/README.md`](../archive/README.md). It includes the old consolidated plan (the full text of D1 to D40 and the risks), the old tasklist and the retired `agents-bridge` files.

Rules:

- New status goes in `plans/master-tasklist.md`.
- New design goes in `plans/master-plan.md`.
- Do not add a third planning document.
- Docs updates go straight to `main`; stream code goes one pull request per stream.
