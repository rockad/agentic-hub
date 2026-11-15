import copy
import io
import json
import logging
import pickle

import pytest

from coordination.config import Config, ConfigError
from coordination.logging import (
    REDACTED,
    Credential,
    JsonFormatter,
    configure_logging,
    contains_secret,
    redact,
)

KEY = "a2ak_dev_k1canary_Zq9XvT3mNpL0aBcDeFgHiJkLmNoPqRsTuV-w_x"


@pytest.fixture
def captured():
    """Route the root logger to a StringIO through configure_logging, restore afterwards."""
    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    stream = io.StringIO()
    yield stream, lambda level="info", **kw: configure_logging(level, stream=stream, **kw)
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)


@pytest.mark.parametrize(
    "text",
    [
        f"Authorization: Bearer {KEY}",
        f"authorization: bearer {KEY}",
        f"AUTHORIZATION=Bearer {KEY}",
        f"{{'authorization': 'Bearer {KEY}'}}",
        f'{{"authorization": "Bearer {KEY}"}}',
        f"[(b'host', b'x'), (b'authorization', b'Bearer {KEY}')]",
        f"Headers({{'authorization': 'Bearer {KEY}'}})",
        f"sent {KEY} to the server",
        f"Bearer {KEY}",
        "Authorization: Basic dXNlcjpwYXNzd29yZA==",
        "Authorization: not-even-a-scheme-token-12345",
    ],
)
def test_redact_removes_the_credential(text):
    out = redact(text)
    assert KEY not in out and "Zq9XvT3m" not in out and "dXNlcjpw" not in out
    assert "not-even-a-scheme" not in out
    assert REDACTED in out
    assert contains_secret(text) and not contains_secret(out)


def test_redact_leaves_ordinary_text_alone():
    text = "task t1 moved from SUBMITTED to WORKING for key_id k1 on port 8120"
    assert redact(text) == text and not contains_secret(text)


def test_redact_removes_listed_secrets_but_ignores_short_ones():
    assert "hunter2hunter2" not in redact("pepper=hunter2hunter2", ["hunter2hunter2"])
    assert redact("a b c", ["b"]) == "a b c"
    assert redact("x", [""]) == "x"


def test_credential_hides_itself_everywhere():
    c = Credential(f"Bearer {KEY}")
    for shown in (repr(c), str(c), f"{c}", f"{c!s:>30}", "%s" % c, "%r" % c, repr([c]), repr({"k": c})):
        assert KEY not in shown
    assert c.reveal() == f"Bearer {KEY}"
    assert c.bearer() == KEY
    with pytest.raises(TypeError):
        pickle.dumps(c)
    with pytest.raises(TypeError):
        copy.copy(c)
    with pytest.raises(TypeError):
        copy.deepcopy(c)
    assert not hasattr(c, "__dict__")


@pytest.mark.parametrize(
    "value,expected",
    [("Bearer abc", "abc"), ("bearer abc", "abc"), ("BEARER abc", "abc"), ("Bearer", None),
     ("Bearer ", None), ("Basic abc", None), ("Bearer a b", None), ("abc", None), ("", None)],
)  # fmt: skip
def test_credential_bearer_parsing(value, expected):
    assert Credential(value).bearer() == expected


def test_configure_logging_writes_json_lines_at_the_level(captured):
    stream, configure = captured
    configure("info")
    log = logging.getLogger("coordination.test")
    log.debug("hidden")
    log.info("hello %s", "world", extra={"fields": {"task_id": "t1", "n": 3}})
    lines = stream.getvalue().splitlines()
    assert len(lines) == 1
    row = json.loads(lines[0])
    assert row["msg"] == "hello world" and row["level"] == "info"
    assert row["logger"] == "coordination.test"
    assert row["fields"] == {"task_id": "t1", "n": 3}
    assert row["ts"].endswith("+00:00")


@pytest.mark.parametrize(
    "level,shown",
    [("debug", 4), ("info", 3), ("warning", 2), ("error", 1), ("critical", 0)],
)
def test_log_level_filters(captured, level, shown):
    stream, configure = captured
    configure(level)
    log = logging.getLogger("coordination.test")
    log.debug("d")
    log.info("i")
    log.warning("w")
    log.error("e")
    assert len(stream.getvalue().splitlines()) == shown  # of debug, info, warning, error
    log.critical("c")
    assert len(stream.getvalue().splitlines()) == shown + 1


def test_unknown_level_is_an_error():
    for bad in ("trace", "verbose", "", "warn", "10"):
        with pytest.raises(ValueError):
            configure_logging(bad)


def test_configure_twice_does_not_stack_handlers(captured):
    stream, configure = captured
    configure("info")
    configure("info")
    logging.getLogger("coordination.test").info("once")
    assert len(stream.getvalue().splitlines()) == 1


def test_log_output_never_carries_a_credential(captured):
    stream, configure = captured
    configure("debug", secrets=["pepper-pepper-pepper"])
    log = logging.getLogger("coordination.test")
    log.info("header Authorization: Bearer %s received", KEY)
    log.info("fields", extra={"fields": {"h": f"Authorization: Bearer {KEY}", "p": "pepper-pepper-pepper"}})
    log.info("dict %s", {"authorization": f"Bearer {KEY}"})
    try:
        raise RuntimeError(f"failed with {KEY}")
    except RuntimeError:
        log.exception("boom %s", KEY)
    out = stream.getvalue()
    assert "Zq9XvT3m" not in out and KEY not in out and "pepper-pepper" not in out
    assert out.count("\n") == 4
    for line in out.splitlines():
        json.loads(line)  # still valid JSON after scrubbing


def test_formatter_scrubs_without_the_filter():
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "key %s", (KEY,), None)
    assert KEY not in JsonFormatter().format(record)


def test_exotic_field_values_are_repr_then_scrubbed():
    class Odd:
        def __repr__(self):
            return f"Odd({KEY})"

    record = logging.LogRecord("x", logging.INFO, __file__, 1, "m", None, None)
    record.fields = {"odd": Odd(), "t": (1, KEY)}
    out = JsonFormatter().format(record)
    assert KEY not in out and json.loads(out)["fields"]["t"][0] == 1


# A2A_LOG_LEVEL in config -------------------------------------------------------------------


def test_config_log_level_default_and_normalisation():
    assert Config.from_env({}).log_level == "info"
    assert Config.from_env({"A2A_LOG_LEVEL": "DEBUG"}).log_level == "debug"
    assert Config.from_env({"A2A_LOG_LEVEL": " Warning "}).log_level == "warning"


@pytest.mark.parametrize("bad", ["trace", "verbose", "", "10", "warn"])
def test_config_rejects_an_unknown_log_level(bad):
    with pytest.raises(ConfigError, match="A2A_LOG_LEVEL"):
        Config.from_env({"A2A_LOG_LEVEL": bad})
