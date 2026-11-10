---
name: sync-main
description: >-
  Bring the latest main into the current feature branch with careful conflict
  resolution: main wins on shared code, the branch keeps its own functionality.
  Then builds, tests and lints the affected parts, attributes every failure to the
  merge or to the branch as it was, and offers options instead of fixing silently.
when_to_use: >-
  The user asks to sync, update or merge main into the current branch ("pull main",
  "sync with main", "merge main in"). Not for rebasing a shared branch without consent,
  and not for pushing: the skill stops before push and asks.
---

# sync-main: bring main into the current branch

Bring the current main into the current feature branch. Main takes priority, but nothing the branch added is lost.

## Steps

### 1. Take stock

```bash
git status
git branch --show-current
git log --oneline -5
```

- If the working tree is dirty, **stop** and ask the user: commit, stash or abort.
- Remember the current branch name.

### 2. Fetch and measure the gap

```bash
git fetch origin main
git log --oneline HEAD..origin/main
git rev-list --count HEAD..origin/main
```

Show the user the incoming commits from main (at least the top 10 and the total count).

### 3. Choose merge or rebase

- **The branch is pushed** (`git rev-parse --abbrev-ref --symbolic-full-name @{u}` returns an upstream) → **merge**. A rebase breaks other people's clones.
- **The branch is local and pushed nowhere** → a rebase is possible, but **ask** the user first.
- The default is merge.

### 4. Merge

Record the current commit first (`git rev-parse HEAD`) as `<pre-merge-sha>`: every attribution below compares against it.

```bash
git merge origin/main --no-edit
```

Read the output:
- `Merge made by the 'ort' strategy` plus a list of auto-merged files → **clean merge**, go to step 6.
- `CONFLICT (...)` → go to step 5.
- `Already up to date.` → nothing to do; say so and stop.

### 5. Resolve conflicts (if any)

```bash
git status
git diff --name-only --diff-filter=U
```

For each conflicted file:

1. **Read the whole file** to understand the context.
2. Find the `<<<<<<<`, `=======`, `>>>>>>>` markers.
3. Resolve by these rules:
   - **Main wins on shared ground**: when main changes infrastructure, configuration, shared utilities, types, translations or branding, take main's version.
   - **Keep the branch's functionality**: when the conflict touches code this branch added (see `git log <branch> --not origin/main`), keep the branch's logic but adapt it to main's changes (new signatures, renames, new fields).
   - **Do not guess in ambiguous cases**: ask the user with the harness's interactive question tool, showing the concrete diff hunk and two or three options.
4. Remove every conflict marker and `git add <file>`.
5. After the last file, check that `git status` lists no unmerged paths, then `git commit --no-edit` (the default message).

**Do not use**:
- `git checkout --theirs` / `--ours` across the board: a blind resolution that loses either main's code or the branch's.
- `git merge --abort` without agreeing it with the user.
- `git reset --hard`, ever, unless the user asks for it.

### 6. Verify

```bash
git status
git log --oneline -8
```

Show the user:
- how many commits came in from main;
- the auto-merged files and the resolved conflicts;
- which files of the branch's own functionality were touched, if any;
- that the branch is now N commits ahead of origin.

### 7. Build the affected parts

After a successful merge, **build** the parts of the repository the merge touched, **with a report and an analysis of every failure**.

Find the affected parts from `git diff <pre-merge-sha> HEAD --stat`. A part is a package or app with its own build command: a workspace in a monorepo, a `backend/` and `frontend/` pair, or the repository root. Use each part's own command (`package.json` scripts, `Makefile`, `cargo build`, and so on) and the project's own package manager.

Run independent parts in parallel when the harness can run background commands.

Never start **dev servers** or watchers. Only finite build commands. Tests run separately in step 10.

### 8. Build report

When every build has finished, report per part:
- ✅ or ❌ and the exit code;
- on ❌: the number of errors and the files, grouped.

