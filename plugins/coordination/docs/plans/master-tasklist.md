# Coordination plugin: master tasklist

This is one of the two live planning documents (the other is [`master-plan.md`](master-plan.md)). It holds how to pick up the work, the status, the milestones, the stream status tables, the todo and the open items for the whole coordination plugin (S0 to S3, go-live and the later tracks). The plan holds the design: stream deliverables and acceptance (plan section 4), decisions (sections 11 and 12), waves and workflow process (section 13). New status goes here; new design goes there; do not add a third planning document.

The full text of the old tasklist (decision records, workstream checklist, every ticked box) is kept as [`../archive/master-tasklist-through-2026-11-14.md`](../archive/master-tasklist-through-2026-11-14.md). Labels: **verified** (read or observed), **reported** (a claim not reproduced), **unverified**. No dates are given for work that has not started. Items marked (user) are user-only: an agent must not do them.

## 0. How to pick up

### 0.1 Start here (copy this into a new Antigravity or Claude Code session)

```
You are continuing the A2A coordination plugin work (repo agentic-hub, folder plugins/coordination). Planning is done and S1 implementation is under way. Twelve of the 19 S1 streams are merged to main: SCAF (PR #32), PG (PR #37), BKP (PR #42), STORE (PR #61), OBS (PR #62), on 2026-11-17 AUTH (PR #65), STATE (PR #67), MCP (PR #68), A2A (PR #69) and ADMIN (PR #71), and on 2026-11-21 ID (PR #85) and WAKE (PR #86, with decisions Z18 and Z19), together with the image-build fix (PR #70) and a CI job that builds and starts the image (PR #74). Waves W1 to W5a are complete and the end-to-end wake test passed on 2026-11-21. Wave W5b (CLAUDE and AGY) is merged: S1-AGY PR #95 (`3f8be9f`, 2026-11-22), S1-CLAUDE PR #94 (`84f3026`) and the AGY hardening PR #96 (`d55c790`), all on 2026-11-23, each after an Opus review with verdict MERGE and green CI on the exact head. Open: the live checks (the user's), the minors collected in the #94 and #96 follow-up (a small PR), and wave W6. State and next steps are in section 0.7 ("W5b state"). The docs were reorganised on 2026-11-15 into two live documents. Section 0.7 says how to continue without the original session. The plan is docs/plans/master-plan.md (streams in section 4, waves and workflow in section 13); the status and todo are docs/plans/master-tasklist.md (this file). Check a PR's state with `gh pr view`, not with `git merge-base --is-ancestor`: squash-merged PRs report "not merged" there.
1. Read plugins/coordination/AGENTS.md, docs/README.md, then this file, sections 1 to 5.
2. Verify the state before acting: git fetch; git log --oneline -8 origin/main; git status; gh pr list. Check every claim in a doc against its evidence file. The S1 entry gate is satisfied (2026-11-11, docs/research/spike-results-2026-11-10-sp3-sp4.md); the user approved the S1 kickoff on 2026-11-11 (Y10). The decision tables Y1 to Y10 and Z1 to Z9 are final (master-plan section 12).
3. Work only in your own git worktree: git worktree add ../agentic-hub-wt-<you> -b <branch> origin/main. Never commit in ~/projects/agentic-hub (it is shared with another session) and never touch the worktrees of a running build (agentic-hub-wt-claude and agentic-hub-wt-agy2 until their PRs merge). Stage explicit paths only. Never push main, tag or release without the user's go.
4. First action: read section 0.7 (resuming without the original session), then check where W5b stands (gh pr list; read-only git status and git log in the worktrees agentic-hub-wt-claude and agentic-hub-wt-agy2). Follow section 0.7 ("W5b state") for what is verified and what is next. Coordination PRs are merged by the main session after an Opus review with verdict MERGE and green CI on the exact head (user, 2026-11-21); everything else still waits for the user's word. Tests use throwaway secrets; running the real stack needs two secret files from the user at W6 (database password and dump_ro secret, each mode 0600 and outside the repo; ask for them, never print or create their values). Then take the first unticked item of section 4 that needs no user input. Ask the user before anything marked (user): agy runs, attended tests, the <storage-host> crontab, hygiene items and the other user-only actions.
5. Decisions in the plan's decision tables are final: do not reopen them. Anything the docs leave open stays marked [design] or [unverified]; do not invent it.
6. Label every statement verified, reported or unverified. Never print a secret or a token. Use vertical lists, absolute dates, and the editor's Edit tool for file changes.
7. Never launch, drive or probe the Antigravity CLI (agy) as a helper; the user starts agy and agy answers prompts. In Claude Code, run Jev's pre-flight before delegating non-trivial work.
8. When you finish a step: update sections 1 to 4 of this file (status, milestones, stream tables, todo), commit, then tell the user what changed and what is next. Docs updates go straight to main (user decision, 2026-11-15; no PR for docs); stream code goes one PR per stream.
9. Quota rule (user): when a workflow finishes, or when the weekly quota nears its limit, stop starting new agents and update sections 0.1, 1, 3.2 and 4.2 with the exact state (branches, shas, uncommitted files, what to run next), then commit to main.
```

### 0.2 Read in this order

1. `plugins/coordination/AGENTS.md` and `README.md` (orientation and rules), then `docs/README.md` (the doc map, section 6).
2. This file, sections 1 to 5.
3. `docs/plans/master-plan.md`: section 4 (the stream you work on), section 13 (waves and the workflow process), sections 11 and 12 (decisions). The full text of decisions D1 to D40 (4, 6, 8, 16, 20, 24, 26 and 37 to 40 matter most), the risks and the open-decision list is in `docs/archive/consolidated-bridge-v2-plan.md`.
4. `docs/specs/spikes.md`: sections 8 and 8b (SP5 and SP5b), section 11 (the S1 entry gate and its status), the A8b and A8c entries.
5. `docs/specs/server-api.md`: 1.2 and 1.4 (storage and compose), 5.2 (handle addressing), 5.4 (session binding), 8.4.1 (public listener), 11 (installer and hooks), 12.2 (S1 design details).
6. Spike evidence under `docs/research/spike-results-*` (especially `spike-results-2026-11-10-sp5b.md`) and the runbooks `spike-runbooks-2026-11-05.md`, `spike-runbook-a8b-*.md`, `spike-runbook-a8c-*.md`. The independent audit of the overnight SP5b work is `docs/research/audit-2026-11-10-sp5b-s1-gate.md` (not rewritten; its findings are applied as C1 to C5, master-plan 11.4).

### 0.3 Environment facts

- **<workstation>** (WSL2 workstation): spikes and dev. Docker, `uv`, `bun` are installed. Scratch ports: stub 18120, SP5 18125 to 18127, SP5b 18130 to 18132 (loopback only). SP5 and SP5b are torn down. The A8c stub is not running now (nothing listens on `127.0.0.1:18120`, checked 2026-11-21 with `ss`; it was reported up on 2026-11-15). Keep S1 acceptance runs off port 18120 anyway: A8c restages the stub when the user runs it. Rootless Docker needs `A2A_UID=0` and `A2A_GID=0` so the server user matches the secret file owner; with them overridden `/data` is not writable, which GL-IMPORT must answer before S2 (a non-root `A2A_UID` other than 0 is untested under rootless Docker).
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
- Jev mode is `on`: call `jev_batch_dispatch` before delegating non-trivial work and `jev_judge` on diffs, and say so. Known defects of the dispatch tool (a substring keyword rule, Antigravity vocabulary, wrong session model) are in the case study `2026-11-09-model-tier-for-multi-stream-workflow.md` (now in `rockad/cognitive-engine`, `packages/jev/docs/case-studies/`; a pointer stays under `plugins/jev/docs/case-studies/`); treat its output as advice, not an instruction. `jev_batch_dispatch` takes, per task: `id`, `task`, `dependencies` (an array of task ids), `kind` (`mechanical`, `settled-edit` or `judgement`) and `needsEdit`. The old server silently ignored unknown keys such as `description` or `dependsOn`, which gave empty task text and a single stage; Jev PR #54 (merged 2026-11-17, not part of this plugin) makes it reject them [reported by the session that hit it].
- Docs workflows that edit many files should give each agent a disjoint file set and finish with a consistency pass: cross-file races produced stale references twice.

