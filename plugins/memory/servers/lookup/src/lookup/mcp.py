"""MCP server: HTTP for deployment, stdio for development.

Stdlib only — no SDK dependency, so the image stays tiny and the same code runs
bare anywhere with python3.

**`serve_http` is the deployment.** One resident compose container on
`127.0.0.1:8100`, registered at user scope; `docs/mcp-servers.md` in the
doppelganger repo carries the add command and the per-machine prerequisites.
Chosen on measured numbers over a host install, not on preference —
`eval/RESULTS.md` Part 2.

**`serve` is stdio, and it is kept deliberately for development.** Keep
it for dev purposes. It is how a client gets driven by hand
without Docker in the loop, and it is what keeps `handle()` honest — a test
pins both transports to that one dispatcher, so neither can quietly grow a
capability the other lacks. **Nothing deploys it.**

⚠️ **And nothing should.** A stdio MCP server means one server process per
session. This project's earlier incarnation shipped that as `docker run --rm -i`
per session, and `--rm` does not fire when a session dies without closing
stdin — so containers accumulated on `core` with nothing reaping them, which is
what got it scrapped. The same leak was reproduced during the 2026-09-07
evaluation in an unrelated tool, so it belongs to `run --rm` plus a stdio MCP
server rather than to this code. Whatever serves real traffic must be ONE
long-lived process.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time

from . import db

from . import __version__ as VERSION
PROTOCOL_VERSION = "2025-06-18"
SUPPORTED = {"2024-11-05", "2025-03-26", "2025-06-18"}

TOOLS = [
    {
        "name": "search_archive",
        "description": (
            "Full-text search across user indexed corpora — Obsidian "
            "vault, durable memories, session handoff files, repository "
            "documentation, shared knowledge base, skills, and "
            "transcripts. Use it for questions about user history, "
            "decisions, past work, correspondence or documents.\n\n"
            "Ask a plain English question. Punctuation and hyphens are safe, and "
            "so is a phrase whose words do not all appear together: a query that "
            "FTS5 rejects, or that it accepts and matches nothing, is retried "
            "with every token quoted and OR-ed, and the reply says what was "
            "actually searched. Deliberate FTS5 syntax (OR, NOT, \"quoted "
            "phrases\", trailing *) is honoured verbatim and an empty result is "
            "left as the answer.\n\n"
            "⚠️ A result is marked REMOTE when the index reads that source over "
            "a network mount, which the machine you are on very likely does not "
            "have: the path is real to the index and not to you. It is marked NOT "
            "REACHABLE when even the index cannot resolve it. Either way, search "
            "still answers from the index's own copy of the text, and "
            "get_document returns the full body without touching the filesystem "
            "— so read a marked result with get_document rather than by opening "
            "its path.\n\n"
            "⚠️ Every result carries a `visibility`, inherited from the system "
            "the material came from. `open` — a company-wide channel, an "
            "unrestricted page — is free to reuse. `gated` — a DM, a private "
            "channel, a permission-restricted page — is usable only after the "
            "fact is verified against its source and the user has explicitly "
            "signed it off. `unstated` means the source declares nothing, so "
            "the provenance is unknown and unknown is handled as gated. Nothing "
            "is banned: provenance decides the ceremony, not whether the "
            "material may be used, so bring a gated fact to the user rather than "
            "discarding it.\n\n"
            "Results come back GROUPED BY SOURCE, one small ranking per corpus, "
            "because a single ranking across corpora of very different sizes "
            "returns whichever corpus is largest rather than whichever is right — "
            "measured over eleven questions, per-source search answered ten within "
            "the top three and one global ranking answered six. Read each group. "
            "Pass `source` only to narrow the search deliberately; call "
            "archive_stats for the list of source names."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string",
                          "description": "a plain question, or FTS5 syntax"},
                "source": {"type": "array", "items": {"type": "string"},
                           "description": "narrow to these sources; omit to search "
                                          "them all, grouped. See archive_stats."},
                "since": {"type": "string", "description": "ISO date lower bound"},
                "until": {"type": "string", "description": "ISO date upper bound"},
                "limit": {"type": "integer", "default": 3, "maximum": 10,
                          "description": "results per source, not in total"},
                "full": {"type": "boolean", "default": False,
                         "description": "whole documents instead of snippets; only "
                                        "honoured when `source` names one source"},
                "visibility": {"type": "string",
                               "enum": ["open", "gated", "unstated"],
                               "description": "only results with this effective "
                                              "visibility — a document's own value, "
                                              "or its source's where it declares "
                                              "none. Pass `open` when you need an "
                                              "answer you can reuse without asking "
                                              "the user first."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_document",
        "description": "Fetch one indexed document in full by the doc_key returned "
                       "in search_archive results.",
        "inputSchema": {"type": "object",
                        "properties": {"doc_key": {"type": "string"}},
                        "required": ["doc_key"]},
    },
    {
        "name": "refresh_index",
        "description": (
            "Re-ingest every declared source, so a note written moments ago is "
            "findable now. Takes about 1.5 s over 1,197 documents. The resident "
            "server also re-ingests on a timer, so this is for when you cannot "
            "wait for the next tick — after writing a note you then want to "
            "search, most obviously. Safe to call repeatedly: ingestion is "
            "idempotent, keyed on source|path|ordinal."),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "archive_stats",
        "description": "What is in the index: document counts, text volume and date "
                       "range per source. Check coverage here before concluding "
                       "something is absent.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


_REMOTE_SOURCES: set[str] | None = None


def remote_sources() -> set[str]:
    """Sources the index reaches over a network mount the CALLER may not share.

    ⚠️ This exists because the obvious implementation of "tell the caller the
    path will not open" does not work, and shipping it proved that.
    `_reachable()` runs inside the server, and the server is a container whose
    own cifs volume mounts `/Volumes/knowledge-archive` regardless of what the
    host has mounted. So when the host's SMB mount was removed, every archive
    result was still reported as reachable — correctly, from where the check
    ran, and uselessly for the caller who asked.

    The server cannot know what the caller has mounted. What it does know is
    which sources it reaches over a network volume, because the manifest says
    so, and a path under one of those is a path the caller has no reason to be
    able to open. That is the honest signal: not "this is broken" but "this is
    not yours to open".
    """
    global _REMOTE_SOURCES
    if _REMOTE_SOURCES is None:
        try:
            from . import manifest
            _REMOTE_SOURCES = {n for n, src in manifest.load().items() if src.volume}
        except Exception:
            _REMOTE_SOURCES = set()
    return _REMOTE_SOURCES


_VISIBILITY: dict[str, str] | None = None


def source_visibility() -> dict[str, str]:
    """Each source's declared visibility, read from the manifest.

    A fact inherits the visibility of the system it came from: material from a
    company-wide channel or an unrestricted page is free to reuse, material
    from a DM, a private channel or a restricted page needs verifying against
    its source and the user's sign-off first. Nothing is refused outright.

    The label has to travel with the result, because the agent reading a hit is
    the one about to reuse the fact and it cannot see the manifest. A source
    that declares nothing is reported as `unstated` and handled as gated —
    unknown provenance resolves that way rather than to `open`.

    Cached like `remote_sources()`, and for the same reason: the manifest does
    not change under a running server, and a failure to load it must not take
    search down with it.
    """
    global _VISIBILITY
    if _VISIBILITY is None:
        try:
            from . import manifest
            _VISIBILITY = {n: s.visibility for n, s in manifest.load().items()}
        except Exception:
            _VISIBILITY = {}
    return _VISIBILITY


def _visibility_of(source: str | None) -> str:
    """The label for one SOURCE. An unknown source is unstated, not open.

    ⚠️ Not the label for a HIT. A document carries its own value, so a result
    line goes through `_visibility_row`; this answers only what the manifest
    says about the corpus, which for a `mixed` source is "ask the document".
    """
    from . import manifest
    return source_visibility().get(source or "", manifest.VISIBILITY_UNSTATED)


def _inherit_sources(want: str | None) -> tuple[str, ...]:
    """Sources whose OWN visibility is `want`, so their NULL rows match it.

    `db` knows nothing about the manifest by design, so a filter on effective
    visibility has to be told which sources' documents inherit the wanted
    value. A manifest that would not load leaves `source_visibility()` empty,
    which matches only rows carrying an explicit value — narrower than was
    asked for, never wider, which is the safe direction for a filter whose job
    is to keep gated material out of an answer.
    """
    if not want:
        return ()
    return tuple(n for n, v in source_visibility().items() if v == want)


def _visibility_row(row) -> str:
    """The label for one HIT: its own value, falling back to its source's.

    Every result line must use this. A `mixed` source with a document that
    declared nothing resolves to `unstated`, never to `mixed` — `mixed`
    describes a corpus and says nothing about the document in hand, while
    `unstated` is both true and handled as gated.
    """
    from . import manifest
    try:
        own = row["visibility"]
    except (KeyError, IndexError):
        own = None          # a row selected without the column
    return manifest.effective_visibility(own, _visibility_of(row["source"]))


def _visibility_legend(names, rows=None) -> str:
    """One line naming what in this reply is not free to reuse.

    Added only when something actually is not, so an all-`open` reply carries no
    ceremony at all. The per-hit lines carry the bare label; this is where it is
    said what the label obliges the reader to do.

    `rows`, when given, is the reply's actual hits, and it is what makes a
    `mixed` source reportable: naming the source would be useless there, since
    the answer differs per document, so those hits are counted instead.
    """
    from . import manifest
    vis = {n: _visibility_of(n) for n in set(names)}
    gated = sorted(n for n, v in vis.items() if v == manifest.VISIBILITY_GATED)
    unstated = sorted(n for n, v in vis.items()
                      if v == manifest.VISIBILITY_UNSTATED)
    # A hit inside an `open` or `mixed` source can still be gated on its own
    # account, and that is invisible from the source list alone.
    narrowed = 0
    for r in (rows or ()):
        if (_visibility_of(r["source"]) not in (manifest.VISIBILITY_GATED,
                                                manifest.VISIBILITY_UNSTATED)
                and _visibility_row(r) != manifest.VISIBILITY_OPEN):
            narrowed += 1
    if not gated and not unstated and not narrowed:
        return ""
    out = ["⚠️ **Not every result below is free to reuse.** A fact inherits the "
           "visibility of the system it came from."]
    if gated:
        out.append(f"`{'`, `'.join(gated)}` "
                   f"{'is' if len(gated) == 1 else 'are'} **gated**: verify the "
                   f"fact against its source and get the user's explicit "
                   f"sign-off before reusing it anywhere it was not already "
                   f"put.")
    if unstated:
        out.append(f"`{'`, `'.join(unstated)}` "
                   f"{'declares' if len(unstated) == 1 else 'declare'} no "
                   f"visibility (**unstated**), so the provenance is unknown "
                   f"and unknown is handled as gated — same verification and "
                   f"sign-off.")
    if narrowed:
        out.append(f"{narrowed} result{'' if narrowed == 1 else 's'} below "
                   f"{'carries' if narrowed == 1 else 'carry'} a visibility of "
                   f"{'its' if narrowed == 1 else 'their'} own that is narrower "
                   f"than the source's — read the `visibility:` on each line "
                   f"rather than the source's name, and treat anything that is "
                   f"not `open` as needing the same sign-off.")
    out.append("Nothing here is banned; provenance decides the ceremony, not "
               "whether the material may be used.")
    return " ".join(out) + "\n"


def _reachable(path: str | None) -> bool:
    """Does this document's file still resolve on the machine serving the query?

    A source can be indexed and then become unreachable — the knowledge archive
    is on a network share, and the share is routinely unmounted. Its documents
    stay searchable on purpose, but the path in the result no longer opens, and
    a caller that is told nothing will simply try to read it and get a
    confusing failure.

    Decision 2026-09-07: *"if the path no longer resolved - a notification
    message, but allow search and fail on navigating to the note."* So the
    search still answers from the index's own copy of the text; only the
    invitation to open the file is withdrawn.
    """
    if not path:
        return False
    try:
        return os.path.exists(path)
    except OSError:
        return False


def _hit(r, text: str) -> str:
    if not _reachable(r["path"]):
        # Not reachable by the INDEX either: its source is gone or unmounted
        # on the server side, so the row is a survivor of a corpus that moved.
        gone = ("  ⚠️ NOT REACHABLE even by the index — its source is not "
                "mounted here; the text below is the index's own copy")
    elif r["source"] in remote_sources():
        gone = ("  ⚠️ REMOTE — the index reads this over a network mount, so "
                "this path very likely does not resolve on your machine; use "
                "get_document with the doc_key rather than opening it")
    else:
        gone = ""
    # `visibility` rides on the same line as `date` and `doc_key` because the
    # reader about to reuse this fact is the one who needs it, and it cannot
    # see the manifest. `open` is free to reuse; `gated` and `unstated` need
    # verification against the source and the user's sign-off — the legend at
    # the head of the reply says so in full.
    return (f"### {r['title']}\n"
            f"date: {(r['date'] or 'unknown')[:10]}  |  doc_key: {r['doc_key']}"
            f"  |  visibility: {_visibility_row(r)}\n"
            f"path: {r['path']}{gone}\n\n{text}")


def t_search(a: dict) -> str:
    """Search, grouped by source unless exactly one source is named.

    The grouping is the default rather than an option because the failure it
    prevents is the caller forgetting to scope: a merged ranking over corpora
    of very different sizes reports the biggest corpus, not the right one. A
    caller who names one source has scoped deliberately and gets a single
    ranking, with `full` bodies if asked.
    """
    con = db.connect(readonly=True)
    sources = a.get("source") or None
    per_source = max(1, min(int(a.get("limit", 3)), 10))
    # An unrecognised value is dropped rather than refused: a filter is a
    # narrowing, and a caller who mistypes one should get the unfiltered
    # answer with the label on every hit, not an error instead of results.
    want_vis = a.get("visibility")
    if want_vis not in ("open", "gated", "unstated"):
        want_vis = None

    if sources and len(sources) == 1:
        rows, effective, relaxed_from = db.search_ex(
            con, a["query"], sources, a.get("since"), a.get("until"),
            per_source, visibility=want_vis,
            inherit_sources=_inherit_sources(want_vis))
        if not rows:
            return (f"No matches in `{sources[0]}`. Try broader terms, drop "
                    f"`source` to search every corpus, or call archive_stats.")
        full = bool(a.get("full"))
        head = [f"## [{sources[0]}] {len(rows)} result(s)"]
        if relaxed_from:
            head.append(f"_searched as_ `{effective}` — the query as written "
                        f"did not work (FTS5 either rejected it or matched "
                        f"nothing), so every token was quoted and OR-ed.")
        n_gone = sum(1 for r in rows if not _reachable(r["path"]))
        if n_gone:
            head.append(f"⚠️ {n_gone} of {len(rows)} name a path the index cannot "
                        f"resolve either — that source is not mounted on the "
                        f"server. The text is the index's own copy.")
        elif sources[0] in remote_sources():
            head.append(f"⚠️ `{sources[0]}` is read over a **network mount**, so "
                        f"these paths very likely do not resolve on your machine. "
                        f"**Use `get_document` with the doc_key rather than opening "
                        f"the path.**")
        legend = _visibility_legend([sources[0]], rows)
        if legend:
            head.append(legend)
        body = []
        for r in rows:
            text = r["body"] if full else r["snip"]
            if full and len(text) > 20000:
                text = text[:20000] + "\n... [truncated]"
            body.append(_hit(r, text))
        return "\n".join(head) + "\n\n" + "\n\n---\n\n".join(body)

    groups = db.search_grouped(con, a["query"], sources, a.get("since"),
                               a.get("until"), per_source,
                               visibility=want_vis,
                               inherit_sources=_inherit_sources(want_vis))
    if not groups:
        searched = ", ".join(sources) if sources else "every corpus"
        return (f"No matches in {searched}. Try broader terms, or call "
                f"archive_stats to check coverage.")
    note = groups[0][3]
    out = []
    if note:
        out.append(f"_searched as_ `{groups[0][2]}` — the query as written did "
                   f"not work (FTS5 either rejected it or matched nothing), so "
                   f"every token was quoted and OR-ed.\n")
    out.append("Grouped by source; each group is ranked on its own, so a hit in a "
               "small corpus is not buried by a large one.\n")
    remote = remote_sources()
    unreachable = sum(1 for _n, rows, _e, _r in groups
                      for r in rows if not _reachable(r["path"]))
    n_remote = sum(1 for name, rows, _e, _r in groups
                   for r in rows if name in remote and _reachable(r["path"]))
    if unreachable:
        out.append(f"⚠️ {unreachable} result(s) name a path the INDEX cannot resolve "
                   f"either — that source is not mounted on the server. The text is "
                   f"still the index's own copy and is answerable.\n")
    if n_remote:
        out.append(f"⚠️ {n_remote} result(s) come from a source the index reads over a "
                   f"**network mount** ({', '.join(sorted(remote))}), so those paths "
                   f"very likely do not resolve on your machine — the index has the "
                   f"share mounted, you may not. **Use `get_document` with the "
                   f"doc_key rather than opening the path**; it returns the full body "
                   f"without touching the filesystem.\n")
    legend = _visibility_legend([name for name, _rows, _e, _r in groups],
                               [r for _n, rs, _e, _r in groups for r in rs])
    if legend:
        out.append(legend)
    for name, rows, _effective, _relaxed in groups:
        out.append(f"## [{name}]")
        out.append("\n\n".join(_hit(r, r["snip"]) for r in rows))
    return "\n\n".join(out)


def t_get(a: dict) -> str:
    con = db.connect(readonly=True)
    r = con.execute("SELECT source,title,date,path,body,meta,visibility"
                    " FROM docs WHERE doc_key=?",
                    (a["doc_key"],)).fetchone()
    if not r:
        return f"No document with doc_key {a['doc_key']}"
    if not _reachable(r["path"]):
        note = ("\n⚠️ that path does not resolve for the index either — its source "
                "is not mounted on the server. The body below is the index's own "
                "copy, which is why this tool works when opening the file would not.")
    elif r["source"] in remote_sources():
        note = ("\n⚠️ that path is read over a network mount, so it very likely does "
                "not resolve on your machine. The body below is the index's own copy, "
                "which is why this tool works when opening the file would not.")
    else:
        note = ""
    legend = _visibility_legend([r["source"]], [r])
    return (f"# {r['title']}\nsource: {r['source']}  date: {r['date']}  "
            f"visibility: {_visibility_row(r)}\n"
            f"path: {r['path']}{note}\nmeta: {r['meta']}\n"
            + (f"\n{legend}" if legend else "")
            + f"\n{r['body']}")


def t_stats(_a: dict) -> str:
    con = db.connect(readonly=True)
    rows = db.stats(con)
    tot = con.execute("SELECT COUNT(*), SUM(bytes) FROM docs").fetchone()
    # `visibility` is here as well as on every hit, so a caller choosing which
    # source to search can see up front which corpora will need sign-off.
    lines = ["| source | docs | text | date range | visibility |",
             "|---|---:|---:|---|---|"]
    for r in rows:
        span = f"{(r['lo'] or '')[:10]} to {(r['hi'] or '')[:10]}" if r["lo"] else "-"
        lines.append(f"| {r['source']} | {r['n']:,} | {(r['b'] or 0)/1048576:.1f} MB "
                     f"| {span} | {_visibility_of(r['source'])} |")
    lines.append(f"| **total** | **{tot[0]:,}** | **{(tot[1] or 0)/1048576:.1f} MB** | | |")
    # Aliases, so a reader can tell that several addresses are ONE source
    # rather than wondering which of them the index used.
    try:
        from . import manifest
        aliased = {n: s.addresses() for n, s in manifest.load().items()
                   if s.addresses()}
    except Exception:
        aliased = {}
    if aliased:
        lines.append("")
        lines.append("Sources reachable at more than one address — the same "
                     "location, not copies:")
        for name, addrs in sorted(aliased.items()):
            lines.append(f"- **{name}**: {', '.join(addrs)}")
    return "\n".join(lines)


# One ingest at a time. The timer thread and a `refresh_index` call can
# otherwise overlap, and two writers on one SQLite file is a lock error rather
# than a merge.
_INGEST_LOCK = threading.Lock()


def t_refresh(_a: dict) -> str:
    from . import pipeline
    if not _INGEST_LOCK.acquire(blocking=False):
        return "A refresh is already running; the index will be current shortly."
    try:
        t0 = time.time()
        r = pipeline.ingest_all(optimize=True)
    finally:
        _INGEST_LOCK.release()
    out = [f"Re-ingested {r['sources']} source(s) in {time.time() - t0:.1f} s — "
           f"{r['added']} added, {r['updated']} changed, {r['unchanged']} "
           f"unchanged, {r['pruned']} pruned, {r['errors']} error(s), "
           f"{r['refused']} refused. {r['skipped_files']:,} file(s) skipped "
           f"unread on an unchanged mtime and size. Index now "
           f"{r['docs']:,} documents, {r['db_bytes'] / 1048576:.1f} MB."]
    if r["dropped"]:
        # Named, not just counted: a document leaving the index is the one
        # outcome a caller cannot discover by searching for it.
        out.append("Dropped (file or source gone): "
                   + ", ".join(f"{k} {v:,}" for k, v in sorted(r["dropped"].items())))
    if r["undeclared"]:
        out.append("Removed from the manifest, so their rows went: "
                   + ", ".join(r["undeclared"]))
    if r["reverify"]:
        out.append("Unreachable, so their file ledger was dropped — the next "
                   "pass that finds them re-reads and re-hashes every file "
                   "rather than trusting a pre-gap mtime: "
                   + ", ".join(r["reverify"]))
    if r["stale"]:
        # Kept deliberately: an unreachable root is not the same as a deleted
        # one, and an offline machine should keep searching what it indexed at
        # home. `lookup prune --source NAME` drops them on purpose.
        out.append("⚠️ Declared but unreachable, rows KEPT and now stale: "
                   + ", ".join(r["stale"]))
    if r["skipped"]:
        out.append("Skipped, root absent: " + ", ".join(r["skipped"]))
    return "\n".join(out)


HANDLERS = {"search_archive": t_search, "get_document": t_get,
            "archive_stats": t_stats, "refresh_index": t_refresh}


def _mount_note(r: dict) -> str:
    """What happened to the network shares this pass, for the log line.

    Silent when nothing changed, which is almost every pass. A share attaching
    or detaching is the event worth seeing: it is the difference between a
    source being genuinely empty and being temporarily unreachable, and it is
    the only visible sign that walking back onto the home network restored the
    archive without anyone doing anything.
    """
    m = r.get("mounts") or {}
    bits = []
    if m.get("attached"):
        bits.append("share ATTACHED: " + ", ".join(m["attached"]))
    if m.get("detached"):
        bits.append("share detached: " + ", ".join(m["detached"]))
    if m.get("failed"):
        bits.append("share mount FAILED: " + "; ".join(
            f"{k}: {v}" for k, v in sorted(m["failed"].items())))
    return ("  " + "  ".join(bits)) if bits else ""


def _refresher(interval: int) -> None:
    """Re-ingest on a timer, forever.

    The timer doubles as the poll for network shares: `ingest_all` reconciles
    them first, so a share that has come back is mounted and indexed on the
    next tick with nothing scheduled separately.

    A timer rather than a file watcher, deliberately. The corpora reach a
    container as bind mounts from macOS through a Linux VM, and inotify does
    not propagate reliably across that boundary — a watcher would look correct
    and silently miss changes, which is the worst of the available failure
    modes. A timer cannot miss anything; it can only be late, and an ingest
    costs ~1.5 s, so a 5-minute tick is well under 1% duty cycle. `sessions/`
    and the vault change many times a day, which is why "on demand only" is not
    enough on its own — hence `refresh_index` as well, for when a caller cannot
    wait for the next tick.
    """
    from . import pipeline
    while True:
        time.sleep(interval)
        if not _INGEST_LOCK.acquire(blocking=False):
            continue
        try:
            t0 = time.time()
            r = pipeline.ingest_all(optimize=True)
            sys.stderr.write(
                "refresh: %d source(s), +%d added, %d changed, %d unchanged, "
                "%d pruned%s, %d total, %.1fs\n"
                % (r["sources"], r["added"], r["updated"], r["unchanged"],
                   r["pruned"],
                   (" [" + ", ".join(f"{k} {v}" for k, v in sorted(r["dropped"].items())) + "]")
                   if r["dropped"] else "",
                   r["docs"], time.time() - t0))
            if note := _mount_note(r):
                sys.stderr.write("refresh:%s\n" % note)
            sys.stderr.flush()
        except Exception as e:
            # A refresh failure must not kill the server: the existing index is
            # still serving, and the next tick may well succeed.
            sys.stderr.write("refresh FAILED: %s: %s\n" % (type(e).__name__, e))
            sys.stderr.flush()
        finally:
            _INGEST_LOCK.release()


def _send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def handle(req: dict) -> dict | None:
    """Dispatch one JSON-RPC request. Returns the reply, or None for a
    notification, which is never answered.

    Pure and transport-free on purpose: the stdio loop and the HTTP server both
    call this, so the two transports cannot drift apart in what they support.
    """
    method, mid = req.get("method"), req.get("id")
    if mid is None:
        return None

    def ok(result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def err(code, message):
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}

    try:
        if method == "initialize":
            want = (req.get("params") or {}).get("protocolVersion")
            return ok({"protocolVersion": want if want in SUPPORTED else PROTOCOL_VERSION,
                       "capabilities": {"tools": {}},
                       "serverInfo": {"name": "lookup", "version": VERSION}})
        if method == "tools/list":
            return ok({"tools": TOOLS})
        if method == "tools/call":
            p = req.get("params") or {}
            fn = HANDLERS.get(p.get("name"))
            if not fn:
                return err(-32602, f"unknown tool {p.get('name')}")
            return ok({"content": [{"type": "text", "text": fn(p.get("arguments") or {})}]})
        if method == "ping":
            return ok({})
        return err(-32601, f"method not found: {method}")
    except Exception as e:
        return err(-32603, f"{type(e).__name__}: {e}")


def serve(stdin=None, stdout=None) -> int:
    """MCP over stdio: one JSON object per line."""
    for line in (stdin or sys.stdin):
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        reply = handle(req)
        if reply is not None:
            _send(reply)
    return 0


def serve_http(host: str = "0.0.0.0", port: int = 8100,
               reingest_interval: int = 300,
               ingest_on_start: bool = True) -> int:
    """MCP over Streamable HTTP, so a RESIDENT process can serve every session.

    This exists because the stdio transport forces one server process per
    session, and per-session containers are what got the earlier incarnation
    scrapped: `docker run --rm` does not reap when a client dies without
    closing stdin. One long-lived HTTP server has no such failure mode — the
    process outlives every client by design rather than by accident.

    Deliberately stateless: no `Mcp-Session-Id` is issued and no SSE stream is
    offered, because every method here is a single request and a single reply.
    A client that wants a stream can still POST; it gets `application/json`.
    """
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = f"lookup/{VERSION}"

        def log_message(self, fmt, *args):        # noqa: A003 - stdlib name
            # One line per request on stderr, so `docker logs` is useful and
            # stdout stays clean for anything that pipes it.
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def _json(self, code: int, payload) -> None:
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> bytes:
            """Read the request body, decoding chunked framing when present.

            `Transfer-Encoding: chunked` is what an HTTP client reaches for
            when it streams a body — Bun's fetch, and therefore OpenCode's MCP
            transport, sends every request that way. BaseHTTPRequestHandler
            does not decode chunked, so a handler that reads only
            Content-Length sees zero bytes, answers 202, and leaves the chunk
            framing on a keep-alive connection; the next request then parses a
            chunk-size line as its request line and the client gets a
            "Bad request syntax" or 501 that names nothing real. Decode it
            here, falling back to Content-Length for clients that send one.
            """
            if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
                out = bytearray()
                while True:
                    line = self.rfile.readline(65536).strip()
                    if b";" in line:                 # chunk extensions
                        line = line.split(b";", 1)[0]
                    if not line:
                        break
                    try:
                        size = int(line, 16)
                    except ValueError:
                        break
                    if size == 0:
                        while True:                  # trailers, then a blank line
                            if self.rfile.readline(65536) in (b"\r\n", b"\n", b""):
                                break
                        break
                    out += self.rfile.read(size)
                    self.rfile.read(2)               # the CRLF after each chunk
                return bytes(out)
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n)

        def do_GET(self):
            # A liveness probe that touches the index, so a compose healthcheck
            # fails when the database is missing rather than when the process
            # is gone -- the second is the failure that actually happens.
            if self.path.rstrip("/") in ("/healthz", "/health"):
                try:
                    con = db.connect(readonly=True)
                    n = con.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
                    self._json(200, {"status": "ok", "docs": n, "version": VERSION})
                except Exception as e:
                    self._json(503, {"status": "unavailable",
                                     "error": f"{type(e).__name__}: {e}"})
                return
            self._json(404, {"error": "not found"})

        def do_POST(self):
            # Read the body BEFORE any early return. A 404 that leaves the body
            # on a keep-alive connection is worse than a 404: the next request
            # reads those leftover bytes as its request line and the client
            # gets a 501 that names nothing real. This is not hypothetical --
            # OpenCode POSTs to `/mcp?codemode=false`, and matching the raw
            # `self.path` treated the query string as part of the path, so the
            # body was never drained.
            body = self._body()
            path = self.path.split("?", 1)[0].split("#", 1)[0].rstrip("/")
            if path not in ("/mcp", ""):
                self._json(404, {"error": "not found"})
                return
            try:
                req = json.loads(body or b"{}")
            except (ValueError, json.JSONDecodeError) as e:
                self._json(400, {"jsonrpc": "2.0", "id": None, "error": {
                    "code": -32700, "message": f"parse error: {e}"}})
                return
            # A batch is a list; the spec allows one, and answering it here is
            # three lines rather than a client-side workaround later.
            if isinstance(req, list):
                out = [r for r in (handle(x) for x in req) if r is not None]
                self._json(200, out)
                return
            reply = handle(req)
            if reply is None:
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._json(200, reply)

    if ingest_on_start:
        # A resident container starts with an empty named volume the first time,
        # so without this the first search reports "index not found" and the
        # cause looks like a mount problem rather than a cold start.
        from . import pipeline
        with _INGEST_LOCK:
            try:
                t0 = time.time()
                r = pipeline.ingest_all(optimize=True, vacuum=True)
                # Report drops here too, not only on the timer. The startup
                # pass is where an undeclared source loses its rows, and a
                # document leaving the index is the one outcome a caller
                # cannot discover by searching for it.
                dropped = ("  dropped: " + ", ".join(
                    f"{k} {v}" for k, v in sorted(r["dropped"].items()))
                ) if r["dropped"] else ""
                stale = ("  stale (rows kept): " + ", ".join(r["stale"])) if r["stale"] else ""
                sys.stderr.write("startup ingest: %d docs, %.1f MB, %.1fs%s%s%s\n"
                                 % (r["docs"], r["db_bytes"] / 1048576,
                                    time.time() - t0, dropped, stale,
                                    _mount_note(r)))
            except Exception as e:
                sys.stderr.write("startup ingest FAILED: %s: %s\n"
                                 % (type(e).__name__, e))
            sys.stderr.flush()

    if reingest_interval > 0:
        threading.Thread(target=_refresher, args=(reingest_interval,),
                         daemon=True, name="reingest").start()

    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    sys.stderr.write(f"lookup {VERSION} MCP on http://{host}:{port}/mcp\n")
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