**Attribution (essential).** For each broken file, check whether the merge touched it:

```bash
git diff <pre-merge-sha> HEAD --stat -- <broken-file>
```

- The merge **did not touch** the file → the failure **already existed** on the branch and is not caused by the sync. Say so explicitly.
- The merge **touched** the file → possibly a semantic conflict from an auto-merge; it needs a manual look.

### 9. Options after the build

Do not fix anything silently. Offer three options and **wait for the choice**:

- **A.** Fix every error now (with a time estimate, if one is possible).
- **B.** Fix the minimum: the root error, production code only, or only the branch's own part.
- **C.** Defer: keep the merge as it is and fix in a separate commit or PR.

Add the context to the choice: "the build was already broken before the merge, nothing got worse" or "the merge introduced new failures in file X, which need a manual look".

### 10. Run the tests

Once the builds pass (or are accepted as broken), **run the tests** of the affected parts, found the same way as in step 7.

Run independent parts in parallel when the harness allows it.

**Finite commands only**, never watch mode:
- Jest: `--ci`, or `--ci --runInBand` when tests are flaky.
- Vitest: `vitest run`, not bare `vitest`.
- End-to-end suites: **only when the user asks**. They are slow and often need a database or other services.

### 11. Test report

When every run has finished, report per part:
- ✅ or ❌ and the exit code;
- failed versus total (for example `3 failed, 142 passed`);
- the failed specs with their paths, grouped.

**Attribution (essential).** For each failed test, find out where it came from:

```bash
git log <pre-merge-sha>..HEAD -- <test-file>
git log <pre-merge-sha>..HEAD -- <tested-source-file>
```

- Neither the test nor the code it tests was touched by the merge → a failure that already existed, not caused by the sync. Say so explicitly.
- The test **came from main** (new or changed) → it may conflict with the branch's functionality and needs a look.
- The tested code **was changed by the merge** → a semantic conflict that needs a manual fix.

### 12. Options after the tests

Do not fix anything silently. Offer three options and **wait for the choice**:

- **A.** Fix every failing test now (with a time estimate, if one is possible).
- **B.** Fix only what matters: the branch's own functionality, smoke tests, production-critical paths.
- **C.** Defer: keep the merge as it is and fix the tests in a separate commit or PR.

Add the context: "N tests were already failing before the merge" or "the merge broke exactly these tests in file X".

### 13. Lint

After builds and tests are settled, **run the linter** in every part that has one, **with a report** (per part: ✅ or ❌, the number of errors, the files). Run the parts in parallel when the harness allows it.

For errors, say which rules are broken, in which files, and whose files they are: the branch's or main's.

### 14. Push

**Never push automatically.** Ask the user whether to push.

If the project's CI cannot run two pipelines at once (some self-hosted runners cannot), check for running or pending pipelines on other branches first, with the CI's own tool (for example `glab ci list --status running` or `gh run list --status in_progress`). If the tool is not available, ask the user to check; push without that check only on the user's explicit decision. When another pipeline is running, stop and offer:

- **A.** Wait for it to finish.
- **B.** Push anyway (the user's explicit decision).
- **C.** Do not push now.

Pushing several branches after a series of syncs: **one at a time**, waiting until each branch's pipeline has passed at least build and test before pushing the next.

## Anti-patterns

- Rebasing a pushed branch without the user's explicit consent.
- Taking `--theirs` or `--ours` for every conflict at once.
- Merging into a dirty working tree: clean it first.
- Pushing the result without confirmation.
- Pushing while another branch's pipeline is running on a CI that cannot run two.
- Deleting or rewriting the branch's code "to make the conflict go away" instead of adapting it.
- Running build, test or lint without a report and an analysis of the failures.
- Starting dev servers or watch-mode tests: the user does that.
- Running end-to-end tests without being asked.
- Fixing build errors or failing tests silently, without attribution (merge or pre-existing) and without the A/B/C options.
