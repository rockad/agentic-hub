"""Known-names spelling pass — an opt-in, deterministic fix for proper nouns.

Recognition is tuned on ordinary words and unreliable on names it has never
seen: measured across four recogniser configurations on this plugin's own
test recordings, a colleague's name or a product's name came out spelled
correctly about **one time in eight**. There is no model fix for this that
belongs in a plugin other people install — the wrong spelling is different
for every person's colleagues and every team's jargon, so the correction has
to come from the one person who already knows the right answer.

`--names-file` supplies that answer as a plain list of `correct: misheard`
lines, **or** as a Markdown file whose body holds a table — see
`parse_names_file` for how the two are told apart. This module does nothing
but literal, whole-word substitution of one exact string for another — no
fuzzy matching, no similarity score, because a regex a maintainer can read
and a user can audit is safer here than a heuristic that might "fix" a word
that was never wrong. **Off by default**, and the repository ships only a
fictional example: a real list of a user's colleagues is personal data that
must never sit in a public plugin's git history
(`references/known-names.example.txt` is not enrolled or read automatically
— the user's own file lives wherever they keep it, outside this repository,
the same rule `lt/voices.py` follows for voice prints).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass
class Correction:
    correct: str
    misheard: list[str]
    # Some canonical forms are ordinary words rather than proper nouns —
    # `handover`, `private networks`, `container registry`. Those still want
    # priming and repair, but `apply` matches every entry against itself
    # case-insensitively to canonicalise casing, which would retitle a
    # sentence-initial "Handover" to lower case and rewrite ordinary prose
    # into title case. `prime_only` tells `apply` to skip exactly that
    # self-match for this entry, while priming and any recorded renderings
    # keep working normally. Only the Markdown table reader below sets it —
    # see its docstring for the `prime only` marker.
    prime_only: bool = False


# A rendering in the second column of a table row is quoted, either as
# Markdown code or in guillemets. Anything unquoted in that column is prose
# about the term, not a string to match.
_QUOTED = re.compile(r"`([^`]+)`|«([^»]+)»")
_EXCLUDED_MARKER = "excluded"
_PRIME_ONLY_MARKER = "prime only"


def _looks_like_a_table(text: str) -> bool:
    """A note's body reads as a table when it carries at least one row — a
    line starting `| ` — that is not a header separator (`| ---`).

    Detected from the content, not the file's extension: a `.md` file that
    is really just a plain list is read as one, and (for whatever it is
    worth) a `.txt` file that happens to hold a table is read as a table.
    """
    return any(
        line.startswith("| ") and not line.startswith("| ---")
        for line in text.splitlines()
    )


def _parse_table(text: str) -> list[Correction]:
    """A generic two-column Markdown table reader.

    The first column is the canonical spelling, the second is the
    renderings recognition actually produced, and any further column is
    ignored. **This stays a plain two-column-table reader and acquires
    nothing specific to any one note** — no hardcoded terms, paths or
    section names, no assumption about which headings exist.

    A row is a line starting `| `; a header-separator row (`| ---`) is
    skipped, as is one whose first cell is empty, is the literal header
    `Canonical`, or begins with `[` (a link rather than a term).

    **Renderings are taken only from the part of the second cell before the
    first em-dash (`—`), and only from quoted strings** — Markdown backticks
    or «guillemets». Prose after the dash explaining the term carries
    backticks too, and a sentence explaining that a rendering was *removed*
    would otherwise put it straight back into the list.

    A row whose second cell contains `excluded` is skipped entirely: some
    canonical spellings are ordinary English phrases, and being listed at
    all would canonicalise casing throughout the transcript, corrupting
    correct prose to fix nothing. **`prime only` is usually what you want
    instead** — it keeps the row, primes and repairs it, and only skips
    canonicalising it against itself; see `Correction.prime_only`.

    Rows are de-duplicated by canonical spelling, case-insensitively,
    keeping the first.
    """
    corrections: list[Correction] = []
    seen: set[str] = set()
    for line in text.splitlines():
        if not line.startswith("| ") or line.startswith("| ---"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue

        canonical = re.sub(r"[`*]", "", cells[0]).strip()
        if not canonical or canonical == "Canonical" or canonical.startswith("["):
            continue

        column = cells[1]
        if _EXCLUDED_MARKER in column.lower():
            continue
        prime_only = _PRIME_ONLY_MARKER in column.lower()

        key = canonical.lower()
        if key in seen:
            continue
        seen.add(key)

        misheard = []
        for match in _QUOTED.finditer(column.split("—")[0]):
            rendering = (match.group(1) or match.group(2)).strip()
            if rendering and rendering.lower() != canonical.lower():
                misheard.append(rendering)

        corrections.append(Correction(canonical, misheard, prime_only=prime_only))
    return corrections


def parse_names_file(path: Path) -> list[Correction]:
    """Read a names file, either format it comes in.

    **Plain list** — `Correct Spelling: misheard one, misheard two` per
    line. Blank lines and lines starting with `#` are skipped, so a file can
    carry comments about where a term came from. A line may list no
    mis-recognitions at all — just `Kubernetes`. That used to be refused as
    a silent no-op, and was, while substitution was this file's only job. It
    now also primes the recogniser's vocabulary before decoding, where a
    bare term is the most useful entry there is: a primed term is usually
    recognised correctly in the first place, which is a better outcome than
    repairing it afterwards.

    **Markdown table** — a two-column table, canonical spelling then
    renderings; see `_parse_table`. This is the shape someone keeping their
    vocabulary in a note already has, so deriving a separate plain list from
    it by hand, and keeping the two in step, is no longer necessary. Which
    format a file holds is detected from its content, not its extension:
    only a file whose body actually carries table rows is read as a table,
    so an ordinary `.md` list of bare terms or `correct: misheard` lines is
    still read as a plain list.
    """
    text = path.read_text(encoding="utf-8")
    if _looks_like_a_table(text):
        return _parse_table(text)

    corrections: list[Correction] = []
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        # A line with no colon at all is a bare term: prime it, correct
        # nothing. That is the most common entry once the file feeds the
        # recogniser as well as the repair, so requiring a trailing colon
        # would be ceremony rather than safety.
        correct, _, rest = line.partition(":")
        correct = correct.strip()
        misheard = [m.strip() for m in rest.split(",") if m.strip()]
        if not correct:
            raise ValueError(f"{path}:{line_number}: no correct spelling before the ':'")
        corrections.append(Correction(correct, misheard))
    return corrections


def _whole_word_pattern(phrase: str) -> re.Pattern[str]:
    """`phrase` may be several words ("Cooper Netease") — the boundary sits
    at its two ends only, so it is matched and replaced as one unit rather
    than word by word."""
    return re.compile(rf"(?<!\w){re.escape(phrase)}(?!\w)", re.IGNORECASE)


def apply(text: str, corrections: list[Correction]) -> tuple[str, int]:
    """Replace every mis-recognition with its correct spelling, and canonicalise.

    Returns the corrected text and how many substitutions were made, which
    the caller puts in the transcript header — a silent correction of
    someone's own transcript is exactly the kind of thing this plugin refuses
    to do everywhere else, and a spelling pass is no exception.

    **A term is also matched against itself**, case-insensitively, so one term
    ends up spelled one way throughout. That is not pedantry: measured across
    a single 55-minute recording, `Object Storage` appeared 15 times and
    `object storage` 9, `VPC` 9 times and `vpc` 4, and `managed Kubernetes`
    came out four different ways in one file. Each of those is recognised
    *correctly* — nothing is misheard — but a reader sees four things and a
    search for the canonical form finds a fraction of the mentions.

    **Unless `correction.prime_only` is set** — an entry for an ordinary word
    or phrase rather than a proper noun, which still wants priming and
    repair but must never be retitled wherever it already appears correctly.
    For such an entry the self-match is skipped; its recorded renderings are
    still corrected normally.
    """
    count = 0
    for correction in corrections:
        # The correct form first, so a variant of it is normalised before any
        # mis-hearing is expanded into it; a replacement that already matches
        # the canonical spelling exactly costs nothing and is not counted.
        # `prime_only` drops the correct form from this list entirely, since
        # matching it against itself is exactly the canonicalisation such an
        # entry must not get.
        targets = correction.misheard if correction.prime_only else [
            correction.correct, *correction.misheard
        ]
        for target in targets:
            pattern = _whole_word_pattern(target)
            replaced = 0

            def _sub(match: re.Match[str]) -> str:
                nonlocal replaced
                if match.group(0) == correction.correct:
                    return match.group(0)
                replaced += 1
                return correction.correct

            text = pattern.sub(_sub, text)
            count += replaced
    return text, count


def apply_to_utterances(utterances, corrections: list[Correction]) -> int:
    total = 0
    for utterance in utterances:
        utterance.text, made = apply(utterance.text, corrections)
        total += made
    return total


def apply_to_segments(segments, corrections: list[Correction]) -> int:
    total = 0
    for segment in segments:
        segment.text, made = apply(segment.text, corrections)
        total += made
    return total


# Whisper's decoder reserves half its 448-token context for the prompt, so
# 224 tokens is the hard ceiling and anything longer is **silently truncated
# from the front** — the tail survives, the head is discarded. A real derived
# list of 206 terms measured 651 tokens, which would have primed the site
# codes at the end of the file and dropped every product and person name at
# the start: the terms the measurement showed priming actually fixes. So the
# budget is counted, not assumed, and it is deliberately well under the
# ceiling because, with no real tokeniser available, the count itself has to
# be an estimate too (see `CHARS_PER_TOKEN` below).
PROMPT_TOKEN_BUDGET = 180

# The fallback estimate, used only when no real tokeniser could be loaded
# (see `_load_tokenizer`). Characters per token, conservatively: English runs
# about four, but Cyrillic tokenises far worse — often one token per
# character or two — and these lists mix the two freely. Two is the safe
# assumption for a mixed list; being wrong in this direction wastes a little
# of the window, and being wrong the other way silently loses the terms at
# the front.
CHARS_PER_TOKEN = 2


@lru_cache(maxsize=1)
def _load_tokenizer():
    """Whisper's own tokeniser, if one is importable — else `None`.

    Loaded lazily, on first use, and any failure to import or build it is
    silent and safe: **this module must stay importable with no ASR engine
    installed**, which is what lets every test in this file, and the whole
    of `evals/naming_test.py`, run with no engine present. `spelling.py`'s
    own script header carries no dependency on either package for exactly
    this reason.

    Only `mlx_whisper`'s bundled multilingual vocabulary counts, because it is
    the one the decoder actually tokenises the prompt with. ⛔ **A different
    tokeniser is worse than no tokeniser here, and `tiktoken`'s GPT-2 encoding
    in particular must not be substituted.** Measured on a real 212-term
    vocabulary: Whisper's own tokeniser fits 27 terms in the budget, GPT-2
    claims 30. Trusting the higher number would overfill the window, and an
    over-long prompt is truncated **from the front** — silently dropping the
    terms at the start of the list, which is precisely the failure this budget
    exists to prevent.

    So the fallback is the character estimate, which errs the safe way by
    under-filling. That it also measured accurate on real data — about 2.02
    characters per token against the 2 assumed — is luck rather than design,
    and the direction of the error is what matters.
    """
    try:
        from mlx_whisper.tokenizer import get_tokenizer

        return get_tokenizer(multilingual=True)
    except Exception:
        return None


def _prompt_cost(prompt: str, tokenizer) -> int:
    """What this prompt actually costs, as the decoder will count it.

    Tokens when a real tokeniser loaded; characters — the old estimate —
    when one did not, or when encoding this particular string somehow
    failed, which is treated the same as no tokeniser being available
    rather than allowed to crash a transcription run over a priming list.
    """
    if tokenizer is not None:
        try:
            return len(tokenizer.encode(prompt))
        except Exception:
            pass
    return len(prompt)


def primed_terms(corrections: list[Correction]) -> list[str]:
    """Which canonical spellings actually fit in the recogniser's prompt.

    **Terms with a recorded mis-hearing come first**, because those are the
    ones already observed to fail; a term with nothing recorded against it is
    included on the chance it helps, so it is the first to be dropped when the
    budget runs out. Within each group the note's own order is kept, so the
    result is stable and a reader can predict it.

    The budget itself is spent in real tokens, counted by
    `_load_tokenizer`'s tokeniser, when one is available — falling back to
    the character estimate only when it is not.
    """
    with_evidence = [c.correct for c in corrections if c.misheard]
    without = [c.correct for c in corrections if not c.misheard]

    tokenizer = _load_tokenizer()
    budget = (
        PROMPT_TOKEN_BUDGET if tokenizer is not None
        else PROMPT_TOKEN_BUDGET * CHARS_PER_TOKEN
    )

    # Measured against the prompt as it will actually be sent, not as a sum of
    # per-term costs. Byte-pair encoding merges across the joining ", ", so
    # costing each term in isolation and adding them up overshoots: on a real
    # 212-term vocabulary the isolated sum reached the 180-token budget while
    # the concatenated prompt was only 137 tokens, leaving a quarter of a
    # finite window unused. Re-encoding the candidate prompt each round costs
    # a few dozen encodes of a short string, which is nothing beside loading a
    # recognition model.
    kept: list[str] = []
    for term in [*with_evidence, *without]:
        candidate = [*kept, term]
        if _prompt_cost(", ".join(candidate) + ".", tokenizer) > budget:
            continue
        kept = candidate
    return kept


def prompt_from(corrections: list[Correction], limit: int | None = None) -> str | None:
    """The vocabulary as a priming prompt for the recogniser, or None.

    This is the half of the file that fixes recognition rather than repairing
    its output, and on code-switched speech it is the half that works. A
    Russian sentence carrying Latin technical terms came back as
    `кластер Кьюбор Ниц … Орго Акты Джитлэп` — plausible-sounding Cyrillic
    nonsense — from both auto-detected and forced-`ru` decoding. Priming the
    same terms returned `кластер Kubernetes, а также ArgoCD, GitLab`, exactly
    as spoken, three terms of three. Forcing the language made no difference
    either way, so the cause was never the language setting.

    Only the correct spellings go in, comma-separated: the prompt is what the
    recogniser should reach for, and feeding it known mis-hearings would
    prime the very strings this file exists to remove.

    **The list is capped by token budget, not by entry count**, and which
    terms survive the cap is decided by `primed_terms` rather than by where
    they happen to sit in the file. `limit` is accepted for callers that want
    a smaller set still and is applied after the budget, never instead of it —
    an entry count cannot protect a finite prompt window, which is the bug
    this replaced.
    """
    terms = primed_terms(corrections)
    if limit is not None:
        terms = terms[:limit]
    return ", ".join(terms) + "." if terms else None


__all__ = [
    "Correction",
    "apply",
    "apply_to_segments",
    "apply_to_utterances",
    "parse_names_file",
    "prompt_from",
]
