"""Static scanners for the security suite (S1-SEC).

Two scanners, both pure functions over source text so a meta-test can feed them a snippet:

- `scan_python(source)`: the Python half of "no code path launches, drives or messages a harness
  process" (api 9, D9, DDR-003). It reads the syntax tree, so a docstring or a comment that only
  talks about `agy` or `tmux` is not a finding, while an import, a call or a string that would be
  executed is.
- `scan_shell(text)`: the same rule for the shell scripts in `bin/` and the backup sidecar.

A finding is `(token, line, text)`. The caller compares findings to an explicit allowlist, one
reason per entry (see `test_no_code_path_launches_a_harness.py`).
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from pathlib import Path

Finding = tuple[str, int, str]

#: Modules whose import is a finding. `subprocess` and `pty` are the two named by the spec; the others
#: are the usual ways to the same end.
FORBIDDEN_MODULES = frozenset({"subprocess", "pty", "pexpect", "ptyprocess", "sh", "plumbum"})
#: `os.<name>` calls that start a process or a terminal.
FORBIDDEN_OS = re.compile(r"^(system|popen|fork|forkpty|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?)$")
#: `asyncio` / event-loop spellings of a subprocess.
FORBIDDEN_ATTRS = re.compile(r"^(create_subprocess_(exec|shell)|subprocess_(exec|shell)|Popen|openpty|forkpty)$")
#: A string that names a harness driver. `agy` and `claude` count only when the whole string is the
#: word (an argv element) or the flag form follows it, so prose such as "Claude Code" is not a finding.
FORBIDDEN_STRINGS = (
    ("tmux", re.compile(r"\btmux\b", re.I)),
    ("agentapi", re.compile(r"\bagentapi\b", re.I)),
    ("pty", re.compile(r"\bpty\b", re.I)),
    ("subprocess", re.compile(r"\bsubprocess\b", re.I)),
    ("claude -p", re.compile(r"\bclaude\b[\s'\",\]]+(-p\b|--print\b)")),
    ("agy -p", re.compile(r"\bagy\b[\s'\",\]]+(-p\b|--prompt\b)")),
    ("agy", re.compile(r"^\s*agy\s*$")),
    ("claude", re.compile(r"^\s*claude\s*$")),
)


def _docstring_ids(tree: ast.AST) -> set[int]:
    """Ids of string-expression statements: docstrings and bare strings, never executed."""
    return {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant)}


def scan_python(source: str) -> list[Finding]:
    tree = ast.parse(source)
    skip = _docstring_ids(tree)
    lines = source.splitlines()
    found: list[Finding] = []

    def add(token: str, node: ast.AST) -> None:
        line = getattr(node, "lineno", 0)
        found.append((token, line, lines[line - 1].strip() if 0 < line <= len(lines) else ""))

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in FORBIDDEN_MODULES:
                    add(alias.name.split(".")[0], node)
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root in FORBIDDEN_MODULES:
                add(root, node)
            if root == "os" and any(FORBIDDEN_OS.match(a.name) for a in node.names):
                add("os." + next(a.name for a in node.names if FORBIDDEN_OS.match(a.name)), node)
            if root == "asyncio" and any(a.name in ("subprocess",) or FORBIDDEN_ATTRS.match(a.name) for a in node.names):
                add("asyncio.subprocess", node)
        elif isinstance(node, ast.Attribute):
            if isinstance(node.value, ast.Name) and node.value.id == "os" and FORBIDDEN_OS.match(node.attr):
                add("os." + node.attr, node)
            elif FORBIDDEN_ATTRS.match(node.attr):
                add(node.attr, node)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip:
            for token, pattern in FORBIDDEN_STRINGS:
                if pattern.search(node.value):
                    add(token, node)
        elif isinstance(node, ast.JoinedStr):
            pass  # its literal pieces are Constant children and are scanned above
    return sorted(set(found), key=lambda f: (f[1], f[0]))


# -- shell ----------------------------------------------------------------------------------------

#: Command position: a harness binary where a command starts (after a separator, a control word or a
#: wrapper such as `exec`, `nohup`, `sudo`, `env`, `timeout N`, `xargs`, `command`, `nice`).
_COMMAND_POSITION = re.compile(
    r"(?:^\(?|[;&|`{]|\$\(|\b(?:then|do|else|exec|nohup|sudo|xargs|env|command|nice|setsid|stdbuf)\b|\btimeout\s+\S+)"
    r"\s*(?:\S*/)?(agy|claude|tmux|agentapi)\b"
)
#: Anywhere in code (strings included): these are never part of a legitimate script of ours.
_ANYWHERE = (
    ("tmux", re.compile(r"\btmux\b")),
    ("agentapi", re.compile(r"\bagentapi\b")),
    ("pty", re.compile(r"\bpty\b")),
    ("subprocess", re.compile(r"\bsubprocess\b")),
    ("claude -p", re.compile(r"\bclaude\b\s+(-p\b|--print\b)")),
    ("agy -p", re.compile(r"\bagy\b\s+(-p\b|--prompt\b)")),
)
_HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def strip_shell_comment(line: str) -> str:
    """The line without a trailing `# comment`, quote-aware (a `#` inside quotes or `$#` stays)."""
    out: list[str] = []
    quote: str | None = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t;") :
            break
        out.append(ch)
    return "".join(out)


def scan_shell(text: str) -> list[Finding]:
    found: set[Finding] = set()
    terminator: str | None = None
    for number, raw in enumerate(text.splitlines(), start=1):
        if terminator is not None:
            body = raw.strip()
            if body == terminator:
                terminator = None
                continue
            line, in_heredoc = body, True  # data: only the "anywhere" tokens apply
        else:
            line, in_heredoc = strip_shell_comment(raw).strip(), False
            heredoc = _HEREDOC.search(line)
            if heredoc:
                terminator = heredoc.group(2)
        if not line:
            continue
        for token, pattern in _ANYWHERE:
            if pattern.search(line):
                found.add((token, number, raw.strip()))
        if not in_heredoc:
            match = _COMMAND_POSITION.search(line)
            if match:
                found.add((match.group(1), number, raw.strip()))
    return sorted(found, key=lambda f: (f[1], f[0]))


# -- the files to scan -------------------------------------------------------------------------------


@dataclass(frozen=True)
class Source:
    label: str  # repo-relative, for messages and the allowlist
    kind: str  # "python" or "shell"
    path: Path


def python_sources(src_root: Path, *, exclude: tuple[str, ...] = ()) -> list[Source]:
    """Every module under `src/coordination` except the listed relative directories."""
    out = []
    for path in sorted(src_root.rglob("*.py")):
        rel = path.relative_to(src_root).as_posix()
        if any(rel == e.rstrip("/") or rel.startswith(e.rstrip("/") + "/") for e in exclude):
            continue
        out.append(Source("coordination/" + rel, "python", path))
    return out


def shell_sources(directory: Path, label: str) -> list[Source]:
    """The scripts of a directory: files with a shell shebang or a `.sh` suffix (bin scripts have no suffix)."""
    out = []
    if not directory.is_dir():
        return out
    for path in sorted(directory.iterdir()):
        if not path.is_file():
            continue
        head = path.read_text(errors="replace").splitlines()[:1]
        if path.suffix == ".sh" or (head and head[0].startswith("#!") and "sh" in head[0]) or path.name == "a2a-lib.sh":
            out.append(Source(f"{label}/{path.name}", "shell", path))
    return out


def scan(source: Source) -> list[Finding]:
    text = source.path.read_text()
    return scan_python(text) if source.kind == "python" else scan_shell(text)
