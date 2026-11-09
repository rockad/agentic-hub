# Pickup handoff: continuing the coordination plugin in a new session

Written 2026-11-09 for a fresh Antigravity session or another Claude Code (Pro) session. Read this file first; it points to the authoritative documents and does not replace them. Labels follow the repo: **verified** (read or observed), **reported** (a claim not reproduced), **unverified**.

## 1. Where the project stands

- The project is **planning-only**. Implementation is allowed only where a spike strictly needs it (DDR-004, decision 1). Nothing listens on a real port yet and no server code exists.
- Stage S0 (spikes) is mostly done: SP1, SP2 (Claude and agy halves, A8b) and SP5 (SQLite) passed with spec changes folded in. S1 (dev server on alyx) has not started.
- On 2026-11-09 the user made 24 more decisions in three `/clarify` rounds, all recorded in the docs:
  - **D-A to D-J:** Postgres in the compose project from S1 (reverses decision 4's SQLite), SP5b gate, 8121 public listener, handle addressing, A8c, final extension URI at S3.
  - **R1 to R8:** handle guess counter, DB password via secret file, exact image pin, dump sidecar, retention, `a2a-data` for import artefacts only, SP5b failure rule, 8121 listener from stage s2.
  - **R9 to R14:** dumps in `/media/media2/backup/a2a/` plus a second restic job, guess counter numbers (10 misses per 60 s, 429), read-only role `dump_ro`, `pg_dump -Fc` verified with `pg_restore --list`, manual s3 flip after `a2a-coord expose check`, compose profile `backup`.
  - **Handle grammar `name#sid8`:** always present, 8 hex; separator tested against `~` in SP5b. Applied to the docs in a separate commit (see section 8).

## 2. Read in this order

1. `plugins/coordination/AGENTS.md` and `README.md` (orientation and rules).
2. `docs/plans/master-tasklist.md` (the living task list; section 4 is the plugin workstreams).
3. `docs/plans/consolidated-bridge-v2-plan.md`: decisions 4, 6, 8, 16, 20, 24, 26 and 37 to 40; the S0 status block; the "Still open" list.
4. `docs/specs/spikes.md`: section 8 and 8b (SP5 and SP5b), section 11 (the S1 entry gate and its status), the A8b and A8c entries.
5. `docs/specs/server-api.md`: 1.2 and 1.4 (storage and compose), 5.2 (handle addressing), 5.4 (session binding), 8.4.1 (public listener), 11 (installer and hooks).
6. `docs/plans/implementation-plan.md` (task ids such as S0-SP5B, S1-PG, S1-BKP, S2-LISTEN, S3-EXPOSE-CHECK) and `docs/plans/go-live-migration.md`.
7. Spike evidence under `docs/research/spike-results-*` and the runbooks `spike-runbooks-2026-11-05.md`, `spike-runbook-a8b-*.md`, `spike-runbook-a8c-*.md`.

## 3. What to do next, in order

Tasks that need no input from the user:

1. **Finish the in-flight commits.** Check `git log` and `git status` first; section 8 lists what was running when this was written.
2. **Run SP5b on alyx** (S1 entry gate). Method: `docs/specs/spikes.md` section 8b. Summary:
   - Work in `~/scratch/a2a-spikes/sp5b/` (reuse `~/scratch/a2a-spikes/sp5/` drivers and `srv-pg.sh`; these are alyx-local and not in git).
   - Tests: D3 lost-update on the versioned store, D7 `pg_dump -Fc` backup with `pg_restore --list` and a restore integrity check, D8 `kill -9` of the server and restart of the Postgres container with zero lost acked writes, the D2 load mix including the session-register and budget-counter writes SP5 skipped, plus the `#` versus `~` handle-separator check.
   - Pass: 0 lost updates, 0 lost acked writes, p99 write under 200 ms. Pick the exact Postgres tag and record its digest (R3).
   - Failure rule (R7): up to two revise-and-rerun cycles, then stop S1 storage work and ask the user. No automatic SQLite fallback.
   - Loopback only, ports 18130 to 18132, tear everything down afterwards. Write `docs/research/spike-results-<date>-sp5b.md` and fold the result into `spikes.md` section 11 and the master tasklist in a separate commit.
3. **Resolve the remaining `[design]` items** only when the work needs them (server-api 12.2 and the lists in the plan): how the init script sets the `dump_ro` password when its secret is mounted only into the sidecar, whether the guess counter also covers card-addressed sends, the restic repository path for the second job, dump file naming details, the `a2a-coord expose check` evidence rules.

Tasks that need the user or an attended session:

- **A8c** (agy): `.mcp.json` at user level, `agy plugin install`, and a signed-out run last (it changes the real agy login). Runbook: `docs/research/spike-runbook-a8c-agy-open-items-2026-11-09.md`.
- **SP3 and SP4** (agy hooks), the **`asyncRewake` on `UserPromptSubmit`** test and the **GUI-launched Claude** test (decision 34; both run inside S1 with their own exit tests).
- **Installing the second restic script and its crontab line on `core`** (the installer prints them; it never edits `core`'s crontab).
- **The S3 go** (create the Cloudflare Tunnel route to `127.0.0.1:8121`), and the user's own housekeeping: rotate the Obsidian MCP bearer in `~/scratch/a2a-spikes/runlogs/chezmoi-diff.baseline` and delete that file, prune `sp2-agy` and `sp2-agy-a8b` from `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`, remove the `sp1` project entry from `~/.claude.json`.

## 4. How spikes are run (process rules)

- Roles: the **helper** is an attended Claude Code session that never launches, drives or probes agy; the **user** starts agy and copies files; **Antigravity** answers prompts and writes its results file; the helper reads logs.
- Scratch work lives under `~/scratch/a2a-spikes/` (alyx-local, not in git): helper briefs, `stub/`, `sp1/` to `sp5/`, `agy-operator/` prompts, `runlogs/`. Borrow and put back (decision 25): back up before touching user config, verify the restore, never print a token (the string `spike-token` is allowed).
- A background Claude Code job has `CLAUDE_CODE_SESSION_ATTENDED=0`, which breaks the wake-listener tests; those need an attended session.
- Listener owner pid is `$CLAUDE_PID`, not `$PPID`. Details are in `docs/research/spike-results-2026-11-05-sp1.md`.

## 5. Environment facts

- **alyx** (WSL2 workstation): spikes and dev. Docker, `uv`, `bun` are installed. Scratch ports: stub 18120, SP5 18125 to 18127, SP5b 18130 to 18132 (loopback only).
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

## 8. In flight when this was written (2026-11-09, late)

Check each with `git log` and the task list; do not redo finished work.

- **Handle grammar `name#sid8`:** docs edit in the `main` worktree (server-api.md, spikes.md, the plan, the tasklist). If `git status` there shows uncommitted changes to those files, review and commit them.
- **Jev 2.3.1** (live plugin fixes from the case study): owned by the session that wrote this file; branch `fix/jev-case-study-2-3-1`, release tag `jev-v2.3.1` after review and green CI. Not part of the coordination work.
- **Coordination docs on `main`:** up to date at commit `7e051cb` (round 3), then the handle grammar commit.

## 9. Open questions that only the user can settle

- The Postgres major version and image digest are chosen when SP5b runs (R3), not before.
- Whether to commit the SP5 and SP5b scratch drivers into the repo so a session on another machine can run them; today they exist only on alyx.
- Whether card-addressed `SendMessage` should share the guess counter (R10 covers handle-addressed sends only).
