# clarify

A skill that walks a non-trivial design through its open decisions ("forks"), one question at a time. Each question gets a full write-up: context, argued options with pros and cons, and a recommendation. Each answer is taken through the harness's interactive question tool.

- `/clarify`, `/grill-me` run Mode A, the standard architecture mode.
- `/clarify:plain` and `/clarify:eli5` (`commands/`) in Claude Code, or `/clarify --plain` and `/clarify --eli5` in Antigravity, run Mode B, plain English with analogies. In Claude Code they are thin commands; in Antigravity they pass arguments to `/clarify`; the protocol lives in the skill. The old `/cplain` and `/celi5` standalone skills are gone.

Works in Claude Code, Google Antigravity and OpenCode.

## Files

- `SKILL.md`: the core protocol, always loaded. It holds the rules that apply on every question (same-reply, per-fork, option naming, counter prefix, locked fork count, terse styles, Claude Code dialog rules), target resolution, the fork taxonomy, the Mode A step format, the CLI fallback, after-answer order and anti-patterns.
- `references/antigravity.md`, `references/claude-code.md`, `references/opencode.md`: the dialog format and examples for one harness. The session reads only its own.
- `references/plain-mode.md`: the Mode B (`/clarify:plain`, `/clarify:eli5`, `--plain`, `--eli5`) step format, decision table and artifact. Read only in Mode B.
- `references/closing.md`: the decision table, artifact, workstream table and execution handoff. Read only after the last fork.
- `hooks.json`: the Antigravity root hook manifest that auto-registers `clarify-require-tool-call` on `Stop`.
- `hooks/clarify-stop-check.mjs` + `hooks/clarify-common.mjs`: the Antigravity Stop hook and shared transcript parser (with `hooks/clarify-stop-check.sh` kept as a compatibility wrapper; see below).

## Install

Clarify is a plugin, no longer a standalone skill, so `npx skills add --skill clarify` (and `cplain`, `celi5`) no longer works.

- **Claude Code marketplace:** `/plugin install clarify@agentic-hub`. This installs the skill, the `/clarify:plain` and `/clarify:eli5` commands and the Claude Code ask hook below, and a new version on `main` reaches you when the plugin updates. If you had installed the skill with `npx skills` earlier, remove that copy (`~/.claude/skills/clarify` and `~/.agents/skills/clarify`) so the skill does not load twice.
- **Antigravity plugin install (from `main`):**
  ```bash
  agy plugin install https://github.com/rockad/agentic-hub/tree/main/plugins/clarify
  ```
  Or from a local checkout:
  ```bash
  agy plugin install /path/to/agentic-hub/plugins/clarify
  ```
  Installing copies the plugin to `~/.gemini/config/plugins/clarify/` and auto-registers the Stop hook via `hooks.json`. To update from `main`, re-run `agy plugin install`.
- **Antigravity upgrade cleanup:** if you previously installed the standalone skill or registered the Stop hook manually, remove `~/.agents/skills/clarify` and delete the old `clarify-require-tool-call` entry from `~/.gemini/config/hooks.json` so neither the skill nor the hook loads twice.

## Antigravity: the Stop hook (plugin install)

In Antigravity, the model can end a reply with a question's full write-up printed but **no `ask_question` call**, so no picker appears. This happens when the skill used tools (codebase discovery) before Question 1. Rules in `SKILL.md` alone did not fix it in testing; see issue #79. `hooks/clarify-stop-check.mjs` (registered automatically via `hooks.json` on plugin install) catches that case and makes the agent continue and call `ask_question`.

Verify the installed plugin and hook registration:

```bash
agy plugin list --json | jq '.[] | select(.name == "clarify") | {enabled, skills, hooks}'
```

What the hook does:

