"""Push notification configuration and delivery, with `A2A_PUSH_ENABLED=1` (S1-A2A, spec 3.3.4).

The screen is tested against a fake resolver, so the tests need no network and cannot be fooled by
the machine's DNS. The config store is the real SDK store over the real Postgres with a real Fernet
key; delivery runs against an `httpx.MockTransport`, which sees the exact request the sender would
put on the wire (the connect URL, the headers, the TLS server name, the timeouts). What no test
here does is open a TLS connection to a public host: that is [unverified] (docs/specs/a2a.md).
"""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest
import sqlalchemy as sa
from a2a.types import a2a_pb2 as pb
from a2a.utils.push_url_validator import validate_push_notification_url
from a2a_helpers import (
    CARD_AGY,
    CARD_CLAUDE,
    H_CLAUDE,
    local_caller,
    make_a2a_env,
    send_params,
)
from conftest import run
from cryptography.fernet import Fernet

from coordination.a2a import PushConfigs, PushSender, PushUrlRefused, address_is_blocked, build_a2a, screen_push_url
from coordination.a2a.push import PinnedTarget, pushed_task
from coordination.service import Directory

PUBLIC = "203.0.113.10"  # TEST-NET-3 stands in for a public address through the fake resolver; see `allow_documentation`
KEY = Fernet.generate_key().decode()


# -- the address rule ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1", "127.255.255.254", "::1",  # loopback
        "169.254.169.254", "169.254.0.1", "fe80::1",  # link-local, the cloud metadata address
        "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",  # private
        "fc00::1", "fd12:3456::1",  # unique-local
        "100.64.0.0", "100.100.100.100", "100.127.255.255",  # carrier-grade NAT: covers tailnet addresses
        "224.0.0.1", "ff02::1",  # multicast
        "0.0.0.0", "::",  # unspecified
        "240.0.0.1", "255.255.255.255",  # reserved
        "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:100.64.0.1",  # IPv4-mapped: judged as the IPv4 inside
        "not an address",
    ],
)
def test_non_public_addresses_are_blocked(address):
    assert address_is_blocked(address)


