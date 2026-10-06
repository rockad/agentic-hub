#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["numpy>=1.24"]
# ///
"""Tests for voice prints: the store, the model guard, and the matching rules.

These run on synthetic vectors and a temporary store, never on real audio —
the same split `quality_test.py` uses between pure-function tests here and
the real-recording measurement in `evals/speaker_separation.py`. Embedding a
real voice needs `sherpa-onnx` and the two downloaded models; nothing below
does, because `enroll_from_file`/`enroll_from_speaker`/`identify` are I/O
wrappers around the pure decisions this file tests directly — matching
`diarize._window_grid` and friends being tested without a model in
`quality_test.py`'s `TestWindowGrid` and `TestClustering`.

    uv run --script evals/voices_test.py
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from lt.diarize import Turn  # noqa: E402
from lt.label import Utterance  # noqa: E402
from lt import voices  # noqa: E402


def unit(vector: list[float]) -> np.ndarray:
    array = np.array(vector, dtype=np.float32)
    return array / np.linalg.norm(array)


class TestStoreRoundTrip(unittest.TestCase):
    """Enrol, list, load and forget, against a temporary store directory.

    Every test in this class points `voices.voices_dir` at a fresh temporary
    directory rather than the real one — the real store is a person's
    biometric data and a test suite must never read or write it, which is
    also why `LOCAL_TRANSCRIBE_VOICES_DIR` is never set here: pointing the
    function itself sidesteps environment leakage between tests entirely.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._real_voices_dir = voices.voices_dir
        voices.voices_dir = lambda: Path(self.tmp.name)
        self.addCleanup(setattr, voices, "voices_dir", self._real_voices_dir)

    def test_an_enrolled_print_round_trips(self):
        vector = unit([1.0, 0.0, 0.0, 0.0])
        stored = voices.enroll("Alice", vector, 42.0, Path("embedding-campplus-zh-en.onnx"), "memo.m4a")
        self.assertEqual(stored.name, "Alice")
        self.assertEqual(stored.embedding_model, "embedding-campplus-zh-en.onnx")

        loaded = voices.load_voice("Alice")
        self.assertIsNotNone(loaded)
        np.testing.assert_allclose(loaded.vector(), vector, atol=1e-6)
        self.assertEqual(loaded.seconds, 42.0)
        self.assertEqual(loaded.source, "memo.m4a")

    def test_list_voices_is_empty_before_anything_is_enrolled(self):
        self.assertEqual(voices.list_voices(), [])

    def test_list_voices_finds_everyone_enrolled_sorted_by_name(self):
        voices.enroll("Carol", unit([1, 0]), 30.0, Path("m.onnx"), "a.m4a")
        voices.enroll("Alice", unit([0, 1]), 30.0, Path("m.onnx"), "b.m4a")
        names = [p.name for p in voices.list_voices()]
        self.assertEqual(names, ["Alice", "Carol"])

    def test_forget_removes_a_voice_and_reports_it_was_there(self):
        voices.enroll("Bob", unit([1, 0]), 30.0, Path("m.onnx"), "a.m4a")
        self.assertTrue(voices.forget_voice("Bob"))
        self.assertIsNone(voices.load_voice("Bob"))

    def test_forgetting_someone_never_enrolled_reports_that(self):
        self.assertFalse(voices.forget_voice("Nobody"))

    def test_forget_is_case_insensitive(self):
        voices.enroll("Dave", unit([1, 0]), 30.0, Path("m.onnx"), "a.m4a")
        self.assertTrue(voices.forget_voice("dave"))

    def test_re_enrolling_the_same_name_overwrites_rather_than_merges(self):
        voices.enroll("Erin", unit([1, 0, 0]), 20.0, Path("m.onnx"), "old.m4a")
        voices.enroll("Erin", unit([0, 1, 0]), 90.0, Path("m.onnx"), "new.m4a")
        prints = [p for p in voices.list_voices() if p.name == "Erin"]
        self.assertEqual(len(prints), 1)
        self.assertEqual(prints[0].source, "new.m4a")
        self.assertEqual(prints[0].seconds, 90.0)

    def test_enrolling_with_no_name_is_refused(self):
        with self.assertRaises(voices.VoiceStoreError):
            voices.enroll("   ", unit([1, 0]), 30.0, Path("m.onnx"), "a.m4a")

    def test_the_stored_file_is_not_group_or_world_readable(self):
        # Best-effort permissioning for what is biometric data — see
        # save_voice's docstring for why this is only checked, not enforced,
        # on Windows.
        if sys.platform == "win32":
            self.skipTest("chmod is a no-op for these bits on Windows")
        voices.enroll("Frank", unit([1, 0]), 30.0, Path("m.onnx"), "a.m4a")
        mode = voices.path_for("Frank").stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)


