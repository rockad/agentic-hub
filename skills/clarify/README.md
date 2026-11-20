# clarify

A skill that walks a non-trivial design through its open decisions ("forks"), one question at a time. Each question gets a full write-up: context, argued options with pros and cons, and a recommendation. Each answer is taken through the harness's interactive question tool.

- `/clarify`, `/grill-me` run Mode A, the standard architecture mode.
- `/cplain`, `/celi5` run Mode B, plain English with analogies. They are thin aliases in `skills/cplain` and `skills/celi5`, and the protocol lives here.

Works in Claude Code, Google Antigravity and OpenCode.

## Files

- `SKILL.md`: the core protocol, always loaded. It holds the rules that apply on every question (same-reply, per-fork, option naming, counter prefix, locked fork count, terse styles, Claude Code dialog rules), target resolution, the fork taxonomy, the Mode A step format, the CLI fallback, after-answer order and anti-patterns.
- `references/antigravity.md`, `references/claude-code.md`, `references/opencode.md`: the dialog format and examples for one harness. The session reads only its own.
- `references/plain-mode.md`: the Mode B (`/cplain`, `/celi5`) step format, decision table and artifact. Read only in Mode B.
- `references/closing.md`: the decision table, artifact, workstream table and execution handoff. Read only after the last fork.
- `hooks/clarify-stop-check.sh`: the Antigravity Stop hook, required in Antigravity (see below).

## Install

- **Agent Skills / Antigravity:** `npx skills add rockad/agentic-hub --skill clarify`. Repeat the command with `--skill cplain` and `--skill celi5` for the aliases.
- **Claude Code marketplace:** `/plugin install clarify@agentic-hub`

Install from `main`. `npx skills add` copies the whole `skills/clarify/` directory, including `hooks/`.

## Antigravity: enable the Stop hook (required)

In Antigravity, the model can end a reply with a question's full write-up printed but **no `ask_question` call**, so no picker appears. This happens when the skill used tools (codebase discovery) before Question 1. Rules in `SKILL.md` alone did not fix it in testing; see issue #79. `hooks/clarify-stop-check.sh` catches that case and makes the agent continue and call `ask_question`.

The skill install does **not** register the hook. Add this entry to `~/.gemini/config/hooks.json`, merging it with any hooks already there:

```json
{
  "clarify-require-tool-call": {
    "enabled": true,
    "Stop": [
      {
        "type": "command",
        "command": "~/.agents/skills/clarify/hooks/clarify-stop-check.sh",
        "timeout": 5
      }
    ]
  }
}
```

With `jq`, keeping existing hooks:

```bash
f=~/.gemini/config/hooks.json
jq '. + {"clarify-require-tool-call": {"enabled": true, "Stop": [{"type": "command", "command": "~/.agents/skills/clarify/hooks/clarify-stop-check.sh", "timeout": 5}]}}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
```

What the hook does:
- It acts only when a reply ends without a tool call (`terminationReason: "NO_TOOL_CALL"`) right after a `## Question N` heading in a clarify session. It then returns `{"decision":"continue", ...}`.
- A clarify session starts at a `/clarify` (or alias, any case) command, a `Target resolved:` line, an `Identified N orthogonal` or `Decomposing into N orthogonal` line, or an `ask_question` call tagged `[Question N of M]` or `[Fork N of M]`. Any mention of the command arms it, including in unrelated prose.
- It ends at a `Decision Table` heading (any case; optional number, emoji, `Final`, quote marker or bold) in a reply with no `## Question` heading, once the last question has been asked (`N >= M`), or when a `Gated Execution` heading shows the run ended early. It also closes if no question was tracked yet. A reply that itself calls `ask_question` never closes the session. `Fork map revised: N → M` updates the total. A table or artifact recap in the middle of a series does not end it. A run that stops early with only the table (no gate) leaves the session armed.
- Outside the session the hook stays silent. Headings inside fenced code blocks are ignored (CommonMark fence rules, CRLF handled). Only `## Question N (of M)` or `## Question N —` headings count.
- It also ends the session when the user abandons the series (#82). The user's message after the last question (the `A1: ...` answer of an `ask_question`, including a write-in, or a typed message) counts as a cancel when it opens with an explicit cancel phrase that ends the sentence or leads into a new request (`forget that.`, `never mind, write ...`, `cancel`, `stop`, `let's stop here`, `I'm done`, `that's enough`, `skip clarify`), or when it is a different slash command (`/jev status`). A phrase inside an ordinary answer (`never mind the cost, go with A`, `stop using Redis`) is still an answer. A new `/clarify` or a tagged `ask_question` arms the hook again.
- Safety net: after 2 consecutive interventions with no `ask_question` call and no user turn in between, the hook stands down (returns `{}`) and prints one line on stderr (`standing down after N consecutive interventions ...`). The count comes from the hook's own earlier `Stop hook blocked termination` messages in the transcript. It resets on an `ask_question` call and on a user turn. A genuine stall is one intervention away from being fixed, so the cap does not weaken the #79 fix.
- Known gaps (#82): a "new unrelated request" that is not a slash command and is not phrased as a cancel (for example `now write me an FAQ`) is not recognised, so the first `## Question N` reply after it still draws up to 2 interventions. The cancel phrase list is English only. If Antigravity omits the hook's own block messages from `transcript.jsonl`, the cap does not engage and only the cancel check protects against the loop (not verified).
- Tests set `CLARIFY_HOOK_STRICT=1` so a broken jq program exits 3 instead of failing open. Normal use never sets it.
- `continuationActive` alone did not prevent a loop in live run E8 (17 interventions in a row on an abandoned series), which is why the cap above exists.
- It fails open (returns `{}`) if `jq` or the transcript is missing.
- It needs `bash` and `jq`. It takes about 15 ms on a typical transcript and about 200 ms on an 11 MB one.

Check it:

```bash
jq '."clarify-require-tool-call".enabled' ~/.gemini/config/hooks.json   # true
test -x ~/.agents/skills/clarify/hooks/clarify-stop-check.sh && echo ok
```

To turn it off, set `"enabled": false`, or delete the `clarify-require-tool-call` entry.

Claude Code and OpenCode need no hook.

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
  ~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl
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
