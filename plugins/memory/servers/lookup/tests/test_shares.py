"""Tests for mounting a source's share from inside the container.

The behaviour being protected: **lookup must start and keep serving when a
share is unreachable, and attach it again on its own once it answers.** A
volume-backed source used to be a hard start dependency, so changing network
took the whole service down; these assert the four states of the reconcile and
that nothing in the path can raise.

    uv run python -m unittest tests.test_shares
"""

from __future__ import annotations

import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

from lookup import shares


def source(name="archive", root="/Volumes/archive", device="//10.0.0.1/archive",
           options="ro,vers=3.0", username="${SHARE_USER}", password="${SHARE_PASS}",
           kind="cifs"):
    """A stand-in for a manifest Source, carrying only what shares.py reads."""
    volume = {"type": kind, "device": device, "options": options}
    if username is not None:
        volume["username"] = username
    if password is not None:
        volume["password"] = password
    return type("S", (), {"name": name, "root": pathlib.Path(root),
                          "volume": volume})()


def local_source(name="vault", root="/tmp/vault"):
    return type("S", (), {"name": name, "root": pathlib.Path(root),
                          "volume": None})()


class HostParsing(unittest.TestCase):
    def test_a_unc_address_yields_its_host(self):
        self.assertEqual(shares.host_of("//192.168.1.90/archive"), "192.168.1.90")

    def test_a_local_path_has_no_host(self):
        self.assertEqual(shares.host_of("/Volumes/archive"), "")

    def test_an_empty_address_has_no_host(self):
        self.assertEqual(shares.host_of(""), "")


class Reachability(unittest.TestCase):
    def test_a_non_address_is_never_reachable(self):
        # No probe is attempted, so nothing can hang on a malformed device.
        self.assertFalse(shares.reachable("/Volumes/archive"))

    def test_a_refused_connection_is_unreachable(self):
        with mock.patch("socket.create_connection", side_effect=OSError):
            self.assertFalse(shares.reachable("//10.255.255.1/x"))

    def test_an_accepted_connection_is_reachable(self):
        with mock.patch("socket.create_connection", return_value=mock.MagicMock()):
            self.assertTrue(shares.reachable("//10.0.0.1/x"))


class MountPointReading(unittest.TestCase):
    def test_a_mount_point_is_detected(self):
        text = "//10.0.0.1/archive /Volumes/archive cifs ro 0 0\n"
        with mock.patch.object(pathlib.Path, "read_text", return_value=text):
            self.assertTrue(shares.is_mounted(pathlib.Path("/Volumes/archive")))

    def test_an_unmounted_path_is_not(self):
        with mock.patch.object(pathlib.Path, "read_text", return_value=""):
            self.assertFalse(shares.is_mounted(pathlib.Path("/Volumes/archive")))

    def test_an_octal_escaped_space_is_decoded(self):
        # The kernel writes a space in a mount point as \040.
        text = "//h/s /Volumes/my\\040share cifs ro 0 0\n"
        with mock.patch.object(pathlib.Path, "read_text", return_value=text):
            self.assertTrue(shares.is_mounted(pathlib.Path("/Volumes/my share")))

    def test_an_unreadable_mount_table_is_not_an_error(self):
        # Running outside a Linux container: report nothing mounted, do not raise.
        with mock.patch.object(pathlib.Path, "read_text", side_effect=OSError):
            self.assertEqual(shares.mount_points(), set())


