# local-transcribe

Transcribe any audio or video file **on your own machine**. No cloud speech API,
no third-party MCP server, no upload. Speech recognition runs on weights
downloaded once and cached; a screen recording's on-screen text is read by a
local Ollama, over the video frames only.

It transcribes any file you already have — a dictated memo, a handheld
recorder's file, a meeting recording, a screen capture of a call — and **labels
the speakers** when you ask it to. It can also **record** the call first, using
OBS Studio or the macOS built-in screen recorder.

**→ [`SETUP.md`](SETUP.md) is the step-by-step guide for macOS, Windows and
Linux**, covering both jobs: transcribing files you already have, and recording
with OBS. It is the thing to send someone who is installing this for the first
time. What follows here is the short version and the reference.

Three ways speakers get labelled, best first:

| The recording | Labels | How |
| --- | --- | --- |
| **Two audio tracks** (what OBS records, one source per track) | `Me` / `Remote` | checked, not assumed — the streams are sampled and compared before the label is trusted; see *Known limits* |
| **One mixed stream**, count known | `Speaker 1…N` | `--speakers N` |
| **One mixed stream**, count unknown | `Speaker 1…N` | `--diarize` clusters and reports what it found |

**A file with a picture also gets its screen read.** The frames where the
picture changed go to a local vision model, so the figure on the slide and the
error in the terminal land in the transcript beside what was said — `--no-ocr`
turns that off. *Known limits* below says exactly what a given file will do.

## Install

