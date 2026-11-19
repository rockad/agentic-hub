# clarify

A skill that walks a non-trivial design through its open decisions ("forks"), one question at a time. Each question gets a full write-up: context, argued options with pros and cons, and a recommendation. Each answer is taken through the harness's interactive question tool.

- `/clarify`, `/grill-me` run Mode A, the standard architecture mode.
- `/cplain`, `/celi5` run Mode B, plain English with analogies. They are thin aliases in `skills/cplain` and `skills/celi5`, and the protocol lives here.

Works in Claude Code, Google Antigravity and OpenCode.

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
- It cannot loop, because it stays silent while `continuationActive` is true. It also stays silent outside clarify.
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
