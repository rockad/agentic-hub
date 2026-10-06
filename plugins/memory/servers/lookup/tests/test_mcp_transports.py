"""The two MCP transports, and the resident server's own machinery.

`handle()` is transport-free so stdio and HTTP cannot drift apart in what they
support; these tests pin that, the HTTP surface, and the "unchanged" path that
makes a periodic re-ingest a genuine no-op.

unittest, not pytest: the Dockerfile's build stage runs `python3 -m unittest`
with nothing installed but this package. See test_search_relax.py.
"""
from __future__ import annotations

import io
import json
import pathlib
import sqlite3
import threading
import unittest
import urllib.error
import urllib.request

from lookup import db, mcp


def _con():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript(db.config.SCHEMA.read_text(encoding="utf-8"))
    return c


DOC = {"source": "memory", "path": "/x/vault-holds-notes-only.md",
       "title": "The vault holds notes only", "date": "2026-09-03",
       "body": "The vault holds notes and attachments only.",
       "meta": {}, "src_sha256": "deadbeef"}


class UpsertUnchangedTests(unittest.TestCase):
    """A re-ingest over an unchanged corpus must not rewrite a single row.

    Without this the resident server's five-minute timer rewrote all 1,199
    rows every tick — `ingested` alone dirtied every page — and one refresh
    took the database from 28.3 MB to 40.8 MB. Growth was unbounded until the
    process restarted.
    """

    def setUp(self):
        self.con = _con()
        self.cur = self.con.cursor()

    def tearDown(self):
        self.con.close()

    def test_first_write_is_added(self):
        self.assertEqual(db.upsert_ex(self.cur, "k1", dict(DOC)), "added")

    def test_identical_second_write_is_unchanged(self):
        db.upsert_ex(self.cur, "k1", dict(DOC))
        self.assertEqual(db.upsert_ex(self.cur, "k1", dict(DOC)), "unchanged")

    def test_unchanged_does_not_touch_ingested(self):
        db.upsert_ex(self.cur, "k1", dict(DOC))
        before = self.cur.execute(
            "SELECT ingested FROM docs WHERE doc_key='k1'").fetchone()["ingested"]
        db.upsert_ex(self.cur, "k1", dict(DOC))
        after = self.cur.execute(
            "SELECT ingested FROM docs WHERE doc_key='k1'").fetchone()["ingested"]
        self.assertEqual(before, after)

    def test_a_changed_body_is_an_update(self):
        db.upsert_ex(self.cur, "k1", dict(DOC))
        d = dict(DOC, body=DOC["body"] + " Scripts live outside it.")
        self.assertEqual(db.upsert_ex(self.cur, "k1", d), "updated")

    def test_a_changed_digest_alone_is_an_update(self):
        # The body can be identical while the source file has been rewritten;
        # src_sha256 is the ledger's join key, so it must not go stale.
        db.upsert_ex(self.cur, "k1", dict(DOC))
        self.assertEqual(
            db.upsert_ex(self.cur, "k1", dict(DOC, src_sha256="cafe")), "updated")

    def test_a_digest_going_to_none_is_an_update(self):
        db.upsert_ex(self.cur, "k1", dict(DOC))
        self.assertEqual(
            db.upsert_ex(self.cur, "k1", dict(DOC, src_sha256=None)), "updated")

    def test_the_old_bool_wrapper_still_means_newly_added(self):
        self.assertTrue(db.upsert(self.cur, "k2", dict(DOC, path="/x/other.md")))
        self.assertFalse(db.upsert(self.cur, "k2", dict(DOC, path="/x/other.md")))


class HandleTests(unittest.TestCase):
    """One dispatcher, so the transports cannot support different things."""

    def test_initialize_echoes_a_supported_protocol(self):
        r = mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "2024-11-05"}})
        self.assertEqual(r["result"]["protocolVersion"], "2024-11-05")
        self.assertEqual(r["result"]["serverInfo"]["name"], "lookup")

    def test_initialize_falls_back_for_an_unknown_protocol(self):
        r = mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "1999-01-01"}})
        self.assertEqual(r["result"]["protocolVersion"], mcp.PROTOCOL_VERSION)

    def test_a_notification_is_never_answered(self):
        self.assertIsNone(mcp.handle({"jsonrpc": "2.0",
                                      "method": "notifications/initialized"}))

    def test_tools_list_matches_the_handler_table(self):
        r = mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(sorted(t["name"] for t in r["result"]["tools"]),
                         sorted(mcp.HANDLERS))

    def test_unknown_method_and_unknown_tool_are_distinct_errors(self):
        self.assertEqual(
            mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "nope"})["error"]["code"],
            -32601)
        self.assertEqual(
            mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                        "params": {"name": "nope"}})["error"]["code"], -32602)

    def test_a_raising_tool_becomes_an_internal_error_not_a_crash(self):
        mcp.HANDLERS["boom"] = lambda _a: (_ for _ in ()).throw(RuntimeError("bang"))
        try:
            r = mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                            "params": {"name": "boom"}})
            self.assertEqual(r["error"]["code"], -32603)
            self.assertIn("bang", r["error"]["message"])
        finally:
            del mcp.HANDLERS["boom"]

    def test_ping(self):
        self.assertEqual(
            mcp.handle({"jsonrpc": "2.0", "id": 7, "method": "ping"}),
            {"jsonrpc": "2.0", "id": 7, "result": {}})


