#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = []
# ///
"""Tests for the on-screen text reader's pure parts.

Everything here runs without Ollama and without a video file: frame thinning,
the parsing of ffmpeg's own timestamps, and the de-duplication that decides
whether two frames are the same slide. Those are where this stage gets its
answers wrong in ways nobody notices — a cap that silently drops the end of a
recording, or a slide held for four minutes rendered as forty entries.

    uv run --script evals/ocr_test.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from lt import ocr  # noqa: E402


def frames(times: list[float]) -> list[ocr.Frame]:
    return [ocr.Frame(time=t, path=Path(f"f{i}.jpg")) for i, t in enumerate(times)]


class Thinning(unittest.TestCase):
    """The cap must sample the whole recording, never truncate it."""

    def test_under_the_cap_is_untouched(self):
        original = frames([0, 5, 10])
        self.assertEqual(ocr.thin(original, 40), original)

    def test_keeps_the_first_and_the_last(self):
        thinned = ocr.thin(frames([float(i) for i in range(100)]), 10)
        self.assertEqual(len(thinned), 10)
        self.assertEqual(thinned[0].time, 0.0)
        self.assertEqual(thinned[-1].time, 99.0)

    def test_spreads_rather_than_truncating(self):
        # Truncation would make "nothing was on screen after minute two" a fact
        # about the cap rather than about the meeting.
        thinned = ocr.thin(frames([float(i) for i in range(600)]), 6)
        self.assertGreater(thinned[-1].time, 500)

    def test_a_cap_of_one_still_returns_one(self):
        self.assertEqual(len(ocr.thin(frames([0, 1, 2]), 1)), 1)

    def test_zero_means_no_cap(self):
        self.assertEqual(len(ocr.thin(frames([0, 1, 2]), 0)), 3)


class Timestamps(unittest.TestCase):
    """Frame times come from ffmpeg's showinfo, so the parsing must hold."""

    SHOWINFO = (
        "[Parsed_showinfo_2 @ 0x14f] n:   0 pts:      0 pts_time:0       "
        "duration:1 fmt:yuvj420p\n"
        "[Parsed_showinfo_2 @ 0x14f] n:   1 pts:  90000 pts_time:12.5    "
        "duration:1 fmt:yuvj420p\n"
        "[Parsed_showinfo_2 @ 0x14f] n:   2 pts: 180000 pts_time:301.04  "
        "duration:1 fmt:yuvj420p\n"
    )

    def test_reads_every_timestamp_in_order(self):
        self.assertEqual(ocr._parse_times(self.SHOWINFO), [0.0, 12.5, 301.04])

    def test_no_showinfo_is_no_timestamps_not_a_crash(self):
        self.assertEqual(ocr._parse_times("ffmpeg version 7.1\n"), [])

    def test_commas_in_the_filter_are_escaped(self):
        # An unescaped comma inside select() splits the filtergraph instead,
        # and ffmpeg then fails with a message about an unknown filter.
        expression = ocr._select_expression(0.12, 4.0)
        self.assertIn("eq(n\\,0)", expression)
        self.assertIn("gt(scene\\,0.12)", expression)
        self.assertIn("prev_selected_t", expression)

    def test_the_backstop_is_in_the_expression_by_default(self):
        # Without it, a deck left on one slide is read once and the transcript
        # reports that as the screen never changing.
        self.assertIn("gt(t-prev_selected_t\\,120.0)", ocr._select_expression(0.03, 4.0))

    def test_the_backstop_can_be_turned_off(self):
        expression = ocr._select_expression(0.03, 4.0, 0)
        self.assertEqual(expression.count("prev_selected_t"), 1)

    def test_the_default_threshold_is_below_a_real_slide_change(self):
        # Measured on a slide deck whose background stays put and whose title
        # line changes: 0.0396. A threshold above that misses every slide.
        self.assertLess(ocr.DEFAULT_SCENE, 0.0396)
        # And above the 0.005–0.027 that scrolling and typing score, or every
        # keystroke becomes a frame to read.
        self.assertGreater(ocr.DEFAULT_SCENE, 0.027)


class NoText(unittest.TestCase):
    """A blank frame must come back blank, however the model phrases it."""

    def test_the_sentinel(self):
        self.assertEqual(ocr.clean("NO_TEXT"), "")

    def test_the_sentence_forms(self):
        for answer in (
            "There is no text in this image.",
            "The image contains no legible text.",
            "no text",
        ):
            self.assertEqual(ocr.clean(answer), "", answer)

    def test_a_fence_is_stripped(self):
        self.assertEqual(ocr.clean("```text\nQ3 revenue: 4.1M\n```"), "Q3 revenue: 4.1M")

    def test_real_text_survives_including_the_word_text(self):
        answer = "Text formatting options\nBold  Italic  Underline"
        self.assertEqual(ocr.clean(answer), answer)

    def test_a_long_answer_about_text_is_not_discarded(self):
        # The no-text patterns only fire on short answers, so a slide that
        # happens to open with "There is no text..." is still kept.
        answer = "There is no text on this slide, " + "and here is why: " * 10
        self.assertEqual(ocr.clean(answer), answer.strip())


