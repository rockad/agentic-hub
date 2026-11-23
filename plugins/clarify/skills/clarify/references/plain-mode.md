# clarify reference: Mode B, Plain English & Intuitive format (`/cplain`, `/celi5`)

Read this once before the first question, only in Mode B. The core `SKILL.md` rules still apply on every question: the Per-fork invariant, the Same-Reply Invariant, the mandatory tool call rule, the option naming rule and the counter prefix rule. Closing-time Mode B pieces (decision table and final artifact) are at the end of this file; the rest of the closing format is in `closing.md`.

Plain English mode translates technical trade-offs into accessible mental models, everyday analogies, and clear risk boundaries while maintaining technical precision underneath.

#### 1. Header with Door Type & Under the Hood Anchor

Every question in Plain Mode begins with a clear classification of reversibility and its technical domain:

```markdown
## Question N (of Total) — <Everyday Descriptive Name>
> **Door Type:** One-Way Door (Tattoo — high cost to reverse) | Two-Way Door (Sticker — easily changed)
> **Under the Hood:** <Formal Engineering Topic / Subsystem>
```

- **One-Way Door (Tattoo)**: High cost to reverse. Hard or destructive to undo once code and data are live (e.g. database schema topology, primary storage engine, public API protocol contracts).
- **Two-Way Door (Sticker)**: Easily changed. Low cost to reverse or iterate upon (e.g. cache TTL duration, polling interval, worker batch chunk size, internal retry limits).

#### 2. The 4-Question Framing

Structure the markdown prose above the tool call around these four questions:

##### 1. What problem are we actually solving?
1–2 plain-English sentences removing all jargon, explaining the practical user-facing or system challenge.

##### 2. What are our choices in plain English?
Present two to four mutually exclusive choices. **Option A is ALWAYS the Recommended Option** (`### Option A. <Analogy Name> (Recommended)`).

For each option, provide:
- **Everyday Analogy**: A relatable real-world comparison (e.g., "The Digital Sticky Tag", "The Fast-Food Drive-Through Lane", "The Central Dispatch Office").
- **Conceptual ASCII Sketch**: Simple mental model diagram (not raw code or DDL).
- **Under the Hood**: Formal engineering mechanism/term (e.g., `M:N Join Table with compound unique index`, `Redis pub/sub ring buffer`, `Optimistic locking with version column`).
- **Where the Analogy Breaks**: The exact boundary where the real-world analogy stops matching software reality, preventing false assumptions.

*Example Option Format:*
```markdown
### Option A. The Digital Sticky Tag (Recommended)
- **Everyday Analogy**: Like sticking a color-coded reusable post-it note on a folder.
- **Mental Model**:
  [Record Folder] <---> [Sticky Tag Box] <---> [Tag Name]
- **Under the Hood**: Normalized `record_tags` join table with foreign keys and compound unique index `(record_id, tag_id)`.
- **Where the Analogy Breaks**: Unlike physical sticky notes that fall off or tear, database join rows never peel off accidentally and enforce strict referential integrity.
```

##### 3. What are the tangible trade-offs & blast radius?
- **What gets easier (Pros)**: 2–3 concrete operational or developer benefits.
- **Failure Blast Radius / Rework Cost (Cons)**: What happens if this assumption is wrong? How much work is required to undo this decision? Who or what gets affected?

##### 4. Why is Option A the common-sense pick?
- 2–3 plain sentences explaining why Option A is the pragmatic default.
- Specific scenario or constraint under which the recommendation would flip to Option B or C.

Close with the recommendation line:

> **Recommendation:** **Option A: <Analogy Name> (<Formal Tech Anchor>)** — <one plain sentence explaining why>.

---

## Closing-time Mode B pieces

Use these when the series closes (see `closing.md` for the rest of the format).

### Decision Table (Mode B, Plain English / ELI5)

| # | Decision Topic | Plain English Analogy | Under the Hood | Door Type | Changed? |
|---|----------------|-----------------------|----------------|-----------|----------|
| 1 | Tag Storage | The Digital Sticky Tag | M:N Join Table | Two-Way (Sticker) | unchanged / revised |
| 2 | Cache Invalidation | The Daily Menu Board | TTL Cache Invalidation | One-Way (Tattoo) | new |

### Final Architecture Artifact (Mode B, Plain English / ELI5)

Dual-layer blueprint providing **both** the conceptual ASCII mental model (everyday system metaphor) and the formal technical specification (under-the-hood contracts, schemas, and invariants). This bridges the intuitive high-level understanding with rigorous implementation-ready contracts.
