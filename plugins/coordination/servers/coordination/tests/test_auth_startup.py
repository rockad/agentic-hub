"""S1-AUTH: the start-up checks of spec 1.6, as one function with a one-line non-zero exit."""

import subprocess
import sys

import pytest
from conftest import PLUGIN_DIR

from coordination.auth.startup import cards_file_problem, public_hostname, startup_check
from coordination.config import Config
from coordination.store.connect import check_database

TAILNET_NAME = "box.tail1234.ts.net"
PUBLIC_NAME = "a2a.example.org"


@pytest.fixture
def cards(tmp_path):
    path = tmp_path / "cards.yaml"
    path.write_text("cards: []\n")
    return path


def env_for(cards, stage="s1", **extra):
    """A valid environment for `stage`, with `extra` laid over it (None removes a variable)."""
    env = {"A2A_CARDS_FILE": str(cards), "A2A_EXPOSURE_STAGE": stage}
    if stage in ("s2", "s3"):
        public = TAILNET_NAME if stage == "s2" else PUBLIC_NAME
        env.update(
            {
                "A2A_PUBLIC_URL": f"https://{public}",
                "A2A_TRUSTED_PROXY_IPS": "172.18.0.1",
                "A2A_ALLOWED_HOSTS": f"127.0.0.1:8120,127.0.0.1:8121,{public}",
            }
        )
    env.update(extra)
    return {k: v for k, v in env.items() if v is not None}


def never_db(config):
    raise AssertionError("the database was checked although a configuration condition failed")


class Recorder:
    def __init__(self):
        self.configs = []

    def __call__(self, config):
        self.configs.append(config)


def refused(env, **kwargs):
    """Run the check against `env`; return the exit message. The database must not be reached."""
    with pytest.raises(SystemExit) as exc:
        startup_check(env, check_db=never_db, **kwargs)
    message = exc.value.code
    assert isinstance(message, str) and message  # a string code: Python exits with status 1
    assert message.startswith("coordination: ")
    assert "\n" not in message and "\r" not in message  # one line
    return message


# the ten conditions of spec 1.6 -------------------------------------------------------------------


@pytest.mark.parametrize("stage", ["s2", "s3"])
def test_condition_public_url_must_be_https_at_s2_and_s3(cards, stage):
    assert "https://" in refused(env_for(cards, stage, A2A_PUBLIC_URL="http://box.example:8120"))


@pytest.mark.parametrize("stage", ["s2", "s3"])
def test_condition_trusted_proxies_must_not_be_empty_at_s2_and_s3(cards, stage):
    assert "A2A_TRUSTED_PROXY_IPS" in refused(env_for(cards, stage, A2A_TRUSTED_PROXY_IPS=None))
    assert "A2A_TRUSTED_PROXY_IPS" in refused(env_for(cards, stage, A2A_TRUSTED_PROXY_IPS=""))


@pytest.mark.parametrize("stage", ["s2", "s3"])
def test_condition_public_listener_must_be_enabled_at_s2_and_s3(cards, stage):
    assert "A2A_PUBLIC_LISTEN" in refused(env_for(cards, stage, A2A_PUBLIC_LISTEN=""))


def test_condition_public_listener_must_not_be_enabled_at_s1(cards):
    assert "A2A_PUBLIC_LISTEN" in refused(env_for(cards, "s1", A2A_PUBLIC_LISTEN="127.0.0.1:8121"))


def test_condition_public_hostname_is_refused_in_allowed_hosts_before_s3(cards):
    env = env_for(cards, "s2", A2A_PUBLIC_URL=f"https://{PUBLIC_NAME}", A2A_ALLOWED_HOSTS=f"127.0.0.1:8120,127.0.0.1:8121,{PUBLIC_NAME}")
    assert "public hostname" in refused(env)
    # with a port on the entry as well
    env["A2A_ALLOWED_HOSTS"] = f"127.0.0.1:8120,{PUBLIC_NAME}:443"
    assert "public hostname" in refused(env)