class TestBelowFloorRefusal(unittest.TestCase):
    """A print is refused below ~20s of real speech, not silently accepted."""

    def test_enough_speech_passes(self):
        voices._require_floor(voices.MIN_ENROLL_SECONDS + 1, context="in test")

    def test_too_little_speech_is_refused(self):
        with self.assertRaises(voices.VoiceStoreError) as ctx:
            voices._require_floor(5.0, context="in test.wav")
        message = str(ctx.exception)
        self.assertIn("5s", message)
        self.assertIn("in test.wav", message)

    def test_the_refusal_names_the_floor_not_a_guess(self):
        with self.assertRaises(voices.VoiceStoreError) as ctx:
            voices._require_floor(0.0, context="in test.wav")
        self.assertIn(f"{voices.MIN_ENROLL_SECONDS:.0f}s", str(ctx.exception))


class TestModelMismatch(unittest.TestCase):
    """A print is only ever compared within the model that made it."""

    def test_best_match_never_sees_a_mismatched_print(self):
        # best_match trusts its caller to have already filtered by model —
        # this proves the caller (`identify`) actually does that, by giving
        # it a print that would win handily on similarity alone and
        # confirming the filter, not the score, is what excludes it.
        current_model = "embedding-campplus-zh-en.onnx"
        other_model = "embedding-campplus-en-voxceleb.onnx"
        wrong_model_print = voices.VoicePrint(
            name="Ghost", embedding=[1.0, 0.0], embedding_model=other_model,
            seconds=60.0, source="x.m4a", enrolled="2026-01-01",
        )
        right_model_print = voices.VoicePrint(
            name="Real", embedding=[1.0, 0.0], embedding_model=current_model,
            seconds=60.0, source="x.m4a", enrolled="2026-01-01",
        )
        compatible = [p for p in [wrong_model_print, right_model_print]
                      if p.embedding_model == current_model]
        self.assertEqual([p.name for p in compatible], ["Real"])

        match = voices.best_match(unit([1.0, 0.0]), compatible)
        self.assertIsNotNone(match)
        self.assertEqual(match[0].name, "Real")


