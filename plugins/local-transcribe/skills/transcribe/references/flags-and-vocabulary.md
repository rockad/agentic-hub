# Transcribe Flags & Mixed-Language Vocabulary Reference

Detailed flag semantics, `--rerender` behavior, and `--names-file` formatting for `scripts/transcribe.py`.

## Flag reference

- `--language en|fi|ru|…` — skip auto-detection when the language is known.
- `--names 'A,B,C'` — real names for `Speaker 1…N`, in order of first speaking.
- `--speaker-threshold 0.4` — with no count given, lower splits voices apart, higher merges them (default `0.5`).
- `--me-stream 1` — which stream is the user's own microphone, when `Me` and `Remote` come out the wrong way round on a multi-track file.
- `--stream N` — transcribe only stream N of a multi-track file, unlabelled.
- `--engine mlx-whisper|faster-whisper`, `--model <name>` — override the per-platform default (`mlx-whisper` on Apple Silicon, `faster-whisper` elsewhere).
- `--no-ocr` — do not read the screen. `--ocr` insists on it and fails loudly if the vision model is missing.
- `--ocr-model`, `--ocr-scene`, `--ocr-interval`, `--ocr-min-gap`, `--ocr-max-frames` — which model reads the screen and how often it looks.
- `--enroll NAME` / `--enroll-from-speaker N` — store a voice print; ask before enrolling anyone other than the user themselves.
- `--no-identify` — leave every speaker numbered even if a print would match; `--identify` (the default) is what turns a match into a name.
- `--list-voices` / `--forget NAME` — see and remove enrolled voice prints.
- `--rerender TRANSCRIPT` — rebuild an existing transcript's `## Needs a quick look` block from its own turn lines, in place. No audio and no recognition, so it is the cheap way to apply an improved `--names-file` to what a run already produced. It rewrites only that section; the transcript text is untouched. ⚠️ Speaker-identification checks are not re-run — a transcript records no similarity scores — so any *Low-confidence* or *Unresolved speakers* section from the original run is dropped rather than guessed at, and it says so on stderr. Re-run the recording itself if those matter.
- `--attendees 'A,B,…'` — name a speaker from context (elimination, a self-introduction, being addressed). Read the verification block's `### Unresolved speakers` back to the user rather than guessing when it appears.
- `--names-file PATH` — the user's own vocabulary. Off by default, and it does two jobs: the terms are **primed into the recogniser before decoding**, and any mis-hearings listed are corrected afterwards. Accepts either a plain `Correct: misheard one, misheard two` list or a Markdown file whose body holds a two-column table (canonical spelling, then renderings) — whichever the file's content actually is, detected automatically, so a vocabulary already kept as a note needs no separate list derived from it.
- `--no-verify` — turn off the whole `## Needs a quick look` block; `--verify` (the default) is what turns every kind of uncertainty a run had into that one ask.

## Mixed-language speech & `--names-file` details

**A conversation that switches language mid-sentence is the ordinary case in some of these recordings, not an edge.** Measured on one real 55-minute Russian meeting, **every one of 120 turns** contained a run of Latin text.

- **Ordinary English phrases inside Russian survive unaided** — *"что we should probably roll that back before the release, потому что…"* came back exactly. Do not offer a flag for this; it already works.
- **Rare technical and product names are what break**, and they break in the destructive direction: `Kubernetes` became *«Кьюбор Ниц»*, and on real audio `Linear` became *«линии»* and `CEO` became `SEO`. A reader who does not know the systems cannot recover those.
- **`--names-file` is the fix, and priming is the half that works best** — a primed term is usually recognised correctly in the first place. Forcing the language changes nothing either way; that was measured, so do not suggest `--language ru` as a remedy.
- **Canonicalisation (`prime only` vs `excluded`).** One term spelled four ways in a single file (`Object Storage` 15 times, `object storage` 9) is correct recognition and still bad output, so a term is matched against itself too. This is wrong for an ordinary word or phrase rather than a proper noun (`handover`, `private networks`) — the Markdown table format marks such a row `prime only` in its renderings cell, which keeps priming and repair but skips the self-match, rather than `excluded`, which drops the row entirely and gets no priming at all.
- ⚠️ **The list is the user's and its entries can be wrong.** Mapping `CEO: SEO` repairs a real mis-hearing but would corrupt a meeting that genuinely discussed SEO. Suggest entries, never invent them silently, and say what a new entry would rewrite.
- ⚠️ **A Cyrillic-rendered Latin name is only recovered if the user lists the rendering they saw.** The matching is literal, not phonetic. When such a mangling appears, offer to add that exact string to their file.
