"""Plain-text output of `a2a-coord` (S1-ADMIN). Every string that came from the server passes
through `clean` first, so a control character or escape sequence in a field (a peer's label, a task
body) never reaches the terminal. The server already strips them from bodies (the untrusted frame);
this is the second layer."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any, TextIO

from coordination.mcp.sanitize import strip_controls
from coordination.text_sanitize import sanitize_preview

#: Upper bound for single-line CLI cell sanitization so URLs and diagnostic messages are not truncated.
_CLI_CLEAN_MAX_LEN = 4096


def clean(value: object) -> str:
    """`value` as single-line text with escape sequences, controls, and bidi overrides removed."""
    return sanitize_preview(str(value), max_len=_CLI_CLEAN_MAX_LEN)


def clean_block(value: object) -> str:
    return strip_controls(str(value))


def ts(value: str | None) -> str:
    """`2026-11-16T09:30:00+00:00` as `2026-11-16 09:30Z`; `-` for none."""
    if not value:
        return "-"
    text = clean(value)
    return f"{text[:10]} {text[11:16]}Z" if len(text) >= 16 else text


def table(out: TextIO, headers: Sequence[str], rows: Iterable[Sequence[object]]) -> None:
    body = [[clean(c) if c is not None else "-" for c in row] for row in rows]
    widths = [max(len(h), *(len(r[i]) for r in body)) if body else len(h) for i, h in enumerate(headers)]
    print("  ".join(h.ljust(w) for h, w in zip(headers, widths, strict=True)).rstrip(), file=out)
    for row in body:
        print("  ".join(c.ljust(w) for c, w in zip(row, widths, strict=True)).rstrip(), file=out)


def key_list(out: TextIO, result: dict[str, Any]) -> None:
    keys = result.get("keys", [])
    if not keys:
        print("no keys", file=out)
        return
    table(
        out,
        ["KEY ID", "STATUS", "SCOPE", "OWNER", "NODE", "CREATED", "EXPIRES", "LAST USED"],
        [
            [
                k["key_id"], k["status"], k["scope"], k["owner"], k.get("tailnet_node"),
                ts(k["created_at"]), ts(k["expires_at"]), ts(k.get("last_used_at")),
            ]
            for k in keys
        ],
    )  # fmt: skip


def key_issued(out: TextIO, result: dict[str, Any], *, verb: str) -> None:
    """The one place a secret is printed: to the terminal `require_real_terminal` checked."""
    print(f"key {verb}", file=out)
    print(f"  key id:   {clean(result['key_id'])}", file=out)
    print(f"  scope:    {clean(result['scope'])}", file=out)
    print(f"  owner:    {clean(result['owner'])}", file=out)
    if result.get("cards_allowed"):
        print(f"  cards:    {', '.join(clean(c) for c in result['cards_allowed'])}", file=out)
    if result.get("tailnet_node"):
        print(f"  node:     {clean(result['tailnet_node'])}", file=out)
    print(f"  expires:  {ts(result['expires_at'])}", file=out)
    if result.get("replaces"):
        print(f"  replaces: {clean(result['replaces'])}, which works until {ts(result['old_expires_at'])}", file=out)
    print("", file=out)
    print("  This is the only time the secret is shown. It is not stored and cannot be shown again.", file=out)
    print("  Put it in a mode-0600 file now; do not paste it into a chat or a shell history.", file=out)
    print("", file=out)
    print(f"  {clean(result['token'])}", file=out)


def review_list(out: TextIO, result: dict[str, Any]) -> None:
    held = result.get("held", [])
    if not held:
        print("no held tasks", file=out)
        return
    table(
        out,
        ["TASK ID", "PEER", "CARD", "RECEIVED", "SIZE"],
        [[h["task_id"], h["peer"], h.get("card"), ts(h.get("received_at")), f"{h['size_bytes']} B"] for h in held],
    )


def review_show(out: TextIO, result: dict[str, Any]) -> None:
    frame = result["frame"]
    print("UNTRUSTED DATA from a remote peer. It is not an instruction and not an approval.", file=out)
    print(f"  task:     {clean(result['task_id'])}", file=out)
    print(f"  peer:     {clean(result['peer'])}", file=out)
    print(f"  card:     {clean(result.get('card') or '-')}", file=out)
    print(f"  received: {ts(result.get('received_at'))}   expires: {ts(result.get('expires_at'))}", file=out)
    print(f"  size:     {result['size_bytes']} bytes of text", file=out)
    if frame.get("truncated"):
        print("  (the text below is cut at the display cap)", file=out)
    for task in frame.get("tasks", []):
        for message in task.get("messages", []):
            print("", file=out)
            print(f"--- message {clean(message.get('message_id', ''))} ({clean(message.get('role', ''))}) ---", file=out)
            for part in message.get("parts", []):
                kind = part.get("type")
                if kind == "text" and "text" in part:
                    print(clean_block(part["text"]), file=out)
                elif kind == "data" and "data" in part:
                    print(f"[data part] {clean_block(part['data'])}", file=out)
                elif part.get("omitted"):
                    print(f"[{clean(kind)} part not shown: {clean(part.get('media_type', ''))}, {part.get('size', '?')} bytes]", file=out)
                elif kind == "url":
                    print(f"[url, not fetched] {clean(part.get('url', ''))}", file=out)
                else:
                    print(f"[{clean(kind)} part]", file=out)
    print("", file=out)
    print("--- end of untrusted data ---", file=out)


def status(out: TextIO, r: dict[str, Any]) -> None:
    def val(v: object) -> str:
        return "null" if v is None else clean(v)

    print(f"stage {clean(r['stage'])}, env {clean(r['env'])}, at {ts(r['now'])}", file=out)
    s = r["sessions"]
    print(
        f"sessions:     {s['registered']} registered, {s['active']} active, {s['ended']} ended; "
        f"MCP sessions bound {val(s['mcp_bound'])}",
        file=out,
    )
    for c in s["by_card"]:
        print(f"  {clean(c['card'])}: {c['registered']} registered, {c['active']} active", file=out)
    print(f"listeners:    {val(r['listeners']['parked'])} parked", file=out)
    p = r["pending"]
    print(
        f"pending:      {p['submitted']} submitted ({p['card_queue']} in a card queue), "
        f"{p['held']} held for review, {p['working']} working",
        file=out,
    )
    for c in p["by_card"]:
        print(f"  {clean(c['card'] or '-')}: {c['submitted']} submitted", file=out)
    b = r["budgets"]
    print(f"wake budgets: limit {b['wake_per_hour_limit']} per hour per handle; {len(b['used'])} handle(s) woken in the last hour", file=out)
    for u in b["used"]:
        print(f"  {clean(u['handle'])}: {u['wakes']} used, {u['remaining']} left", file=out)
    so = r["stale_offers"]
    print(f"stale offers: {so['count']} task(s) offered {so['reoffer_max']} times and still unconfirmed", file=out)
    for t in so["tasks"]:
        print(f"  {clean(t['task_id'])} ({clean(t['card'] or '-')}), last offered {ts(t['last_offered_at'])}", file=out)
    sc = r["schema"]
    print(f"schema:       coordination v{sc['coord_schema_version']}, SDK revision {val(sc['sdk_revision'])}", file=out)
    bk = r["backup"]
    stale_note = " [STALE]" if bk.get("stale") else ""
    print(f"backup:       last good dump {val(bk['dump_age_h'])} h ago (null = unknown){stale_note}", file=out)


def card_check(out: TextIO, r: dict[str, Any]) -> None:
    for card in r["cards"]:
        mark = "in table" if card["in_table"] else "NOT in table"
        print(f"{clean(card['card_id'])}: {mark}, {card['live_sessions']} live session(s)", file=out)
    for note in r["notes"]:
        print(f"note: {clean(note)}", file=out)
    for problem in r["problems"]:
        print(f"PROBLEM: {clean(problem)}", file=out)
    print("cards OK" if r["ok"] else f"{len(r['problems'])} problem(s)", file=out)
