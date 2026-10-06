"""Re-run the verification pass over a transcript that already exists.

Recognition is the expensive half of a run — minutes on a GPU, hours on a CPU
fallback — and the quick-look block is the cheap half, built from the
recognised text alone. So a change to what the block asks about should not
cost a re-transcription, and before this module it did: the only way to see a
detector change against real speech was to run the whole pipeline again.

That made the detectors the least-tested part of the tool, which is backwards
— they are the part a person actually reads and replies to.

`transcribe.py --rerender FILE` reads a transcript's own turn lines back as
utterances, rebuilds the block from them, and replaces the `## Needs a quick
look` section in place. The transcript's text is never touched: only the
section that asks questions about it.

## What is recovered, and what is not

The turn lines carry the timestamp, the speaker label and the text, which is
everything the text-only checks need — manglings and casing come out
identical to a fresh run over the same words.

The checks that depend on state a transcript does not record are skipped
rather than guessed at: an enrolled voice's similarity score, and which
numbered speakers `naming.py` could not resolve. A re-render therefore never
*invents* a low-confidence warning, and it preserves nothing about one that
the original run emitted — so those sections are dropped, and `--rerender`
says so on stderr rather than leaving a reader to notice the absence.

`is_diarized` is inferred from the labels themselves: more than one distinct
speaker name means the file came from a diarized run.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from . import verify
from .label import Utterance

# **[00:05:42] Ada Lovelace:** Right. Yeah. This is ...
_TURN = re.compile(r"^\*\*\[(\d+):(\d+):(\d+)\] ([^:]+):\*\* (.+)$", re.M)

# The block to replace: its heading through to the next top-level heading.
_BLOCK = re.compile(r"^## Needs a quick look\n.*?(?=^## )", re.S | re.M)

# Where the block belongs when the file has none — immediately before the
# transcript itself, which is where a fresh run puts it.
_TRANSCRIPT_HEADING = "## Transcript\n"

UNATTRIBUTED_LABEL = "Unattributed"


@dataclass
class ReRendered:
    utterances: int
    speakers: int
    before_lines: int
    after_lines: int
    manglings: int
    casing_groups: int


def utterances_from(text: str) -> list[Utterance]:
    """The transcript's turn lines, back as utterances.

    A turn records when it began but not when it ended, so each is given the
    next turn's start as its end, and the last one a nominal second. Only
    `unattributed_group` reads the durations, and it is not run here.
    """
    found: list[tuple[float, str, str]] = []
    for match in _TURN.finditer(text):
        hours, minutes, seconds, speaker, body = match.groups()
        start = int(hours) * 3600 + int(minutes) * 60 + int(seconds)
        found.append((float(start), speaker.strip(), body.strip()))

    utterances: list[Utterance] = []
    for index, (start, speaker, body) in enumerate(found):
        end = found[index + 1][0] if index + 1 < len(found) else start + 1.0
        named = None if speaker == UNATTRIBUTED_LABEL else speaker
        utterances.append(Utterance(start, max(end, start), named, body))
    return utterances


def _block_line_count(text: str) -> int:
    match = _BLOCK.search(text)
    return len(match.group(0).rstrip("\n").splitlines()) if match else 0


def rebuild(text: str, *, known_terms: set[str], names_file: Path | None) -> tuple[str, ReRendered]:
    """The transcript with a freshly built quick-look block."""
    utterances = verify_utterances = utterances_from(text)
    speakers = {u.speaker for u in utterances if u.speaker}

    block = verify.build(
        verify_utterances,
        is_diarized=len(speakers) > 1,
        unresolved=None,
        identify_matches=None,
        known_terms=known_terms,
    )
    rendered = verify.render(block, names_file=names_file)

    before = _block_line_count(text)
    if _BLOCK.search(text):
        updated = _BLOCK.sub(lambda _: rendered + "\n" if rendered else "", text, count=1)
    elif rendered and _TRANSCRIPT_HEADING in text:
        updated = text.replace(_TRANSCRIPT_HEADING, rendered + "\n" + _TRANSCRIPT_HEADING, 1)
    else:
        updated = text

    return updated, ReRendered(
        utterances=len(utterances),
        speakers=len(speakers),
        before_lines=before,
        after_lines=_block_line_count(updated),
        manglings=len(block.manglings),
        casing_groups=len(block.casing),
    )
