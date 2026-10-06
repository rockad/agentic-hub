# Recording other people — consent and retention

**This file applies to the recorder, not the transcriber** — with one
exception. Transcribing a file you already have, or dictating a note to
yourself, involves nobody else and must never prompt about any of this. But
**enrolling someone else's voice print** (`--enroll`, from the transcriber)
is its own act with its own consent question, covered in *Voice prints* below
— it is not "just transcribing" even though it runs through the same script.

## The case this exists for

Google Meet has no local recording, so capturing a Meet call on your own machine
means recording the screen and audio *around* the browser. **The other
participants see nothing.** When Meet itself records, every participant gets an
indicator; a screen recorder gives them no signal at all.

So it is possible to record four colleagues who have no idea it is happening
without intending to deceive anyone. That is the specific thing this file is
here to prevent, and it is why `record.py start` prints a one-line reminder
every time it starts a recording — one line is cheap, and tracking "have I said
this already" is the kind of state that gets it wrong on the call that matters.

## Before you start a recording

1. **Say out loud that you are recording, and get agreement**, before the
   recording starts — not after, and not in a chat message nobody reads.
2. **Say why**, and say where the file will live. "I'd like to record this so I
   don't have to take notes; it stays on my laptop" is usually the whole
   conversation.
3. **If anyone objects, do not record.** Take notes instead.
4. **A customer or candidate conversation needs more than a verbal nod.** Check
   what your organisation requires before you record one of those at all.

## Where recordings and transcripts may be stored

_To be filled in by your organisation._ The plugin deliberately ships no
retention period and no storage location: those are policy, not defaults, and
inventing them would be worse than leaving them blank.

**Retention:** the same as your organisation applies to its own meeting
recordings. For Google Meet, the default is that a recording is kept in the
organiser's Drive until somebody deletes it, with no fixed expiry — other
platforms differ, so check yours rather than assuming. If your organisation has
set a figure, use that. **If it has not, say so in the consent line rather than
inventing one** — "it stays on my laptop and I have no set deletion date" is an
honest answer and a made-up "deleted after 30 days" is not, because the person
agreeing is relying on it.

What the plugin does guarantee:

- The recording and the transcript are written to **local disk** and stay there.
- Nothing is copied anywhere unless you set an archive directory yourself.
- No audio and no transcript text is sent to any network service. A recording
  with video sends the **frames** to a local Ollama on `127.0.0.1` to have
  their on-screen text read, and nothing else.

## Treat the output as confidential

A transcript of a customer call, a candidate interview or a colleague's
one-to-one is confidential material in text form, which makes it far easier to
paste somewhere careless than the recording was. Store it where you store other
confidential notes, and do not put it in a shared or public space.

## Recording yourself is different

Dictating a memo, or recording your own thoughts, involves nobody else. None of
the above applies, and the tool will not ask you about it.

## Naming a speaker from context (`--attendees`) is not a voice print

`--attendees` names a `Speaker N` from an attendee list, a self-introduction,
or being addressed by name — all read from the words already recognised.
**Nothing about a person's voice is ever stored or compared**, so none of the
weight below applies to it: the recording's own transcript already contains
the words this uses, and putting a name to a cluster the transcript already
separated adds nothing a reader could not work out themselves from the same
words plus the recording's own metadata. Confirm the names you supply are
right, the same way you would check any other fact before writing it down —
but there is no separate consent question here the way there is for a print.

## Voice prints are a separate, further step — and need their own consent

`--enroll` stores a **voice print**: a fingerprint of how someone sounds,
kept so a later recording can name them instead of leaving them `Speaker N`.
That is biometric personal data, not a transcript, and having recorded or
transcribed someone is not the same as having their agreement to fingerprint
their voice and keep it on file indefinitely.

**Enrolling yourself needs nothing beyond what is above.** It is your own
voice, kept on your own machine, for your own future transcripts.

**Enrolling anyone else is a separate ask, and it should be rare.** Prefer
enrolling only yourself. On a 1:1 recording, naming your own cluster already
tells the reader who the other speaker is — the meeting has exactly two
people, one of them is named, and the recording's own metadata (a calendar
invite, a filename, who you were on the call with) says who the other one
was. That gets the same readable transcript without a second person's voice
ever being stored. Enrol someone else only when they know their voice is
being kept for this and are fine with it — the same bar as recording them at
all, not a lower one because it is "just an ID this time."

**Never enrol someone from a recording they do not know exists.** A voice
print made from a call they did not know was recorded compounds one consent
problem with a second, more permanent one: the recording can be deleted, but
a print re-identifies them in every future recording until someone remembers
to `--forget` it.

What the plugin guarantees on its own, so this is about judgment rather than
also being about the mechanics:

- Nothing is ever enrolled as a side effect of transcribing, diarizing, or
  identifying — `--enroll` is the only door in.
- Prints are stored **locally only**, in a directory this plugin's own files
  never share (`LOCAL_TRANSCRIBE_VOICES_DIR`, default
  `~/.local/share/local-transcribe/voices/`) — never inside the transcript,
  and never uploaded anywhere. Keep that directory **private and unshared**.
  The test is whether a print can leave the machine, not whether the folder
  is under version control: a git repository with no remote is fine, while a
  repository you push, a synced cloud folder, a shared drive, or a backup
  that ships the tree off the machine is not. Naming version control as the
  disqualifier would ban something harmless and, worse, imply that an
  unversioned folder inside a synced directory is safe — which is the actual
  leak.
- `--list-voices` shows everyone currently enrolled and `--forget NAME`
  deletes one print permanently. There is no bulk export and no "undo" on a
  forget — the vector is gone.
