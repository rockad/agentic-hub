"""Invariant (api 9, 1.5, 1.6, round-2 R8, plan Risk 13): no public route exists before the S3 gate; the
server refuses the public `Host` before `A2A_EXPOSURE_STAGE=s3`.

Two layers, both checked:

1. START-UP REFUSAL. While the stage is `s1` or `s2`, a configuration whose `A2A_ALLOWED_HOSTS` holds the
   public hostname (named by `A2A_PUBLIC_URL`) does not start: bare, with a port, in any letter case and
   among other hosts. At `s3` the same configuration starts.
2. RUNTIME 421. A server whose configuration passed that check answers `421` to the public `Host` on the
   8120 listener, with every key kind and on every endpoint (the Host check runs before the key check),
   and a forged `X-Forwarded-Host`, `Forwarded` or `X-Original-Host` neither lets the public `Host` in nor
   keeps a loopback `Host` out. `/healthz` is exempt from the Host check by design (api 3.7) and says only
   `{"ok":true}`.

What this file does not cover: the 8121 listener and its refusals (S2-LISTEN: the listener does not exist
at S1), the tunnel, and the S3 flip itself (the human procedure of 1.6; `a2a-coord expose check`, S3).
"""

from __future__ import annotations

import dataclasses

import pytest
from auth_helpers import HOST, add_key, bearer, client_for, make_config, probe_app

from coordination.auth import LOCAL_HARNESS, REMOTE_PEER, STATUS_CLIENT, InMemoryApiKeyStore
from coordination.auth.startup import problems, startup_check
from coordination.config import Config

PUBLIC = "a2a.example.org"
TAILNET = "box.tail1234.ts.net"
LOOPBACK_HOSTS = ("127.0.0.1:8120", "localhost:8120")
MESSAGE = "A2A_ALLOWED_HOSTS contains the public hostname before A2A_EXPOSURE_STAGE=s3"


@pytest.fixture
def cards(tmp_path):
    path = tmp_path / "cards.yaml"
    path.write_text("cards: []\n")
    return path


def config_for(cards, stage: str, hosts: tuple[str, ...], public_url: str = f"https://{PUBLIC}") -> Config:
    base = {
        "cards_file": str(cards),
        "exposure_stage": stage,
        "public_url": public_url,
        "allowed_hosts": hosts,
        "trusted_proxy_ips": ("172.18.0.1",),
        "enforce_tailnet_identity": stage != "s1",
        "public_listener_enabled": stage != "s1",
    }
    return dataclasses.replace(Config.from_env({}), **base)


# -- 1. start-up refusal --------------------------------------------------------------------------------


@pytest.mark.parametrize("stage", ["s1", "s2"])
@pytest.mark.parametrize(
    "hosts",
    [
        (*LOOPBACK_HOSTS, PUBLIC),
        (*LOOPBACK_HOSTS, f"{PUBLIC}:443"),
        (*LOOPBACK_HOSTS, f"{PUBLIC}:8120"),
        (*LOOPBACK_HOSTS, PUBLIC.upper()),
        (PUBLIC,),
        (TAILNET, "127.0.0.1:8121", PUBLIC),
    ],
    ids=["bare", "port443", "port8120", "uppercase", "alone", "among-others"],
)
def test_the_public_hostname_in_allowed_hosts_is_refused_before_s3(cards, stage, hosts):
    assert MESSAGE in problems(config_for(cards, stage, hosts))


@pytest.mark.parametrize("stage", ["s1", "s2"])
def test_the_refusal_is_the_process_exiting_with_one_line(cards, stage):
    env = {
        "A2A_CARDS_FILE": str(cards), "A2A_EXPOSURE_STAGE": stage, "A2A_PUBLIC_URL": f"https://{PUBLIC}",
        "A2A_TRUSTED_PROXY_IPS": "172.18.0.1", "A2A_ALLOWED_HOSTS": f"127.0.0.1:8120,{PUBLIC}",
        "A2A_PUBLIC_LISTEN": "0.0.0.0:8121" if stage == "s2" else "",
    }  # fmt: skip

    def never_db(config):
        raise AssertionError("the database was checked although a configuration condition failed")

    with pytest.raises(SystemExit) as exc:
        startup_check(env, check_db=never_db)
    message = exc.value.code
    assert isinstance(message, str) and message.startswith("coordination: ") and "\n" not in message
    assert PUBLIC not in message or "public hostname" in message  # names the rule, may name the variable


def test_the_same_configuration_starts_at_s3(cards):
    assert MESSAGE not in problems(config_for(cards, "s3", (*LOOPBACK_HOSTS, PUBLIC)))
    assert problems(config_for(cards, "s3", (*LOOPBACK_HOSTS, PUBLIC))) == []


def test_the_tailnet_name_is_not_the_public_hostname(cards):
    """At s2 the public URL is the tailnet name, which `A2A_ALLOWED_HOSTS` must hold (the Host that
    `tailscale serve` forwards). Only the Cloudflare hostname is refused before s3."""
    assert problems(config_for(cards, "s2", (*LOOPBACK_HOSTS, TAILNET), public_url=f"https://{TAILNET}")) == []


