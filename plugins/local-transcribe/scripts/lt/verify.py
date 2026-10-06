"""One block asking about everything a run was uncertain about.

Five different stages already produce their own uncertainty — an unnamed
speaker, a shaky voice match, a stretch of speech nobody could be matched to,
a word that does not look real, a term spelled two ways in one file — and
before this module existed each would have needed its own prompt, or would
have gone unmentioned. Neither is acceptable: a stream of separate questions
is exactly what a person with limited attention cannot act on, and staying
silent about a shaky identification is worse than staying silent about
nothing at all, because a wrong name repeated back with confidence is a
mistake dressed up as a fact.

So everything lands in **one compact block**: one Markdown section in the
transcript, one line printed to stderr, answerable in a single reply. It is
never in the way of using the file — a transcript with every category below
empty is identical to one with `--no-verify` passed, and a transcript with
every category firing is still a transcript, complete, with the questions
appended rather than gating anything on them. `--verify` is on by default and
`--no-verify` turns the whole thing off, the same shape as `--identify`.

## The five categories, and what each one actually checks

1. **Unresolved speakers** — `lt/naming.py`'s own finding, reused rather than
   duplicated. `resolve_names` already decides which numbered speakers it can
   name and which it cannot; this module only adds a place for the second
   group to land that is not its own separate ask. See `build`'s `unresolved`
   parameter and `naming.render_unresolved`/`naming.summarize_unresolved`,
   which this module's own rendering reuses verbatim rather than
   reimplementing the same evidence format a second time.

2. **Low-confidence speaker identifications.** `lt/voices.py`'s `identify`
   only ever names a cluster once its best match clears both
   `IDENTIFY_THRESHOLD` (0.55) and `IDENTIFY_MARGIN` — that bar decides
   whether a name is asserted *at all*, and it is deliberately generous once
   past it: measured on this plugin's own held-out data, a genuine match ran
   0.744-0.772 median across two recordings, and 0.89-0.97 on the recording a
   print was actually built from, against an impostor's 0.392-0.415. A match
   that clears the accept bar but lands well below that range — `0.72`, say
   — is not a failure worth refusing, but it is a name that has not been
   *confirmed*, only permitted, and confirming it costs one line rather than
   a wrong name quoted back as fact in every later reference to that
   speaker. `LOW_CONFIDENCE_BELOW` (0.80) is picked with real headroom below
   the measured genuine-match floor of 0.744, on the reasoning that a match
   sitting closer to the accept floor than to a typical genuine score is the
   one worth a human glance, not the one comfortably inside it.

3. **Unattributed turns.** `lt/label.py` leaves a segment's speaker as
   `None` when no diarized turn overlaps it at all — too quiet, overlapped,
   or music — and the transcript renders it as `Unattributed` rather than
   guessing. One such line is unremarkable; several, or a long one, means a
   real stretch of the recording has no speaker on it, which is worth
   knowing about before the transcript is trusted as complete. Reported as
   **one group** — a count, a total duration, and a handful of timestamps —
   never one line per turn, because a transcript with forty short
   unattributed turns should cost the reader one line to learn about, not
   forty.

4. **Suspected mangled proper nouns.** Recognition mishears names it has
   never seen, and it mishears them in a specific shape often enough to be
   worth catching automatically: real examples from this plugin's own test
   recordings include an interviewee's name coming out as an unrelated short
   word, an acronym-and-word compound losing a letter, and a technical term
   losing its shape entirely into a run of capitalised fragments. What this
   module actually detects is much narrower than "a mangled name" in
   general, because most of that is undetectable without a dictionary — see
   the warning below. It flags a Latin-script token that:

   - is rare (`MANGLING_MAX_COUNT` or fewer occurrences of that exact
     spelling in the whole file — a name that recurs a dozen times has
     already been seen and judged, correctly or not, and repeating the ask
     for something already read past several times is noise);
   - is not already named in the user's own `--names-file`, if one was
     given (`known_terms`) — this module never re-asks about something the
     user has already told the pipeline about, whichever direction that
     correction runs;
   - and carries an **irregular internal capital** — a lowercase letter
     immediately followed by an uppercase one, or two or more capitals at
     the very start followed by a lowercase run (`QBornets`-shaped). This is
     a narrow, mechanical shape check, not a spelling check: it fires on
     `QBornets` and on nothing at all in ordinary prose, because an ordinary
     English word or name has one capital, at the start, with nothing
     lowercase before it.

   ⚠️ **What this deliberately does not attempt, and why:**

   - **A hyphenated acronym-word splice** (`CR-adress`-shaped) is not
     checked, on purpose. The shape that would catch it — a short run of
     capitals, a hyphen, a lowercase word — is indistinguishable from an
     entirely ordinary compound adjective: `US-based`, `AI-driven`,
     `EU-wide` have exactly the same shape and are correct. There is no
     way to tell the two apart from shape alone, and flagging every
     `XX-word` compound in a transcript that talks about geography or
     technology at all would be exactly the ten-false-positives-to-avoid-one
     this module exists to prevent. So a mangling that only shows up this
     way is missed, deliberately, rather than drowned in noise.
   - **A mangling that happens to spell a real word** (an interviewee's
     name coming out as an ordinary short English word, in this plugin's
     own test data) is undetectable by any shape or frequency check — it
     needs the meaning of the sentence, which is exactly the kind of
     judgement this module refuses to make silently. Nothing here claims to
     catch it.
   - **A genuine camelCase brand name mentioned once or twice**
     (`iPhone`, `eBay`, a colleague's product with its own capitalisation)
     looks exactly like a mangled one under this check and will be flagged
     too. That is an accepted cost: a false positive here is one line in a
     block the reader can skip entirely, never a wrong assertion in the
     transcript itself.
   - ⛔ **A Latin term rendered into Cyrillic is never attempted here, at
     all** — `Linear` coming out as `линии`, `CEO` as `SEO`. There is no
     reliable test for that without a Russian lexicon, the same reasoning
     `lt/spelling.py`'s module docstring gives for why it is not attempted
     there either, and a bad heuristic for it would be worse than nothing.
     The remedy is the same one `spelling.py` already offers: once a reader
     spots the rendering, they add that exact string to their
     `--names-file` and it is corrected and primed from then on. This
     module's own token matching only ever looks at Latin-script text
     (`_WORD`), so it structurally cannot attempt the Cyrillic case even by
     accident.

5. **Casing and spelling variants of one term.** The same failure
   `lt/spelling.py`'s docstring measures — `Object Storage` fifteen times
   and `object storage` nine, in one real 55-minute recording, both
   *correctly* recognised and still bad output — is worth catching even
   before the user has written a `--names-file` entry for it. This groups
   every 1-3 word phrase in the transcript case-insensitively, and flags a
   group once it has **two or more distinct exact-case spellings** and
   **at least `CASING_MIN_TOTAL` occurrences in total**.

   The one deliberate design choice here is what keeps this from firing on
   ordinary English: **the first word of every sentence is never a
   candidate.** Sentence-initial capitalisation ("The project is on
   track" vs. "we discussed the project") is not a spelling inconsistency,
   it is English grammar, and without excluding it this check would fire on
   nearly every common noun in the file. Excluding it, plus requiring a
   minimum total count, plus requiring the phrase to contain at least one
   word that is not on a short stop-word list, is what keeps this
   deliberately quiet on ordinary prose and only loud on the same kind of
   repeated technical term `spelling.py` was written to canonicalise.

## Corrections should stick — the `--names-file` loop

Nothing in this module writes to a file on its own; that would be a silent
edit to something the user is supposed to own and audit (`spelling.py`'s own
rule, `Correction`/`parse_names_file`). What it does instead is **say which
file an answer belongs in**: every rendered block names the user's own
`--names-file` if one was given, or says one can be created, so that
answering "GitLab is canonical" or "QBornets was Kubernetes" is naturally an
edit to that one file — `Correct Spelling: misheard one, misheard two` per
line, as `spelling.py` already documents — rather than an answer that
evaporates once this run's terminal scrolls past it. The next recording that
mentions the same term is then primed and corrected automatically, and this
module has nothing left to ask about it.

## Pure functions, tested without audio or a model

Every decision in this module takes plain data — `Utterance` lists, already-
recognised text, already-scored matches — and returns a plain result; nothing
here touches `sherpa-onnx`, `ffmpeg`, or a real recording. `evals/verify_test.py`
covers each category firing when it should and staying quiet when it should,
on invented `Utterance` lists, the same split `naming_test.py` and
`voices_test.py` use for their own pure decisions. `evals/smoke.sh` checks
the two facts a unit test cannot: a clean real transcription produces no
block at all, and a real run with something genuinely unresolved produces
one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .label import Utterance
from .naming import UnresolvedSpeaker, render_unresolved, summarize_unresolved
from .transcript import hhmmss
from .voices import SpeakerMatch

# See "Low-confidence speaker identifications" above for the measurements
# behind this number: real matches ran 0.744-0.772 median (0.89-0.97 on the
# recording a print was built from), impostors 0.392-0.415, and the accept
# floor in lt/voices.py is 0.55. A match below 0.80 cleared that floor but
# sits closer to it than to a typical genuine score, which is the line worth
# a human glance rather than silent trust.
LOW_CONFIDENCE_BELOW = 0.80

# How many of an unattributed group's timestamps to show — enough to spot-
# check without turning "one group" back into "one line per turn".
UNATTRIBUTED_SAMPLE = 3

# A rendering of a mangled token is worth confirming once or twice; a term
# repeated a dozen times has already been read, judged, and presumably
# accepted (or corrected) by the time it recurs that often.
MANGLING_MAX_COUNT = 2
MANGLING_MIN_LENGTH = 4

# A phrase needs this many total mentions, across all its exact-case
# spellings, before a casing split is worth asking about — one utterance
# that happens to case something unusually is not a pattern.
CASING_MIN_TOTAL = 3
CASING_MAX_NGRAM = 3

# How many findings of the noisier categories to show before truncating —
# keeps the block compact even on a file with a genuinely long tail of small
# issues; the point is one short reply, not an exhaustive audit.
MAX_MANGLINGS = 8
MAX_CASING_GROUPS = 5

_WORD = re.compile(r"[A-Za-z][A-Za-z'-]*")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")

# A lowercase letter immediately followed by an uppercase one ("boRnets"), or
# two-or-more capitals at the very start followed by a lowercase run
# ("QBornets") — see the module docstring for what this deliberately does and
# does not catch, and why.
_IRREGULAR_CAPITAL = re.compile(r"[a-z][A-Z]|^[A-Z]{2,}[a-z]")

# "GPUs", "LLMs", "IBEs", "SVNs" — an all-capital acronym carrying a plural
# `s` matches `_IRREGULAR_CAPITAL`'s second branch, and not one of them is a
# mis-hearing. Measured on five real meetings: four of the eight manglings
# reported on the noisiest file were this single shape, so suppressing it is
# most of what made that block worth reading.
_ACRONYM_PLURAL = re.compile(r"^[A-Z]{2,}'?s$")

# Common English function words, excluded so a casing group needs at least
# one word that is not one of these — otherwise "the project"/"The project"
# (sentence-initial "The" is already excluded separately) or similar function
# words would count as a "term" worth asking about.
_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
    "can", "could", "did", "do", "does", "don", "each", "for", "from", "get",
    "got", "had", "has", "have", "he", "her", "here", "hi", "him", "his",
    "how", "i", "if", "in", "into", "is", "it", "its", "just", "like", "me",
    "more", "most", "my", "no", "nor", "not", "now", "of", "ok", "okay",
    "on", "one", "or", "other", "our", "out", "over", "own", "s", "same",
    "she", "should", "so", "some", "sure", "t", "than", "that", "the",
    "their", "them", "then", "there", "these", "they", "this", "those",
    "thanks", "to", "too", "two", "up", "us", "very", "was", "we", "well",
    "were", "what", "when", "where", "which", "who", "why", "will", "with",
    "would", "yeah", "yep", "yes", "you", "your",
}


@dataclass
class LowConfidenceMatch:
    speaker: str
    similarity: float
    first_utterance: str


@dataclass
class UnattributedGroup:
    count: int
    total_seconds: float
    sample_timestamps: list[str]


@dataclass
class SuspectedMangling:
    token: str
    count: int
    first_context: str
    at: float


@dataclass
class CasingGroup:
    # (exact spelling, count), sorted most-frequent first.
    variants: list[tuple[str, int]]
    # How many further phrases varied in the *same* single word and were
    # folded into this one — see `casing_variants`.
    folded: int = 0


@dataclass
class VerificationBlock:
    unresolved_speakers: list[UnresolvedSpeaker] = field(default_factory=list)
    low_confidence: list[LowConfidenceMatch] = field(default_factory=list)
    unattributed: UnattributedGroup | None = None
    manglings: list[SuspectedMangling] = field(default_factory=list)
    casing: list[CasingGroup] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not (
            self.unresolved_speakers
            or self.low_confidence
            or self.unattributed
            or self.manglings
            or self.casing
        )


def low_confidence_identifications(
    matches: list[SpeakerMatch], utterances: list[Utterance]
) -> list[LowConfidenceMatch]:
    """Every accepted identification below `LOW_CONFIDENCE_BELOW`.

    `matches` is only ever what `voices.identify` actually accepted — this
    never second-guesses the threshold and margin identification already
    applied, it only flags an accepted match that is closer to that bar than
    to a confident one. `utterances` must already carry the renamed speaker
    labels, since that is the only way to find this speaker's own words to
    quote as evidence.
    """
    from .naming import first_substantive_line  # local: avoid a cycle at import time

    found: list[LowConfidenceMatch] = []
    for match in matches:
        if match.similarity >= LOW_CONFIDENCE_BELOW:
            continue
        theirs = [u for u in utterances if u.speaker == match.speaker]
        first = first_substantive_line(theirs) if theirs else ""
        found.append(LowConfidenceMatch(match.speaker, match.similarity, first))
    found.sort(key=lambda m: m.similarity)
    return found


def unattributed_group(utterances: list[Utterance]) -> UnattributedGroup | None:
    """One group covering every turn no speaker could be matched to.

    Never one line per turn — see the module docstring. Returns `None` when
    there is nothing to report, so a caller can always treat the result as
    "present or not" without checking `count` itself.
    """
    unattributed = [u for u in utterances if u.speaker is None]
    if not unattributed:
        return None
    total = sum(u.end - u.start for u in unattributed)
    sample = [hhmmss(u.start) for u in unattributed[:UNATTRIBUTED_SAMPLE]]
    return UnattributedGroup(count=len(unattributed), total_seconds=total, sample_timestamps=sample)


def _plural_of_something_real(token: str, known: set[str]) -> bool:
    """A plural that is not a mis-hearing: an acronym carrying an `s`, or the
    plural of a term the vocabulary already lists.

    The acronym case needs no vocabulary at all — no spelling of `GPUs` is
    ever a mangled noun — which matters because the detector also runs when
    no `--names-file` was given.
    """
    if _ACRONYM_PLURAL.match(token):
        return True
    for suffix in ("'s", "s"):
        if token.endswith(suffix):
            return token[: -len(suffix)].lower() in known
    return False


def suspected_manglings(
    utterances: list[Utterance], known_terms: set[str] | None = None
) -> list[SuspectedMangling]:
    """Rare, irregularly-capitalised Latin-script tokens — see the module
    docstring for exactly what shape this catches and what it deliberately
    does not."""
    known = {t.lower() for t in (known_terms or set())}
    occurrences: dict[str, list[Utterance]] = {}
    for utterance in utterances:
        for token in _WORD.findall(utterance.text):
            if len(token) < MANGLING_MIN_LENGTH:
                continue
            if token.lower() in known:
                continue
            if _plural_of_something_real(token, known):
                continue
            if not _IRREGULAR_CAPITAL.search(token):
                continue
            occurrences.setdefault(token, []).append(utterance)

    found = [
        SuspectedMangling(
            token=token,
            count=len(seen),
            first_context=seen[0].text.strip(),
            at=seen[0].start,
        )
        for token, seen in occurrences.items()
        if len(seen) <= MANGLING_MAX_COUNT
    ]
    found.sort(key=lambda m: m.at)
    return found[:MAX_MANGLINGS]


def _content_word(word: str) -> bool:
    return len(word) >= 3 and word.lower() not in _STOPWORDS


def _contains_phrase(haystack: list[str], needle: list[str]) -> bool:
    n = len(needle)
    return any(haystack[i : i + n] == needle for i in range(len(haystack) - n + 1))


def _qualifies(variants: dict[str, int]) -> bool:
    return len(variants) >= 2 and sum(variants.values()) >= CASING_MIN_TOTAL


def _single_varying_token(variants: list[tuple[str, int]]) -> str | None:
    """The one word whose casing differs across all of a group's spellings,
    when there is exactly one — `None` when the phrases differ in more than
    one word, or in length, and so are genuinely separate questions."""
    splits = [text.split() for text, _ in variants]
    if len({len(words) for words in splits}) != 1:
        return None
    differing = [
        position
        for position in range(len(splits[0]))
        if len({words[position] for words in splits}) > 1
    ]
    if not differing:
        return None

    # Every position that varies has to be the *same* word in a different
    # case. More than one such position is allowed, so a repeated word counts
    # as one token: a real meeting produced 'Storage Storage' / 'Storage
    # storage' / 'storage storage', which a one-position rule treats as two
    # independent inconsistencies and so never folds with anything. Note this
    # decides only whether a group can fold *into another* — it does not
    # change how a lone group is displayed.
    tokens = set()
    for position in differing:
        spellings = {words[position] for words in splits}
        if len({spelling.lower() for spelling in spellings}) != 1:
            return None
        tokens.add(spellings.pop().lower())
    return tokens.pop() if len(tokens) == 1 else None


def casing_variants(utterances: list[Utterance]) -> list[CasingGroup]:
    """Phrases (1-3 words) said in more than one exact casing, grouped.

    The first word of every sentence is skipped entirely — see the module
    docstring for why that one exclusion is what keeps this quiet on
    ordinary English rather than flagging every sentence-initial capital.

    Overlapping n-grams of the same words are collected at every length
    (1-3), which is deliberate — a two-word term and a one-word term both
    need to be reachable — but it means "Object" and "Storage" separately
    can each qualify alongside "Object Storage" itself, three reports of one
    finding. A shorter qualifying phrase that is a contiguous sub-phrase of a
    longer qualifying one is dropped, keeping only the more informative,
    longer ask.
    """
    groups: dict[str, dict[str, int]] = {}
    for utterance in utterances:
        for sentence in _SENTENCE_SPLIT.split(utterance.text):
            words = _WORD.findall(sentence)
            for start in range(1, len(words)):  # 1: skip the sentence-initial word
                for n in range(1, CASING_MAX_NGRAM + 1):
                    if start + n > len(words):
                        break
                    gram = words[start : start + n]
                    if not any(_content_word(w) for w in gram):
                        continue
                    key = " ".join(w.lower() for w in gram)
                    exact = " ".join(gram)
                    counts = groups.setdefault(key, {})
                    counts[exact] = counts.get(exact, 0) + 1

    qualifying = {key: variants for key, variants in groups.items() if _qualifies(variants)}

    found: list[CasingGroup] = []
    for key, variants in qualifying.items():
        words = key.split()
        subsumed_by_longer = any(
            len(other.split()) > len(words) and _contains_phrase(other.split(), words)
            for other in qualifying
        )
        if subsumed_by_longer:
            continue
        ranked = sorted(variants.items(), key=lambda kv: (-kv[1], kv[0]))
        found.append(CasingGroup(variants=ranked))

    found.sort(key=lambda g: -sum(count for _, count in g.variants))

    # One token, one question. Overlapping n-grams mean a single inconsistent
    # word shows up once per phrase it appears in: on a real meeting the block
    # asked about "because I"/"because i", "I mean"/"i mean" and "I
    # already"/"i already" as three separate findings, all of which are the
    # word `I`. Groups are already sorted by total mentions, so the first one
    # reaching a given token is its most-evidenced phrasing and the rest fold
    # into it.
    collapsed: list[CasingGroup] = []
    representative: dict[str, CasingGroup] = {}
    for group in found:
        token = _single_varying_token(group.variants)
        if token is None:
            collapsed.append(group)
        elif token in representative:
            representative[token].folded += 1
        else:
            representative[token] = group
            collapsed.append(group)
    return collapsed[:MAX_CASING_GROUPS]


def build(
    utterances: list[Utterance],
    *,
    is_diarized: bool,
    unresolved: list[UnresolvedSpeaker] | None = None,
    identify_matches: list[SpeakerMatch] | None = None,
    known_terms: set[str] | None = None,
) -> VerificationBlock:
    """Assemble the whole block from what a run actually produced.

    `is_diarized` gates the three speaker-related categories — unresolved
    speakers, low-confidence identification, and unattributed turns all
    presuppose a diarized recording; on a dictated memo or a two-track call
    every utterance would otherwise carry `speaker=None`/no identification by
    construction, which is not the same fact as the diarizer failing to
    attribute something and must never be reported as if it were. The text
    checks (manglings, casing) run regardless of how the file was labelled,
    since they are about the words, not the speakers.
    """
    return VerificationBlock(
        unresolved_speakers=list(unresolved or []) if is_diarized else [],
        low_confidence=(
            low_confidence_identifications(identify_matches or [], utterances)
            if is_diarized
            else []
        ),
        unattributed=unattributed_group(utterances) if is_diarized else None,
        manglings=suspected_manglings(utterances, known_terms),
        casing=casing_variants(utterances),
    )


def _nested_unresolved(unresolved: list[UnresolvedSpeaker]) -> str:
    """`naming.render_unresolved`'s own output, demoted from its own `##`
    heading to a `###` subsection of this block. The evidence format —
    per-speaker turns, word share, first line, candidates, leading theory —
    is entirely `naming.py`'s; this changes nothing about it but the heading
    level, so the two never drift into two different renderings of the same
    finding."""
    full = render_unresolved(unresolved)
    if not full:
        return ""
    return full.replace("## Unresolved speakers", "### Unresolved speakers", 1)


def render(block: VerificationBlock, *, names_file: Path | None = None) -> str:
    """The whole block as it lands in the transcript, or `""` when there is
    nothing to ask — a caller can always append the result unconditionally."""
    if block.is_empty():
        return ""

    where = f"`{names_file.name}`" if names_file else "a `--names-file` you create"

    lines: list[str] = [
        "## Needs a quick look",
        "",
        "> [!note] One short reply covers everything below",
        "> The transcript above is already complete and usable — nothing here "
        "held it up. Answer what you know and skip the rest; there is no need "
        "to reopen the recording for any of it.",
        "",
    ]

    if block.unresolved_speakers:
        lines.append(_nested_unresolved(block.unresolved_speakers).rstrip("\n"))
        lines.append("")

    if block.low_confidence:
        lines += [
            "### Low-confidence speaker identifications",
            "",
            f"> Matched an enrolled voice, but below {LOW_CONFIDENCE_BELOW:.2f} "
            "similarity — worth a glance before the name is repeated as fact.",
            "",
        ]
        for match in block.low_confidence:
            lines.append(f"**{match.speaker}** — similarity {match.similarity:.2f}")
            lines.append(f"> {match.first_utterance}")
            lines.append("")

    if block.unattributed:
        group = block.unattributed
        lines += [
            "### Unattributed speech",
            "",
            f"{group.count} turn(s), {hhmmss(group.total_seconds)} total, that no "
            f"speaker could be matched to — for example at "
            f"{', '.join(group.sample_timestamps)}.",
            "",
        ]

    if block.manglings:
        lines += [
            "### Possibly mis-heard names or terms",
            "",
            f"> If any of these is a name or a term rather than a real word, "
            f"add the correct spelling to {where} — see `--names-file` in "
            "SETUP.md/README.md for the format.",
            "",
        ]
        # One turn, one quotation. Several suspect tokens routinely sit in
        # the same sentence, and quoting that sentence once per token made a
        # single long turn appear three times in one block — the reason a
        # quick-look section could run to 43 lines while asking about 8
        # things. Grouped by the turn they were found in, in time order.
        by_turn: dict[tuple[float, str], list[SuspectedMangling]] = {}
        for mangling in block.manglings:
            by_turn.setdefault((mangling.at, mangling.first_context), []).append(mangling)
        for (at, context), found in sorted(by_turn.items(), key=lambda kv: kv[0][0]):
            tokens = ", ".join(f"**{m.token}** ({m.count}×)" for m in found)
            lines.append(f"{tokens} at {hhmmss(at)}")
            lines.append(f"> {context}")
            lines.append("")

    if block.casing:
        lines += [
            "### Inconsistent capitalisation",
            "",
            f"> Say which form is canonical for each, and it can go in {where} "
            "so the next recording is consistent from the start.",
            "",
        ]
        for group in block.casing:
            variants = ", ".join(f"'{text}' ({count}×)" for text, count in group.variants)
            if group.folded:
                variants += (
                    f" — and {group.folded} other phrase(s) differing only in this word"
                )
            lines.append(f"- {variants}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def summarize(block: VerificationBlock) -> str:
    """The same block, compact, for stderr — visible without opening the
    file at all, the same reasoning `naming.summarize_unresolved` already
    follows for its own narrower case."""
    if block.is_empty():
        return ""

    lines = ["needs a quick look — one short reply covers all of this:"]

    if block.unresolved_speakers:
        # summarize_unresolved's own first line is a header identical in
        # spirit to the one this function already printed above; drop it and
        # keep only its per-speaker lines, which already begin with "  ".
        lines += summarize_unresolved(block.unresolved_speakers).splitlines()[1:]

    for match in block.low_confidence:
        lines.append(f"  low-confidence match: {match.speaker} at similarity {match.similarity:.2f}")

    if block.unattributed:
        group = block.unattributed
        lines.append(
            f"  unattributed speech: {group.count} turn(s), "
            f"{hhmmss(group.total_seconds)} total"
        )

    for mangling in block.manglings:
        lines.append(f"  possibly mis-heard: {mangling.token!r} ({mangling.count}x) at {hhmmss(mangling.at)}")

    for group in block.casing:
        variants = " / ".join(f"{text} ({count})" for text, count in group.variants)
        lines.append(f"  casing variants: {variants}")

    return "\n".join(lines)


__all__ = [
    "CASING_MAX_NGRAM",
    "CASING_MIN_TOTAL",
    "LOW_CONFIDENCE_BELOW",
    "MANGLING_MAX_COUNT",
    "MANGLING_MIN_LENGTH",
    "MAX_CASING_GROUPS",
    "MAX_MANGLINGS",
    "UNATTRIBUTED_SAMPLE",
    "CasingGroup",
    "LowConfidenceMatch",
    "SuspectedMangling",
    "UnattributedGroup",
    "VerificationBlock",
    "build",
    "casing_variants",
    "low_confidence_identifications",
    "render",
    "summarize",
    "suspected_manglings",
    "unattributed_group",
]
