"""No acknowledged write is lost: the SP5b D8 criterion, kept as a regression test (S1-STORE).

Two cases, both against the throwaway Postgres container:
- the server process is killed with SIGKILL in the middle of a write load;
- the Postgres server process is killed with SIGKILL in the middle of a write load, started again,
  and the same store object (same pool) carries on.

An id counts as acknowledged only once `create` returned, so each one must be in the database.
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

from conftest import run
from coordination.store.task_store import CoordTaskStore
from store_helpers import entry, migrated_engine, new_task

DRIVER = Path(__file__).with_name("store_load_driver.py")
MIN_ACKS = 60


def _present_ids(pg_server, db: str) -> set[str]:
    out = pg_server.psql(db, "SELECT task_id FROM task_index")
    return set(out.split()) if out else set()


def test_kill_9_of_the_server_process_mid_load_loses_no_acked_write(pg_server, config):
    db = config.db_url.rsplit("/", 1)[1]
    env = {
        "PATH": os.environ.get("PATH", ""),
        "A2A_DB_URL": config.db_url,
        "A2A_DB_PASSWORD_FILE": config.db_password_file,
    }
    proc = subprocess.Popen(
        [sys.executable, str(DRIVER)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env
    )
    acked: list[str] = []
    ready = threading.Event()
    enough = threading.Event()

    def read() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            if not line.endswith("\n"):
                break  # a line cut by the kill is not an acknowledgement
            line = line.strip()
            if line == "READY":
                ready.set()
            elif line.startswith("ACK "):
                acked.append(line[4:])
                if len(acked) >= MIN_ACKS:
                    enough.set()

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        assert ready.wait(60), "the load driver did not start"
        assert enough.wait(60), "the load driver did not acknowledge enough writes"
        proc.send_signal(signal.SIGKILL)
        proc.wait(timeout=10)
    finally:
        if proc.poll() is None:
            proc.kill()
        reader.join(timeout=10)
    assert proc.returncode == -signal.SIGKILL
    assert len(acked) >= MIN_ACKS
    missing = set(acked) - _present_ids(pg_server, db)
    assert not missing, f"{len(missing)} acknowledged tasks are not in the database"

    async def integrity():
        async with migrated_engine(config) as engine:
            return await CoordTaskStore(engine).check_integrity()

    assert run(integrity()).ok  # no task without its version row or index row after the kill


def test_kill_9_of_postgres_mid_load_loses_no_acked_write_and_the_pool_recovers(pg_server, config):
    db = config.db_url.rsplit("/", 1)[1]

    async def go():
        acked: set[str] = set()
        failed: list[int] = []
        async with migrated_engine(config) as engine:
            store = CoordTaskStore(engine)
            stop = asyncio.Event()

            async def writer(n: int) -> None:
                while not stop.is_set():
                    task = new_task()
                    try:
                        await store.create(task, entry(sender=f"w{n}"))
                    except Exception:  # noqa: BLE001 - the database is away; this write was not acked
                        failed.append(n)
                        await asyncio.sleep(0.2)
                        continue
                    acked.add(task.id)

            writers = [asyncio.create_task(writer(n)) for n in range(6)]
            while len(acked) < MIN_ACKS:
                await asyncio.sleep(0.05)
            before_kill = len(acked)
            await asyncio.to_thread(pg_server.crash)
            await asyncio.sleep(1.0)
            await asyncio.to_thread(pg_server.start_again)
            target = len(acked) + MIN_ACKS  # writes acknowledged AFTER the restart
            while len(acked) < target:
                await asyncio.sleep(0.05)
            stop.set()
            await asyncio.gather(*writers)
            integrity = await store.check_integrity()
            return set(acked), before_kill, integrity, len(failed)

    acked, before_kill, integrity, failed = run(go())
    assert failed > 0  # positive control: the writers really did hit the crash
    assert len(acked) >= before_kill + MIN_ACKS  # the same pool wrote again after the crash
    missing = acked - _present_ids(pg_server, db)
    assert not missing, f"{len(missing)} acknowledged tasks are not in the database"
    assert integrity.ok


def test_a_clean_restart_of_the_postgres_container_loses_nothing(pg_server, config):
    db = config.db_url.rsplit("/", 1)[1]

    async def go():
        async with migrated_engine(config) as engine:
            store = CoordTaskStore(engine)
            ids = []
            for _ in range(40):
                task = new_task()
                await store.create(task, entry())
                ids.append(task.id)
            await asyncio.to_thread(pg_server.restart)
            # The first use of the pool after the restart must work (pool_pre_ping).
            late = new_task()
            await store.create(late, entry())
            ids.append(late.id)
            return ids

    ids = run(go())
    assert set(ids) <= _present_ids(pg_server, db)
