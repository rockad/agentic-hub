# Multi-arch (linux/amd64 + linux/arm64) with NO emulation.
#
# The build stage is pinned to --platform=$BUILDPLATFORM, so every RUN executes
# on the builder's own architecture and is never emulated. This project is pure
# Python with no compiled dependencies, so its installed tree is architecture-
# independent and can simply be COPYed into the target image, whose stages
# contain no RUN at all.
#
# That matters concretely: `core` is a Raspberry Pi whose only x86 binfmt
# handler is **box86**, a 32-bit emulator that cannot execute amd64 (an amd64
# container there fails with `exec format error`). Emulating amd64 would have
# meant registering qemu-x86_64 via a privileged container — root on a box
# running live Home Assistant, needing re-registration after every reboot, and
# risking a clash with the existing box86 handler. None of that is necessary.

FROM --platform=$BUILDPLATFORM python:3.14-slim AS build
WORKDIR /src

COPY pyproject.toml sources.example.toml README.md ./
RUN cp sources.example.toml sources.toml
COPY src/ ./src/
COPY tests/ ./tests/

# Tests run here, once, on the build architecture. There is nothing
# architecture-specific to test, so running them per-target arch would only
# cost time.
#
# The image tracked 3.11 while the dev box ran 3.14, deliberately, so the build
# would reject syntax only the newer interpreter accepts (a backslash inside an
# f-string expression, hit for real). Both are 3.14 now, so that guard is gone
# along with the mismatch it guarded against: a local test pass and a build test
# pass finally mean the same thing. The cost is that a syntax error is no longer
# caught by version skew — if the dev box ever moves ahead of this pin again,
# restore the older pin here rather than letting the two drift silently.
RUN pip install --no-cache-dir --target /out . && \
    PYTHONPATH=/out \
      LOOKUP_MANIFEST=/src/sources.toml python3 -m unittest discover -s tests -t . && \
    python3 -c "import sqlite3; c=sqlite3.connect(':memory:'); \
      c.execute('CREATE VIRTUAL TABLE t USING fts5(x)'); print('FTS5', sqlite3.sqlite_version)"


FROM python:3.14-slim
WORKDIR /app

# ⚠️ The ONE `RUN` in a target stage, and the reason the no-emulation claim
# above is now narrower than it was.
#
# `cifs-utils` supplies /sbin/mount.cifs, without which the kernel cannot mount
# a cifs share and `lookup.shares` can only report that it is missing. It has
# to be here rather than in the build stage because it is a runtime binary for
# the TARGET architecture, so this layer is the only thing a cross-build would
# have to emulate. Both machines that run this image are arm64 and build
# natively, so nothing is emulated in practice; an amd64 cross-build from an
# arm64 host would emulate this apt step alone.
#
# The share is mounted from inside the container, not by Docker, because a
# Docker volume is fixed when the container is created: a volume-backed source
# makes the container refuse to start whenever the share is unreachable, and
# needs a manual recreate when it returns. See `src/lookup/shares.py`.
RUN apt-get update && \
    apt-get install -y --no-install-recommends cifs-utils && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /out /app/lib
COPY --from=build /src/sources.toml /app/sources.toml

VOLUME ["/data"]

ENV PYTHONPATH=/app/lib \
    LOOKUP_DB=/data/index.db \
    LOOKUP_MANIFEST=/app/sources.toml \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["python3", "-m", "lookup.cli"]
CMD ["--help"]
