---
name: transcribe
description: >-
  Transcribe an audio or video file locally into a Markdown transcript. Use to
  transcribe a recording or voice memo.
---

# Transcribe a file, locally

**One command, and the file never leaves the machine:**

```bash
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/transcribe.py" <file> --dictation
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/transcribe.py" <file> --speakers 3
```

It writes `<file-stem>.transcript.md` next to the input and prints that path.
`--out <dir>` puts it somewhere else. The transcript is an ordinary Markdown
file — file it wherever the user's notes live.

## Before running

1. **`uv` must be installed.** Everything else — `ffmpeg`, the recognition
   weights, numpy — arrives on the first run and is cached. There is no setup
   step and no `sudo`.
2. **Check the file first** with `--probe-only`. It prints the duration, the
   sample rate and the *input shape*, and costs nothing:

   ```bash
   uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/transcribe.py" <file> --probe-only
   ```
3. **The first run downloads the model** (~1.5 GB for `whisper-large-v3-turbo`,
   plus 29 MB of speaker models the first time labels are asked for). Say so
   before starting it, then it is cached for every later run.
4. **A file with video also wants a vision model** — `ollama pull qwen2.5vl:7b`,
   about 6 GB, once. Without it the run still produces its transcript and says
   in a `note:` line that the screen was not read; with `--no-ocr` it is not
   wanted at all.

## The one thing to establish first: how many people are on the recording

A single-stream audio file is byte-for-byte the same shape whether it holds a
dictated memo or six people round a table microphone. The container cannot tell
them apart, so **the script refuses to guess** and exits 3 naming the three ways
forward. Which one to pass is the user's knowledge, not yours:

| They say | Pass |
| --- | --- |
| "it's just me", a dictated memo, a voice note | `--dictation` |
| "there were four of us" | `--speakers 4` |
| a conversation, count unknown or unsure | `--diarize` |

**Ask rather than assuming**, and prefer `--speakers N` whenever they can give
the number — a known count is a constraint the clusterer uses, so it beats
letting it guess. Count the people who actually **spoke**, not the invitee list:
a silent attendee is not a speaker.

`--names 'Alice,Bob'` replaces `Speaker 1`, `Speaker 2`… in order of first
appearance. Offer it when the user has told you who was there — but only if
they also know who spoke first, because the order is the only thing the
recording establishes. Getting it wrong puts the wrong name on every line.

**A file with two or more audio streams usually needs nothing at all** — but
never assume it: a stream count is not a source count. Before labelling
anything, the script samples a few seconds from each stream and checks
whether they actually carry different audio. Two genuinely separate streams
get `Me` / `Remote` with no flag needed. When they turn out to carry the same
mixed audio — one microphone, duplicated onto both tracks — it refuses
per-track labels exactly as it would refuse a genuine single-stream file, and
`--dictation` on one of those then *succeeds*, correctly, because a same-mix
file really is one source. Only a confirmed two-source file makes
`--dictation` a contradiction worth refusing.

## What it does with each kind of file

| The file | What happens |
| --- | --- |
| One audio stream, one speaker | `--dictation` → transcript, no labels |
| One audio stream, several speakers | `--speakers N` or `--diarize` → `Speaker 1…N`. A bare run is refused (exit 3) |
| Two or more audio streams (OBS-style), checked and distinct | **`Me` / `Remote` automatically**. `--me-stream 1` if they are swapped |
| Two or more audio streams that turn out to carry the same mix | Treated as a single-source file: `--dictation`, `--speakers N`, or `--diarize`; a bare run is refused (exit 3) |
| Two or more audio streams where one holds **no audio at all** | The silent track is not a source. Treated as a single-source file on whichever track has something, even if that is not track 1; a bare run is refused (exit 3) |
| One stereo or multi-channel stream | Downmixed, then treated as one stream: `--dictation` or `--speakers N`. The channel→source mapping is not used |
| Video with audio | Audio transcribed, **and the screen read** into its own section. `--no-ocr` turns the screen half off |
| Video with no audio | The screen is the whole document — a transcript of on-screen text, no speech. Refused (exit 3) only with `--no-ocr`, or when no text was found on any frame |

Exit codes: `0` done, `2` bad input or a missing engine, `3` an input shape this
version cannot label honestly.

## Speaker separation, and what to say about its accuracy

Two ONNX models through `sherpa-onnx`, 29 MB together, downloaded on the first
`--speakers`/`--diarize` run and cached. No account, no token and no licence
acceptance — that is why it is `sherpa-onnx` and not `pyannote`.

