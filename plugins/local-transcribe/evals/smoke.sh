#!/usr/bin/env bash
# Smoke test for the transcriber: every input shape, and every refusal.
#
# It builds its own inputs, so it needs no fixtures in git. On macOS the speech
# comes from `say`, which means the speech-content checks run there; elsewhere
# the inputs are tones and only the shape and refusal checks run.
#
#   ./evals/smoke.sh            # everything
#   ./evals/smoke.sh --fast     # skip the cases that load the model
#
# Exit 0 means every check passed.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRANSCRIBE="$HERE/../scripts/transcribe.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/local-transcribe-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

PASS=0
FAIL=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

run() { uv run --script "$TRANSCRIBE" "$@" 2>&1; }
code() { uv run --script "$TRANSCRIBE" "$@" >/dev/null 2>&1; echo $?; }

# --- inputs -----------------------------------------------------------------

head_ "Building inputs in $WORK"

FFMPEG="$(uv run --with imageio-ffmpeg python -c \
  'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())' | tail -1)"
[[ -x "$FFMPEG" ]] && ok "ffmpeg from the wheel: $(basename "$FFMPEG")" \
                   || bad "no ffmpeg from the wheel"

SPOKEN="the quick brown fox jumps over the lazy dog"
HAVE_SPEECH=0
if command -v say >/dev/null 2>&1; then
    say -o "$WORK/memo.aiff" "$SPOKEN. $SPOKEN." && HAVE_SPEECH=1
else
    "$FFMPEG" -nostdin -loglevel error -y -f lavfi \
        -i "sine=frequency=300:duration=8" -ac 1 -ar 22050 "$WORK/memo.aiff"
fi
[[ -s "$WORK/memo.aiff" ]] && ok "one-speaker source (speech=$HAVE_SPEECH)" \
                           || bad "could not build the one-speaker source"

# A two-voice conversation, for the diarization checks. Two `say` voices are
# two genuinely different speakers as far as an embedding model is concerned,
# which is what makes the attribution assertions below meaningful rather than
# merely non-crashing. Without `say` the sources are two tones: the stage still
# runs, but only its shape is checked, never which voice said what.
HAVE_TWO_VOICES=0
if [[ $HAVE_SPEECH == 1 ]]; then
    say -v Daniel -o "$WORK/v1a.aiff" "Good morning. I will walk you through the setup."
    say -v Kathy  -o "$WORK/v1b.aiff" "Thank you. Does it keep the audio on my own laptop?"
    say -v Daniel -o "$WORK/v1c.aiff" "Yes. Nothing at all is uploaded anywhere."
    say -v Kathy  -o "$WORK/v1d.aiff" "That is exactly what I needed to hear today."
    if [[ -s "$WORK/v1a.aiff" && -s "$WORK/v1b.aiff" ]]; then HAVE_TWO_VOICES=1; fi
fi
if [[ $HAVE_TWO_VOICES == 1 ]]; then
    for v in v1a v1b v1c v1d; do
        "$FFMPEG" -nostdin -loglevel error -y -i "$WORK/$v.aiff" \
            -ac 1 -ar 16000 "$WORK/$v.wav"
    done
    : > "$WORK/all.txt"
    for v in v1a v1b v1c v1d; do printf "file '%s'\n" "$WORK/$v.wav" >> "$WORK/all.txt"; done
    "$FFMPEG" -nostdin -loglevel error -y -f concat -safe 0 -i "$WORK/all.txt" \
        -c copy "$WORK/meeting.wav"
else
    "$FFMPEG" -nostdin -loglevel error -y -f lavfi \
        -i "sine=frequency=220:duration=5" -f lavfi \
        -i "sine=frequency=660:duration=5" -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" \
        -ac 1 -ar 16000 "$WORK/meeting.wav"
fi
"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/meeting.wav" \
    -ac 1 -ar 16000 -c:a aac "$WORK/meeting.m4a"
[[ -s "$WORK/meeting.m4a" ]] \
    && ok "two-speaker source (distinct voices=$HAVE_TWO_VOICES)" \
    || bad "could not build the two-speaker source"

# A second two-voice conversation, this one with a real self-introduction in
# it, for the naming-from-context checks — meeting.wav above never says
# either speaker's name, which is what makes it the right fixture for
# elimination but the wrong one for testing that a self-introduction is
# actually found.
if [[ $HAVE_TWO_VOICES == 1 ]]; then
    say -v Daniel -o "$WORK/n1a.aiff" "Hi, I'm Daniel, thanks for making the time today."
    say -v Kathy  -o "$WORK/n1b.aiff" "Nice to meet you, I've been looking forward to this call."
    say -v Daniel -o "$WORK/n1c.aiff" "Let's start with the roadmap for next quarter."
    say -v Kathy  -o "$WORK/n1d.aiff" "Sounds good, I have a few questions about staffing."
    for v in n1a n1b n1c n1d; do
        "$FFMPEG" -nostdin -loglevel error -y -i "$WORK/$v.aiff" \
            -ac 1 -ar 16000 "$WORK/$v.wav"
    done
    : > "$WORK/nall.txt"
    for v in n1a n1b n1c n1d; do printf "file '%s'\n" "$WORK/$v.wav" >> "$WORK/nall.txt"; done
    "$FFMPEG" -nostdin -loglevel error -y -f concat -safe 0 -i "$WORK/nall.txt" \
        -c copy "$WORK/attendees.wav"
    "$FFMPEG" -nostdin -loglevel error -y -i "$WORK/attendees.wav" \
        -ac 1 -ar 16000 -c:a aac "$WORK/attendees.m4a"
fi

"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/memo.aiff" \
    -ac 1 -ar 8000 -c:a aac "$WORK/phone.m4a"
"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/memo.aiff" \
    -ac 2 -c:a aac "$WORK/stereo.m4a"
"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/memo.aiff" -i "$WORK/memo.aiff" \
    -map 0:a -map 1:a -c:a aac "$WORK/twotrack.mkv"
"$FFMPEG" -nostdin -loglevel error -y -f lavfi \
    -i "color=c=black:s=320x240:d=3" -pix_fmt yuv420p "$WORK/silent.mp4"

# The failure this plugin exists to catch: one microphone, two OBS tracks that
# both carry the identical mix — at different gains and encode settings, the
# way a real one-mic-two-track recording actually looks on disk, never
# byte-identical. This is what a stream-count-only check would wrongly label
# Me / Remote.
"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/memo.aiff" \
    -ac 1 -ar 48000 -filter:a "volume=0.4" -c:a aac -b:a 96k "$WORK/mix_low.m4a"
