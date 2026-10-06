---
name: skills-doctor
description: >-
  Diagnose and repair `npx skills` installs across both scopes — the
  project's skills-lock.json and the global ~/.agents/.skill-lock.json.
  `reinstall` rebuilds everything for Claude Code only, in symlink mode
  (canonical files under .agents/skills/, symlinks under .claude/skills/),
  working around two skills-CLI quirks: forced copy mode for single-agent
  targets, and stdin-swallowing inside scripted loops. `status` reports the
  current install state without changing anything.
when_to_use: The user wants to reinstall, repair, or inspect their npx-skills setup — broken or missing skill symlinks, skills copied instead of symlinked, skills installed for the wrong agents, lock-file drift, or a fresh machine restore. Keywords — skills doctor, reinstall skills, fix skills, skill symlinks, skills-lock. Skip for adding/updating a single skill from a known source (plain `npx skills add`/`update` is enough) and for authoring skills (use skill-creator).
argument-hint: "reinstall [-n] [-a agent] | status"
allowed-tools: Bash(bash *) Bash(npx skills *) Bash(jq *) Bash(ls *) Bash(find *) Read
metadata:
  author: aleksandr
  requires: Node.js (npx) + the vercel-labs/skills CLI fetchable from npm
---

# skills-doctor

Maintains the `npx skills` install layout this setup standardizes on: **one
agent (Claude Code), symlink mode** — canonical skill folders in
`.agents/skills/`, symlinks in `.claude/skills/`, in both the project scope
(the repo's `skills-lock.json`, falling back to `$DIGITAL_ASSISTANT_HOME`
when the cwd has none) and the global scope (`~/.agents/.skill-lock.json`,
dirs under `~`).

`$SKILL_DIR` = this skill's folder — `${CLAUDE_SKILL_DIR}` in Claude Code,
the directory containing this SKILL.md elsewhere.

## `reinstall`

```bash
bash "$SKILL_DIR"/scripts/reinstall.sh [-n] [-a <agent>]
```

Snapshots both lock files first, then per scope: `npx skills remove --all`,
then re-adds every source with its skill list for `claude-code` (or `-a
<agent>`). Run with `-n` first and show the user the plan when they haven't
already confirmed a full reinstall — the real run wipes and rebuilds every
installed skill, and a mid-run failure (e.g. an unreachable source) leaves
skills removed until re-run.

The script encodes two `npx skills` (v1.5.x) behaviors that are easy to
regress on — don't "simplify" them away when editing:

- **Single-agent installs are forced to copy mode.** Symlink mode only
  activates when ≥2 distinct skill dirs are targeted, so the script pairs
  the agent with one universal agent (`amp`), whose install dir *is* the
  canonical `.agents/skills/` — flipping the CLI to symlink mode while
  writing nothing extra anywhere.
- **The CLI reads stdin**, so inside `while read` loops every `npx` call
  carries `< /dev/null` — without it the rest of the source list is
  swallowed and only the first source installs.

On failure mid-run, the lock snapshot lists what should exist: re-run the
script, or replay individual lines as `npx skills add <src> -s <skill> -a
claude-code amp -y`. A project lock clobbered by a partial run can be
restored with `git restore skills-lock.json` when the repo tracks it.

## `status`

Read-only. Report, for each scope:

1. **Lock vs installed** — skill names in the lock (`jq -r '.skills | keys[]'
   <lock>`) vs directories in `.agents/skills/`; flag entries missing on
   disk and orphan dirs missing from the lock.
2. **Symlink health** — every entry in `.claude/skills/` should be a symlink
   into the scope's `.agents/skills/`; flag real directories (copy-mode
   residue from single-agent installs) and broken symlinks
   (`find <dir> -maxdepth 1 -xtype l`).
3. **Missing Claude links** — canonical skills with no `.claude/skills/`
   symlink (installed for universal agents only, invisible to Claude Code's
   per-scope discovery).

Paths: project scope uses `<project>/.agents/skills/` and
`<project>/.claude/skills/` next to `skills-lock.json`; global scope uses
`~/.agents/skills/`, `~/.claude/skills/`, and `~/.agents/.skill-lock.json`.
Suggest `reinstall` when anything is flagged; a single missing symlink can
also be fixed in place with one `npx skills add <src> -s <skill> -a
claude-code amp -y [-g]`.

## Notes

- **Requires Node.js and the [`skills` CLI](https://github.com/vercel-labs/skills).** Everything here shells out to `npx skills`, so `node`/`npx` must be installed and the `skills` npm package reachable (npm registry access, or an already-populated npx cache). Without them, fail with a clear message — there is no fallback path.
- `npx skills experimental_install` cannot do any of this — it hardcodes
  universal agents and ignores `--agent`/`--copy` entirely; that gap is why
  this skill exists.
- The zsh helper `skills-reinstall` in `~/.oh-my-zsh/custom/functions.zsh`
  delegates to this script — the script is the single source of truth.
- Sources listed as SSH host aliases (e.g. `mygit:owner/repo.git`) need that
  host configured in `~/.ssh/config`; https sources may prompt for
  credentials when the repo is private.
