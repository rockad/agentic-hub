"""Start-up checks (spec 1.6, S1-AUTH): one function, a non-zero exit with a one-line reason.

`startup_check()` is what `app.main` calls before it serves. It:

1. reads the configuration (`config.load`); a variable that cannot be parsed, including an
   `A2A_ENV` that is not `dev` or `live`, ends the start with its one-line message;
2. runs the configuration conditions of spec 1.6 (`problems`), in the order the spec lists them;
3. calls `store.connect.check_database`, which waits for Postgres, brings both migration streams
   to head and refuses a schema newer than this code knows. That condition already lives there
   and is reused, not repeated here.

Any failure is `SystemExit("coordination: <reason>")`: the process exits with status 1 and the
reason is one line on stderr. The reason never contains a secret: it names a variable, not its
value, except for the few non-secret values it must quote (the stage, the env).

[design] choices where spec 1.6 is silent:

- "public listener enabled" is `Config.public_listener_enabled`: with `A2A_PUBLIC_LISTEN` unset it
  follows the stage (on from s2, spec 1.5); set to a value it is on; set to the empty string it is
  off. So `s1` plus a value, and `s2` or `s3` plus the empty string, are refused.
- "the public hostname" is the host of `A2A_PUBLIC_URL` when that is neither loopback nor a
  Tailscale name (`*.ts.net`): at s2 the public URL is the tailnet name, which `A2A_ALLOWED_HOSTS`
  must contain; only the Cloudflare hostname is refused before s3.
- the card id of an entry in the cards file is its `name` (the AgentCard field of spec 8.5). The
  full cards schema belongs to S1-A2A and S1-ID; this check only enforces what 1.6 states.
- "more than one worker" is checked on the number the caller passes (`workers`), because no
  environment variable sets it: `app.main` passes the value it hands to uvicorn.
"""

from __future__ import annotations

import ipaddress
import os
import re
from collections.abc import Callable, Mapping
from pathlib import Path
from urllib.parse import urlsplit

import yaml

from coordination.config import ENVS, Config, ConfigError

CARD_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}@[a-z0-9][a-z0-9-]{0,31}$")
TAILNET_SUFFIX = ".ts.net"


def _host_of(url_or_hostport: str) -> str | None:
    parts = urlsplit(url_or_hostport if "//" in url_or_hostport else f"//{url_or_hostport}")
    return parts.hostname.lower() if parts.hostname else None


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def public_hostname(public_url: str) -> str | None:
    """The Cloudflare-side hostname named by `A2A_PUBLIC_URL`, or None if it is loopback or a
    Tailscale name (see the module docstring)."""
    host = _host_of(public_url)
    if host is None or _is_loopback(host) or host.endswith(TAILNET_SUFFIX):
        return None
    return host


def cards_file_problem(path: str) -> str | None:
    """Why the cards file is unusable, or None. One line, no file content."""
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        return f"the cards file {path} cannot be read ({exc.strerror or type(exc).__name__})"
    except UnicodeDecodeError:
        return f"the cards file {path} is not UTF-8"
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError:
        return f"the cards file {path} is not valid YAML"
    if not isinstance(data, dict) or not isinstance(data.get("cards"), list):
        return f"the cards file {path} must be a mapping with a `cards` list"
    for index, card in enumerate(data["cards"]):
        if not isinstance(card, dict):
            return f"the cards file {path}: entry {index} is not a mapping"
        card_id = card.get("name")
        if not isinstance(card_id, str) or not CARD_ID.match(card_id):
            return f"the cards file {path}: entry {index} has no valid card id in `name` (expected <harness>@<machine>)"
    return None


def problems(config: Config, *, workers: int = 1) -> list[str]:
    """Every configuration condition of spec 1.6 that holds, as one-line reasons.

    The database condition (schema newer than the code) is not here: `check_database` owns it.
    """
    out: list[str] = []
    late = config.exposure_stage in ("s2", "s3")
    if late and not config.public_url.startswith("https://"):
        out.append(f"A2A_EXPOSURE_STAGE={config.exposure_stage} needs an https:// A2A_PUBLIC_URL")
    if late and not config.trusted_proxy_ips:
        out.append(f"A2A_EXPOSURE_STAGE={config.exposure_stage} needs A2A_TRUSTED_PROXY_IPS (no TLS proxy configured)")
    if late and not config.public_listener_enabled:
        out.append(f"A2A_EXPOSURE_STAGE={config.exposure_stage} needs the public listener (A2A_PUBLIC_LISTEN) enabled")
    if config.exposure_stage == "s1" and config.public_listener_enabled:
        out.append("A2A_EXPOSURE_STAGE=s1 must not enable the public listener (A2A_PUBLIC_LISTEN)")
    public = public_hostname(config.public_url)
    if config.exposure_stage != "s3" and public is not None:
        hosts = {_host_of(h) for h in config.allowed_hosts}
        if public in hosts:
            out.append("A2A_ALLOWED_HOSTS contains the public hostname before A2A_EXPOSURE_STAGE=s3")
    if config.env not in ENVS:
        out.append("A2A_ENV must be dev or live")
    if late and not config.enforce_tailnet_identity:
        out.append(f"A2A_EXPOSURE_STAGE={config.exposure_stage} needs A2A_ENFORCE_TAILNET_IDENTITY=1")
    if config.push_enabled and not config.push_enc_key:
        out.append("A2A_PUSH_ENABLED=1 needs A2A_PUSH_ENC_KEY")
    card_problem = cards_file_problem(config.cards_file)
    if card_problem is not None:
        out.append(card_problem)
    if workers > 1:
        out.append(f"{workers} workers are configured; exactly one is required")
    return out


def _fail(reason: str) -> SystemExit:
    # One line: a reason that somehow holds a newline is flattened, not split.
    return SystemExit("coordination: " + " ".join(reason.split()))


def startup_check(
    environ: Mapping[str, str] | None = None,
    *,
    workers: int = 1,
    check_db: Callable[[Config], None] | None = None,
) -> Config:
    """Load the configuration and check it; return it, or exit non-zero with one line.

    `check_db` defaults to `store.connect.check_database`.
    """
    try:
        config = Config.from_env(os.environ if environ is None else environ)
    except ConfigError as exc:
        raise _fail(str(exc)) from None
    found = problems(config, workers=workers)
    if found:
        raise _fail(found[0])
    if check_db is None:
        from coordination.store.connect import check_database

        check_db = check_database
    check_db(config)  # raises SystemExit with its own one-line reason
    return config