- **What it catches:** acts only when a reply ends without a tool call (`terminationReason: "NO_TOOL_CALL"`) right after a `## Question N` heading (`## Question N (of M)` or `## Question N —`, ignoring fenced code blocks) in an active clarify session, returning `{"decision":"continue", ...}` so the agent calls `ask_question`.
- **When it arms and disarms:** arms on `/clarify` (or `/grill-me`, `/clarify:plain`, `/clarify:eli5`, etc.), `Target resolved:`, `Identified N orthogonal` / `Decomposing into N orthogonal`, or a tagged `ask_question` (`[Question N of M]` / `[Fork N of M]`); disarms on a closing `Decision Table` heading (once `N >= M`, `Gated Execution`, or if no question was tracked), an explicit cancel phrase or different slash command (#82), or an empty `A1: ` answer (Esc).
- **2-intervention stand-down cap:** after 2 consecutive `Stop hook blocked termination` interventions with no `ask_question` call and no user turn in between, the hook stands down (`{}`) and logs one line to stderr; the counter resets on `ask_question` or a user turn (`continuationActive` alone was insufficient in live run E8).
- **Fail-open design:** stays silent (`{}`) outside clarify sessions or if the transcript is missing or unreadable (tests set `CLARIFY_HOOK_STRICT=1` to exit non-zero on parser errors instead).
- **Runtime requirement:** requires `node`; runs `hooks/clarify-stop-check.mjs` using the shared parser in `hooks/clarify-common.mjs` (with `hooks/clarify-stop-check.sh` kept as a compatibility wrapper).
- **Verified Stop payload:** tested against Antigravity `1.5.15`'s 13-key Stop payload (`artifactDirectoryPath`, `continuationActive`, `conversationId`, `cwd`, `error`, `executionNum`, `fullyIdle`, `hookEventName`, `lastUserInput`, `modelName`, `terminationReason`, `transcriptPath` pointing to `transcript_full.jsonl`, `workspacePaths`).

OpenCode needs no hook. Claude Code has its own hook, below.

## Claude Code: the ask hook (plugin install)

Rules alone stopped holding in long sessions: after many turns or a compaction, forks 3 and later were asked with only the dialog and no write-up (issue #97). `hooks/clarify-ask-check.sh` is a `PreToolUse` hook on `AskUserQuestion`, registered by `hooks/hooks.json` through the plugin manifest.

- It acts only on a clarify question, whose text starts with `[Question N of M]` or `[Fork N of M]`. Other questions pass untouched.
- It looks at the assistant text since the last user entry (a prompt or a tool result). With no `## Question N` heading there, it denies the call and tells the model to print the full step and ask again.
- It denies each question number once per session. The transcript is written asynchronously and can lag, so a missing heading may be a false alarm; the retry passes, so the worst case is one extra round trip and it cannot loop.
- It fails open if `jq` or the transcript is missing. It needs `bash` and `jq`.
- Tests: `scripts/test-clarify-ask-hook.sh`. It only runs when the skill is installed as the plugin; a plain `npx skills` copy has no Claude Code hook.

## Claude Code notes

- Claude Code may show the user only the `AskUserQuestion` dialog. So each option carries a 2–3 sentence `description` and a `preview` with `+` and `-` lines.
- Every preview ends with a `→ next: full Question N+1 write-up, then ask` line. The answer echo repeats it right beside the brevity reminder of terse output styles such as Concise. Without it, questions 2 and later lost their write-up.

## Verify a session

`scripts/check-clarify-transcript.sh` (repo root, bash + `jq`) checks a session transcript:

```bash
# Claude Code
scripts/check-clarify-transcript.sh ~/.claude/projects/<project>/<session>.jsonl
# Antigravity
scripts/check-clarify-transcript.sh --format antigravity \
  ~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript_full.jsonl
```

- It fails a question that has no `## Question N` write-up before it, a Claude Code description under 120 characters, an empty preview, or a fork count that changes without a `Fork map revised` notice.
- In Antigravity, it also fails a question heading with no `ask_question` call in the same reply.
- It warns on a Claude Code preview without the `→ next:` line.
- Exit codes: `0` all pass, `1` a failure, `2` no clarify questions found, `3` usage error.

Background and test history: `docs/plans/clarify-claude-code-option-explanations.md` and issue #79.

## Relationship to the native `/grill-me`

In Google Antigravity, `/grill-me` is a built-in command that injects the native `<GRILL_ME>` prompt. This skill does not shadow or replace it. It treats `/grill-me` as a trigger and adds exhaustive fork decomposition (no 4-fork cap), codebase pre-flight, prose-first previews, a recommended Option A and a Jev-aware handoff. In Claude Code and OpenCode, where there is no native `/grill-me`, the skill provides the same interview under the same command.

## Keeping the skill light

`SKILL.md` loads in full on every trigger, so it has a line cap and a word cap enforced in CI by `scripts/check-clarify-skill.sh`, which also checks that the strings the Stop hook and the transcript checker depend on are still present. Add a rule once, in the rules block, not again in an anti-pattern or a note. Put long examples and conditional formats in `references/`.