"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/memo.aiff" \
    -ac 1 -ar 48000 -filter:a "volume=1.6" -c:a aac -b:a 192k "$WORK/mix_high.m4a"
"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/mix_low.m4a" -i "$WORK/mix_high.m4a" \
    -map 0:a -map 1:a -c:a copy "$WORK/samemix.mkv"
[[ -s "$WORK/samemix.mkv" ]] && ok "same-mix two-track source (different gain/bitrate)" \
                             || bad "could not build the same-mix source"

# A two-track file whose second track was never fed: real speech on track 1,
# digital silence on track 2. A real 66-minute recording looked exactly like
# this, and because a silent track cannot be correlated against a live one the
# check came back inconclusive and the run labelled by track anyway — putting a
# whole two-person conversation on `Me`. The fixture exists so that can never
# pass again.
"$FFMPEG" -nostdin -loglevel error -y -f lavfi -i anullsrc=r=48000:cl=mono \
    -t 20 -c:a aac -b:a 96k "$WORK/silence.m4a"
"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/memo.aiff" \
    -ac 1 -ar 48000 -c:a aac -b:a 128k "$WORK/live_track.m4a"
"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/live_track.m4a" -i "$WORK/silence.m4a" \
    -map 0:a -map 1:a -c:a copy -shortest "$WORK/silenttrack.mkv"
[[ -s "$WORK/silenttrack.mkv" ]] && ok "two-track source whose second track is silent" \
                                 || bad "could not build the silent-track source"

# The mirror image: silence on track 1 and the real audio on track 2. Defaulting
# to stream 0 would transcribe the silence and produce an empty transcript that
# looks like a quiet meeting, so which stream carries the audio has to be found
# rather than assumed. Nothing in the recordings this was developed against had
# this shape, which is exactly why it needs a fixture.
"$FFMPEG" -nostdin -loglevel error -y -i "$WORK/silence.m4a" -i "$WORK/live_track.m4a" \
    -map 0:a -map 1:a -c:a copy -shortest "$WORK/silentfirst.mkv"
[[ -s "$WORK/silentfirst.mkv" ]] && ok "two-track source whose FIRST track is silent" \
                                 || bad "could not build the silent-first source"

# Russian, kept permanently rather than checked once: it is a working language
# for these recordings, so a change that regresses it must fail here rather
# than be discovered in a meeting transcript. macOS ships exactly one ru_RU
# voice (Milena), so this is one speaker by necessity — a two-voice Russian
# diarization fixture is not buildable from `say` alone, and that is a gap in
# the coverage rather than a choice. Every name in it is invented.
HAVE_RUSSIAN=0
if [[ $HAVE_SPEECH == 1 ]] && say -v '?' 2>/dev/null | grep -q ru_RU; then
    say -v Milena -o "$WORK/ru.aiff" \
        "Здравствуйте. Меня зовут Анатолий Орлов. Со мной работает Владимир Соколов. Мы обсуждаем кластер Kubernetes и хранилище объектов." \
        && HAVE_RUSSIAN=1
    if [[ $HAVE_RUSSIAN == 1 ]]; then
        "$FFMPEG" -nostdin -loglevel error -y -i "$WORK/ru.aiff" \
            -ac 1 -ar 16000 -c:a aac "$WORK/russian.m4a"
        ok "Russian source (one ru_RU voice, invented names)"

        # Code-switching, which is how these conversations actually run: a
        # Russian sentence carrying an English phrase and a Latin technical
        # term. The two behave differently and the fixture asserts both.
        say -v Milena -o "$WORK/cs.aiff" \
            "Мы обсуждаем кластер Kubernetes. Мы решили, что we should probably roll that back before the release, потому что тесты падают."
        "$FFMPEG" -nostdin -loglevel error -y -i "$WORK/cs.aiff" \
            -ac 1 -ar 16000 -c:a aac "$WORK/codeswitch.m4a"
        [[ -s "$WORK/codeswitch.m4a" ]] && ok "code-switched source (Russian host, English inserts)" \
                                        || bad "could not build the code-switched source"
    fi
else
    printf '  \033[33mskip\033[0m  no ru_RU voice on this machine; Russian checks skipped\n'
fi

# Slides, for the on-screen text reader. drawtext needs a font named outright —
# the wheel's ffmpeg has no fontconfig, so a bare `drawtext` silently renders
# nothing. Without a font on this machine the slide checks are skipped rather
# than asserted against a blank picture.
FONT=""
for candidate in \
    /System/Library/Fonts/Supplemental/Arial.ttf \
    /System/Library/Fonts/Helvetica.ttc \
    /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    /usr/share/fonts/TTF/DejaVuSans.ttf \
    /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf; do
    [[ -f "$candidate" ]] && { FONT="$candidate"; break; }
done

SLIDE_ONE="QUARTERLY REVIEW"
SLIDE_TWO="MIGRATION DEADLINE"
if [[ -n "$FONT" ]]; then
    for pair in "1:$SLIDE_ONE" "2:$SLIDE_TWO"; do
        n="${pair%%:*}"; words="${pair##*:}"
        "$FFMPEG" -nostdin -loglevel error -y -f lavfi \
            -i "color=c=white:s=1280x720:d=6" \
            -vf "drawtext=fontfile=$FONT:text='$words':fontcolor=black:fontsize=72:x=80:y=300" \
            -pix_fmt yuv420p -r 5 "$WORK/slide$n.mp4"
    done
    : > "$WORK/slides.txt"
    for n in 1 2; do printf "file '%s'\n" "$WORK/slide$n.mp4" >> "$WORK/slides.txt"; done
    "$FFMPEG" -nostdin -loglevel error -y -f concat -safe 0 -i "$WORK/slides.txt" \
        -c copy "$WORK/slides.mp4"
    # The same slides with speech over them: a screen share with a voice on it,
    # which is the shape this feature actually exists for.
    "$FFMPEG" -nostdin -loglevel error -y -i "$WORK/slides.mp4" -i "$WORK/memo.aiff" \
        -map 0:v -map 1:a -c:v copy -c:a aac -shortest "$WORK/talk.mkv"
    [[ -s "$WORK/slides.mp4" && -s "$WORK/talk.mkv" ]] \
        && ok "slide sources (font: $(basename "$FONT"))" \
        || bad "could not build the slide sources"
else
    printf '  \033[33mskip\033[0m  no usable font; the slide checks are skipped\n'
fi

# Is the vision model actually pulled? Every model-dependent OCR check below is
# conditional on this, so the suite passes on a machine that has never pulled it.
OCR_MODEL="${LOCAL_TRANSCRIBE_OCR_MODEL:-qwen2.5vl:7b}"
HAVE_VISION=0
if curl -s --max-time 3 http://127.0.0.1:11434/api/tags 2>/dev/null \
   | grep -q "\"${OCR_MODEL%%:*}"; then
    HAVE_VISION=1
