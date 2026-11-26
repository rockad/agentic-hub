#!/usr/bin/env python3
"""Unit tests for scripts/build-agy-release-marketplace.py."""

from __future__ import annotations

import hashlib
import json
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "build-agy-release-marketplace.py"


class TestBuildAgyReleaseMarketplace(unittest.TestCase):
    def test_packages_all_plugins_deterministically_with_valid_schema(self) -> None:
        with tempfile.TemporaryDirectory(prefix="agy-release-test-") as tmp:
            out_a = Path(tmp) / "run-a"
            out_b = Path(tmp) / "run-b"
            tag = "agy-marketplace-v2026.11.26"

            for out in (out_a, out_b):
                proc = subprocess.run(
                    [
                        sys.executable,
                        str(SCRIPT),
                        "--repo-root",
                        str(REPO_ROOT),
                        "--out-dir",
                        str(out),
                        "--tag",
                        tag,
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertIn("Packaged", proc.stdout)

            mp_a = json.loads((out_a / "marketplace.json").read_text(encoding="utf-8"))
            mp_b = json.loads((out_b / "marketplace.json").read_text(encoding="utf-8"))
            root_mp = json.loads((REPO_ROOT / "marketplace.json").read_text(encoding="utf-8"))

            self.assertEqual(len(mp_a["plugins"]), len(root_mp["plugins"]))
            self.assertEqual(
                [p["source"]["sha256"] for p in mp_a["plugins"]],
                [p["source"]["sha256"] for p in mp_b["plugins"]],
                "Repeated builds must produce identical SHA-256 digests",
            )

            for plugin in mp_a["plugins"]:
                name = plugin["name"]
                version = plugin["version"]
                url = plugin["source"]["url"]
                sha = plugin["source"]["sha256"]

                self.assertTrue(url.startswith("https://github.com/rockad/agentic-hub/releases/download/"))
                self.assertTrue(url.endswith(f"/{tag}/{name}-{version}.zip"))
                self.assertEqual(len(sha), 64)

                zip_path = out_a / f"{name}-{version}.zip"
                self.assertTrue(zip_path.is_file(), f"Missing archive {zip_path}")
                actual_sha = hashlib.sha256(zip_path.read_bytes()).hexdigest()
                self.assertEqual(sha, actual_sha)

                with zipfile.ZipFile(zip_path) as zf:
                    names = zf.namelist()
                    self.assertIn(f"{name}/plugin.json", names)
                    for member in names:
                        self.assertNotIn("/node_modules/", f"/{member}")
                        self.assertNotIn("/.venv/", f"/{member}")
                        self.assertNotIn("/__pycache__/", f"/{member}")

            # Verify POSIX executable bit is preserved on coordination/bin/a2a-doctor
            coord_entry = next(p for p in mp_a["plugins"] if p["name"] == "coordination")
            coord_zip = out_a / f"coordination-{coord_entry['version']}.zip"
            with zipfile.ZipFile(coord_zip) as zf:
                doctor_info = zf.getinfo("coordination/bin/a2a-doctor")
                mode = (doctor_info.external_attr >> 16) & 0o777
                self.assertTrue(mode & stat.S_IXUSR, f"a2a-doctor lost executable bit: {oct(mode)}")

            # If agy CLI is available locally, validate clean plugins in strict mode
            if shutil.which("agy"):
                for clean_name in ("jev", "clarify", "subagents"):
                    entry = next(p for p in mp_a["plugins"] if p["name"] == clean_name)
                    zip_path = out_a / f"{clean_name}-{entry['version']}.zip"
                    val = subprocess.run(
                        ["agy", "plugin", "validate", "--strict", str(zip_path)],
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(
                        val.returncode,
                        0,
                        f"agy plugin validate --strict failed on {zip_path.name}:\n{val.stdout}\n{val.stderr}",
                    )


if __name__ == "__main__":
    unittest.main()
