# Setting up `local-transcribe`

A transcriber that runs entirely on your own machine. You point it at an audio
or video file — a meeting recording, a screen capture of a call, a voice memo —
and it writes a Markdown transcript beside it, with speaker labels when you ask
for them and the on-screen text read by a model running on your laptop.

**Nothing is uploaded.** No cloud speech API, no third-party service, no
account. The only network traffic is a one-time download of the model weights
from public URLs, and after that it works with the wifi off.

This guide covers **macOS, Windows and Linux**, and two separate jobs that
people usually conflate:

| Job | What you need | Section |
| --- | --- | --- |
| **Transcribe a file you already have** — a Teams/Zoom recording, an OBS file, a phone memo | `uv`, and Ollama if the file has a screen to read | [1](#1-install-uv) → [3](#3-transcribe-a-file-you-already-have) |
| **Record a call first**, then transcribe it | the above, plus OBS Studio | [4](#4-recording-a-call-with-obs) |

Do the first job first. It needs no OBS, no audio routing, and no recording
setup at all, and it is most of the value.

---

## What gets installed, and how big it is

Measured on an Apple Silicon Mac. Everything is cached after the first
run and nothing is downloaded twice.

| Piece | Size | When it arrives | Needed for |
| --- | --- | --- | --- |
| `uv` | ~35 MB | you install it | everything |
| Python packages incl. `ffmpeg` | ~60 MB | first run | everything |
| `whisper-large-v3-turbo` weights | **1.5 GB** | first transcription | everything |
| Silero VAD and one embedding model | **29 MB** | first `--speakers` run | speaker labels |
| Ollama | ~500 MB | you install it | OCR only |
| `qwen2.5vl:7b` | **~6 GB** | you pull it | OCR only |
| OBS Studio | ~200 MB | you install it | recording only |

So the minimum useful install is `uv` plus 1.6 GB of weights. **OCR is
optional** — `--no-ocr` skips the Ollama stage entirely, and you can add
Ollama later without touching anything else. A file with no video never needs
it at all.

> [!important] There is no `sudo` anywhere in this setup, and no system
> `ffmpeg`. `ffmpeg` arrives as a Python wheel, which is why this installs the
> same way on a locked-down work laptop as on your own.

---

## 1. Install `uv`

`uv` is the only hard prerequisite. It builds and caches the Python environment
on first run, so you never manage one yourself.

**macOS**

```bash
brew install uv
# or, with no Homebrew:
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Linux**, and WSL

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Windows** — PowerShell

```powershell
winget install --id=astral-sh.uv -e
# or:
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Check it:

```bash
uv --version
```

If that says *command not found*, open a new terminal — the installer adds
`uv` to your `PATH` and the change reaches only new shells.

---

## 2. Get the plugin

### If you use Claude Code

```
/plugin marketplace add rockad/agentic-hub
/plugin install local-transcribe
```

That gives you two skills — `transcribe` and `record` — that you can ask for in
plain language ("transcribe this recording, there were three of us").

> [!note] The marketplace is **public** and hosted on GitHub (`rockad/agentic-hub`).
> The clone is anonymous — no account, no token, nothing to sign up for. If it is
> unreachable from where you are, the plain-copy route below is the same
> scripts, not a lesser version.

### If you do not, or the marketplace is unreachable

Copy the `local-transcribe` directory anywhere and call the script directly.
There is nothing to install and nothing to register:

```bash
uv run --script /path/to/local-transcribe/scripts/transcribe.py --help
```

Everything in this guide works through that command. The Claude Code skills are
a convenience layer over exactly these scripts.

---

## 3. Transcribe a file you already have

### First, ask what the file is — this is free and instant

```bash
uv run --script scripts/transcribe.py recording.mkv --probe-only
```

```
recording.mkv: 00:47:12 · shape B · 2 audio stream(s) · 48000 Hz, 1 ch, aac · video present
```

The **shape** is what decides how it can be labelled, so read it before
anything else:

| Shape | What it is | Speaker labels |
| --- | --- | --- |
| **A** | one audio stream, one channel | `--dictation`, or `--speakers N` for labels |
| **B** | **two or more audio streams** | **`Me` / `Remote`, checked before it is trusted — see below** |
| **C** | one stream, several channels | downmixed; `--speakers N` for labels |
| **F** | video with no audio | no speakers — the screen is read instead, and that is the whole document |

⚠️ **A stream count is not a source count.** `--probe-only` can only report how
many audio streams a container holds, not what is *in* them — and a stream
count of 2 does not by itself mean one source per stream. OBS in **Advanced
output mode, with the microphone routed to track 1 and the far-end audio to
track 2** (§4.3) genuinely produces that split, and only then is `Me` /
`Remote` a fact about the file. OBS's default "plain recording" also writes
two or more audio streams, but every one of them can carry the same mixed
audio — both speakers on both tracks — because nothing routed the sources
apart. This is not a hypothetical: it is exactly what a real recording did on
2026-09-15, one room microphone writing two identical-content OBS tracks, and
the old logic labelled them `Me` / `Remote` anyway — attributing one person's
words to the other with nothing warning anyone. Shape alone cannot tell these
cases apart; only the samples can.

**So the samples are checked automatically, before shape B is trusted.** A
handful of short windows spread across the file are decoded from each stream
— never the whole file, so this costs a few seconds regardless of length —
and their loudness contours are compared after removing level and gain
differences, which is what lets it tell "two mics" from "one mic re-encoded
twice" rather than being fooled by one track simply being quieter. Both a bare
run and `--probe-only` print the result:

```bash
uv run --script scripts/transcribe.py call.mkv --probe-only
```

```
call.mkv: 00:49:29 · shape B · 2 audio stream(s) · 48000 Hz, 2 ch, aac
checking whether the audio streams are separate sources…
  streams 0/1: distinct sources (envelope correlation 0.21, threshold 0.60, 5/5 windows used)
```

If it instead reports **same mix**, `Me` / `Remote` is refused — the run asks
for `--dictation`, `--speakers N` or `--diarize` exactly as it would for a
genuine single-stream file, naming this section as the fix for the next
recording. Full mechanics are in `scripts/lt/mixcheck.py`.

**The old manual check — transcribing each stream on its own and comparing —
still works** as a second opinion, or on a file this check could not read (an
unusual codec, say):

```bash
uv run --script scripts/transcribe.py call.mkv --stream 0 --dictation --out /tmp/s0
uv run --script scripts/transcribe.py call.mkv --stream 1 --dictation --out /tmp/s1
```

Read the two transcripts side by side: **different** sentences confirm
separate sources; the **same** sentences in both confirm a shared mix. The
same check works by ear too: play each extracted stream and listen for
whether both voices are audible on both.

### One person talking — a dictated memo, a voice note

```bash
uv run --script scripts/transcribe.py memo.m4a --dictation
```

### Several people, and you know how many

This is the normal meeting case. Give the number of people who actually spoke:

```bash
uv run --script scripts/transcribe.py standup.m4a --speakers 4
```

```
**[00:00:00] Speaker 1:** Morning — let's start with the migration.
**[00:00:06] Speaker 2:** Staging is done, production is waiting on the DNS change.
```

Put real names on them, in order of who spoke first:

```bash
uv run --script scripts/transcribe.py standup.m4a --speakers 4 \
    --names 'Alice,Bob,Carol,Dave'
```

### Several people, and you do not know how many

```bash
uv run --script scripts/transcribe.py roundtable.m4a --diarize
```

It clusters the voices and reports what it found. If the count comes out wrong,
`--speakers N` overrides it, and `--speaker-threshold` is the dial in between:
**lower splits one person into several, higher merges two into one** (default
`0.5`).

### A recording with one track per person

Nothing to pass. A two-track file is checked and, once confirmed genuinely
two sources, labels itself:

```bash
uv run --script scripts/transcribe.py call.mkv
```

```
speakers: 2 audio streams, labelled by source (stream 0 is Me) — checked and found distinct (envelope correlation 0/1: 0.21, threshold 0.60)
```

If the check instead finds the same mix on both streams, it refuses per-track
labels the same way a single-stream file would — see *A stream count is not a
source count* above.

If `Me` and `Remote` come out the wrong way round, your recorder put the
microphone on track 2: add `--me-stream 1`.

### Why it refuses instead of guessing

A one-stream audio file is **byte-for-byte the same shape** whether it holds a
dictated memo or six people round a table microphone. Nothing in the file says
which, so with no instruction the tool stops and asks:

```
error: standup.m4a is a single audio stream, which is the same shape whether it is a
dictated memo or six people round a table mic — the container cannot tell them apart,
and defaulting the choice either way is wrong half the time.
Say which it is:
  --dictation            one speaker, no labels
  --speakers 3           three people, labelled Speaker 1–3
  --diarize              several people, let the model count them
```

The two mistakes are not symmetrical, which is the whole reason for the
refusal. Speaker separation wrongly **off** on a meeting gives you an
unlabelled wall of text that reads as perfectly fine and is useless the moment
anyone needs to know who said what — and you find out weeks later. Wrongly
**on** on a monologue wastes a few minutes.

### Useful flags

| Flag | What it does |
| --- | --- |
| `--out DIR` | write the transcript somewhere other than beside the input |
| `--language en` | skip language detection (also `fi`, `ru`, …) |
| `--no-ocr` | skip Ollama entirely — faster, and no model to install, for a file with nothing worth reading on screen |
| `--stream N` | transcribe only stream N of a multi-track file |
| `--probe-only` | report what the file is and stop |

---

## 3b. Reading the screen — install Ollama

Optional, and only needed for a file with video. Skip this and pass `--no-ocr`
on such a file; everything else works, and an audio-only file never touches it.

The on-screen text is read by a vision model on your own machine. **Frames of
the video** are sent to `127.0.0.1:11434`, which is a process on your laptop;
the audio and the transcript text never go near it.

**macOS** — download from [ollama.com/download](https://ollama.com/download),
or `brew install ollama && brew services start ollama`

**Windows** — download the installer from
[ollama.com/download](https://ollama.com/download), or
`winget install --id=Ollama.Ollama -e`

**Linux**

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Then pull the vision model once, since it is what reads the slides and shared
screens:

```bash
ollama pull qwen2.5vl:7b          # the on-screen text, ~6 GB
```

Check it is up:

```bash
curl -s http://127.0.0.1:11434/api/tags
```

On a machine with less memory, point it at the smaller alternative — no
reinstall needed:

```bash
export LOCAL_TRANSCRIBE_OCR_MODEL=granite3.2-vision:2b   # a third of the size
```

> [!note] If Ollama is not running, the transcription still succeeds. The
> on-screen text is skipped, and the transcript says so in its header, rather
> than the whole run failing on an optional stage. `--ocr` is the way to
> insist: it fails loudly, before recognition starts, when the vision model is
> missing.

### What reading the screen actually does

A file with video gets its screen read with no flag. The run picks the frames
where the picture changed — plus one every two minutes regardless, so a deck
left on one slide is not read once and called unchanging — sends each to the
vision model, and collapses repeats, so a slide held for four minutes is one
entry and not forty. What it reads lands in an `## On-screen text` section
with timestamps.

| You want | Pass |
| --- | --- |
| Nothing on screen worth reading (a talking-head call) | `--no-ocr` |
| A slide was missed | `--ocr-scene 0.02` — reads on smaller changes |
| The picture never cuts (a scrolling document) | `--ocr-interval 15` — every fifteen seconds instead |
| A long recording read more densely | `--ocr-max-frames 80` (the default 40 are spread across the whole file, never truncated at the start) |

---

## 4. Recording a call with OBS

Only needed when the recording does not exist yet. **If you already have a
file, you are done — go back to section 3.**

> [!warning] **Quit OBS before editing any of its configuration files**, and
> **restart it after changing any output setting.**
>
> OBS rewrites `basic.ini`, `user.ini`, the scene collection JSON and the
> plugin configs — `obs-websocket`'s `config.json` among them — from memory
> when it exits, so an edit made while it runs is overwritten with no error.
> A file read while it runs can likewise return a value the GUI has already
> replaced. The order is **quit → edit → relaunch**.
>
> OBS also builds its recording output at launch, so output settings changed
> afterwards — through the API or the files — apply only from the next start.
> Until then it records in the previous format, tracks and folder while the
> profile, and `record.py detect`, report the new ones.
>
> Both are avoided by using the GUI or the WebSocket API and restarting before
> you check anything.

### Why OBS, and not the built-in recorder

Google Meet has no local recording of its own, so a Meet call has to be
captured around the browser. Only OBS can put **your microphone on one track
and everyone else on another** — but a track configuration is not proof the
routing actually happened (§3 above covers the recording that broke this
assumption), so the transcriber checks the streams before trusting them.

| Recorder | Captures the far end | Speaker labels |
| --- | --- | --- |
| **OBS Studio** | yes | `Me` / `Remote` with two tracks, **checked before it is trusted** |
| macOS `screencapture` | **no**, unless a loopback device is the default input | none |

The macOS built-in recorder **cannot capture system audio at all** — there is
no flag for it. Reaching the same result needs BlackHole plus an Aggregate
Device as the default input, which is a lighter install than OBS but more
fiddly to get right.

### 4.1 Install OBS

**macOS** — `brew install --cask obs`, or from
[obsproject.com](https://obsproject.com/download)

**Windows** — `winget install --id=OBSProject.OBSStudio -e`, or from
[obsproject.com](https://obsproject.com/download)

**Linux**

```bash
sudo apt install obs-studio        # Debian/Ubuntu
flatpak install flathub com.obsproject.Studio
```

On **macOS**, grant OBS *Screen Recording* and *Microphone* permission in
System Settings → Privacy & Security the first time it asks, then **restart
OBS** — the grant does not reach the running process. Until you do, the video
is a black screen.

> [!important] On macOS, *Screen Recording* permission is what lets OBS capture
> **system audio** too, not just the picture. macOS 13 and later expose the
> other end of a call through ScreenCaptureKit, which is gated by that same
> permission, so a refused Screen Recording prompt silently costs you the
> `Remote` track as well as the video.

Check the install before configuring anything:

```bash
uv run --script scripts/record.py detect
```

With OBS closed it says so plainly, which is the expected answer at this point:

```
⛔ obs
    blocked: OBS is not answering on 127.0.0.1:4455 — start it and enable its
    WebSocket server (Tools → WebSocket Server Settings).
```

### 4.2 Turn on the WebSocket server

This is how the `record` skill starts and stops OBS, and how it asks OBS where
it actually wrote the file rather than guessing.

1. OBS → **Tools → WebSocket Server Settings**
2. Tick **Enable WebSocket server**
3. Leave the port at **4455**
4. **Show Connect Info** → copy the password

Then put the password in your environment — never paste it into a chat:

```bash
export OBS_WS_PASSWORD='...'        # macOS/Linux: add to ~/.zshrc or ~/.bashrc
```

```powershell
$env:OBS_WS_PASSWORD = '...'        # Windows, this session
```

### 4.3 Add the sources, and route each to its own track

Without this, OBS records one mixed track, and **no speaker labels are
possible** even though OBS is running and looks perfectly fine.

**First, the three sources.** A fresh OBS profile has an empty scene, and an
empty scene records a black file with no audio. In the **Sources** panel, click
**+** three times:

| Source | macOS | Windows | Linux |
| --- | --- | --- | --- |
| the picture | **macOS Screen Capture** | *Display Capture* | *Screen Capture (PipeWire)* |
| you | **Audio Input Capture** → your microphone | *Audio Input Capture* | *Audio Input Capture* |
| the far end | **macOS Audio Capture** | *Audio Output Capture* | *Audio Output Capture* |

> [!important] **You have to pick the display yourself, and the tool will not
> pick one for you.** Most setups have more than one screen — a laptop panel
> and an external monitor — and there is no correct default between them:
> capturing the wrong one gives you a perfectly valid recording of the wrong
> thing, and you find out on playback. Open the screen source's **Properties**
> and choose the display the call is on.
>
> On macOS a screen source created without a display shows
> `init_screen_stream: Invalid target display ID: 0` in the OBS log and records
> black.

While you are in the screen source's **Properties**, tick **Hide OBS windows
from capture** (`hide_obs` in the scene file). Otherwise OBS's own preview
appears inside the recording, and because the preview is showing the capture,
it recurses into an infinite tunnel that makes the screen content unreadable.

> [!note] On **macOS 13 and later you do not need BlackHole**. *macOS Audio
> Capture* takes the far end straight from ScreenCaptureKit, which is why the
> old loopback-device advice no longer applies. It does need *Screen Recording*
> permission — see 4.1.

**Then the output settings and the routing:**

1. **Settings → Output → Output Mode: `Advanced`**
2. **Recording** tab → **Recording Format: `mkv`** (or *hybrid MP4*; plain MP4
   cannot hold multiple audio tracks)
3. Still on the Recording tab, under **Audio Track**, tick **1** and **2**
4. Close Settings. In the **Audio Mixer**, click the ⚙ on any source →
   **Advanced Audio Properties**
5. In the **Tracks** columns:
   - your **microphone** → track **1** only
   - the **far-end audio** source → track **2** only
   - the **screen** source → neither, so it cannot leak into either track

Verify before you rely on it:

```bash
uv run --script scripts/record.py detect
```

It reads how many tracks OBS is *actually* recording and says what labels you
will get. **One track means no labels** — go back to step 3.

> [!warning] **Wear headphones.** Without them your microphone picks up the
> other participants through your speakers, so they appear on *both* tracks and
> `Me` stops meaning you. This is the most common way a two-track recording
> quietly turns into a one-track one.

### 4.4 Record

```bash
uv run --script scripts/record.py detect     # what will this machine deliver?
uv run --script scripts/record.py start
uv run --script scripts/record.py stop       # prints the file it wrote
```

`stop` prints the real path, asked of OBS rather than configured anywhere. Then
transcribe it with no flags at all — it is a two-track file, so it labels
itself:

```bash
uv run --script scripts/transcribe.py "/path/from/stop.mkv"
```

**If no recorder on the machine can hear the far end, `start` refuses** rather
than recording. A microphone-only recording of a call is worthless for the
reason you made it, and you only discover that on playback, when the call
cannot be repeated. `--mic-only` overrides it, and is the right flag when you
are recording only yourself.

### 4.5 Consent

⚠️ **A local screen recording of a Meet call is invisible to everyone else** —
Meet's own recording shows all participants an indicator, and this does not.
Say you are recording and get agreement before you start. `references/consent.md`
has the rest; retention specifics are for your organisation to fill in.

This applies to recording only. Transcribing a file you already have is not a
new act of recording, so the transcriber never asks.

### Under WSL

An OBS running on the Windows side is reachable at `127.0.0.1` only with
`networkingMode=mirrored`; otherwise the host is the nameserver address in
`/etc/resolv.conf`. Set `OBS_WS_HOST` to it. `detect` reports which addresses
it tried.

### 4.6 Requirements for the scripts, and for driving OBS yourself

**`uv` is the only thing you install.** Every script here carries its
dependencies inline as [PEP 723](https://peps.python.org/pep-0723/) metadata:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["obsws-python>=1.7"]
# ///
```

So `uv run --script scripts/record.py` resolves and caches `obsws-python` on
first run, and there is no virtualenv to create, activate or remember.

⚠️ **Run them with `uv run --script`, not with `python`.** `python
scripts/record.py` ignores the inline metadata and fails with
`ModuleNotFoundError: obsws-python` unless you have built an environment by
hand. The shebang says the same thing, so `./scripts/record.py` works too.

**OBS is controlled over obs-websocket v5, through the `obsws-python` client.**
If you are scripting OBS yourself — creating sources, setting tracks, changing
profile settings — use that library and, where it exists, this plugin's own
`lt.recorders.obs` module rather than writing another client: the framing,
authentication and error messages are already handled there.

```python
import obsws_python as obsws

cl = obsws.ReqClient(host="127.0.0.1", port=4455, password=..., timeout=10)
cl.set_profile_parameter("AdvOut", "RecEncoder", "...")   # recording settings
cl.set_input_audio_tracks("Microphone", {"1": True, "2": False})
```

Two things that bite when scripting OBS on macOS:

- ⚠️ **Do not ask OBS to enumerate a screen source's `display_uuid`.** The
  `GetInputPropertiesListPropertyItems` request against a `screen_capture`
  input **crashes OBS outright**, reproducibly, taking the WebSocket connection
  with it. Set `display_uuid` directly if you already know it, or leave the
  display to the person, which is the right answer anyway (see 4.3).
- **The video encoder id differs between Simple and Advanced output mode.**
  `apple_h264` is Simple-mode only; in Advanced mode it fails with
  `Encoder ID 'apple_h264' not found` and **recording silently never starts**.
  The Advanced-mode id on Apple Silicon is
  `com.apple.videotoolbox.videoencoder.ave.avc`. The OBS log lists every id
  the build has under `Available Encoders:`.

---

## 5. Which models run where

You do not choose these — the tool picks per platform — but it helps to know
what is running.

| Stage | Apple Silicon | Windows / Linux | Gated? |
| --- | --- | --- | --- |
| Speech recognition | `mlx-whisper` on the **Apple GPU** via Metal | `faster-whisper`, **CUDA + float16** if an NVIDIA card, else CPU + int8 | no |
| Speaker segmentation | `sherpa-onnx`, CPU (measured faster — see below) | same | no |
| Speaker embedding | `sherpa-onnx`, CPU | same | no |
| On-screen text | Ollama running `qwen2.5vl:7b` (Apache-2.0), GPU if it has one | same | no |

**Nothing here needs an account, a token or a licence acceptance.** That was a
hard requirement, and it is why speaker separation uses `sherpa-onnx` rather
than the better-known `pyannote.audio`: `pyannote`'s weights sit behind gated
Hugging Face terms that *every person* must accept individually on their own
account, and someone who skips it silently gets one merged speaker label
instead of an error. The `sherpa-onnx` models are plain public downloads.

**Ollama cannot do the speech recognition, only the on-screen text reading.**
Its `/v1/audio/transcriptions` endpoint exists but no audio-capable model is
published, so it answers *"model does not support multimodal requests"*.
Setting `LOCAL_TRANSCRIBE_ASR_ENGINE=ollama` tells you that rather than
pretending.

### Is it using my GPU?

**Yes, for the stage where it matters, and the run tells you so rather than
leaving you to assume it.** Every run prints the accelerator, and every
transcript records it in its header:

```
transcribing with mlx-whisper / mlx-community/whisper-large-v3-turbo on Apple GPU via MLX (Device(gpu, 0))…
separating 2 speakers (sherpa-onnx on cpu)…
```

```yaml
device: Apple GPU via MLX (Device(gpu, 0))
```

- **Apple Silicon** — recognition runs on the Apple GPU through MLX's Metal
  backend. There is nothing to enable and no CPU variant to pick.
- **NVIDIA** — recognition runs on the card with `float16`, chosen explicitly
  rather than left to a library default. If a card is visible to the driver but
  unusable by the runtime, it says so and falls back to the CPU instead of
  failing after the weights have loaded.
- **Neither** — the CPU path with `int8`, and the run warns you, because a
  machine that should be fast and is not should not be a mystery.

`LOCAL_TRANSCRIBE_ASR_DEVICE=cuda|cpu` forces the choice.

**Speaker separation deliberately stays on the CPU.** It is already about
**0.04× of audio duration** — a minute of work on a 30-minute recording — and
CoreML benchmarks no faster at two threads and slower at six, for a longer
model load. Both models are small enough that per-operator dispatch dominates,
so there is nothing to gain. `LOCAL_TRANSCRIBE_DIARIZE_PROVIDER=coreml` (or
`cuda`, which needs a CUDA-enabled `sherpa-onnx` build the plain PyPI wheel is
not) if you want to measure it on your own hardware.

### Speed

On an Apple Silicon Mac (M5, 24 GB) a warm run transcribes at **0.13–0.36× of
audio duration** — a 30-minute recording in roughly 4–10 minutes — and speaker
separation adds about 0.04× on top. Short files are dominated by the fixed
model load, so those figures are a floor and not a throughput number.

⚠️ **A GPU-less Windows or Linux laptop has not been measured yet**, and it
runs the CPU path. Expect it to be several times slower. On a machine like
that, `LOCAL_TRANSCRIBE_ASR_MODEL=small` trades accuracy for a large speed
gain.

---

## 6. When something goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| `uv: command not found` | `PATH` updated only for new shells | open a new terminal |
| `is a single audio stream, which is the same shape…` | it will not guess one speaker vs several | pass `--dictation`, `--speakers N` or `--diarize` |
| Only `Speaker 1` on a real conversation | one voice dominates, or the count was wrong | pass the real `--speakers N`, or lower `--speaker-threshold` to `0.4` |
| More speakers than people | one person's voice varied, or crosstalk | pass `--speakers N` to pin the count |
| `Me` and `Remote` swapped | the microphone is on track 2 | `--me-stream 1` |
| Everyone appears on both tracks | speakers instead of headphones during the call | wear headphones; re-route per 4.3 |
| `warning: recognition looped` | Whisper repeated one phrase for much of the file — usually the wrong `--language`, sometimes audio it cannot make out | re-run naming the real language, or drop `--language` to auto-detect |
| `warning: --language en was given but 82% of the recognised letters are Cyrillic` | the forced language is wrong for this recording | drop `--language`, or name the right one |
| `warning: the labels did not attach to the text` | separation ran but everything landed on one speaker | treat the transcript as unlabelled; check for a `looped` warning above it, which is the usual cause |
| `note: no on-screen text — the vision model … is not pulled` | the screen half has no model | `ollama pull qwen2.5vl:7b`, or `--no-ocr` if you do not want it |
| `note: no on-screen text — Ollama is not reachable …` | Ollama is not running | start Ollama, or pass `--no-ocr` |
| `on-screen text: skipped — …` in the header | the same, recorded in the file | as above; the transcript itself is unaffected |
| The slides are missing from a screen share | they changed too little for the sampler to notice | `--ocr-scene 0.02`, or `--ocr-interval 15` for a picture that never cuts |
| One screen entry for a long recording | nothing changed enough, and the two-minute backstop found the same picture each time | it is probably right; `--ocr-interval 30` samples harder if you doubt it |
| `no legible text was found on any of the frames` on a silent video | the picture has no text, or it is too small to read | `--ocr-scene 0.02`; check the recording is not a black screen (on macOS, OBS without Screen Recording permission records black) |
| The on-screen text is subtly wrong | it is a model's reading, not a measurement | check anything you quote against the recording; this is stated in the file too |
| Header says `speakers: … NOT RELIABLE` | the run does not trust its own labels | read the `> [!warning]` block at the top of the transcript |
| `detect` reports one track | OBS is recording mixed audio | redo 4.3, check the format is `mkv` |
| The recording ignores the format, tracks or folder you just set | output settings changed since OBS started; it is still using the ones loaded at launch | restart OBS, then re-run `detect` — before the restart `detect` reports the profile, not what OBS will do |
| `start` says it is recording, `stop` says nothing is | OBS refused to start the output, usually a bad encoder id | check the OBS log for `Encoder ID '…' not found`; in Advanced mode on Apple Silicon use `com.apple.videotoolbox.videoencoder.ave.avc` |
| The file is there but the picture is black | the scene has no screen source, or the source has no display selected | add the source and pick the display (4.3); the OBS log says `init_screen_stream: Invalid target display ID: 0` |
| The recording shows OBS itself, tunnelling into infinity | OBS's own window is inside the capture | tick **Hide OBS windows from capture** in the screen source's Properties |
| OBS quits the moment a script asks about a source | `GetInputPropertiesListPropertyItems` on a `screen_capture` input crashes OBS on macOS | do not enumerate `display_uuid` over the WebSocket — set the display in the GUI |
| `ModuleNotFoundError: obsws-python` | the script was run with `python`, which ignores its inline PEP 723 dependencies | run it with `uv run --script` (4.6) |
| `could not download the speaker model` | network or proxy | it is a plain public URL; on an offline machine place the file at the path in the message |
| Transcript is poor and the header says 8000 Hz | the source is below 16 kHz | nothing to fix in software — record at a higher rate |

Exit codes: **0** done · **2** bad input or a missing engine · **3** an input
shape this version cannot label honestly.

---

## 7. Everything you can configure

Every value has a working default, and none of them points at a machine that
is not yours.

| Variable | Default | What it does |
| --- | --- | --- |
| `LOCAL_TRANSCRIBE_ASR_ENGINE` | `mlx-whisper` on Apple Silicon, else `faster-whisper` | which recogniser |
| `LOCAL_TRANSCRIBE_ASR_MODEL` | `mlx-community/whisper-large-v3-turbo` / `large-v3-turbo` | model for that engine |
| `LOCAL_TRANSCRIBE_ASR_DEVICE` | `auto` → `cuda` if a usable card, else `cpu` | `faster-whisper` only; MLX is always the Apple GPU |
| `LOCAL_TRANSCRIBE_ASR_COMPUTE` | `float16` on CUDA, `int8` on CPU | `faster-whisper` quantisation |
| `LOCAL_TRANSCRIBE_DIARIZE_PROVIDER` | `cpu` — measured fastest | `coreml`, or `cuda` with a CUDA-enabled `sherpa-onnx` build |
| `LOCAL_TRANSCRIBE_MODEL_DIR` | `~/.cache/local-transcribe/models` | where the speaker models are cached |
| `LOCAL_TRANSCRIBE_VAD_MODEL` | downloaded | use a local Silero VAD `.onnx` |
| `LOCAL_TRANSCRIBE_EMBEDDING_MODEL` | downloaded | pin a local embedding `.onnx`; nothing ever switches models on your behalf |
| `LOCAL_TRANSCRIBE_DIARIZE_THREADS` | `2` | CPU threads for speaker separation |
| `LOCAL_TRANSCRIBE_OLLAMA_URL` | `http://127.0.0.1:11434` | where the vision model lives |
| `LOCAL_TRANSCRIBE_OCR_MODEL` | `qwen2.5vl:7b` | which vision model reads the screen |
| `LOCAL_TRANSCRIBE_FFMPEG` / `_FFPROBE` | the wheel's binary | use a specific system build |
| `LOCAL_TRANSCRIBE_RECORDER` | negotiate | pin a recorder backend by name |
| `OBS_WS_HOST` / `OBS_WS_PORT` | `127.0.0.1` / `4455` | where OBS listens |
| `OBS_WS_PASSWORD` | unset | from the environment or the OS keyring |
| `LOCAL_TRANSCRIBE_RECORD_DIR` | `~/Movies` | where `screencapture` writes |
| `LOCAL_TRANSCRIBE_AUDIO_DEVICE` | unset | a CoreAudio input id for `screencapture -G` |
| `LOCAL_TRANSCRIBE_ARCHIVE_DIR` | unset | copy finished recordings here as well |

---

## 8. What this version will not do

Stated plainly, because each of these is refused with an explanation rather
than fudged:

- **On-screen text it cannot vouch for.** Slides and shared screens *are* read
  now, by a local vision model, and that reading is a model's rather than a
  measurement — a misread digit is the failure to expect. The transcript says so
  in the section itself; do not quote a number off it without checking the
  recording. Reading between frames is also not attempted: a slide that appeared
  and vanished inside the sampling gap was never looked at.
- **Channels as speakers.** A multi-channel single stream whose channels are
  separate sources gets downmixed, then diarized if you ask. The channel
  mapping itself is not used.
- **Naming who is who from a mixed recording.** `Speaker 1` is as far as the
  audio goes; `--names` is you telling it, in order of first appearance.
- **Overlapping speech.** Two people talking at once is attributed whole to
  whoever dominates that stretch. Accuracy under overlap has not been measured
  yet.
- **Non-English speaker separation accuracy.** The embedding model is trained
  on English and Chinese. It works on other languages — voice identity is
  mostly acoustic — but no number is claimed for Finnish or Russian.

## 9. Verifying your install

```bash
./evals/smoke.sh                            # 68 checks, end to end
uv run --script evals/quality_test.py       # 24 checks, instant
```

`smoke.sh` builds its own inputs, needs no fixtures, and covers every input
shape and every refusal. On macOS it uses two `say` voices as two real
speakers, so the speaker-separation checks assert attribution and not merely
that nothing crashed. `./evals/smoke.sh --fast` skips the cases that load the
model.

`quality_test.py` loads no model and covers the checks that decide whether a
run is allowed to present speaker labels at all.

## Privacy, in one paragraph

The audio is read by `ffmpeg` and by the recognition and speaker models, all on
this machine. **Frames of the video** are sent to `127.0.0.1:11434` for the
on-screen text, which is a local process; `--no-ocr` stops even that, and an
audio-only file never triggers it. No transcript text is ever sent anywhere,
and the only outbound request the tool ever makes is the one-time model
download.
