# History rewrite plan: scrub machine-specific details from git history

Status: PLANNING ONLY. Written 2026-11-11. Nothing in this document has been run. No rewriting command has been executed, and no ref has been changed.

Label convention: statements are marked verified (checked directly), reported (from documentation or the owner, not re-checked) or unverified (assumed).

## Goal and non-goals

Goal:

- Remove machine-specific details from the full git history of `rockad/agentic-hub`, so history matches the scrubbed tip.

Context:

- The repository is public.
- The tip was scrubbed on 2026-11-11 (PR #30). The scrubbed details remain in earlier commits (verified by the nature of git history).
- The owner decided on 2026-11-11 to rewrite history later, in a planned window.

Non-goals and severity:

- No secrets were found in history (reported by the scrub review). Exposure is low severity, so this is hygiene, not incident response.
- No credential rotation is part of this plan.
- This plan does not change repository content at the tip.

## What a rewrite changes and breaks

- Every commit SHA changes from the first rewritten commit onward.
- Tags and GitHub releases must be recreated, because they point at old SHAs. Known tags (verified locally): `jev-v2.3.0`, `jev-v2.3.1`, `pre-split-2026-10-05`. The remote list must be captured too, since local tags may be incomplete.
- Open PRs and non-default branches are orphaned or must be rebased onto the new history.
- Every local clone and every worktree diverges and must be reset or re-cloned.
- Other repositories or notes that cite agentic-hub SHAs (for example the cognitive-engine repo and vault notes) point at commits that no longer exist on the default branch.
- Forks and third-party clones keep the old history. Nothing in this plan can change them.

Documented limitation (reported, not verified):

- GitHub keeps old objects reachable through `refs/pull/*` and cached views, so a force-push alone does not fully remove them.
- Full removal needs a purge request to GitHub Support. Whether Support grants it is unverified.

## Prerequisites

- Merge or close all open PRs.
- Tell every session that uses the repo: other Claude sessions, `agy`, and every worktree.
- Take a full mirror backup clone (`git clone --mirror`) and keep it offline.
- Capture the lists of tags, releases and branches (names, target SHAs, release notes) into a file outside the repo.
- Prepare the replacement map locally (see below).
- Complete a dry run on a mirror copy, with a diff of `git grep` results before and after.

Replacement map:

- The map is a text file for `git filter-repo --replace-text`.
- Each line has the form `literal==>replacement`.
- Example lines with fake values only: `old-host.example==>` followed by the placeholder `<storage-host>`, and `fake-home-prefix==>` followed by `~`.
- The real map is built locally from the placeholder table used in the scrub (workstation host, storage host, LAN IPs, mount root, cloud remotes, private domain hosts, home path, file links).
- The real map is kept outside git (for example under `~/.config/`), mode 0600, and deleted after the rewrite is verified.
- The real map is never committed, pasted into an issue or PR, or quoted in any public file.

## Order of steps

1. Freeze. Announce the window, stop all sessions that write to the repo, and confirm no open PRs.
2. Mirror backup. Make the offline mirror clone and capture the tag, release and branch lists.
3. Dry run on a copy. Clone the mirror to a scratch location, run `git filter-repo --replace-text` there, then verify with `git log -S` and `git grep` over all refs. Compare against the pre-rewrite results.
4. Owner force-push. Only the owner pushes: all branches and all tags, with force. No agent pushes.
5. Recreate GitHub releases from the captured list, pointing at the new tags.
6. Reset or re-clone every worktree and clone. Do not merge old history into the new history.
7. Request the GitHub Support purge of unreachable objects and `refs/pull/*` caches (if the owner decides to ask).
8. Verify and record. Run the checklist below, then delete the local replacement map and record the outcome.

## Verification checklist

- `git log -S` for each real literal, over all refs, returns nothing (run locally with the private map).
- `git grep` over every ref returns nothing for each placeholder source pattern (class of pattern, not the value).
- Commit count and the tree at the tip match the pre-rewrite tip, apart from SHAs. Compare file contents, not SHAs.
- All expected tags and releases exist and point at rewritten commits.
- A fresh clone builds and the plugin tests pass.
- Old SHAs cited elsewhere are listed and updated or annotated.
- GitHub Support reply recorded, if requested.

## Rollback

- Before the force-push: discard the dry-run copy. Nothing changed.
- After the force-push: the offline mirror backup holds the old history. Rolling back means force-pushing the old refs from the mirror, which re-publishes the removed details. It restores SHAs for others, but undoes the hygiene goal.
- A force-push cannot be undone in the sense of un-publishing. Anyone who fetched the new history must reset again.
- Keep the mirror until the verification is complete and the owner confirms. The mirror itself contains the removed details, so store it privately and delete it when no longer needed.

## Open decisions for the owner

- The window date and duration.
- Whether to ask GitHub Support for a purge.
- Whether forks or third-party clones exist (check the fork list and clone traffic on GitHub; unverified today).
- Which dependent repositories and notes to update after the SHAs change.
- How long to retain the offline mirror backup.
