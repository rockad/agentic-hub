# coordination server

The A2A 1.0.1 coordination server of the `coordination` plugin. One Python process, one uvicorn worker, managed with `uv`, shipped as a Docker image. The plugin README and `docs/specs/server-api.md` describe the whole design; this directory holds the code.

Layout under `src/coordination/`:

- `app.py`, `config.py`, `cli.py`, `healthcheck.py`, `clock.py`: the S1-SCAF skeleton.
- `service/`, `store/`, `wake/`: typed protocols (`protocol.py`) that later streams code against.
- `mcp/`, `auth/`: empty packages owned by S1-MCP and S1-AUTH.

Local use:

- `uv sync` then `uv run pytest`.
- `uv run python -m coordination` serves `/healthz` on `A2A_LISTEN` (default `0.0.0.0:8120`).
