#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["imageio-ffmpeg>=0.5", "numpy>=1.24"]
# ///
"""Tests for the mixed-track detector (`lt/mixcheck.py`).

This module exists because a real recording broke the plugin's old assumption
that a stream count is a source count: a 2.35 GB / 49-minute OBS capture of a
two-person meeting, recorded from **one** room microphone, wrote two audio
streams that carried the identical mix, and the plugin labelled them `Me` /
`Remote` anyway — attributing the user's own words to the other person. That
file is private to the person who recorded it and is not something a public
repository can ship or depend on, so these tests build small stand-ins with
the bundled ffmpeg that reproduce the same two shapes and check the detector
tells them apart:

    same mix, two levels    the exact failure — one source, two tracks,
                             different gain and codec, must be flagged "mixed"
    two distinct sources    two different voices on two streams, must be
                             flagged "distinct" — guards against a detector
                             that just always says "mixed"

Measured against the real failing file directly (not reproduced here, but
worth recording): envelope correlation **0.96** against a threshold of 0.60,
in 1.7s wall clock for the whole file. The synthetic fixtures below land at
1.00 (mixed) and ~0.25 (distinct) — the same wide separation.

    uv run --script evals/mixcheck_test.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from lt import mixcheck  # noqa: E402
from lt.ffmpeg import ffmpeg_path  # noqa: E402

HAVE_SAY = shutil.which("say") is not None


def _ffmpeg(args: list[str]) -> None:
    result = subprocess.run(
        [ffmpeg_path(), "-nostdin", "-loglevel", "error", "-y", *args],
        stdin=subprocess.DEVNULL, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {args}\n{result.stderr}")


class ContainerFixtures(unittest.TestCase):
    """Builds the two container shapes once, in a temp directory."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="lt-mixcheck-")
        cls.work = Path(cls._tmp.name)

        # --- the exact failure: one source, two tracks, different gain and
        #     codec — what one room mic recorded onto two OBS tracks looks
        #     like on disk. ----------------------------------------------
        mono = cls.work / "mono.wav"
        if HAVE_SAY:
            aiff = cls.work / "mono.aiff"
            subprocess.run(
                ["say", "-o", str(aiff),
                 "Good morning everyone. Let's review the migration plan and "
                 "talk about the deadline for staging. Thanks for setting "
                 "this up, I wanted to ask about the rollback plan."],
                check=True,
            )
            _ffmpeg(["-i", str(aiff), "-ac", "1", "-ar", "48000", str(mono)])
        else:
            _ffmpeg([
                "-f", "lavfi",
                "-i", "sine=frequency=300:duration=20,tremolo=f=0.7:d=0.8",
                "-ac", "1", "-ar", "48000", str(mono),
            ])

        low, high = cls.work / "low.m4a", cls.work / "high.m4a"
        _ffmpeg(["-i", str(mono), "-filter:a", "volume=0.4",
                 "-c:a", "aac", "-b:a", "96k", str(low)])
        _ffmpeg(["-i", str(mono), "-filter:a", "volume=1.6",
                 "-c:a", "aac", "-b:a", "192k", str(high)])
        cls.mixed = cls.work / "mixed_two_track.mkv"
        _ffmpeg(["-i", str(low), "-i", str(high),
                 "-map", "0:a", "-map", "1:a", "-c:a", "copy", str(cls.mixed)])

        # --- a genuine two-source recording: two different contents ------
        cls.distinct = cls.work / "distinct_two_source.mkv"
        a_m4a, b_m4a = cls.work / "a.m4a", cls.work / "b.m4a"
        if HAVE_SAY:
            a_aiff, b_aiff = cls.work / "a.aiff", cls.work / "b.aiff"
            subprocess.run(["say", "-v", "Daniel", "-o", str(a_aiff),
                "Good morning everyone. Let's start the review of the "
                "migration plan and talk about the deadline for staging."],
                check=True)
            subprocess.run(["say", "-v", "Kathy", "-o", str(b_aiff),
                "Thanks for setting this up. I wanted to ask whether the "
                "rollback plan is documented anywhere before we proceed."],
                check=True)
            _ffmpeg(["-i", str(a_aiff), "-ac", "1", "-ar", "48000",
                     "-c:a", "aac", str(a_m4a)])
            _ffmpeg(["-i", str(b_aiff), "-ac", "1", "-ar", "48000",
                     "-c:a", "aac", str(b_m4a)])
        else:
            # No `say` on this platform (Linux CI): two tones with unrelated
            # amplitude envelopes stand in for two independent voices. Real
            # speech content is not what is being tested — only that two
            # uncorrelated loudness contours are told apart from one shared
            # one, which is exactly what this module measures.
            _ffmpeg(["-f", "lavfi",
                     "-i", "sine=frequency=300:duration=20,tremolo=f=0.7:d=0.8",
                     "-ac", "1", "-ar", "48000", "-c:a", "aac", str(a_m4a)])
            _ffmpeg(["-f", "lavfi",
                     "-i", "sine=frequency=520:duration=20,tremolo=f=2.9:d=0.8",
                     "-ac", "1", "-ar", "48000", "-c:a", "aac", str(b_m4a)])
        _ffmpeg(["-i", str(a_m4a), "-i", str(b_m4a),
                 "-map", "0:a", "-map", "1:a", "-c:a", "copy", str(cls.distinct)])

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()


