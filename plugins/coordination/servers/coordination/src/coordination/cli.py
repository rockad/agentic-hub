"""`a2a-coord` command line skeleton.

Admin commands (key, review, status, card check, db init-dump-role, install) are added by
S1-ADMIN, S1-PG and S1-INST. S1-SCAF ships only the entry point.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence

from coordination import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="a2a-coord", description="A2A coordination server admin")
    parser.add_argument("--version", action="version", version=f"a2a-coord {__version__}")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    parser.parse_args(argv)
    parser.print_help()
    return 0
