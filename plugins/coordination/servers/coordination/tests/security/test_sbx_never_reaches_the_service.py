"""Invariant (api 9, D13, round-2 R1, status-client 11): model sessions (sbx) must never reach `:8120` or
`:8121`. The container is on no sbx network, is not on the sbx allow rule, and publishes only on the host
loopback; the admin socket is in-container only and not published.

The host-side half of the plan's S1-SEC test, in two parts:

1. The compose file (static): every published port is bound to `127.0.0.1`; no service joins a named
   network, so no sbx network can be attached (a project with no `networks:` key runs on its own
   default network only); the admin socket directory is a `tmpfs`, never a volume or a bind mount.
2. A reachability probe with a scratch container and a scratch network, both created and removed here:
   a stand-in listener on 8120 and 8121 sits on its own bridge network and is published the way the
   compose file publishes the server (`127.0.0.1` only). A probe container that is NOT on that network
   (the position of an sbx session) tries the listener's own IP and the network's bridge gateway on
   both ports, and must reach none of them. Positive controls prove the probe can connect when it
   should: a probe on the listener's own network, and the host loopback through the published port.

What this does not show: the in-sandbox half (a real sbx session) belongs to LT-ADP with the
cognitive-engine session, and the stand-in is not the server image, so the probe checks the topology
the compose file declares, not the server's code. The probe uses host ports chosen by Docker, never
8120 or 18120 of the host, and only a network and containers it creates itself.
"""

from __future__ import annotations

import json
import shutil
import socket
import subprocess
import uuid
import pytest
import yaml
from conftest import COMPOSE_FILE, _unavailable, pinned_postgres_image

from coordination.config import Config

PORTS = (8120, 8121)


@pytest.fixture(scope="module")
def compose():
    if not COMPOSE_FILE.is_file():
        pytest.skip("compose file is outside the build context (the server image build); the CI checkout run covers it")
    return yaml.safe_load(COMPOSE_FILE.read_text())


# -- 1. the compose file ---------------------------------------------------------------------------


def _published(compose) -> list[tuple[str, str]]:
    out = []
    for name, service in compose["services"].items():
        for entry in service.get("ports", []):
            out.append((name, entry if isinstance(entry, str) else json.dumps(entry, sort_keys=True)))
    return out


def test_every_published_port_is_bound_to_the_host_loopback(compose):
    published = _published(compose)
    assert published, "the server publishes nothing: the check below would pass for the wrong reason"
    assert [(s, p) for s, p in published if not p.startswith("127.0.0.1:")] == []
    assert {s for s, _ in published} == {"coordination"}  # Postgres and the dump sidecar publish nothing


def test_no_service_publishes_a_wildcard_or_host_network(compose):
    for name, service in compose["services"].items():
        assert service.get("network_mode") is None, name  # no `host`, no `container:`
        for entry in service.get("ports", []):
            assert not str(entry).startswith(("0.0.0.0", "[::]", ":")), (name, entry)


def test_the_project_names_no_network_so_no_sbx_network_can_be_attached(compose):
    assert "networks" not in compose, "a top-level network was added: re-run the sbx isolation test (status-client 11)"
    for name, service in compose["services"].items():
        assert "networks" not in service, f"{name} joins a named network: re-run the sbx isolation test"
    text = COMPOSE_FILE.read_text().lower()
    assert "sbx" not in text.replace("sbx isolation", "")  # no mention that would be an attachment


def test_the_admin_socket_directory_is_a_tmpfs_and_never_a_volume_or_a_bind_mount(compose):
    server = compose["services"]["coordination"]
    socket_dir = server["environment"].get("A2A_ADMIN_SOCKET", Config().admin_socket).rsplit("/", 1)[0]
    assert any(str(t).split(":", 1)[0] == socket_dir for t in server.get("tmpfs", [])), "the socket directory is not a tmpfs"
    for service in compose["services"].values():
        for volume in service.get("volumes", []):
            spec = volume if isinstance(volume, str) else volume.get("target", "")
            assert "/run/a2a" not in spec and "admin.sock" not in spec, spec  # not shared with the host or another container


def test_no_api_key_is_placed_in_any_service_environment(compose):
    for name, service in compose["services"].items():
        env = service.get("environment", {})
        names = env if isinstance(env, list) else list(env)
        assert not [n for n in names if "API_KEY" in str(n).upper()], name  # [t2 section 4]


# -- 2. the reachability probe ------------------------------------------------------------------------


def _docker(*args: str, check: bool = True, timeout: float = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check, timeout=timeout)


def _require_docker() -> str:
    if shutil.which("docker") is None:
        _unavailable("docker is not installed")
    if _docker("info", check=False, timeout=30).returncode != 0:
        _unavailable("the docker daemon is not reachable")
    image = pinned_postgres_image()  # busybox `nc` lives in this image; the Postgres fixture pulls it too
    if _docker("image", "inspect", image, check=False).returncode != 0:
        if _docker("pull", "-q", image, check=False, timeout=600).returncode != 0:
            _unavailable(f"the pinned image {image} is not present and cannot be pulled")
    return image


def _connects(image: str, network: str, host: str, port: int) -> bool:
    """True if a throwaway container on `network` can open a TCP connection to host:port."""
    proc = _docker(
        "run", "--rm", "--network", network, "--entrypoint", "sh", image,
        "-c", f"nc -w 2 {host} {port} </dev/null",
        check=False, timeout=60,
    )  # fmt: skip
    return proc.returncode == 0


