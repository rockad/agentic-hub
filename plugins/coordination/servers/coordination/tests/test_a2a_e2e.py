"""S1-A2A end to end: a real uvicorn server-in-a-thread serving `build_server_app` (the app `main`
serves: the real access-control middleware over the SQL key store, the real service layer, the
cards file written into the `cards` table at start-up, a real Postgres), driven over real sockets
by the A2A SDK's own client (`a2a-sdk` 1.3.0, the version the server is pinned to) on both
bindings.

This is interoperability evidence, not a spec conformance run: the SDK client is the same package
that defines the wire types, so it agrees with the server on field names by construction. What it
does show is that a standard client can start from the member card URL, follow the card to the
interface URL and tenant, send, read, list, cancel and be refused, over JSON-RPC and over REST,
with the version header and the bearer key the card declares. The TCK is not run here (see
docs/specs/a2a.md).
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Iterator

import httpx
import pytest
import uvicorn
from a2a.client import ClientConfig, ClientFactory
from a2a.utils.errors import PushNotificationNotSupportedError, TaskNotCancelableError
from a2a.types import a2a_pb2 as pb
from a2a_helpers import CARDS_YAML
from conftest import free_port, run
from mcp_helpers import CARD_AGY, CARD_CLAUDE, make_env

from coordination.app import build_server_app

JSONRPC, REST = "JSONRPC", "HTTP+JSON"


class Served:
    def __init__(self, env, port: int) -> None:
        self.env, self.port = env, port
        self.url = f"http://127.0.0.1:{port}"


@pytest.fixture
def served(pg_db, tmp_path) -> Iterator[Served]:
    port = free_port()
    cards_file = tmp_path / "cards.yaml"
    cards_file.write_text(CARDS_YAML)
    env = make_env(
        pg_db,
        allowed_hosts=(f"127.0.0.1:{port}",),
        listen=f"127.0.0.1:{port}",
        public_url=f"http://127.0.0.1:{port}",
        cards_file=str(cards_file),
    )
    app = build_server_app(env.config)  # the app `main` serves
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started:
        assert thread.is_alive() and time.monotonic() < deadline, "the server did not start"
        time.sleep(0.05)
    try:
        yield Served(env, port)
    finally:
        server.should_exit = True
        thread.join(timeout=20)
        run(env.engine.dispose())


def card_path(card_id: str) -> str:
    return f"/agents/{card_id}/.well-known/agent-card.json"


async def client_for(served: Served, token: str, card_id: str, binding: str):
    """What a standard client does: read the member card from its own path with the key the card
    declares, then talk to the interface URL and tenant the card gives."""
    http = httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"})
    factory = ClientFactory(ClientConfig(httpx_client=http, streaming=False, supported_protocol_bindings=[binding]))
    client = await factory.create_from_url(served.url, relative_card_path=card_path(card_id))
    return client, http


def send_request(card_id: str, text: str, *, message_id: str) -> pb.SendMessageRequest:
    request = pb.SendMessageRequest(
        tenant=card_id,
        message=pb.Message(message_id=message_id, role=pb.Role.ROLE_USER, parts=[pb.Part(text=text)]),
    )
    request.configuration.return_immediately = True
    return request


async def first_task(client, request: pb.SendMessageRequest) -> pb.Task:
    async for event in client.send_message(request):
        return event.task
    raise AssertionError("no response")


@pytest.mark.parametrize("binding", [JSONRPC, REST])
def test_the_sdk_client_reads_the_member_card_and_runs_the_operations(served, binding):
    keys = served.env.keys

    async def scenario() -> None:
        claude, http_claude = await client_for(served, keys.claude, CARD_CLAUDE, binding)
        agy, http_agy = await client_for(served, keys.agy, CARD_AGY, binding)
        try:
            # The card the client resolved says what the server says: own tenant, the public URL,
            # honest flags.
            card = claude._card
            assert card.name == CARD_CLAUDE
            assert {i.tenant for i in card.supported_interfaces} == {CARD_CLAUDE}
            assert {i.url for i in card.supported_interfaces} == {f"{served.url}/a2a/v1"}
            assert not card.capabilities.streaming and not card.capabilities.push_notifications

            # claude-code sends to the agy card; both sides see the same task.
            sent = await first_task(claude, send_request(CARD_AGY, "please review", message_id="m-sdk-1"))
            assert sent.status.state == pb.TaskState.TASK_STATE_SUBMITTED
            got = await claude.get_task(pb.GetTaskRequest(id=sent.id))
            assert got.id == sent.id and got.history[0].parts[0].text == "please review"
            theirs = await agy.get_task(pb.GetTaskRequest(id=sent.id))
            assert theirs.id == sent.id

            # The same message_id returns the same task.
            again = await first_task(claude, send_request(CARD_AGY, "please review", message_id="m-sdk-1"))
            assert again.id == sent.id

            listed = await claude.list_tasks(pb.ListTasksRequest())
            assert [t.id for t in listed.tasks] == [sent.id]
            assert listed.total_size == 1

            extended = await claude.get_extended_agent_card(pb.GetExtendedAgentCardRequest())
            assert extended.name == CARD_CLAUDE

            canceled = await claude.cancel_task(pb.CancelTaskRequest(id=sent.id))
            assert canceled.status.state == pb.TaskState.TASK_STATE_CANCELED
            with pytest.raises(TaskNotCancelableError):  # -32002, read back as the SDK exception class
                await claude.cancel_task(pb.CancelTaskRequest(id=sent.id))

            # Push is off: the SDK client reads -32003 back as its own exception class.
            with pytest.raises(PushNotificationNotSupportedError):
                await claude.create_task_push_notification_config(
                    pb.TaskPushNotificationConfig(task_id=sent.id, url="https://example.com/hook")
                )
        finally:
            await claude.close()
            await agy.close()
            await http_claude.aclose()
            await http_agy.aclose()

    asyncio.run(scenario())


def test_a_client_that_sends_no_key_or_the_wrong_version_is_refused_over_real_sockets(served):
    keys = served.env.keys
    with httpx.Client(base_url=served.url) as http:
        assert http.get("/.well-known/agent-card.json").status_code == 200  # the front desk is public
        assert http.get("/.well-known/agent-card.json").json()["name"] == "Coordination front desk"
        assert http.get(card_path(CARD_CLAUDE)).status_code == 401
        assert http.get(card_path(CARD_CLAUDE), headers={"Authorization": f"Bearer {keys.peer}"}).status_code == 200
        body = {"jsonrpc": "2.0", "id": 1, "method": "ListTasks", "params": {}}
        auth = {"Authorization": f"Bearer {keys.claude}"}
        assert http.post("/a2a/v1", json=body).status_code == 401
        old = http.post("/a2a/v1", json=body, headers={**auth, "A2A-Version": "0.3"})
        assert old.json()["error"]["code"] == -32009
        missing = http.post("/a2a/v1", json=body, headers=auth)
        assert missing.json()["error"]["code"] == -32009
        ok = http.post("/a2a/v1", json=body, headers={**auth, "A2A-Version": "1.0"})
        assert "result" in ok.json()
        # The cards file reached the `cards` table at start-up: a send to a defined card works.
        sent = http.post(
            "/a2a/v1",
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "SendMessage",
                "params": {
                    "tenant": CARD_AGY,
                    "message": {"messageId": "m-e2e-2", "role": "ROLE_USER", "parts": [{"text": "hi"}]},
                    "configuration": {"returnImmediately": True},
                },
            },
            headers={**auth, "A2A-Version": "1.0"},
        )
        assert sent.json()["result"]["task"]["status"]["state"] == "TASK_STATE_SUBMITTED"
