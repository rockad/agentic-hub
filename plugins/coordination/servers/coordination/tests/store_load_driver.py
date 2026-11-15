"""A stand-in for the server under load, for the durability test (not a test itself).

Run as a subprocess by `test_store_durability.py`. It reads `A2A_DB_URL` and
`A2A_DB_PASSWORD_FILE` from the environment (the same two variables the server uses), creates
tasks from several concurrent writers and prints one line, `ACK <task id>`, after each create has
committed. The test kills this process with SIGKILL and then checks that every printed id is in the
database. A line is printed only after `create` returned, so an id on stdout is an acknowledged
write.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid

from a2a.types import a2a_pb2 as pb
from coordination.config import Config
from coordination.store import schema
from coordination.store.engine import make_engine
from coordination.store.task_store import CoordTaskStore, IndexEntry

WRITERS = 8


async def writer(store: CoordTaskStore, n: int) -> None:
    while True:
        task = pb.Task(id=str(uuid.uuid4()), context_id=str(uuid.uuid4()))
        task.status.state = pb.TaskState.TASK_STATE_SUBMITTED
        await store.create(task, IndexEntry(from_principal=f"writer-{n}", origin="local", to_card="claude-code@box"))
        sys.stdout.write(f"ACK {task.id}\n")
        sys.stdout.flush()


async def main() -> None:
    engine = make_engine(Config.from_env(os.environ))
    await schema.migrate_all(engine)
    store = CoordTaskStore(engine)
    sys.stdout.write("READY\n")
    sys.stdout.flush()
    await asyncio.gather(*(writer(store, n) for n in range(WRITERS)))


if __name__ == "__main__":
    asyncio.run(main())
