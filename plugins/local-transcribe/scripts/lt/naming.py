"""Naming a diarized speaker from context, once separation has already run.

**Separation and naming are two different stages with two different
standards.** `lt/diarize.py` decides "these turns are one person" and has to
be automatic and confident — clustering embeddings is what this plugin is
good at. This module decides "that person is Ada Lovelace", which rests on
much weaker evidence: an attendee list, a sentence someone said about
themselves, a name someone else used to address them. A numbered transcript
(`Speaker 1`, `Speaker 2`…) is already a complete, usable artefact, so nothing
here ever degrades one, delays it, or marks it as failed — it only ever adds a
name on top when the evidence supports it, and asks a short, evidenced
question when it does not.

⛔ **No biometrics here.** `lt/voices.py` is the one place a voice is ever
fingerprinted, and enrolling someone else's voice print is a deliberately
rare, explicit act (see `references/consent.md`). Everything in this module
works from the *words*, never the *voice* — an attendee list and the text
already recognised. Naming someone from context they gave in the meeting
itself needs none of the consent weight a voice print does.

## Sources, strongest first

1. **An enrolled print** (`lt/voices.py`) — already applied before this module
   runs. A speaker it named arrives here as an ordinary name, not `Speaker N`,
   and is never touched again.
2. **Elimination.** A speaker who is not yet named, on a recording where every
   other speaker now *is* named, and where the attendee list has exactly one
   name still unaccounted for, must be that person — there is nobody else it
   can be. This one case covers most two-person meetings on its own, since the
   user's own cluster is usually named by their enrolled print already.
3. **The attendee list, generally.** The same reasoning generalises: whenever
   exactly one unnamed speaker remains and exactly one attendee remains
   unaccounted for, elimination fires — however many speakers or attendees
   the recording started with. Resolving one speaker can make a second
   elimination possible, so the two stages below run in a loop until neither
   makes progress.
4. **The words themselves** — a speaker introducing themselves, or being
   addressed by name in an adjacent turn. This is the weakest source and the
   only one that reads free text, so it is deliberately narrow: it is only
   ever asked "does this match one of the names I was given?", never "whose
   name is this?" — a self-introduction to a name nobody on the attendee list
   holds is not reported as a name, however clearly it was said. That
   constraint is not theoretical: a real recording in this plugin's own test
   set has a speaker say "hi, I'm Marjorie" while the attendee list (and the
   correct answer) name someone else entirely — seemingly a first-name
   mismatch between the interviewee's given name and the one on the calendar
   invite. Matched against the free text alone this would have quoted the
   wrong name in the transcript header; checked against the candidate list it
   correctly finds nothing to assert, and elimination names the speaker
   instead. See `evals/naming_test.py::TestSelfIntroductionIgnoresNonCandidates`.

## The hard constraint

A name reached this way is an inference about a person, so **it must be
right or absent.** Every `Assignment` records its `basis` in plain words —
"from the attendee list by elimination", "self-introduction at 00:01:12",
"addressed by name at 00:04:40" — and that string is what the transcript
header shows, so a reader can audit exactly what the name rests on rather
than trusting a bare label. Evidence that resolves to more than one
candidate name is never guessed between: the speaker stays `Speaker N` and
goes into the unresolved report with whatever theory was closest, and why it
was not asserted.

**A mapping never survives past one file.** `resolve_names` takes the
utterances of a single recording and nothing else; there is no cache, no
store, no cross-file memory — `Speaker 2` in one recording has no relationship
to `Speaker 2` in another, and this module has no way to make it have one.

## Russian, and why exact string matching is not enough

A Cyrillic name spoken aloud is usually inflected — case endings, and
sometimes a patronymic ending too — so it will not literally match the
nominative form an attendee list gives ("Анатолий"), which is what would show
up if this only ever did the same whole-word match English gets. Measured
against a real Russian recording in this plugin's own test set: the correct
speaker's name is never once said in the nominative form the attendee list
carries, only inflected ("Анатолия", "Анатолию") or not at all — an
English-shaped matcher would silently score 0 for every mention on every
Russian file, look like it works because it never crashes, and never once
actually match.

The fix is not a stemmer — a full morphological analyser is a dependency this
plugin does not need for what is a narrow, bounded problem. Instead, a
Cyrillic name is reduced to a short **core** (its own text with a fixed
number of trailing characters removed — case endings are one to three
characters), and a candidate word matches when it *starts with* that core.
"Анатолий" cores to "анато", which is a prefix of "анатолий", "анатолия",
"анатолию" and "анатолием" alike — every case this plugin's test data actually
produced. It does **not** catch a diminutive ("Толя" for "Анатолий") because
that is a different root, not an ending, and guessing across roots is
exactly the kind of leap this module refuses to make. Latin names are matched
by exact whole word instead, case-insensitively — English names do not
decline, and prefix-matching one would only invite false positives ("Mark"
inside "Marksburg").

`evals/naming_test.py::TestRussianInflection` and the module's own smoke
measurement (see `evals/naming_smoke.py`) both check this in each direction:
exact matching finds none of a set of real inflected forms, the core match
finds all of them, and neither ever matches an unrelated word that happens to
share a prefix.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .label import Utterance
from .transcript import hhmmss

_NUMBERED = re.compile(r"^Speaker \d+$")

# How many trailing characters a Cyrillic name loses to build its matching
# core, and the shortest a core may be before it is refused as too generic to
# mean anything. Measured against this plugin's own Russian test recording:
# "Анатолий" (7 letters) needs both endings ("-ия", "-ию", "-ием") stripped by
# at most 3 characters to still share a 4-letter core ("анато") with every
# inflected form seen. A shorter name loses proportionally more of itself to
# case endings, which is exactly why MIN_CORE exists — a 3-letter core would
# start matching words that are not the name at all.
RUSSIAN_ENDING_CHARS = 2
MIN_CORE = 4

# Cue phrases that precede a self-introduction. Deliberately loose — "I'm" on
# its own is completed by ordinary words nineteen times out of twenty ("I'm
# not sure", "I'm still on it") — because the safety net is not the cue, it is
# that the captured word must then match a name on the candidate list. An
# unmatched capture (a real recording in this plugin's test set says "hi, I'm
# Marjorie" where the candidate list names someone else) is simply discarded,
# so a looser cue costs nothing and catches more phrasing.
_SELF_INTRO = [
    re.compile(r"\bmy name is\s+(\w+)", re.IGNORECASE),
    re.compile(r"\bi'?m\s+(\w+)", re.IGNORECASE),
    re.compile(r"\bthis is\s+(\w+)", re.IGNORECASE),
    re.compile(r"меня зовут\s+(\w+)", re.IGNORECASE),
    re.compile(r"\bэто\s+(\w+)\s+говор", re.IGNORECASE),
]

# A speaker "greeting" the transcript with one bare word — the kind of turn
# that is real speech but tells a reader nothing about who is talking.
_GREETINGS = {
    "hi", "hello", "hey", "yeah", "yeah.", "yes", "yep", "ok", "okay",
    "thanks", "sure", "right",
    "привет", "да", "угу", "ага", "спасибо", "ок", "окей",
}


def _has_cyrillic(text: str) -> bool:
    return any("Ѐ" <= ch <= "ӿ" for ch in text)


def _core(token: str) -> str:
    """`token`'s matching core — see the module docstring's Russian section."""
    token = token.lower()
    if not _has_cyrillic(token) or len(token) - RUSSIAN_ENDING_CHARS < MIN_CORE:
        return token
    return token[: len(token) - RUSSIAN_ENDING_CHARS]


def _token_matches(word: str, name_token: str) -> bool:
    """Does a word found in speech refer to this one token of a candidate name?

    Latin tokens match only exactly, case-insensitively — English names do
    not inflect, and prefix-matching one invites false positives a Cyrillic
    core does not risk in the same way ("Mark" is a prefix of "Marksburg").
    """
    word, name_token = word.lower(), name_token.lower()
    if not _has_cyrillic(name_token):
        return word == name_token
    core = _core(name_token)
    return len(core) >= MIN_CORE and word.startswith(core)


def _name_tokens(name: str) -> list[str]:
    return [t for t in re.findall(r"\w+", name, re.UNICODE) if len(t) >= 2]


def _vocative_pattern(token: str) -> re.Pattern[str]:
    """A name immediately followed by a comma — the shape a vocative address
    takes in ordinary punctuation ("Anatoly, can you...", "Толя, ты...").

    This is deliberately narrower than "the name appears anywhere nearby":
    a real Russian recording in this plugin's test set mentions a candidate's
    diminutive four times, always in the third person ("the project Dima
    leads"), never once as a vocative — and none of the four is followed by a
    comma. Matching on mere co-occurrence would have offered this as evidence
    it is not; requiring the comma correctly finds nothing there instead.
    """
    if _has_cyrillic(token):
        return re.compile(rf"(?<!\w){re.escape(_core(token))}\w*\s*,", re.IGNORECASE)
    # Latin names do not inflect, so no trailing `\w*` is allowed here — with
    # one it would also match "Marksburg," off a candidate named "Mark".
    return re.compile(rf"(?<!\w){re.escape(token.lower())}\s*,", re.IGNORECASE)


def _self_introductions(text: str, candidates: list[str]) -> list[str]:
    """Candidate names this utterance introduces itself as — never any other word.

    Every match is filtered through the candidate list before it is returned,
    which is what makes the loose cue list above safe: a cue completed by a
    word that is not a candidate's name produces nothing, silently.
    """
    found: list[str] = []
    for pattern in _SELF_INTRO:
        for match in pattern.finditer(text):
            word = match.group(1)
            for candidate in candidates:
                if any(_token_matches(word, tok) for tok in _name_tokens(candidate)):
                    if candidate not in found:
                        found.append(candidate)
    return found


def _addressed_as(text: str, candidates: list[str]) -> list[str]:
    """Candidate names this utterance addresses someone else as, vocatively."""
    found: list[str] = []
    for candidate in candidates:
        for token in _name_tokens(candidate):
            if _vocative_pattern(token).search(text):
                if candidate not in found:
                    found.append(candidate)
                break
    return found


def parse_attendees(raw: str) -> list[str]:
    """Split `--attendees` into names, deduplicated, order preserved."""
    seen: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if name and name not in seen:
            seen.append(name)
    return seen


def _is_numbered(speaker: str | None) -> bool:
    return bool(speaker) and bool(_NUMBERED.match(speaker))


def _numbered_in_order(utterances: list[Utterance]) -> list[str]:
    order: list[str] = []
    for utterance in utterances:
        if _is_numbered(utterance.speaker) and utterance.speaker not in order:
            order.append(utterance.speaker)  # type: ignore[arg-type]
    return order


def _names_overlap(a: str, b: str) -> bool:
    """Do two names plausibly refer to the same person?

    A loose test on purpose: an enrolled print or an identified speaker is
    usually a bare first name ("Grace Hopper"), and an attendee list entry is
    usually the full name from a calendar invite ("Grace Hopper") — this
    only has to recognise that those are the same person, not tell two
    different people apart, which shared-token overlap does well enough for a
    handful of meeting attendees.
    """
    tokens_a = {t.lower() for t in re.findall(r"\w+", a, re.UNICODE) if len(t) >= 3}
    tokens_b = {t.lower() for t in re.findall(r"\w+", b, re.UNICODE) if len(t) >= 3}
    return bool(tokens_a & tokens_b)


def _first_substantive(items: list[Utterance]) -> str:
    """The clearest example of this speaker's own words to show in a report.

    Skips one-word turns and bare greetings, in either language, because
    "yeah" tells a reader nothing about who is speaking — falls back to this
    speaker's longest turn if literally everything they said was that short,
    so this always returns something rather than an empty string.
    """
    for utterance in items:
        words = utterance.text.split()
        if len(words) <= 1:
            continue
        if utterance.text.strip().strip(".,!?…").lower() in _GREETINGS:
            continue
        return utterance.text.strip()
    return max(items, key=lambda u: len(u.text.split())).text.strip()


def first_substantive_line(utterances: list[Utterance]) -> str:
    """Public entry point to `_first_substantive`, for `lt.verify` — the same
    "clearest line to show as evidence for this speaker" choice, so a second
    module needing it does not grow its own copy of the greeting/one-word
    skip logic above."""
    return _first_substantive(utterances)


@dataclass
class SpeakerStats:
    turns: int
    words: int
    word_share: float
    first_substantive: str


def _speaker_stats(utterances: list[Utterance], numbered: list[str]) -> dict[str, SpeakerStats]:
    total_words = sum(len(u.text.split()) for u in utterances) or 1
    by_speaker: dict[str, list[Utterance]] = {}
    for utterance in utterances:
        if utterance.speaker in numbered:
            by_speaker.setdefault(utterance.speaker, []).append(utterance)  # type: ignore[arg-type]

    stats: dict[str, SpeakerStats] = {}
    for speaker in numbered:
        items = by_speaker.get(speaker, [])
        words = sum(len(u.text.split()) for u in items)
        stats[speaker] = SpeakerStats(
            turns=len(items),
            words=words,
            word_share=words / total_words,
            first_substantive=_first_substantive(items) if items else "",
        )
    return stats


@dataclass
class WordMatch:
    candidate: str
    basis: str
    score: int  # 2 = self-introduction, 1 = addressed by name — see _word_matches
    at: float


def _word_matches(
    utterances: list[Utterance], speaker: str, candidates: list[str]
) -> list[WordMatch]:
    """Every self-introduction or vocative address found for `speaker`.

    A self-introduction outscores being addressed because it is first-person
    evidence about the speaker's own identity; an address is secondhand — a
    neighbour could be talking about a third party the speaker merely
    resembles in the room. Both are read only from `speaker`'s own turns
    (self-introduction) or the turn immediately before/after one of them,
    spoken by someone else (addressed) — a mention three turns away is not
    "adjacent" and is not evidence.
    """
    matches: list[WordMatch] = []
    for index, utterance in enumerate(utterances):
        if utterance.speaker != speaker:
            continue
        for candidate in _self_introductions(utterance.text, candidates):
            matches.append(
                WordMatch(candidate, f"self-introduction at {hhmmss(utterance.start)}", 2, utterance.start)
            )
        for neighbour_index in (index - 1, index + 1):
            if not 0 <= neighbour_index < len(utterances):
                continue
            neighbour = utterances[neighbour_index]
            if not neighbour.speaker or neighbour.speaker == speaker:
                continue
            for candidate in _addressed_as(neighbour.text, candidates):
                matches.append(
                    WordMatch(candidate, f"addressed by name at {hhmmss(neighbour.start)}", 1, neighbour.start)
                )
    matches.sort(key=lambda m: m.at)
    return matches


def _resolve_word_claims(
    confident: dict[str, tuple[str, str, int]]
) -> dict[str, tuple[str, str]]:
    """Strongest evidence first — the same rule `lt.voices._resolve_claims`
    uses for enrolled prints, applied here to word evidence: a name claimed by
    a stronger match is not claimed a second time, and the loser is left for
    the caller to try again or report unresolved."""
    accepted: dict[str, tuple[str, str]] = {}
    claimed: set[str] = set()
    for speaker, (candidate, basis, score) in sorted(
        confident.items(), key=lambda item: -item[1][2]
    ):
        if candidate in claimed:
            continue
        claimed.add(candidate)
        accepted[speaker] = (candidate, basis)
    return accepted


def _word_stage(
    utterances: list[Utterance], unresolved: list[str], remaining: list[str]
) -> tuple[dict[str, tuple[str, str]], dict[str, str]]:
    """One pass of word evidence over every still-unresolved speaker.

    Returns the claims worth accepting and, for whoever is left, a leading
    theory to carry into the unresolved report — set when a speaker's words
    matched more than one remaining candidate and so could not be asserted.
    """
    proposals: dict[str, list[WordMatch]] = {}
    for speaker in unresolved:
        found = _word_matches(utterances, speaker, remaining)
        if found:
            proposals[speaker] = found

    confident: dict[str, tuple[str, str, int]] = {}
    ambiguous: dict[str, str] = {}
    for speaker, found in proposals.items():
        distinct: dict[str, list[WordMatch]] = {}
        for match in found:
            distinct.setdefault(match.candidate, []).append(match)
        if len(distinct) == 1:
            candidate, matches = next(iter(distinct.items()))
            best = max(matches, key=lambda m: m.score)
            confident[speaker] = (candidate, best.basis, best.score)
        else:
            names = " and ".join(sorted(distinct))
            ambiguous[speaker] = f"mentioned as both {names} — not asserted"

    return _resolve_word_claims(confident), ambiguous


@dataclass
class Assignment:
    speaker: str
    name: str
    basis: str


@dataclass
class UnresolvedSpeaker:
    speaker: str
    first_utterance: str
    turns: int
    word_share: float
    candidates: list[str]
    leading_theory: str | None = None


@dataclass
class NamingResult:
    assignments: list[Assignment] = field(default_factory=list)
    unresolved: list[UnresolvedSpeaker] = field(default_factory=list)


def _apply(utterances: list[Utterance], assignments: list[Assignment]) -> None:
    mapping = {a.speaker: a.name for a in assignments}
    for utterance in utterances:
        if utterance.speaker in mapping:
            utterance.speaker = mapping[utterance.speaker]


def resolve_names(utterances: list[Utterance], attendees: list[str]) -> NamingResult:
    """Name as many `Speaker N` labels as the evidence actually supports.

    Runs elimination and word evidence in a loop because resolving one
    speaker can make the next elimination possible — a three-person call
    where one person is enrolled and a second introduces themselves leaves
    exactly one name for exactly one remaining speaker, which is elimination
    again, not a new mechanism. The loop stops the moment a full pass makes
    no progress, and whoever is left goes into `NamingResult.unresolved`
    rather than being guessed at.

    Renames `utterances` in place, the same convention `lt.voices.identify`
    uses, so a caller can pass the same list through both without special
    cases for which one ran.
    """
    if not attendees:
        return NamingResult()

    numbered = _numbered_in_order(utterances)
    if not numbered:
        return NamingResult()

    already_named = sorted({
        utterance.speaker for utterance in utterances
        if utterance.speaker and not _is_numbered(utterance.speaker)
    })
    remaining = [
        attendee for attendee in attendees
        if not any(_names_overlap(attendee, name) for name in already_named)
    ]

    stats = _speaker_stats(utterances, numbered)
    unresolved = list(numbered)
    assignments: list[Assignment] = []
    theories: dict[str, str] = {}

    progress = True
    while progress:
        progress = False

        if len(unresolved) == 1 and len(remaining) == 1:
            speaker, candidate = unresolved[0], remaining[0]
            assignments.append(Assignment(speaker, candidate, "from the attendee list by elimination"))
            unresolved.remove(speaker)
            remaining.remove(candidate)
            theories.pop(speaker, None)
            progress = True
            continue

        if unresolved and remaining:
            accepted, ambiguous = _word_stage(utterances, unresolved, remaining)
            theories.update(ambiguous)
            for speaker, (candidate, basis) in accepted.items():
                assignments.append(Assignment(speaker, candidate, basis))
                unresolved.remove(speaker)
                remaining.remove(candidate)
                theories.pop(speaker, None)
                progress = True

    _apply(utterances, assignments)

    unresolved_report = [
        UnresolvedSpeaker(
            speaker=speaker,
            first_utterance=stats[speaker].first_substantive,
            turns=stats[speaker].turns,
            word_share=stats[speaker].word_share,
            candidates=list(remaining),
            leading_theory=theories.get(speaker),
        )
        for speaker in unresolved
    ]
    return NamingResult(assignments=assignments, unresolved=unresolved_report)


def render_unresolved(unresolved: list[UnresolvedSpeaker]) -> str:
    """The `## Unresolved speakers` section of the transcript — empty string
    when there is nothing to ask, so a caller can always append the result."""
    if not unresolved:
        return ""
    lines = [
        "## Unresolved speakers",
        "",
        "> [!note] One short reply names everyone below",
        "> Say which candidate each numbered speaker is, or say none of them "
        "fit — the evidence for each is quoted here so you don't have to "
        "reopen the recording to answer.",
        "",
    ]
    for speaker in unresolved:
        lines.append(f"**{speaker.speaker}** — {speaker.turns} turn(s), {speaker.word_share:.0%} of the words")
        lines.append(f"> {speaker.first_utterance}")
        lines.append("")
        candidates = ", ".join(speaker.candidates) if speaker.candidates else "none — every attendee given is already accounted for"
        lines.append(f"- Candidates still unaccounted for: {candidates}")
        if speaker.leading_theory:
            lines.append(f"- Leading theory: {speaker.leading_theory}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def summarize_unresolved(unresolved: list[UnresolvedSpeaker]) -> str:
    """A compact stderr form of the same report, printed so the ask is visible
    without opening the file at all."""
    lines = ["unresolved speakers — one short reply names them all:"]
    for speaker in unresolved:
        candidates = ", ".join(speaker.candidates) if speaker.candidates else "none left"
        theory = f" ({speaker.leading_theory})" if speaker.leading_theory else ""
        lines.append(
            f"  {speaker.speaker}: {speaker.turns} turn(s), "
            f"{speaker.word_share:.0%} of the words — candidates: {candidates}{theory}"
        )
    return "\n".join(lines)


# What a two-person recording's other speaker is called when no evidence
# reaches a name. Deliberately not "Speaker 2": with exactly two people a
# number tells the reader nothing they did not already know from the meeting
# itself, while `Unknown` says the true thing — that the tool could not
# determine who this was. Numbering earns its place once there are enough
# participants that telling them apart is the point.
UNKNOWN_SPEAKER = "Unknown"


def name_or_unknown(utterances: list[Utterance]) -> str | None:
    """In a two-speaker recording, replace a lone `Speaker N` with `Unknown`.

    Returns the label that was replaced, or None if nothing changed, so the
    caller can record in the header which speaker this happened to.

    Two conditions, and the second is the one worth stating. It fires only
    when the recording has exactly two speakers, because with three or more
    the numbers are the finished form. And it fires only when exactly one of
    them is unnamed: if **neither** has a name, the numbers are the only
    thing keeping the two people apart, and replacing both with `Unknown`
    would merge two speakers into one label and lose the separation the
    diarizer just established. That case keeps its numbers.
    """
    speakers = []
    for utterance in utterances:
        if utterance.speaker and utterance.speaker not in speakers:
            speakers.append(utterance.speaker)
    if len(speakers) != 2:
        return None

    numbered = [speaker for speaker in speakers if _is_numbered(speaker)]
    if len(numbered) != 1:
        return None

    target = numbered[0]
    for utterance in utterances:
        if utterance.speaker == target:
            utterance.speaker = UNKNOWN_SPEAKER
    return target


__all__ = [
    "MIN_CORE",
    "RUSSIAN_ENDING_CHARS",
    "UNKNOWN_SPEAKER",
    "Assignment",
    "NamingResult",
    "SpeakerStats",
    "UnresolvedSpeaker",
    "WordMatch",
    "first_substantive_line",
    "name_or_unknown",
    "parse_attendees",
    "render_unresolved",
    "resolve_names",
    "summarize_unresolved",
]