### 0.6 How spikes are run (process rules)

- Roles: the **helper** is an attended Claude Code session that never launches, drives or probes agy; the **user** starts agy and copies files; **Antigravity** answers prompts and writes its results file; the helper reads logs.
- Scratch work lives under `~/scratch/a2a-spikes/` (<workstation>-local, not in git): helper briefs, `stub/`, `sp1/` to `sp5b/`, `agy-operator/` prompts, `runlogs/`. Borrow and put back (decision 25): back up before touching user config, verify the restore, never print a token (the string `spike-token` is allowed).
- A background Claude Code job has `CLAUDE_CODE_SESSION_ATTENDED=0`, which breaks the wake-listener tests; those need an attended session.
- Listener owner pid is `$CLAUDE_PID`, not `$PPID`. Details are in `docs/research/spike-results-2026-11-05-sp1.md`.

### 0.7 Resuming without the original session (state of 2026-11-21)

Why this section exists: the main session that runs the waves may stop (quota). Anything not written here or in git is lost. Labels: [verified] was observed by the main session, [reported] comes from a build agent.

How a wave runs (master-plan section 13), so another account or Antigravity can repeat it:

- The original session drove each wave with one Claude Code `Workflow` script (not in the repo; it only chains agents). The same steps work by hand with subagents (Claude Code `Agent`, Antigravity `invoke_subagent`; the tier rule in section 0.5):
  1. Build: one agent per stream in its own worktree and branch `feat/coordination-<id>` (`git worktree add ../agentic-hub-wt-<id> -b feat/coordination-<id> origin/main`), told which files are in scope, to commit with explicit paths, never push.
  2. Check: a separate agent re-runs the stream's acceptance list from master-plan section 4.2 with throwaway secrets, its own compose project name and a free port (not 18120), canary scans with pattern files and a positive control.
  3. Repair: at most two rounds, only for failed criteria.
  4. Scope check: `git diff --name-only origin/main...HEAD` must stay inside the stream's files.
  5. Review by the main session: read the diff, re-run `A2A_TEST_REQUIRE_DOCKER=1 uv run pytest -q` in `plugins/coordination/servers/coordination` (Docker needed), push, open one PR per stream with caveats, no merge without the user's word.
- Quota note: a usage limit can cut an agent off (its work stays in its worktree; resume it with a prompt that says to inspect `git log`, `git status` and `git diff` first). With little quota left, run one stream at a time. The main session parks agent work when the weekly quota nears its limit (user rule).

Where things are [verified 2026-11-17]:

- Merged to `main` on 2026-11-17, in this order (merge commits):
  - PR #65 S1-AUTH, `eb09ad5`
  - PR #67 S1-STATE, `0ea46ab`
  - PR #70 image-build test fix, `df95c47`
  - PR #68 S1-MCP, `552f00d`
  - PR #69 S1-A2A, `7444c79`
  - PR #71 S1-ADMIN, `86069be`
  - PR #73 public-leak scrub plus the CI leak guard `scripts/check-public-leaks.sh` (Jev session's PR, not part of this plan), `30171b8`
  - PR #74 image build, cards mount and an image CI job, `503fb93`