class TestTheExactFailureIsFlagged(ContainerFixtures):
    """The direction that matters most: this MUST come out "mixed"."""

    def test_same_mix_at_different_gains_and_codecs_is_flagged(self):
        report = mixcheck.compare(self.mixed, None, 0, 1)
        self.assertEqual(report.status, "mixed", report.describe())
        self.assertGreaterEqual(report.score, mixcheck.SAME_MIX_THRESHOLD)

    def test_classify_and_overall_status_agree(self):
        reports = mixcheck.classify(self.mixed, 2, None)
        self.assertEqual(mixcheck.overall_status(reports), "mixed")


class TestTwoRealSourcesAreNotFlagged(ContainerFixtures):
    """The guard against a detector that just always says "mixed"."""

    def test_two_separate_sources_are_not_flagged(self):
        report = mixcheck.compare(self.distinct, None, 0, 1)
        self.assertEqual(report.status, "distinct", report.describe())
        self.assertLess(report.score, mixcheck.SAME_MIX_THRESHOLD)

    def test_classify_and_overall_status_agree(self):
        reports = mixcheck.classify(self.distinct, 2, None)
        self.assertEqual(mixcheck.overall_status(reports), "distinct")


class TestOverallStatus(unittest.TestCase):
    def test_any_mixed_pair_makes_it_mixed(self):
        reports = [
            mixcheck.MixReport(status="distinct", score=0.1, stream_a=0, stream_b=1),
            mixcheck.MixReport(status="mixed", score=0.9, stream_a=0, stream_b=2),
        ]
        self.assertEqual(mixcheck.overall_status(reports), "mixed")

    def test_all_inconclusive_stays_inconclusive(self):
        reports = [mixcheck.MixReport(status="inconclusive", score=0.0)]
        self.assertEqual(mixcheck.overall_status(reports), "inconclusive")

    def test_no_reports_is_inconclusive(self):
        self.assertEqual(mixcheck.overall_status([]), "inconclusive")

    def test_one_distinct_pair_is_enough(self):
        reports = [
            mixcheck.MixReport(status="inconclusive", score=0.0, stream_a=0, stream_b=1),
            mixcheck.MixReport(status="distinct", score=0.2, stream_a=0, stream_b=2),
        ]
        self.assertEqual(mixcheck.overall_status(reports), "distinct")