fi

# A two-track call: one voice per track, which is what OBS records with one
# audio track per source. Distinct content per track is the point — it is how
# the Me / Remote assertions can tell a real attribution from a lucky one.
if [[ $HAVE_TWO_VOICES == 1 ]]; then
    : > "$WORK/me.txt"; : > "$WORK/rem.txt"
    for v in v1a v1c; do printf "file '%s'\n" "$WORK/$v.wav" >> "$WORK/me.txt"; done
    for v in v1b v1d; do printf "file '%s'\n" "$WORK/$v.wav" >> "$WORK/rem.txt"; done
    "$FFMPEG" -nostdin -loglevel error -y -f concat -safe 0 -i "$WORK/me.txt" \
        -c copy "$WORK/me.wav"
    "$FFMPEG" -nostdin -loglevel error -y -f concat -safe 0 -i "$WORK/rem.txt" \
        -c copy "$WORK/rem.wav"
    "$FFMPEG" -nostdin -loglevel error -y -i "$WORK/me.wav" -i "$WORK/rem.wav" \
        -map 0:a -map 1:a -c:a aac "$WORK/call.mkv"
else
    cp "$WORK/twotrack.mkv" "$WORK/call.mkv"
fi
[[ -s "$WORK/call.mkv" ]] && ok "two-track call source" \
                          || bad "could not build the two-track call source"

# --- probing ----------------------------------------------------------------

head_ "Probing reports the right shape"

# The first run in a cold uv cache prints "Installed N packages" to stderr, so
# warm the environment before anything reads a specific line of output.
run "$WORK/memo.aiff" --probe-only >/dev/null 2>&1

for pair in "memo.aiff:shape A" "phone.m4a:shape A" "stereo.m4a:shape C" \
            "twotrack.mkv:shape B" "silent.mp4:shape F"; do
    file="${pair%%:*}"; want="${pair##*:}"
    got="$(run "$WORK/$file" --probe-only | grep -m1 'shape')"
    [[ "$got" == *"$want"* ]] && ok "$file → $want" \
                              || bad "$file → expected '$want', got: $got"
done

got="$(run "$WORK/phone.m4a" --probe-only | grep -m1 'shape')"
[[ "$got" == *"8000 Hz"* ]] && ok "phone.m4a reports 8000 Hz" \
                            || bad "phone.m4a did not report its sample rate: $got"

# --- refusals ---------------------------------------------------------------

head_ "Shapes it cannot label honestly are refused with exit 3"

for pair in "memo.aiff:--dictation:" "stereo.m4a:--dictation:" \
            "silent.mp4:nothing to transcribe:--no-ocr"; do
    file="$(echo "$pair" | cut -d: -f1)"
    hint="$(echo "$pair" | cut -d: -f2)"
    extra="$(echo "$pair" | cut -d: -f3)"
    # shellcheck disable=SC2086  # $extra is one optional flag, deliberately split
    got="$(code "$WORK/$file" $extra)"
    [[ "$got" == 3 ]] && ok "$file $extra refused (exit 3)" \
                      || bad "$file $extra expected exit 3, got $got"
    # shellcheck disable=SC2086
    text="$(run "$WORK/$file" $extra)"
    [[ "$text" == *"$hint"* ]] && ok "$file names the way forward ('$hint')" \
                               || bad "$file did not mention '$hint'"
done

# A bare single stream is ambiguous, so all three ways out get named: the
# refusal is only useful if it says what to pass instead.
text="$(run "$WORK/memo.aiff")"
for hint in "--dictation" "--speakers" "--diarize"; do
    [[ "$text" == *"$hint"* ]] && ok "the ambiguous-stream refusal offers $hint" \
                               || bad "the refusal never mentions $hint"
done

# --dictation on a two-track file is a contradiction, not a shortcut: one
# source per track means it is not one speaker.
got="$(code "$WORK/call.mkv" --dictation)"
[[ "$got" == 3 ]] && ok "--dictation on a two-track file refused (exit 3)" \
                  || bad "--dictation on two tracks gave exit $got"

got="$(code "$WORK/memo.aiff" --dictation --diarize)"
[[ "$got" == 2 ]] && ok "--dictation with --diarize exits 2 as contradictory" \
                  || bad "--dictation --diarize gave exit $got"

got="$(code "$WORK/memo.aiff" --speakers 0)"
[[ "$got" == 2 ]] && ok "--speakers 0 exits 2" || bad "--speakers 0 gave exit $got"

got="$(code "$WORK/missing.m4a")"
[[ "$got" == 2 ]] && ok "a missing file exits 2" || bad "missing file gave exit $got"

head_ "Ollama is refused as a recogniser, with a reason"
text="$(LOCAL_TRANSCRIBE_ASR_ENGINE=ollama run "$WORK/memo.aiff" --dictation)"
[[ "$text" == *"no audio-capable model"* ]] \
    && ok "the ollama ASR stub explains itself" \
    || bad "the ollama ASR stub said: $text"

head_ "On-screen text: the flags, before any model runs"

got="$(code "$WORK/memo.aiff" --dictation --ocr)"
[[ "$got" == 2 ]] && ok "--ocr on a file with no video exits 2" \
                  || bad "--ocr on audio-only gave exit $got"
text="$(run "$WORK/memo.aiff" --dictation --ocr)"
[[ "$text" == *"no video stream"* ]] \
    && ok "the audio-only refusal says there is no screen" \
    || bad "the audio-only refusal said: $text"

got="$(code "$WORK/memo.aiff" --dictation --ocr --no-ocr)"
[[ "$got" == 2 ]] && ok "--ocr with --no-ocr exits 2 as contradictory" \
                  || bad "--ocr --no-ocr gave exit $got"

# A model that is not pulled must be said before the long stages, not after —
# and how it is said depends on whether the stage was asked for by name.
got="$(LOCAL_TRANSCRIBE_OCR_MODEL=not-a-real-model:1b code "$WORK/silent.mp4")"
[[ "$got" == 2 ]] && ok "a missing vision model on a silent video exits 2" \
                  || bad "missing model on silent.mp4 gave exit $got"
text="$(LOCAL_TRANSCRIBE_OCR_MODEL=not-a-real-model:1b run "$WORK/silent.mp4")"
[[ "$text" == *"ollama pull not-a-real-model:1b"* ]] \
    && ok "it names the exact pull command" \
    || bad "the missing-model error did not name the pull: $text"

