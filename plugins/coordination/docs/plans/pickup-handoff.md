# Pickup handoff: continuing the coordination plugin in a new session

## Start here (copy this into a new Antigravity or Claude Code session)

```
You are continuing the A2A coordination plugin work (repo agentic-hub, folder plugins/coordination). The project is planning-only.
1. Read plugins/coordination/AGENTS.md, then docs/plans/pickup-handoff.md (this file), then docs/plans/master-tasklist.md section 4.
2. Verify the state before acting: git fetch; git log --oneline -8 origin/main; git status. Check every claim in a doc against its evidence file. The S1 entry gate is NOT open (SP3 and SP4 are still open).
3. Work only in your own git worktree: git worktree add ../agentic-hub-wt-<you> -b <branch> origin/main. Never commit in /home/rockad/projects/agentic-hub (it is shared with another session). Stage explicit paths only. Never push main, tag or release without the user's go.
4. Take the first item of section 3 "What to do next" that needs no user input. Ask the user before anything marked needs user (agy runs, attended spikes, core crontab, hygiene items).
5. Decisions in the plan's decision tables are final: do not reopen them. Anything the docs leave open stays marked [design] or [unverified]; do not invent it.
6. Label every statement verified, reported or unverified. Never print a secret or a token. Use vertical lists, absolute dates, and the editor's Edit tool for file changes.
7. Never launch, drive or probe the Antigravity CLI (agy) as a helper; the user starts agy and agy answers prompts. In Claude Code, run Jev's pre-flight before delegating non-trivial work.
8. When you finish a step: update section 3 and section 8 of this file and the master tasklist, commit, then tell the user what changed and what is next.
```

Written 2026-11-09, updated 2026-11-10 after SP5b passed, S1 design items were resolved and the round-4 decisions (X1 to X5) and audit corrections (C1 to C5) were applied. Read this file first; it points to the authoritative documents and does not replace them. Labels follow the repo: **verified** (read or observed), **reported** (a claim not reproduced), **unverified**.

## 1. Where the project stands