**Two people in one room on one microphone is the ordinary case, and it works.**
Measured on a 49-minute two-person interview recorded that way, the separation
agreed with every one of 844 seconds a reader had attributed by hand. Say so
plainly if the user asks whether an in-room recording can be labelled: it can,
and a second microphone is not needed for two people. What no arrangement of
tracks can fix is that **both voices reach one microphone**, so such a file is
always a single source however it was recorded — `Me` / `Remote` is available
only when the sources really were captured separately.

**A run takes roughly 0.06× of audio duration** for this stage — about three
minutes of CPU on a 50-minute file. Nothing retries and nothing switches models
on its own, so a second pass is never the reason a run is slow.

The script prints how many speakers it found; **report that number**, because it
is the one thing the user can check against their own memory of the meeting. If
it disagrees with them:

- **fewer speakers than people** → re-run with `--speakers N`, or lower
  `--speaker-threshold` (try `0.4`) to split more readily
- **more speakers than people** → `--speakers N` pins it

Two honest limits to state when they matter rather than glossing:
**overlapping speech** is attributed whole to whoever dominates that stretch,
and the embedding model is trained on **English and Chinese**, so it works on
other languages but no accuracy figure is claimed for them.

Speaker labels from `--diarize` are `Speaker 1`, `Speaker 2`… and **which human
that is, the recording does not say.** Never infer the mapping from the content
and present it as fact; if the transcript makes it obvious, offer `--names` and
let the user confirm.

## Voice prints: naming a speaker without being told, next time

`--enroll NAME` stores a **voice print** — a fingerprint of how that person
sounds — so a later diarized recording can name their cluster automatically
instead of leaving it `Speaker N`. It is a separate, standing store, kept
next to `--speakers`/`--diarize` rather than instead of them: identification
only ever runs on top of a diarized recording, and only ever names someone
who was deliberately enrolled.

```bash
# From a dictated memo — the whole file is one person's speech.
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/transcribe.py" memo.m4a --enroll 'Alice'

# From an interview you already have, once you know which numbered speaker
# is who (read the transcript first — this is the main way people get enrolled).
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/transcribe.py" interview.m4a \
    --speakers 2 --enroll-from-speaker 2 --enroll 'Bob'

# Upkeep.
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/transcribe.py" --list-voices
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/transcribe.py" --forget 'Bob'
```

**Ask before enrolling anyone other than the user themselves, every time.** A
voice print is biometric data kept indefinitely on the user's own machine,
which is a materially bigger commitment than a transcript that can be
deleted — see `references/consent.md` § *Voice prints* for the full reasoning.
In practice:

- **Enrolling the user is the default, and needs no special care beyond the
  ordinary rules above.** It is their own voice, on their own machine.
- **Prefer enrolling only the user, even on a call with one other person.**
  Naming the user's own cluster on a 1:1 recording already identifies the
  other speaker by elimination — a two-person meeting with one named
  speaker and a filename or calendar invite naming who the call was with
  tells the reader everything a second print would, with nobody else's
  voice ever stored.
- **Only enrol someone else when the user asks for it by name, and confirm
  they're fine with their voice being kept for this** before running
  `--enroll-from-speaker`. Never suggest enrolling a colleague, a candidate
  or a customer as a convenience — offer `--names` for one-off labelling of
  a single transcript instead, which asserts nothing permanent.
- **A `--enroll-from-speaker` failure below the floor (~20s of real speech)
  is not a bug to work around** — a print built from less speech is
  unreliable in a way that would not announce itself later, so point the
  user at a longer stretch of that speaker rather than lowering anything.

**Identification is on by default (`--identify`) and silent when it has
nothing to say.** With no voices enrolled it costs nothing extra and changes
no output; once someone is enrolled, a diarized run whose best match for a
cluster clears both a similarity floor and a clear margin over every other
enrolled voice names that cluster, and leaves everything else numbered. The
transcript header records exactly which speakers were identified this way
and at what similarity, so **read that line before repeating a name back to
the user** — an identification is a model's best guess from a fingerprint,
not a certainty, however confident the header sounds.

## Naming a speaker from context — `--attendees`, no fingerprinting involved

`--attendees 'Ada Lovelace,Alan Turing'` names a `Speaker N` who is not
already identified, **using only the words already recognised — never a
voice.** This is context, not biometrics, so none of the consent weight
around `--enroll` applies to it; still confirm the attendee names with the
user if you are supplying them yourself rather than quoting something they
already told you, since a misspelled or wrong name is quoted right back at
them in the header.