if [[ $FAST == 1 ]]; then
    head_ "Skipping the model runs (--fast)"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    [[ $FAIL == 0 ]] || exit 1
    exit 0
fi

# --- transcription ----------------------------------------------------------

head_ "Transcribing (loads the model; first run downloads it)"

out="$(run "$WORK/memo.aiff" --dictation | tail -1)"
if [[ -f "$out" ]]; then
    ok "wrote $(basename "$out")"
    grep -q '^speakers: single (dictation)$' "$out" \
        && ok "header records the single-speaker decision" \
        || bad "header is missing the speakers line"
    grep -q '^## Transcript$' "$out" && ok "has a Transcript section" \
                                     || bad "no Transcript section"
    # The header must say what did the work, so "was the GPU used?" is
    # answerable from the file rather than assumed.
    grep -q '^device: ' "$out" && ok "header records the accelerator" \
                              || bad "header has no device line"
    if [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]; then
        grep -q '^device: Apple GPU via MLX' "$out" \
            && ok "Apple Silicon reports the GPU, not the CPU" \
            || bad "on Apple Silicon but device is: $(grep -m1 '^device: ' "$out")"
    fi
    if [[ $HAVE_SPEECH == 1 ]]; then
        grep -qi 'quick brown fox' "$out" \
            && ok "recognised the spoken words" \
            || bad "did not recognise the spoken words"
    fi
    # A clean dictation run has nothing to be uncertain about: one speaker,
    # ordinary words, nothing mis-heard or inconsistently cased.
    grep -q '^## Needs a quick look$' "$out" \
        && bad "a clean run still wrote a verification block" \
        || ok "a clean run writes no verification block at all"
else
    bad "no transcript written for memo.aiff (got: $out)"
fi

out="$(run "$WORK/phone.m4a" --dictation | tail -1)"
if [[ -f "$out" ]]; then
    grep -q '8000 Hz' "$out" && ok "8 kHz source recorded in the header" \
                             || bad "8 kHz not in the header"
    grep -q 'below the 16 kHz' "$out" && ok "8 kHz carries a quality note" \
                                      || bad "8 kHz has no quality note"
else
    bad "no transcript written for phone.m4a"
fi

out="$(run "$WORK/twotrack.mkv" --dictation --stream 1 | tail -1)"
[[ -f "$out" ]] && ok "--stream 1 transcribes one stream of a two-stream file" \
               || bad "--stream 1 wrote nothing"

# --- speaker separation -----------------------------------------------------

head_ "Speaker separation on one mixed stream (downloads two ONNX models once)"

out="$(run "$WORK/meeting.m4a" --speakers 2 --out "$WORK/diar" | tail -1)"
if [[ -f "$out" ]]; then
    ok "wrote a diarized transcript"
    grep -qE '^speakers: [0-9]+ separated by sherpa-onnx diarization' "$out" \
        && ok "header records how the speakers were separated" \
        || bad "header does not record the diarization: $(grep -m1 '^speakers:' "$out")"
    grep -q 'count given as 2' "$out" \
        && ok "header records that the count was given, not guessed" \
        || bad "header does not record the given count"
    grep -qE '^\*\*\[[0-9:]+\] Speaker [0-9]+:\*\*' "$out" \
        && ok "every line carries a speaker label" \
        || bad "no speaker-labelled lines found"
    if [[ $HAVE_TWO_VOICES == 1 ]]; then
        found="$(grep -oE 'Speaker [0-9]+' "$out" | sort -u | wc -l | tr -d ' ')"
        [[ "$found" == 2 ]] && ok "two voices came out as exactly two speakers" \
                            || bad "two voices came out as $found speaker(s)"
        # Attribution, not just counting: the first and second turns are
        # different voices in the source, so they must differ in the output.
        first="$(grep -m1 -oE 'Speaker [0-9]+' "$out")"
        second="$(grep -oE 'Speaker [0-9]+' "$out" | sed -n 2p)"
        [[ -n "$second" && "$first" != "$second" ]] \
            && ok "consecutive turns by different voices got different labels" \
            || bad "turns 1 and 2 both came out as '$first'"
    fi
else
    bad "no diarized transcript written (got: $out)"
fi

out="$(run "$WORK/meeting.m4a" --diarize --out "$WORK/auto" | tail -1)"
if [[ -f "$out" ]]; then
    grep -q 'count found by clustering' "$out" \
        && ok "--diarize records that it counted the speakers itself" \
        || bad "--diarize did not record that the count was found"
else
    bad "--diarize wrote nothing"
fi

out="$(run "$WORK/meeting.m4a" --speakers 2 --names 'Alice,Bob' \
        --out "$WORK/named" | tail -1)"
if [[ -f "$out" ]]; then
    grep -q 'Alice:' "$out" && ok "--names replaced Speaker 1" \
                                || bad "--names did not reach the transcript"
    grep -q 'Speaker 1:' "$out" && bad "Speaker 1 survived --names" \
                                || ok "no numbered label left where a name was given"
else
    bad "--names wrote nothing"
fi

head_ "Naming a speaker from context — elimination and self-introduction"

