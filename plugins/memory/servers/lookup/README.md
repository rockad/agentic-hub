# lookup

Search over user material — Obsidian vault, durable memories,
session handoff files, repository documentation, shared knowledge base,
skills, and transcripts — plus personal archives the extractors reach: Gmail, Google Drive
documents, Gemini conversations, interview transcripts, calendar, contacts, bookmarks and
activity history.

Everything is local. No cloud service is contacted at any point. It exposes an MCP server,
which is the interface Claude uses and the one part of this project that must not change
shape if the engine underneath it ever does.

## Two layers

`lookup` is deliberately two things, and the distinction decides where new code may go.

**1. The search engine — SQLite FTS5, chosen by measurement.** Scored against eleven
questions written in advance, on 1,197 documents across eight sources, it answers **10
within the top 3** — a tie with a hybrid BM25-plus-vector engine (Zilliz claude-context on
Milvus), while building in **1.4 s** to **28 MB** and answering in **0.06 s** against that
engine's 835 s, three-container stack and 0.21 s. LEANN, the third candidate, cost 361 s
and 2.6–4.4 s per query for no better result. The full comparison, both deployment modes
and every measured figure is in [`eval/RESULTS.md`](eval/RESULTS.md).

**2. The extractors — the ingestion stage, and the irreplaceable part.** Nothing
off-the-shelf parses Google Takeout `MyActivity.html`, a 3.5 GB mbox streamed
message-by-message, `.vcf` or `.ics` into per-document text. The design settled their future
on 2026-09-07: *"lookup should be able to extract info from as many sources as possible so
it's good to keep the extractors and use those when necessary."* So they stay, and adding a
format is expected work here.

⚠️ **An extractor existing for a source is not permission to index it.** The Gmail Takeout
under the knowledge archive's `google/mail` exists only to build Writing Voice, and the rest
of the personal Takeout is reserved for a future Doppelganger enrichment pass. Neither may
be folded into a general-purpose index. The manifest is where that is enforced.

## ⚠️ Search per source, not across all of them

`bm25()` is computed over the whole index, so **one merged ranking across corpora of very
different sizes returns whichever corpus is largest rather than whichever is right.**
Measured on the eleven questions: **per-source search answers 10 of 11 in the top 3; one
merged ranking answers 6.** Nothing about the engine changed between those two numbers —
only the query.

So `search_archive` **groups its results by source by default**, one small ranking per
corpus, and its description tells the caller to read every group. Pass `source` only to
narrow deliberately. From the CLI the same behaviour is `search --grouped`, opt-in there so
existing scripts keep the flat output they parse.

This is also why `.claude/memory/MEMORY.md` is excluded from the `memory` source: it is one
line per memory, an index *of* that corpus rather than content in it, and it took a top-3
slot on five of the eleven questions — displacing the memory that held the answer. Grouping
cannot fix that one, because the competition is inside a single source.

## Inclusion principle

**`sources.toml` is the only declaration of what may be indexed.** There is no
"index everything except ..." mode and no recursive discovery from a parent
directory. Adding data to the index is an edit to that file, visible in a diff.

This is not stylistic. The same physical disk holds `/media/media2/External`,
which is **restricted data and must never be indexed**. An exclusion list makes that
a rule someone can forget; an inclusion list makes it structurally absent. Three
layers enforce it:

1. `External` appears in no declared root — and a test asserts that.
2. The container never bind-mounts it.
3. `pipeline.py` re-checks every document's resolved path against its declared
   root before writing, and refuses anything that escapes (including via
   symlink). A refusal is reported and makes `ingest` exit non-zero.

## Layout

```
sources.toml               the inclusion manifest for what lives only on core
sources.example.toml       a template for your own manifest, kept outside this
                           repo -- LOOKUP_MANIFEST points at it
eval/                      the engine comparison: RESULTS.md and the candidates
src/lookup/
  manifest.py              loads and enforces sources.toml
  pipeline.py              ingest orchestration + the inclusion re-check
  db.py                    schema access, doc identity, search
  cli.py                   sources | ingest | search | stats | mcp
  mcp.py                   MCP server over stdio
  extract/                 one module per format family
tests/                     inclusion invariants + extractor regressions
```

