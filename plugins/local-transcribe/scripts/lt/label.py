"""Attaching speaker labels to recognised text.

Two sources of labels, and they are not equally good:

**Two audio streams** (shape B — what OBS records with one track per source)
are labelled by construction — stream 1 is your microphone and stream 2 is
everyone else — *once the streams are confirmed to actually be separate
sources*. A stream count is not a source count: one microphone recorded onto
a two-track profile writes two streams that carry the identical mix, and a
real recording did exactly that (2026-09-15), so `from_streams` below is only
ever called after `lt/mixcheck.py` has sampled and compared the streams and
found them to differ. This is the better path whenever it is genuinely
available, which is why the recorder skill pushes people towards OBS.

**One mixed stream** (shapes A2 and D — a table microphone, or a screen
recording of a Meet call) needs the diarizer, and the labels are `Speaker 1`,
`Speaker 2`… in order of first appearance. Which human that is, the recording
does not say; `--names` maps them once the reader knows.

Recognition and diarization run independently and disagree about boundaries,
because one is cutting on words and the other on voices. The join is therefore
by **overlap**: each recognised segment takes the speaker whose turns cover
most of it. A segment straddling a real speaker change is attributed whole to
the dominant side rather than split, because the word timings are not accurate
enough to cut mid-segment without inventing a boundary.
"""

from __future__ import annotations

from dataclasses import dataclass

from .asr import Segment
from .diarize import Turn


@dataclass
class Utterance:
    start: float
    end: float
    speaker: str | None
    text: str


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def from_diarization(segments: list[Segment], turns: list[Turn]) -> list[Utterance]:
    """Label each recognised segment with the speaker that dominates it."""
    order: dict[int, int] = {}
    for turn in turns:
        order.setdefault(turn.speaker, len(order) + 1)

    utterances: list[Utterance] = []
    for segment in segments:
        totals: dict[int, float] = {}
        for turn in turns:
            if overlap := _overlap(segment.start, segment.end, turn.start, turn.end):
                totals[turn.speaker] = totals.get(turn.speaker, 0.0) + overlap

        if totals:
            best = max(totals, key=lambda key: totals[key])
            speaker = f"Speaker {order[best]}"
        else:
            # Speech the segmenter found no voice for — too quiet, overlapped,
            # or music. Carrying the previous label forward would be a guess
            # indistinguishable from a real attribution, so it is not made:
            # the speaker is left unknown and the words are still reported.
            speaker = None

        utterances.append(Utterance(segment.start, segment.end, speaker, segment.text))

    return merge_adjacent(utterances)


def from_streams(streams: list[tuple[str, list[Segment]]]) -> list[Utterance]:
    """Interleave per-stream recognitions into one chronological transcript.

    `streams` is [(label, segments)] — one entry per audio stream, already
    recognised separately. No model is involved here: the label is a property
    of which stream the audio came from. The caller is what carries the
    burden of proof — this function trusts that the streams are genuinely
    separate sources because `lt/mixcheck.py` has already checked, not
    because a stream count implies it.
    """
    utterances = [
        Utterance(segment.start, segment.end, label, segment.text)
        for label, segments in streams
        for segment in segments
    ]
    utterances.sort(key=lambda item: (item.start, item.end))
    return merge_adjacent(utterances)


def merge_adjacent(utterances: list[Utterance]) -> list[Utterance]:
    """Collapse consecutive utterances by the same speaker into one block.

    A speaker saying four sentences is one turn in the transcript, not four
    timestamped lines, which is the difference between a transcript that reads
    and one that only parses.
    """
    merged: list[Utterance] = []
    for utterance in utterances:
        if merged and merged[-1].speaker == utterance.speaker:
            previous = merged[-1]
            previous.end = max(previous.end, utterance.end)
            previous.text = f"{previous.text} {utterance.text}".strip()
        else:
            merged.append(
                Utterance(utterance.start, utterance.end, utterance.speaker, utterance.text)
            )
    return merged


def rename(utterances: list[Utterance], names: list[str]) -> list[Utterance]:
    """Replace `Speaker N` with a real name, positionally.

    Names map onto speakers in order of first appearance, which is the only
    order the recording establishes. A short list leaves the rest numbered
    rather than failing, because a partially named transcript is useful.
    """
    seen: list[str] = []
    for utterance in utterances:
        if utterance.speaker and utterance.speaker not in seen:
            seen.append(utterance.speaker)

    mapping = {
        speaker: names[index].strip()
        for index, speaker in enumerate(seen)
        if index < len(names) and names[index].strip()
    }
    for utterance in utterances:
        if utterance.speaker in mapping:
            utterance.speaker = mapping[utterance.speaker]
    return utterances


def speakers_present(utterances: list[Utterance]) -> list[str]:
    found: list[str] = []
    for utterance in utterances:
        if utterance.speaker and utterance.speaker not in found:
            found.append(utterance.speaker)
    return found


__all__ = [
    "Utterance",
    "from_diarization",
    "from_streams",
    "merge_adjacent",
    "rename",
    "speakers_present",
]