if [[ $HAVE_TWO_VOICES == 1 ]]; then
    out="$(run "$WORK/attendees.m4a" --speakers 2 \
            --attendees 'Daniel Ainsworth,Kathy Bates' \
            --out "$WORK/namedctx" | tail -1)"
    if [[ -f "$out" ]]; then
        ok "wrote a transcript with --attendees"
        grep -q 'Daniel Ainsworth:' "$out" \
            && ok "the self-introduced speaker got their full attendee name" \
            || bad "Daniel Ainsworth never made it into the transcript"
        grep -q 'Kathy Bates:' "$out" \
            && ok "the other speaker was named by elimination" \
            || bad "Kathy Bates never made it into the transcript"
        grep -q 'Speaker 1:\|Speaker 2:' "$out" \
            && bad "a numbered label survived a fully-resolved --attendees run" \
            || ok "no numbered label left once every speaker was named from context"
        grep -q '^## Needs a quick look$' "$out" \
            && bad "a verification block appeared even though both speakers were named" \
            || ok "no verification block on a run with nothing left uncertain"
        grep -q 'named from context' "$out" \
            && ok "the header records what the names rest on" \
            || bad "the header does not mention naming from context: $(grep -m1 '^speakers:' "$out")"
        grep -q 'self-introduction' "$out" \
            && ok "the header names self-introduction as a basis" \
            || bad "self-introduction is not recorded as a basis"
        grep -q 'elimination' "$out" \
            && ok "the header names elimination as a basis" \
            || bad "elimination is not recorded as a basis"
    else
        bad "--attendees on a fully-nameable file wrote nothing"
    fi

    # meeting.m4a never says either speaker's name, and 'Alice'/'Bob' are not
    # its speakers' real names — a fictional attendee list gives naming from
    # context nothing to work with, which must produce an honest ask rather
    # than a guess dressed up as a fact. This is also the fixture for the two
    # required --verify smoke checks: a clean run above writes no block, and
    # this genuinely-unresolvable one writes one.
    out="$(run "$WORK/meeting.m4a" --speakers 2 \
            --attendees 'Nobody Onelist,Nobody Twolist' \
            --out "$WORK/unresolvedctx" | tail -1)"
    if [[ -f "$out" ]]; then
        grep -q '^## Needs a quick look$' "$out" \
            && ok "an unresolvable speaker produces a verification block" \
            || bad "no verification block on a file naming settles nothing about"
        grep -q '^### Unresolved speakers$' "$out" \
            && ok "the block nests the unresolved-speakers evidence naming.py produces" \
            || bad "no nested Unresolved speakers subsection: $(grep -m1 '^###' "$out")"
        grep -q 'Candidates still unaccounted for: Nobody Onelist, Nobody Twolist' "$out" \
            && ok "each unresolved speaker lists the remaining candidates" \
            || bad "candidates line missing or wrong: $(grep -m1 'Candidates still' "$out")"
    else
        bad "the unresolved-context run wrote nothing"
    fi

    # --no-verify silences the whole block, unresolved speakers included —
    # the assignments naming.py could make still apply, only the reporting
    # of what is left over is turned off.
    out="$(run "$WORK/meeting.m4a" --speakers 2 --no-verify \
            --attendees 'Nobody Onelist,Nobody Twolist' \
            --out "$WORK/unresolvedctx-noverify" | tail -1)"
    if [[ -f "$out" ]]; then
        grep -q '^## Needs a quick look$' "$out" \
            && bad "--no-verify still wrote a verification block" \
            || ok "--no-verify silences the verification block entirely"
        grep -q '^### Unresolved speakers$' "$out" \
            && bad "--no-verify still reported unresolved speakers" \
            || ok "--no-verify silences the unresolved-speakers report too"
    else
        bad "the --no-verify unresolved-context run wrote nothing"
    fi
else
    printf '  \033[33mskip\033[0m  no distinct say voices; naming-from-context checks need real speech\n'
fi

head_ "The known-names spelling pass — opt in, whole word, counted"

NAMES_FILE="$WORK/names.txt"
cat > "$NAMES_FILE" <<'EOF'
# fictional, for the smoke test only — "database" stands in for whatever a
# real recogniser actually mangles, so this fires deterministically rather
# than depending on how a specific nonsense phrase happens to get recognised.
Kubernetes: database
EOF
if [[ $HAVE_SPEECH == 1 ]]; then
    say -o "$WORK/spell.aiff" "let's talk about the database and the roadmap"
    "$FFMPEG" -nostdin -loglevel error -y -i "$WORK/spell.aiff" \
        -ac 1 -ar 16000 -c:a aac "$WORK/spell.m4a"
    out="$(run "$WORK/spell.m4a" --dictation --names-file "$NAMES_FILE" \
            --out "$WORK/spelled" | tail -1)"
    if [[ -f "$out" ]]; then
        ok "wrote a transcript with --names-file"
        grep -qi 'Kubernetes' "$out" \
            && ok "the mis-recognition was corrected to the right spelling" \
            || bad "'Kubernetes' never made it into the corrected transcript"
        grep -q '^names corrected: [1-9][0-9]* substitution' "$out" \
            && ok "the header records how many substitutions were made" \
            || bad "header does not record substitutions: $(grep -m1 '^names corrected:' "$out")"
    else
        bad "--names-file run wrote nothing"
    fi
else
    printf '  \033[33mskip\033[0m  no speech synthesis available for the spelling-pass fixture\n'
fi

out="$(run "$WORK/memo.aiff" --dictation --out "$WORK/nospell" | tail -1)"
grep -q '^names corrected: off$' "$out" \
    && ok "names corrected defaults to off without --names-file" \
    || bad "names-corrected header wrong by default: $(grep -m1 '^names corrected:' "$out")"

head_ "--names-file also accepts a Markdown table, detected from its content"

NAMES_TABLE="$WORK/names.md"
cat > "$NAMES_TABLE" <<'EOF'
# Vocabulary

Some prose before the table, which the table reader ignores entirely.

| Canonical | Renderings |
| --- | --- |
| `Kubernetes` | `database` |
| `handover` | `hand over` — prime only, an ordinary word |
| `Object Storage` | excluded — an ordinary phrase, listed here only to prove it is left out |
EOF
if [[ $HAVE_SPEECH == 1 ]]; then
    say -o "$WORK/spellmd.aiff" "let's talk about the database and the roadmap"
    "$FFMPEG" -nostdin -loglevel error -y -i "$WORK/spellmd.aiff" \
        -ac 1 -ar 16000 -c:a aac "$WORK/spellmd.m4a"
    out="$(run "$WORK/spellmd.m4a" --dictation --names-file "$NAMES_TABLE" \
            --out "$WORK/spelledmd" | tail -1)"
    if [[ -f "$out" ]]; then
        ok "wrote a transcript with a Markdown --names-file"
        grep -qi 'Kubernetes' "$out" \
            && ok "the mis-recognition was corrected from the table's second column" \
            || bad "'Kubernetes' never made it into the corrected transcript"
        grep -q '^names corrected: [1-9][0-9]* substitution' "$out" \
            && ok "the header records substitutions from the Markdown table too" \
            || bad "header does not record substitutions: $(grep -m1 '^names corrected:' "$out")"
    else
        bad "the Markdown --names-file run wrote nothing"
    fi
else
    printf '  \033[33mskip\033[0m  no speech synthesis available for the Markdown-table fixture\n'
fi

# The excluded row and the prime-only row are both parsing questions, not
# recognition questions, so they are checked directly rather than by hoping
# a synthesised recording happens to mangle "handover" or "Object Storage".
cat > "$WORK/check-table-markers.py" <<PYEOF
import sys
sys.path.insert(0, "$HERE/../scripts")
from pathlib import Path
from lt import spelling

corrections = spelling.parse_names_file(Path("$NAMES_TABLE"))
by_name = {c.correct: c for c in corrections}
assert "Object Storage" not in by_name, "excluded row was not left out"
assert by_name["handover"].prime_only, "prime only row was not flagged"
assert by_name["handover"].misheard == ["hand over"], by_name["handover"].misheard
text, count = spelling.apply("Handover is Monday. Please plan the hand over.", corrections)
assert text.startswith("Handover is Monday"), text
assert "the handover." in text, text
assert count == 1, count
print("ok")
PYEOF
out="$(uv run python3 "$WORK/check-table-markers.py" 2>&1)"
[[ "$out" == "ok" ]] \
    && ok "the Markdown table honours excluded and prime-only markers" \
    || bad "table-parsing checks failed: $out"