class SameSlide(unittest.TestCase):
    """One slide shown for four minutes is one entry, not forty."""

    SLIDE = "Roadmap Q3\n- Ship the ingest path\n- Cut the p95 to 200ms\n- Hire two"

    def test_identical_frames_are_one_slide(self):
        self.assertTrue(ocr.same_slide(self.SLIDE, self.SLIDE))

    def test_a_cursor_moving_is_still_one_slide(self):
        self.assertTrue(ocr.same_slide(self.SLIDE, self.SLIDE + "\n|"))

    def test_a_different_slide_is_a_different_slide(self):
        self.assertFalse(ocr.same_slide(self.SLIDE, "Appendix\nSources and method"))

    def test_empty_never_matches(self):
        self.assertFalse(ocr.same_slide("", self.SLIDE))

    def test_merge_spans_the_run_and_keeps_the_earliest_time(self):
        merged = ocr.merge([
            ocr.Slide(start=10.0, end=10.0, text=self.SLIDE),
            ocr.Slide(start=20.0, end=20.0, text=self.SLIDE + "\n|"),
            ocr.Slide(start=30.0, end=30.0, text="Appendix\nSources and method"),
        ])
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0].start, 10.0)
        self.assertEqual(merged[0].end, 20.0)
        self.assertEqual(merged[1].start, 30.0)

    def test_merge_keeps_the_fuller_reading(self):
        short, full = "Roadmap Q3", self.SLIDE
        merged = ocr.merge([
            ocr.Slide(start=1.0, end=1.0, text=short),
            ocr.Slide(start=2.0, end=2.0, text=full),
        ])
        # The two are the same slide only if they overlap enough to merge; when
        # they do, the longer reading is the one worth keeping.
        if len(merged) == 1:
            self.assertEqual(merged[0].text, full)


class Preflight(unittest.TestCase):
    """The reason a stage cannot run must be actionable, not merely true."""

    def test_an_unpulled_model_names_the_pull_command(self):
        real = ocr.ollama.installed_models
        ocr.ollama.installed_models = lambda *a, **k: ["qwen2.5:7b-instruct"]
        try:
            reason = ocr.preflight("qwen2.5vl:7b")
        finally:
            ocr.ollama.installed_models = real
        self.assertIsNotNone(reason)
        self.assertIn("ollama pull qwen2.5vl:7b", reason)

    def test_an_unreachable_daemon_says_so(self):
        real = ocr.ollama.installed_models
        ocr.ollama.installed_models = lambda *a, **k: None
        try:
            reason = ocr.preflight("qwen2.5vl:7b")
        finally:
            ocr.ollama.installed_models = real
        self.assertIn("not reachable", reason)

    def test_a_pulled_model_passes(self):
        real = ocr.ollama.installed_models
        ocr.ollama.installed_models = lambda *a, **k: ["qwen2.5vl:7b"]
        try:
            self.assertIsNone(ocr.preflight("qwen2.5vl:7b"))
        finally:
            ocr.ollama.installed_models = real

    def test_a_bare_name_matches_the_latest_tag(self):
        real = ocr.ollama.installed_models
        ocr.ollama.installed_models = lambda *a, **k: ["moondream:latest"]
        try:
            self.assertIsNone(ocr.preflight("moondream"))
        finally:
            ocr.ollama.installed_models = real


class Residency(unittest.TestCase):
    """"Is it on the GPU" is answered from /api/ps, never assumed."""

    def _with_ps(self, body):
        real = ocr.ollama._get
        ocr.ollama._get = lambda path, timeout: body if path == "/api/ps" else None
        self.addCleanup(lambda: setattr(ocr.ollama, "_get", real))

    def test_fully_resident(self):
        self._with_ps({"models": [
            {"name": "qwen2.5vl:7b", "size": 6000, "size_vram": 6000}
        ]})
        self.assertEqual(ocr.ollama.residency("qwen2.5vl:7b"), "GPU")

    def test_no_vram_is_cpu(self):
        self._with_ps({"models": [
            {"name": "qwen2.5vl:7b", "size": 6000, "size_vram": 0}
        ]})
        self.assertEqual(ocr.ollama.residency("qwen2.5vl:7b"), "CPU")

    def test_a_partial_offload_is_reported_as_a_share(self):
        self._with_ps({"models": [
            {"name": "qwen2.5vl:7b", "size": 6000, "size_vram": 3000}
        ]})
        self.assertEqual(ocr.ollama.residency("qwen2.5vl:7b"), "50% GPU")

    def test_a_model_that_is_not_loaded_is_unknown(self):
        self._with_ps({"models": []})
        self.assertIsNone(ocr.ollama.residency("qwen2.5vl:7b"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
