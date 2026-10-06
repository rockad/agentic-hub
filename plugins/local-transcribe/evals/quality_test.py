#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["numpy>=1.24"]
# ///
"""Tests for the degeneracy checks.

These are the guard against the worst failure the pipeline has: a recognition
pass that loops, producing thousands of confident words whose timestamps have
stalled, so every speaker label lands on one person and the transcript reads as
structured when it is not. The checks are pure functions over segments, so they
need no model and run in milliseconds.

    uv run --script evals/quality_test.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from lt.asr import Segment  # noqa: E402
from lt.label import Utterance  # noqa: E402
from lt import quality  # noqa: E402


VOCABULARY = (
    "cluster migration staging production deadline handover roadmap capacity "
    "incident rollout quota latency invoice tenant backlog release scheduler "
    "gateway retention onboarding budget vendor forecast pipeline firmware "
    "inventory contract escalation compliance provisioning"
).split()


def speech(count: int = 60) -> list[Segment]:
    """Ordinary varied speech, in order.

    The phrasing has to actually vary: a fixture whose every line ends the same
    way is a repetition loop by construction and would make the check look
    broken when it is working. Words are drawn from a vocabulary by a stride
    that is coprime with its length, so no three-word run repeats.
    """
    words: list[Segment] = []
    for i in range(count):
        picked = [VOCABULARY[(i * 7 + j * 11) % len(VOCABULARY)] for j in range(11)]
        words.append(Segment(float(i * 3), float(i * 3 + 2), " ".join(picked)))
    return words


def looped(count: int = 60) -> list[Segment]:
    """What a conditioning loop produces: one phrase, over and over."""
    return [Segment(float(i * 3), float(i * 3 + 2), "у нас у нас у нас") for i in range(count)]


class TestRepetition(unittest.TestCase):
    def test_ordinary_speech_is_not_flagged(self):
        self.assertLess(quality.repetition_share(speech()), quality.REPETITION_LIMIT)

    def test_a_loop_is_flagged(self):
        self.assertGreater(quality.repetition_share(looped()), quality.REPETITION_LIMIT)

    def test_too_little_text_is_not_judged(self):
        # A five-word memo must not be called a loop for repeating a word.
        self.assertEqual(quality.repetition_share([Segment(0, 1, "yes yes")]), 0.0)


class TestMonotonicity(unittest.TestCase):
    def test_ordered_segments_are_clean(self):
        self.assertEqual(quality.non_monotonic_share(speech()), 0.0)

    def test_backwards_timestamps_are_counted(self):
        segments = speech(10)
        segments[5] = Segment(1.0, 2.0, "out of order")
        self.assertGreater(quality.non_monotonic_share(segments), 0.0)

    def test_a_single_segment_is_clean(self):
        self.assertEqual(quality.non_monotonic_share([Segment(0, 1, "one")]), 0.0)


class TestDominance(unittest.TestCase):
    def test_a_balanced_conversation(self):
        utterances = [
            Utterance(0, 1, "Speaker 1", "one two three four five"),
            Utterance(1, 2, "Speaker 2", "six seven eight nine ten"),
        ]
        _, share = quality.dominant_share(utterances)
        self.assertLess(share, quality.COLLAPSE_LIMIT)

    def test_a_collapse(self):
        utterances = [
            Utterance(0, 1, "Speaker 1", " ".join(["word"] * 100)),
            Utterance(1, 2, "Speaker 2", "one"),
        ]
        speaker, share = quality.dominant_share(utterances)
        self.assertEqual(speaker, "Speaker 1")
        self.assertGreaterEqual(share, quality.COLLAPSE_LIMIT)

    def test_no_labels_at_all(self):
        self.assertEqual(quality.dominant_share([Utterance(0, 1, None, "hi")]), (None, 0.0))


class TestForeignScript(unittest.TestCase):
    def test_english_has_no_foreign_script(self):
        self.assertEqual(quality.foreign_script_share(speech()), (None, 0.0))

    def test_cyrillic_is_detected(self):
        script, share = quality.foreign_script_share(
            [Segment(0, 1, "привет как дела сегодня")]
        )
        self.assertEqual(script, "Cyrillic")
        self.assertGreater(share, 0.9)


class TestAssess(unittest.TestCase):
    def test_a_clean_run_produces_no_warnings(self):
        utterances = [
            Utterance(0, 1, "Speaker 1", "one two three four five"),
            Utterance(1, 2, "Speaker 2", "six seven eight nine ten"),
        ]
        report = quality.assess(speech(), utterances, speakers_found=2)
        self.assertTrue(report.ok, report.warnings)
        self.assertTrue(report.labels_trustworthy)

    def test_a_loop_distrusts_the_labels(self):
        report = quality.assess(looped(), None, speakers_found=2)
        self.assertFalse(report.labels_trustworthy)
        self.assertTrue(any("looped" in w for w in report.warnings))

    def test_a_collapse_distrusts_the_labels(self):
        utterances = [
            Utterance(0, 1, "Speaker 1", " ".join(["word"] * 100)),
            Utterance(1, 2, "Speaker 2", "one"),
        ]
        report = quality.assess(speech(), utterances, speakers_found=2)
        self.assertFalse(report.labels_trustworthy)
        self.assertTrue(any("did not attach" in w for w in report.warnings))

    def test_a_forced_language_that_contradicts_the_script_warns(self):
        segments = [Segment(float(i), float(i) + 1, "привет как дела") for i in range(60)]
        report = quality.assess(segments, None, requested_language="en")
        self.assertTrue(any("probably" in w and "Cyrillic" in w for w in report.warnings))

    def test_no_forced_language_means_no_script_warning(self):
        segments = [Segment(float(i), float(i) + 1, "привет как дела") for i in range(60)]
        report = quality.assess(segments, None, requested_language=None)
        self.assertFalse(any("Cyrillic" in w for w in report.warnings))

    def test_deterministic_stream_labels_are_exempt_from_dominance(self):
        # A webinar recorded on two tracks: the far end talks almost the whole
        # time. The labels are still facts about which stream carried the
        # words, so this must not be reported as a failed attribution.
        utterances = [
            Utterance(0, 1, "Remote", " ".join(["word"] * 100)),
            Utterance(1, 2, "Me", "thanks"),
        ]
        report = quality.assess(
            speech(), utterances, speakers_found=2, labels_inferred=False
        )
        self.assertTrue(report.labels_trustworthy)
        self.assertFalse(any("did not attach" in w for w in report.warnings))

    def test_one_speaker_is_never_a_collapse(self):
        # Dictation is 100% one speaker and that is correct, not a failure.
        utterances = [Utterance(0, 1, "Speaker 1", " ".join(["word"] * 100))]
        report = quality.assess(speech(), utterances, speakers_found=1)
        self.assertTrue(report.labels_trustworthy)


class TestNoAutomaticModelSwitch(unittest.TestCase):
    """The retry on a second embedding model is gone, and must stay gone.

    It read a collapsed *clustering* as evidence about the *embedding* and
    switched to a model that separates voices at 21% equal-error rate instead
    of 1%, so every recording it fired on was labelled by the worse model while
    printing a line claiming it had helped. These assertions exist so that
    reintroducing it fails a test rather than passing review.
    """

    def test_the_fallback_embedding_api_is_gone(self):
        from lt import diarize

        for name in (
            "ensure_fallback_embedding",
            "embedding_overridden",
            "FALLBACK_EMBEDDING_FILE",
            "FALLBACK_EMBEDDING_URL",
        ):
            self.assertFalse(
                hasattr(diarize, name),
                f"lt.diarize.{name} is back; the automatic model switch was a "
                "regression and dominance is a fact about clustering, not about "
                "the embedding model",
            )

    def test_the_pipeline_does_not_switch_models_on_dominance(self):
        source = (
            Path(__file__).resolve().parent.parent / "scripts/transcribe.py"
        ).read_text()
        self.assertNotIn("ensure_fallback_embedding", source)
        self.assertNotIn("used_fallback", source)

    def test_a_pinned_embedding_model_is_still_honoured(self):
        import inspect

        from lt import diarize

        self.assertIn(
            "embedding_model", inspect.signature(diarize.diarize).parameters
        )


class TestWindowGrid(unittest.TestCase):
    """The grid that replaced segmentation, checked without a model.

    Segmentation used to decide where speakers changed and was wrong about it
    on a single mixed recording, which collapsed the clustering to one speaker.
    The grid makes no such claim: it covers speech at a fixed rate and lets the
    clustering place the boundaries.
    """

    def setUp(self):
        from lt import diarize

        self.diarize = diarize

    def test_a_long_region_is_covered_at_the_hop_rate(self):
        grid, belongs = self.diarize._window_grid([(0.0, 10.0)])
        self.assertEqual(set(belongs), {0})
        self.assertEqual(grid[0], (0.0, self.diarize.WINDOW_SECONDS))
        starts = [round(start, 3) for start, _ in grid]
        self.assertEqual(starts[1] - starts[0], self.diarize.HOP_SECONDS)
        self.assertLessEqual(max(end for _, end in grid), 10.0)

    def test_a_region_shorter_than_the_window_is_one_window(self):
        grid, _ = self.diarize._window_grid([(1.0, 2.5)])
        self.assertEqual(grid, [(1.0, 2.5)])

    def test_a_region_too_short_to_fingerprint_is_dropped(self):
        grid, belongs = self.diarize._window_grid([(1.0, 1.2)])
        self.assertEqual(grid, [])
        self.assertEqual(belongs, [])

    def test_windows_never_span_two_regions(self):
        regions = [(0.0, 6.0), (30.0, 36.0)]
        grid, belongs = self.diarize._window_grid(regions)
        for (start, end), region in zip(grid, belongs):
            low, high = regions[region]
            self.assertGreaterEqual(start, low)
            self.assertLessEqual(end, high)


class TestClustering(unittest.TestCase):
    """Two voices are two blobs on the unit sphere; the rest is bookkeeping."""

    def setUp(self):
        from lt import diarize

        self.diarize = diarize

    def _two_blobs(self, per_blob=40, spread=0.05, seed=0):
        import numpy as np

        rng = np.random.default_rng(seed)
        base = np.zeros((2, 16), dtype=np.float32)
        base[0, 0] = base[1, 1] = 1.0
        rows = []
        for index in (0, 1):
            noise = rng.normal(0, spread, size=(per_blob, 16)).astype(np.float32)
            blob = base[index] + noise
            rows.append(blob / np.linalg.norm(blob, axis=1, keepdims=True))
        truth = np.array([0] * per_blob + [1] * per_blob)
        return np.concatenate(rows), truth

    def test_a_known_count_splits_the_blobs(self):
        vectors, truth = self._two_blobs()
        labels = self.diarize._cluster(vectors, 2, self.diarize.DEFAULT_THRESHOLD)
        agree = (labels == truth).mean()
        self.assertIn(round(max(agree, 1 - agree), 3), (1.0,))

    def test_an_unknown_count_finds_two(self):
        vectors, _ = self._two_blobs()
        labels = self.diarize._cluster(vectors, None, self.diarize.DEFAULT_THRESHOLD)
        self.assertEqual(len(set(labels.tolist())), 2)

    def test_one_voice_is_not_split_into_several(self):
        vectors, _ = self._two_blobs(per_blob=40, spread=0.05)
        one_voice = vectors[:40]
        labels = self.diarize._cluster(
            one_voice, None, self.diarize.DEFAULT_THRESHOLD
        )
        self.assertEqual(len(set(labels.tolist())), 1)


class TestSmoothingAndTurns(unittest.TestCase):
    """A speaker holds the floor for longer than one window."""

    def setUp(self):
        from lt import diarize

        self.diarize = diarize

    def test_an_isolated_disagreement_is_voted_away(self):
        import numpy as np

        grid = [(float(i), float(i) + 3.0) for i in range(8)]
        belongs = [0] * len(grid)
        labels = np.array([0, 0, 0, 1, 0, 0, 0, 0])
        smoothed = self.diarize._smooth(grid, labels, belongs)
        self.assertEqual(smoothed.tolist(), [0] * 8)

    def test_the_vote_does_not_cross_a_silence(self):
        import numpy as np

        grid = [(0.0, 3.0), (1.0, 4.0), (60.0, 63.0)]
        belongs = [0, 0, 1]
        labels = np.array([0, 0, 1])
        smoothed = self.diarize._smooth(grid, labels, belongs)
        self.assertEqual(smoothed.tolist(), [0, 0, 1])

    def test_turns_are_clamped_to_their_region(self):
        import numpy as np

        regions = [(10.0, 20.0)]
        grid = [(10.0, 13.0), (11.0, 14.0), (12.0, 15.0)]
        turns = self.diarize._turns_from_labels(
            grid, np.array([0, 0, 0]), regions, [0, 0, 0]
        )
        self.assertEqual(len(turns), 1)
        self.assertAlmostEqual(turns[0].start, 10.0)
        self.assertAlmostEqual(turns[0].end, 20.0)

    def test_a_boundary_falls_between_the_two_window_centres(self):
        import numpy as np

        regions = [(0.0, 10.0)]
        grid = [(0.0, 3.0), (1.0, 4.0), (2.0, 5.0), (3.0, 6.0)]
        turns = self.diarize._turns_from_labels(
            grid, np.array([0, 0, 1, 1]), regions, [0, 0, 0, 0]
        )
        self.assertEqual([turn.speaker for turn in turns], [0, 1])
        # centres 1.5, 2.5, 3.5, 4.5 — the change sits between 2.5 and 3.5
        self.assertAlmostEqual(turns[0].end, 3.0)
        self.assertAlmostEqual(turns[1].start, 3.0)

    def test_speaker_ids_follow_first_appearance(self):
        import numpy as np

        regions = [(0.0, 20.0)]
        grid = [(float(i), float(i) + 3.0) for i in range(6)]
        turns = self.diarize._turns_from_labels(
            grid, np.array([3, 3, 1, 1, 3, 3]), regions, [0] * 6
        )
        self.assertEqual([turn.speaker for turn in turns], [0, 1, 0])


class TestObsDuration(unittest.TestCase):
    """obs-websocket reports `outputDuration` in milliseconds, and `Recording`
    carries seconds. Passing it through unconverted reported a 16-second clip
    as `duration: 16099s`, which looked like a plausible long recording."""

    class _Status:
        def __init__(self, millis):
            self.output_duration = millis

    def test_milliseconds_become_seconds(self):
        from lt.recorders.obs import ObsRecorder

        self.assertAlmostEqual(
            ObsRecorder._duration_seconds(self._Status(16099)), 16.099
        )

    def test_absent_duration_stays_none(self):
        from lt.recorders.obs import ObsRecorder

        self.assertIsNone(ObsRecorder._duration_seconds(self._Status(None)))
        self.assertIsNone(ObsRecorder._duration_seconds(object()))

    def test_zero_is_zero_not_none(self):
        from lt.recorders.obs import ObsRecorder

        self.assertEqual(ObsRecorder._duration_seconds(self._Status(0)), 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