class TestEnvelopeMath(unittest.TestCase):
    """The comparison primitives, with no audio file and no ffmpeg at all."""

    @staticmethod
    def _norm(x: np.ndarray) -> np.ndarray:
        return (x - x.mean()) / x.std()

    def test_identical_envelopes_correlate_perfectly(self):
        a = self._norm(np.sin(np.linspace(0, 20, 400)))
        self.assertAlmostEqual(mixcheck._best_correlation(a, a.copy(), 5), 1.0, places=6)

    def test_a_gain_and_dc_offset_do_not_reduce_the_score(self):
        # The property the whole module depends on: two tracks of the same
        # audio at different levels must score as if they were identical.
        raw = np.sin(np.linspace(0, 20, 400)) + 2.0
        scaled = raw * 5.0 + 100.0
        a, b = self._norm(raw), self._norm(scaled)
        self.assertAlmostEqual(mixcheck._best_correlation(a, b, 5), 1.0, places=5)

    def test_a_small_shift_is_found_within_the_offset_window(self):
        base = np.sin(np.linspace(0, 20, 400))
        a, b = self._norm(base), self._norm(np.roll(base, 3))
        self.assertGreater(mixcheck._best_correlation(a, b, 5), 0.99)

    def test_uncorrelated_noise_scores_low(self):
        rng = np.random.default_rng(0)
        a = self._norm(rng.standard_normal(400))
        b = self._norm(rng.standard_normal(400))
        self.assertLess(abs(mixcheck._best_correlation(a, b, 5)), 0.3)

    def test_envelope_of_near_silence_is_none(self):
        silence = np.zeros(mixcheck.SAMPLE_RATE * 2, dtype=np.float32)
        self.assertIsNone(mixcheck._envelope(silence))

    def test_envelope_is_gain_invariant_end_to_end(self):
        # A full pass through _envelope (not just _best_correlation) on two
        # raw sample arrays that are the same loudness contour at different
        # volumes — the shape this module exists to recognise.
        t = np.linspace(0, 4, mixcheck.SAMPLE_RATE * 4, endpoint=False)
        carrier = np.sin(2 * np.pi * 300 * t)
        contour = 0.5 + 0.5 * np.sin(2 * np.pi * 0.6 * t)  # a slow tremolo
        quiet = (carrier * contour * 0.2).astype(np.float32)
        loud = (carrier * contour * 0.9).astype(np.float32)
        env_a, env_b = mixcheck._envelope(quiet), mixcheck._envelope(loud)
        self.assertIsNotNone(env_a)
        self.assertIsNotNone(env_b)
        max_offset = max(1, int(mixcheck.MAX_OFFSET_SECONDS / mixcheck.FRAME_SECONDS))
        self.assertGreater(mixcheck._best_correlation(env_a, env_b, max_offset), 0.99)


class TestSilentStreams(unittest.TestCase):
    """A track the recorder wrote but never fed is not a source.

    A real 66-minute recording carried one such track — digital silence, mean
    and peak both -91 dB — and the pair could not be correlated because one
    side has no envelope. That came back "inconclusive", and the run then
    labelled by track anyway and put a whole two-person conversation on `Me`.
    These assertions keep the two questions apart: whether two streams are the
    same mix, and whether a stream holds anything at all.
    """

    def _report(self, silent, status="inconclusive"):
        return mixcheck.MixReport(
            status=status, score=0.0, stream_a=0, stream_b=1, silent=tuple(silent)
        )

    def test_silent_indices_are_collected_across_pairs(self):
        reports = [self._report([1]), self._report([2])]
        self.assertEqual(mixcheck.silent_streams(reports), [1, 2])

    def test_a_stream_holding_audio_is_not_listed(self):
        self.assertEqual(mixcheck.silent_streams([self._report([])]), [])

    def test_carrying_audio_drops_the_silent_track(self):
        self.assertEqual(mixcheck.carrying_audio([self._report([1])], 2), [0])

    def test_carrying_audio_can_leave_the_second_stream(self):
        # The live track is not always stream 0, and defaulting to 0 would
        # transcribe silence.
        self.assertEqual(mixcheck.carrying_audio([self._report([0])], 2), [1])

    def test_two_live_streams_are_both_kept(self):
        self.assertEqual(
            mixcheck.carrying_audio([self._report([], status="distinct")], 2), [0, 1]
        )

    def test_silence_peak_is_below_any_real_recording(self):
        # A quiet room through a distant microphone still peaks far above the
        # threshold; digital silence is orders of magnitude below it.
        self.assertLess(mixcheck.SILENCE_PEAK, 1e-3)
        self.assertGreater(mixcheck.SILENCE_PEAK, 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