What it can settle, strongest first, and always with its reasoning recorded:

- **Elimination** — a speaker not yet named, once every other speaker on the
  call is named and the attendee list has exactly one name left over, must
  be that person. Covers most 1:1s: enrol the user, give both names in
  `--attendees`, and the other speaker is named without ever recording their
  voice.
- **A self-introduction, or being addressed by name** — read only from the
  words, and only ever checked against the names given; a name said aloud
  that is not on the attendee list is never asserted, however clearly it was
  said. **Never suggest a name you noticed in the transcript yourself** —
  that is exactly the free-text guess this flag exists to avoid; put the
  name on `--attendees` and let the run decide whether the evidence supports it.

**Ambiguous evidence is never resolved by guessing, including by you.** A
speaker two candidates could equally fit stays `Speaker N` and appears in the
verification block instead (`## Needs a quick look` → `### Unresolved
speakers`, see below) — their first substantive line, how much of the
meeting they carried, which candidates remain — printed to stderr as well as
in the file. **Relay that section verbatim rather than picking one name
yourself**; one short reply from the user settles every speaker in it. Never
carry a resolution across files — `Speaker 2` in one recording says nothing
about `Speaker 2` in another, however similar the meeting.

⚠️ **Give the attendee list in the script the meeting is actually spoken
in.** A self-introduction or address is only ever matched within one
script — a Cyrillic mention is matched against a Cyrillic candidate name
(case endings and all), never against a Latin transliteration of it.
Elimination has no such limit, since it never reads the words at all.

## `warning:` lines are not noise — relay them

The run checks itself and prints `warning:` lines when its own output cannot be
trusted. **Never summarise a transcript, or present its speaker labels, without
passing these on first.** The transcript repeats them in a `> [!warning]`
block, and its `speakers:` header says `NOT RELIABLE`, so a file that is
untrustworthy admits it — but the user is reading your message, not the header.

| Warning | What it means | What to offer |
| --- | --- | --- |
| `recognition looped` | Whisper repeated one phrase for much of the file. The text is largely worthless and the timestamps stalled, so labels mean nothing | re-run naming the real `--language`; if it recurs, the audio is too noisy to recognise |
| `segments start before the one before them` | timestamps cannot place a speaker turn | treat as unlabelled; the text is still usable |
| `the labels did not attach to the text` | separation ran but everything landed on one speaker | treat as unlabelled and say so plainly |
| `--language X was given but … letters are Y` | the forced language is wrong | drop `--language` to auto-detect, or name the right one |

A clean run prints none of these. **Silence here is the signal that the labels
can be quoted.**

## The verification block — everything the run was unsure about, in one ask

`--verify` (on by default) collects five different kinds of uncertainty into
**one** `## Needs a quick look` section at the end of the transcript, plus one
compact line on stderr — never a stream of separate prompts:

- **Unresolved speakers** — `--attendees` naming from context, above, nested
  here as `### Unresolved speakers` rather than its own section.
- **A speaker identification that matched, but only weakly** — an enrolled
  voice print cleared `voices.py`'s accept bar but well below a confident
  score; worth confirming before the name is repeated back as settled fact.
- **A stretch of speech nobody could be matched to** — reported as one group
  (a count, a total duration, a few timestamps), never one line per turn.
- **A token that looks like a mis-heard name or term** — rare, oddly
  capitalised, and not already in the user's `--names-file`. This is
  deliberately narrow: it catches a shape like `QBornets`, not a mangling
  that happens to spell an ordinary word, and it never attempts to catch a
  Latin name rendered into Cyrillic (`Linear` → «линии») — there is no
  reliable test for that without a Russian lexicon, so it stays a thing the
  user has to notice and add to their file themselves.
- **A term spelled two different ways in the same file** — `Object Storage`
  fifteen times and `object storage` nine, the same failure `--names-file`
  fixes once told about it, caught here before the user has had to tell it
  anything.

**Relay the block the same way you already relay `warning:` lines — verbatim,
never re-worded, and never answer any part of it yourself from something you
noticed reading the transcript.** It never blocks or delays anything: a file
with every category firing is exactly as complete and usable as one with
none, and `--no-verify` turns the whole thing off for a user who does not
want to be asked.