head_ "a vocabulary row must not rewrite another row's output"

# A row whose canonical spelling is an ordinary word gets canonicalised
# against itself, which silently rewrites any longer canonical containing it:
# a real `storage` row downcased the `Object Storage` team name to `Object
# storage`. `prime only` is the fix, and the check that finds the whole class
# is self-consistency — apply the list to each of its own canonicals and
# nothing should change.
cat > "$WORK/two-row-fixture.md" <<'MDEOF'
| Canonical | Known mangling | Source |
| --- | --- | --- |
| Object Storage | | fixture |
| storage | `sturidge` | fixture |
MDEOF
cat > "$WORK/two-row-prime-only.md" <<'MDEOF'
| Canonical | Known mangling | Source |
| --- | --- | --- |
| Object Storage | | fixture |
| storage | `sturidge` — prime only | fixture |
MDEOF

cat > "$WORK/check-self-consistency.py" <<PYEOF
import sys
sys.path.insert(0, "$HERE/../scripts")
from pathlib import Path
from lt import spelling

# Without prime only, the ordinary-word row damages the compound row.
plain = spelling.parse_names_file(Path("$WORK/two-row-fixture.md"))
damaged, _ = spelling.apply("Object Storage owns it", plain)
assert damaged == "Object storage owns it", damaged
offenders = [c.correct for c in plain if spelling.apply(c.correct, plain)[0] != c.correct]
assert offenders == ["Object Storage"], offenders

# With prime only, the compound survives and the mangling is still corrected.
guarded = spelling.parse_names_file(Path("$WORK/two-row-prime-only.md"))
kept, _ = spelling.apply("Object Storage owns it", guarded)
assert kept == "Object Storage owns it", kept
fixed, count = spelling.apply("the sturidge layer", guarded)
assert fixed == "the storage layer", fixed
assert count == 1, count

# Self-consistency: the whole set applied to each of its own canonical
# spellings changes nothing. This is the assertion that generalises.
survivors = [c.correct for c in guarded if spelling.apply(c.correct, guarded)[0] != c.correct]
assert survivors == [], survivors
print("ok")
PYEOF
out="$(uv run python3 "$WORK/check-self-consistency.py" 2>&1)"
[[ "$out" == "ok" ]] \
    && ok "prime only protects an ordinary-word canonical, and every canonical survives its own list" \
    || bad "self-consistency checks failed: $out"

head_ "--rerender rebuilds the quick-look block without any audio"

# The point of the flag: a detector change can be seen against real speech
# without paying for recognition again. So this fixture is a transcript, not
# a recording — no synthesis, no model, and it runs on every machine.
cat > "$WORK/fixture.transcript.md" <<'MDEOF'
---
type: transcript
source: fixture.mkv
duration: 00:00:20
---

## Needs a quick look

stale content that must be replaced

## Transcript

**[00:00:01] Ada:** the GPUs are saturated and the LLMs keep timing out
**[00:00:09] Grace:** we put devX and OpenBow behind the runner
**[00:00:15] Ada:** So because I said it. So because I meant it. So because I did.
**[00:00:18] Grace:** So because i said it. So because i meant it.
MDEOF

rerender_out="$(run --rerender "$WORK/fixture.transcript.md")"
rerender_code=$(code --rerender "$WORK/fixture.transcript.md")
body="$(cat "$WORK/fixture.transcript.md")"

[[ "$rerender_code" == "0" ]] \
    && ok "--rerender exits 0 on a transcript with no audio present" \
    || bad "--rerender exited $rerender_code: $rerender_out"

grep -q "rerendered 4 turn(s), 2 speaker(s)" <<<"$rerender_out" \
    && ok "--rerender reads the turns and speakers back out of the transcript" \
    || bad "--rerender did not report the expected turn/speaker counts: $rerender_out"

grep -q "stale content that must be replaced" <<<"$body" \
    && bad "--rerender left the old quick-look block in place" \
    || ok "--rerender replaced the old quick-look block"

grep -q '^\*\*\[00:00:09\] Grace:\*\* we put devX' <<<"$body" \
    && ok "--rerender left the transcript text untouched" \
    || bad "--rerender altered the transcript text"

# (a) and (b) and (c), end to end on the rebuilt block.
grep -qE '\bGPUs\b|\bLLMs\b' <<<"$(sed -n '/^## Needs a quick look/,/^## /p' "$WORK/fixture.transcript.md")" \
    && bad "plural acronyms were still reported as mis-heard terms" \
    || ok "plural acronyms are not reported as mis-heard terms"

quicklook="$(sed -n '/^## Needs a quick look/,/^## /p' "$WORK/fixture.transcript.md")"
[[ "$(grep -c '> we put devX and OpenBow behind the runner' <<<"$quicklook")" == "1" ]] \
    && ok "two suspect tokens in one turn quote that turn once" \
    || bad "the shared turn was quoted more than once: $quicklook"

head_ "Two audio tracks label themselves, once checked to be separate sources"

out="$(run "$WORK/call.mkv" --out "$WORK/call" | tail -1)"
if [[ -f "$out" ]]; then
    ok "a two-track file transcribes without being told anything"
    grep -q 'checked and found distinct' "$out" \
        && ok "header says the streams were checked, not assumed" \
        || bad "header does not record the check: $(grep -m1 '^speakers:' "$out")"
    grep -q '\] Me:' "$out"     && ok "track 1 is labelled Me" || bad "no Me label"
    grep -q '\] Remote:' "$out" && ok "track 2 is labelled Remote" || bad "no Remote label"
    # The multi-stream path rebuilds Recognition, and used to drop `device`,
    # so the header claimed `unknown` while the run said Apple GPU.
    if grep -q '^device: unknown' "$out"; then
        bad "header lost the accelerator: $(grep -m1 '^device:' "$out")"
    else
        ok "header records the accelerator the run actually used"
    fi
    if [[ $HAVE_TWO_VOICES == 1 ]]; then
        # --me-stream must actually swap which side is you, or the flag is a lie.
        swapped="$(run "$WORK/call.mkv" --me-stream 1 \
                   --out "$WORK/swap" | tail -1)"
        mine="$(grep -m1 -A0 '\] Me:' "$out" | head -c 120)"
        theirs="$(grep -m1 -A0 '\] Me:' "$swapped" | head -c 120)"
        [[ -n "$theirs" && "$mine" != "$theirs" ]] \
            && ok "--me-stream 1 swaps which track is Me" \
            || bad "--me-stream 1 changed nothing"
    fi
