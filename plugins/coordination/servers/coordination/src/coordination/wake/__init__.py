"""The wake path (S1-WAKE; spec 7): the listener table, the wake decision, the budget, the
confirmation, and the two endpoints.

- `table`: `ListenerTable`, one parked `/wake/listen` request per handle (newest wins). It is also
  the `ListenerView` the service layer, the MCP tools and `GET /sessions` read.
- `service`: `WakeService`: parks listeners, decides a wake (pending set, in flight, budget,
  anti-loop), confirms wakes, answers `/wake/pending`. It is the `Notifier` the service layer calls.
- `routes`: `POST /wake/listen`, `GET|POST /wake/pending` (`WakeEndpoint`).
- `store`: the `wakes` table as the budget and the confirmation use it.
- `rules`: the anti-loop rule, the announce dedupe, the park limiter.
- `outcomes`: how a parked request ends (`Release`); the only body is an integer.
- `protocol`: the `Notifier` interface (S1-STATE's).

This package `__init__` imports nothing from the other streams on purpose: the service layer
imports `coordination.wake.protocol`, and `wake.service` imports the identity package, which
imports the service layer. Import `coordination.wake.service`, `.routes` and `.build` explicitly.

Docs: docs/specs/wake.md.
"""
