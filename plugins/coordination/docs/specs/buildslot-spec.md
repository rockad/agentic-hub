# BuildSlot Protocol: Specification (Task C1 / Delegation D)

Status: APPROVED BY USER (2026-11-03T14:12:26 / 14:54). Formally delegated to Claude Code for implementation on branch `feat/buildslot-protocol` (stacked on `feat/stage1-integration`, PR #5).
Author: Claude Code (macp / doppelganger-6b), 2026-11-03. Inputs: bridge-v2 channel messages 1 to 3, 5b's feedback on message 1, Antigravity messages 27 to 29.
Assignee: `cognitive-engine-5b` (chosen by the user).
Implementation status (2026-11-03): IMPLEMENTED, PR OPEN. `feat/buildslot-protocol` @ `da1b199` (verified with `git ls-remote`), PR #13 open and not a draft, base `feat/stage1-integration` (stacked on #5), opened at the user's request per the implementer. Reported by the implementer, not re-run by macp: 65 tests in `test_coordination.py` pass; the full suite (5508 passed / 22 skipped) was measured at the earlier commit `6c0ac4d` only. Choices to review: only `rootless-docker` is predefined (`~/.agents/cognitive-engine-docker-tests.lock`); other slots use a private file under `$XDG_STATE_HOME/cognitive-engine/slots`.
**Name rule changed from this spec (implementer's decision, 2026-11-03):** slot names are restricted to lower-case letters, digits and `-`; names with `.`, `_` or other characters are refused (this replaces the draft's "upper-case and replace every non-alphanumeric by `_`" slugging). Reason: slugging would alias distinct names (`a-b`, `a_b`, `a.b`) onto one physical slot; refusing them keeps name to marker and name to lock file one-to-one (only `-` maps to `_`), so the marker-bypass collision found in review cannot be constructed. Section 8's marker description below is superseded by this rule. Not yet done: adoption call sites (section 7), README; 6 SIM117 style findings left on purpose.

## 1. Scope

- One resource kind: a **named exclusive slot** (examples: `rootless-docker`, `gpu-model`).
- Out of scope, each needing its own contract and a named consumer first: file leases, mailboxes, task delegation (A2A style), heartbeat/liveness (task C3).
- Placement: Protocol and the flock implementation live in `packages/harness2` (e.g. `coordination.py`); any daemon-backed implementation lives outside the repo (agentic-hub) behind the same Protocol.

## 2. Interface

```python
@dataclass(frozen=True)
class HolderInfo:            # every field optional: an implementation fills what it can
    label: str | None        # e.g. "suite:full" or "proposer:p1"
    pid: int | None
    host: str | None
    acquired_at: float | None   # unix time
    ttl_hint_s: float | None    # a hint, see 3

class SlotTimeout(TimeoutError):
    slot: str
    holder: HolderInfo | None   # None when unknown, never guessed

class BuildSlot(Protocol):
    def hold(self, name: str, *, timeout: float | None = None,
             deadline: float | None = None, label: str | None = None,
             ttl_hint: float | None = None) -> ContextManager[None]: ...
    def holder(self, name: str) -> HolderInfo | None: ...   # best effort, may be stale
```

- `timeout` (seconds from now) and `deadline` (`time.monotonic()` instant): the earlier wins, same rule as `model_gate.GATE`. Expiry raises `SlotTimeout`.
- Async: `ahold(...)` mirrors `hold` and waits in a worker thread, as `GATE.ahold` does.
- Not re-entrant; take it once at the outermost point. If both are needed, take `GATE` first, then the slot, and release in reverse order (avoids lock-order deadlock).

## 3. Guarantees per field (flock implementation vs a daemon one)

| property | flock implementation | daemon implementation | in the Protocol |
| --- | --- | --- | --- |
| mutual exclusion among cooperating processes on one host | yes | yes | **required** |
| release on holder death | yes (kernel drops the lock) | yes (TTL or PID check) | **required** |
| deadline / timeout on wait | yes (poll `LOCK_NB`) | yes | **required** |
| `SlotTimeout` carries holder when known | yes, via sidecar | yes | **required** (field may be None) |
| `ttl` enforcement | **no**: a live holder keeps the flock indefinitely | yes | **optional**: documented as a hint only |
| holder metadata | best effort via sidecar `<lockfile>.holder` JSON written after acquire | native | **optional** |
| fairness / queue order | **no** | possible | **out of scope**, callers must not rely on order |
| force release of a hung live holder | **no**: operator kills the pid | possible | **out of scope** |
| heartbeat / liveness of the holder | **no** | possible | **out of scope** (task C3) |
| cross-host | **no** (flock is host-local) | possible | **out of scope** |

## 4. Flock implementation notes

- Lock file: the existing `~/.agents/cognitive-engine-docker-tests.lock` for `rootless-docker`, so the shell wrapper and Python callers exclude each other. The lock file stays empty; holder data goes to a sidecar so the shell wrapper's behaviour is unchanged.
- Sidecar content: JSON `{label, pid, host, acquired_at, ttl_hint_s}`, written after the flock is held and removed on release. A reader treats it as untrusted and possibly stale: if `host` matches and the pid is not alive, report holder `None` rather than a dead process.
- Wait loop: `flock(LOCK_EX | LOCK_NB)` with short sleeps until the deadline. A blocking `flock` cannot honour a deadline portably.
- A hung live holder blocks everyone until killed. The error names the holder so a human or agent can act; the implementation never kills anything.
- Lock files must live on a local filesystem (not SMB/NFS); the implementation checks nothing there, the doc states it.

## 5. Kill switch

- The flock implementation is the default and has no network dependency, so the project works with every coordination server down.
- Selecting a daemon implementation is explicit configuration, and a failed connection raises; it does **not** silently fall back to flock, because that would let two holders believe they exclude each other.

## 6. Conformance suite (one suite, run against every implementation)

- Mutual exclusion across two processes (not threads).
- Timeout and deadline: the earlier one wins; `SlotTimeout` names the holder when known.
- Release on normal exit, on exception, and on holder `SIGKILL`.
- Not re-entrant: second `hold` in the same thread times out instead of succeeding.
- Holder info: sidecar present while held, absent after release, stale pid is not reported.
- Lock-order rule with `GATE`: the documented order never deadlocks in a two-process test.
- Async `ahold` does not block the event loop.
- A daemon implementation must pass the same file unchanged; that is what makes swapping safe.

## 7. Adoption call sites (task C2, to be confirmed read-only)

- `packages/harness2/.../model_gate.py`: `GATE` stays the in-process semaphore; add the slot only around cross-process resources.
- The Docker suite wrapper that takes `~/.agents/cognitive-engine-docker-tests.lock`.
- `stage1.py` teardown check `gate_locked`: report the holder from `SlotTimeout`/`holder()`.

## 8. Open questions

- RESOLVED (read-only check of the handoff and tasklist): the wrapper is the shell command `flock ~/.agents/cognitive-engine-docker-tests.lock pytest ...`, i.e. `flock(1)` wrapping the whole run. Consequences for the spec:
  - The Python side must use `fcntl.flock`, not `fcntl.lockf`, or the two will not exclude each other.
  - **Nesting deadlock risk:** `flock(1)` holds the lock on its own open file description, so a pytest run started under it that then calls `hold("rootless-docker")` on the same file opens a new description and blocks on its own parent until timeout. Adoption must pick one layer per run: either the shell wrapper stays and Python code in those runs does not take the slot, or the wrapper is retired and Python takes it. A conformance test should cover "caller already holds the slot via the shell wrapper"; an env marker (e.g. the wrapper exports the slot name it holds) is one way to detect it. Decide before any code.
  - Proposed env marker (Antigravity message 2 suggested one): the shell wrapper exports `CE_BUILDSLOT_HELD_<SLOT>=1` before `pytest`, where `<SLOT>` is the slot name upper-cased with every non-alphanumeric character replaced by `_` (env names cannot contain `-`: `rootless-docker` becomes `CE_BUILDSLOT_HELD_ROOTLESS_DOCKER`). The Python `hold()` sees the marker, skips acquisition and returns, so there is no nesting. The marker is inherited by children, so it is advisory and trusted only within one cooperating process tree.
  - The wrapper has no timeout (`flock` without `-w` waits forever), so it also never reports a holder. The Protocol's `SlotTimeout` is the improvement only where Python takes the slot.
- Which name strings are canonical (`rootless-docker`, `gpu-model`)? Where is the name-to-path map kept?
- Does the user want this PR at all (Gate 0)?
