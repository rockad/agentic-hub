---
name: record
description: >-
  Record a call or screen locally with OBS or the macOS screen recorder. Use to
  start, stop or check a recording.
---

# Record locally, on whatever this machine has

**Always run `detect` first.** It costs nothing, needs no recorder running, and
it is the only way to know what the recording will actually be worth:

```bash
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/record.py" detect
```

Then:

```bash
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/record.py" start
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/record.py" status
uv run --script "${CLAUDE_PLUGIN_ROOT}/scripts/record.py" stop     # prints the file path
```

`stop` prints the recording's real path on stdout — asked of the recorder, never
guessed or configured. Exit codes: `0` done, `3` nothing was recorded and the
reason is printed.

## Consent comes first, and it is not boilerplate here

**Before the first recording in a conversation, read `references/consent.md` and
say the short version out loud to the user.** The script prints a one-line
reminder on every `start`; your job is to make sure the user has actually
agreed with the other participants, not to relay a string.

⚠️ **A local screen recording of a Google Meet call is invisible to the other
participants.** Meet's own recording shows everyone an indicator; a screen
recorder shows nothing. Someone can record four colleagues who have no idea it
is happening without ever intending to deceive anyone. That is the specific
thing to prevent, so name it when the call is on Meet.

This applies to recording only. Transcribing a file the user already has is not
a new act of recording and must never prompt.

## Never guess `--mic-only`

If no backend can capture the far end, `start` refuses with exit 3 rather than
making a recording where everyone except the user is silent — a failure you
only discover on playback, when the call cannot be repeated.

**Do not pass `--mic-only` to get past that.** Ask the user which they meant:

- Recording **other people** → fix the backend first. `detect` prints the fix.
- Recording **only themselves** (dictation, a talk-through, thinking aloud) →
  `--mic-only` is correct and the refusal was the tool doing its job.

## Backends, and what each really gives you

| Backend | Far-end audio | Speaker labels | Setup |
| --- | --- | --- | --- |
| **OBS Studio** | yes | `Me` / `Remote N` with two audio tracks, **checked by the transcriber before it is trusted** | install OBS, enable its WebSocket server, route each source to its own track |
| **macOS `screencapture`** | **no**, unless a loopback aggregate device is the default input | `Speaker N` from the transcriber's `--diarize`, with no `Me` anchor — everything lands in one mixed stream | install BlackHole, build an Aggregate Device in Audio MIDI Setup |

**OBS is the recommended backend for a call**, and the reason is Google Meet:
Meet has no local recording of its own, so a Meet call must be captured around
the browser, and only OBS's two-track routing separates the user's microphone
from everyone else. That separation is what lets speaker labels be a checked
fact rather than a guess — checked, because a track count is not a proof the
routing actually happened; see the warning below.

`detect` reports how many audio tracks OBS is actually recording. **One track
means no labels** even though OBS is running and looks fine — say so plainly
rather than letting the user find out later.

⚠️ **Two tracks only stay two sources if the user is wearing headphones.**
Through speakers, their microphone picks up everyone else, so the far end lands
on *both* tracks and `Me` stops meaning them. `detect` cannot see this — it only
counts tracks, not what is in them — but the transcriber's own mix check can:
it samples both tracks at transcription time and refuses per-track labels when
they turn out to carry the same audio, rather than silently mislabelling the
transcript. Still mention headphones when setting up a call recording, since
catching the problem after the call is worse than preventing it.

### Getting OBS ready

1. Install OBS, then **Tools → WebSocket Server Settings → Enable WebSocket
   server**. Default is `127.0.0.1:4455`.
2. **Settings → Output → Recording**: enable two audio tracks.
3. **Advanced Audio Properties**: route the microphone to track 1 and desktop
   audio to track 2. ⚠️ A profile reset silently undoes this — if labels stop
   working, check here first.
4. On WSL, an OBS running on the Windows side is reachable at `127.0.0.1` only
   with `networkingMode=mirrored`; otherwise set `OBS_WS_HOST` to the
   `/etc/resolv.conf` nameserver address. `detect` says which it tried.

⛔ **Never handle the OBS WebSocket password.** It comes from
`OBS_WS_PASSWORD` or the OS keyring. Do not ask the user to paste it into the
conversation, do not read it out of a file, and do not echo it — if
authentication fails, tell them to set the environment variable themselves.

## After stopping

1. Give the user the path `stop` printed.
2. Offer to transcribe it, and run `transcribe.py <path> --probe-only` first —
   that reports the input shape, which tells you whether speaker labels are
   available for this file.
3. A two-track OBS recording is input shape B. Pass nothing — the transcriber
   samples both tracks, and once it confirms they carry different audio it
   labels them **`Me` / `Remote`** with no flags needed. `--me-stream 1` is the
   fix if they come out swapped. If the tracks turn out to carry the same
   mixed audio (one mic, duplicated onto both — see the headphones warning
   above), it refuses per-track labels and asks for `--dictation`,
   `--speakers N`, or `--diarize` instead, exactly as it would for a
   single-stream file.
4. A **one-track** recording is shape A, so it needs the speaker count:
   `--speakers N` if the user knows how many people spoke, `--diarize` if not.
   Those labels come from a clustering model and are `Speaker 1…N`, so say
   plainly that they are inferred, the same as a same-mix two-track file's
   labels would be if that path is taken.

## Copying the recording somewhere

`LOCAL_TRANSCRIBE_ARCHIVE_DIR`, or `--archive-dir <dir>`, copies the finished
file. **Unset means no copy, which is the safe default.**

The recording is always written locally first and **never deleted
automatically**, and it must never be recorded straight to a network share: a
network blip mid-call cannot be re-recorded, while a failed copy costs nothing
because the local file is still there. If a copy fails, the message names the
local path — pass that on rather than treating the recording as lost.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `LOCAL_TRANSCRIBE_RECORDER` | unset — negotiate | pin a backend by name |
| `OBS_WS_HOST` / `OBS_WS_PORT` | `127.0.0.1` / `4455` | where OBS listens |
| `OBS_WS_PASSWORD` | unset | from the environment or the OS keyring, never from chat |
| `LOCAL_TRANSCRIBE_RECORD_DIR` | `~/Movies` | where `screencapture` writes (OBS decides its own) |
| `LOCAL_TRANSCRIBE_AUDIO_DEVICE` | unset | a CoreAudio input id for `screencapture -G` |
| `LOCAL_TRANSCRIBE_ARCHIVE_DIR` | unset | copy finished recordings here |