class Attaching(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / "share"
        self.addCleanup(self.tmp.cleanup)

    def test_a_missing_cifs_helper_is_reported_as_a_build_problem(self):
        with mock.patch.object(shares, "cifs_helper", return_value=None):
            ok, message = shares.attach(source(root=str(self.root)))
        self.assertFalse(ok)
        self.assertIn("cifs-utils", message)

    def test_the_helper_is_found_wherever_the_distro_puts_it(self):
        # Debian trixie ships it in /usr/sbin, not /sbin. A fixed path made a
        # working image report cifs-utils as missing.
        with mock.patch("shutil.which", return_value=None), \
             mock.patch.object(pathlib.Path, "exists",
                               lambda self: str(self) == "/usr/sbin/mount.cifs"):
            self.assertEqual(shares.cifs_helper(), "/usr/sbin/mount.cifs")

    def test_no_helper_anywhere_returns_none(self):
        with mock.patch("shutil.which", return_value=None), \
             mock.patch.object(pathlib.Path, "exists", lambda self: False):
            self.assertIsNone(shares.cifs_helper())

    def test_an_unsupported_volume_type_is_refused(self):
        ok, message = shares.attach(source(kind="nfs"))
        self.assertFalse(ok)
        self.assertIn("unsupported", message)

    def test_a_missing_device_is_refused(self):
        ok, message = shares.attach(source(device=""))
        self.assertFalse(ok)
        self.assertIn("no device", message)

    def test_a_successful_mount_creates_the_mount_point(self):
        done = subprocess.CompletedProcess([], 0, "", "")
        with mock.patch("subprocess.run", return_value=done), \
             mock.patch.object(shares, "cifs_helper", return_value="/usr/sbin/mount.cifs"), \
             mock.patch.object(shares, "has_content", return_value=(True, "")):
            ok, message = shares.attach(source(root=str(self.root)))
        self.assertTrue(ok, message)
        self.assertTrue(self.root.is_dir())

    def test_a_mount_that_yields_nothing_is_not_a_success(self):
        # ⚠️ The failure this guards. cifs exits 0 for an empty share and for
        # the wrong share; either leaves the root EXISTING, so the source stops
        # reporting stale and starts reporting present-and-empty — a corpus
        # that silently answers nothing instead of saying it is offline.
        done = subprocess.CompletedProcess([], 0, "", "")
        with mock.patch("subprocess.run", return_value=done), \
             mock.patch.object(shares, "cifs_helper", return_value="/usr/sbin/mount.cifs"), \
             mock.patch.object(shares, "detach", return_value=(True, "ok")) as detach:
            ok, message = shares.attach(source(root=str(self.root)))
        self.assertFalse(ok)
        self.assertIn("empty", message)
        # and it must be backed out, or the lie persists until the next restart
        detach.assert_called_once()

    def test_an_unreadable_mount_is_not_a_success_either(self):
        done = subprocess.CompletedProcess([], 0, "", "")
        with mock.patch("subprocess.run", return_value=done), \
             mock.patch.object(shares, "cifs_helper", return_value="/usr/sbin/mount.cifs"), \
             mock.patch.object(shares, "has_content",
                               return_value=(False, "its contents cannot be read")), \
             mock.patch.object(shares, "detach", return_value=(True, "ok")):
            ok, message = shares.attach(source(root=str(self.root)))
        self.assertFalse(ok)
        self.assertIn("cannot be read", message)

    def test_a_failed_mount_reports_the_reason_and_not_the_password(self):
        done = subprocess.CompletedProcess([], 32, "", "mount error(2): no such file")
        with mock.patch("subprocess.run", return_value=done), \
             mock.patch.object(shares, "cifs_helper", return_value="/usr/sbin/mount.cifs"):
            ok, message = shares.attach(source(root=str(self.root)))
        self.assertFalse(ok)
        self.assertIn("mount error(2)", message)
        self.assertNotIn("password", message)

    def test_a_hanging_mount_times_out_rather_than_blocking_the_pass(self):
        with mock.patch("subprocess.run",
                        side_effect=subprocess.TimeoutExpired("mount", 20)), \
             mock.patch.object(shares, "cifs_helper", return_value="/usr/sbin/mount.cifs"):
            ok, message = shares.attach(source(root=str(self.root)))
        self.assertFalse(ok)
        self.assertIn("timed out", message)

    def test_the_options_carry_credentials_and_stay_read_only(self):
        with mock.patch.dict("os.environ", {"SHARE_USER": "smb", "SHARE_PASS": "pw"}):
            opts = shares._options(source().volume)
        self.assertIn("username=smb", opts)
        self.assertIn("password=pw", opts)
        self.assertIn("ro", opts.split(","))

    def test_an_empty_password_is_still_passed(self):
        # Omitting it makes mount.cifs prompt on stdin and hang with no tty.
        with mock.patch.dict("os.environ", {"SHARE_USER": "smb"}, clear=True):
            opts = shares._options(source(password="${SHARE_PASS}").volume)
        self.assertIn("password=", opts)


class ContentCheck(unittest.TestCase):
    """"Did it mount" is not the same question as "did anything arrive"."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_an_empty_directory_has_no_content(self):
        ok, why = shares.has_content(self.root)
        self.assertFalse(ok)
        self.assertIn("empty", why)

    def test_one_entry_is_enough(self):
        # One readdir, not a walk: the ingest pass does the walking, and a
        # 3-second SMB traversal must not run twice per cycle.
        (self.root / "anything").write_text("x", encoding="utf-8")
        ok, why = shares.has_content(self.root)
        self.assertTrue(ok, why)

    def test_a_subdirectory_counts(self):
        (self.root / "sub").mkdir()
        self.assertTrue(shares.has_content(self.root)[0])

    def test_a_permission_error_is_reported_not_raised(self):
        with mock.patch.object(pathlib.Path, "iterdir", side_effect=PermissionError):
            ok, why = shares.has_content(self.root)
        self.assertFalse(ok)
        self.assertIn("account", why)

    def test_an_io_error_is_reported_not_raised(self):
        with mock.patch.object(pathlib.Path, "iterdir", side_effect=OSError("EIO")):
            ok, why = shares.has_content(self.root)
        self.assertFalse(ok)
        self.assertIn("cannot be listed", why)


class Reconciling(unittest.TestCase):
    """The four states, each with exactly one right action."""

    def test_reachable_and_unmounted_gets_attached(self):
        srcs = {"archive": source()}
        with mock.patch.object(shares, "reachable", return_value=True), \
             mock.patch.object(shares, "is_mounted", return_value=False), \
             mock.patch.object(shares, "attach", return_value=(True, "ok")):
            out = shares.reconcile(srcs)
        self.assertEqual(out.attached, ["archive"])
        self.assertFalse(out.failed)

    def test_reachable_and_mounted_is_left_alone(self):
        srcs = {"archive": source()}
        with mock.patch.object(shares, "reachable", return_value=True), \
             mock.patch.object(shares, "is_mounted", return_value=True), \
             mock.patch.object(shares, "attach") as attach:
            out = shares.reconcile(srcs)
        attach.assert_not_called()
        self.assertTrue(out.quiet)

    def test_unreachable_and_mounted_gets_detached(self):
        # Left mounted, every read blocks in the kernel instead of failing.
        srcs = {"archive": source()}
        with mock.patch.object(shares, "reachable", return_value=False), \
             mock.patch.object(shares, "is_mounted", return_value=True), \
             mock.patch.object(shares, "detach", return_value=(True, "ok")):
            out = shares.reconcile(srcs)
        self.assertEqual(out.detached, ["archive"])
        self.assertEqual(out.unreachable, ["archive"])

    def test_unreachable_and_unmounted_is_only_reported(self):
        srcs = {"archive": source()}
        with mock.patch.object(shares, "reachable", return_value=False), \
             mock.patch.object(shares, "is_mounted", return_value=False), \
             mock.patch.object(shares, "detach") as detach:
            out = shares.reconcile(srcs)
        detach.assert_not_called()
        self.assertEqual(out.unreachable, ["archive"])
        self.assertTrue(out.quiet)

    def test_a_local_source_is_ignored_entirely(self):
        with mock.patch.object(shares, "reachable") as probe:
            out = shares.reconcile({"vault": local_source()})
        probe.assert_not_called()
        self.assertTrue(out.quiet)
        self.assertEqual(out.unreachable, [])

    def test_a_failed_mount_does_not_stop_the_other_sources(self):
        srcs = {"a": source(name="a"), "b": source(name="b")}
        with mock.patch.object(shares, "reachable", return_value=True), \
             mock.patch.object(shares, "is_mounted", return_value=False), \
             mock.patch.object(shares, "attach",
                               side_effect=[(False, "boom"), (True, "ok")]):
            out = shares.reconcile(srcs)
        self.assertEqual(out.attached, ["b"])
        self.assertIn("a", out.failed)

    def test_a_volume_table_with_no_device_is_reported_not_ignored(self):
        # Treating it as "not a share" would turn a typo into a source whose
        # root never exists — an empty corpus rather than a visible error.
        broken = type("S", (), {"name": "x", "root": pathlib.Path("/x"),
                                "volume": {}})()
        out = shares.reconcile({"x": broken})
        self.assertIn("x", out.failed)
        self.assertIn("no device", out.failed["x"])
        self.assertFalse(out.quiet)

    def test_reconcile_never_raises_on_a_malformed_source(self):
        # A manifest can declare nonsense; the ingest pass must still run.
        odd = type("S", (), {"name": "y", "root": pathlib.Path("/y"),
                             "volume": {"device": 12345}})()
        try:
            shares.reconcile({"y": odd})
        except Exception as exc:  # noqa: BLE001 - the assertion IS "no raise"
            self.fail(f"reconcile raised {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