@pytest.fixture(scope="module")
def topology():
    """A scratch bridge network with a stand-in listener on 8120 and 8121, published on host loopback."""
    image = _require_docker()
    tag = uuid.uuid4().hex[:8]
    network, listener = f"a2a-sec-net-{tag}", f"a2a-sec-listener-{tag}"
    try:
        _docker("network", "create", "--driver", "bridge", network)
        # Published exactly as the compose file publishes the server: 127.0.0.1 only. The host ports
        # are chosen by Docker, never 8120 or 18120.
        _docker(
            "run", "-d", "--name", listener, "--network", network,
            "-p", "127.0.0.1::8120", "-p", "127.0.0.1::8121",
            "--entrypoint", "sh", image, "-c",
            "nc -lk -p 8120 -e /bin/true & nc -lk -p 8121 -e /bin/true & wait",
        )  # fmt: skip
        info = json.loads(_docker("inspect", listener).stdout)[0]
        ip = info["NetworkSettings"]["Networks"][network]["IPAddress"]
        gateway = json.loads(_docker("network", "inspect", network).stdout)[0]["IPAM"]["Config"][0]["Gateway"]
        host_ports = {int(p.split("/")[0]): int(b[0]["HostPort"]) for p, b in info["NetworkSettings"]["Ports"].items() if b}
        assert set(host_ports) == set(PORTS) and not set(host_ports.values()) & {8120, 18120}
        assert all(b[0]["HostIp"] == "127.0.0.1" for b in info["NetworkSettings"]["Ports"].values() if b)
        yield {"image": image, "network": network, "ip": ip, "gateway": gateway, "host_ports": host_ports, "listener": listener}
    finally:
        _docker("rm", "-f", listener, check=False)
        _docker("network", "rm", network, check=False)


def _wait_listening(topology) -> None:
    import time

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if all(_connects(topology["image"], topology["network"], topology["ip"], p) for p in PORTS):
            return
        time.sleep(0.5)
    raise AssertionError("the stand-in listener never came up on its own network")


def test_positive_controls_the_probe_connects_where_it_should(topology):
    _wait_listening(topology)  # a container ON the listener's network reaches both ports
    for port, host_port in topology["host_ports"].items():
        with socket.create_connection(("127.0.0.1", host_port), timeout=5):  # the published loopback route works
            pass
        assert port in PORTS


@pytest.mark.parametrize("port", PORTS)
@pytest.mark.parametrize("route", ["container_ip", "network_gateway"])
def test_a_container_off_the_network_reaches_neither_the_container_ip_nor_the_gateway(topology, route, port):
    _wait_listening(topology)  # without this a refusal could just mean "not up yet"
    target = topology["ip"] if route == "container_ip" else topology["gateway"]
    # `bridge` is Docker's default network: where a session that is not on the compose network sits.
    assert _connects(topology["image"], "bridge", target, port) is False, f"{route} {target}:{port} is reachable off-network"


def test_the_published_host_port_is_not_reachable_on_the_gateway_address(topology):
    """Publishing is loopback only: the same host port on the bridge gateway address has no listener."""
    _wait_listening(topology)
    for host_port in topology["host_ports"].values():
        assert _connects(topology["image"], "bridge", topology["gateway"], host_port) is False


# -- meta-tests: the static checks fail on a compose file that breaks each rule ----------------------------


def _mutated(compose, change):
    import copy

    clone = copy.deepcopy(compose)
    change(clone)
    return clone


@pytest.mark.parametrize(
    ("check", "change"),
    [
        (test_every_published_port_is_bound_to_the_host_loopback, lambda c: c["services"]["coordination"].update(ports=["8120:8120"])),
        (test_every_published_port_is_bound_to_the_host_loopback, lambda c: c["services"]["postgres"].update(ports=["127.0.0.1:5432:5432"])),
        (test_no_service_publishes_a_wildcard_or_host_network, lambda c: c["services"]["coordination"].update(network_mode="host")),
        (test_no_service_publishes_a_wildcard_or_host_network, lambda c: c["services"]["coordination"].update(ports=["0.0.0.0:8120:8120"])),
        (test_the_project_names_no_network_so_no_sbx_network_can_be_attached, lambda c: c.update(networks={"sbx": {"external": True}})),
        (test_the_project_names_no_network_so_no_sbx_network_can_be_attached, lambda c: c["services"]["coordination"].update(networks=["sbx"])),
        (test_the_admin_socket_directory_is_a_tmpfs_and_never_a_volume_or_a_bind_mount, lambda c: c["services"]["coordination"].update(tmpfs=["/tmp"])),
        (test_the_admin_socket_directory_is_a_tmpfs_and_never_a_volume_or_a_bind_mount, lambda c: c["services"]["coordination"]["volumes"].append("/run/a2a:/run/a2a")),
        (test_no_api_key_is_placed_in_any_service_environment, lambda c: c["services"]["coordination"]["environment"].update(A2A_API_KEY="x")),
    ],
)
def test_each_static_check_fails_on_a_compose_file_that_breaks_its_rule(compose, check, change):
    check(compose)  # the real file passes
    with pytest.raises(AssertionError):
        check(_mutated(compose, change))