# -- 2. runtime 421 -------------------------------------------------------------------------------------

ENDPOINTS = [
    ("POST", "/mcp"), ("POST", "/a2a/v1"), ("POST", "/wake/listen"), ("POST", "/wake/pending"), ("GET", "/sessions"),
    ("POST", "/sessions/end"), ("POST", "/status"), ("GET", "/.well-known/agent-card.json"),
    ("GET", "/agents/claude-code@box/.well-known/agent-card.json"), ("GET", "/no-such-endpoint"),
]  # fmt: skip
PUBLIC_HOSTS = [PUBLIC, PUBLIC.upper(), f"{PUBLIC}:443", f"{PUBLIC}:8120", f"{PUBLIC}.", "[::1]:8120", "evil.example"]


def stack(stage: str):
    store = InMemoryApiKeyStore()
    hosts = (*LOOPBACK_HOSTS,) if stage == "s1" else (*LOOPBACK_HOSTS, TAILNET)
    config = make_config(exposure_stage=stage, allowed_hosts=hosts, status_enabled=True, public_url=f"https://{PUBLIC}")
    tokens = {
        LOCAL_HARNESS: add_key(store, LOCAL_HARNESS, card_id="claude-code@box"),
        REMOTE_PEER: add_key(store, REMOTE_PEER, peer_id="p", cards_allowed=("claude-code@box",)),
        STATUS_CLIENT: add_key(store, STATUS_CLIENT),
        None: None,
    }
    return probe_app(config, store), tokens


@pytest.mark.parametrize("stage", ["s1", "s2"])
def test_the_public_host_is_421_on_every_endpoint_with_every_key_kind(stage):
    app, tokens = stack(stage)
    seen = 0
    for host in PUBLIC_HOSTS:
        client = client_for(app, host=host)
        for method, path in ENDPOINTS:
            for token in tokens.values():
                r = client.request(method, path, headers=bearer(token) if token else {})
                assert r.status_code == 421, (stage, host, method, path, r.status_code)
                assert r.headers["content-type"].startswith("application/problem+json")
                assert r.json()["detail"] == "Host not allowed."  # constant, names no host
                seen += 1
    assert seen == len(PUBLIC_HOSTS) * len(ENDPOINTS) * 4


@pytest.mark.parametrize("stage", ["s1", "s2"])
def test_a_refused_public_host_never_reaches_a_handler(stage):
    app, tokens = stack(stage)
    client = client_for(app, host=PUBLIC)
    r = client.post("/mcp", headers=bearer(tokens[LOCAL_HARNESS]))
    assert r.status_code == 421 and "reached" not in r.text
    ok = client_for(app, host=HOST).post("/mcp", headers=bearer(tokens[LOCAL_HARNESS]))
    assert ok.status_code == 200 and ok.json()["reached"] is True  # control: the same key, the loopback host


@pytest.mark.parametrize("header", ["X-Forwarded-Host", "X-Original-Host", "X-Host", "Forwarded", "X-Forwarded-Server"])
def test_a_forged_forwarding_header_neither_admits_the_public_host_nor_blocks_the_loopback_host(header):
    app, tokens = stack("s1")
    key = bearer(tokens[LOCAL_HARNESS])
    value = f"host={PUBLIC}" if header == "Forwarded" else PUBLIC
    admitted = client_for(app, host=HOST).post("/mcp", headers={**key, header: value})
    assert admitted.status_code == 200, header  # the real Host decides
    loopback = f"host={HOST}" if header == "Forwarded" else HOST
    refused = client_for(app, host=PUBLIC).post("/mcp", headers={**key, header: loopback})
    assert refused.status_code == 421, header


def test_healthz_is_exempt_by_design_and_says_nothing_else():
    app, _ = stack("s1")
    r = client_for(app, host=PUBLIC).get("/healthz")
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_at_s3_the_public_host_passes_the_host_check_and_meets_the_key_check():
    store = InMemoryApiKeyStore()
    config = make_config(exposure_stage="s3", allowed_hosts=(*LOOPBACK_HOSTS, PUBLIC), status_enabled=True)
    client = client_for(probe_app(config, store), host=PUBLIC)
    assert client.post("/mcp").status_code == 401  # past the Host check, refused for want of a key


@pytest.mark.xfail(
    strict=True,
    reason=(
        "USER DECISION (S1-SEC finding): the start-up check knows the public hostname only from A2A_PUBLIC_URL. "
        "With the URL left at its loopback default, a public hostname added to A2A_ALLOWED_HOSTS before s3 is "
        "not recognised as public and the server starts and accepts that Host. Closing it needs a rule such as "
        "'before s3, every allowed host must be loopback or a tailnet name', which would also refuse a plain "
        "machine name at s1; spec 1.6 does not say which."
    ),
)
def test_the_public_hostname_in_allowed_hosts_is_refused_even_when_the_public_url_is_not_set(cards):
    config = config_for(cards, "s1", (*LOOPBACK_HOSTS, PUBLIC), public_url="http://127.0.0.1:8120")
    assert MESSAGE in problems(config)