**Where the answer is a name, a spelling, or a canonical casing, offer to add
it to the user's `--names-file`** (or suggest starting one — see
`references/known-names.example.txt`) rather than letting the answer
evaporate once this reply scrolls past. That is what makes the next
recording, and the rest of this one, stop asking about the same term.

**When the block is empty, say nothing about it** — the same way a clean run
with no `warning:` lines earns no comment either. There is no `## Needs a
quick look` section to point to, and pointing out its absence is its own
kind of noise.

## The on-screen text

**A file with a video stream gets its screen read as well as its audio, with no
flag.** The frames where the picture actually changed go to a local vision model
(`qwen2.5vl:7b` by default, Apache-2.0, about 6 GB, pulled once), and what it
reads lands in an `## On-screen text` section with timestamps, above the
transcript. The point is the half of a meeting that is never said aloud: the
figure on the slide, the error in the terminal, the name of the dashboard
someone is pointing at.

**`--no-ocr` turns it off**, and that is the right flag when the screen carries
nothing worth reading — a talking-head call, a webcam recording — because the
stage costs several seconds per frame and adds nothing there. Offer it when the
user says the recording is just faces.

| Situation | What happens |
| --- | --- |
| The vision model is not pulled | A `note:` line, the transcript is written anyway, and the header says `on-screen text: skipped — …` naming the `ollama pull` command |
| `--ocr` given and the model is not pulled | Exit 2 before recognition starts, so an hour of transcription is not spent first |
| The file has no video | The header says `no video stream`; `--ocr` on such a file exits 2 |
| Nothing legible on any frame of a silent video | Exit 3, suggesting `--ocr-scene 0.05` or `--ocr-interval` |

**Say this whenever you quote on-screen text: it is a model's reading and can be
wrong.** It is not like the `Me`/`Remote` labels on a two-track recording, which
are facts about the container. The transcript carries that caveat in the section
itself; the user is reading your message, not the file. Wrong-but-plausible text
is the specific failure to expect — a misread digit, not a missing line.

Tuning, when the defaults miss things:

- **A slide was missed** → `--ocr-scene 0.05` reads on smaller changes.
- **The picture never cuts** (a scrolling document, a slowly-drawn diagram) →
  `--ocr-interval 15` reads a frame every fifteen seconds instead.
- **A long recording** is capped at 40 frames, spread across the whole thing
  rather than truncated at the start; `--ocr-max-frames 80` raises it.

## Reporting back

Give the user the transcript path, the recognised word count, and the wall-clock
as a multiple of audio duration (the script prints all three). If the source was
below 16 kHz, mention that the transcript carries a quality note — that is why
an otherwise mysterious bad transcript is explainable.

**If they ask whether the GPU is being used, read it off the run rather than
reasoning about it.** The script prints the accelerator on the `transcribing
with …` line and every transcript carries it as a `device:` header field.
Recognition uses the Apple GPU via MLX on Apple Silicon and `cuda` + `float16`
where a usable NVIDIA card exists; **speaker separation runs on the CPU on
purpose**, because it is already about 0.04× of audio duration and CoreML
measured no better. A `note:` line about falling back to the CPU is worth
passing on — it means a machine that should be fast is not.

## Other flags

- `--language en|fi|ru|…` — skip auto-detection when the language is known.
- `--names 'A,B,C'` — real names for `Speaker 1…N`, in order of first speaking.
- `--speaker-threshold 0.4` — with no count given, lower splits voices apart,
  higher merges them (default `0.5`).
- `--me-stream 1` — which stream is the user's own microphone, when `Me` and
  `Remote` come out the wrong way round on a multi-track file.
- `--stream N` — transcribe only stream N of a multi-track file, unlabelled.
- `--engine mlx-whisper|faster-whisper`, `--model <name>` — override the
  per-platform default (`mlx-whisper` on Apple Silicon, `faster-whisper`
  elsewhere).
- `--no-ocr` — do not read the screen. `--ocr` insists on it and fails loudly
  if the vision model is missing.
- `--ocr-model`, `--ocr-scene`, `--ocr-interval`, `--ocr-min-gap`,
  `--ocr-max-frames` — which model reads the screen and how often it looks.
- `--enroll NAME` / `--enroll-from-speaker N` — store a voice print; see
  *Voice prints* above before offering this to name anyone but the user.
- `--no-identify` — leave every speaker numbered even if a print would match;
  `--identify` (the default) is what turns a match into a name.