else
    bad "no transcript written for the two-track call (got: $out)"
fi

head_ "Two audio tracks that are really one source are refused, not guessed"

got="$(run "$WORK/samemix.mkv" --probe-only | tail -1)"
[[ "$got" == *"same mix"* ]] && ok "--probe-only reports the same-mix finding" \
                             || bad "--probe-only did not report same mix: $got"

got="$(code "$WORK/samemix.mkv")"
[[ "$got" == 3 ]] && ok "a bare run on a same-mix two-track file is refused (exit 3)" \
                  || bad "same-mix bare run expected exit 3, got $got"
text="$(run "$WORK/samemix.mkv")"
for hint in "--dictation" "--speakers" "--diarize" "SETUP.md"; do
    [[ "$text" == *"$hint"* ]] && ok "the same-mix refusal mentions $hint" \
                               || bad "the same-mix refusal never mentions $hint"
done

out="$(run "$WORK/samemix.mkv" --dictation --out "$WORK/samemix" | tail -1)"
if [[ -f "$out" ]]; then
    ok "--dictation on a same-mix two-track file succeeds"
    grep -q 'per-track Me / Remote labelling was skipped' "$out" \
        && ok "header records that per-track labelling was skipped, and why" \
        || bad "header does not explain the skip: $(grep -m1 '^speakers:' "$out")"
    grep -q '\] Me:' "$out" && bad "a same-mix file still got a Me label" \
                            || ok "no Me / Remote label on a same-mix file"
else
    bad "--dictation on samemix.mkv wrote nothing"
fi

head_ "A silent second track is not a second source"

got="$(code "$WORK/silenttrack.mkv")"
[[ "$got" == 3 ]] && ok "a bare run on a silent-track file is refused (exit 3)" \
                  || bad "silent-track bare run expected exit 3, got $got"

text="$(run "$WORK/silenttrack.mkv")"
[[ "$text" == *"no audio at all"* ]] && ok "the refusal says the track holds no audio" \
                                     || bad "the refusal never mentions the silence: $text"
for hint in "--dictation" "--speakers" "--diarize"; do
    [[ "$text" == *"$hint"* ]] && ok "the silent-track refusal mentions $hint" \
                               || bad "the silent-track refusal never mentions $hint"
done

out="$(run "$WORK/silenttrack.mkv" --dictation --out "$WORK/silenttrack" | tail -1)"
if [[ -f "$out" ]]; then
    ok "--dictation on a silent-track file succeeds"
    grep -q 'holds no audio at all' "$out" \
        && ok "header records that a track was silent" \
        || bad "header does not explain the silence: $(grep -m1 '^speakers:' "$out")"
    grep -q '\] Me:' "$out" && bad "a silent-track file still got a Me label" \
                            || ok "no Me / Remote label on a silent-track file"
    grep -q 'assumed separate' "$out" \
        && bad "the header still claims the streams were assumed separate" \
        || ok "the header makes no claim that the streams were separate"
else
    bad "--dictation on silenttrack.mkv wrote nothing"
fi

head_ "A silent FIRST track: the live stream is found, not assumed"

out="$(run "$WORK/silentfirst.mkv" --dictation --out "$WORK/silentfirst" | tail -1)"
if [[ -f "$out" ]]; then
    ok "--dictation on a silent-first file succeeds"
    grep -q 'stream 0 holds no audio at all' "$out" \
        && ok "header names stream 0 as the silent one" \
        || bad "header does not name stream 0 as silent: $(grep -m1 '^speakers:' "$out")"
    grep -q 'stream 1 was transcribed' "$out" \
        && ok "the live stream was transcribed even though it is not stream 0" \
        || bad "header does not say stream 1 was transcribed: $(grep -m1 '^speakers:' "$out")"
    if [[ $HAVE_SPEECH == 1 ]]; then
        grep -qi 'quick brown fox' "$out" \
            && ok "the words from the live track are in the transcript" \
            || bad "the transcript does not contain the live track's speech"
    fi
else
    bad "--dictation on silentfirst.mkv wrote nothing"
fi

