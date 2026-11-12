"""Checks over docker-compose.yml (S1-PG). The file lives in the plugin root, outside the Docker
build context, so these tests skip inside the image build and run on the dev box.

`test_running_image_matches` also needs a running stack: set A2A_INSPECT_PROJECT to the compose
project name (the acceptance run does) and it compares `docker inspect` with the pin.
"""

import json
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents  # tests, servers/coordination, servers, plugin root
COMPOSE = (_ROOT[3] if len(_ROOT) > 3 else Path("/nonexistent")) / "docker-compose.yml"
PINNED = "postgres:17.11-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac"

pytestmark = pytest.mark.skipif(not COMPOSE.is_file(), reason="compose file is outside the build context")


@pytest.fixture(scope="module")
def compose():
    return yaml.safe_load(COMPOSE.read_text())


def test_postgres_image_is_the_recorded_exact_tag_and_digest(compose):
    image = compose["services"]["postgres"]["image"]
    assert image == PINNED
    assert re.fullmatch(r"postgres:\d+\.\d+(\.\d+)?-alpine@sha256:[0-9a-f]{64}", image)
    assert ":latest" not in image and not re.search(r"postgres:\d+(-alpine)?(@|$)", image)


def test_no_published_port_for_postgres(compose):
    pg = compose["services"]["postgres"]
    assert "ports" not in pg and "network_mode" not in pg
    # the only published port in the file is the server's, on host loopback
    published = [p for s in compose["services"].values() for p in s.get("ports", [])]
    assert all(p.startswith("127.0.0.1:") for p in published)


def test_password_comes_from_secret_files_outside_the_repo(compose):
    for name, secret in compose["secrets"].items():
        assert set(secret) == {"file"}, name
        path = secret["file"]
        assert path.startswith("${A2A_SECRETS_DIR:-${HOME}/.config/a2a-coord/secrets}/")
        assert not path.startswith((".", "./", "secrets/"))
    assert set(compose["secrets"]) == {"a2a_db_password"}  # pg_dump_password is S1-BKP's, sidecar only
    for svc in ("postgres", "coordination"):
        assert compose["services"][svc]["secrets"] == ["a2a_db_password"]


def test_no_password_in_environment_and_no_trust(compose):
    pg_env = compose["services"]["postgres"]["environment"]
    srv_env = compose["services"]["coordination"]["environment"]
    assert pg_env["POSTGRES_PASSWORD_FILE"] == "/run/secrets/a2a_db_password"
    assert srv_env["A2A_DB_PASSWORD_FILE"] == "/run/secrets/a2a_db_password"
    for env in (pg_env, srv_env):
        for key in env:
            assert not (re.search(r"PASSWORD|SECRET|PASS$", key) and not key.endswith("_FILE")), key
    assert "POSTGRES_HOST_AUTH_METHOD" not in pg_env
    args = pg_env["POSTGRES_INITDB_ARGS"]
    assert "--auth-local=scram-sha-256" in args and "--auth-host=scram-sha-256" in args
    assert "trust" not in json.dumps(pg_env)
    assert not re.search(r"://[^@/\s]*:[^@/\s]*@", srv_env["A2A_DB_URL"]), "A2A_DB_URL must carry no password"


def test_server_waits_for_a_healthy_database(compose):
    assert compose["services"]["coordination"]["depends_on"]["postgres"] == {"condition": "service_healthy"}
    hc = compose["services"]["postgres"]["healthcheck"]
    assert "pg_isready" in hc["test"][1] and "-U coordination" in hc["test"][1] and "-d coordination" in hc["test"][1]


def test_data_is_on_a_named_volume(compose):
    assert compose["services"]["postgres"]["volumes"] == ["a2a-pgdata:/var/lib/postgresql/data"]
    assert "a2a-pgdata" in compose["volumes"]


def test_dump_secret_is_not_wired_into_postgres_or_the_server(compose):
    for svc in ("postgres", "coordination"):
        body = json.dumps(compose["services"][svc])
        assert "pg_dump_password" not in body and "dump_ro" not in body


def test_server_wiring(compose):
    srv = compose["services"]["coordination"]
    assert srv["environment"]["A2A_DB_URL"].startswith("${A2A_DB_URL:-postgresql+asyncpg://coordination@postgres:5432/")
    assert srv["read_only"] is True and srv["cap_drop"] == ["ALL"]


@pytest.mark.skipif(not os.environ.get("A2A_INSPECT_PROJECT"), reason="needs a running stack")
def test_running_image_matches():
    project = os.environ["A2A_INSPECT_PROJECT"]
    ids = subprocess.run(
        ["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}",
         "--filter", "label=com.docker.compose.service=postgres"],
        capture_output=True, text=True, check=True,
    ).stdout.split()  # fmt: skip
    assert len(ids) == 1
    info = json.loads(subprocess.run(["docker", "inspect", ids[0]], capture_output=True, text=True, check=True).stdout)[0]
    assert info["Config"]["Image"] == PINNED
    image = json.loads(subprocess.run(["docker", "image", "inspect", info["Image"]], capture_output=True, text=True, check=True).stdout)[0]
    assert PINNED.split("@")[1] in image["RepoDigests"][0] or PINNED.split("@")[1] in json.dumps(image["RepoDigests"])
    assert "latest" not in info["Config"]["Image"]
    assert not info["NetworkSettings"]["Ports"] or all(v is None for v in info["NetworkSettings"]["Ports"].values())
