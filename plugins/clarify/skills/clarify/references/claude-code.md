# clarify reference: Claude Code (`AskUserQuestion`)

Read this once before the first question when the `AskUserQuestion` tool exists. The core `SKILL.md` rules still apply on every question, and the dialog rules below add to them: the Per-fork invariant, the Same-Reply Invariant, the option naming rule, the counter prefix rule and the `→ next:` line.

Uses `AskUserQuestion` with a short `header` and `label`, a self-sufficient `description` and `preview` on every option, and `"multiSelect": false` (strictly required by Claude Code; `preview` renders only on single-select forks). Claude Code may show the user only the dialog, so the dialog carries the argument in addition to the prose step above it:

- **`description`**: two to three sentences per option — what it does, the main pro, the main con. Target 150–300 characters, never under 120. In Mode B it also carries the analogy.
- **`preview`**: a technical or mental-model block, followed by `+` pro lines and `- con` lines, about 6–12 lines in all. In Mode B it holds the sketch, an `Under the hood:` line, a `Door:` line (Tattoo or Sticker), then the `+` and `-` lines.
- **Prose stays**: the full step is still printed above the call (see the per-fork invariant). The dialog repeats the essentials; it does not replace the analysis.
- **Labels match the headings.** The dialog `label`s repeat the printed `### Option X.` headings letter for letter, and Option A is the recommended one (`Option A: <name> (Recommended)`). A `PreToolUse` hook (`hooks/clarify-labels.sh`) denies a dialog whose letters are out of order or whose recommended option is not A, and tells you to reprint the step. It cannot compare the prose itself: Claude Code writes the current reply to the transcript after `PreToolUse` hooks finish, so `scripts/check-clarify-transcript.sh` does that offline.
- **Final `→ next:` line**: every option's `preview` ends with `→ next: full Question N+1 write-up, then ask` (on the last fork: `→ next: decision table and closing`). The `AskUserQuestion` tool result echoes the chosen option's preview, so this line lands right beside any output-style brevity reminder and counters it. Keep previews within about 12 lines including it.

**Mode A (Standard Architecture):**
```json
AskUserQuestion({
  "questions": [
    {
      "header": "Fork 1/5",
      "question": "[Question 1 of 5] Which data model should we use for record tagging?",
      "multiSelect": false,
      "options": [
        {
          "label": "Option A: M:N join table (Recommended)",
          "description": "Normalized join table with a compound unique index on (record_id, tag_id). Tags are queryable from either side and a rename touches one row. Costs one extra join per tagged read and a separate table to migrate.",
          "preview": "record_tags\n  record_id -> records.id\n  tag_id    -> tags.id\n  UNIQUE (record_id, tag_id)\n\nRead: JOIN record_tags USING (record_id)\n+ FK integrity, rename a tag in one row\n+ indexed lookups from either side\n- extra join on every tagged read\n- one more table to migrate and back up\n→ next: full Question 2 write-up, then ask"
        },
        {
          "label": "Option B: Denormalized JSONB array",
          "description": "Embedded JSON array on the record row, queried through a GIN index. Writes stay in one row and reads need no join. Renaming or aggregating tags means scanning every row, and there are no foreign keys.",
          "preview": "records\n  id\n  tags: jsonb -- ['backend', 'urgent']\n\nIndex: GIN (tags jsonb_path_ops)\n+ single-row write, no join on read\n+ no extra table to migrate\n- rename a tag = rewrite every row\n- no FK, a typo becomes a new tag\n- tag counts need a full scan\n→ next: full Question 2 write-up, then ask"
        },
        {
          "label": "Option C: Single-tenant delimited string",
          "description": "Comma-delimited string in one text column on the record. Zero relations and the fastest start, but matching needs LIKE patterns, a typo silently creates a new tag, and fixing it later is a full data migration.",
          "preview": "records\n  id\n  tags: text -- 'backend,urgent'\n\nRead: tags LIKE '%urgent%'\n+ trivial to start, no schema work\n- LIKE cannot use a normal index\n- 'urgent' also matches 'non-urgent'\n- a comma inside a tag breaks parsing\n- later migration touches every row\n→ next: full Question 2 write-up, then ask"
        }
      ]
    }
  ]
})
```

**Mode B (Plain English / ELI5):**
```json
AskUserQuestion({
  "questions": [
    {
      "header": "Fork 1/5",
      "question": "[Question 1 of 5] How should we organize user tags on records?",
      "multiSelect": false,
      "options": [
        {
          "label": "Option A: The Digital Sticky Tag (M:N Join Table) (Recommended)",
          "description": "Like reusable sticky notes on a folder: each note lives in its own box and can be moved or renamed freely. Searchable from either side with clean integrity, but you maintain an extra index-card box (a join table).",
          "preview": "[Records] <---> [Sticky Tag Box] <---> [Tags]\n\nUnder the hood: record_tags join table, UNIQUE (record_id, tag_id)\nDoor: One-Way (Tattoo) - storage shape is hard to change once data is live\n+ rename a tag once, every folder follows\n+ searchable from either side\n- one more table to maintain\n- a join on every tagged read\n→ next: full Question 2 write-up, then ask"
        },
        {
          "label": "Option B: The Direct Sharpie Label (Denormalized JSONB)",
          "description": "Like writing tags in ink directly on the folder. Fast to write and nothing extra to maintain, but finding every folder with one tag means opening them all, and renaming a tag means rewriting each folder.",
          "preview": "[Record Folder]\n  tags in ink: [urgent, backend]\n\nUnder the hood: jsonb array column on records with a GIN index\nDoor: One-Way (Tattoo) - storage shape is hard to change once data is live\n+ one write, no joins\n+ no extra table\n- rename = rewrite 10,000 folders\n- no integrity check, typos spawn new tags\n→ next: full Question 2 write-up, then ask"
        },
        {
          "label": "Option C: The Comma List on the Box (Delimited String)",
          "description": "Like jotting tags separated by commas on the box lid. Quickest to start and needs no schema work, but a typo breaks the search, similar names collide, and untangling it later means rewriting every box.",
          "preview": "[Record Folder]\n  lid: \"urgent,backend\"\n\nUnder the hood: delimited text column, matched with LIKE\nDoor: One-Way (Tattoo) - storage shape is hard to change once data is live\n+ zero setup\n- typos and near-names silently break searches\n- no index can help, every search is a full scan\n- a comma inside a tag corrupts the list\n→ next: full Question 2 write-up, then ask"
        }
      ]
    }
  ]
})
```
