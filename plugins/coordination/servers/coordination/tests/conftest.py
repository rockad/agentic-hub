"""Shared fixtures: a throwaway Postgres container, the image `docker-compose.yml` pins.

The store tests run against a real Postgres (S1-STORE: the only engine S1 supports). Each test
gets its own database inside one session-wide container. The password is random per run, lives in
a mode-0600 file under pytest's temp directory (outside the repo) and is handed to the container as
`POSTGRES_PASSWORD_FILE`, as in the compose project.

No Docker, or no pinned image and no network to pull it: the Postgres tests skip, with the reason
in the summary. `A2A_TEST_REQUIRE_DOCKER=1` turns that skip into a failure, so a CI run cannot
pass by silently skipping. The image build runs this suite without a Docker daemon and relies on
the skip.
"""

from __future__ import annotations

import asyncio
import dataclasses
import os
import secrets
import shutil
import socket
import subprocess
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
import yaml

from coordination.config import Config

PLUGIN_DIR = Path(__file__).resolve().parents[3]
COMPOSE_FILE = PLUGIN_DIR / "docker-compose.yml"
PG_USER = "coordination"  # the role compose's POSTGRES_USER creates; a superuser in the container


def pinned_postgres_image() -> str:
    with COMPOSE_FILE.open() as fh:
        return yaml.safe_load(fh)["services"]["postgres"]["image"]


def _docker(*args: str, check: bool = True, timeout: float = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check, timeout=timeout)


def _unavailable(reason: str) -> None:
    if os.environ.get("A2A_TEST_REQUIRE_DOCKER") == "1":
        pytest.fail(f"A2A_TEST_REQUIRE_DOCKER=1 but {reason}", pytrace=False)
    pytest.skip(reason)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class PgServer:
    """A running throwaway Postgres container."""

    name: str
    port: int
    password_file: Path
    password: str  # the throwaway value; never printed, never written into the repo

    host: str = "127.0.0.1"

    def config(self, database: str, **overrides: object) -> Config:
        values: dict[str, object] = {
            "db_url": f"postgresql+asyncpg://{PG_USER}@{self.host}:{self.port}/{database}",
            "db_password_file": str(self.password_file),
        }
        values.update(overrides)
        return dataclasses.replace(Config.from_env({}), **values)

    def psql(self, database: str, sql: str) -> str:
        """Run SQL as the superuser inside the container over stdin (no password in argv)."""
        # `-e PGPASSWORD` with no value: docker takes it from this process's environment, so the
        # value is never in an argv.
        proc = subprocess.run(
            ["docker", "exec", "-i", "-e", "PGPASSWORD", self.name, "psql", "-h", "127.0.0.1", "-U", PG_USER,
             "-d", database, "-v", "ON_ERROR_STOP=1", "-tA"],
            input=sql, capture_output=True, text=True, check=False, env={**os.environ, "PGPASSWORD": self.password},
        )
        if proc.returncode != 0:
            raise RuntimeError(f"psql failed: {proc.stderr.strip()[:300]}")
        return proc.stdout.strip()

    def restart(self, timeout_s: float = 60) -> None:
        _docker("restart", "-t", "2", self.name)
        self.wait_ready(timeout_s)

    def crash(self) -> None:
        """SIGKILL the Postgres server process (a crash, not a clean stop)."""
        _docker("kill", "-s", "KILL", self.name)

    def start_again(self, timeout_s: float = 60) -> None:
        """Start the crashed container again; the published port is fixed, so it stays the same."""
        _docker("start", self.name)
        self.wait_ready(timeout_s)

    def wait_ready(self, timeout_s: float = 60) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            r = _docker("exec", self.name, "pg_isready", "-h", "127.0.0.1", "-U", PG_USER, "-d", "postgres", check=False)
            if r.returncode == 0:
                # pg_isready answers on the temporary init server too; wait for a real login.
                try:
                    self.psql("postgres", "SELECT 1")
                    return
                except RuntimeError:
                    pass
            time.sleep(0.5)
        raise RuntimeError("the test Postgres did not become ready")

    def stop(self) -> None:
        _docker("rm", "-f", self.name, check=False)

    def create_database(self, name: str | None = None) -> str:
        name = name or f"t_{uuid.uuid4().hex[:12]}"
        self.psql("postgres", f'CREATE DATABASE "{name}"')
        return name

    def drop_database(self, name: str) -> None:
        try:
            self.psql("postgres", f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        except RuntimeError:
            pass


def start_postgres(workdir: Path) -> PgServer:
    if shutil.which("docker") is None:
        _unavailable("docker is not installed")
    if _docker("info", check=False, timeout=30).returncode != 0:
        _unavailable("the docker daemon is not reachable")
    image = pinned_postgres_image()
    if _docker("image", "inspect", image, check=False).returncode != 0:
        pulled = _docker("pull", "-q", image, check=False, timeout=600)
        if pulled.returncode != 0:
            _unavailable(f"the pinned image {image} is not present and cannot be pulled")
    password = secrets.token_urlsafe(24)
    workdir.mkdir(parents=True, exist_ok=True)
    password_file = workdir / "pg_password"
    password_file.write_text(password + "\n")
    password_file.chmod(0o600)
    port = free_port()
    name = f"a2a-store-test-{uuid.uuid4().hex[:8]}"
    _docker(
        "run", "-d", "--name", name,
        "-e", f"POSTGRES_USER={PG_USER}", "-e", "POSTGRES_DB=postgres",
        "-e", "POSTGRES_PASSWORD_FILE=/run/secrets/pw",
        "-e", "POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256",
        "-v", f"{password_file}:/run/secrets/pw:ro",
        "-p", f"127.0.0.1:{port}:5432",
        image,
    )
    server = PgServer(name=name, port=port, password_file=password_file, password=password)
    try:
        server.wait_ready()
    except Exception:
        server.stop()
        raise
    return server


@pytest.fixture(scope="session")
def pg_server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[PgServer]:
    server = start_postgres(tmp_path_factory.mktemp("pg"))
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def pg_db(pg_server: PgServer) -> Iterator[Callable[..., Config]]:
    """Factory: `pg_db()` makes a fresh empty database and returns a Config for it."""
    made: list[str] = []

    def make(**overrides: object) -> Config:
        name = pg_server.create_database()
        made.append(name)
        return pg_server.config(name, **overrides)

    try:
        yield make
    finally:
        for name in made:
            pg_server.drop_database(name)


@pytest.fixture
def config(pg_db: Callable[..., Config]) -> Config:
    return pg_db()


def run(coro):
    """Run a coroutine to completion (the suite has no pytest-asyncio; asyncpg binds to a loop)."""
    return asyncio.run(coro)