@pytest.mark.parametrize("address", ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
def test_public_addresses_are_not_blocked(address):
    assert not address_is_blocked(address)


# -- the screen ----------------------------------------------------------------------------------


def resolver(table: dict[str, list[str]]):
    calls: list[tuple[str, int]] = []

    async def resolve(host: str, port: int) -> list[str]:
        calls.append((host, port))
        return list(table.get(host, []))

    resolve.calls = calls  # type: ignore[attr-defined]
    return resolve


async def yes(_url: str) -> bool:
    return True


def screen(url, allow=(), table=None, validator=yes):
    return run(screen_push_url(url, allow, resolve=resolver(table or {"hook.example": ["8.8.8.8"]}), validator=validator))


@pytest.mark.parametrize(
    "url, why",
    [
        ("http://hook.example/x", "scheme_not_https"),
        ("ftp://hook.example/x", "scheme_not_https"),
        ("https://user@hook.example/x", "userinfo_not_allowed"),
        ("https://user:secret@hook.example/x", "userinfo_not_allowed"),
        ("https://:secret@hook.example/x", "userinfo_not_allowed"),
        ("https://127.0.0.1/x", "address_not_public"),
        ("https://[::1]/x", "address_not_public"),
        ("https://169.254.169.254/latest/meta-data/", "address_not_public"),
        ("https://10.1.2.3/x", "address_not_public"),
        ("https://192.168.0.5/x", "address_not_public"),
        ("https://100.64.1.1/x", "address_not_public"),
        ("https://100.101.102.103/x", "address_not_public"),
        ("https://[fe80::1]/x", "address_not_public"),
        ("https://[::ffff:127.0.0.1]/x", "address_not_public"),
        ("https://hook.example:8443/x", "port_not_allowed"),
        ("https:///x", "host_missing"),
        ("", "url_invalid"),
        ("https://hook.example:notaport/x", "url_invalid"),
        ("https://hook.example/" + "a" * 3000, "url_invalid"),
        ("https://unresolvable.example/x", "host_unresolvable"),
    ],
)
def test_the_screen_refuses(url, why):
    with pytest.raises(PushUrlRefused) as exc:
        screen(url)
    assert str(exc.value) == why
    assert "secret" not in str(exc.value) and "hook.example" not in str(exc.value)  # the URL is never in the reason


@pytest.mark.parametrize(
    "resolved",
    [["127.0.0.1"], ["10.0.0.7"], ["169.254.169.254"], ["100.64.0.9"], ["fc00::7"], ["8.8.8.8", "10.0.0.7"], ["10.0.0.7", "8.8.8.8"]],
)
def test_a_name_that_resolves_to_anything_non_public_is_refused_even_if_another_address_is_public(resolved):
    with pytest.raises(PushUrlRefused, match="address_not_public"):
        screen("https://hook.example/x", table={"hook.example": resolved})


def test_a_public_name_passes_and_the_target_is_pinned_to_the_resolved_address():
    target = screen("https://hook.example/path/a?b=c")
    assert target == PinnedTarget(host="hook.example", port=443, address="8.8.8.8", path="/path/a?b=c", allowlisted=False)
    assert target.connect_url == "https://8.8.8.8:443/path/a?b=c" and target.host_header == "hook.example"
    v6 = screen("https://v6.example/", table={"v6.example": ["2606:4700:4700::1111"]})
    assert v6.connect_url == "https://[2606:4700:4700::1111]:443/"
    assert screen("https://HOOK.example./x").host == "hook.example"  # case and a trailing dot


def test_an_unresolvable_name_fails_closed():
    with pytest.raises(PushUrlRefused, match="host_unresolvable"):
        screen("https://nothing.example/", table={})


def test_the_sdk_validator_is_always_asked_and_a_no_from_it_refuses():
    asked: list[str] = []

    async def no(url: str) -> bool:
        asked.append(url)
        return False

    with pytest.raises(PushUrlRefused, match="address_not_public"):
        screen("https://hook.example/x", validator=no)
    assert asked == ["https://hook.example/x"]


def test_the_default_validator_is_the_sdks_validate_push_notification_url(pg_db):
    env = make_a2a_env(pg_db, push_enabled=True, push_enc_key=KEY)
    endpoint = build_a2a(env.config, env.base.service, env.base.store, Directory(env.engine), env.engine, env.base.clock, registry=env.registry)
    assert endpoint.ops._push._validator is validate_push_notification_url  # there is no setting that turns it off
    assert endpoint.ops.sender._validator is validate_push_notification_url
    assert endpoint.ops.sender._transport is None  # the real network, in production


def test_the_default_screen_calls_the_sdk_validator_for_real_against_a_literal_address():
    # no fake: the SDK's own function refuses a loopback literal, and so does the screen
    with pytest.raises(PushUrlRefused, match="address_not_public"):
        run(screen_push_url("https://127.0.0.1/x"))


def test_an_allowlisted_name_is_the_only_way_to_a_private_target_and_it_must_be_exact():
    table = {"intranet.example": ["10.0.0.5"], "intranet.example.evil": ["10.0.0.5"], "sub.intranet.example": ["10.0.0.5"]}
    ok = screen("https://intranet.example/x", allow=("intranet.example",), table=table, validator=_never)
    assert ok.allowlisted and ok.address == "10.0.0.5"  # the SDK validator was skipped: it would have said no
    for url in ("https://sub.intranet.example/x", "https://intranet.example.evil/x", "https://other.example/x"):
        with pytest.raises(PushUrlRefused):
            screen(url, allow=("intranet.example",), table={**table, "other.example": ["10.0.0.5"]})
    # https and no userinfo still apply to an allowlisted name
    with pytest.raises(PushUrlRefused, match="scheme_not_https"):
        screen("http://intranet.example/x", allow=("intranet.example",), table=table)
    with pytest.raises(PushUrlRefused, match="userinfo_not_allowed"):
        screen("https://u:p@intranet.example/x", allow=("intranet.example",), table=table)


async def _never(_url: str) -> bool:
    raise AssertionError("the SDK validator must not run for an allowlisted name")


def test_a_port_other_than_443_needs_an_allowlist_entry_that_names_it():
    table = {"hook.example": ["8.8.8.8"]}
    with pytest.raises(PushUrlRefused, match="port_not_allowed"):
        screen("https://hook.example:8443/x", allow=("hook.example",), table=table)  # an entry without a port means 443
    ok = screen("https://hook.example:8443/x", allow=("hook.example:8443",), table=table)
    assert ok.port == 8443 and ok.host_header == "hook.example:8443"
    with pytest.raises(PushUrlRefused, match="port_not_allowed"):
        screen("https://hook.example:9443/x", allow=("hook.example:8443",), table=table)


# -- the config store: the operations, with the flag on ------------------------------------------


@pytest.fixture
def env(pg_db):
    return make_a2a_env(pg_db, push_enabled=True, push_enc_key=KEY)


def push_app(env, table=None, **kw):
    return env.wire(env.app(push_resolve=resolver(table or {"hook.example": ["8.8.8.8"], "other.example": ["8.8.4.4"]}), push_validator=yes, **kw))


def new_task(wire, env, token=None):
    return wire.result(token or env.keys.agy, "SendMessage", send_params(CARD_CLAUDE))["task"]["id"]


def test_the_card_declares_push_true_when_the_flag_is_on(env):
    card = env.wire().card(f"/agents/{CARD_CLAUDE}/.well-known/agent-card.json", env.keys.agy).json()
    assert card["capabilities"]["pushNotifications"] is True and card["capabilities"]["streaming"] is False


def test_create_get_list_delete_by_the_originator(env):
    wire = push_app(env)
    task_id = new_task(wire, env)
    created = wire.result(env.keys.agy, "CreateTaskPushNotificationConfig",
                          {"taskId": task_id, "url": "https://hook.example/h", "token": "tok-1", "authentication": {"scheme": "Bearer", "credentials": "cred-1"}})
    assert created["taskId"] == task_id and created["url"] == "https://hook.example/h" and created["id"]
    got = wire.result(env.keys.agy, "GetTaskPushNotificationConfig", {"taskId": task_id, "id": created["id"]})
    assert got == created
    assert [c["id"] for c in wire.result(env.keys.agy, "ListTaskPushNotificationConfigs", {"taskId": task_id})["configs"]] == [created["id"]]
    assert wire.result(env.keys.agy, "DeleteTaskPushNotificationConfig", {"taskId": task_id, "id": created["id"]}) == {}
    assert wire.result(env.keys.agy, "ListTaskPushNotificationConfigs", {"taskId": task_id})["configs"] == []
    assert wire.error(env.keys.agy, "GetTaskPushNotificationConfig", {"taskId": task_id, "id": created["id"]})["code"] == -32001


def test_the_same_over_rest(env):
    wire = push_app(env)
    task_id = new_task(wire, env)
    base = f"/{CARD_CLAUDE}/tasks/{task_id}/pushNotificationConfigs"
    created = wire.rest(env.keys.agy, "POST", base, json_body={"url": "https://hook.example/h"})
    assert created.status_code == 200 and created.json()["taskId"] == task_id
    cid = created.json()["id"]
    assert wire.rest(env.keys.agy, "GET", f"{base}/{cid}").json()["url"] == "https://hook.example/h"
    assert len(wire.rest(env.keys.agy, "GET", base).json()["configs"]) == 1
    assert wire.rest(env.keys.agy, "DELETE", f"{base}/{cid}").status_code == 200
    assert wire.rest(env.keys.agy, "GET", base).json()["configs"] == []
    assert wire.rest(env.keys.agy, "POST", base, json_body={"url": "http://hook.example/h"}).status_code == 400


@pytest.mark.parametrize(
    "url, why",
    [
        ("http://hook.example/h", "scheme_not_https"),
        ("https://user:pw@hook.example/h", "userinfo_not_allowed"),
        ("https://127.0.0.1/h", "address_not_public"),
        ("https://localhost/h", "host_unresolvable"),
        ("https://169.254.169.254/h", "address_not_public"),
        ("https://10.0.0.1/h", "address_not_public"),
        ("https://100.64.0.1/h", "address_not_public"),
        ("https://hook.example:8443/h", "port_not_allowed"),
    ],
)
def test_a_refused_url_never_reaches_the_store(env, url, why):
    wire = push_app(env)
    task_id = new_task(wire, env)
    err = wire.error(env.keys.agy, "CreateTaskPushNotificationConfig", {"taskId": task_id, "url": url})
    assert err["code"] == -32602 and err["data"][0]["metadata"]["reason"] == why
    assert wire.result(env.keys.agy, "ListTaskPushNotificationConfigs", {"taskId": task_id})["configs"] == []


def test_a_task_has_at_most_three_configs_and_an_existing_one_can_still_be_updated(env):
    wire = push_app(env)
    task_id = new_task(wire, env)
    ids = [wire.result(env.keys.agy, "CreateTaskPushNotificationConfig", {"taskId": task_id, "url": f"https://hook.example/{i}"})["id"] for i in range(3)]
    assert len(set(ids)) == 3
    fourth = wire.error(env.keys.agy, "CreateTaskPushNotificationConfig", {"taskId": task_id, "url": "https://hook.example/4"})
    assert fourth["code"] == -32602 and "at most 3" in fourth["message"]
    updated = wire.result(env.keys.agy, "CreateTaskPushNotificationConfig", {"taskId": task_id, "id": ids[0], "url": "https://other.example/u"})
    assert updated["id"] == ids[0] and updated["url"] == "https://other.example/u"
    assert len(wire.result(env.keys.agy, "ListTaskPushNotificationConfigs", {"taskId": task_id})["configs"]) == 3
    other = new_task(wire, env)  # the cap is per task
    assert wire.result(env.keys.agy, "CreateTaskPushNotificationConfig", {"taskId": other, "url": "https://hook.example/z"})["id"]


def test_only_the_originator_may_touch_a_tasks_configs_everyone_else_gets_nothing(env):
    wire = push_app(env)
    task_id = new_task(wire, env)
    cid = wire.result(env.keys.agy, "CreateTaskPushNotificationConfig", {"taskId": task_id, "url": "https://hook.example/h"})["id"]
    missing = "00000000-0000-0000-0000-000000000000"
    calls = [
        ("CreateTaskPushNotificationConfig", {"taskId": task_id, "url": "https://hook.example/evil"}),
        ("GetTaskPushNotificationConfig", {"taskId": task_id, "id": cid}),
        ("ListTaskPushNotificationConfigs", {"taskId": task_id}),
        ("DeleteTaskPushNotificationConfig", {"taskId": task_id, "id": cid}),
    ]
    # the recipient can see the task and is not its originator; a stranger and a peer cannot see it
    for token in (env.keys.claude, env.keys.claude_other, env.keys.mac, env.keys.peer):
        for method, params in calls:
            err = wire.error(token, method, params)
            assert err["code"] == -32001, (method, token[:10])
            absent = wire.error(token, method, {**params, "taskId": missing})
            assert err == absent
    # nothing changed: the originator's config is intact and there is still exactly one
    assert [c["id"] for c in wire.result(env.keys.agy, "ListTaskPushNotificationConfigs", {"taskId": task_id})["configs"]] == [cid]


def test_a_peer_is_the_originator_of_its_own_held_task(env):
    wire = push_app(env)
    task_id = wire.result(env.keys.peer, "SendMessage", send_params(CARD_CLAUDE))["task"]["id"]
    assert wire.result(env.keys.peer, "CreateTaskPushNotificationConfig", {"taskId": task_id, "url": "https://hook.example/h"})["id"]
    assert wire.error(env.keys.claude, "ListTaskPushNotificationConfigs", {"taskId": task_id})["code"] == -32001


def test_a_config_in_send_message_is_created_with_the_task(env):
    wire = push_app(env)
    params = send_params(CARD_CLAUDE)
    params["configuration"]["taskPushNotificationConfig"] = {"url": "https://hook.example/h", "token": "t"}
    task_id = wire.result(env.keys.agy, "SendMessage", params)["task"]["id"]
    configs = wire.result(env.keys.agy, "ListTaskPushNotificationConfigs", {"taskId": task_id})["configs"]
    assert [c["url"] for c in configs] == ["https://hook.example/h"]
    bad = send_params(CARD_CLAUDE, message_id="bad-push")
    bad["configuration"]["taskPushNotificationConfig"] = {"url": "http://hook.example/h"}
    assert wire.rpc(env.keys.agy, "SendMessage", bad).json()["error"]["code"] == -32602


def test_configs_are_encrypted_at_rest_the_url_token_and_credentials_are_not_in_the_table(env):
    wire = push_app(env)
    task_id = new_task(wire, env)
    wire.result(env.keys.agy, "CreateTaskPushNotificationConfig",
                {"taskId": task_id, "url": "https://hook.example/needle-url", "token": "needle-token", "authentication": {"scheme": "Bearer", "credentials": "needle-credentials"}})

    async def raw() -> list[bytes]:
        async with env.engine.connect() as conn:
            return [bytes(r[0]) for r in (await conn.execute(sa.text("select config_data from push_notification_configs"))).all()]

    rows = run(raw())
    assert len(rows) == 1
    for needle in (b"needle-url", b"needle-token", b"needle-credentials", b"hook.example"):
        assert needle not in rows[0]
    decrypted = Fernet(KEY).decrypt(rows[0])  # the positive control: the same bytes do hold them under the key
    assert b"needle-url" in decrypted and b"needle-token" in decrypted
    # and a store built with a different key cannot read them back
    other = PushConfigs(env.engine, Fernet.generate_key().decode())
    assert run(other.list("agent-card-never-the-owner", task_id)) == []


def test_push_enabled_without_a_key_is_refused_at_build_time(pg_db):
    env = make_a2a_env(pg_db, push_enabled=True)
    with pytest.raises(ValueError, match="A2A_PUSH_ENC_KEY"):
        build_a2a(env.config, env.base.service, env.base.store, Directory(env.engine), env.engine, env.base.clock, registry=env.registry)


# -- delivery ------------------------------------------------------------------------------------


def sender_for(env, table, handler: Callable[[httpx.Request], httpx.Response], allow=(), validator=yes):
    transport = httpx.MockTransport(handler)
    configs = PushConfigs(env.engine, KEY, allow, resolve=resolver(table), validator=validator)
    return configs, PushSender(configs.store, allow, resolve=resolver(table), validator=validator, transport=transport)


def a_task(env, wire):
    task_id = new_task(wire, env)
    return run(env.base.service.get_task(local_caller(CARD_AGY), task_id))


def test_delivery_goes_to_the_pinned_address_with_the_hostname_in_host_and_sni_and_the_task_without_coord(env):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(204)

    table = {"hook.example": ["8.8.8.8", "8.8.4.4"]}
    configs, sender = sender_for(env, table, handler)
    wire = push_app(env, table)
    task = a_task(env, wire)
    run(configs.create("agent", task.id, pb.TaskPushNotificationConfig(url="https://hook.example:443/h?x=1", token="tok", authentication=pb.AuthenticationInfo(scheme="Bearer", credentials="cred"))))
    result = run(sender.send(task))
    assert [(d.ok, d.reason, d.status) for d in result] == [(True, "delivered", 204)]
    request = seen[0]
    assert request.url.host == "8.8.8.8" and request.url.scheme == "https" and request.url.port in (None, 443)  # the pin, not a second resolution
    assert request.url.raw_path == b"/h?x=1"
    assert request.headers["host"] == "hook.example"
    assert request.extensions["sni_hostname"] == "hook.example"
    assert request.headers["x-a2a-notification-token"] == "tok" and request.headers["authorization"] == "Bearer cred"
    assert request.extensions["timeout"] == {"connect": 5.0, "read": 5.0, "write": 5.0, "pool": 5.0}
    body = json.loads(request.content)
    assert body["task"]["id"] == task.id
    assert "coord" not in body["task"].get("metadata", {}) and "coord" not in request.content.decode()  # internal fields removed


def test_pushed_task_drops_coord_and_keeps_the_rest(env):
    wire = push_app(env)
    task = a_task(env, wire)
    assert "coord" in task.metadata
    clean = pushed_task(task)
    assert "coord" not in clean.metadata and clean.id == task.id and len(clean.history) == len(task.history)
    assert "coord" in task.metadata  # the original is untouched


def test_redirects_are_not_followed(env):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(302, headers={"Location": "https://127.0.0.1/internal"})

    table = {"hook.example": ["8.8.8.8"]}
    configs, sender = sender_for(env, table, handler)
    task = a_task(env, push_app(env, table))
    run(configs.create("agent", task.id, pb.TaskPushNotificationConfig(url="https://hook.example/h")))
    result = run(sender.send(task))
    assert [(d.ok, d.reason, d.status) for d in result] == [(False, "redirect_not_followed", 302)]
    assert seen == ["https://8.8.8.8/h"]  # one request; the Location was never fetched


def test_a_name_public_at_config_time_and_private_at_send_time_is_refused_at_send_time(env):
    table = {"hook.example": ["8.8.8.8"]}
    reached: list[httpx.Request] = []
    configs, sender = sender_for(env, table, lambda r: reached.append(r) or httpx.Response(200))
    task = a_task(env, push_app(env, table))
    run(configs.create("agent", task.id, pb.TaskPushNotificationConfig(url="https://hook.example/h")))  # public: accepted
    table["hook.example"] = ["10.0.0.9"]  # DNS rebinding: the same name, now private
    result = run(sender.send(task))
    assert [(d.ok, d.reason) for d in result] == [(False, "address_not_public")]
    assert reached == []  # no request was made
    with pytest.raises(Exception, match="push url refused"):
        run(configs.create("agent", task.id, pb.TaskPushNotificationConfig(id="again", url="https://hook.example/h")))  # and config time refuses it too


def test_a_failing_endpoint_is_recorded_and_never_raises_or_changes_the_task(env):
    table = {"hook.example": ["8.8.8.8"]}
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectTimeout("slow", request=request)
        return httpx.Response(500, content=b"x" * 100_000)

    configs, sender = sender_for(env, table, handler)
    wire = push_app(env, table)
    task = a_task(env, wire)
    run(configs.create("agent", task.id, pb.TaskPushNotificationConfig(id="a", url="https://hook.example/a")))
    run(configs.create("agent", task.id, pb.TaskPushNotificationConfig(id="b", url="https://hook.example/b")))
    result = {d.config_id: (d.ok, d.reason) for d in run(sender.send(task))}
    assert sorted(result.values()) == [(False, "error"), (False, "http_500")]
    after = run(env.base.service.get_task(local_caller(CARD_AGY), task.id))
    assert after.status.state == task.status.state  # a push failure never changes task state


def test_an_allowlisted_private_target_is_delivered_to_its_private_address(env):
    seen: list[httpx.Request] = []
    table = {"intranet.example": ["10.0.0.5"]}
    configs, sender = sender_for(env, table, lambda r: seen.append(r) or httpx.Response(200), allow=("intranet.example",), validator=_never)
    task = a_task(env, push_app(env, table))
    run(configs.create("agent", task.id, pb.TaskPushNotificationConfig(url="https://intranet.example/h")))
    assert [d.ok for d in run(sender.send(task))] == [True] and seen[0].url.host == "10.0.0.5"


def test_the_sender_ignores_proxy_environment_variables(env, monkeypatch):
    """The pin would be defeated by a proxy that re-resolves the name."""
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    seen: list[httpx.Request] = []
    table = {"hook.example": ["8.8.8.8"]}
    configs, sender = sender_for(env, table, lambda r: seen.append(r) or httpx.Response(200))
    task = a_task(env, push_app(env, table))
    run(configs.create("agent", task.id, pb.TaskPushNotificationConfig(url="https://hook.example/h")))
    assert [d.ok for d in run(sender.send(task))] == [True] and len(seen) == 1


def test_a_task_with_no_configs_sends_nothing(env):
    sent: list[httpx.Request] = []
    _, sender = sender_for(env, {}, lambda r: sent.append(r) or httpx.Response(200))
    task = a_task(env, push_app(env))
    assert run(sender.send(task)) == [] and sent == []


def test_a_push_flag_off_means_no_push_service_and_no_sender(pg_db):
    env = make_a2a_env(pg_db)
    endpoint = build_a2a(env.config, env.base.service, env.base.store, Directory(env.engine), env.engine, env.base.clock, registry=env.registry)
    assert endpoint.ops._push is None and endpoint.ops.sender is None