## Design

- **SQLite FTS5**, not Elasticsearch/Meilisearch. The deployment target is a Raspberry Pi 4
  with 8 GB RAM, **swap fully consumed**, running live Home Assistant. A JVM search engine
  is not viable there and a resident daemon is risk for no gain. FTS5 is a single file,
  zero idle memory, BM25 ranking and `snippet()` included.
- **Stdlib only.** No third-party Python. The image is ~150 MB and cross-builds for arm64
  with no compiled dependencies.
- **External-content FTS5**: text is stored once in `docs`, indexed by `fts`, not duplicated.
- **`unicode61 remove_diacritics 2`** tokenizer — the corpus mixes English, Russian and
  Finnish, so Cyrillic must tokenise properly. Verified: a query for `Грузия` matches.
- **A resident compose container, with host stdio as the fallback** — measured, not
  assumed, and measured *through the MCP tool* rather than the CLI. The container answers
  a first tool call in 22–48 ms against 65 ms warm and 239 ms cold for a fresh stdio
  process, holds 23.6 MiB **once** instead of ~20 MB per session, and returns identical
  grouped results on 11 of 11 questions. It costs ~5 ms more per query (17 ms against
  12 ms) and a 215 MB image. Figures and the reasoning: [`eval/RESULTS.md`](eval/RESULTS.md)
  Part 2.
- ⚠️ **One resident server, never one container per session.** The original design spawned
  the MCP server per session with `docker run --rm`, and that is what got the earlier
  incarnation scrapped: `--rm` does not fire when a session dies without closing stdin, so
  containers accumulated with nothing reaping them. The failure was reproduced during the
  evaluation in a completely different tool, so it is a property of `run --rm` with a stdio
  MCP server rather than of this code. **A resident HTTP server has no reaping problem to
  solve** — the process outlives every client by design instead of by accident.
- **The image build is the only place the stdlib-only rule is enforced**, which is a reason
  to keep it regardless of where the server runs: it has caught two bugs a local run could
  not — a backslash inside an f-string, and a `pytest` import in a test.

## Usage

**The container is the only deployment.** Host installation was removed on 2026-09-07 once
the benchmark showed the container matched it: *"if benchmark shows that
containerised version is working as fast as the host installed one — cleanup the host's
installation and path, remove it from docs also, leave only container."*

```bash
cp .env.example .env && $EDITOR .env       # LOOKUP_HOME — one variable, no per-corpus names
uv run lookup mounts --write               # derive the source mounts from the manifest
docker compose up -d                       # ~2.3 s to healthy, startup ingest included
curl -s localhost:8100/healthz             # {"status":"ok","docs":1201,...}

claude mcp add --scope user --transport http lookup http://127.0.0.1:8100/mcp
```

⚠️ **`uv run lookup`, not bare `lookup`.** Nothing installs this package on the host any
more — that was host mode, and it is gone — so the console script is not on `$PATH` and the
first thing a fresh machine would otherwise hit is `command not found`, on the one step that
must not be skipped. Without the override the container starts with **no corpora mounted**
and the first ingest finds nothing, which reads as a broken manifest rather than a missing
generate step.

With Docker but no `uv`, the image can emit it instead — same code, no host Python:

```bash
docker compose build
docker run --rm -e LOOKUP_HOME="$HOME" -e LOOKUP_MANIFEST=/app/sources.toml \
  -v "/path/to/your/sources.toml:/app/sources.toml:ro" \
  lookup:local mounts > docker-compose.override.yml
```

`.env` rather than exported variables, so `up -d` works from any shell — including whatever
starts it after a reboot. It and the generated `docker-compose.override.yml` are gitignored
because the paths are machine-local; `.env.example` is tracked and carries the shape.

It re-ingests at startup, then every 300 s, and `refresh_index` forces it in between —
`docker-compose.yml` says why a timer rather than a file watcher. **Loopback only:** this is
a local-first index over private material, current-employer notes included, and it has no
authentication of its own.

