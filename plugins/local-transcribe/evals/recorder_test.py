#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "obsws-python>=1.7",
# ]
# ///
"""Unit tests for the recorder logic that a live recorder cannot reach.

Two things here cannot be covered by driving a real recorder on this machine:
the stop path (macOS Screen Recording permission is not granted to the terminal,
so `screencapture` exits immediately) and the archive copy's failure branches.
Both are branching logic where a silent mistake loses a recording, so they get
tested directly against an injected state file and a stand-in process.

    uv run --script evals/recorder_test.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from lt import recorders  # noqa: E402
from lt.archive import copy_recording  # noqa: E402
from lt.recorders import RecorderError, base  # noqa: E402
from lt.recorders.screencap import STATE, ScreencaptureRecorder  # noqa: E402


class StateIsolated(unittest.TestCase):
    """Every test gets its own state directory, so none of them see each other."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="lt-recorder-test-")
        self._previous = os.environ.get("LOCAL_TRANSCRIBE_STATE_DIR")
        os.environ["LOCAL_TRANSCRIBE_STATE_DIR"] = self._tmp.name

    def tearDown(self) -> None:
        if self._previous is None:
            os.environ.pop("LOCAL_TRANSCRIBE_STATE_DIR", None)
        else:
            os.environ["LOCAL_TRANSCRIBE_STATE_DIR"] = self._previous
        self._tmp.cleanup()


class TestState(StateIsolated):
    def test_roundtrip(self):
        base.write_state("probe", {"pid": 1234})
        self.assertEqual(base.read_state("probe")["pid"], 1234)
        base.clear_state("probe")
        self.assertIsNone(base.read_state("probe"))

    def test_missing_reads_none(self):
        self.assertIsNone(base.read_state("never-written"))

    def test_corrupt_state_reads_none_rather_than_raising(self):
        (base.state_dir() / "broken.json").write_text("{not json", encoding="utf-8")
        self.assertIsNone(base.read_state("broken"))


class TestStopPath(StateIsolated):
    """`stop()` must SIGINT the process, not SIGKILL it — SIGKILL loses the file."""

    def test_stop_signals_the_process_and_clears_state(self):
        # `sleep` stands in for screencapture: it dies on SIGINT and ignores nothing.
        process = subprocess.Popen(["sleep", "30"])
        output = Path(base.state_dir()) / "fake-recording.mov"
        output.write_bytes(b"\x00" * 2048)
        base.write_state(STATE, {
            "pid": process.pid, "path": str(output),
            "started_at": time.time() - 5, "mic_only": True,
        })

        result = ScreencaptureRecorder().stop()

        self.assertFalse(result.active)
        self.assertEqual(result.path, output)
        self.assertEqual(result.bytes_written, 2048)
        self.assertIsNone(base.read_state(STATE), "state must be cleared after stop")
        self.assertIsNotNone(process.poll(), "the recording process must be gone")
        self.assertTrue(
            any("microphone only" in note for note in result.notes),
            "a mic-only recording must say so on stop",
        )

    def test_stop_reports_an_empty_file_as_a_permission_problem(self):
        process = subprocess.Popen(["sleep", "30"])
        output = Path(base.state_dir()) / "empty.mov"
        output.touch()
        base.write_state(STATE, {
            "pid": process.pid, "path": str(output), "started_at": time.time(),
        })
        result = ScreencaptureRecorder().stop()
        process.kill()
        self.assertEqual(result.bytes_written, 0)
        self.assertTrue(any("Screen Recording" in note for note in result.notes))

    def test_stop_with_no_state_raises(self):
        with self.assertRaises(RecorderError):
            ScreencaptureRecorder().stop()

    def test_stop_with_a_dead_process_clears_stale_state(self):
        base.write_state(STATE, {"pid": 999_999, "path": "/nowhere.mov"})
        with self.assertRaises(RecorderError):
            ScreencaptureRecorder().stop()
        self.assertIsNone(base.read_state(STATE), "stale state must not persist")

    def test_status_reports_stale_state_without_claiming_to_record(self):
        base.write_state(STATE, {"pid": 999_999, "path": "/nowhere.mov"})
        status = ScreencaptureRecorder().status()
        self.assertFalse(status.active)