class TestBestMatch(unittest.TestCase):
    """Threshold and margin, on made-up vectors placed at known similarities."""

    def print_at(self, name: str, vector) -> voices.VoicePrint:
        return voices.VoicePrint(
            name=name, embedding=list(unit(vector)), embedding_model="m.onnx",
            seconds=60.0, source="x.m4a", enrolled="2026-01-01",
        )

    def test_a_strong_unambiguous_match_is_accepted(self):
        # Modelled on the real cross-file measurement in this module's
        # docstring: a genuine match around +0.89 against a next-best
        # around +0.53, a margin of +0.36 — comfortably past both bars.
        query = unit([1.0, 0.0])
        prints = [self.print_at("Ada", [0.95, 0.31]), self.print_at("Alan", [0.5, 0.87])]
        match = voices.best_match(query, prints)
        self.assertIsNotNone(match)
        name, score, runner_up = match
        self.assertEqual(name.name, "Ada")
        self.assertGreater(score, voices.IDENTIFY_THRESHOLD)
        self.assertGreater(score - runner_up, voices.IDENTIFY_MARGIN)

    def test_below_threshold_stays_unidentified_even_alone(self):
        # Modelled on a real measurement of a non-enrolled speaker: ~+0.32 against the
        # one enrolled print, nowhere near 0.55 — a single candidate cannot
        # be "ambiguous", but it can still be too weak to accept.
        query = unit([1.0, 0.0])
        prints = [self.print_at("Someone", [0.32, 0.95])]
        self.assertIsNone(voices.best_match(query, prints))

    def test_a_single_print_has_no_margin_problem(self):
        query = unit([1.0, 0.0])
        prints = [self.print_at("OnlyOne", [1.0, 0.0])]
        match = voices.best_match(query, prints)
        self.assertIsNotNone(match)
        self.assertEqual(match[2], -1.0)  # the "no runner-up" sentinel

    def test_two_close_candidates_above_threshold_refuse_to_pick(self):
        # Both clear IDENTIFY_THRESHOLD, but they are too close to each
        # other to call — this is exactly the ambiguity the margin exists
        # to catch, and guessing here is worse than staying numbered.
        query = unit([1.0, 0.05])
        prints = [self.print_at("A", [1.0, 0.0]), self.print_at("B", [0.99, 0.10])]
        self.assertIsNone(voices.best_match(query, prints))

    def test_no_prints_at_all(self):
        self.assertIsNone(voices.best_match(unit([1.0, 0.0]), []))


class TestClaimResolution(unittest.TestCase):
    """Two clusters cannot end up with the same enrolled name."""

    def test_the_stronger_match_keeps_a_contested_name(self):
        candidates = [(0.60, 0, "Alice"), (0.90, 1, "Alice")]
        accepted = voices._resolve_claims(candidates)
        self.assertEqual(accepted, {1: ("Alice", 0.90)})

    def test_uncontested_matches_all_survive(self):
        candidates = [(0.70, 0, "Alice"), (0.65, 1, "Bob")]
        accepted = voices._resolve_claims(candidates)
        self.assertEqual(set(accepted), {0, 1})


class TestApplyMatches(unittest.TestCase):
    """Renaming utterances, and what an unmatched cluster keeps."""

    def test_a_matched_speaker_is_renamed_everywhere_it_appears(self):
        utterances = [
            Utterance(0, 1, "Speaker 1", "hello"),
            Utterance(1, 2, "Speaker 2", "hi"),
            Utterance(2, 3, "Speaker 1", "how are you"),
        ]
        order = {0: 1, 1: 2}
        note = voices._apply_matches(utterances, order, {0: ("Ada", 0.89)})
        self.assertEqual([u.speaker for u in utterances], ["Ada", "Speaker 2", "Ada"])
        self.assertIn("Ada", note)
        self.assertIn("0.89", note)

    def test_an_unmatched_speaker_is_left_numbered(self):
        utterances = [Utterance(0, 1, "Speaker 1", "hello"), Utterance(1, 2, "Speaker 2", "hi")]
        order = {0: 1, 1: 2}
        # Speaker id 1 never appears in `accepted` — the shape produced when
        # its best match never cleared best_match's threshold and margin.
        note = voices._apply_matches(utterances, order, {0: ("Ada", 0.89)})
        self.assertEqual([u.speaker for u in utterances], ["Ada", "Speaker 2"])
        self.assertNotIn("Speaker 2", note)

    def test_nothing_matched_returns_no_note_and_renames_nobody(self):
        utterances = [Utterance(0, 1, "Speaker 1", "hello")]
        note = voices._apply_matches(utterances, {0: 1}, {})
        self.assertIsNone(note)
        self.assertEqual(utterances[0].speaker, "Speaker 1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