- `--list-voices` / `--forget NAME` — see and remove enrolled voice prints.
- `--rerender TRANSCRIPT` — rebuild an existing transcript's `## Needs a quick
  look` block from its own turn lines, in place. No audio and no recognition,
  so it is the cheap way to apply an improved `--names-file` to what a run
  already produced. It rewrites only that section; the transcript text is
  untouched. ⚠️ Speaker-identification checks are not re-run — a transcript
  records no similarity scores — so any *Low-confidence* or *Unresolved
  speakers* section from the original run is dropped rather than guessed at,
  and it says so on stderr. Re-run the recording itself if those matter.
- `--attendees 'A,B,…'` — name a speaker from context (elimination, a
  self-introduction, being addressed); see *Naming a speaker from context*
  above. Read the verification block's `### Unresolved speakers` back to the
  user rather than guessing when it appears.
- `--names-file PATH` — the user's own vocabulary. Off by default, and it
  does two jobs: the terms are **primed into the recogniser before decoding**,
  and any mis-hearings listed are corrected afterwards. Accepts either a
  plain `Correct: misheard one, misheard two` list or a Markdown file whose
  body holds a two-column table (canonical spelling, then renderings) —
  whichever the file's content actually is, detected automatically, so a
  vocabulary already kept as a note needs no separate list derived from it.
  See *Mixed-language speech* below, which is where it earns its place.
- `--no-verify` — turn off the whole `## Needs a quick look` block; see
  *The verification block* above. `--verify` (the default) is what turns
  every kind of uncertainty a run had into that one ask.

## Mixed-language speech, and a two-person recording's second speaker

**A conversation that switches language mid-sentence is the ordinary case in
some of these recordings, not an edge.** Measured on one real 55-minute
Russian meeting, **every one of 120 turns** contained a run of Latin text. So:

- **Ordinary English phrases inside Russian survive unaided** — *"что we
  should probably roll that back before the release, потому что…"* came back
  exactly. Do not offer a flag for this; it already works.
- **Rare technical and product names are what break**, and they break in the
  destructive direction: `Kubernetes` became *«Кьюбор Ниц»*, and on real audio
  `Linear` became *«линии»* and `CEO` became `SEO`. A reader who does not know
  the systems cannot recover those.
- **`--names-file` is the fix, and priming is the half that works best** —
  a primed term is usually recognised correctly in the first place. Forcing
  the language changes nothing either way; that was measured, so do not
  suggest `--language ru` as a remedy.
- **It also canonicalises.** One term spelled four ways in a single file
  (`Object Storage` 15 times, `object storage` 9) is correct recognition and
  still bad output, so a term is matched against itself too. This is wrong
  for an ordinary word or phrase rather than a proper noun (`handover`,
  `private networks`) — the Markdown table format marks such a row
  `prime only` in its renderings cell, which keeps priming and repair but
  skips the self-match, rather than `excluded`, which drops the row
  entirely and gets no priming at all.
- ⚠️ **The list is the user's and its entries can be wrong.** Mapping
  `CEO: SEO` repairs a real mis-hearing but would corrupt a meeting that
  genuinely discussed SEO. Suggest entries, never invent them silently, and
  say what a new entry would rewrite.
- ⚠️ **A Cyrillic-rendered Latin name is only recovered if the user lists the
  rendering they saw.** The matching is literal, not phonetic. When such a
  mangling appears, offer to add that exact string to their file.

**On a two-speaker recording `Speaker 2` never appears.** The other speaker is
either a name reached from context or the literal `Unknown` — with two people
a number tells the reader nothing the meeting had not already told them, while
`Unknown` says the true thing. From three speakers up the numbers stay, since
telling them apart is then the point. `Unattributed` is a different label for a
different fact: one stretch of speech no speaker could be matched to.

Environment variables override the defaults for a whole session and are listed
in the plugin README: `LOCAL_TRANSCRIBE_ASR_ENGINE`, `_ASR_MODEL`,
`_MODEL_DIR`, `_DIARIZE_THREADS`, `_OLLAMA_URL`, `_OCR_MODEL`, `_FFMPEG`.

**Someone installing this for the first time gets `SETUP.md`**, not these
flags: it is the per-OS guide for macOS, Windows and Linux, covering both
transcribing existing files and recording with OBS.

## What this skill does not do

- **It does not record.** Transcribing a file the user already has is not an act
  of recording and must never prompt about consent. Recording is a separate
  skill with its own rules in `references/consent.md`.
- **It does not get the file off a phone.** It takes a path; whatever the user
  already uses to copy files is the right answer.
- **It does not file the transcript anywhere.** Next to the input, or `--out`.
