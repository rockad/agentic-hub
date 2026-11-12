# Pickup handoff: continuing the coordination plugin in a new session

## Start here (copy this into a new Antigravity or Claude Code session)

```
You are continuing the A2A coordination plugin work (repo agentic-hub, folder plugins/coordination). Planning is done and S1 implementation has started: stream S1-SCAF (compose and server scaffold) is delivered and merged (PR #32, commit 11f7e0f, verified 2026-11-11).
1. Read plugins/coordination/AGENTS.md, then docs/plans/pickup-handoff.md (this file), then docs/plans/master-tasklist.md section 4.
2. Verify the state before acting: git fetch; git log --oneline -8 origin/main; git status. Check every claim in a doc against its evidence file. SP3 and SP4 were run on 2026-11-10 and 2026-11-11 and are recorded, so the S1 entry gate is satisfied (docs/research/spike-results-2026-11-10-sp3-sp4.md). The user approved the S1 kickoff on 2026-11-11 (Y10) and decided the SP3 and SP4 proposals (Y5 to Y9); section 10 holds the table Y1 to Y10 and is final.
3. Work only in your own git worktree: git worktree add ../agentic-hub-wt-<you> -b <branch> origin/main. Never commit in ~/projects/agentic-hub (it is shared with another session). Stage explicit paths only. Never push main, tag or release without the user's go.
4. First action: the next stream is S1-PG (Postgres compose service and `a2a-coord db init-dump-role`, per docs/plans/implementation-plan.md). It needs two secret files from the user before it can run: the database password and the dump_ro secret, each mode 0600 and outside the repo; ask for them, never print or create their values. Then take the first item of section 3 "What to do next" that needs no user input. Ask the user before anything marked needs user (agy runs, attended spikes, <storage-host> crontab, hygiene items, and the user-only actions listed in section 10).
5. Decisions in the plan's decision tables are final: do not reopen them. Anything the docs leave open stays marked [design] or [unverified]; do not invent it.
6. Label every statement verified, reported or unverified. Never print a secret or a token. Use vertical lists, absolute dates, and the editor's Edit tool for file changes.
7. Never launch, drive or probe the Antigravity CLI (agy) as a helper; the user starts agy and agy answers prompts. In Claude Code, run Jev's pre-flight before delegating non-trivial work.
8. When you finish a step: update section 3 and section 8 of this file and the master tasklist, commit, then tell the user what changed and what is next.
```