- Earlier merges: SCAF (PR #32), PG (PR #37), BKP (PR #42), STORE (PR #61), OBS (PR #62). The Jev session's PRs #66 and #72 are not part of this plan.
- Suite on the top of the stack before the merges: 1173 passed, 3 skipped [verified, main session]. CI on `main`: "Run Test Suites" passes on each merge commit [verified].
- The stack branch `stack/coordination-auth-state` and all merged coordination branches and worktrees are deleted.
- PR #74 (`fix(coordination): image build, cards mount, and an image CI job`) fixed three breaks that plain CI did not catch:
  - Four AUTH and A2A tests indexed `Path(__file__).parents[N]` and broke the in-image test run. They now use the conftest `PLUGIN_DIR` and skip outside the repo.
  - `docker-compose.yml` now mounts `${A2A_CONFIG_DIR:-./config}` read-only at `/config`. Before this the server could not read `/config/cards.yaml` and stopped at start-up.
  - The dump image pinned `postgresql17-client=~17.11`, which Alpine no longer ships. The pin is now `=~17`.
  - New workflow `.github/workflows/coordination-image.yml` builds both images, starts the stack with throwaway secrets and a one-card CI cards file, and checks `/healthz`, `a2a-coord status`, `card check` and the admin socket.
  - Lesson: plain CI never built the image, so all three breaks passed CI. Keep the image job.
- The S1-ADMIN hand run (`docs/specs/admin.md` section 11) was done by the user on 2026-11-17 and all steps passed, including `/dev/tty` under `docker compose exec -it` [verified]. Results are recorded in that section.

W4a and W4b are done (decisions Z6 and Z10 to Z16). Short note of what was built, for the record:

- S1-AUTH: authentication middleware, keys, cards file; no schema change.
- S1-STATE: the task service layer; `CoordTaskStore.transition` writes the task, its audit row and its `task_index` update in one transaction (Z6), and the Z6 atomic test is a real Postgres test. It added no migration (m0003 and m0004 were reserved and are unused).
- S1-MCP: `/mcp` as a second ASGI app behind the shared AUTH middleware; `wait_seconds` capped by `A2A_MAX_WAIT_S` (Z15).
- S1-A2A: wire tests against the pinned spec commit `4735f48`; front desk per Z13; TCK allowlist reviewed by the user (Z16) and the TCK CI job enabled.
- S1-ADMIN: admin socket and `a2a-coord key|review|status|card|db`; `key create` requires `--expires` (Z14).

W5a: parked 2026-11-18 (quota), paused 2026-11-19 for the jev work, resumed 2026-11-19 after jev PR #77 (2.3.17) and the clarify PR #80 merged. Both PRs were open on 2026-11-20 and merged on 2026-11-21 (item 3); items 1 and 2 are the state at that time [verified]:

1. S1-ID: **PR #85** against `main`, branch `feat/coordination-id` at `be74a9c` (worktree `agentic-hub-wt-id`, clean). That is `330aa3f` (independent check passed all, 1273 passed, 3 skipped [reported]) plus the Z17 commit. Full suite re-run by the main session with Docker: **1283 passed, 3 skipped** [verified]. Since its base `1df346b`, `main` changed only `docs/plans/` under the plugin, so no rebase was needed.
2. S1-WAKE: **PR #86** against `feat/coordination-id` (stacked), branch `feat/coordination-wake` at `e8acb73` (worktree `agentic-hub-wt-wake`, clean, force-pushed over `cd25787`).
   - Rebased onto `be74a9c` on 2026-11-19 as `04231ad`: only `docs/specs/identity.md` and `docs/specs/mcp.md` conflicted (both streams' notes kept); the code merged cleanly.
   - Z18 built as `e8acb73` by a Sonnet build agent and reviewed by the main session: `CoordinationService.bind_idle_ender` (the app binds `IdentityService.end_idle`; `Directory.end_idle` stays as the fallback for a service built without it), the lifespan starts `run_forever` (task `coordination-sweep`, 60 s, first pass at start-up) after `admin.start()` and cancels it first on shutdown, `cli/render.py` text fixed, specs updated (`identity`, `wake`, `a2a`, `mcp`, `admin`, `service-layer`), new `tests/test_wake_sweep.py` (real wiring, unit, lifespan; removing the binding fails two of them [reported by the agent]).
   - Full suite re-run by the main session with Docker on `e8acb73`: **1368 passed, 3 skipped** [verified].
   - The WAKE built defaults were decided on 2026-11-20 (decision Z19, master-plan 12.3): eight kept as built; the anti-loop streak is derived from the `wakes` rows (m0004 `set_hash`), built as `7946398` (the build agent stopped on quota; the main session finished it, fixed two tests, re-ran the suite and the latency gate: wake p99 111.5 ms [verified]). The built rule (three newest rows in a row) differs from the round's sketch (a count in the last hour); the user kept the built rule on 2026-11-21 and Z19 now states it.
3. Merged on the user's word (2026-11-21): #85 (S1-ID) as `56c254d`, then #86 (S1-WAKE, GitHub retargeted it to `main` itself when #85 merged; all three CI checks passed) as `0322a9b` [verified].
4. End-to-end wake test **passed on 2026-11-21** [verified, user and main session]: new 7-day keys (`local-harness` on `handrun@local`, `remote-peer` `e2e-peer`), both probes `404`; `register.sh` `201`; the peer's task was held (`INPUT_REQUIRED` to the sender) and the parked listener stayed parked for the 51 s it was held; the user's `review release` answered the listener `200` with body `1` within the release command's run (log: `/wake/listen` 200 at 15:42:38.290Z, `review.release` logged at .293Z after commit); `pending.sh` confirmed the wake. Original plan of the test: Helper scripts are in `~/.config/a2a-coord/` (`register.sh`, `listen.sh`, `pending.sh`, `send.sh`, `probe.sh`). The flow: register a session, park a listener, the peer sends a task that is held for review, the user releases it, and the listener wakes with the count.

W5b state (2026-11-23; the bullets below are the history up to the takeover, the last four bullets are current):

- Started on the user's word ("start W5b in workstreams") by the earlier `coordination` session (now `coordination-legacy`) as workflow `wf_f2947e40-92c`: one Sonnet build agent per stream, then a Sonnet check and up to two repair rounds. Both build agents stopped on the 5-hour limit after about 34 minutes, before any check or commit [reported by the earlier session]. Their files stayed uncommitted in two worktrees.
- Taken over on 2026-11-21 by the current `coordination` session (user request). Nothing was reviewed before; what the current session did [verified]:
  - Committed each stream on its own branch with explicit paths and rebased it onto `origin/main` `290accc`:
    - S1-CLAUDE: `feat/coordination-claude` at `9333ea9`, worktree `agentic-hub-wt-claude`. Files: `bin/a2a-register`, `bin/a2a-listen`, `bin/a2a-pending`, `hooks/hooks.json`, `docs/specs/claude-hooks.md`, an 8-line addition to `docs/specs/server-api.md` (11.1), and five test files.
    - S1-AGY: `feat/coordination-agy` at `506e9a1`, worktree `agentic-hub-wt-agy`. Files: `bin/a2a-agy-session`, `bin/a2a-agy-pending`, `agy/hooks.fragment.json`, `docs/specs/agy-hooks.md`, a 9-line addition to `docs/specs/server-api.md` (11.2), and three test files.
  - Scope check (`git diff --name-only origin/main...HEAD`) stays inside each stream's files; `bash scripts/check-public-leaks.sh` is clean in both; `shellcheck` and `dash -n` pass on every script.
  - Stream tests: Claude hooks 209 passed, agy hooks 212 passed. Full suite with Docker (`A2A_TEST_REQUIRE_DOCKER=1`): S1-CLAUDE **1602 passed, 3 skipped**; S1-AGY: see the next bullet.
  - Acceptance audit against master-plan 4.2 (S1-CLAUDE and S1-AGY): every listed criterion has a test, and the key-never-in-argv, guard, owner-watch (`kill -9`), failure-matrix and byte-constant-output checks run against both a stub and the real server. The agy hooks print `{}` and exit 0 on failure (Y6), where the plan's acceptance line says "no output"; the spec records `{}` as the silent form.
- Pushed on 2026-11-22 after a rebase onto `origin/main` `f483cd8`: PR #94 (S1-CLAUDE, `752147f`) and PR #95 (S1-AGY, `a433900`); CI green on both; full suites 1602 and 1600 passed, 3 skipped each, run locally before the rebase [verified]. The earlier workflow's check stage never ran; the Opus review replaced it.
- **Opus review of #95** (2026-11-22, `a433900`): MERGE, no blocker or major, 8 minors, all contract, output-safety, key-handling, timing and fragment checks clean. Merged by the main session as `3f8be9f` (user authority of 2026-11-21). The minors became PR #96 and S1-INST musts: the hook `command` path written absolute (whether agy expands `~` is unverified), `A2A_AGY_CARD` set or checked by the installer, and the backstop limit for an unregistered or ended session (recorded in `docs/specs/agy-hooks.md` section 9).
- **Opus review of #94** (2026-11-23, `752147f`): FIX FIRST. BLOCKER: a failed redirection or arithmetic error in `a2a-listen` or `a2a-register` put shell errors with paths on stderr, which an exit 2 shows the model, and an unwritable log over 256 KiB exited 2 on every re-armed listener [verified by experiment]. MAJOR: `claude --resume` of an ended session races the listener against the revive (410 `ended` was final). MAJOR: the hook tests skip in CI. Seven minors. All fixed in `d5fc5b0` (stderr on fd 3, failing redirections in subshells, exclusive marker, marker cleared by a successful start, 410 `ended` retried at `SessionStart`, own-state-dir check, number guard), 216 hook tests passed; documented in `docs/specs/claude-hooks.md` sections 4, 5 and 10. Open, accepted: the card source for the hook (S1-INST should read a 0600 file next to the key) and a late end post after a fast `--resume`.
- **CI gap closed** (user priority, 2026-11-23): `ci.yml` runs no coordination pytest, and the image build runs the suite with only `src/` and `tests/`, so every test that needs a repository file or Docker skipped there (102 Claude hook tests; the AGY ones the same way). The new workflow `coordination-suite.yml` (job "Coordination suite from a checkout (hooks, then everything with Docker)", in PR #94) runs the hook tests of both harnesses with zero skips allowed (428 passed on the runner), then the whole suite with `A2A_TEST_REQUIRE_DOCKER=1` and exactly three expected skips (the TCK checkout, `A2A_BACKUP_IMAGE`, a running stack; each covered by its own job): 1867 passed, 3 skipped [verified in the job log]. The gate is `scripts/check-pytest-skips.sh <junit.xml> <skips> <min tests>`; shown locally to fail when `a2a-register` is removed (77 skips) [verified]. A fourth skip or a missing test fails the job: change the number with the test.
- **State at the pause and resume of 2026-11-23:** the user paused work for the quota reset (13:14) and the main session resumed on its own schedule (14:59). The Opus re-review of #94 could not be launched: Jev's elevation approval, answered twice, did not take effect, so #94 is not merged (comment on the PR) and #96 has no review yet. The next session: get the approval (`[jev-elevate:opus]` question), run the re-review of #94 and the review of #96, merge each on a MERGE verdict with green CI on the exact head; the second merge of the two needs no rebase (disjoint files). Resolved the same evening: a "for this session" answer to the Jev question took effect, both Opus reviews ran, and #94 and #96 merged (section 4.2).
- [design] defaults the builds chose, for the user with the PRs (details in `docs/specs/claude-hooks.md` section 10 and `docs/specs/agy-hooks.md`):
  - server URL variable `A2A_SERVER_URL` (default `http://127.0.0.1:8120`); card from `A2A_CARD` or `claude-code@<short hostname>` (agy: `A2A_AGY_CARD`, `antigravity@<machine>`)
  - Claude key file mode is not checked; agy key read from `~/.gemini/config/plugins/coordination/mcp_config.json` (plugin name is the installer's to fix, BP12)
  - a client error the status table does not list (400, 404, 413 and so on) ends the Claude listener silently
  - `a2a-register` adds a constant warning sentence when `A2A_API_KEY` is unset (SP2 C9)
  - agy hooks: `.a2a-optout` in the first workspace root (a plan [proposal], D26 and Y7: the user confirms), flat `hooks.json` form under the group name `a2a-coord` (Y9), session hook reads the count without `announce`
- Live checks, all the user's (section 4.1 and 4.2): Claude idle wake under 10 s with `claude` at 2.1.290 or later; `asyncRewake` on `UserPromptSubmit` re-arming after Esc; GUI-launched Claude seeing `A2A_API_KEY`; agy: the next model call sees the count and calls `a2a_inbox` in at least 4 of 5 trials; a conversation after `/clear` gets a handle (BP11). The plugin is not installed and not in the marketplace, so the hooks cannot fire in any session until the S1-INST installer (W6) or a hand install.
- Ownership (user, 2026-11-21): the earlier `coordination` session (id `af2e62`) stopped on its quota limit and the user renamed it `coordination-legacy`; the current session named `coordination` is the main driver. The 2026-11-19 line below ("no other session takes it over") stands for peers acting on their own; this handover was the user's explicit request. Its handover message of 2026-11-21 is the source of the W5a merge facts and the workflow-script path (`coordination-s1-w5b-wf_f2947e40-92c.js` in that session's project directory; resuming it does not reuse the partial work, because its first step is `git worktree add`).
- Test stack: `coordination-coordination-1` and `coordination-postgres-1` (compose project `coordination`, `127.0.0.1:8120`) have been up since the end-to-end test. `docker compose down` keeps the database, `down -v` wipes it with the test keys; the user decides.

W5a brief (historical; started 2026-11-17, the brief for the account or Antigravity session that ran it):

1. S1-ID is being built by a Claude Code workflow in worktree `agentic-hub-wt-id`, branch `feat/coordination-id` from main `503fb93`, with an independent check and up to two repair rounds. S1-WAKE follows, stacked on `feat/coordination-id` (worktree `agentic-hub-wt-wake`, branch `feat/coordination-wake`). Deliverables and acceptance: master-plan section 4.2.
2. Migration numbers: S1-ID m0003 if it needs schema, S1-WAKE m0004. Only m0001 and m0002 exist; check `store/migrations/`.
3. Open [design] questions S1-ID builds a conservative default for and reports: the unnamed-session form (`server-api` 3.5) and whether a resumed ended session revives. Do not treat the defaults as decided; they go to the user with the PR.
4. Handed over from earlier streams: the rest of S1-ID, wake confirmation (S1-WAKE), parked-listener close on key revoke and the `status` listener and budget fields (S1-WAKE).
5. Per stream: scope = its own module plus `app.py` mounting, `config.py`, tests, `docs/specs/`; nothing under `docs/plans` (status goes in this file, committed to `main`). One PR per stream, the WAKE PR opened against the ID branch and retargeted to `main` when ID merges. Merge only on the user's word.
6. After each stream: update sections 0.1, 1, 3.2 and 4.2 of this file and commit to `main`. Next wave: W5b (CLAUDE and AGY, then the user's live checks), master-plan section 13.
- Ownership (user, 2026-11-19; the main driver changed on 2026-11-21, see "W5b state"): the background Claude Code session named `coordination` that took over on 2026-11-19 is the main driver of this work, and no other session takes it over. The session `cognitive-engine` is responsible for the work in the `cognitive-engine` repository and messages the main driver before changing an interface shared with this plugin (for example the LT status adapter, D13) [verified, its reply]. The earlier `coordination` session (it ran W3a to W5a) handed over on 2026-11-19 and stopped; its handover is recorded below.
- Handover of 2026-11-19 from the earlier session [reported by it, checked at its reply time]:
  - Its two W5a workflows have finished; no agents, monitors, quota crons, coordination containers or volumes are left, and nothing listens on 18120 (the A8c stub is not running). The workflow script `coordination-s1-w5a.js` (args `{"streams":["wake"]}` or `["id"]`) lives outside the repo, in that session's Claude Code project directory, beside `coordination-s1-w4a.js` and `coordination-tck-review.js`.
  - Its worktrees are only `agentic-hub-wt-id` and `agentic-hub-wt-wake`; the other `agentic-hub-wt-*` trees belong to the Jev and `ce-research` sessions. Open PRs #77 and #80 are Jev work.
  - Local files on <workstation>, outside the repo, kept for the next run (user decision): `~/.config/a2a-coord/secrets/a2a_db_password` (throwaway, mode 0600, never print it), `config/cards.yaml` (throwaway card), the helper scripts `register.sh`, `listen.sh`, `pending.sh`, `send.sh`, `probe.sh`, and `handrun-steps.md` (stale: the ADMIN hand run passed and is recorded in `docs/specs/admin.md` section 11). The `keys/` directory was deleted on purpose, so the end-to-end test needs new keys.
  - End-to-end wake test, paused at step 1 (user): create the harness and peer keys with `a2a-coord key create` in the user's own terminal and save each secret to `~/.config/a2a-coord/keys/*.key` with `(umask 077; cat > file)`; then `register.sh`, `listen.sh`, `send.sh`; the user releases the held task with `a2a-coord review release`; `listen.sh` returns `200` and a count.
  - User decisions not written down before: no exact quota figures, reset times or plan tiers go into this public repo; no periodic quota-check cron; PR branches are rebased, not merged.
  - Superseded by decision Z19 (2026-11-20, master-plan 12.3), which answers these; the S1-WAKE defaults as the earlier session listed them: anti-loop state in memory; the `200` body is the pending count clamped to 1 to 9999; `429` above 30 parks in 60 s; re-check every 20 s; the p99 gate measured at 100 wakes per second, not a 200-wake burst. They go to the user with the WAKE PR (`docs/specs/wake.md`).
  - Waiting on the user when it was written: merge words for the ID and WAKE PRs and the end-to-end wake test (both done 2026-11-21), A8c in agy (not blocking; still open), and the `asyncRewake` and GUI-launched `A2A_API_KEY` checks (need the S1-CLAUDE hooks; still open).
- Operating notes (from the same handover, 2026-11-19):
  - Merge words are per PR. Merge a stacked PR with `gh api -X PUT repos/<owner>/agentic-hub/pulls/<n>/merge -f sha=<exact head sha> -f merge_method=merge` once `mergeable` is true (GitHub reports null for a few seconds after `main` moves); retarget the next one with `gh api -X PATCH .../pulls/<n> -f base=main`. A retarget does not start "Run Test Suites". `gh pr edit` fails with the "Projects (classic)" GraphQL error: edit a body with `gh api -X PATCH ... -F body=@file`. From a worktree, `gh pr checks` needs `-R`.
  - Run `bash scripts/check-public-leaks.sh` from the worktree root before every push (CI enforces it). Use placeholders such as `<workstation>` and `/home/user`.
  - Never run `a2a-coord key create` or `review release` for the user: they need a real terminal and the typed phrase by design. Keys are shown once and saved by the user with `(umask 077; cat > file)`.
  - Tests must not index `Path(__file__).parents[N]`: use conftest's `PLUGIN_DIR` and skip when the file is absent (the image build runs the suite with only `src/` and `tests/`). The suite takes 7 to 13 minutes with Docker (12 min 39 s for 1602 tests on 2026-11-21, with another suite and the test stack on the same Docker host); do not stash or switch branches while it runs, and run two suites one after the other, not at once.
  - CI on coordination paths: "Run Test Suites", "A2A TCK against the coordination server", "Coordination image" (builds both images, starts the stack, runs healthz, status and card check), and "Coordination suite from a checkout (hooks, then everything with Docker)" (PR #94: the hook tests of both harnesses with zero skips allowed, then the whole suite with Docker and three expected skips; `scripts/check-pytest-skips.sh`). Before it, CI ran no coordination tests from a checkout.
  - Hand-run stack (stage `s1`, rootless Docker), from `plugins/coordination`: `A2A_UID=0 A2A_GID=0 A2A_CONFIG_DIR=$HOME/.config/a2a-coord/config docker compose up -d --build`; admin CLI with `docker compose exec -it coordination a2a-coord ...` (`-T` without a terminal); `docker compose down -v` when done. The helper scripts expect `~/.config/a2a-coord/keys/{harness,peer}.key`; `send.sh` posts as the remote peer to `/a2a/v1/<card>/message:send` (held for review); `probe.sh <keyfile>` prints 404 for an accepted key and 401 for a refused one.
  - The repo has no ruff config and CI does not run ruff (about 140 existing findings on the base): do not lint-clean unrelated code.
  - Z17 detail: only `POST /sessions`, `a2a_hello(handle)` and the agy path revive an ended session; a Claude `Mcp-Session-Id` already bound to an ended handle still gets `session_ended` and recovers with `a2a_hello(handle)`. The WAKE burst figure: 200 simultaneous wakes give p99 of about 2.3 s; the gate is asserted at 100 wakes per second (`docs/specs/wake.md` section 11).
- Peers: `claude-cp` (Remote Control, built SCAF, PG and BKP; offline most of the time), `ce-research`, `jev-updates`, `cognitive-engine`. Do not edit their branches. The scratch status file `~/scratch/a2a-spikes/s1-todo.md` on <workstation> is only an agent log; this file is the status.
- Antigravity pickup: the user starts agy; a helper never drives or probes it (A8c, hooks and any live agy check are the user's). The session model is the ceiling for subagents; `pro` needs the user's approval.

## 1. Status at a glance (as of 2026-11-21)

- Stage S0 (spikes) is closed for the S1 entry gate (2026-11-11). Open from it: A8c, and two attended tests that run inside S1.
- Stage S1: 12 of the 19 streams are merged to `main`: SCAF, PG, BKP, STORE, OBS, AUTH, STATE, MCP, A2A, ADMIN, ID and WAKE. Counted against the streams table in section 3.2 (20 rows, the two S1-TEST rows being one stream); the image fix (PR #70, PR #74) is not a stream. Waves W1 to W5a are complete; W5b is built and committed locally, not pushed.
- All of W4a and W4b merged on 2026-11-17 (PRs #65, #67, #70, #68, #69, #71, #73, #74; list and merge commits in section 0.7). Full suite on the top of the stack before the merges: 1173 passed, 3 skipped; CI "Run Test Suites" passes on each merge commit [verified, main session]. The new image CI job (PR #74) builds both images and starts the stack; plain CI had never built the image.
- The S1-ADMIN hand run (`docs/specs/admin.md` section 11) passed on 2026-11-17, including `/dev/tty` under `docker compose exec -it` [verified, user]. Client compatibility of MCP with Claude Code and agy is still unverified (S1-GATE and the user's live checks).
- The upstream TCK issue was not posted: both problems are already reported upstream (a2aproject/a2a-tck #202 and #273); the user added a +1 to each.
- Wave W5a: both streams built, checked and in PRs (2026-11-20): S1-ID PR #85 (`be74a9c`, 1283 passed, 3 skipped), S1-WAKE PR #86 stacked on it (`e8acb73`, includes Z18, 1368 passed, 3 skipped), both suites re-run by the main session [verified]. Both merged on 2026-11-21 (#85 `56c254d`, #86 `0322a9b`, with Z19 Fork 2 `7946398`); details in section 0.7.
- The end-to-end wake test passed on 2026-11-21 [verified, user and main session]: a task held for review did not wake the parked listener, and the user's `review release` answered it `200` with the count (section 0.7 item 4).
- Wave W5b is merged (2026-11-22 and 2026-11-23): S1-AGY PR #95 (`3f8be9f`), S1-CLAUDE PR #94 (`84f3026`, after an Opus FIX FIRST on `752147f` and a MERGE re-review of the fixed `d5fc5b0`), AGY hardening PR #96 (`d55c790`, after an Opus FIX FIRST on the first head and a MERGE re-review of `9baf72d`). The CI gap is closed: the job `coordination-suite.yml` (in #94) runs the hook tests of both harnesses with zero skips and the whole suite with Docker (428 and 1867 passed on the runner). `@Doc-Cr` reviewed #94 on macOS with a real Claude Code 2.1.323 (no blocker; findings in the follow-up). Nothing has been run in Claude Code or agy yet: the live checks are the user's. Details in section 0.7 ("W5b state").
- Main driver: the session named `coordination` since 2026-11-21 (the earlier one is `coordination-legacy`); see section 0.7.
- Quota: the main session parks agent work when the weekly quota nears its limit (user rule, section 0.1 item 9); see section 0.7.
- Not started: TEST-skel (planned beside W3a, not done), S1-INST to S1-GATE (W6), all of S2, S3, go-live and the later tracks.
- Docs updates go straight to `main` from 2026-11-15 (user decision, no PR for docs); stream code goes one PR per stream, merged on the user's word.
- Open for the user: A8c in agy, the attended tests, the W5b and W6 live checks, the secret files at W6, and the user-only items in section 4.7. The two S1-ID [design] questions were decided as Z17 and the sweep placement as Z18 (master-plan 12.3); no design question is open for the agents.

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
| 2026-11-15 | Wave W4a (AUTH, STATE) launched | section 3.2 |
| 2026-11-17 | W4a and W4b merged (AUTH, STATE, MCP, A2A, ADMIN); image build fixed and the image CI job added; ADMIN hand run passed | PRs #65, #67, #70, #68, #69, #71, #74; section 0.7 |
| 2026-11-18 | S1-ID design questions decided (Z17); TTL sweep placement decided (Z18), built in the WAKE branch | master-plan 12.3; PR #86 |
| 2026-11-20 | WAKE built defaults decided (Z19), the user kept the built anti-loop rule | master-plan 12.3; `9d16c1e` |
| 2026-11-21 | W5a merged: S1-ID and S1-WAKE; wake anti-loop streak derived from the `wakes` rows (m0004 `set_hash`) | PR #85 `56c254d`, PR #86 `0322a9b` |
| 2026-11-21 | End-to-end wake test passed (held task did not wake the listener; `review release` woke it with the count) | section 0.7 item 4; `1662100` |
| 2026-11-21 | W5b built and committed locally (S1-CLAUDE `9333ea9`, S1-AGY `506e9a1`); the main driver changed to the current `coordination` session | section 0.7 ("W5b state") |
| 2026-11-22 | W5b pushed: PR #94 (S1-CLAUDE) and PR #95 (S1-AGY); Opus review of #95 MERGE; #95 merged | `3f8be9f` |
| 2026-11-23 | Opus review of #94 FIX FIRST, fixed (`d5fc5b0`), re-review MERGE, #94 merged `84f3026`; CI gap closed (job `Coordination suite`); AGY hardening PR #96 merged `d55c790`; Doc-Cr review of #94 recorded | section 0.7 ("W5b state") |

Planned, in order (a sequence, not dates), with the gate condition of each:

- **S1 remaining waves:** W5b (CLAUDE and AGY: built, to push and open PRs; then the user's live checks), W6 (INST, DOC, SEC, TEST full, opus review of SEC).
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
| S1-AUTH | done (W4a) | PR #65, merged 2026-11-17, `eb09ad5` | S1-STORE schema | 10-16 | checker 8 of 8; no schema change; not wired at merge: production audit store (done by STATE), rate-limit numbers (S3-LIMITS), real tailnet identity source (S2-TS) [reported by its build agent] |
| S1-STATE | done (W4a) | PR #67, merged 2026-11-17, `0ea46ab` | S1-STORE | 14-22 | checker passed all; the Z6 atomic test is real and green [verified] |
| S1-MCP | done (W4b) | PR #68, merged 2026-11-17, `552f00d` | S1-AUTH, S1-STATE | 12-18 | checker 12 of 12; client compatibility with Claude Code and agy unverified; handed on: rest of S1-ID, wake confirmation (S1-WAKE); details in `docs/specs/mcp.md` |
| S1-A2A | done (W4b) | PR #69, merged 2026-11-17, `7444c79` | S1-AUTH, S1-STATE | 16-24 | TCK allowlist reviewed by the user (Z16): 13 entries; TCK gate: 263 cases, 97 passed, 13 failed (all allowed), 153 skipped, 0 blocking, 0 stale [verified]; TCK CI job `.github/workflows/coordination-tck.yml`; front-desk scope per Z13 |
| S1-ADMIN | done (W4b) | PR #71, merged 2026-11-17, `86069be` | S1-AUTH, S1-STATE | 12-18 | admin socket, `a2a-coord`; lean verification (Z12); key-create scope per Z14; the user's hand run (`docs/specs/admin.md` section 11) passed on 2026-11-17, including `/dev/tty` under `docker compose exec -it` [verified]; handed to WAKE: parked-listener close on revoke and `status` listener and budget fields |
| S1-ID | done (W5a) | PR #85, merged 2026-11-21, `56c254d` | S1-MCP | 8-12 | identity, binding, `/sessions`; suite 1283 passed, 3 skipped [verified]; the two [design] questions were decided as Z17; the stream worktree `agentic-hub-wt-id` and branch are still to be removed |
| S1-WAKE | done (W5a) | PR #86, merged 2026-11-21, `0322a9b` (includes Z18, Z19 Fork 2 `7946398`, m0004) | S1-ID | 12-18 | wake, pending, budget, TTL sweep; suite 1368 passed, 3 skipped, wake p99 111.5 ms [verified]; the end-to-end wake test passed 2026-11-21; the stream worktree `agentic-hub-wt-wake` and branch are still to be removed |
| S1-CLAUDE | merged (W5b) | PR #94 merged 2026-11-23 as `84f3026` | S1-WAKE | 6-10 | `bin/a2a-register`, `a2a-listen`, `a2a-pending`, `hooks/hooks.json`, `docs/specs/claude-hooks.md`, the CI job `coordination-suite.yml`; Opus FIX FIRST then MERGE; hook tests 216 passed, runner: 428 hook tests and 1867 in the whole suite [verified]; minors and the Doc-Cr findings are in the follow-up (section 4.2); the user runs live checks (idle wake, `asyncRewake` after Esc, GUI `A2A_API_KEY`) |
| S1-AGY | merged (W5b) | PR #95 `3f8be9f` and the hardening PR #96 `d55c790`, 2026-11-22 and 2026-11-23 | S1-ID, S1-WAKE | 6-10 | `bin/a2a-agy-session`, `a2a-agy-pending`, `agy/hooks.fragment.json`, `docs/specs/agy-hooks.md`; two Opus reviews (MERGE, then FIX FIRST and MERGE for #96); #96: 248 agy hook tests passed [verified]; `.a2a-optout` is a plan [proposal] for the user to confirm; live checks by the user in own agy session; a helper never drives agy |
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
- State 2026-11-14: S1-SCAF, S1-PG and S1-BKP merged; no later stream had started; the lost `claude-cp` session left no code beyond these. State 2026-11-15: S1-STORE (PR #61) and S1-OBS (PR #62) merged; the main-session suite on merged `main` gave 313 passed, 3 skipped [verified]. State 2026-11-17: AUTH, STATE, MCP, A2A and ADMIN merged, W5a running. State 2026-11-20: W5a in PRs #85 and #86 (Z18 built in #86); see section 0.7.

## 4. Todo

Tick a box when it is done and say so in the commit that changes it. Items marked (user) are user-only.

### 4.1 S0 and attended tests

- [x] S0 gate satisfied 2026-11-11 (SP1 to SP5b passed, SP3 passed, SP4 recorded)
- [ ] (user) A8c in agy, signed-out run last (runbook `docs/research/spike-runbook-a8c-agy-open-items-2026-11-09.md`); not started [reported]. It tests the three items A8b left open, same labels and borrow-and-put-back rules as the A8b runbook; the helper never starts or drives agy:. Part 1 (read-only questions) was answered by agy on 2026-11-23 from its docs: `docs/research/spike-results-2026-11-23-a8c-part1-agy.md`. Runs R0 to R3 are still open. Part 2 (validator and a hook probe in a scratch workspace) ran on 2026-11-23: `docs/research/spike-results-2026-11-23-a8c-part2-agy.md`; the user still removes the probe workspace from `trustedWorkspaces`. Part 3 (a workspace-level plugin with bundled hooks and an MCP server) ran the same day: `docs/research/spike-results-2026-11-23-a8c-part3-agy.md`
  - [ ] (1) `.mcp.json` at user level in `~/.gemini/config/plugins/<name>/`: agy's docs say plugin MCP servers load only from `mcp_config.json` and `.mcp.json` is ignored, so R1 is expected to fail and the installer keeps `mcp_config.json` plus a required `plugin.json` (Part 1 answers, `docs/research/spike-results-2026-11-23-a8c-part1-agy.md`; not yet run)
  - [ ] (2) `agy plugin install <path>` and uninstall
  - [ ] (3) tool use while signed out of agy; this changes the real agy login, so it is the LAST run: back up the agy credential files explicitly, put them back, check; the user signs out, the helper never does
- [ ] A8c cleanup with the user: the stub on `127.0.0.1:18120` is already not running (checked 2026-11-21); remove the agy MCP cache entries for it [unverified whether any remain]
- [ ] (user) `asyncRewake` on `UserPromptSubmit` with re-arm after Esc, inside S1 (Y10; design in `server-api` 11.1). [design] Exit test to write: after Esc, the next prompt re-arms the listener and a parked wake still reaches the turn
- [ ] (user) GUI-launched Claude seeing `A2A_API_KEY`, inside S1 (Y10; decision 34). [design] Exit test to write: a GUI-launched session reads the variable; if not, the `~/.claude.json` fallback of decision 34 applies
- [ ] Open from A8b, untested (not blocking): whether agy tool use needs a live sign-in (every successful call was signed in; the startup sign-in warning is harmless); covered by A8c item (3)

### 4.2 S1: now running

- [x] W3a done (STORE PR #61, OBS PR #62, both merged 2026-11-15)
- [x] W4a merged 2026-11-17: AUTH PR #65 (`eb09ad5`), STATE PR #67 (`0ea46ab`)
- [x] W4b merged 2026-11-17: MCP PR #68 (`552f00d`), A2A PR #69 (`7444c79`), ADMIN PR #71 (`86069be`)
- [x] Image-build fix PR #70 (`df95c47`) and image CI job PR #74 (`503fb93`) merged 2026-11-17 (the Jev session's PR #73, `30171b8`, merged between them and is not part of this plan)
- [x] (user) TCK allowlist reviewed and the TCK CI job enabled (Z16, 2026-11-16; PR #69)
- [x] (user) Upstream TCK issue: the draft was not posted, because both problems are already reported upstream (a2aproject/a2a-tck #202, CORE-SEND-003 has no `expected_error`, and #273, HTTP_JSON-ERR-001 versus SVC-001); the user added a +1 to each (2026-11-17)
- [x] (user) S1-ADMIN hand run (`docs/specs/admin.md` section 11), all steps passed 2026-11-17
- [x] W5a: #85 (`56c254d`) then #86 (`0322a9b`) merged on the user's words 2026-11-21; Z19 recorded (master-plan 12.3)
- [x] (user) End-to-end wake test passed 2026-11-21 (section 0.7 item 4)
- [x] W5b built, pushed, PRs opened 2026-11-22 (#94 S1-CLAUDE, #95 S1-AGY); #95 merged `3f8be9f` after an Opus MERGE review
- [x] W5b merged: PR #94 (S1-CLAUDE) `84f3026` and PR #96 (AGY hardening) `d55c790` on 2026-11-23, each after an Opus MERGE review and with green CI on the exact head (the Jev elevation approval had not taken effect for hours; a "for this session" answer finally did)
- [ ] Follow-up PR for the minors of the #94 and #96 reviews and the Doc-Cr findings: leading zeros in `num()` and only the two intended exit 2 paths, the `410 unregistered` retry only at `SessionStart` or without a marker, the zombie owner on macOS without `/proc`, the stale marker on a resume with a bad key, a stricter skip gate (missing attributes, skipped-module allowlist), the `a2a-register` own-dir guard, the `0` count, `a2a-pending` stderr, the spec wording nits of #96, and the user's answer on the attended guard in `a2a-register`
- [x] CI gap closed (merged with #94): job `coordination-suite.yml` runs the hook tests of both harnesses (zero skips, 428 on the runner) and the whole suite with Docker (three expected skips, 1867 passed); gate `scripts/check-pytest-skips.sh` shown to bite locally
- [x] Housekeeping: removed the merged worktrees `agentic-hub-wt-id` and `agentic-hub-wt-wake` and their local branches (2026-11-22)
- [x] Housekeeping: removed the worktrees `agentic-hub-wt-claude`, `agentic-hub-wt-agy` and `agentic-hub-wt-agy2` and the local branches of #94, #95 and #96 (2026-11-23)
- [ ] TEST-skel (planned beside W3a, not done; no dependency blocks it)

Main-session steps after each workflow (no user needed):

- [ ] Read each diff and re-run each stream's suite and acceptance itself
- [ ] `jev_judge` on each diff (weak signal)
- [ ] Push each branch and open one PR per stream, with caveats in the PR body (no merge)
- [ ] Update this file (docs go straight to `main`)

Waiting on the user:

- [x] (user) Merge words for the S1-ID and S1-WAKE PRs (given 2026-11-21)
- [ ] (user) Confirm the `.a2a-optout` proposal (D26, Y7) and give merge words for the S1-CLAUDE and S1-AGY PRs, once they are opened
- [ ] (user) Live checks (W5b): Claude idle wake under 10 s with `claude` at 2.1.290 or later; `asyncRewake` after Esc; GUI-launched Claude seeing `A2A_API_KEY`; agy inbox call in at least 4 of 5 trials; a conversation after `/clear` gets a handle (BP11)
- [ ] (user) Decide whether to stop the coordination test stack on `127.0.0.1:8120` (`docker compose down` keeps the database, `down -v` wipes it)
- [x] W4b order MCP, A2A, ADMIN confirmed by the user on 2026-11-15 (Z8, Z10 to Z15)
- [ ] (user) Provide the secret files (database password, `dump_ro` secret; mode 0600, outside the repo) at W6 (Z7); nothing earlier needs them
- [ ] (user) CLAUDE and AGY live checks (W5b), run the installer (W6); the ADMIN TTY paths are done (hand run 2026-11-17)
- [x] Housekeeping checked 2026-11-15 [verified by the main session]: nothing left to prune in the agy trusted workspaces or the Claude project entry; the Obsidian bearer rotation was decided unnecessary by the user
- [x] PR #58 (`feat/jev-antigravity-hook`) merged into `main` (commit `5ce432b`, 2026-11-15) [verified]
- [x] PR #54 (`feat/jev-tool-validation`) retargeted to `main` (head `2fb323f`), all CI checks passing [verified]
- [x] PR #55 (`feat/jev-agent-guard-parity`) synced with #54 (head `b27937b`), all CI checks passing [verified]
- [x] PR #54 (`feat/jev-tool-validation`) and PR #55 (`feat/jev-agent-guard-parity`) merged 2026-11-17 [verified with `gh pr view`]; Jev work, not part of this plan
- [x] Housekeeping done: the worktrees `.claude/worktrees/ag-hook` and `.claude/worktrees/jev-install` and the local branch `feat/jev-antigravity-hook` no longer exist [verified 2026-11-21]

Blocked until their dependencies merge:

- [x] W4b: MCP, then A2A, then ADMIN (merged 2026-11-17)
- [x] W5a: ID (#85), then WAKE (#86), merged 2026-11-21
- [x] W5b: CLAUDE (PR #94 `84f3026`) and AGY (PR #95 `3f8be9f`, hardening PR #96 `d55c790`) merged
- [ ] W6: INST, DOC, SEC suite, TEST full, opus review of SEC, then GATE
- [ ] S1 exit gate (S1-GATE) passed: two-way task round trip, Claude idle wake, agy surfacing, API key refusal, quarantine end to end

S1 items carried from the old tasklist (the stream that owns each is in brackets; acceptance is in master-plan section 4.2):

- [ ] [STATE, then SEC and GATE] Z6 atomic exit test: a transition, its audit row and its `task_index` update commit in one transaction; a failed audit insert leaves state and version unchanged and no row. The STATE part is merged and the test is green [verified]; the box stays open for SEC and GATE
- [x] [MCP] Tool `a2a_runs`: read-only status, scoped to the caller (kept 2026-11-09, D-I). The tool exists in `mcp/tools.py` and returns an empty `runs` list; its data comes with LT-SRV (`status_runs`), per `docs/specs/mcp.md` [verified 2026-11-21]. The earlier mention of it only under LT-SRV in section 3.6 means "data", not "tool"
- [x] [A2A, MCP, ID, WAKE] Endpoints `/mcp`, `/a2a/v1`, `/wake/listen`, `/wake/pending`, `/sessions`, `/sessions/end`, `/status`, Agent Card: every route is registered in the code on `main` [verified 2026-11-21 by reading the route tables]; client compatibility with Claude Code and agy stays open for the live checks
- [ ] [ID] Server side done (PR #85, Z17); the hook side (the SessionStart text and the register call showing the new form) is built in the W5b branches, unmerged. Session handle grammar `name~sid8` (decisions 2026-11-09 and 2026-11-10, X1; `server-api` 3.5 and 5.1, evidence SP2 C6 pair 3): `register` and `a2a_hello(name=...)` build `<card-id>/<name>~<sid8>` on the server, `~` plus the first 8 hex characters of the session id always present; session-part regex `^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$`; handle validation in `coord.to`, `a2a_hello(handle)` and the hook scripts' check of the returned handle; server-side uniqueness, a same-`<sid8>` collision rejected by a clear error [design]; the SessionStart text and the register call show the new form. Open [design]: the unnamed-session form (`server-api` 3.5, two readings)
- [x] [AUTH, ADMIN] Done on `main` (PRs #65 and #71; the ADMIN hand run 2026-11-17 and the end-to-end wake test 2026-11-21 used real keys and `review release`). API keys (`a2a-coord key create|list|rotate|revoke`, `a2ak_<env>_<keyid>_<secret>`) and `a2a-coord review`, run inside the container over the unpublished admin socket (decisions 15 and 24)
- [ ] [CLAUDE, AGY] Merged (PR #95, PR #94, PR #96); open until the user's live checks pass. Claude Code hooks (`a2a-listen`, `UserPromptSubmit`) and agy hooks (user-level `~/.gemini/config/hooks.json`, decision 26), MCP entries, and the agy inbox instruction through `SessionStart` `injectSteps` (decision 27; no `AGENTS.md` is written). Hook scripts copied to `~/.local/share/a2a-coord/<version>/bin/` with a `current` symlink (decision 28)
- [ ] [INST] Installer `a2a-coord install --claude --agy`: non-secret parts of chezmoi-managed files through chezmoi; Claude key from the unmanaged 0600 `~/.config/a2a-coord/api-key`, exported as `A2A_API_KEY` by one non-secret chezmoi-managed shell line, with a `~/.claude.json` fallback if the GUI test shows no env expansion (decision 34); agy key literal in the unmanaged `~/.gemini/config/plugins/<name>/mcp_config.json` (mode 0600); no key in any chezmoi-managed file (decisions 16, 24, 34); never writes an `AGENTS.md`, refuses to write through symlinks (decision 27); `a2a-coord install --rotate-key` rotates the key file
- [ ] [INST] Installer agy placement rules from SP2 A8b (decision 24, `server-api.md` 11.0): the plugin `<name>` is unique across user and workspace scopes; never ship a workspace plugin with the same name; the post-install health check makes a real tool call (`a2a_hello` or `a2a_inbox`), not only a connection check; fallback if the placement breaks is the `agy mcp add` global entry, which reopens decision 24 with the user. The A8c result sets the final placement
- [ ] [INST] Musts from the Opus reviews of PR #94 and #95 (2026-11-22 and 2026-11-23): write the agy hook `command` paths as the absolute path of `current` (whether agy expands `~` is unverified); set `A2A_AGY_CARD` or check the host name against the key's card (the default comes from `uname -n`, wrong under WSL and on the mac, and a wrong card is a silent 403); give the Claude hooks their card the same way, from a 0600 file next to the key file (`~/.config/a2a-coord/card`), because a GUI-launched Claude has no `A2A_CARD`
- [ ] [INST] From agy's documentation answers (2026-11-23, `docs/research/spike-results-2026-11-23-a8c-part1-agy.md`): the agy plugin needs `plugin.json` and `mcp_config.json` (`.mcp.json` is ignored); the hook `command` may use `~` (documented, not yet run) but keep the absolute path until a live check; `A2A_AGY_CARD` from the shell reaches the hooks (verified in the part 2 probe for a terminal-started agy; a GUI-started agy is not tested), so bake the card into the hook command or read it from a 0600 file next to the key anyway; a plugin placed with `agy plugin install` is replaced on update, which would lose a literal key in its `mcp_config.json`, so decision 34 needs a look before the installer writes it ([design]: place by copying as in A8b, or use the documented plugin MCP `variables`); `agy plugin validate [--json] <dir>` is a read-only check the installer's health check or the user could run
- [ ] [INST] From the A8c part 2 probe (2026-11-23, `docs/research/spike-results-2026-11-23-a8c-part2-agy.md`), all verified in a project-level `hooks.json`: `&`, `<`, `>` reach the hooks as `&`, `<`, `>` (PR #96 decodes them); `~` in the hook `command` works; the hook's working directory is the folder of the `hooks.json`; a hook with `timeout: 3` was killed after 3.0 s and a `PreInvocation` hook delays the model call by up to its timeout; project hooks load only after the trust dialog (trust or exit). The user removes the probe workspace from `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`. **[design] to put to the user at S1-INST:** one agy plugin directory with `plugin.json` (`name` and `version` set), `mcp_config.json`, `hooks.json` and the scripts, placed by copying into `~/.gemini/config/plugins/<name>/` (docs: active in all workspaces, hooks get `PLUGIN_ROOT`), instead of merging into the shared `~/.gemini/config/hooks.json` (decision 26, Y9); untested at run time, a workspace-level plugin probe in the scratch folder would test it without touching user config
- [ ] [INST] From the A8c part 3 probe (2026-11-23, `docs/research/spike-results-2026-11-23-a8c-part3-agy.md`), verified with a workspace-level plugin in `.agents/plugins/<name>/`: a plugin folder with `plugin.json` (`name`, `version`), `hooks.json`, `hooks/*.sh` and `mcp_config.json` activates without `agy plugin install`; hooks run with the plugin folder as the working directory and `PLUGIN_ROOT` set (`PLUGIN_DATA` unset for a non-installed plugin), relative commands resolve, the environment is inherited, a `timeout` kills a hook; a plugin MCP server on a closed port logs only a 30 s "still connecting" line and does not delay the first reply (so the health check must make a real `a2a_hello`). Decided by the user on 2026-11-23 as Z20 (master-plan 12.3): every harness integration is a plugin built like one; for agy, one plugin directory copied into `~/.gemini/config/plugins/<name>/`, no merge into the shared `hooks.json` (revises D26 and D28 for agy); the installer copies and never uses `agy plugin install`; left open: the plugin name, whether the scripts of all harnesses are generated from one source, how the Claude plugin is listed (manifest location and marketplace entry: `claude plugin validate plugins/coordination` currently fails); the user-level placement itself is still unrun
- [ ] [INST] Y9 installer rules: merge into `~/.gemini/config/hooks.json` by its own key only, byte-copy backup first, re-read right before writing, atomic write
- [ ] [AGY] Merged in PR #95 (`3f8be9f`; no `Stop` entry, always exit 0 with `{}`) and hardened in PR #96 (`d55c790`); open until the live trials pass. Y5 and Y6 hook shape: `systemMessage` with the tested dedupe, connect timeout about 200 ms, always exit 0 with `{}`, no throttle
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
- **A8c stub.** Nothing listens on `127.0.0.1:18120` now (checked 2026-11-21); it was reported up on 2026-11-15. Acceptance runs still use another port. Remove the agy MCP cache entries for it only at A8c cleanup, with the user.
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
- **Jev PR stack (#58, #54, #55):** all merged (#58 `5ce432b` on 2026-11-15; #54 and #55 on 2026-11-17 [verified 2026-11-21]); the old worktrees are gone. Jev work, not part of this plan.
- **Shared checkout.** `ce-research` switches branches in `~/projects/agentic-hub`. The coordination work uses its own worktrees (`agentic-hub-wt-<stream>`), removed after the stream merges; another session must not touch the worktree of a running build, and nobody commits in the shared checkout.
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