@pytest.mark.parametrize("value", ["prod", "Dev", "", "development"])
def test_condition_env_must_be_dev_or_live(cards, value):
    assert "A2A_ENV" in refused(env_for(cards, "s1", A2A_ENV=value))


@pytest.mark.parametrize("stage", ["s2", "s3"])
def test_condition_tailnet_enforcement_must_be_on_at_s2_and_s3(cards, stage):
    assert "TAILNET" in refused(env_for(cards, stage, A2A_ENFORCE_TAILNET_IDENTITY="0"))


def test_condition_push_needs_its_encryption_key(cards):
    assert "A2A_PUSH_ENC_KEY" in refused(env_for(cards, "s1", A2A_PUSH_ENABLED="1"))
    assert "A2A_PUSH_ENC_KEY" in refused(env_for(cards, "s1", A2A_PUSH_ENABLED="1", A2A_PUSH_ENC_KEY=""))


def test_condition_cards_file_missing(cards, tmp_path):
    assert "cannot be read" in refused(env_for(cards, "s1", A2A_CARDS_FILE=str(tmp_path / "nope.yaml")))


@pytest.mark.parametrize(
    "text, fragment",
    [
        ("cards: [\n", "not valid YAML"),
        ("- just\n- a list\n", "mapping with a `cards` list"),
        ("cards: not-a-list\n", "mapping with a `cards` list"),
        ("other: []\n", "mapping with a `cards` list"),
        ("cards:\n  - just-a-string\n", "not a mapping"),
        ("cards:\n  - description: no id\n", "no valid card id"),
        ("cards:\n  - name: NoAtSign\n", "no valid card id"),
        ("cards:\n  - name: Claude@box\n", "no valid card id"),
        ("cards:\n  - name: claude-code@\n", "no valid card id"),
        ("cards:\n  - name: " + "a" * 33 + "@box\n", "no valid card id"),
        ("cards:\n  - name: -x@box\n", "no valid card id"),
        ("cards:\n  - name: 12\n", "no valid card id"),
    ],
)
def test_condition_cards_file_invalid(tmp_path, text, fragment):
    path = tmp_path / "cards.yaml"
    path.write_text(text)
    message = refused(env_for(path, "s1"))
    assert fragment in message and str(path) in message
    assert cards_file_problem(str(path)) is not None


def test_cards_file_that_is_not_utf8_is_refused(tmp_path):
    path = tmp_path / "cards.yaml"
    path.write_bytes(b"cards: [\xff\xfe]\n")
    assert "UTF-8" in refused(env_for(path, "s1"))


def test_condition_more_than_one_worker(cards):
    assert "2 workers" in refused(env_for(cards, "s1"), workers=2)


def test_the_tenth_condition_a_schema_newer_than_the_code_is_in_the_database_check(pg_db, pg_server, cards):
    """Not duplicated here: `check_database` owns it, and `startup_check` calls it."""
    config = pg_db()
    check_database(config)  # migrates to head
    db = config.db_url.rsplit("/", 1)[1]
    pg_server.psql(db, "UPDATE coord_schema_version SET version = 999")
    env = env_for(cards, "s1", A2A_DB_URL=config.db_url, A2A_DB_PASSWORD_FILE=config.db_password_file)
    with pytest.raises(SystemExit) as exc:
        startup_check(env)
    message = exc.value.code
    assert message.startswith("coordination: ") and "newer" in message and "\n" not in message


def test_the_database_error_is_one_line_too(cards, tmp_path):
    env = env_for(cards, "s1", A2A_DB_PASSWORD_FILE=str(tmp_path / "missing"))
    with pytest.raises(SystemExit) as exc:
        startup_check(env)
    assert exc.value.code.startswith("coordination: ") and "\n" not in exc.value.code


