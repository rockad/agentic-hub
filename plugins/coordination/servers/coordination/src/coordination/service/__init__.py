"""The service layer (S1-STATE): task behaviour, called identically by `/a2a/v1` and `/mcp`."""

from coordination.service.directory import Directory
from coordination.service.errors import ServiceError
from coordination.service.ports import ListenerView, NoListeners
from coordination.service.protocol import ServiceLayer, TaskService
from coordination.service.service import CoordinationService
from coordination.service.states import Actor, State
from coordination.service.types import (
    LOCAL_HARNESS,
    REMOTE_PEER,
    Caller,
    InboxItem,
    InboxResult,
    ServiceSettings,
    SweepResult,
    WakeSnapshot,
)

__all__ = [
    "LOCAL_HARNESS",
    "REMOTE_PEER",
    "Actor",
    "Caller",
    "CoordinationService",
    "Directory",
    "InboxItem",
    "InboxResult",
    "ListenerView",
    "NoListeners",
    "ServiceError",
    "ServiceLayer",
    "ServiceSettings",
    "State",
    "SweepResult",
    "TaskService",
    "WakeSnapshot",
]
