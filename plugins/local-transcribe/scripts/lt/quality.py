"""Detecting a recognition pass that degenerated, before its labels are trusted.

Speech recognition can fail in a way that produces plenty of confident-looking
output: told the wrong language, or given very noisy audio, Whisper falls into
a repetition loop — the same phrase hundreds of times — and its segment
timestamps stall or run backwards while it does. Every stage downstream then
behaves reasonably on nonsense, and the result is a transcript that **reads as
structured and is not**: a speaker header asserting two people, and one giant
block holding every word.

That is the exact failure this plugin refuses elsewhere, so it is checked here
rather than hoped away. The checks are deliberately cheap and structural — they
look at timestamps and word repetition, never at meaning — because they have to
run on every file without a second model.

Nothing here throws. A degenerate pass still produces text worth keeping, so
the transcript is written; what changes is that it says so, loudly, in the
header and on stderr, instead of presenting speaker labels it cannot support.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from .asr import Segment
from .label import Utterance

# The most common three-word phrase in ordinary speech is a few percent of the
# words. A tenth of the transcript being one repeated phrase is not speech.
REPETITION_LIMIT = 0.10

# Whisper emits segments in order. A handful of inversions is rounding; more
# than one in a hundred means the timestamps cannot place a speaker turn.
NON_MONOTONIC_LIMIT = 0.01

# One voice holding almost every word, when the diarizer reported several,
# means the join found nothing to attribute — not that someone monologued.
COLLAPSE_LIMIT = 0.95

# Scripts that indicate the recognised language is not the one that was forced.
SCRIPTS = {
    "Cyrillic": (0x0400, 0x04FF),
    "Greek": (0x0370, 0x03FF),
    "Arabic": (0x0600, 0x06FF),
    "Hebrew": (0x0590, 0x05FF),
    "CJK": (0x4E00, 0x9FFF),
}
LATIN_LANGUAGES = {
    "en", "fi", "sv", "no", "da", "de", "nl", "fr", "es", "it", "pt", "pl",
    "cs", "sk", "sl", "hr", "hu", "ro", "tr", "et", "lv", "lt", "is", "ca",
}


@dataclass
class Quality:
    """What the run found wrong with itself."""

    warnings: list[str] = field(default_factory=list)
    labels_trustworthy: bool = True

    @property
    def ok(self) -> bool:
        return not self.warnings


def repetition_share(segments: list[Segment], n: int = 3) -> float:
    """Share of the words taken up by the single most repeated n-gram."""
    words = [word for segment in segments for word in segment.text.split()]
    if len(words) < n * 20:
        return 0.0
    grams = Counter(
        " ".join(words[i : i + n]) for i in range(len(words) - n + 1)
    )
    _, count = grams.most_common(1)[0]
    return (count * n) / len(words)


def non_monotonic_share(segments: list[Segment]) -> float:
    """Share of segments that start before the segment preceding them."""
    if len(segments) < 2:
        return 0.0
    backwards = sum(
        1
        for index in range(1, len(segments))
        if segments[index].start < segments[index - 1].start
    )
    return backwards / len(segments)


def dominant_share(utterances: list[Utterance]) -> tuple[str | None, float]:
    """The speaker holding the largest share of the words, and that share."""
    words: Counter[str] = Counter()
    for utterance in utterances:
        if utterance.speaker:
            words[utterance.speaker] += len(utterance.text.split())
    total = sum(words.values())
    if not total:
        return None, 0.0
    speaker, count = words.most_common(1)[0]
    return speaker, count / total


def foreign_script_share(segments: list[Segment]) -> tuple[str | None, float]:
    """The non-Latin script most present in the text, and its share of letters."""
    counts: Counter[str] = Counter()
    letters = 0
    for segment in segments:
        for char in segment.text:
            if not char.isalpha():
                continue
            letters += 1
            code = ord(char)
            for name, (low, high) in SCRIPTS.items():
                if low <= code <= high:
                    counts[name] += 1
                    break
    if not letters or not counts:
        return None, 0.0
    name, count = counts.most_common(1)[0]
    return name, count / letters


def assess(
    segments: list[Segment],
    utterances: list[Utterance] | None,
    *,
    speakers_found: int = 0,
    requested_language: str | None = None,
    labels_inferred: bool = True,
) -> Quality:
    """Judge whether this run's output can be presented as it stands.

    `labels_inferred` is False when the labels came from which audio stream the
    words arrived on. That case is exempt from the dominance check: a two-track
    recording where the far end talks for 99% of a webinar is ordinary, and the
    labels are still a fact about the container rather than a guess that failed.
    """
    quality = Quality()

    repetition = repetition_share(segments)
    if repetition > REPETITION_LIMIT:
        quality.labels_trustworthy = False
        quality.warnings.append(
            f"recognition looped: one phrase accounts for {repetition:.0%} of the "
            "words, which is a Whisper failure and not speech. The usual cause is "
            "the wrong --language for this audio; the next is audio too noisy to "
            "recognise. Timestamps stall during a loop, so speaker labels from "
            "this run mean nothing."
        )

    backwards = non_monotonic_share(segments)
    if backwards > NON_MONOTONIC_LIMIT:
        quality.labels_trustworthy = False
        quality.warnings.append(
            f"{backwards:.0%} of segments start before the one before them, so the "
            "timestamps cannot place a speaker turn. Speaker labels from this run "
            "are not reliable."
        )

    script, share = foreign_script_share(segments)
    if (
        script
        and share > 0.20
        and requested_language
        and requested_language.lower() in LATIN_LANGUAGES
    ):
        quality.warnings.append(
            f"--language {requested_language} was given but {share:.0%} of the "
            f"recognised letters are {script}. The forced language is probably "
            "wrong — drop --language to let it detect, or name the real one."
        )

    if utterances and speakers_found >= 2 and labels_inferred:
        speaker, dominance = dominant_share(utterances)
        if dominance >= COLLAPSE_LIMIT:
            quality.labels_trustworthy = False
            quality.warnings.append(
                f"{speakers_found} speakers were separated, but {speaker} holds "
                f"{dominance:.0%} of the words — the labels did not attach to the "
                "text. Treat this transcript as unlabelled."
            )

    return quality


__all__ = [
    "COLLAPSE_LIMIT",
    "NON_MONOTONIC_LIMIT",
    "REPETITION_LIMIT",
    "Quality",
    "assess",
    "dominant_share",
    "foreign_script_share",
    "non_monotonic_share",
    "repetition_share",
]