class StdioTests(unittest.TestCase):
    def test_stdio_answers_requests_and_skips_junk(self):
        lines = io.StringIO('\n'.join([
            '{"jsonrpc":"2.0","id":1,"method":"ping"}',
            'not json at all',
            '',
            '{"jsonrpc":"2.0","method":"notifications/initialized"}',
            '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
        ]))
        out = []
        real = mcp._send
        mcp._send = out.append
        try:
            mcp.serve(stdin=lines)
        finally:
            mcp._send = real
        self.assertEqual([m["id"] for m in out], [1, 2])


class HttpTests(unittest.TestCase):
    """The transport a resident container needs.

    stdio forces one server process per client, and a container per session is
    what leaked on core and got the earlier incarnation scrapped.
    """

    @classmethod
    def setUpClass(cls):
        # A FILE database, not `:memory:`, and `config.DB` rather than a
        # patched `db.connect`. The HTTP server answers on its own threads, and
        # a sqlite3 connection may only be used by the thread that created it —
        # handing every thread the same in-memory object raises
        # ProgrammingError, which surfaced as a 503 from /healthz and looked
        # like a server bug rather than a test one. A file lets each thread
        # open its own connection, which is what the real deployment does.
        import tempfile
        cls.tmp = tempfile.TemporaryDirectory()
        cls._real_db = db.config.DB
        db.config.DB = pathlib.Path(cls.tmp.name) / "index.db"
        con = db.connect()
        con.execute(
            "INSERT INTO docs(doc_key, source, path, title, date, body, ingested)"
            " VALUES (?,?,?,?,?,?,?)",
            ("k1", "memory", "/x/m.md", "The vault holds notes only", "2026-09-03",
             "The vault holds notes and attachments only.", "2026-09-07"))
        con.commit()
        con.close()

        # serve_http binds inside itself, so port 0 would hide the chosen port
        # from the test. Take a free port here and hand it over concretely, so
        # a parallel run cannot collide either.
        import socket
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        cls.port = s.getsockname()[1]
        s.close()
        cls.thread = threading.Thread(
            target=mcp.serve_http,
            kwargs={"host": "127.0.0.1", "port": cls.port, "reingest_interval": 0,
                    "ingest_on_start": False},
            daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.port}"
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.url + "/healthz", timeout=1).read()
                break
            except Exception:
                import time
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        db.config.DB = cls._real_db
        cls.tmp.cleanup()

    def post(self, payload):
        req = urllib.request.Request(
            self.url + "/mcp", data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, (json.loads(r.read()) if r.status != 202 else None)

    def test_healthz_reports_the_document_count(self):
        with urllib.request.urlopen(self.url + "/healthz", timeout=5) as r:
            body = json.loads(r.read())
        self.assertEqual(r.status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["docs"], 1)

    def test_a_request_gets_a_json_rpc_reply(self):
        status, body = self.post({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"jsonrpc": "2.0", "id": 1, "result": {}})

    def test_a_notification_gets_202_and_no_body(self):
        status, body = self.post({"jsonrpc": "2.0",
                                  "method": "notifications/initialized"})
        self.assertEqual(status, 202)
        self.assertIsNone(body)

    def test_a_batch_is_answered_as_a_list(self):
        status, body = self.post([{"jsonrpc": "2.0", "id": 1, "method": "ping"},
                                  {"jsonrpc": "2.0", "method": "notifications/x"},
                                  {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}])
        self.assertEqual(status, 200)
        self.assertEqual([m["id"] for m in body], [1, 2])

    def test_a_search_comes_back_grouped(self):
        _s, body = self.post({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                              "params": {"name": "search_archive",
                                         "arguments": {"query": "vault"}}})
        self.assertIn("## [memory]", body["result"]["content"][0]["text"])

    def test_an_unknown_path_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(self.url + "/nope", timeout=5)
        self.assertEqual(e.exception.code, 404)

    def test_malformed_json_is_a_parse_error_not_a_crash(self):
        req = urllib.request.Request(
            self.url + "/mcp", data=b"{not json",
            headers={"Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(e.exception.code, 400)
        self.assertEqual(json.loads(e.exception.read())["error"]["code"], -32700)


if __name__ == "__main__":
    unittest.main()


class UnreachablePathTests(unittest.TestCase):
    """A document can outlive the mount that made its path resolvable.

    The knowledge archive is a network share and is routinely unmounted. Its
    documents stay searchable on purpose — an unreachable source is not a
    deleted one — so the result has to say that the path will not open rather
    than letting the caller find out by trying.

    Decision 2026-09-07: *"if the path no longer resolved - a notification
    message, but allow search and fail on navigating to the note."*
    """

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.tmp.name)
        self.here = base / "present.md"
        self.here.write_text("mounted and readable", encoding="utf-8")
        self._real_db = db.config.DB
        db.config.DB = base / "index.db"
        con = db.connect()
        cur = con.cursor()
        for key, path, src in (("live", str(self.here), "vault"),
                               ("gone", "/Volumes/not-mounted/x.md", "archive")):
            db.upsert_ex(cur, key, {
                "source": src, "path": path, "title": f"doc {key}",
                "date": "2026-09-01",
                "body": "passphrase keychain escalation", "meta": {}})
        con.commit()
        con.close()
        self.con = db.connect(readonly=True)
        self._connect = db.connect
        db.connect = lambda readonly=False: self.con

    def tearDown(self):
        db.connect = self._connect
        self.con.close()
        db.config.DB = self._real_db
        self.tmp.cleanup()

    def test_reachable_helper(self):
        self.assertTrue(mcp._reachable(str(self.here)))
        self.assertFalse(mcp._reachable("/Volumes/not-mounted/x.md"))
        self.assertFalse(mcp._reachable(None))

    def test_a_live_path_is_not_annotated(self):
        out = mcp.t_search({"query": '"passphrase"', "source": ["vault"]})
        self.assertNotIn("NOT REACHABLE", out)

    def test_an_unreachable_path_is_annotated_and_still_returned(self):
        out = mcp.t_search({"query": '"escalation"', "source": ["archive"]})
        self.assertIn("NOT REACHABLE", out)
        # Search must still answer: the text is the index's own copy.
        self.assertIn("doc gone", out)

    def test_the_grouped_reply_counts_them_up_front(self):
        out = mcp.t_search({"query": '"keychain"'})
        self.assertIn("the INDEX cannot resolve either", out)

    def test_get_document_says_so_and_still_serves_the_body(self):
        out = mcp.t_get({"doc_key": "gone"})
        self.assertIn("does not resolve for the index either", out)
        self.assertIn("passphrase keychain escalation", out)

    def test_get_document_is_silent_for_a_live_path(self):
        out = mcp.t_get({"doc_key": "live"})
        self.assertNotIn("does not resolve", out)

    def test_the_tool_description_warns_the_caller(self):
        tool = next(t for t in mcp.TOOLS if t["name"] == "search_archive")
        self.assertIn("NOT REACHABLE", tool["description"])
        self.assertIn("REMOTE", tool["description"])


class RemoteSourceMarkingTests(unittest.TestCase):
    """A path can be real to the index and unopenable by the caller.

    ⚠️ The first implementation of this checked `os.path.exists` in the server
    and shipped. It was useless for the case it was built for: the server is a
    container whose own cifs volume mounts /Volumes/knowledge-archive whatever
    the host has, so when the host's SMB mount was removed every archive result
    still reported as reachable — correct from where the check ran, and wrong
    for the caller who asked. The server cannot know what the caller mounted;
    it can know which sources it reads over a network volume, because the
    manifest says so.
    """

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.tmp.name)
        # A path that DOES resolve for the server, from a source the manifest
        # marks as volume-backed: exactly the case that defeated version one.
        self.shared = base / "on-the-share.md"
        self.shared.write_text("mounted for the index", encoding="utf-8")
        self._real_db = db.config.DB
        db.config.DB = base / "index.db"
        con = db.connect()
        cur = con.cursor()
        db.upsert_ex(cur, "k", {"source": "archive", "path": str(self.shared),
                                "title": "on the share", "date": "2026-09-01",
                                "body": "opsgenie escalation runbook", "meta": {}})
        db.upsert_ex(cur, "v", {"source": "vault", "path": str(self.shared),
                                "title": "local note", "date": "2026-09-01",
                                "body": "opsgenie escalation runbook", "meta": {}})
        con.commit(); con.close()
        self.con = db.connect(readonly=True)
        self._connect = db.connect
        db.connect = lambda readonly=False: self.con
        self._remote = mcp._REMOTE_SOURCES
        mcp._REMOTE_SOURCES = {"archive"}

    def tearDown(self):
        mcp._REMOTE_SOURCES = self._remote
        db.connect = self._connect
        self.con.close()
        db.config.DB = self._real_db
        self.tmp.cleanup()

    def test_a_resolvable_path_from_a_remote_source_is_still_marked(self):
        out = mcp.t_search({"query": '"opsgenie"', "source": ["archive"]})
        self.assertIn("network mount", out)
        self.assertIn("get_document", out)

    def test_the_same_path_from_a_local_source_is_not_marked(self):
        out = mcp.t_search({"query": '"opsgenie"', "source": ["vault"]})
        self.assertNotIn("network mount", out)

    def test_the_grouped_reply_names_the_remote_sources(self):
        out = mcp.t_search({"query": '"runbook"'})
        self.assertIn("network mount", out)
        self.assertIn("archive", out)

    def test_get_document_marks_it_too(self):
        out = mcp.t_get({"doc_key": "k"})
        self.assertIn("network mount", out)
        self.assertIn("opsgenie escalation runbook", out)

    def test_get_document_is_silent_for_the_local_one(self):
        self.assertNotIn("network mount", mcp.t_get({"doc_key": "v"}))