# the control: a valid configuration passes, and then the database is checked ---------------------------


@pytest.mark.parametrize("stage", ["s1", "s2", "s3"])
def test_a_valid_configuration_passes_and_reaches_the_database_check(cards, stage):
    recorder = Recorder()
    config = startup_check(env_for(cards, stage), check_db=recorder)
    assert isinstance(config, Config) and config.exposure_stage == stage
    assert recorder.configs == [config]


def test_the_public_hostname_is_allowed_in_allowed_hosts_at_s3(cards):
    startup_check(env_for(cards, "s3"), check_db=Recorder())  # PUBLIC_NAME is in A2A_ALLOWED_HOSTS


def test_the_tailnet_name_is_not_the_public_hostname_at_s2(cards):
    startup_check(env_for(cards, "s2"), check_db=Recorder())  # TAILNET_NAME is in A2A_ALLOWED_HOSTS


def test_custom_port_passes_s1_startup_and_keeps_pre_s3_public_hostname_check(cards):
    config = startup_check(env_for(cards, "s1", A2A_PORT="8129"), check_db=Recorder())
    assert config.allowed_hosts == ("127.0.0.1:8129", "localhost:8129")
    assert config.public_url == "http://127.0.0.1:8129"
    # Pre-s3 public hostname refusal still holds when a non-loopback public host is listed alongside a custom port
    bad = env_for(cards, "s2", A2A_PORT="8129", A2A_PUBLIC_URL=f"https://{PUBLIC_NAME}", A2A_ALLOWED_HOSTS=f"127.0.0.1:8129,{PUBLIC_NAME}")
    msg = refused(bad)
    assert "not allowed at" in msg or "public hostname" in msg


def test_a_card_with_a_valid_id_passes(tmp_path):
    path = tmp_path / "cards.yaml"
    path.write_text("cards:\n  - name: claude-code@box\n    description: x\n  - name: antigravity@mac\n")
    startup_check(env_for(path, "s1"), check_db=Recorder())


@pytest.mark.skipif(not (PLUGIN_DIR / "config/cards.yaml").is_file(), reason="the config is outside the build context")
def test_the_shipped_cards_file_passes():
    shipped = PLUGIN_DIR / "config" / "cards.yaml"
    assert cards_file_problem(str(shipped)) is None


def test_public_hostname_helper():
    assert public_hostname("https://a2a.example.org") == "a2a.example.org"
    assert public_hostname("https://a2a.example.org:8443/x") == "a2a.example.org"
    assert public_hostname(f"https://{TAILNET_NAME}") is None
    assert public_hostname("http://127.0.0.1:8120") is None
    assert public_hostname("http://localhost:8120") is None
    assert public_hostname("http://[::1]:8120") is None
    assert public_hostname("") is None


# the public listener switch ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "stage, listen, expected",
    [("s1", None, False), ("s2", None, True), ("s3", None, True), ("s1", "0.0.0.0:8121", True), ("s2", "", False), ("s2", "  ", False)],
)
def test_public_listener_enabled_follows_the_stage_unless_set(stage, listen, expected):
    env = {"A2A_EXPOSURE_STAGE": stage}
    if listen is not None:
        env["A2A_PUBLIC_LISTEN"] = listen
    assert Config.from_env(env).public_listener_enabled is expected


# the real process ------------------------------------------------------------------------------------


def test_the_process_exits_1_with_one_line_on_stderr(cards, tmp_path):
    env = {"PATH": "/usr/bin:/bin", "A2A_CARDS_FILE": str(cards), "A2A_ENV": "prod"}
    proc = subprocess.run([sys.executable, "-m", "coordination"], env=env, capture_output=True, text=True, timeout=60)
    assert proc.returncode == 1
    lines = proc.stderr.strip().splitlines()
    assert len(lines) == 1 and lines[0].startswith("coordination: ") and "A2A_ENV" in lines[0]
    assert proc.stdout == ""