class TestArchive(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="lt-archive-test-")
        self.root = Path(self._tmp.name)
        self.source = self.root / "call.mov"
        self.source.write_bytes(b"recording")
        os.environ.pop("LOCAL_TRANSCRIBE_ARCHIVE_DIR", None)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_no_destination_keeps_the_local_file_and_says_so(self):
        result = copy_recording(self.source)
        self.assertFalse(result.copied)
        self.assertIn(str(self.source), result.message)
        self.assertTrue(self.source.exists())

    def test_copy_succeeds_and_leaves_the_original(self):
        result = copy_recording(self.source, self.root / "archive")
        self.assertTrue(result.copied)
        self.assertTrue(result.destination.exists())
        self.assertTrue(self.source.exists(), "the local file is never deleted")

    def test_unwritable_destination_names_the_safe_local_path(self):
        # A file where a directory should be: mkdir fails, so the copy must not.
        blocked = self.root / "not-a-dir"
        blocked.write_text("x")
        result = copy_recording(self.source, blocked / "under")
        self.assertFalse(result.copied)
        self.assertIn("safe at", result.message)
        self.assertIn(str(self.source), result.message)
        self.assertTrue(self.source.exists())

    def test_missing_source_is_reported_not_raised(self):
        result = copy_recording(self.root / "gone.mov", self.root / "archive")
        self.assertFalse(result.copied)
        self.assertIn("does not exist", result.message)


class TestRegistry(unittest.TestCase):
    def test_unknown_backend_raises_with_the_known_names(self):
        with self.assertRaises(RecorderError) as caught:
            recorders.get("nosuchthing")
        self.assertIn("obs", str(caught.exception))

    def test_obs_is_preferred_over_the_builtin_recorder(self):
        self.assertLess(
            recorders.PREFERENCE.index("obs"),
            recorders.PREFERENCE.index("screencapture"),
            "OBS is the only cross-platform route to deterministic labels",
        )

    def test_survey_reports_every_backend(self):
        names = {report.name for report in recorders.survey()}
        self.assertEqual(names, set(recorders.BACKENDS))

    def test_pinning_an_unknown_backend_raises(self):
        os.environ["LOCAL_TRANSCRIBE_RECORDER"] = "nosuchthing"
        try:
            with self.assertRaises(RecorderError):
                recorders.choose()
        finally:
            os.environ.pop("LOCAL_TRANSCRIBE_RECORDER")

    def test_a_backend_that_cannot_record_a_call_is_not_chosen_for_one(self):
        recorder, reports = recorders.choose(for_a_call=True)
        for report in reports:
            if report.available and not report.can_record_a_call and recorder is not None:
                self.assertNotEqual(recorder.name, report.name)


class TestObsConfig(unittest.TestCase):
    """The connection settings, which are reachable without a running OBS."""

    def setUp(self) -> None:
        for key in ("OBS_WS_HOST", "OBS_WS_PORT"):
            os.environ.pop(key, None)

    tearDown = setUp

    def test_default_port(self):
        from lt.recorders import obs
        self.assertEqual(obs.port(), 4455)

    def test_bad_port_raises_rather_than_defaulting(self):
        from lt.recorders import obs
        os.environ["OBS_WS_PORT"] = "not-a-port"
        with self.assertRaises(RecorderError):
            obs.port()

    def test_configured_host_wins(self):
        from lt.recorders import obs
        os.environ["OBS_WS_HOST"] = "10.0.0.5"
        self.assertEqual(obs.candidate_hosts(), ["10.0.0.5"])

    def test_default_host_is_loopback(self):
        from lt.recorders import obs
        self.assertEqual(obs.candidate_hosts()[0], "127.0.0.1")

    def test_unreachable_message_never_contains_a_password(self):
        from lt.recorders import obs
        os.environ["OBS_WS_PASSWORD"] = "hunter2-do-not-leak"
        try:
            message = obs.ObsRecorder()._unreachable_message(["127.0.0.1:4455 refused"])
            self.assertNotIn("hunter2", message)
        finally:
            os.environ.pop("OBS_WS_PASSWORD")

    def test_capabilities_of_absent_obs_is_unavailable_with_a_reason(self):
        from lt.recorders import obs
        caps = obs.ObsRecorder().capabilities()
        if not caps.available:
            self.assertTrue(caps.blockers, "an unavailable backend must say why")


if __name__ == "__main__":
    unittest.main(verbosity=2)
