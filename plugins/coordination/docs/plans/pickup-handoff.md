# Pickup handoff: continuing the coordination plugin in a new session

Written 2026-11-09, updated 2026-11-10 after SP5b passed and S1 design items resolved. Read this file first; it points to the authoritative documents and does not replace them. Labels follow the repo: **verified** (read or observed), **reported** (a claim not reproduced), **unverified**.

## 1. Where the project stands

- The project is **planning-only**. Implementation is allowed only where a spike strictly needs it (DDR-004, decision 1). Nothing listens on a real port yet and no server code exists.
- Stage S0 (spikes) is **complete**: SP1, SP2 (Claude and agy halves, A8b), SP5 (SQLite), and **SP5b (Postgres on alyx)** passed with spec changes folded in. S1 entry gate is satisfied.
- On 2026-11-10, SP5b ran on alyx and **passed** all acceptance gates (full report: `docs/research/spike-results-2026-11-10-sp5b.md`, committed in `946f198`):
  - **Pinned Postgres image**: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (D-B, R3).
  - **D3 (Lost-update CAS)**: 300 rounds, 0 lost updates, 0 double takes, transition p99 10.13 ms.
  - **D7 (Backup sidecar under load)**: `pg_dump -Fc` via `dump_ro` in 0.73 s, `pg_restore --list` verified 71 entries, restore into scratch DB with 100% count match (722/722), Alembic at head (`b5e3d1c8a2f7`).
  - **D8 (Crash resilience under load)**: 2x `kill -9` of server + Postgres container restart, 0 lost acked writes (336 creates, 296 completions, 40 cancels), level-triggered park re-offer verified.
  - **D2 (10-min mixed load benchmark)**: 1,986 tasks, 0 unhandled DB errors, loop lag p99 2.41 ms, wake p99 2.8 ms, store.save p99 17.25 ms, transition.versioned p99 18.66 ms, 0 deadlocks with `SEED_VERSION=1`.
  - **Separator check**: `#` and `~` validated across URL query (%23), shell quoting, JSON, and Postgres DB. `name#sid8` adopted.
- All four S1 `[design]` items were resolved in `docs/specs/server-api.md` (commit `c17402b`):
  - `dump_ro` password delivery via secret `a2a_pg_dump_password` mounted `mode: 0444` in Postgres for `01-init.sh`, and `mode: 0400` in dump sidecar read into `/tmp/.pgpass` (`mode 0600`).
  - Rate-limit guess counter scope: handle-addressed sends (`coord.to: "<card>/<name>#<sid8>"`) participate in 10/60s rate limit; card-addressed sends bypass guess counter.
  - Restic repo path for second job: `rclone:gdrive:backups/restic-a2a`, tag `a2a-dumps`.
  - `a2a-coord expose check` evidence rules and exit codes documented.