- The project is **planning-only**. Implementation is allowed only where a spike strictly needs it (DDR-004, decision 1). Nothing listens on a real port yet and no server code exists.
- Stage S0 (spikes) is **not complete**. SP1, SP2 (Claude and agy halves, A8b), SP5 (SQLite) and **SP5b (Postgres on alyx)** passed with spec changes folded in. S1 storage gate satisfied by SP5b; overall S1 entry gate is NOT yet satisfied while SP3 (agy `PreInvocation`) and SP4 (record only), both still open in `docs/specs/spikes.md` section 11 and in the tasklist.
- An independent audit of the overnight SP5b work is in `docs/research/audit-2026-11-10-sp5b-s1-gate.md` (agy's audit, moved out of this handoff; not rewritten). Its findings are applied as C1 to C5 in the docs; read the audit file for its own wording.
- On 2026-11-10, SP5b ran on alyx and **passed** all acceptance gates (full report: `docs/research/spike-results-2026-11-10-sp5b.md`, committed in `946f198`; measured numbers unchanged, three corrections added: C1 gate wording, C2 the D7 outlier, C3 the deadlock count):
  - **Pinned Postgres image**: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (D-B, R3).
  - **D3 (Lost-update CAS)**: 300 rounds, 0 lost updates, 0 double takes, transition p99 10.13 ms.
  - **D7 (Backup sidecar under load)**: `pg_dump -Fc` via `dump_ro` in 0.73 s, `pg_restore --list` verified 71 entries, restore into scratch DB with 100% count match (722/722), Alembic at head (`b5e3d1c8a2f7`).
  - **D8 (Crash resilience under load)**: 2x `kill -9` of server + Postgres container restart, 0 lost acked writes (336 creates, 296 completions, 40 cancels), level-triggered park re-offer verified.
  - **D2 (10-min mixed load benchmark)**: 1,986 tasks, 0 unhandled DB errors, loop lag p99 2.41 ms, wake p99 2.8 ms, store.save p99 17.25 ms, transition.versioned p99 18.66 ms, 0 deadlocks inferred from an empty `db_errors` count (no separate deadlock counter in the logs; C3). A 1,036.82 ms `CancelTask` outlier during the D7 dump has an unverified cause (C2); the 200 ms p99 gate was evaluated on D2 only.
  - **Separator check**: `#` and `~` validated across URL query (%23 for `#`), shell quoting, JSON, and Postgres DB. Verdict (X1): `#` needs `%23` in URL queries; `~` adopted by user decision 2026-11-10.
- The five S1 `[design]` points of commit `c17402b` were proposals by the overnight agy run, not settled facts. The user decided them on 2026-11-10 in a fourth `/clarify` round (X1 to X5); the docs follow these decisions, and `docs/specs/server-api.md` 12.2 and the tasklist were aligned to them in the same round:
  - X1, handle grammar: `card/name~sid8` (for example `claude-code@alyx/c6-same~3f2a9c1d`), session part regex `^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$`; replaces the `#` separator of commit `db17ada`. `@` and `/` stay (legal in a URL query string); `#` is rejected (URL fragment, needs `%23`).
  - X2, `dump_ro` password: the host command `a2a-coord db init-dump-role` (idempotent; run by the installer after Postgres is up and again on rotation) feeds `psql` in the Postgres container over stdin. The secret file is mounted only into the sidecar; no init script mounts it into Postgres. The D7 role setup is retested through the command route in the SP5b follow-up.
  - X3, guess counter scope: handle-addressed sends only ("not available" answers). Card-addressed sends stay outside it (403 `CardNotAllowed`, not counted) and stay under the per-key `SendMessage` limit of 10 per minute.
  - X4, second restic job: repository `rclone:gdrive-aleks:backups/restic-a2a`, password file `~/.config/a2a-coord/restic-password` (mode 0600, created by the user), cron `45 5 * * *` in core's local time (Europe/Helsinki), `restic forget --keep-last 3 --prune --tag a2a-dumps`, source `/media/media2/backup/a2a/`.
  - X5, `a2a-coord expose check`: exit 0 all met, 1 at least one unmet, 2 could not evaluate. Runtime checks now; fuzz report, honest card and extension URI listed as manual until S3 ([design], task S3-EXPOSE-CHECK).
- Decisions from 2026-11-09 `/clarify` rounds:
  - **D-A to D-J:** Postgres in the compose project from S1 (reverses decision 4's SQLite), SP5b gate, 8121 public listener, handle addressing, A8c, final extension URI at S3.
  - **R1 to R8:** handle guess counter, DB password via secret file, exact image pin, dump sidecar, retention, `a2a-data` for import artefacts only, SP5b failure rule, 8121 listener from stage s2.
  - **R9 to R14:** dumps in `/media/media2/backup/a2a/` plus a second restic job, guess counter numbers (10 misses per 60 s, 429), read-only role `dump_ro`, `pg_dump -Fc` verified with `pg_restore --list`, manual s3 flip after `a2a-coord expose check`, compose profile `backup`.
  - **Handle grammar:** `name#sid8` was adopted across specs, plans and tasklists in commit `db17ada`; round-4 X1 replaces the separator with `~` (`name~sid8`).

## 2. Read in this order

1. `plugins/coordination/AGENTS.md` and `README.md` (orientation and rules).
2. `docs/plans/master-tasklist.md` (the living task list; section 4 is the plugin workstreams).
3. `docs/plans/consolidated-bridge-v2-plan.md`: decisions 4, 6, 8, 16, 20, 24, 26 and 37 to 40; the S0 status block; the "Still open" list.
4. `docs/specs/spikes.md`: section 8 and 8b (SP5 and SP5b), section 11 (the S1 entry gate and its status), the A8b and A8c entries.
5. `docs/specs/server-api.md`: 1.2 and 1.4 (storage and compose), 5.2 (handle addressing), 5.4 (session binding), 8.4.1 (public listener), 11 (installer and hooks), 12.2 (S1 design details).
6. `docs/plans/implementation-plan.md` (task ids such as S0-SP5B, S1-PG, S1-BKP, S2-LISTEN, S3-EXPOSE-CHECK) and `docs/plans/go-live-migration.md`.
7. Spike evidence under `docs/research/spike-results-*` (especially `spike-results-2026-11-10-sp5b.md`) and runbooks `spike-runbooks-2026-11-05.md`, `spike-runbook-a8b-*.md`, `spike-runbook-a8c-*.md`.

## 3. What to do next, in order

### Completed unattended overnight tasks (verified on `main`)

1. **[DONE] In-flight docs commit**: Committed `db17ada` adopting `name#sid8` grammar across specs, plans, and tasklist (the separator is replaced by `~` in round 4, X1).
2. **[DONE] SP5b spike on alyx (S1 storage gate)**: Executed in `/home/rockad/scratch/a2a-spikes/sp5b/`. Passed all gates (0 lost updates, 0 lost acked writes, p99 write 18.66 ms on D2, 0 deadlocks inferred from an empty `db_errors` count). Scratch containers destroyed, ports released. Documented in `docs/research/spike-results-2026-11-10-sp5b.md`, updated `spikes.md` and `master-tasklist.md` (commit `946f198`).
3. **[DONE, superseded in part] S1 `[design]` items**: first written into `docs/specs/server-api.md` 12.2 by commit `c17402b`; the user's round-4 decisions X1 to X5 replace its values for the separator, the `dump_ro` secret, the guess counter scope, the restic job and the expose check.

### Verification checklist for Claude Code pickup session

Before picking up new workstreams, Claude Code should verify the committed state:
- [ ] Inspect git log: `git -C /home/rockad/projects/agentic-hub-wt-main log -8 --oneline` (it includes `db17ada`, `946f198`, `c17402b`, the handoff commit `3a2bea8`, and the round-4 docs commit once it exists).
- [ ] Read `plugins/coordination/docs/research/spike-results-2026-11-10-sp5b.md` and verify against Section 11 of `docs/specs/spikes.md`.
- [ ] Read `plugins/coordination/docs/research/audit-2026-11-10-sp5b-s1-gate.md` for the audit that led to corrections C1 to C5.
- [ ] Read `plugins/coordination/docs/specs/server-api.md` Section 12.2 and confirm it carries the round-4 values X1 to X5.
- [ ] Read `plugins/coordination/docs/plans/master-tasklist.md` Section 4 to confirm S0-SP5B is checked off and that SP3 and SP4 are still open.

### Next actions, in order

1. **SP3 and SP4** (agy hooks): the blockers of the overall S1 entry gate. They need an attended session or an agy run. SP3 is agy `PreInvocation`; SP4 is record only.
   - A helper pack for SP3 and SP4 is prepared in `~/scratch/a2a-spikes/` (alyx-local, not in git): `helper-brief-sp3-sp4.md` and `agy-operator/sp3-sp4-*.md`.
   - The SP5b follow-up is done (2026-11-10, non-gating): results in `docs/research/spike-results-2026-11-10-sp5b-followup.md`, Claude Code's independent check in its section 7. Verdicts: (a) PASS for the mechanism, (b) PASS, (c) cause UNVERIFIED. The agy-reported items without a saved log are carried as exit tests of S1-PG and S1-BKP.
2. **At S2 (the user):** create the restic password file `~/.config/a2a-coord/restic-password` (mode 0600) and install the second restic job on core from the text the installer prints (X4).
3. After SP3 and SP4 are recorded and the user gives the go: S1 dev server kickoff (task S1-PG and compose scaffold per `implementation-plan.md`).

### Tasks that need the user or an attended session

- **A8c** (agy): `.mcp.json` at user level, `agy plugin install`, and a signed-out run last (it changes the real agy login). Runbook: `docs/research/spike-runbook-a8c-agy-open-items-2026-11-09.md`.
- **SP3 and SP4** (agy hooks), the **`asyncRewake` on `UserPromptSubmit`** test and the **GUI-launched Claude** test (decision 34; both run inside S1 with their own exit tests).
- **Creating the restic password file and installing the second restic script and its crontab line on `core`** (at S2; the installer prints the script and the line; it never edits `core`'s crontab and never writes into the knowledge-archive git repo).
- **The S3 go** (create the Cloudflare Tunnel route to `127.0.0.1:8121`), and the user's own housekeeping: rotate the Obsidian MCP bearer in `~/scratch/a2a-spikes/runlogs/chezmoi-diff.baseline` and delete that file, prune `sp2-agy` and `sp2-agy-a8b` from `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`, remove the `sp1` project entry from `~/.claude.json`.
- **S1 dev server implementation kickoff** (only after the overall S1 entry gate is closed: SP3 and SP4 recorded; then task S1-PG and compose scaffold per `implementation-plan.md`).

## 4. How spikes are run (process rules)

- Roles: the **helper** is an attended Claude Code session that never launches, drives or probes agy; the **user** starts agy and copies files; **Antigravity** answers prompts and writes its results file; the helper reads logs.
- Scratch work lives under `~/scratch/a2a-spikes/` (alyx-local, not in git): helper briefs, `stub/`, `sp1/` to `sp5b/`, `agy-operator/` prompts, `runlogs/`. Borrow and put back (decision 25): back up before touching user config, verify the restore, never print a token (the string `spike-token` is allowed).
- A background Claude Code job has `CLAUDE_CODE_SESSION_ATTENDED=0`, which breaks the wake-listener tests; those need an attended session.
- Listener owner pid is `$CLAUDE_PID`, not `$PPID`. Details are in `docs/research/spike-results-2026-11-05-sp1.md`.

## 5. Environment facts

- **alyx** (WSL2 workstation): spikes and dev. Docker, `uv`, `bun` are installed. Scratch ports: stub 18120, SP5 18125 to 18127, SP5b 18130 to 18132 (loopback only, all torn down).
- **core** (`192.168.1.90`, verified over ssh on 2026-11-09): Raspberry Pi 5 Model B Rev 1.0, 4 cores at 2.4 GHz, 8 GB RAM, Debian 12 aarch64, Docker 29.x, user in the docker group. Read-only ssh is fine; ask the user before anything needing root or a restart on `core`. The existing restic job is `/media/media2/knowledge-archive/ops/restic-backup.sh` (user crontab, 05:30, single source). Verified read-only on 2026-11-10: the rclone remotes are `gdrive-aleks:` and `odrive-aleks:`, core's time zone is Europe/Helsinki (cron runs in local time) and `/media/media2/knowledge-archive` is a clean git repo. Speed is not a concern (user, 2026-11-09).
- Ports in the design: 8120 tailnet listener, 8121 public listener (loopback only; the tunnel route is the exposure gate).
- Shell tools: prefer `jq`, `yq`, `rg`, `fd`, `sd`; edit files with the editor's Edit tool, never a script read-replace-write. In zsh a variable holding several lines is not word-split; loop with `while read`.

## 6. Repository and commit rules

- The `agentic-hub` checkout at `/home/rockad/projects/agentic-hub` is **shared** with another Claude session (`ce-research`, owner of the cross-repo plan and the cognitive-engine port) that switches branches in it. Always run `git branch --show-current` before committing. Commit `main` from a worktree: `git worktree add ../agentic-hub-wt-main main` (exists on alyx), stage explicit paths only (no `git add -A`, no `commit -a`), `git fetch` before pushing.
- Never edit `ce-research`'s branch (`docs/clarify-decisions-2026-11-09`, PR #20), its files or the pr-plan; send it a message instead (`SendMessage` to `ce-research`).
- Commit and push only when the user asks. End commit messages with the attribution lines the harness gives.
- Check a branch against `origin/main` only after `git fetch`; a stale local `main` caused one wrong conclusion on 2026-11-09.
- Vertical lists only in docs, absolute dates, no secrets, no invented facts: mark open items `[design]` or `[unverified]`.

## 7. Models and delegation

- Claude Code: subagents default to Sonnet; Opus only for judgements whose error is expensive and for one final verification; pass the model explicitly. Antigravity: inherit the session model; the `pro` tier needs the user's approval. The mapping table is in the user-level `AGENTS.md` (`~/.gemini/config/AGENTS.md` and `~/.claude/CLAUDE.md`).
- Jev mode is `on`: call `jev_batch_dispatch` before delegating non-trivial work and `jev_judge` on diffs, and say so. Known defects of the dispatch tool (a substring keyword rule, Antigravity vocabulary, wrong session model) are in `plugins/jev/docs/case-studies/2026-11-09-model-tier-for-multi-stream-workflow.md`; treat its output as advice, not an instruction.
- Docs workflows that edit many files should give each agent a disjoint file set and finish with a consistency pass: cross-file races produced stale references twice.

## 8. In flight / Commits on `main`

The following commits are on `main` and pushed to `origin/main`:
- `db17ada`: `docs(coordination): adopt name#sid8 grammar across specs, plans, and tasklist` (separator replaced by `~` in round 4, X1)
- `946f198`: `docs(coordination): record SP5b pass and S1 entry gate satisfaction` (the commit message predates C1: SP5b satisfies the S1 storage gate only)
- `c17402b`: `docs(coordination): resolve S1 design items (dump_ro secret, guess counter, restic repo, expose check)` (values replaced by X2 to X5)
- `3a2bea8`: `docs(coordination): update pickup handoff with SP5b pass and S1 design resolutions` (its gate wording and "settled" statements are corrected by C1 and C5)
- Round-4 docs (X1 to X5, C1 to C5) are an uncommitted working-tree change until the user asks for a commit.

## 9. Open questions and next steps

- **Postgres image pin settled**: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (D-B, R3).
- **Guess counter scope (X3)**: the counter covers handle-addressed sends only ("not available" answers). Card-addressed sends are outside it (403 `CardNotAllowed`) and stay under the per-key `SendMessage` limit of 10 per minute; card existence is public by design (D32), so there is nothing to enumerate.
- **Still open for user confirmation**:
  - Whether to commit the SP5 and SP5b scratch drivers into the repo so a session on another machine can run them; today they exist only on alyx in `~/scratch/a2a-spikes/`.
  - Attended spike runs (A8c, SP3/SP4).
