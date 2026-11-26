"""Agent Cards: the cards file, the builder and the card registry (S1-A2A, spec 3.2, 8.5).

`config/cards.yaml` holds the non-secret definition of every member card. Its schema [design;
S1-AUTH's start-up check enforces only `name`]:

```yaml
cards:
  - name: claude-code@<workstation>        # the card id, ^<harness>@<machine>$ (spec 5.1)
    description: Claude Code sessions on <workstation>. ...   # optional
    version: "0.1.0"                       # optional, defaults to the server version
    skills:                                # optional, one default skill when absent
      - id: parked-task-exchange
        name: Parked task exchange
        description: ...
        tags: [coordination]
        examples: [...]
```

Everything else in a card is the server's, not the file's: the interface URLs (from
`A2A_PUBLIC_URL`, never the listen address), the tenant (the card id), the bearer security scheme
that is actually enforced, the capability flags, the extension URI, the input and output modes and
the 60 s deviation sentence of D22. A card therefore cannot claim more than the server does.

Three cards are built from one definition (`CardBuilder`):

- the member card, `GET /agents/<card>/.well-known/agent-card.json`, any valid API key (D31, D32);
- the extended card, `GetExtendedAgentCard`: the member card, plus (for a local-harness key only)
  an extension entry whose `params` lists the card's live sessions (spec 3.3.3);
- the root front-desk card, `GET /.well-known/agent-card.json`, public and generic: no member
  name, no tenant (decision Z13).

Wire form is ProtoJSON camelCase from `MessageToDict`, with no v0.3 compatibility fields (D33).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import sqlalchemy as sa
import yaml
from a2a.types import a2a_pb2 as pb
from google.protobuf import json_format
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine

from coordination import __version__
from coordination.clock import Clock
from coordination.config import Config
from coordination.service.directory import ACTIVE_WINDOW
from coordination.service.ports import ListenerView
from coordination.service.types import CARD_RE
from coordination.store.tables import cards as cards_table
from coordination.store.tables import sessions as sessions_table
from coordination.text_sanitize import sanitize_preview

log = logging.getLogger("coordination.a2a")

EXTENSION_URI = "urn:agentic-hub:coordination:v1"
EXTENSION_DESCRIPTION = (
    "Per-session handles in message metadata (coord.to), server-set origin and hold markers on "
    "tasks, async parked tasks (SendMessage may return before a terminal state)."
)
PROTOCOL_VERSION = "1.0"
MODES = ("text/plain", "application/json")
BEARER = "bearerAuth"
CARD_CACHE_CONTROL = "max-age=60"  # spec 3.2

FRONT_DESK_NAME = "Coordination front desk"
FRONT_DESK_DESCRIPTION = (
    "Front desk of a server that connects coding-agent sessions. This card names no member. "
    "Authenticate with an API key, read the card of the agent you need at "
    "/agents/<card-id>/.well-known/agent-card.json, and send to the interface URL and tenant "
    "that card gives. A message sent here, without a tenant, is rejected."
)
FRONT_DESK_SKILL = {
    "id": "front-desk",
    "name": "Front desk",
    "description": "Points a caller at the member cards. It takes no tasks itself.",
    "tags": ["coordination", "front-desk"],
}
DEFAULT_SKILL = {
    "id": "parked-task-exchange",
    "name": "Parked task exchange",
    "description": (
        "Accepts a task or question for a live, human-supervised session, which takes it with a "
        "tool call, may ask for clarification, and answers. Remote senders' tasks are held for "
        "human review first."
    ),
    "tags": ["coordination", "coding-agent", "task-handoff"],
}


class CardsError(ValueError):
    """The cards file cannot be used. The message names the file and the entry, never its content."""


def deviation_sentence(block_max_s: int) -> str:
    """The D22 sentence every card carries, with the cap the server actually applies."""
    return (
        "Deviation from A2A 1.0.1: a SendMessage request without returnImmediately waits at most "
        f"{block_max_s} seconds, then returns the current task in SUBMITTED or WORKING state; "
        "poll with GetTask. A request with returnImmediately returns at once."
    )


@dataclass(frozen=True)
class CardDefinition:
    """One entry of the cards file."""

    card_id: str
    description: str = ""
    version: str = __version__
    skills: tuple[Mapping[str, Any], ...] = ()

    @property
    def harness(self) -> str:
        return self.card_id.split("@", 1)[0]

    @property
    def machine(self) -> str:
        return self.card_id.split("@", 1)[1]

    def as_json(self) -> dict[str, Any]:
        """What the `cards.card_json` column holds: the non-secret definition."""
        return {
            "name": self.card_id,
            "description": self.description,
            "version": self.version,
            "skills": [dict(s) for s in self.skills],
        }


@dataclass(frozen=True)
class CardRegistry:
    """The defined cards, by id, in file order."""

    definitions: Mapping[str, CardDefinition] = field(default_factory=dict)

    def __contains__(self, card_id: object) -> bool:
        return card_id in self.definitions

    def get(self, card_id: str) -> CardDefinition | None:
        return self.definitions.get(card_id)

    def ids(self) -> list[str]:
        return list(self.definitions)

    @classmethod
    def empty(cls) -> CardRegistry:
        return cls({})


def parse_cards(raw: str, *, source: str = "the cards file") -> CardRegistry:
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError:
        raise CardsError(f"{source} is not valid YAML") from None
    if not isinstance(data, dict) or not isinstance(data.get("cards"), list):
        raise CardsError(f"{source} must be a mapping with a `cards` list")
    out: dict[str, CardDefinition] = {}
    for index, entry in enumerate(data["cards"]):
        if not isinstance(entry, dict):
            raise CardsError(f"{source}: entry {index} is not a mapping")
        card_id = entry.get("name")
        if not isinstance(card_id, str) or not CARD_RE.match(card_id):
            raise CardsError(f"{source}: entry {index} has no valid card id in `name`")
        if card_id in out:
            raise CardsError(f"{source}: card {card_id} is defined twice")
        description = entry.get("description", "")
        version = entry.get("version", __version__)
        if not isinstance(description, str) or not isinstance(version, str | int | float):
            raise CardsError(f"{source}: card {card_id} has a bad description or version")
        skills = entry.get("skills", [])
        if not isinstance(skills, list) or not all(isinstance(s, dict) and s.get("id") for s in skills):
            raise CardsError(f"{source}: card {card_id} has skills that are not mappings with an id")
        out[card_id] = CardDefinition(card_id, description.strip(), str(version), tuple(skills))
    return CardRegistry(out)


def load_cards(path: str) -> CardRegistry:
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise CardsError(f"the cards file {path} cannot be read ({type(exc).__name__})") from None
    return parse_cards(raw, source=f"the cards file {path}")


def load_cards_or_empty(path: str) -> CardRegistry:
    """For `build_server_app`: `startup_check` has already refused a bad file when `main` runs, so
    this only matters to a caller that builds the app without it (tests). It never hides a problem:
    it logs one."""
    try:
        return load_cards(path)
    except CardsError as exc:
        log.warning("no cards served: %s", exc)
        return CardRegistry.empty()


async def sync_cards(engine: AsyncEngine, registry: CardRegistry) -> int:
    """Upsert the defined cards into the `cards` table (spec 1.3: "loaded from the cards file at
    start"), which the service layer reads to decide whether a card exists. A card removed from
    the file is not deleted from the table [design]: keys, sessions and tasks may still name it.
    Returns the number of cards written."""
    rows = [
        {"card_id": d.card_id, "harness": d.harness, "machine": d.machine, "card_json": d.as_json()}
        for d in registry.definitions.values()
    ]
    if not rows:
        return 0
    stmt = pg_insert(cards_table)
    stmt = stmt.on_conflict_do_update(
        index_elements=[cards_table.c.card_id],
        set_={"harness": stmt.excluded.harness, "machine": stmt.excluded.machine, "card_json": stmt.excluded.card_json},
    )
    async with engine.begin() as conn:
        await conn.execute(stmt, rows)
    return len(rows)


# -- builder -------------------------------------------------------------------------------


@dataclass(frozen=True)
class LiveSession:
    handle: str
    liveness: str


class SessionLister:
    """The live sessions of a card, for the extended card of a local-harness key (spec 3.3.3).

    `liveness` follows spec 5.5: `listening` (a parked listener, from the `ListenerView`),
    `active` (a call in the last 15 minutes) or `registered`. Ended sessions are not listed."""

    def __init__(self, engine: AsyncEngine, clock: Clock, listeners: ListenerView | None = None) -> None:
        self._engine = engine
        self._clock = clock
        self._listeners = listeners

    async def live(self, card_id: str) -> list[LiveSession]:
        stmt = (
            sa.select(sessions_table.c.handle, sessions_table.c.last_seen_at)
            .where(sessions_table.c.card_id == card_id, sessions_table.c.ended_at.is_(None))
            .order_by(sessions_table.c.registered_at, sessions_table.c.handle)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        now = self._clock.now()
        out = []
        for handle, last_seen in rows:
            if self._listeners is not None and self._listeners.is_listening(handle):
                liveness = "listening"
            elif _recent(last_seen, now):
                liveness = "active"
            else:
                liveness = "registered"
            out.append(LiveSession(handle, liveness))
        return out


def _recent(last_seen: datetime, now: datetime) -> bool:
    return now - last_seen <= ACTIVE_WINDOW


class CardBuilder:
    """Builds the three card shapes from a definition and the configuration."""

    def __init__(self, config: Config) -> None:
        self._config = config

    @property
    def interface_url(self) -> str:
        """`A2A_PUBLIC_URL` plus the A2A path: the one origin clients are told, never the listener's."""
        return self._config.public_url.rstrip("/") + "/a2a/v1"

    def _interfaces(self, tenant: str) -> list[pb.AgentInterface]:
        return [
            pb.AgentInterface(
                url=self.interface_url, protocol_binding=binding, protocol_version=PROTOCOL_VERSION, tenant=tenant
            )
            for binding in ("JSONRPC", "HTTP+JSON")
        ]

    def _common(self, name: str, description: str, version: str, tenant: str, skills: Sequence[Mapping[str, Any]]) -> pb.AgentCard:
        sentence = deviation_sentence(self._config.send_block_max_s)
        text = description.strip()
        if sentence not in text:
            text = f"{text} {sentence}".strip()
        card = pb.AgentCard(name=name, description=text, version=version)
        card.supported_interfaces.extend(self._interfaces(tenant))
        card.capabilities.streaming = False  # D35: nothing builds the event fan-out at S1
        card.capabilities.push_notifications = self._config.push_enabled
        card.capabilities.extended_agent_card = True
        extension = card.capabilities.extensions.add(uri=EXTENSION_URI, description=EXTENSION_DESCRIPTION)
        extension.required = False
        scheme = pb.SecurityScheme()
        scheme.http_auth_security_scheme.scheme = "Bearer"
        scheme.http_auth_security_scheme.bearer_format = "opaque API key issued by a2a-coord"
        scheme.http_auth_security_scheme.description = "Scoped bearer API key. Loopback requests need one too."
        card.security_schemes[BEARER].CopyFrom(scheme)
        requirement = card.security_requirements.add()
        requirement.schemes[BEARER].list.extend([])
        card.default_input_modes.extend(MODES)
        card.default_output_modes.extend(MODES)
        for skill in skills or (DEFAULT_SKILL,):
            card.skills.append(_skill(skill))
        return card

    def member(self, definition: CardDefinition) -> pb.AgentCard:
        return self._common(
            definition.card_id,
            definition.description or f"{definition.harness} sessions on machine {definition.machine}.",
            definition.version,
            definition.card_id,
            definition.skills,
        )

    def front_desk(self) -> pb.AgentCard:
        """Public and generic (D32, Z13): no member name, no tenant."""
        return self._common(FRONT_DESK_NAME, FRONT_DESK_DESCRIPTION, __version__, "", (FRONT_DESK_SKILL,))

    def extended(self, definition: CardDefinition, sessions: Sequence[LiveSession] | None) -> pb.AgentCard:
        """The member card; with `sessions` (a local-harness key) the extension carries them."""
        card = self.member(definition)
        if sessions is not None:
            ext = next(e for e in card.capabilities.extensions if e.uri == EXTENSION_URI)
            ext.params.update({"sessions": [{"handle": sanitize_preview(s.handle), "liveness": s.liveness} for s in sessions]})
        return card


def _skill(spec: Mapping[str, Any]) -> pb.AgentSkill:
    skill = pb.AgentSkill(
        id=str(spec["id"]),
        name=str(spec.get("name") or spec["id"]),
        description=str(spec.get("description") or spec.get("name") or spec["id"]),
    )
    skill.tags.extend(str(t) for t in spec.get("tags", []) or [])
    skill.examples.extend(str(e) for e in spec.get("examples", []) or [])
    return skill


def card_json(card: pb.AgentCard) -> dict[str, Any]:
    """ProtoJSON, camelCase, with no v0.3 compatibility fields (D33). Fields without presence are
    printed, so `streaming: false` and `pushNotifications: false` are stated, not implied."""
    return json_format.MessageToDict(card, always_print_fields_with_no_presence=True)
