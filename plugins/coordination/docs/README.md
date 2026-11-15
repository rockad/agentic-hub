# Coordination plugin docs: map

There are exactly two live planning documents. Everything else is reference or archive.

- [`plans/master-plan.md`](plans/master-plan.md): the whole plan. Workstreams and acceptance (section 4), the dependency DAG, parallelisation, traceability, effort, the go-live migration, the git history rewrite, decision records, decision rounds, and the waves and workflow process.
- [`plans/master-tasklist.md`](plans/master-tasklist.md): the status and todo. How to pick up, status at a glance, milestones, stream status tables, todo checkboxes, open items and risks, and this map.
- [`specs/`](specs/): contracts and spike plans. `server-api.md` (the API), `spikes.md`, `audit-events.md`, `status-client.md`, `buildslot-spec.md`, and `heartbeat-spec.md` (historical).
- [`research/`](research/): evidence. Audits, spike results and spike runbooks. Read-only records.
- [`runbooks/`](runbooks/): operations. `backup.md`.
- [`archive/`](archive/): superseded history, see [`archive/README.md`](archive/README.md).

Rules:

- New status goes in `plans/master-tasklist.md`.
- New design goes in `plans/master-plan.md`.
- Do not add a third planning document.
- Docs updates go straight to `main`; stream code goes one pull request per stream.
