#!/usr/bin/env python3
"""Build Antigravity plugin release .zip archives and a zip-indexed marketplace.json.

Reads the repository's source-tree root `marketplace.json` and each listed plugin's
`plugin.json`, packages each plugin into a deterministic `.zip` (preserving POSIX
executable permissions and excluding build/cache/secret directories), computes SHA-256
digests, and writes an Antigravity-compatible `marketplace.json` + `SHA256SUMS.txt`
into `--out-dir` for attachment to a GitHub Release.

Never mutates root `marketplace.json` or `.claude-plugin/marketplace.json`, keeping
Claude Code and repo tree-based installs intact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

EXCLUDED_DIRS = frozenset(
    {
        ".git",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        ".pytest_cache",
        ".ruff_cache",
        ".mypy_cache",
        ".turbo",
        "dist",
    }
)

EXCLUDED_FILES = frozenset({".env", ".DS_Store"})
EXCLUDED_SUFFIXES = (".pyc", ".pyo")

# Fixed timestamp for deterministic zip archives (reproducible SHA-256 sums).
DETERMINISTIC_ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def should_skip_dir(name: str) -> bool:
    return name in EXCLUDED_DIRS


def should_skip_file(name: str) -> bool:
    return name in EXCLUDED_FILES or name.endswith(EXCLUDED_SUFFIXES)


def build_plugin_zip(plugin_dir: Path, plugin_name: str, zip_path: Path) -> str:
    """Create a deterministic zip for `plugin_dir` rooted at `<plugin_name>/` and return sha256."""
    files: list[Path] = []
    for root, dirs, filenames in os.walk(plugin_dir, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not should_skip_dir(d))
        root_path = Path(root)
        for filename in sorted(filenames):
            if should_skip_file(filename):
                continue
            files.append(root_path / filename)

    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for file_path in files:
            rel = file_path.relative_to(plugin_dir).as_posix()
            arcname = f"{plugin_name}/{rel}"
            st = os.lstat(file_path)

            info = zipfile.ZipInfo(filename=arcname, date_time=DETERMINISTIC_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # Unix

            if stat.S_ISLNK(st.st_mode):
                resolved = file_path.resolve(strict=True)
                plugin_root = plugin_dir.resolve(strict=True)
                if not resolved.is_relative_to(plugin_root):
                    raise ValueError(f"Symlink escapes plugin directory: {file_path} -> {resolved}")
                if not resolved.is_file():
                    continue
                target_mode = stat.S_IMODE(resolved.stat().st_mode)
                info.external_attr = (stat.S_IFREG | target_mode) << 16
                zf.writestr(info, resolved.read_bytes())
            else:
                mode = stat.S_IMODE(st.st_mode)
                info.external_attr = (stat.S_IFREG | mode) << 16
                zf.writestr(info, file_path.read_bytes())

    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    return digest


def build_marketplace(
    repo_root: Path,
    out_dir: Path,
    tag: str,
    repo: str,
    plugin_filter: set[str] | None = None,
) -> dict:
    root_mp_path = repo_root / "marketplace.json"
    root_mp = json.loads(root_mp_path.read_text(encoding="utf-8"))

    out_dir.mkdir(parents=True, exist_ok=True)
    release_plugins: list[dict] = []
    checksum_lines: list[str] = []

    for entry in root_mp.get("plugins", []):
        name = entry.get("name") or entry.get("id")
        if not name:
            raise ValueError(f"Marketplace entry missing name/id: {entry}")
        if plugin_filter and name not in plugin_filter:
            continue

        rel_path = entry.get("path") or f"plugins/{name}"
        plugin_dir = repo_root / rel_path
        manifest_path = plugin_dir / "plugin.json"
        if not manifest_path.is_file():
            raise FileNotFoundError(f"Missing plugin.json for {name}: {manifest_path}")

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        version = manifest.get("version") or entry.get("version")
        if not version:
            raise ValueError(f"Missing version for plugin {name}")

        zip_filename = f"{name}-{version}.zip"
        zip_path = out_dir / zip_filename
        sha256 = build_plugin_zip(plugin_dir, name, zip_path)
        checksum_lines.append(f"{sha256}  {zip_filename}")

        download_url = f"https://github.com/{repo}/releases/download/{tag}/{zip_filename}"
        release_plugins.append(
            {
                "name": name,
                "description": entry.get("description") or manifest.get("description", ""),
                "version": version,
                "source": {
                    "url": download_url,
                    "sha256": sha256,
                },
            }
        )

    if not release_plugins:
        raise RuntimeError("No plugins were packaged (check --plugins filter and marketplace.json)")

    release_mp = {
        "$schema": root_mp.get("$schema", "https://antigravity.google/schemas/marketplace.json"),
        "name": root_mp.get("name", "Rockad Agentic Hub Marketplace"),
        "description": root_mp.get("description", ""),
        "repository": root_mp.get("repository", f"https://github.com/{repo}.git"),
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "plugins": release_plugins,
    }

    mp_out = out_dir / "marketplace.json"
    mp_out.write_text(json.dumps(release_mp, indent=2) + "\n", encoding="utf-8")

    sums_out = out_dir / "SHA256SUMS.txt"
    sums_out.write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")

    return release_mp


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Path to the agentic-hub repository root.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("dist/agy-release"),
        help="Output directory for plugin .zip archives, marketplace.json, and SHA256SUMS.txt.",
    )
    parser.add_argument(
        "--tag",
        required=True,
        help="GitHub Release tag used in source.url (e.g. agy-marketplace-v2026.11.26).",
    )
    parser.add_argument(
        "--repo",
        default="rockad/agentic-hub",
        help="GitHub owner/repo slug (default: rockad/agentic-hub).",
    )
    parser.add_argument(
        "--plugins",
        default="",
        help="Optional comma-separated subset of plugin names to package (default: all).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    plugin_filter = {p.strip() for p in args.plugins.split(",") if p.strip()} or None
    out_dir = args.out_dir if args.out_dir.is_absolute() else args.repo_root / args.out_dir
    release_mp = build_marketplace(
        repo_root=args.repo_root,
        out_dir=out_dir,
        tag=args.tag,
        repo=args.repo,
        plugin_filter=plugin_filter,
    )
    print(f"Packaged {len(release_mp['plugins'])} plugins into {out_dir}")
    for p in release_mp["plugins"]:
        print(f"  - {p['name']}@{p['version']} sha256={p['source']['sha256'][:12]}...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
