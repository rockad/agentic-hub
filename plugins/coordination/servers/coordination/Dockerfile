# Portable image: no host name inside, where it runs is configuration (decision 23).
# Base image python:3.14-slim, so the dev box and the image run the same interpreter.

FROM python:3.14-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.31 /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src

# Dependencies first, so this layer is cached until pyproject.toml or uv.lock change.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-install-project

COPY src/ ./src/
COPY tests/ ./tests/

# Tests run here, in the build stage, with the dev group. A failing test fails the build.
RUN uv sync --frozen && uv run --frozen pytest

# The runtime tree: no dev group, project installed non-editable so src/ is not needed.
RUN uv sync --frozen --no-dev --no-editable


FROM python:3.14-slim

# Non-root user. /data is created owned by it, so a fresh named volume inherits that
# ownership on first mount. The volume holds go-live import artefacts only.
RUN groupadd --system --gid 10001 a2a && \
    useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin a2a && \
    mkdir /data /run/a2a && \
    chown a2a:a2a /data /run/a2a

COPY --from=build /app/.venv /app/.venv

ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER a2a
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8120

CMD ["python3", "-m", "coordination"]
