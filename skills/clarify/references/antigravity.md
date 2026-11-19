# clarify reference: Google Antigravity (`ask_question`)

Read this once before the first question when the `ask_question` tool exists. The core `SKILL.md` rules still apply on every question: the Per-fork invariant, the Same-Reply Invariant, the mandatory tool call rule, the option naming rule and the counter prefix rule.

Uses `ask_question`. The recommended option (Option A) is listed first and prefixed with `(Recommended)`. The question string is prefixed with `[Question N of Total]`. Always invoke `ask_question` in the same reply as `## Question 1 (of Total)` — do not end Turn 1 after the recommendation without calling the tool. The UI automatically prepends numbers (`1.`, `2.`, `3.`) and appends an `Other` option:

**Mode A (Standard Architecture):**
```json
ask_question({
  "questions": [
    {
      "question": "[Question 1 of 5] Which data model should we use for record tagging?",
      "options": [
        "(Recommended) Option A: M:N join table",
        "Option B: Denormalized JSONB array",
        "Option C: Single-tenant delimited string"
      ],
      "is_multi_select": false
    }
  ]
})
```

**Mode B (Plain English / ELI5):**
```json
ask_question({
  "questions": [
    {
      "question": "[Question 1 of 5] How should we organize user tags on records?",
      "options": [
        "(Recommended) Option A: The Digital Sticky Tag (M:N Join Table)",
        "Option B: The Direct Sharpie Label (Denormalized JSONB)",
        "Option C: The Comma List on the Box (Delimited String)"
      ],
      "is_multi_select": false
    }
  ]
})
```

*What the user sees in the Antigravity UI picker (Mode B):*
```
1. (Recommended) Option A: The Digital Sticky Tag (M:N Join Table)
2. Option B: The Direct Sharpie Label (Denormalized JSONB)
3. Option C: The Comma List on the Box (Delimited String)
4. Other
```

**Antigravity `Stop` hook (required; setup in `../README.md`)** (`hooks/clarify-stop-check.sh`, alongside `SKILL.md`): catches `NO_TOOL_CALL` replies containing `## Question N` without `ask_question` and returns `{"decision":"continue",...}` to force the missing `ask_question` call automatically. `~/.gemini/config/hooks.json`:
```json
{ "clarify-require-tool-call": {
  "enabled": true,
  "Stop": [{ "type": "command", "command": "~/.agents/skills/clarify/hooks/clarify-stop-check.sh", "timeout": 5 }]
} }
```

The skill install does not register the hook. See `../README.md` for the full setup and verification steps.