- Decisions from 2026-11-09 `/clarify` rounds:
  - **D-A to D-J:** Postgres in the compose project from S1 (reverses decision 4's SQLite), SP5b gate, 8121 public listener, handle addressing, A8c, final extension URI at S3.
  - **R1 to R8:** handle guess counter, DB password via secret file, exact image pin, dump sidecar, retention, `a2a-data` for import artefacts only, SP5b failure rule, 8121 listener from stage s2.
  - **R9 to R14:** dumps in `/media/media2/backup/a2a/` plus a second restic job, guess counter numbers (10 misses per 60 s, 429), read-only role `dump_ro`, `pg_dump -Fc` verified with `pg_restore --list`, manual s3 flip after `a2a-coord expose check`, compose profile `backup`.
  - **Handle grammar `name#sid8`:** adopted across all specs, plans, and tasklists (commit `db17ada`).

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

1. **[DONE] In-flight docs commit**: Committed `db17ada` adopting `name#sid8` grammar across specs, plans, and tasklist.
2. **[DONE] SP5b spike on alyx (S1 entry gate)**: Executed in `/home/rockad/scratch/a2a-spikes/sp5b/`. Passed all gates (0 lost updates, 0 lost acked writes, p99 write 18.66 ms, 0 deadlocks, `#` separator verified). Scratch containers destroyed, ports released. Documented in `docs/research/spike-results-2026-11-10-sp5b.md`, updated `spikes.md` and `master-tasklist.md` (commit `946f198`).
3. **[DONE] Resolve S1 `[design]` items**: Fully documented in `docs/specs/server-api.md` 12.2 (`dump_ro` secrets, guess counter scope, restic path, expose check exit codes) (commit `c17402b`).

### Verification checklist for Claude Code pickup session

Before picking up new workstreams, Claude Code should verify the committed state:
- [ ] Inspect git log: `git -C /home/rockad/projects/agentic-hub-wt-main log -4 --oneline` (`db17ada`, `946f198`, `c17402b`, and this handoff commit).
- [ ] Read `plugins/coordination/docs/research/spike-results-2026-11-10-sp5b.md` and verify against Section 11 of `docs/specs/spikes.md`.
- [ ] Read `plugins/coordination/docs/specs/server-api.md` Section 12.2 to confirm the 4 resolved S1 design items.
- [ ] Read `plugins/coordination/docs/plans/master-tasklist.md` Section 4 to confirm S0-SP5B is checked off.

### Tasks that need the user or an attended session

- **A8c** (agy): `.mcp.json` at user level, `agy plugin install`, and a signed-out run last (it changes the real agy login). Runbook: `docs/research/spike-runbook-a8c-agy-open-items-2026-11-09.md`.
- **SP3 and SP4** (agy hooks), the **`asyncRewake` on `UserPromptSubmit`** test and the **GUI-launched Claude** test (decision 34; both run inside S1 with their own exit tests).
- **Installing the second restic script and its crontab line on `core`** (the installer prints them; it never edits `core`'s crontab).
- **The S3 go** (create the Cloudflare Tunnel route to `127.0.0.1:8121`), and the user's own housekeeping: rotate the Obsidian MCP bearer in `~/scratch/a2a-spikes/runlogs/chezmoi-diff.baseline` and delete that file, prune `sp2-agy` and `sp2-agy-a8b` from `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`, remove the `sp1` project entry from `~/.claude.json`.
- **S1 dev server implementation kickoff** (when ready, proceeding with task S1-PG and compose scaffold per `implementation-plan.md`).

## 4. How spikes are run (process rules)

- Roles: the **helper** is an attended Claude Code session that never launches, drives or probes agy; the **user** starts agy and copies files; **Antigravity** answers prompts and writes its results file; the helper reads logs.
- Scratch work lives under `~/scratch/a2a-spikes/` (alyx-local, not in git): helper briefs, `stub/`, `sp1/` to `sp5b/`, `agy-operator/` prompts, `runlogs/`. Borrow and put back (decision 25): back up before touching user config, verify the restore, never print a token (the string `spike-token` is allowed).
- A background Claude Code job has `CLAUDE_CODE_SESSION_ATTENDED=0`, which breaks the wake-listener tests; those need an attended session.
- Listener owner pid is `$CLAUDE_PID`, not `$PPID`. Details are in `docs/research/spike-results-2026-11-05-sp1.md`.

## 5. Environment facts

- **alyx** (WSL2 workstation): spikes and dev. Docker, `uv`, `bun` are installed. Scratch ports: stub 18120, SP5 18125 to 18127, SP5b 18130 to 18132 (loopback only, all torn down).
- **core** (`192.168.1.90`, verified over ssh on 2026-11-09): Raspberry Pi 5 Model B Rev 1.0, 4 cores at 2.4 GHz, 8 GB RAM, Debian 12 aarch64, Docker 29.x, user in the docker group. Read-only ssh is fine; ask the user before anything needing root or a restart on `core`. The existing restic job is `/media/media2/knowledge-archive/ops/restic-backup.sh` (user crontab, 05:30, single source). Speed is not a concern (user, 2026-11-09).
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
- `db17ada`: `docs(coordination): adopt name#sid8 grammar across specs, plans, and tasklist`
- `946f198`: `docs(coordination): record SP5b pass and S1 entry gate satisfaction`
- `c17402b`: `docs(coordination): resolve S1 design items (dump_ro secret, guess counter, restic repo, expose check)`
- (Current): `docs(coordination): update pickup handoff with SP5b pass and S1 design resolutions`

## 9. Open questions and next steps

- **Postgres image pin settled**: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (D-B, R3).
- **Guess counter scope settled**: Handle-addressed sends (`coord.to: "<card>/<name>#<sid8>"`) participate in 10/60s rate limit; card-addressed sends bypass guess counter.
- **Still open for user confirmation**:
  - Whether to commit the SP5 and SP5b scratch drivers into the repo so a session on another machine can run them; today they exist only on alyx in `~/scratch/a2a-spikes/`.
  - Attended spike runs (A8c, SP3/SP4).