Written 2026-11-09, updated 2026-11-10 after SP5b passed, S1 design items were resolved and the round-4 decisions (X1 to X5) and audit corrections (C1 to C5) were applied, updated 2026-11-11 after SP3 and SP4 were run and recorded, and updated again on 2026-11-11 with the fifth clarify round (Y1 to Y10, section 10), and updated a third time on 2026-11-11 after S1-SCAF merged (PR #32). Read this file first; it points to the authoritative documents and does not replace them. Labels follow the repo: **verified** (read or observed), **reported** (a claim not reproduced), **unverified**.

## 1. Where the project stands

- Status 2026-11-11: planning and spikes are done and **S1 implementation has started**. Stream **S1-SCAF is delivered and merged** as PR #32 (commit `11f7e0f`) [verified by the main session on 2026-11-11, acceptance re-run on a fresh `--no-cache` build]:
  - Delivered: `plugins/coordination/plugin.json`; `docker-compose.yml` with the single service `coordination` (`read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp` and `/run/a2a`, `127.0.0.1:8120` only, named volume `a2a-data` at `/data`, healthcheck, non-root uid 10001); `servers/coordination` (multi-stage Dockerfile running pytest in the build stage, `a2a-sdk[http-server]==1.3.0`, `uv.lock`, one config module reading the 35 `A2A_*` variables of api 1.5, `/healthz`, `a2a-coord` CLI skeleton, typed protocols for store, service, notifier and clock, 25 tests); `AGENTS.md` and `README.md` status text.
  - Acceptance [verified]: 25 tests passed in the build stage; container healthy; `/healthz` 200; non-root; writes outside `/data`, `/tmp` and `/run/a2a` fail; `docker port` shows only `127.0.0.1:8120`; no host-name or memory-plugin hits; `uv.lock` present; 35 of 35 config variables match the api 1.5 table.
  - Design choices where the spec was silent: `A2A_DEPLOY_HOST` defaults to `local`; unknown `A2A_*` variables are ignored; base image `python:3.14-slim` with uv 0.11.31.
  - Not included, left to later streams: Postgres (S1-PG), dump sidecar (S1-BKP), the `./config` bind mount (the cards file read is S1-AUTH), CI, marketplace entry.
  - The delivered list names only `/healthz` as an endpoint; storage, auth and the other endpoints belong to the later S1 streams [unverified whether the skeleton registers any other route].
- Stage S0 (spikes): the **S1 entry gate is satisfied** (status 2026-11-11, `docs/specs/spikes.md` section 11), and the S1 kickoff is **approved** (Y10, 2026-11-11; section 10). SP1, SP2 (Claude and agy halves, A8b), SP5 (SQLite) and **SP5b (Postgres on <workstation>)** passed with spec changes folded in. **SP3** (agy `PreInvocation`) and **SP4** (held `Stop` park, record only) were run on 2026-11-10 and 2026-11-11 and are recorded in `docs/research/spike-results-2026-11-10-sp3-sp4.md` (tracked since commit `1213787`). The earlier C1 wording (gate NOT satisfied, SP3 and SP4 open) was correct on 2026-11-10 and is superseded. S0 is not "complete" in the sense of every open item: A8c and the non-gating SP5b follow-up items stay open, and the `asyncRewake` and GUI-launched Claude tests run inside S1.
- SP3 and SP4 results (2026-11-10 and 2026-11-11, agy 1.5.4 then 1.5.5, run by a helper with the user attending):
  - SP3 gate items passed [verified]: P1 5 of 5 trials (the model called `a2a_inbox` unprompted), P3 p50 28 ms and p95 33 ms over 186 runs, P4 dedupe rule works, P5 all 6 failure modes fail open (0 blocked turns, 0 errors, 0 orphans).
  - SP3 record-only items: P1b, P1r (resume does not re-fire `SessionStart`; `PreInvocation` does fire), P2 (once per model call), P6 (no `timeout` key: agy proceeded after about 31.5 s, hook not killed), P7 (both wordings read as system text), P8 (user-level hooks ran in a trusted workspace; `.a2a-optout` honoured with no network call; an untrusted workspace stopped at the trust dialog).
  - SP4 recorded, non-gating: K1 to K6 (`Stop` once per user turn; typing queued; `continue` capped at 10; UI released at about 60 s on `timeout: 30` with the hook not killed; Esc, Ctrl-C and `/exit` leave an orphan; a finished background command wakes an idle agy). Results file reading: usable with serious caveats at best.
  - Not tested [unverified]: a held park of 300 s to 1800 s, and user-level hooks in an untrusted workspace past the trust dialog.
- An independent audit of the overnight SP5b work is in `docs/research/audit-2026-11-10-sp5b-s1-gate.md` (agy's audit, moved out of this handoff; not rewritten). Its findings are applied as C1 to C5 in the docs; read the audit file for its own wording.
- On 2026-11-10, SP5b ran on <workstation> and **passed** all acceptance gates (full report: `docs/research/spike-results-2026-11-10-sp5b.md`, committed in `946f198`; measured numbers unchanged, three corrections added: C1 gate wording, C2 the D7 outlier, C3 the deadlock count):
  - **Pinned Postgres image**: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (D-B, R3).
  - **D3 (Lost-update CAS)**: 300 rounds, 0 lost updates, 0 double takes, transition p99 10.13 ms.
  - **D7 (Backup sidecar under load)**: `pg_dump -Fc` via `dump_ro` in 0.73 s, `pg_restore --list` verified 71 entries, restore into scratch DB with 100% count match (722/722), Alembic at head (`b5e3d1c8a2f7`).
  - **D8 (Crash resilience under load)**: 2x `kill -9` of server + Postgres container restart, 0 lost acked writes (336 creates, 296 completions, 40 cancels), level-triggered park re-offer verified.
  - **D2 (10-min mixed load benchmark)**: 1,986 tasks, 0 unhandled DB errors, loop lag p99 2.41 ms, wake p99 2.8 ms, store.save p99 17.25 ms, transition.versioned p99 18.66 ms, 0 deadlocks inferred from an empty `db_errors` count (no separate deadlock counter in the logs; C3). A 1,036.82 ms `CancelTask` outlier during the D7 dump has an unverified cause (C2); the 200 ms p99 gate was evaluated on D2 only.
  - **Separator check**: `#` and `~` validated across URL query (%23 for `#`), shell quoting, JSON, and Postgres DB. Verdict (X1): `#` needs `%23` in URL queries; `~` adopted by user decision 2026-11-10.
- The five S1 `[design]` points of commit `c17402b` were proposals by the overnight agy run, not settled facts. The user decided them on 2026-11-10 in a fourth `/clarify` round (X1 to X5); the docs follow these decisions, and `docs/specs/server-api.md` 12.2 and the tasklist were aligned to them in the same round:
  - X1, handle grammar: `card/name~sid8` (for example `claude-code@<workstation>/c6-same~3f2a9c1d`), session part regex `^[a-z0-9][a-z0-9._-]{0,38}~[0-9a-f]{8}$`; replaces the `#` separator of commit `db17ada`. `@` and `/` stay (legal in a URL query string); `#` is rejected (URL fragment, needs `%23`).
  - X2, `dump_ro` password: the host command `a2a-coord db init-dump-role` (idempotent; run by the installer after Postgres is up and again on rotation) feeds `psql` in the Postgres container over stdin. The secret file is mounted only into the sidecar; no init script mounts it into Postgres. The D7 role setup is retested through the command route in the SP5b follow-up.
  - X3, guess counter scope: handle-addressed sends only ("not available" answers). Card-addressed sends stay outside it (403 `CardNotAllowed`, not counted) and stay under the per-key `SendMessage` limit of 10 per minute.
  - X4, second restic job: repository `rclone:<gdrive-remote>:backups/restic-a2a`, password file `~/.config/a2a-coord/restic-password` (mode 0600, created by the user), cron `45 5 * * *` in <storage-host>'s local time (Europe/Helsinki), `restic forget --keep-last 3 --prune --tag a2a-dumps`, source `<media-root>/backup/a2a/`.
  - X5, `a2a-coord expose check`: exit 0 all met, 1 at least one unmet, 2 could not evaluate. Runtime checks now; fuzz report, honest card and extension URI listed as manual until S3 ([design], task S3-EXPOSE-CHECK).
- Decisions from 2026-11-09 `/clarify` rounds:
  - **D-A to D-J:** Postgres in the compose project from S1 (reverses decision 4's SQLite), SP5b gate, 8121 public listener, handle addressing, A8c, final extension URI at S3.
  - **R1 to R8:** handle guess counter, DB password via secret file, exact image pin, dump sidecar, retention, `a2a-data` for import artefacts only, SP5b failure rule, 8121 listener from stage s2.
  - **R9 to R14:** dumps in `<media-root>/backup/a2a/` plus a second restic job, guess counter numbers (10 misses per 60 s, 429), read-only role `dump_ro`, `pg_dump -Fc` verified with `pg_restore --list`, manual s3 flip after `a2a-coord expose check`, compose profile `backup`.
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
2. **[DONE] SP5b spike on <workstation> (S1 storage gate)**: Executed in `~/scratch/a2a-spikes/sp5b/`. Passed all gates (0 lost updates, 0 lost acked writes, p99 write 18.66 ms on D2, 0 deadlocks inferred from an empty `db_errors` count). Scratch containers destroyed, ports released. Documented in `docs/research/spike-results-2026-11-10-sp5b.md`, updated `spikes.md` and `master-tasklist.md` (commit `946f198`).
3. **[DONE, superseded in part] S1 `[design]` items**: first written into `docs/specs/server-api.md` 12.2 by commit `c17402b`; the user's round-4 decisions X1 to X5 replace its values for the separator, the `dump_ro` secret, the guess counter scope, the restic job and the expose check.

### Verification checklist for Claude Code pickup session

Before picking up new workstreams, Claude Code should verify the committed state:
- [ ] Inspect git log: `git -C ~/projects/agentic-hub-wt-main log -8 --oneline` (it includes `db17ada`, `946f198`, `c17402b`, the handoff commit `3a2bea8`, and the round-4 docs commit once it exists).
- [ ] Read `plugins/coordination/docs/research/spike-results-2026-11-10-sp5b.md` and verify against Section 11 of `docs/specs/spikes.md`.
- [ ] Read `plugins/coordination/docs/research/audit-2026-11-10-sp5b-s1-gate.md` for the audit that led to corrections C1 to C5.
- [ ] Read `plugins/coordination/docs/specs/server-api.md` Section 12.2 and confirm it carries the round-4 values X1 to X5.
- [ ] Read `plugins/coordination/docs/plans/master-tasklist.md` Section 4 to confirm S0-SP5B, SP3 and SP4 are checked off (SP3 and SP4 on 2026-11-11).
- [ ] Read `plugins/coordination/docs/research/spike-results-2026-11-10-sp3-sp4.md` (section 1 table and section 4) and verify against Section 11 of `docs/specs/spikes.md`.

### Next actions, in order

1. **[DONE 2026-11-11] SP3 and SP4** (agy hooks): run on 2026-11-10 and 2026-11-11 and recorded; the overall S1 entry gate is satisfied. Results: `docs/research/spike-results-2026-11-10-sp3-sp4.md`. Spike code and logs stay in `~/scratch/a2a-spikes/` (not in git, never merged). The user still has to prune four scratch workspace entries from `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` (results file section 7).
   - The user decided the proposals drawn from SP3 and SP4 on 2026-11-11 (Y5 to Y9, section 10). Next for the docs: commit these updates when the user asks.
   - The SP5b follow-up is done (2026-11-10, non-gating): results in `docs/research/spike-results-2026-11-10-sp5b-followup.md`, Claude Code's independent check in its section 7. Verdicts: (a) PASS for the mechanism, (b) PASS, (c) cause UNVERIFIED. The agy-reported items without a saved log are carried as exit tests of S1-PG and S1-BKP.
2. **At S2 (the user):** create the restic password file `~/.config/a2a-coord/restic-password` (mode 0600) and install the second restic job on <storage-host> from the text the installer prints (X4).
3. **[DONE 2026-11-11] S1-SCAF** (compose and server scaffold): delivered and merged as PR #32 (`11f7e0f`), acceptance verified (section 1).
4. **Next: S1-PG** (Postgres compose service and `a2a-coord db init-dump-role`, per `implementation-plan.md`; image `postgres:17.11-alpine` pinned by digest, R3). **State at the weekly-quota stop (2026-11-11): S1-PG is implemented but NOT reviewed, NOT committed.** A Sonnet agent finished it in the worktree `~/projects/agentic-hub-wt-pg` (branch `feat/coordination-s1-pg`, from `main` 67cca60), uncommitted, tested with throwaway secrets only. The agent REPORTED acceptance a to g all passing (healthy stack, no published Postgres port, canary scans clean, exact tag plus digest, data survives down/up, `init-dump-role` idempotent with rotation and `dump_ro` read-only; local tests 70 passed, 1 skipped) [reported, not re-run by the main session]. Known caveat to settle at review: the server container cannot read the 0600 secret file unless `A2A_UID` and `A2A_GID` match the file owner (rootless Docker needs 0; rootful needs the host uid), and with them overridden `/data` is not writable (GL-IMPORT will need an answer). On resume: `git -C ~/projects/agentic-hub-wt-pg status -sb` and `git diff --stat`; if the work is there, re-run acceptance a to g of the S1-PG block yourself (canary scans, refused host connections, data survives down/up, `dump_ro` rotation), then commit explicit paths, open a PR and wait for the user's word to merge; if the worktree is empty, restart S1-PG from the brief decisions: secrets dir `${A2A_SECRETS_DIR:-$HOME/.config/a2a-coord/secrets}` (files `a2a_db_password` and `pg_dump_password`, mode 0600), exact tag plus digest, no trust authentication, a minimal startup connect probe in `store/connect.py` (S1-STORE replaces it), `init-dump-role` feeding SQL over stdin. It needs two secret files from the user first: the database password and the `dump_ro` secret, each mode 0600 and outside the repo. Then S1-BKP (dump sidecar), S1-AUTH (cards file and the `./config` bind mount), and the other S1 streams. A8c, the `asyncRewake` test and the GUI-launched Claude test run later inside S1, each with its own exit test (Y10).

### Tasks that need the user or an attended session

- **A8c** (agy): `.mcp.json` at user level, `agy plugin install`, and a signed-out run last (it changes the real agy login). Runbook: `docs/research/spike-runbook-a8c-agy-open-items-2026-11-09.md`. Run inside S1 (Y10).
- The **`asyncRewake` on `UserPromptSubmit`** test and the **GUI-launched Claude** test (decision 34; both run inside S1 with their own exit tests, Y10; not S1-entry blockers). SP3 and SP4 are done (2026-11-11).
- **Creating the restic password file and installing the second restic script and its crontab line on `<storage-host>`** (at S2; the installer prints the script and the line; it never edits `<storage-host>`'s crontab and never writes into the knowledge-archive git repo).
- **The S3 go** (create the Cloudflare Tunnel route to `127.0.0.1:8121`), and the user's own housekeeping: rotate the Obsidian MCP bearer in `~/scratch/a2a-spikes/runlogs/chezmoi-diff.baseline` and delete that file, prune `sp2-agy` and `sp2-agy-a8b` from `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`, remove the `sp1` project entry from `~/.claude.json`.
- **S1 dev server implementation**: the overall S1 entry gate is satisfied since 2026-11-11 (SP3 passed, SP4 recorded) and the user gave the go on 2026-11-11 (Y10). S1-SCAF is done and merged (PR #32); S1-PG is next and needs the user to provide two secret files (database password, `dump_ro` secret; mode 0600, outside the repo).
- **User-only items still open** (an agent must not do these):
  - Create the restic password file `~/.config/a2a-coord/restic-password` (mode 0600) on <storage-host> before S2 (X4).
  - Schedule the agentic-hub history-rewrite window and run the owner force-push (Y4; [`history-rewrite-plan.md`](history-rewrite-plan.md); not scheduled).
  - Delete the old `ghcr.io/rockad/lookup:latest` tag in the package settings (Y2).
  - Housekeeping: rotate the Obsidian MCP bearer in `~/scratch/a2a-spikes/runlogs/chezmoi-diff.baseline` and delete that file; prune the scratch workspace entries (`sp2-agy`, `sp2-agy-a8b` and the four from the SP3 and SP4 runs, results file section 7) from `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`; remove the `sp1` project entry from `~/.claude.json`.
  - The S3 go (create the Cloudflare Tunnel route to `127.0.0.1:8121`).
- The user-only actions of the fifth clarify round are also listed in section 10.

## 4. How spikes are run (process rules)

- Roles: the **helper** is an attended Claude Code session that never launches, drives or probes agy; the **user** starts agy and copies files; **Antigravity** answers prompts and writes its results file; the helper reads logs.
- Scratch work lives under `~/scratch/a2a-spikes/` (<workstation>-local, not in git): helper briefs, `stub/`, `sp1/` to `sp5b/`, `agy-operator/` prompts, `runlogs/`. Borrow and put back (decision 25): back up before touching user config, verify the restore, never print a token (the string `spike-token` is allowed).
- A background Claude Code job has `CLAUDE_CODE_SESSION_ATTENDED=0`, which breaks the wake-listener tests; those need an attended session.
- Listener owner pid is `$CLAUDE_PID`, not `$PPID`. Details are in `docs/research/spike-results-2026-11-05-sp1.md`.

## 5. Environment facts

- **<workstation>** (WSL2 workstation): spikes and dev. Docker, `uv`, `bun` are installed. Scratch ports: stub 18120, SP5 18125 to 18127, SP5b 18130 to 18132 (loopback only, all torn down).
- **<storage-host>** (`<storage-host-ip>`, verified over ssh on 2026-11-09): Raspberry Pi 5 Model B Rev 1.0, 4 cores at 2.4 GHz, 8 GB RAM, Debian 12 aarch64, Docker 29.x, user in the docker group. Read-only ssh is fine; ask the user before anything needing root or a restart on `<storage-host>`. The existing restic job is `<media-root>/knowledge-archive/ops/restic-backup.sh` (user crontab, 05:30, single source). Verified read-only on 2026-11-10: the rclone remotes are `<gdrive-remote>:` and `<odrive-remote>:`, <storage-host>'s time zone is Europe/Helsinki (cron runs in local time) and `<media-root>/knowledge-archive` is a clean git repo. Speed is not a concern (user, 2026-11-09).
- Ports in the design: 8120 tailnet listener, 8121 public listener (loopback only; the tunnel route is the exposure gate).
- Shell tools: prefer `jq`, `yq`, `rg`, `fd`, `sd`; edit files with the editor's Edit tool, never a script read-replace-write. In zsh a variable holding several lines is not word-split; loop with `while read`.

## 6. Repository and commit rules

- The `agentic-hub` checkout at `~/projects/agentic-hub` is **shared** with another Claude session (`ce-research`, owner of the cross-repo plan and the cognitive-engine port) that switches branches in it. Always run `git branch --show-current` before committing. Commit `main` from a worktree: `git worktree add ../agentic-hub-wt-main main` (exists on <workstation>), stage explicit paths only (no `git add -A`, no `commit -a`), `git fetch` before pushing.
- Never edit `ce-research`'s branch (`docs/clarify-decisions-2026-11-09`, PR #20), its files or the pr-plan; send it a message instead (`SendMessage` to `ce-research`).
- Commit and push only when the user asks. End commit messages with the attribution lines the harness gives.
- Check a branch against `origin/main` only after `git fetch`; a stale local `main` caused one wrong conclusion on 2026-11-09.
- Vertical lists only in docs, absolute dates, no secrets, no invented facts: mark open items `[design]` or `[unverified]`.

## 7. Models and delegation

- Claude Code: subagents default to Sonnet; Opus only for judgements whose error is expensive and for one final verification; pass the model explicitly. Antigravity: inherit the session model; the `pro` tier needs the user's approval. The mapping table is in the user-level `AGENTS.md` (`~/.gemini/config/AGENTS.md` and `~/.claude/CLAUDE.md`).
- Jev mode is `on`: call `jev_batch_dispatch` before delegating non-trivial work and `jev_judge` on diffs, and say so. Known defects of the dispatch tool (a substring keyword rule, Antigravity vocabulary, wrong session model) are in the case study `2026-11-09-model-tier-for-multi-stream-workflow.md` (now in `rockad/cognitive-engine`, `packages/jev/docs/case-studies/`; a pointer stays under `plugins/jev/docs/case-studies/`); treat its output as advice, not an instruction.
- Docs workflows that edit many files should give each agent a disjoint file set and finish with a consistency pass: cross-file races produced stale references twice.

## 8. In flight / Commits on `main`

The following commits are on `main` and pushed to `origin/main`:
- `db17ada`: `docs(coordination): adopt name#sid8 grammar across specs, plans, and tasklist` (separator replaced by `~` in round 4, X1)
- `946f198`: `docs(coordination): record SP5b pass and S1 entry gate satisfaction` (the commit message predates C1: SP5b satisfies the S1 storage gate only)
- `c17402b`: `docs(coordination): resolve S1 design items (dump_ro secret, guess counter, restic repo, expose check)` (values replaced by X2 to X5)
- `3a2bea8`: `docs(coordination): update pickup handoff with SP5b pass and S1 design resolutions` (its gate wording and "settled" statements are corrected by C1 and C5)
- `74f6c0e`: `docs(coordination): apply round-4 decisions and correct the overnight SP5b and S1-gate claims` (the round-4 docs, X1 to X5 and C1 to C5, are committed).

## 9. Open questions and next steps

- **Postgres image pin settled**: `postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` (D-B, R3).
- **Guess counter scope (X3)**: the counter covers handle-addressed sends only ("not available" answers). Card-addressed sends are outside it (403 `CardNotAllowed`) and stay under the per-key `SendMessage` limit of 10 per minute; card existence is public by design (D32), so there is nothing to enumerate.
- **Still open for user confirmation**:
  - Whether to commit the SP5 and SP5b scratch drivers into the repo so a session on another machine can run them; today they exist only on <workstation> in `~/scratch/a2a-spikes/`.
  - Attended spike runs still open: A8c (SP3 and SP4 are done); A8c, the `asyncRewake` test and the GUI-launched Claude test run inside S1 (Y10).
- The SP3 and SP4 proposals are decided (Y5 to Y9, section 10); no open question remains from them.

## 10. Decisions of 2026-11-11 (fifth clarify round, Y1 to Y10)

The user decided these on 2026-11-11, after the SP3 and SP4 results (`docs/research/spike-results-2026-11-10-sp3-sp4.md` section 4 holds the evidence for Y5 to Y8). They are final: do not reopen them. Status labels: **done** (reported by the user), **decided** (the docs follow it; the code or spec text is not written yet), **open** (needs a user action), **in progress**.

| ID | Decision | Status | What it changes |
| --- | --- | --- | --- |
| Y1 | PR #21 (GHCR hardening) merged now. | done 2026-11-11 (reported) | The GHCR publishing hardening is on `main`; nothing in the coordination docs. |
| Y2 | Delete the old `ghcr.io/rockad/lookup:latest` tag. | open, user action | Package settings only; the helper's token has no package scope, so an agent cannot do it. |
| Y3 | The default host in `plugins/gitea/.mcp.json` becomes a placeholder URL. | in progress (separate branch) | The gitea plugin default; no coordination spec changes. |
| Y4 | Rewrite the agentic-hub git history later, in a planned window. | decided, not scheduled | Plan note: [`history-rewrite-plan.md`](history-rewrite-plan.md). Needs an owner force-push; until then no history rewrite and no force-push by any agent. |
| Y5 | The agy `PreInvocation` hook injects with `systemMessage` plus the tested dedupe rule (not `ephemeralMessage`). | decided | Decision 9 (note appended); the hook spec in `server-api.md` 11.2 and BP13 in `implementation-plan.md` were aligned on 2026-11-11 (`systemMessage` chosen, about 200 ms connect timeout, `{}` on no announcement). |
| Y6 | Hook timing: connect timeout about 200 ms, keep the tested dedupe, no throttle, always exit 0 with `{}`. | decided | Decision 9 (note appended); the shipped hook script at S1-AGY. Evidence: a down stub costs about 1.03 s at a 1 s connect timeout, and agy does not kill a slow hook at its timeout (P5, P6, verified). |
| Y7 | Decision 26 stands: agy hooks in the user-level `~/.gemini/config/hooks.json`, opt-out by the `.a2a-optout` marker. | decided | Nothing changes; decision 26 stays as written. Evidence: user-level hooks ran in trusted workspaces and `.a2a-optout` was honoured with no network call (P8, verified); behaviour in an untrusted workspace past the trust dialog stays unverified. |
| Y8 | No held `Stop` park for now. agy keeps `SessionStart` `injectSteps` plus `a2a_inbox` and `a2a_wait` (decision 27 baseline, no idle wake). The K6 background-watcher route stays a future option. | decided | Decision 27 (note appended); SP4 stays record-only. K6 (a finished background command wakes an idle agy, verified) is not built. |
| Y9 | The installer merges into `~/.gemini/config/hooks.json` by its own key only, takes a byte-copy backup first, re-reads the file right before writing, and writes atomically. | decided | Installer rules for S1 (`server-api.md` 11 to be aligned when S1 starts). Reason: the user's own tab-sync tool also edits that file (it did so twice during the SP3 run, reported). |
| Y10 | Start S1 now; run A8c, the `asyncRewake` test and the GUI-launched Claude test inside S1. | approved | Section 3 and the master tasklist: the S1 kickoff needs no further go; the three attended tests move from "open spikes" to S1 exit tests. |

User-only actions (an agent must not do these):

- Delete the old `ghcr.io/rockad/lookup:latest` tag in the package settings (Y2).
- Schedule the history-rewrite window and run the owner force-push when the plan is ready (Y4; the plan note is [`history-rewrite-plan.md`](history-rewrite-plan.md); not scheduled).
- Earlier user-only items stay in section 3 (restic password file and crontab at S2, the S3 go, hygiene actions).

Superseded by this round: the former section 10 was a list of proposals from the SP3 and SP4 results; Y5 to Y9 decide them. The SP4 findings (K1 to K6: `Stop` timeout not enforced at 30 s, orphan scripts on Esc, Ctrl-C and `/exit`, a cap of 10 continues, typed input queued) remain the reason Y8 ships no park.