**The index survives** a restart, `docker compose down`, `docker rm -f` and an image
rebuild, because it lives in the named volume `lookup_index`; the service picks it up,
verifies it by counting rows on `/healthz`, and its first refresh reports the corpus
unchanged. Measured, not assumed — `eval/RESULTS.md` Part 3. Only `down -v` discards it,
and that costs one ~2 s rebuild.

### One source, several addresses

A share can be reachable at more than one address — `smb://core/knowledge-archive`,
`smb://core.lan/knowledge-archive` and `smb://192.168.1.90/knowledge-archive` are one
machine — so a source may declare them:

```toml
aliases = [
  "smb://core/knowledge-archive",
  "smb://core.lan/knowledge-archive",
  "smb://192.168.1.90/knowledge-archive",
]
```

That is a **check, not resolution logic**. Document identity is address-independent already
(`sha1(source|path|key)`, with paths under `root`), so an alias changes nothing about what
is indexed. What it buys: `mounts --write` accepts any listed address in the source's
`<VOLUME>_DEVICE` variable and normalises it to the `//host/share` form the kernel wants,
and **refuses an address that is not listed** — so a mistyped host cannot quietly mount a
different share under a source name that already holds documents.

The compose default stays the IPv4 literal, which needs no resolver and so works anywhere
the LAN does. ⚠️ Note the host and the container can resolve a name differently: on macOS
`core` goes via LAN DNS to `core.lan` with IPv6 addresses only, while `~/.ssh/config` maps
it to the IPv4 literal — inside the Docker VM all three forms reach the same address.

⚠️ **Renaming a source orphans its volume.** The volume name is derived from the source
name, so `src_oldname` is left behind and `src_newname` created. Nothing is lost when the
volume is a network share — it holds no data, it *is* the share — but `docker volume rm`
is needed to tidy up.

⚠️ **Changing the address means removing the volume.** A named volume's `driver_opts` are
fixed at creation, so editing `device` and running `up -d` silently reuses the old one:
`docker compose down`, `docker volume rm <project>_<volume>`, `up -d`. Nothing is lost —
the volume holds no data, it *is* the share.

### A source declares its visibility

A fact inherits the visibility of the system it came from, so a source says which that
was:

```toml
visibility = "open"     # a company-wide channel, an unrestricted page, anything published
visibility = "gated"    # a DM, a private channel, a permission-restricted page
# omitted               # unstated: provenance not declared
```

`open` material is free to reuse. `gated` material is usable only once the fact has been
verified against its source and the owner has explicitly signed it off. **Nothing is ever
banned** — provenance decides the ceremony, not whether the material may be used, so a
gated fact goes to the owner rather than being discarded. Omitting the key leaves the
source `unstated`, which is **reported as such and handled as gated**: an undeclared
source is of unknown provenance, and unknown resolves to gated, so defaulting to `open`
would silently assert the one thing that cannot be taken back once something has been
reused on the strength of it. An invalid value is a manifest error rather than a silent
fallback.

The label travels with the answer, because the reader about to reuse a fact cannot see the
manifest: every `search_archive` hit and every `get_document` header carries
`visibility: …`, a reply containing a gated or unstated source is prefixed with what that
obliges, `archive_stats` lists it per source, and `lookup sources` prints it.

### Adding a source

One `[[source]]` block in your manifest (the file `LOOKUP_MANIFEST` points at), then regenerate the mounts:

```bash
$EDITOR "$LOOKUP_MANIFEST"
uv run lookup mounts --write && docker compose up -d
```

No new environment variable, no hand-written mount, no code change. Roots resolve `${VAR}`
from the environment — **any** variable — or take a plain absolute path, so a source
outside `${LOOKUP_HOME}` needs nothing special.

### Development

`uv run` is the development loop, which is not a deployment:

```bash
uv run --quiet python -m unittest discover -s tests -t .
LOOKUP_HOME="$HOME" LOOKUP_MANIFEST="$PWD/sources.example.toml" \
  LOOKUP_DB=/tmp/dev.db uv run --quiet lookup search "vault notes only" --grouped
```

