"""The only code path that moves a held task to `SUBMITTED` is the admin `release` command
(spec 8.3, decision D19; S1-ADMIN acceptance).

This file is the STATIC half: it reads the source tree. The runtime half, against a real database,
is `test_admin_pg.py` (every other way to touch a held task, then the one way that works). No
Docker is needed here.
"""

from __future__ import annotations

import ast
from pathlib import Path

from coordination.admin.ops import AdminOps
from coordination.admin.protocol import COMMANDS
from coordination.service.states import TRANSITIONS, Actor, State, sources

SRC = Path(__file__).resolve().parents[1] / "src" / "coordination"


def _modules() -> list[tuple[str, ast.Module]]:
    return [(str(p.relative_to(SRC)), ast.parse(p.read_text(), filename=str(p))) for p in sorted(SRC.rglob("*.py"))]


class _Scoped(ast.NodeVisitor):
    """Collects (qualified enclosing function, node) for every node a predicate accepts."""

    def __init__(self, accept) -> None:
        self.accept = accept
        self.stack: list[str] = []
        self.found: list[tuple[str, ast.AST]] = []

    def _enter(self, node: ast.AST, name: str) -> None:
        self.stack.append(name)
        self.generic_visit(node)
        self.stack.pop()

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._enter(node, node.name)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._enter(node, node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._enter(node, node.name)

    def generic_visit(self, node: ast.AST) -> None:
        if self.accept(node):
            self.found.append((".".join(self.stack) or "<module>", node))
        super().generic_visit(node)


def _find(accept) -> list[tuple[str, str]]:
    out = []
    for name, tree in _modules():
        v = _Scoped(accept)
        v.visit(tree)
        out += [(name, where) for where, _ in v.found]
    return out


def _calls(attr: str):
    def accept(node: ast.AST) -> bool:
        if not isinstance(node, ast.Call):
            return False
        f = node.func
        return (isinstance(f, ast.Attribute) and f.attr == attr) or (isinstance(f, ast.Name) and f.id == attr)

    return accept


def test_release_hold_has_exactly_one_caller_and_it_is_the_admin_release_command():
    assert _find(_calls("release_hold")) == [("admin/review.py", "ReviewAdmin.release")]


def test_no_other_way_to_name_release_hold_exists_in_source():
    """Not a call, but a `getattr`, a string, a `partial` or an alias would be a second way in."""
    mentions = []
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr == "release_hold":
                mentions.append((str(path.relative_to(SRC)), "attribute"))
            elif isinstance(node, ast.Name) and node.id == "release_hold":
                mentions.append((str(path.relative_to(SRC)), "name"))
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.strip() == "release_hold":
                mentions.append((str(path.relative_to(SRC)), "string"))
    assert sorted(mentions) == [("admin/review.py", "attribute")]


def test_the_admin_package_never_makes_a_transition_of_its_own():
    """The admin code reaches a task only through the service's hooks: it never builds a transition
    or names the admin actor itself."""
    admin_files = [p for p in SRC.rglob("*.py") if "admin" in p.relative_to(SRC).parts[:1]]
    text = "\n".join(p.read_text() for p in admin_files)
    for forbidden in ("_transition(", "Actor.ADMIN", "task_store.transition", "_store.transition", ".transition(", "update_index"):
        assert forbidden not in text, forbidden


def test_only_the_admin_actor_may_move_a_held_task_to_submitted_and_only_the_hooks_use_that_actor():
    for actor in Actor:
        allowed = State.QUARANTINED in sources(State.SUBMITTED, actor)
        assert allowed is (actor is Actor.ADMIN), actor
    assert {(f, t, a) for f, t, a in TRANSITIONS if f is State.QUARANTINED and t is State.SUBMITTED} == {
        (State.QUARANTINED, State.SUBMITTED, Actor.ADMIN)
    }
    # In the service, the ADMIN actor is named by exactly two functions, `release_hold` and `deny_hold`.
    users = _find(lambda n: isinstance(n, ast.Attribute) and n.attr == "ADMIN" and isinstance(n.value, ast.Name) and n.value.id == "Actor")
    assert sorted(set(users)) == [
        ("service/service.py", "CoordinationService.deny_hold"),
        ("service/service.py", "CoordinationService.release_hold"),
        ("service/states.py", "<module>"),  # the transition table itself (two rows)
    ]


def test_one_command_name_reaches_release_and_nothing_releases_in_bulk():
    releases = [c for c in COMMANDS if "release" in c]
    assert releases == ["review.release"]
    assert not [c for c in COMMANDS if "all" in c.split(".") or "batch" in c or "bulk" in c]
    # The command table maps that name to `ReviewAdmin.release` and the handler takes one task id.
    import inspect

    assert "review.release" in inspect.getsource(AdminOps.__init__)
    sig = inspect.signature(__import__("coordination.admin.review", fromlist=["ReviewAdmin"]).ReviewAdmin.release)
    assert list(sig.parameters) == ["self", "args", "actor"]
    body = inspect.getsource(__import__("coordination.admin.review", fromlist=["ReviewAdmin"]).ReviewAdmin.release)
    assert 'phrase_for("release", task_id)' in body and body.count("release_hold(") == 1


def test_no_http_binding_imports_the_admin_package():
    """`/mcp` and `/a2a/v1` cannot reach the release hook because they do not import the admin code."""
    for name, tree in _modules():
        if name.startswith(("mcp/", "a2a/", "auth/", "wake/")):
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("coordination.admin"):
                    raise AssertionError(f"{name} imports {node.module}")
                if isinstance(node, ast.Import) and any(a.name.startswith("coordination.admin") for a in node.names):
                    raise AssertionError(f"{name} imports {node.names[0].name}")