Only one prerequisite: **[`uv`](https://docs.astral.sh/uv/)**. Recording with
OBS additionally needs OBS itself; nothing else in the plugin depends on it.

```bash
brew install uv                                    # macOS
curl -LsSf https://astral.sh/uv/install.sh | sh    # Linux, WSL
winget install astral-sh.uv                        # Windows
```

Everything else arrives on the first run and is cached: `ffmpeg` comes from the
`imageio-ffmpeg` wheel rather than a system package, so there is **no
`brew install ffmpeg`, no `apt-get`, and no `sudo`** anywhere in the setup. The
speaker-separation models add 29 MB on the first run that asks for labels, and
need no account or licence acceptance.

The first transcription also downloads the recognition model (~1.5 GB for
`whisper-large-v3-turbo`), once.

## Use

```bash
# What is in this file? Free, and worth doing first.
uv run --script scripts/transcribe.py memo.m4a --probe-only

# Transcribe a single-speaker recording.
uv run --script scripts/transcribe.py memo.m4a --dictation

# Four people in a meeting, and you know it was four.
uv run --script scripts/transcribe.py standup.m4a --speakers 4

# …with their real names, in order of who spoke first.
uv run --script scripts/transcribe.py standup.m4a --speakers 4 \
    --names 'Alice,Bob,Carol,Dave'

# Several people, count unknown — let it cluster and report.
uv run --script scripts/transcribe.py roundtable.m4a --diarize

# A two-track OBS recording needs no flags: it labels itself Me / Remote.
uv run --script scripts/transcribe.py call.mkv

# A screen share: the audio is transcribed and the screen is read as well.
uv run --script scripts/transcribe.py demo.mkv --speakers 2

# Faces only, nothing on screen worth reading — skip the vision model.
uv run --script scripts/transcribe.py call.mkv --no-ocr

# Somewhere else, a known language.
uv run --script scripts/transcribe.py memo.m4a --dictation \
    --out ~/notes --language en
```

The transcript is written to `<file-stem>.transcript.md` beside the input, and
the path is printed on stdout. It is an ordinary Markdown file — file it
wherever your notes live.

Exit codes: `0` done, `2` bad input or a missing engine, `3` an input shape this
version cannot label honestly.

### Why it still will not guess between one speaker and several

A one-stream audio file is byte-for-byte the same shape whether it holds a
dictated memo or six people round a table microphone. Nothing in the container
distinguishes them, so a bare single stream is **refused with the three ways
forward named** — `--dictation`, `--speakers N`, `--diarize`.

The two mistakes are not symmetrical, which is the whole reason. Speaker
separation wrongly *off* on a conversation gives you an unlabelled wall of text
that reads as fine and is useless the moment anyone needs to know who said what
— a silent failure whose only fix is a full re-run. Wrongly *on* on a monologue
wastes a few minutes. So the default is to stop and ask.

### Speaker separation

Two small ONNX models, downloaded once (29 MB together) and run through
`sherpa-onnx`: Silero VAD, which finds where speech is, and an embedding model
that fingerprints each three-second window of it so the windows can be
clustered into speakers.

**Nothing is asked where the voice changes.** A segmentation model used to
answer that question here, and on a single mixed recording of two people in one
room it answered wrongly: the stretches it returned held both voices, every
fingerprint came out alike, and the clusterer put 98% of the audio on one
speaker. Turn boundaries now fall out of where the cluster labels change along
the window grid, after a vote that smooths isolated disagreements away.

`--speakers N` tells the clusterer to produce exactly N. With no count it
clusters on cosine distance, and `--speaker-threshold` is the dial: **lower
splits one voice into several, higher merges two into one** (default `0.5`).

⛔ **`pyannote.audio` is deliberately not used.** Its weights sit behind gated
Hugging Face terms that each person must accept individually on their own
account, and whoever skips it gets one merged label instead of an error. The
`sherpa-onnx` models are plain public downloads: no account, no token, no
licence click-through, and no `torch`.

### Voice prints — naming a speaker instead of numbering them

`Speaker 1`, `Speaker 2`… can become real names automatically, once someone is
**enrolled**: a print — one embedding vector, the same fingerprint the
clusterer already computes per window, averaged over enough of that person's
speech to represent them rather than one sentence.

```bash
# From a dictated memo — the whole file is one person.
uv run --script scripts/transcribe.py memo.m4a --enroll 'Alice'

# From an interview you already have, once you've read the transcript and
# know which numbered speaker is who. This is the main path.
uv run --script scripts/transcribe.py interview.m4a --speakers 2 \
    --enroll-from-speaker 2 --enroll 'Bob'

# Every later run with --speakers/--diarize then names any cluster that
# matches, and leaves the rest numbered — no flag needed.
uv run --script scripts/transcribe.py meeting.m4a --speakers 3

uv run --script scripts/transcribe.py --list-voices
uv run --script scripts/transcribe.py --forget 'Bob'
```

**A voice print is biometric personal data**, and this plugin is public —
other people install it — so the design answers to that rather than to
convenience:

- **Local storage only, in a private, unshared directory.** The test is
  whether a print can leave the machine, not whether the directory is under
  version control — a git repository with no remote is fine; one you push, a
  synced cloud folder, a shared drive or a backup that ships the tree is not.
  `LOCAL_TRANSCRIBE_VOICES_DIR` (default `~/.local/share/local-transcribe/voices/`,
  `%LOCALAPPDATA%` on Windows) is the only override, and neither the default
  nor an override inside this plugin's own tree is a supported configuration —
  see *Configuration* below.
- **Enrolment is always an explicit `--enroll`, naming a person.** Nothing
  enrols as a side effect of transcribing, diarizing, or identifying.
- **The print is the only thing stored.** No audio, no clip — a few dozen
  floats and the bookkeeping needed to use them safely.
- **A print is only ever compared within the model that made it.** Every
  print records its embedding model by filename, and a comparison across
  models is refused rather than producing a number that looks like a score
  and measures nothing.
- **Below ~20 seconds of real speech (measured by voice-activity detection,
  not file length), enrolment is refused** rather than storing a print too
  weak to trust — a weak print scores low against everyone, including its
  own owner, without ever saying so.

**A cluster is named only when the match is unambiguous.** Measured on two
real recordings (`_inbox/voice-check`, 2026-09-16): a genuine match's
window-vs-print similarity ran **+0.744 and +0.772** median; a different
person's ran **+0.392 and +0.415**. `IDENTIFY_THRESHOLD` (`0.55`) sits in the
middle of that roughly-0.33 gap, and `IDENTIFY_MARGIN` (`0.08`) is generous
against a gap that measured 0.33–0.45 between two different people's prints
against the same cluster — a cluster clears both, or it stays numbered. A
cross-file check told the same story on real audio: enrolling two people from
one 49-minute recording and identifying against a *different* recording
scored the genuine match at **+0.89** (runner-up +0.53) and the never-enrolled
third person at **+0.32 / +0.32** against both prints — comfortably on the
right side of both bars in both directions. `evals/voices_test.py` has the
threshold and margin cases as unit tests, on synthetic vectors placed at
these measured similarities, so a change to either constant fails a test
that names the recording the number came from.

⚠️ **Ask before enrolling anyone other than yourself.** A print is kept
indefinitely on the machine that enrolled it, which is a bigger commitment
than a transcript that can be deleted. On a 1:1 recording, enrolling only
yourself and letting the other speaker stay `Speaker N`/`Remote` already
identifies them by elimination once the recording's own metadata says who the
call was with — a second print adds no readability for the cost of storing
someone else's biometric data. `references/consent.md` has the fuller
reasoning and where it differs from recording consent.

### Naming a speaker from context — no voice ever fingerprinted

The paragraph above already argues that on a 1:1 recording, naming yourself
identifies the other speaker by elimination "once the recording's own
metadata says who the call was with." `--attendees` is that argument turned
into code, generalised past the 1:1 case:

```bash
uv run --script scripts/transcribe.py call.m4a --speakers 2 \
    --attendees 'Ada Lovelace,Alan Turing'
```

**Separation and naming are different stages with different standards.**
`--speakers`/`--diarize` decides "these turns are one person" and has to be
automatic and confident; naming decides "that person is Ada Lovelace", which
rests on much weaker evidence — and a numbered transcript is already a
complete, usable artefact, so nothing here ever delays one or marks it
failed. Four sources, weakest last:

1. **An enrolled voice print** (above) — already applied before this runs.
2. **Elimination.** A speaker not yet named, once every *other* speaker on
   the call *is* named, and the attendee list has exactly one name left
   unaccounted for, must be that person. Covers most 1:1 meetings on its own.
3. **The attendee list, generally.** The same reasoning generalises — N
   speakers, N attendees, N−1 named, and resolving one can make the next
   elimination possible, so this and the step below run in a loop.
4. **The words themselves** — a self-introduction, or being addressed by
   name in an adjacent turn. The only source that reads free text, so it is
   deliberately narrow: matched only against names the attendee list gives,
   never invented from what was said. This is not a theoretical caution — a
   real interview in this plugin's own test set has the interviewee say "hi,
   I'm Marjorie" while the correct name, from the attendee list, is someone
   else entirely (apparently a first-name mismatch between how they
   introduced themselves and the name on the calendar invite). Matched
   against free text alone this would have quoted the wrong name in the
   transcript header; restricted to the attendee list it correctly asserts
   nothing, and elimination names the speaker instead.

**Ambiguous evidence is never guessed between.** A name reached this way is
an inference about a person, so it must be right or absent — every name the
header shows carries its basis in plain words ("from the attendee list by
elimination", "self-introduction at 00:01:12", "addressed by name at
00:04:40"), and a speaker two candidates could equally be stays `Speaker N`
and appears in an `## Unresolved speakers` section instead, with their first
substantive line, how much of the meeting they carried, and which candidates
are still unaccounted for — one short reply back is enough to settle every
speaker in the file. It is also printed to stderr, so the ask is visible
without opening the transcript. **No mapping ever survives past one file** —
`Speaker 2` in one recording has no relationship to `Speaker 2` in another.

⚠️ **A Cyrillic name needs the attendee list in the same script it will be
spoken in.** Word evidence never compares text across scripts — an inflected
Cyrillic mention is matched by a shared word-start ("Анатолий" cores to
"анато", which "Анатолия"/"Анатолию"/"Анатолием" all start with, catching every
case ending measured on this plugin's own Russian test recording, though not
a diminutive like "Толя" — a different root, not an ending, and this refuses
to guess across roots), but that only fires when the candidate name is
written in Cyrillic too. Elimination and the enrolled-print path have no such
constraint, since neither ever reads the words at all — give the attendee
list in whichever script gets you the coverage you want. See `lt/naming.py`
for the full reasoning and `evals/naming_test.py` for the measured cases.

### Known-names spelling pass — an opt-in fix for mangled proper nouns

Recognition is tuned on ordinary words and unreliable on names it has never
seen — measured at one correct spelling in eight across four recogniser
configurations on this plugin's own test recordings. `--names-file` corrects
this yourself, deterministically:

```bash
uv run --script scripts/transcribe.py call.m4a --names-file colleagues.txt
```

`colleagues.txt` can be either of two shapes, told apart by content rather
than the file's extension:

- **Plain text**, one correction per line — `Correct Spelling: misheard one,
  misheard two`, or a bare `Correct Spelling` to prime it without correcting
  anything — applied as whole-word, case-insensitive substitution and
  nothing cleverer; see `references/known-names.example.txt`.
- **A Markdown table**, first column the canonical spelling and second
  column the renderings — the shape a vocabulary note already has, so there
  is no separate list to derive and keep in step by hand. A file is read
  this way whenever its body actually carries table rows; anything else
  (prose, headings, frontmatter) is ignored. Only quoted renderings —
  Markdown backticks or «guillemets» — before the second cell's first
  em-dash (`—`) are taken as mis-hearings, so a sentence after the dash
  explaining the term, including one explaining that a rendering was
  *removed*, is never read back in. Rows are de-duplicated by canonical
  spelling, case-insensitively, keeping the first.

  A row's second cell can also carry two markers:

  | Marker | Effect |
  | --- | --- |
  | `excluded` | The row is left out entirely — nothing is primed, nothing is corrected. |
  | `prime only` | The row is primed and its renderings are still corrected, but it is never matched against itself — see below. |

  **`prime only` is usually the one you want.** Some canonical forms are
  ordinary words rather than proper nouns — `handover`, `private networks`,
  `container registry` — and every entry is normally also matched against
  itself, case-insensitively, so the same term ends up spelled one way
  throughout a file (below). For an ordinary word that canonicalisation is
  actively wrong: it would retitle a sentence-initial "Handover" to lower
  case, or title-case ordinary prose. `prime only` keeps the priming and the
  repair and drops only that self-match. `excluded` still works — it means
  "leave this row out altogether" — but for an ordinary word `prime only`
  gets you priming for free where `excluded` gets you nothing.

**Off by default**, and the header records how many substitutions were made
(`names corrected: 3 substitution(s) from colleagues.txt`) so a correction is
always auditable rather than a silent rewrite. The shipped example is
fictional: a real list of your own colleagues' names, and how a recogniser
mangles them, is personal data about your workplace and must never be
committed to this public plugin — keep your real file wherever you keep your
other notes, the same rule `LOCAL_TRANSCRIBE_VOICES_DIR` follows for voice
prints.

**A term is also matched against itself**, case-insensitively, so one term
ends up spelled one way throughout — measured across a single 55-minute
recording, `Object Storage` appeared 15 times and `object storage` 9, `VPC` 9
times and `vpc` 4, and `managed Kubernetes` came out four different ways in
one file. Each of those is recognised *correctly*, nothing is misheard, but a
reader sees several things and a search for the canonical form finds a
fraction of the mentions. `prime_only` entries (above) are the exception.

The priming half of the pass (below) is capped by how much of the
recogniser's 180-token prompt budget fits, counted with Whisper's own
tokeniser when one is importable (`mlx_whisper`, or a bare `tiktoken`
install as a less exact fallback) and with a conservative two-characters-
per-token guess otherwise — the guess exists only so this module, and every
test that imports it, keeps working with no ASR engine installed at all.

### The verification block — five kinds of uncertainty, one ask

Five different stages can each end a run with something unresolved: an
unnamed speaker, a voice identification that only just cleared the bar, a
stretch of speech no cluster could be matched to, a token that looks
mis-heard, a term spelled two ways in one file. Asked about separately, that
is a stream of prompts; asked about together, it is one short reply. `--verify`
(on by default; `--no-verify` turns it off) collects all five into a single
`## Needs a quick look` section at the end of the transcript, and one compact
line on stderr:

```bash
uv run --script scripts/transcribe.py call.m4a --speakers 2 \
    --attendees 'Ada Lovelace,Alan Turing' --names-file colleagues.txt
```

| Category | What it checks | Threshold |
| --- | --- | --- |
| Unresolved speakers | `--attendees` naming from context (above) that could not settle a speaker — nested here rather than in its own section | — |
| Low-confidence identification | An enrolled voice print (above) matched, but only just | below `0.80` similarity — see `lt/verify.py` for why that number, set with real headroom below the measured genuine-match floor of `0.744` |
| Unattributed speech | Segments `lt/label.py` left with no speaker at all, reported as one group (count, total duration, a few timestamps) — never one line per turn | any |
| Suspected mangled terms | A rare (1-2 occurrences), Latin-script, irregularly-capitalised token (`QBornets`-shaped) not already in `--names-file`. A plural or possessive of an acronym (`GPUs`, `LLMs`, `GPU's`) or of a known term is not one, and is skipped | ≤ `MANGLING_MAX_COUNT` occurrences |
| Casing/spelling variants | The same 1-3 word phrase said in two or more exact case forms, `CASING_MIN_TOTAL` times or more in total — the same failure the spelling pass above measures (`Object Storage` fifteen times, `object storage` nine). Phrases whose only difference is the same single word are one finding, not one each | ≥ 3 total mentions |

Several suspect tokens in the same turn share one quotation of it, so a long
sentence carrying three of them is quoted once rather than three times.

**`--rerender TRANSCRIPT` rebuilds that block on an existing transcript**, from
its own turn lines, with no audio and no recognition — the cheap way to apply an
improved `--names-file` to a transcript you already have, or to see a detector
change without paying for recognition again. It rewrites only that section.
Speaker-identification checks are not re-run, since a transcript records no
similarity scores, so any *Low-confidence* or *Unresolved speakers* section is
dropped rather than guessed at, and it says so on stderr.

```bash
uv run --script scripts/transcribe.py --rerender call.transcript.md \
    --names-file colleagues.txt
```

**It never delays or withholds anything.** A file with every category firing
is exactly as complete as one with none — this is a section appended to an
already-finished transcript, never a gate in front of it.

⚠️ **What it deliberately does not attempt**, both for the same reason
`--names-file`'s docstring gives: **a Latin term rendered into Cyrillic**
(`Linear` → «линии», `CEO` → `SEO`) has no reliable shape- or frequency-based
test without a Russian lexicon, so it is never attempted — the remedy is
the same one the spelling pass already offers, adding the exact rendering to
`--names-file` once a reader spots it. **A hyphenated acronym-word splice**
(`CR-adress`-shaped) is also not checked, because the shape that would catch
it is indistinguishable from an entirely ordinary compound like `US-based` or
`AI-driven` — there is no way to tell them apart from shape alone, so this
is missed on purpose rather than flagging every such compound in a file that
talks about geography or technology at all. And **a mangling that happens to
spell a real word** (an interviewee's name coming out as an ordinary short
English word, in this plugin's own test data) needs the meaning of the
sentence to catch, which is exactly the kind of silent judgement this module
refuses to make — nothing here claims to catch it.

### Reading the screen

A screen share carries two channels of meaning and only one of them is speech.
The number on the slide, the error in the terminal, the name of the dashboard
someone is pointing at — none of it is ever said aloud, and a transcript that
drops it is a transcript of half the meeting. So a file with a video stream also
gets its screen read, with no flag to pass, into an `## On-screen text` section
above the transcript.

The sampling is the whole design, and it is deliberately dull:

- **Frames are chosen by change, not by clock.** A deck is mostly still, so a
  fixed interval either misses a slide or reads the same one thirty times.
- **The threshold is 0.03, and that number is measured rather than guessed.**
  Advancing a template deck — same background, new title line — scores **0.0396**,
  because the text is a small fraction of the picture, while a window switch in
  a real screen recording scores 0.10–0.17 and scrolling or typing scores
  0.005–0.027. A higher threshold was tried first and missed the second slide of
  a two-slide deck **silently**, which is the failure mode this stage has to
  avoid: an empty section and a still screen look identical in the output.
- **A frame is taken every two minutes regardless.** Scene detection cannot see
  what does not change, and a deck left on one slide for twenty minutes changes
  nothing — without the backstop the file would report one screen for the whole
  meeting, which is a claim about the sampling and not about the meeting.
- **Repeats collapse by their text**, so a slide held for four minutes is one
  entry spanning those minutes rather than forty near-identical ones.
- **At most 40 frames, spread across the recording** rather than truncated at
  the start, so "nothing on screen after minute two" can never be an artefact of
  the cap.

The model is `qwen2.5vl:7b` on a local Ollama — Apache-2.0, about 6 GB, pulled
once, and no account or licence acceptance, on the same rule that rules out
`pyannote` below. `granite3.2-vision:2b` is the small alternative.
Without the model pulled the run still writes its transcript and records
`on-screen text: skipped — …` in the header; `--ocr` insists instead, failing
before recognition starts rather than after an hour of it.

⚠️ **On-screen text is a model's reading, not a measurement.** Unlike the
`Me`/`Remote` labels on a two-track recording, which are facts about the
container, this can be wrong — and wrong plausibly, a misread digit rather than
a missing line. The section says so in the file itself. Check anything you mean
to quote.

### It checks its own output before presenting it

Speech recognition can fail by producing *more* output rather than less: told
the wrong language, or given audio it cannot make out, Whisper falls into a
repetition loop — one phrase for minutes — and its segment timestamps stall
while it does. Everything downstream then behaves sensibly on nonsense, and the
result is a transcript that reads as structured, with a confident speaker
header, and is not.

So each run judges itself on three structural signals — how much of the text is
one repeated phrase, whether timestamps ever run backwards, and whether one
speaker ended up holding nearly every word despite several being separated —
and when any of them trips it prints a `warning:`, repeats it in a
`> [!warning]` block at the top of the transcript, and marks the `speakers:`
header `NOT RELIABLE`. The transcript is still written, because the text can
still be worth having; what it will not do is present labels it cannot support.

It also warns when `--language` contradicts the script that came out — a forced
`en` on a Russian call is the most common way to trigger a loop in the first
place.

⚠️ **Whisper's `condition_on_previous_text` is off and must stay off.** Feeding
each window the previous window's text is what makes the loop self-sustaining.
On a 46-minute two-person call, turning it off took the most repeated
three-word phrase from 1848 occurrences to 10, removed every backwards
timestamp, and cut recognition from 275 s to 71 s.

## Known limits

| Your file | Today |
| --- | --- |
| One audio stream, one speaker | ✅ transcript |
| One audio stream, several speakers | ✅ `--speakers N` or `--diarize` → `Speaker 1…N`; bare invocation still refused |
| Two audio streams (OBS track 1 + track 2) | ✅ `Me` / `Remote` once the streams are sampled and confirmed to differ — see *Two streams is not two sources* below |
| Stereo / multi-channel single stream | ✅ downmixed, then `--dictation` or `--speakers N`; the channel→source mapping itself is unused |
| Video with audio | ✅ audio transcribed **and the screen read** into its own section; `--no-ocr` for audio only |
| Video with no audio | ✅ a transcript of the on-screen text alone. ⛔ exit 3 under `--no-ocr`, or when no frame held legible text |
| On-screen text itself | ⚠️ a model's reading, not a measurement — expect a misread digit rather than a missing line, and check anything you quote |
| Overlapping speech | ⚠️ attributed whole to whoever dominates; accuracy under overlap unmeasured |
| Speaker accuracy outside English | ⚠️ no figure is claimed — the default embedding model is trained on English and Chinese |
| **A mixed single-track call recording** | ⚠️ separation can fail outright — see below. The run detects it and says so |

### Two streams is not two sources

A container holding two or more audio streams looks, from the outside,
exactly like OBS's own two-track output — but the stream *count* is a fact
about the file's structure, not about how many microphones fed it. One room
microphone, recorded through a profile with two tracks configured, writes two
streams that both carry the identical mix; nothing about the container says
so. This happened on a real recording and the old logic labelled the streams
`Me` / `Remote` anyway, attributing one person's words to the other with
nothing warning anyone.

**So before either label is handed out, the streams are sampled and
compared.** A handful of short windows spread across the file are decoded from
each stream — never the whole file — and their loudness contours are
correlated after removing level and gain, which is amplitude-invariant by
construction: two independent voices produce uncorrelated contours, and the
same audio re-encoded onto two tracks produces the same contour wherever
anyone speaks, whatever the gain difference between the tracks. `--probe-only`
runs this check on its own and reports the result; a bare transcription run
prints it too, and the transcript header records what was actually checked
rather than asserting a guarantee. Full mechanics are in
`scripts/lt/mixcheck.py`.

**When the streams turn out to be the same mix**, per-track labelling is
refused rather than produced wrong: pass `--dictation`, `--speakers N` or
`--diarize` as you would for any single-source file, and the run transcribes
one stream. `SETUP.md` §4.3 covers routing each source to its own OBS track,
which is what makes the streams genuinely separate the next time.

### What a collapsed clustering actually meant

A clustering that puts nearly everything on one speaker is a failure rather
than a monologue, and until `0.7.0` this was read as a failure of the embedding
model: the run retried on a second model and kept whichever pass looked less
collapsed. That was wrong, and expensively so — a recording it fired on came
out labelled by a **worse** model while printing a line saying it had helped.

Measured on a 49-minute two-person interview, with minutes of each speaker
attributed by hand, the two models tell those speakers apart at:

| embedding model | equal-error rate |
| --- | --- |
| `campplus-zh-en`, the default | **1%** |
| `campplus-en-voxceleb`, the one the retry preferred | 21% |

The fingerprints were never the problem. What was collapsing was the stage
before them, and replacing it with the window grid fixed the same recordings:
on that interview, a plain two-speaker clustering now agrees with **every one
of 844 hand-attributed seconds**, where the old pipeline produced a 98 / 2
split. The retry is therefore gone rather than tuned.

An earlier collapse recorded here — a 46-minute Google Meet recording of two
Russian-speaking men, 2442 seconds on one speaker and 31 on the other, with
four other embedding models collapsing identically — is the same shape of
failure and was read the same wrong way at the time. Five models agreeing is
not evidence about five models; it is evidence about what they were being fed.

A collapse still marks the labels `NOT RELIABLE`, opens the transcript with a
warning and writes the text. Two things help then:

1. **Record with two tracks instead**, each source routed to its own track
   (`SETUP.md` §4.3) — the whole reason the recorder pushes OBS. That makes the
   split a checkable fact rather than an inference; see *Two streams is not
   two sources* above for what "checkable" means and why the check matters.
   ⚠️ Two people in one room speaking into one microphone can never be split
   this way, however the tracks are routed — that shape is always a single
   source, and the window grid is the only thing that separates it.
2. **Pin a model yourself.** `LOCAL_TRANSCRIBE_EMBEDDING_MODEL` takes any local
   `.onnx`. Nothing overrides it, and nothing switches models on your behalf.

## Configuration

Every value has a working default. Nothing points at a host or a path that is
not yours.

| Variable | Default | What it does |
| --- | --- | --- |
| `LOCAL_TRANSCRIBE_ASR_ENGINE` | `mlx-whisper` on Apple Silicon, else `faster-whisper` | Which recogniser to use |
| `LOCAL_TRANSCRIBE_ASR_MODEL` | `mlx-community/whisper-large-v3-turbo` / `large-v3-turbo` | Model name for that engine |
| `LOCAL_TRANSCRIBE_ASR_DEVICE` | `auto` → `cuda` if a usable card, else `cpu` | `faster-whisper` only; MLX is always the Apple GPU |
| `LOCAL_TRANSCRIBE_ASR_COMPUTE` | `float16` on CUDA, `int8` on CPU | `faster-whisper` quantisation |
| `LOCAL_TRANSCRIBE_DIARIZE_PROVIDER` | `cpu` — measured fastest, see below | `coreml`, or `cuda` with a CUDA-enabled `sherpa-onnx` build |
| `LOCAL_TRANSCRIBE_MODEL_DIR` | `~/.cache/local-transcribe/models` | Where the two speaker models are cached |
| `LOCAL_TRANSCRIBE_VAD_MODEL` | downloaded | Use a local Silero VAD `.onnx` instead |
| `LOCAL_TRANSCRIBE_EMBEDDING_MODEL` | downloaded | Pin a local embedding `.onnx`; nothing ever switches models on your behalf |
| `LOCAL_TRANSCRIBE_DIARIZE_THREADS` | `2` | CPU threads for speaker separation |
| `LOCAL_TRANSCRIBE_VOICES_DIR` | `~/.local/share/local-transcribe/voices/` | Where enrolled voice prints are stored — **must be private and unshared**; a local-only git repository is fine, anything that syncs or is pushed is not |
| `LOCAL_TRANSCRIBE_OLLAMA_URL` | `http://127.0.0.1:11434` | Where the vision model lives |
| `LOCAL_TRANSCRIBE_OCR_MODEL` | `qwen2.5vl:7b` | Which vision model reads the screen; `granite3.2-vision:2b` is a third of the size |
| `LOCAL_TRANSCRIBE_FFMPEG` / `_FFPROBE` | the wheel's binary | Use a specific system build instead |

### GPU use, and where it is worth having

Every run prints the accelerator and every transcript records it in a `device:`
header line, so this is answerable from the output rather than by assumption.

**Recognition uses the GPU wherever there is one.** On Apple Silicon that is
the Apple GPU through MLX's Metal backend, with nothing to enable. On an NVIDIA
machine `faster-whisper` gets `cuda` plus `float16`, both resolved explicitly —
CTranslate2's `default` compute type means "whatever the model was converted
as", which is not necessarily fp16. A card the driver exposes but the runtime
cannot use produces a stated fallback to CPU rather than a crash after the
weights have loaded.

**Speaker separation stays on the CPU, and that is the measured choice.** The
stage runs at roughly **0.04× of audio duration** — about a minute on a
30-minute recording — and CoreML benchmarks no faster at two threads and
slower at six, with a longer model load. Both models are small enough that
per-operator dispatch dominates, so there is no kernel work to amortise a
transfer. `LOCAL_TRANSCRIBE_DIARIZE_PROVIDER` exists for measuring it on other
hardware; `cuda` needs a CUDA-enabled `sherpa-onnx` build, which the PyPI wheel
is not, and ONNX Runtime falls back to the CPU silently rather than failing.

**Ollama cannot do the speech recognition, only the on-screen text reading.**
Its `POST /v1/audio/transcriptions` endpoint parses uploads but is absent from
the documented `/v1/` surface, and no audio-capable model is published, so a
text model answers *"model does not support multimodal requests"*. The
recogniser sits behind an interface with an `ollama` implementation stubbed, so
the day an audio model appears the switch is a config value rather than a
rewrite. Until then `LOCAL_TRANSCRIBE_ASR_ENGINE=ollama` fails with that
explanation rather than pretending.

## Privacy

The audio is read by `ffmpeg` and by the recognition weights, both on this
machine. **Frames of the video go to a local Ollama on `127.0.0.1:11434`** to
have their on-screen text read, and they are written as JPEGs in the run's own
temporary directory, which is deleted with it; `--no-ocr` stops the frames
being extracted, and sent, at all. Nothing else leaves the machine: no
transcript text is ever sent anywhere, and the plugin makes no network request
beyond the one-time model download from Hugging Face.

**Voice prints never leave the machine either, and are never created
implicitly.** `--enroll` is the only thing that writes one, to
`LOCAL_TRANSCRIBE_VOICES_DIR` (local disk, outside any git repository by
default — see *Voice prints* above), and nothing about transcribing,
diarizing or identifying a recording writes or sends a print on its own.

## Recording

Optional, and a separate skill — transcription is the product, and a file you
already have needs none of this. **Always run `detect` first:**

```bash
uv run --script scripts/record.py detect     # what will this machine deliver?
uv run --script scripts/record.py start
uv run --script scripts/record.py stop       # prints the file it wrote
```

`stop` prints the recording's real path, asked of the recorder rather than
guessed or configured. Exit `3` means nothing was recorded and the reason is
printed.

| Backend | Far-end audio | Speaker labels | Setup |
| --- | --- | --- | --- |
| **OBS Studio** | yes | `Me` / `Remote N` with two audio tracks, **once the transcriber confirms the tracks actually differ** | install OBS, enable its WebSocket server, route each source to its own track |
| **macOS `screencapture`** | **no**, unless a loopback aggregate device is the default input | `Speaker N` from `--diarize` — no `Me` anchor, since everything lands in one mixed stream | install BlackHole, build an Aggregate Device, make it the default input |

**OBS is the one to use for a call**, and Google Meet is the reason: Meet has no
local recording of its own, so a Meet call has to be captured around the
browser, and only OBS's two-track routing separates your microphone from
everyone else. `detect` reads how many audio tracks OBS is actually recording —
**one track means no labels**, even though OBS is running and looks fine.

### It refuses to record a call it cannot capture

If no backend can hear the far end, `start` exits 3 instead of recording. A
microphone-only recording of a call is worthless for the reason you made it and
you only find out on playback, when the call cannot be repeated. `--mic-only`
overrides it, and is the right flag when you are recording only yourself.

⚠️ **The macOS built-in recorder cannot capture system audio at all.**
`screencapture` offers `-v`, `-g` (*default **input***) and `-G<id>` (a chosen
**input**) — there is no system-audio flag. The fix is BlackHole plus an
Aggregate Device as the default input, which is a much lighter install than OBS
and can reach the same automatic labels in principle — subject to the same
check, since a two-track container from either backend is not trusted to
label itself until the transcriber confirms the tracks differ.

### Consent

⚠️ **A local screen recording of a Google Meet call is invisible to the other
participants**, where Meet's own recording shows everyone an indicator. Announce
the recording and get agreement before starting; `references/consent.md` has the
rest, with the retention specifics left for your organisation to fill in.

This applies to the recorder only. Transcribing a file you already have is not a
new act of recording, so the transcriber never asks.

### The recording is written locally and never deleted

`LOCAL_TRANSCRIBE_ARCHIVE_DIR` (or `--archive-dir`) copies the finished file
somewhere else; unset means no copy. Recording straight to a network share was
tried and reverted — a network blip mid-call cannot be re-recorded, while a
failed copy costs nothing because the local file is still there. If a copy
fails, the message names the local path.

| Variable | Default | What it does |
| --- | --- | --- |
| `LOCAL_TRANSCRIBE_RECORDER` | unset — negotiate | pin a backend by name |
| `OBS_WS_HOST` / `OBS_WS_PORT` | `127.0.0.1` / `4455` | where OBS listens |
| `OBS_WS_PASSWORD` | unset | from the environment or the OS keyring |
| `LOCAL_TRANSCRIBE_RECORD_DIR` | `~/Movies` | where `screencapture` writes |
| `LOCAL_TRANSCRIBE_AUDIO_DEVICE` | unset | a CoreAudio input id for `screencapture -G` |
| `LOCAL_TRANSCRIBE_ARCHIVE_DIR` | unset | copy finished recordings here |

Under WSL, an OBS on the Windows side is reachable at `127.0.0.1` only with
`networkingMode=mirrored`; otherwise the host is the `/etc/resolv.conf`
nameserver address. `detect` reports which addresses it tried.

## Licence

MIT — see the `LICENSE` file at the root of the repository.