`lookup mcp` without `--http` still speaks stdio, kept for debugging a client by hand. It
is not how anything is deployed: a stdio MCP server means one process per session, and one
*container* per session is what got this project's earlier incarnation scrapped.

Ask a plain question: punctuation and hyphens are safe, and so is a phrase whose words do
not all appear together — a query FTS5 rejects, or accepts and matches nothing, is retried
with every token quoted and OR-ed, and the reply says what was actually searched.
Deliberate FTS5 syntax runs verbatim, and its empty result is left as the answer.

## Sources

`lookup sources` prints the manifest. Text-native sources (Gemini, vault, mail, calendar,
contacts, bookmarks, activity, NotebookLM, transcripts) are parsed directly.

**Binary documents (PDF/Office) are NOT converted here.** They go through the existing
`vault-markdown-convert` skill — which already handles markitdown plus a local OCR fallback
for scanned PDFs — and the resulting `.md` files are dropped into `/data/converted`, picked
up by the `documents` source. Deliberately not reimplemented: one converter, not two.

## Deployment

⚠️ **The registry image is `git.bigrockad.com/rockad/lookup`.** Gitea's 301 for a
renamed repository covers the *git* path, not the container registry — an old
`rockad/personal-index` tag is not redirected and simply will not resolve.


Dev on WSL (x86_64), deployed to `core` (aarch64) via this Gitea instance's
container registry:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t git.bigrockad.com/rockad/lookup:VERSION --push .
echo "$GITEA_SERVER_TOKEN" | docker login git.bigrockad.com -u rockad --password-stdin
docker push git.bigrockad.com/rockad/lookup:VERSION
ssh core docker pull git.bigrockad.com/rockad/lookup:VERSION
```

Push and pull go over **HTTPS to `git.bigrockad.com`**, not the LAN address. The
LAN registry endpoint is `192.168.1.90:8099`, but plain HTTP would need
`insecure-registries` in Docker's daemon config on both hosts — and restarting
the daemon on core restarts **Home Assistant**. Not worth it; the HTTPS path
needs no daemon change and the layers are well under Cloudflare's request limit.

`.gitea/workflows/build.yml` runs the same build in CI once an `act_runner` with
the `docker` label is registered. Until then it is inert, and `docker save |
ssh core docker load` remains a working fallback that needs no registry at all.

Cross-building needs QEMU binfmt once: `docker run --privileged --rm tonistiigi/binfmt --install arm64`.

**Multi-arch with no emulation.** The Dockerfile pins its build stage to
`--platform=$BUILDPLATFORM`, so every `RUN` executes on the builder's own
architecture; the target stages contain no `RUN` at all, only `COPY`. Nothing here
is compiled, so the installed tree is architecture-independent.

That is not just tidiness. `core` is an arm64 Pi whose only x86 binfmt handler is
**box86** — a 32-bit emulator that cannot execute amd64 (`docker run --platform
linux/amd64 alpine uname -m` there fails with `exec format error`). Emulating amd64
would have meant registering `qemu-x86_64` via a privileged container: root on a box
running live Home Assistant, lost on every reboot, and at risk of clashing with the
existing box86 handler. Building this way needs none of it.

**The build runs the test suite against Python 3.14**, the version the dev box runs, so a
local pass and a build pass mean the same thing.

⚠️ It was pinned to 3.11 for a while precisely because they differed: 3.14 accepts syntax
3.11 rejects (backslashes inside f-string expressions — hit for real), and failing the build
is cheaper than failing on core. **Keep them equal, or pin deliberately — never let them
drift apart unnoticed.**

## Gotchas worth keeping

- **`doc_key` must not hash the body.** It did originally, and two distinct contacts sharing
  a name with no other fields hashed identically and silently overwrote each other — 5,660
  vcards collapsed to 3,971 rows. Keys are now `source|path|ordinal`, or the extractor's own
  key (mail uses `Message-ID`).
- **The mbox is streamed, never loaded.** `mailbox.mbox` builds a full table of contents up
  front; on a 3.5 GB archive on a box with no swap headroom that is not worth risking.
