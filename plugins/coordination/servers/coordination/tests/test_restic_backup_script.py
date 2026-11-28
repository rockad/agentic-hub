from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents  # tests, servers/coordination, servers, plugin root
SCRIPT = (_ROOT[2] if len(_ROOT) > 2 else Path("/nonexistent")) / "backup" / "a2a-restic-backup.sh"
pytestmark = [
    pytest.mark.hooks,
    pytest.mark.skipif(not SCRIPT.is_file(), reason="a2a-restic-backup.sh is outside the build context"),
]

@pytest.fixture
def restic_env(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    repo_dir = tmp_path / "repo"
    dump_dir = tmp_path / "dumps"
    dump_dir.mkdir()
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    
    password_file = config_dir / "restic-password"
    password_file.write_text("secretpassword\n")
    password_file.chmod(0o600)
    
    # Create a fake restic stub
    stub_log = tmp_path / "restic.log"
    restic_stub = bin_dir / "restic"
    restic_stub.write_text(f"""#!/bin/sh
echo "RESTIC_ARGS: $@" >> "{stub_log}"
# Check that RESTIC_PASSWORD_FILE is set and exists
if [ -z "${{RESTIC_PASSWORD_FILE:-}}" ] || [ ! -f "$RESTIC_PASSWORD_FILE" ]; then
    echo "ERROR: password file not set or missing" >&2
    exit 1
fi
# Ensure secret is never printed by restic stub
exit 0
""")
    restic_stub.chmod(0o755)
    
    return bin_dir, repo_dir, dump_dir, password_file


def run_script(
    script_path: Path,
    repo: str,
    password_file: Path,
    dump_dir: Path,
    bin_dir: Path,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["A2A_RESTIC_REPO"] = repo
    env["A2A_RESTIC_PASSWORD_FILE"] = str(password_file)
    env["A2A_DUMP_DIR"] = str(dump_dir)
    return subprocess.run(
        ["sh", str(script_path)],
        env=env,
        capture_output=True,
        text=True,
    )


def test_restic_script_is_executable_and_shellcheck_clean():
    assert SCRIPT.stat().st_mode & stat.S_IXUSR, "a2a-restic-backup.sh must be executable"
    if shutil.which("shellcheck"):
        subprocess.run(["shellcheck", "-s", "sh", str(SCRIPT)], check=True)


def test_restic_script_missing_repo(restic_env):
    bin_dir, repo_dir, dump_dir, password_file = restic_env

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["A2A_RESTIC_PASSWORD_FILE"] = str(password_file)
    env["A2A_DUMP_DIR"] = str(dump_dir)
    # A2A_RESTIC_REPO unset
    if "A2A_RESTIC_REPO" in env:
        del env["A2A_RESTIC_REPO"]

    res = subprocess.run(["sh", str(SCRIPT)], env=env, capture_output=True, text=True)
    assert res.returncode != 0
    assert "A2A_RESTIC_REPO is required" in res.stderr


def test_restic_script_missing_password_file(restic_env):
    bin_dir, repo_dir, dump_dir, password_file = restic_env

    missing_pw = password_file.parent / "nonexistent"
    res = run_script(SCRIPT, str(repo_dir), missing_pw, dump_dir, bin_dir)
    assert res.returncode != 0
    assert "missing or not a file" in res.stderr


def test_restic_script_wide_permissions(restic_env):
    bin_dir, repo_dir, dump_dir, password_file = restic_env

    password_file.chmod(0o644)
    res = run_script(SCRIPT, str(repo_dir), password_file, dump_dir, bin_dir)
    assert res.returncode != 0
    assert "permissions" in res.stderr and "too wide" in res.stderr


def test_restic_script_empty_dump_dir_and_zero_byte_dump(restic_env):
    bin_dir, repo_dir, dump_dir, password_file = restic_env

    # dump_dir has no .dump files
    res = run_script(SCRIPT, str(repo_dir), password_file, dump_dir, bin_dir)
    assert res.returncode != 0
    assert "has no .dump files" in res.stderr

    # 0-byte .dump file is also rejected
    (dump_dir / "empty.dump").write_bytes(b"")
    res_zero = run_script(SCRIPT, str(repo_dir), password_file, dump_dir, bin_dir)
    assert res_zero.returncode != 0
    assert "has no .dump files" in res_zero.stderr


def test_restic_script_invalid_keep_last_and_missing_home(restic_env):
    bin_dir, repo_dir, dump_dir, password_file = restic_env
    (dump_dir / "a2a-20261127T020000Z.dump").write_text("fake dump content")

    bad_keep_env = os.environ.copy()
    bad_keep_env["PATH"] = f"{bin_dir}:{bad_keep_env['PATH']}"
    bad_keep_env["A2A_RESTIC_REPO"] = str(repo_dir)
    bad_keep_env["A2A_RESTIC_PASSWORD_FILE"] = str(password_file)
    bad_keep_env["A2A_DUMP_DIR"] = str(dump_dir)
    bad_keep_env["A2A_RESTIC_KEEP_LAST"] = "0"
    res = subprocess.run(["sh", str(SCRIPT)], env=bad_keep_env, capture_output=True, text=True)
    assert res.returncode != 0
    assert "A2A_RESTIC_KEEP_LAST must be a positive integer" in res.stderr

    no_home_env = {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "A2A_RESTIC_REPO": str(repo_dir),
    }
    res_no_home = subprocess.run(["sh", str(SCRIPT)], env=no_home_env, capture_output=True, text=True)
    assert res_no_home.returncode != 0
    assert "ERROR: password file" in res_no_home.stderr


def test_restic_script_happy_path(restic_env):
    bin_dir, repo_dir, dump_dir, password_file = restic_env

    # Create a valid .dump file
    (dump_dir / "a2a-20261127T020000Z.dump").write_text("fake dump content")

    res = run_script(SCRIPT, str(repo_dir), password_file, dump_dir, bin_dir)
    assert res.returncode == 0, res.stderr

    stub_log = bin_dir.parent / "restic.log"
    log_content = stub_log.read_text()

    assert f"backup --tag a2a-dumps -- {dump_dir}" in log_content
    assert "forget --keep-last 3 --prune --tag a2a-dumps" in log_content

    # Verify secret password is never echoed
    assert "secretpassword" not in log_content
    assert "secretpassword" not in res.stdout
    assert "secretpassword" not in res.stderr
