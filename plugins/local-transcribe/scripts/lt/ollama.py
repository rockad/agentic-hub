"""One client for the local Ollama, used by the on-screen text reader.

Nothing here reaches any network but the loopback address in `OLLAMA_URL`.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_URL = "http://127.0.0.1:11434"


class OllamaError(RuntimeError):
    """A request reached Ollama and came back unusable."""


def url() -> str:
    return os.environ.get("LOCAL_TRANSCRIBE_OLLAMA_URL", DEFAULT_URL).rstrip("/")


def _get(path: str, timeout: float) -> dict | None:
    try:
        with urllib.request.urlopen(f"{url()}{path}", timeout=timeout) as response:
            return json.loads(response.read())
    except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError):
        return None


def reachable(timeout: float = 3.0) -> bool:
    return _get("/api/tags", timeout) is not None


def installed_models(timeout: float = 5.0) -> list[str] | None:
    """Every model tag this Ollama already holds, or None if it is unreachable.

    None and `[]` mean different things — unreachable versus running with
    nothing pulled — and the caller has a different sentence for each.
    """
    body = _get("/api/tags", timeout)
    if body is None:
        return None
    return [m.get("name", "") for m in body.get("models", []) if m.get("name")]


def has_model(name: str, *, installed: list[str] | None = None) -> bool:
    """Is `name` pulled? `llava` matches `llava:latest`, as the CLI treats them.

    Asked before a stage starts rather than discovered from a 404 halfway
    through, because pulling a vision model is a multi-gigabyte download and the
    person deserves to be told that before an hour of recognition, not after.
    """
    tags = installed if installed is not None else installed_models()
    if not tags:
        return False
    wanted = name if ":" in name else f"{name}:latest"
    return any(tag == wanted or tag == name for tag in tags)


def generate(
    model: str,
    prompt: str,
    *,
    images: list[str] | None = None,
    timeout: float = 600.0,
    temperature: float = 0.2,
    think: bool = False,
    num_ctx: int | None = None,
    keep_alive: str | None = None,
) -> str:
    """One non-streaming completion. `images` are raw base64, no data: prefix.

    `num_ctx` is worth setting explicitly whenever images are involved: the
    daemon's default window is small, an image costs the same budget as text,
    and the overflow is silent — the model simply answers from the part of the
    picture that fitted. `keep_alive` holds the weights in memory between calls,
    which on a frame-by-frame run is the difference between loading a 6 GB model
    once and loading it forty times.
    """
    options: dict = {"temperature": temperature}
    if num_ctx:
        options["num_ctx"] = num_ctx
    payload: dict = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": options,
        "think": think,
    }
    if images:
        payload["images"] = images
    if keep_alive:
        payload["keep_alive"] = keep_alive

    request = urllib.request.Request(
        f"{url()}/api/generate",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace").strip()
        raise OllamaError(f"Ollama returned HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError) as exc:
        raise OllamaError(f"the Ollama request failed: {exc}") from exc

    return (body.get("response") or "").strip()


def residency(model: str, timeout: float = 3.0) -> str | None:
    """Where the loaded model actually sits, read off `/api/ps`.

    "It should use the GPU" is not an answer anyone can act on. `size_vram`
    against `size` is the daemon's own account of how much of the weights it got
    onto the accelerator, and a model that quietly fell back to system memory is
    the difference between seconds and minutes per frame.
    """
    body = _get("/api/ps", timeout)
    if not body:
        return None
    for entry in body.get("models", []):
        name = entry.get("name") or entry.get("model") or ""
        if name != model and not name.startswith(f"{model}:"):
            continue
        total = int(entry.get("size") or 0)
        vram = int(entry.get("size_vram") or 0)
        if total <= 0:
            return None
        if vram >= total:
            return "GPU"
        if vram <= 0:
            return "CPU"
        return f"{vram / total:.0%} GPU"
    return None


__all__ = [
    "DEFAULT_URL", "OllamaError", "generate", "has_model", "installed_models",
    "reachable", "residency", "url",
]
