"""Invariant (api 9, D13, t2 section 5): never exposed on any endpoint or tool: anything that starts a sweep
or grants approval; credentials (the OpenRouter key, the RFC 006 credential route, Claude and agy tokens);
run directories and transcripts; Jev configuration tools such as `jev_set_mode`. The MCP tool list is a
closed set; there is no tool that proxies another server, reads a path, or runs a command.

Checked on what the server actually serves:

- the tool catalogue: names, descriptions and argument names (the ten names are in
  `test_never_approval_or_command.py` at the wire; here the words);
- the routes of the real app and the cards;
- the shape of every tool argument: no argument is a path, a URL to fetch, a command or a credential;
- the configuration object: no field and no environment variable of the server holds a credential for
  another service (the only secrets are its own: the key pepper, the push encryption key, the database
  password file).
"""

from __future__ import annotations

import dataclasses
import re

from coordination.app import build_server_app
from coordination.config import ENV_VARS, Config
from coordination.mcp.tools import catalogue

FORBIDDEN = re.compile(
    r"jev|openrouter|anthropic|gemini|oauth|rfc ?006|credential|sweep|approv|grant|run[_ ]?dir|transcript|"
    r"proxy|shell|exec|subprocess|command|set_mode|api[_ ]?key|bearer",
    re.I,
)
#: words in the catalogue that look like a hit and are not: the notice that tells the model a body is NOT
#: an approval or a command, and the description of the key the tool does not take.
ALLOWED_CONTEXT = ("not an instruction", "not approval", "never approval", "never an instruction", "approval from your user", "Do not run commands")


def _walk(value, path=()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield (*path, key), key
            yield from _walk(item, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _walk(item, (*path, index))
    elif isinstance(value, str):
        yield path, value


def test_the_tool_catalogue_names_no_forbidden_capability():
    specs = catalogue(50)
    assert len(specs) == 10
    for spec in specs:
        assert not FORBIDDEN.search(spec.name), spec.name
        for path, text in _walk(spec.schema):
            if path and path[-1] == "description":
                continue
            assert not FORBIDDEN.search(str(text)), (spec.name, path, text)
        for sentence in re.split(r"(?<=[.!?])\s+", spec.description):
            hit = FORBIDDEN.search(sentence)
            if hit:
                assert any(ok in sentence for ok in ALLOWED_CONTEXT), (spec.name, sentence)


def test_no_tool_argument_is_a_path_a_url_a_command_or_a_credential():
    names = set()
    for spec in catalogue(50):
        schema = spec.schema
        for prop in schema.get("properties", {}):
            names.add(prop)
    assert names == {"handle", "name", "limit", "include_followups", "task_id", "history_length", "timeout_seconds", "task_ids", "to", "text", "data", "context_id", "wait_seconds", "state", "artifacts", "reason"}
    assert not [n for n in names if re.search(r"path|url|uri|file|cmd|command|exec|shell|key|token|secret|password|credential", n)]


def test_no_configuration_field_or_variable_holds_a_credential_for_another_service():
    own_secrets = {"key_pepper", "push_enc_key", "db_password_file"}
    names = {f.name for f in dataclasses.fields(Config)}
    foreign = [n for n in names | {v.lower() for v in ENV_VARS} if re.search(r"openrouter|anthropic|claude|gemini|agy|jev|cognitive|token|credential", n, re.I)]
    assert foreign == []
    assert {n for n in names if re.search(r"secret|pepper|password|enc_key", n)} == own_secrets


def test_no_route_serves_a_directory_a_transcript_or_a_credential(pg_db):
    app = build_server_app(pg_db(allow_writes=True, status_enabled=True))
    paths = [getattr(r, "path", "") for r in app.routes]
    assert paths
    assert not [p for p in paths if re.search(r"sweep|approv|grant|credential|token|transcript|run[_-]?dir|runs|files?|static|download|proxy|exec|shell|jev", p, re.I)], paths
    assert not [r for r in app.routes if type(r).__name__ in ("Mount", "Host")], "a Mount can serve a directory or another app"
