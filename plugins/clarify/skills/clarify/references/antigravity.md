# clarify reference: Google Antigravity (`ask_question`)

Read this once before the first question when the `ask_question` tool exists. The core `SKILL.md` rules still apply on every question: the Per-fork invariant, the Same-Reply Invariant, the option naming rule and the counter prefix rule.

Uses `ask_question`. The recommended option (Option A) is listed first and prefixed with `(Recommended)`. The question string is prefixed with `[Question N of Total]`. Always invoke `ask_question` in the same reply as `## Question 1 (of Total)` — never end Turn 1 after codebase discovery and the recommendation without calling `ask_question`. The UI automatically prepends numbers (`1.`, `2.`, `3.`) and appends an `Other` option:

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

The Antigravity UI automatically numbers the picker options and appends an `Other` option (rendered as `Write-in...` in the Antigravity CLI). Never print numbered text options in prose—always pass the options to `ask_question` instead.

**Antigravity option-label hook:** `hooks.json` also registers `hooks/clarify-labels.mjs` as a `PreToolUse` hook on `ask_question`. Antigravity writes the reply to the transcript before `PreToolUse` runs, so it compares the printed `### Option X.` headings with the picker labels (letters, order, the recommended option, and which option is which) and denies a mismatch, at most twice per question. After a denial, reprint the step with the corrected headings, then call `ask_question` again.

**Antigravity `Stop` hook:** The plugin bundles `hooks.json` at the plugin root to register `hooks/clarify-stop-check.mjs` (with the `clarify-stop-check.sh` wrapper) automatically on `agy plugin install`. It catches `NO_TOOL_CALL` replies containing `## Question N` without `ask_question` and forces the missing call. See the plugin README (`../../../README.md`) for details and verification steps.
