"""`a2a-coord status` and `a2a-coord card check`, server side (S1-ADMIN; spec 3.7, 8.3).

Both are read-only. `status` is counts and identifiers: no task body, no key secret, no hash.

`status` fields (spec 3.7: sessions, parked listeners, pending counts, wake budgets, stale offers,
schema version; "additions [design]"), and which ones are filled today:

| field | source | today |
| --- | --- | --- |
| `sessions` | the `sessions` table, and `mcp_sessions` (the in-memory `Mcp-Session-Id` map) | real; the table stays empty until S1-ID registers sessions |
| `listeners` | `parked` from the parked-listener table | `null` until S1-WAKE provides one (`listener_count`) |
| `pending` | `task_index` joined to the SDK `tasks` table | real |
| `budgets` | the `wakes` table, last hour, against `A2A_WAKE_BUDGET_PER_H` | real; empty until S1-WAKE writes wakes |
| `stale_offers` | `SUBMITTED` tasks offered `A2A_REOFFER_MAX` times [design] | real |
| `schema` | `coord_schema_version` and the SDK's Alembic revision | real |
| `backup` | `dump_age_h` from the dump sidecar's `last_ok` file (`null` = unknown) | real |

`card check` [design: the spec names the command and nothing else] checks that what the cards file
defines is what the server serves and what the keys point at:

- every defined card builds, and says only what the server does (streaming off at S1, push as
  configured, extended card, the 60 s deviation sentence, interface URLs from `A2A_PUBLIC_URL`
  and never the listen address, tenant equal to the card id);
- every defined card is in the `cards` table (the service layer reads the table, loaded at start);
- every live key's card (`local-harness`) and every card in a `remote-peer` allowlist is defined.

It returns `problems` (each makes `ok` false) and `notes` (information: a card in the table that is
no longer in the file, a defined card with no live session).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from a2a.server.models import TaskModel
from a2a.types import a2a_pb2 as pb
from coordination.a2a.cards import CardBuilder, CardRegistry, deviation_sentence
from coordination.admin.keystore import KeyAdminStore
from coordination.backup_status import status_fields
from coordination.clock import Clock
from coordination.config import Config
from coordination.service.directory import ACTIVE_WINDOW
from coordination.store import schema
from coordination.store.tables import cards as cards_table
from coordination.store.tables import sessions, task_index, wakes

S = pb.TaskState
STALE_OFFER_LIST = 20
WAKE_WINDOW = timedelta(hours=1)


class StatusAdmin:
    def __init__(
        self,
        config: Config,
        clock: Clock,
        engine: AsyncEngine,
        keys: KeyAdminStore,
        registry: CardRegistry,
        *,
        mcp_session_count: Callable[[], int] | None = None,
        listener_count: Callable[[], int] | None = None,
    ) -> None:
        self._config = config
        self._clock = clock
        self._engine = engine
        self._keys = keys
        self._registry = registry
        self._mcp_session_count = mcp_session_count
        self._listener_count = listener_count

    # -- status -----------------------------------------------------------------------------

    async def status(self) -> dict[str, Any]:
        now = self._clock.now()
        tm = TaskModel
        state = tm.status["state"].as_string()
        submitted = state == S.Name(S.TASK_STATE_SUBMITTED)
        ix = task_index
        reoffer_max = self._config.reoffer_max
        stale = sa.and_(submitted, ix.c.hold.is_(None), ix.c.offer_count >= reoffer_max)
        joined = ix.join(tm.__table__, tm.id == ix.c.task_id)

        def count(cond: sa.ColumnElement[bool]) -> sa.ColumnElement[int]:
            return sa.func.coalesce(sa.func.sum(sa.case((cond, 1), else_=0)), 0)

        async with self._engine.connect() as conn:
            pending = (
                await conn.execute(
                    sa.select(
                        count(sa.and_(submitted, ix.c.hold.is_(None))),
                        count(
                            sa.and_(
                                submitted, ix.c.hold.is_(None), ix.c.addressing == "card", ix.c.to_handle.is_(None)
                            )
                        ),
                        count(sa.and_(ix.c.hold.is_not(None), state == S.Name(S.TASK_STATE_INPUT_REQUIRED))),
                        count(sa.and_(state == S.Name(S.TASK_STATE_WORKING), ix.c.hold.is_(None))),
                    ).select_from(joined)
                )
            ).one()
            per_card = (
                await conn.execute(
                    sa.select(ix.c.to_card, sa.func.count())
                    .select_from(joined)
                    .where(submitted, ix.c.hold.is_(None))
                    .group_by(ix.c.to_card)
                    .order_by(ix.c.to_card)
                )
            ).all()
            stale_rows = (
                await conn.execute(
                    sa.select(ix.c.task_id, ix.c.to_card, ix.c.offer_count, ix.c.last_offered_at)
                    .select_from(joined)
                    .where(stale)
                    .order_by(ix.c.last_offered_at, ix.c.task_id)
                    .limit(STALE_OFFER_LIST)
                )
            ).all()
            stale_total = (await conn.execute(sa.select(count(stale)).select_from(joined))).scalar_one()
            session_rows = (
                await conn.execute(
                    sa.select(
                        sessions.c.card_id,
                        count(sessions.c.last_seen_at >= now - ACTIVE_WINDOW),
                        sa.func.count(),
                    )
                    .where(sessions.c.ended_at.is_(None))
                    .group_by(sessions.c.card_id)
                    .order_by(sessions.c.card_id)
                )
            ).all()
            ended = (
                await conn.execute(sa.select(sa.func.count()).select_from(sessions).where(sessions.c.ended_at.is_not(None)))
            ).scalar_one()
            wake_rows = (
                await conn.execute(
                    sa.select(wakes.c.handle, sa.func.count())
                    .where(wakes.c.at >= now - WAKE_WINDOW)
                    .group_by(wakes.c.handle)
                    .order_by(sa.func.count().desc(), wakes.c.handle)
                )
            ).all()
        versions = await schema.versions(self._engine)
        registered = sum(int(r[2]) for r in session_rows)
        return {
            "now": now.isoformat(),
            "stage": self._config.exposure_stage,
            "env": self._config.env,
            "sessions": {
                "registered": registered,
                "active": sum(int(r[1]) for r in session_rows),
                "ended": int(ended),
                "by_card": [{"card": r[0], "registered": int(r[2]), "active": int(r[1])} for r in session_rows],
                "mcp_bound": self._mcp_session_count() if self._mcp_session_count else None,
            },
            "listeners": {"parked": self._listener_count() if self._listener_count else None},
            "pending": {
                "submitted": int(pending[0]),
                "card_queue": int(pending[1]),
                "held": int(pending[2]),
                "working": int(pending[3]),
                "by_card": [{"card": r[0], "submitted": int(r[1])} for r in per_card],
            },
            "budgets": {
                "wake_per_hour_limit": self._config.wake_budget_per_h,
                "window_minutes": int(WAKE_WINDOW.total_seconds() // 60),
                "used": [
                    {"handle": r[0], "wakes": int(r[1]), "remaining": max(self._config.wake_budget_per_h - int(r[1]), 0)}
                    for r in wake_rows
                ],
            },
            "stale_offers": {
                "reoffer_max": reoffer_max,
                "count": int(stale_total),
                "tasks": [
                    {
                        "task_id": r[0],
                        "card": r[1],
                        "offer_count": int(r[2]),
                        "last_offered_at": r[3].isoformat() if r[3] else None,
                    }
                    for r in stale_rows
                ],
            },
            "schema": {"coord_schema_version": versions.coord_schema_version, "sdk_revision": versions.sdk_revision},
            "backup": status_fields(self._config.dump_last_ok_file, now),
        }

    # -- card check -------------------------------------------------------------------------

    async def card_check(self) -> dict[str, Any]:
        problems: list[str] = []
        notes: list[str] = []
        config, registry = self._config, self._registry
        if not registry.ids():
            problems.append("the cards file defines no card")

        builder = CardBuilder(config)
        sentence = deviation_sentence(config.send_block_max_s)
        for card_id in registry.ids():
            definition = registry.get(card_id)
            assert definition is not None
            for message in _card_problems(builder.member(definition), card_id, config, sentence):
                problems.append(f"{card_id}: {message}")

        async with self._engine.connect() as conn:
            in_table = {r[0] for r in (await conn.execute(sa.select(cards_table.c.card_id))).all()}
            live = dict(
                (
                    await conn.execute(
                        sa.select(sessions.c.card_id, sa.func.count())
                        .where(sessions.c.ended_at.is_(None))
                        .group_by(sessions.c.card_id)
                    )
                ).all()
            )
        defined = set(registry.ids())
        for card_id in sorted(defined - in_table):
            problems.append(f"{card_id}: defined in the cards file but not in the cards table (restart the server)")
        for card_id in sorted(in_table - defined):
            notes.append(f"{card_id}: in the cards table but not in the cards file (kept on purpose, spec 1.3)")
        for card_id in sorted(defined):
            if not live.get(card_id):
                notes.append(f"{card_id}: no live session")

        now = self._clock.now()
        for key in await self._keys.list_all():
            if key.revoked_at is not None or key.expires_at <= now:
                continue
            named = [key.card_id] if key.card_id else list(key.cards_allowed or ())
            for card_id in named:
                if card_id not in defined | in_table:
                    problems.append(f"key {key.key_id} ({key.scope}) names the undefined card {card_id}")
        return {
            "ok": not problems,
            "problems": problems,
            "notes": notes,
            "cards": [
                {"card_id": c, "in_table": c in in_table, "live_sessions": int(live.get(c, 0))}
                for c in registry.ids()
            ],
        }


def _card_problems(card: pb.AgentCard, card_id: str, config: Config, sentence: str) -> list[str]:
    out: list[str] = []
    for field in ("name", "description", "version"):
        if not getattr(card, field):
            out.append(f"the built card has no {field}")
    if not card.skills:
        out.append("the built card has no skill")
    if not card.default_input_modes or not card.default_output_modes:
        out.append("the built card has no input or output modes")
    if card.capabilities.streaming:
        out.append("the card says streaming is on; nothing serves it at S1")
    if card.capabilities.push_notifications != config.push_enabled:
        out.append("the card's push flag differs from A2A_PUSH_ENABLED")
    if not card.capabilities.extended_agent_card:
        out.append("the card does not advertise the extended card")
    if sentence not in card.description:
        out.append("the card lacks the 60 s deviation sentence")
    if not card.supported_interfaces:
        out.append("the card has no interface")
    expected = config.public_url.rstrip("/") + "/a2a/v1"
    for interface in card.supported_interfaces:
        if interface.url != expected:
            out.append(f"interface URL {interface.url} is not {expected}")
        if config.listen and config.listen in interface.url and config.listen not in config.public_url:
            out.append("an interface URL contains the listen address")
        if interface.tenant != card_id:
            out.append(f"interface tenant {interface.tenant!r} is not the card id")
    return out
