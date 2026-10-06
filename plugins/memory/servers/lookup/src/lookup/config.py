"""Runtime paths and settings, environment-driven.

Defaults are the in-container paths; compose maps core's real directories onto
them. Source trees are mounted read-only — the indexer has no business writing
to the archive it reads.

    /media/media2/lookup            -> /data
    /media/media2/takeout/extracted/Takeout -> /data/takeout   (ro)
    .../lookup/sources/...          -> /data/sources   (ro)
    .../lookup/converted            -> /data/converted (ro)

/media/media2/External is deliberately absent from that list and from
sources.toml. It is restricted data. See the header of sources.toml.
"""
from __future__ import annotations

import os
from pathlib import Path


def load_dotenv(start: Path | None = None) -> dict[str, str]:
    """Load `.env` from the repo root into the environment, without overriding.

    ⚠️ This exists because of a silent, plausible-looking failure. `docker
    compose` reads `.env` on its own, but nothing else does — so
    `uv run lookup mounts --write`, the one bring-up step that must not be
    skipped, ran with LOOKUP_HOME unset AND LOOKUP_MANIFEST unset, fell back to the
    packaged `sources.toml` (core's manifest, whose roots are container paths),
    generated mounts for `/data/converted` and friends, and **exited 0**. A
    wrong override file that looks right is worse than a crash.

    An already-set variable always wins, so an explicit `LOOKUP_DB=... lookup ...`
    still overrides the file. A relative `LOOKUP_*` path is resolved against the
    directory holding `.env`, so `LOOKUP_MANIFEST=sources-local.toml` works from
    anywhere without hard-coding where the repo was cloned.
    """
    here = (start or Path.cwd()).resolve()
    for d in [here, *here.parents]:
        env = d / ".env"
        if env.is_file():
            break
    else:
        return {}

    loaded: dict[str, str] = {}
    for raw in env.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        if not key or key in os.environ:
            continue
        if key.startswith("LOOKUP_") and val and not val.startswith("/"):
            val = str((env.parent / val).resolve())
        os.environ[key] = val
        loaded[key] = val
    return loaded


def _p(env: str, default: str) -> Path:
    return Path(os.environ.get(env, default))


# ⚠️ Called at import, BEFORE the paths below are read: every value here is
# resolved from the environment once, at module load, so a .env loaded
# afterwards would change nothing. LOOKUP_NO_DOTENV=1 skips it, which is what
# the tests use so a developer's own .env cannot reach them.
# ⚠️ A PI_* variable set in the environment is a HARD ERROR, not something to
# ignore. The names changed to LOOKUP_* when the project stopped being called
# personal-index, and a stale PI_MANIFEST silently ignored is the exact shape of
# a failure this project has already had: the command fell back to a different
# manifest, generated mounts for paths that do not exist here, and exited 0.
# Better to stop and name the new variable.
_RENAMED = {
    "PI_MANIFEST": "LOOKUP_MANIFEST",
    "PI_DB": "LOOKUP_DB",
    "PI_NO_DOTENV": "LOOKUP_NO_DOTENV",
    "PI_MAIL_MAX_BODY": "LOOKUP_MAIL_MAX_BODY",
}
_GONE = ("PI_TAKEOUT", "PI_SOURCES", "PI_CONVERTED", "PI_ARCHIVE")

_stale = [f"{k} is now {v}" for k, v in _RENAMED.items() if k in os.environ]
_stale += [f"{k} no longer exists — a manifest root resolves any ${{VAR}}, so "
           f"declare whatever variable you want and use it there"
           for k in _GONE if k in os.environ]
if _stale:
    raise SystemExit(
        "lookup: stale personal-index environment variable(s):\n  "
        + "\n  ".join(_stale)
        + "\nUnset them, or rename them, and try again. Ignoring one silently "
          "is how a wrong manifest got used once already.")

if not os.environ.get("LOOKUP_NO_DOTENV"):
    load_dotenv()

DB = _p("LOOKUP_DB", "/data/index.db")

_default_manifest = Path(__file__).resolve().parents[2] / "sources.toml"
if not _default_manifest.is_file():
    _example = Path(__file__).resolve().parents[2] / "sources.example.toml"
    if _example.is_file():
        _default_manifest = _example
MANIFEST = _p("LOOKUP_MANIFEST", str(_default_manifest))
SCHEMA = Path(__file__).with_name("schema.sql")

# Cap per mail message. Whole 10 MB newsletters add index bloat, not recall.
MAIL_MAX_BODY = int(os.environ.get("LOOKUP_MAIL_MAX_BODY", "60000"))

# ⚠️ No placeholder table any more. A manifest root resolves ${VAR} from the
# environment, ANY variable, so there is nothing left for this to bless. It
# held PI_TAKEOUT, PI_SOURCES, PI_CONVERTED and PI_ARCHIVE — one per kind of
# material, which is exactly the special-casing the generic-sources rule
# removed. Kept as an empty mapping so `manifest._expand`'s legacy lookup still
# has something to miss against.
PLACEHOLDERS: dict[str, Path] = {}
