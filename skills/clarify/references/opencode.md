# clarify reference: OpenCode (`question`)

Read this once before the first question when the `question` tool exists. The core `SKILL.md` rules still apply on every question: the Per-fork invariant, the Same-Reply Invariant, the option naming rule and the counter prefix rule.

Uses `question` following standard option schema with `Option A:` labels:

**Mode A (Standard Architecture):**
```json
question({
  "questions": [
    {
      "header": "Fork 1/5",
      "question": "[Question 1 of 5] Which data model should we use for record tagging?",
      "options": [
        {
          "label": "Option A: M:N join table (Recommended)",
          "description": "Normalized join table with compound unique index. Flexible queries, zero migration debt."
        },
        {
          "label": "Option B: Denormalized JSONB array",
          "description": "Embedded JSON array on record. Faster writes, but slower tag aggregation and no foreign keys."
        },
        {
          "label": "Option C: Single-tenant delimited string",
          "description": "Simple comma-delimited string in record column. Zero relations, but fragile querying."
        }
      ]
    }
  ]
})
```

**Mode B (Plain English / ELI5):**
```json
question({
  "questions": [
    {
      "header": "Fork 1/5",
      "question": "[Question 1 of 5] How should we organize user tags on records?",
      "options": [
        {
          "label": "Option A: The Digital Sticky Tag (M:N Join Table) (Recommended)",
          "description": "Like reusable sticky notes. Independent, clean, but needs a separate index card box."
        },
        {
          "label": "Option B: The Direct Sharpie Label (Denormalized JSONB)",
          "description": "Like writing directly on the folder. Fast to write, but harder to search all folders for one tag."
        },
        {
          "label": "Option C: The Comma List on the Box (Delimited String)",
          "description": "Writing tags separated by commas. Quickest to start, messy to organize later."
        }
      ]
    }
  ]
})
```