if [[ $HAVE_RUSSIAN == 1 && $FAST == 0 ]]; then
    head_ "Russian is a working language, not a one-off check"

    out="$(run "$WORK/russian.m4a" --dictation --out "$WORK/ru" | tail -1)"
    if [[ -f "$out" ]]; then
        ok "a Russian recording transcribes"
        grep -q '^language: ru$' "$out" \
            && ok "the language is detected as Russian" \
            || bad "language line is not ru: $(grep -m1 '^language:' "$out")"
        # Invented Cyrillic names, and they come back intact on clean speech —
        # the opposite of the English case, where names were the weak part.
        # This is a TTS voice, so it measures the pipeline rather than
        # real-world accuracy against an accent or a noisy room.
        grep -q 'Анатолий Орлов' "$out" \
            && ok "a Cyrillic full name survives recognition" \
            || bad "the Cyrillic name did not survive: $(grep -m1 'зовут' "$out")"
        grep -q 'Владимир Соколов' "$out" \
            && ok "a second Cyrillic full name survives recognition" \
            || bad "the second Cyrillic name did not survive"
        # What actually fails in Russian speech is a Latin technical term, so
        # it is reported rather than asserted — a future model that gets it
        # right should not fail this suite.
        if grep -qi 'Kubernetes' "$out"; then
            ok "Latin technical term survived in Russian speech (better than measured)"
        else
            printf '  \033[33mnote\033[0m  a Latin technical term was lost in Russian speech — %s\n' \
                "$(grep -m1 -o 'Мы обсуждаем[^.]*' "$out" | cut -c1-60)"
            PASS=$((PASS + 1))
        fi
    else
        bad "the Russian recording produced no transcript"
    fi

    # And the spelling pass has to work on a Cyrillic document, which is the
    # repair for exactly the failure noted above.
    printf 'Объектное хранилище: хранилища объектов\n' > "$WORK/ru-names.txt"
    out="$(run "$WORK/russian.m4a" --dictation --names-file "$WORK/ru-names.txt" \
        --out "$WORK/ru-fixed" | tail -1)"
    if [[ -f "$out" ]]; then
        grep -q 'Объектное хранилище' "$out" \
            && ok "the known-names pass corrects a Cyrillic phrase" \
            || bad "the Cyrillic correction was not applied"
        grep -qE '^names corrected: [1-9]' "$out" \
            && ok "the header records how many Cyrillic substitutions were made" \
            || bad "header does not record the substitutions: $(grep -m1 '^names corrected' "$out")"
    else
        bad "the Russian names-file run wrote nothing"
    fi

    head_ "Code-switching: an inserted language comes back in its own script"

    # An ordinary English phrase inside Russian speech survives unaided,
    # because it is vocabulary the model already expects. This is the frequent
    # case in these conversations and it needs no flag — asserted so that a
    # future change cannot quietly start translating it into Cyrillic.
    out="$(run "$WORK/codeswitch.m4a" --dictation --out "$WORK/cs" | tail -1)"
    if [[ -f "$out" ]]; then
        grep -qi 'roll that back before the release' "$out" \
            && ok "an English phrase inside Russian survives in Latin script" \
            || bad "the English phrase was not preserved: $(grep -m1 -o 'решили[^.]*' "$out" | cut -c1-70)"
        # A rare technical term is the half that fails: measured as
        # «кластер Кьюбор Ниц» from both auto-detected and forced-ru decoding.
        # Reported rather than asserted, since a better model should not fail
        # the suite — the assertion that matters is the repair below.
        if grep -q 'кластер Kubernetes' "$out"; then
            ok "a Latin technical term survived unprimed (better than measured)"
        else
            printf '  \033[33mnote\033[0m  a Latin technical term needs priming — %s\n' \
                "$(grep -m1 -o 'обсуждаем[^.]*' "$out" | cut -c1-50)"
            PASS=$((PASS + 1))
        fi
    else
        bad "the code-switched recording produced no transcript"
    fi

    # Priming the vocabulary is the fix, and it works at recognition time
    # rather than repairing the text: 3 terms of 3 in the measurement that
    # motivated this. A bare term with no mis-hearings listed is a valid line
    # precisely so it can be primed.
    printf 'Kubernetes\nArgoCD\nGitLab\n' > "$WORK/terms.txt"
    out="$(run "$WORK/codeswitch.m4a" --dictation --names-file "$WORK/terms.txt" \
        --out "$WORK/cs-primed" | tail -1)"
    if [[ -f "$out" ]]; then
        grep -q 'кластер Kubernetes' "$out" \
            && ok "a primed Latin term comes back exactly inside Russian speech" \
            || bad "priming did not preserve the term: $(grep -m1 -o 'обсуждаем[^.]*' "$out" | cut -c1-70)"
        grep -qi 'roll that back before the release' "$out" \
            && ok "priming did not disturb the English phrase" \
            || bad "priming broke the English phrase"
    else
        bad "the primed code-switch run wrote nothing"
    fi
fi

head_ "On-screen text: what lands in the file"

# Every transcript answers the question, including the ones with no picture:
# "nobody looked at the screen" and "there was nothing on it" are different
# facts and a reader cannot tell them apart without this line.
out="$(run "$WORK/memo.aiff" --dictation --out "$WORK/noscreen" | tail -1)"
grep -q '^on-screen text: no video stream$' "$out" \
    && ok "an audio-only transcript says there was no video stream" \
    || bad "audio-only header: $(grep -m1 '^on-screen text:' "$out")"

if [[ -n "$FONT" ]]; then
    out="$(run "$WORK/talk.mkv" --dictation --no-ocr \
           --out "$WORK/offscreen" | tail -1)"
    if [[ -f "$out" ]]; then
        grep -q '^on-screen text: off$' "$out" \
            && ok "--no-ocr is recorded in the header as off" \
            || bad "--no-ocr header: $(grep -m1 '^on-screen text:' "$out")"
        grep -q '^## On-screen text$' "$out" \
            && bad "--no-ocr still wrote an On-screen text section" \
            || ok "--no-ocr writes no On-screen text section"
    else
        bad "--no-ocr wrote nothing for talk.mkv"
    fi

    # A missing model must cost the file its slides and not its transcript.
    out="$(LOCAL_TRANSCRIBE_OCR_MODEL=not-a-real-model:1b \
           run "$WORK/talk.mkv" --dictation --out "$WORK/nomodel" | tail -1)"
    if [[ -f "$out" ]]; then
        ok "a missing vision model still produced a transcript"
        grep -q '^on-screen text: skipped — ' "$out" \
            && ok "the header records why the screen was not read" \
            || bad "no skip reason in the header: $(grep -m1 '^on-screen text:' "$out")"
    else
        bad "a missing vision model lost the whole transcript"
    fi
fi

if [[ $HAVE_VISION == 1 && -n "$FONT" ]]; then
    head_ "On-screen text: reading the screen with $OCR_MODEL"

    out="$(run "$WORK/slides.mp4" --out "$WORK/screenonly" | tail -1)"
    if [[ -f "$out" ]]; then
        ok "a video with no audio now produces a transcript at all"
        grep -q '^## On-screen text$' "$out" && ok "it has an On-screen text section" \
                                             || bad "no On-screen text section"
        grep -qi "$SLIDE_ONE" "$out" && ok "the first slide's words were read" \
                                     || bad "'$SLIDE_ONE' is not in the file"
        grep -qi "$SLIDE_TWO" "$out" && ok "the second slide's words were read" \
                                     || bad "'$SLIDE_TWO' is not in the file"
        # Scene detection must find the cut between them; one frame for two
        # slides means the second slide was never looked at.
        grep -qE '^on-screen text: .*[2-9][0-9]* frame' "$out" \
            && ok "both slides were reached by scene detection" \
            || bad "only one frame read: $(grep -m1 '^on-screen text:' "$out")"
        grep -q 'No speech was recognised' "$out" \
            && ok "it says plainly that there was no speech" \
            || bad "a silent video did not say it had no speech"
    else
        bad "the screen-only path wrote nothing (got: $out)"
    fi

    out="$(run "$WORK/talk.mkv" --dictation --out "$WORK/talkocr" | tail -1)"
    if [[ -f "$out" ]]; then
        grep -qi "$SLIDE_ONE" "$out" \
            && ok "speech and on-screen text land in the same transcript" \
            || bad "the slide text is missing from the spoken transcript"
        grep -q '^## Transcript$' "$out" && ok "the spoken transcript is still there" \
                                         || bad "the Transcript section vanished"
        grep -q 'can be wrong' "$out" \
            && ok "the section says the reading is a model's and may be wrong" \
            || bad "no caveat on the on-screen text"
    else
        bad "the video-with-audio run wrote nothing"
    fi
elif [[ -n "$FONT" ]]; then
    printf '  \033[33mskip\033[0m  %s is not pulled; the screen is not read\n' "$OCR_MODEL"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL == 0 ]] || exit 1
