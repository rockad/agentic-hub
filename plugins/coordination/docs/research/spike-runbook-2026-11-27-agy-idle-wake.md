# Spike runbook AW0: does a finished background command wake an idle agy session? (2026-11-27)

Gate for streams AW1 to AW4 of the agy idle wake design (master-plan 4.2a, decision Z23, tasklist 3.9). **The user runs both sessions.** Nothing here may start, drive or wrap agy from outside (DDR-003): each agy session starts its own background process, and the sender uses the normal `a2a_send` tool.

Labels for the results: **verified** (observed by you), **reported**, **unverified**.

## 0. Setup

- The coordination server is up on this machine: `curl -s http://127.0.0.1:8120/healthz` answers 200 (or use `A2A_SERVER_URL` from `~/.config/a2a-coord/settings`).
- The agy plugin is installed and the key file exists: `~/.config/a2a-coord/keys/antigravity.key` (the same file the agy hooks read; `~/.gemini/config/mcp_config.json` is the fallback).
- Open two agy sessions in a trusted workspace so the hooks load. Call them **A** (listener) and **B** (sender).
- In both, confirm the SessionStart line appears and run `a2a_hello` with the handle it prints. Write both handles down.
- `a2a_peers` in B must list A's handle.

## 1. The spike listener (session A writes it, then starts it)

Ask session A: "Write this file to /tmp/a2a-wake-spike.sh, make it executable, and run it with run_command as a BACKGROUND command. Do not set NotificationTimeoutSeconds. Then end your turn." The script prints its one wake line on stdout and exits 0 on a `200`, which is the event under test.

```sh
#!/bin/sh
# AW0 spike listener. Not the production script. Prints no key.
CFG=${XDG_CONFIG_HOME:-$HOME/.config}/a2a-coord
URL=${A2A_SERVER_URL:-http://127.0.0.1:8120}
KF=${A2A_AGY_KEY_FILE:-$CFG/keys/antigravity.key}
[ -r "$KF" ] || KF=$HOME/.gemini/config/mcp_config.json
key=$(head -c 65536 "$KF" | tr '\n' ' ' | grep -o 'a2ak_[A-Za-z0-9_-]*' | head -n 1)
SESSION=${ANTIGRAVITY_CONVERSATION_ID:?no ANTIGRAVITY_CONVERSATION_ID in this shell}
LOG=/tmp/a2a-wake-spike.log
echo "$(date +%T) start pid=$$ ppid=$PPID parent=$(ps -o comm= -p "$PPID") session=$SESSION url=$URL" >> "$LOG"
( while kill -0 $$ 2>/dev/null; do sleep 60; echo "$(date +%T) alive pid=$$ ppid=$(ps -o ppid= -p $$ | tr -d ' ')" >> "$LOG"; done ) &
hb=$!
trap 'kill $hb 2>/dev/null' EXIT
while :; do
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$key" |
    curl -q -K - -s -o /tmp/a2a-wake-spike.body -w '%{http_code}' --noproxy '*' --proto '=http,https' \
      -X POST -H "X-Coord-Session: $SESSION" -H 'X-Coord-Wait: 300' --max-time 330 "$URL/wake/listen")
  echo "$(date +%T) listen -> $code" >> "$LOG"
  case $code in
    200)
      n=$(tr -cd '0-9' < /tmp/a2a-wake-spike.body | head -c 4)
      echo "[a2a] ${n:-?} pending. Call a2a_inbox. Then re-arm the listener."
      exit 0 ;;
    408) ;;
    *) echo "[a2a] spike listener stopped: HTTP $code"; exit 1 ;;
  esac
done
```

Notes:
- If the terminal sandbox refuses the connection to `127.0.0.1:8120` and asks for approval, that is check C4; approve it once and record it.
- A `409` (superseded) or `410` (session not registered) ends the script with the line above; re-run `a2a_hello` in A and start it again.

## 2. Checks

Each check gets a PASS / FAIL / UNVERIFIED line and one sentence of evidence in the results file. Times come from the log at `/tmp/a2a-wake-spike.log` and the agy transcript.

| # | Check | How | Pass means |
| --- | --- | --- | --- |
| C1 | Idle wake on background completion | A starts the script, then the turn ends and A is idle (no tool running). In B run `a2a_send` to A's handle with any short task. Wait up to 2 minutes without touching A | A starts a new turn on its own, the first text it sees is the `[a2a] N pending...` line. Record the delay between the send and A's new turn |
| C2 | Survives turns | Start the script again, then in A type 3 ordinary prompts (each one a model turn). Then send from B | The log still shows `alive` lines and the send wakes A |
| C3 | Parent pid | Compare `ppid=` in the `start` line and in later `alive` lines. Run `ps -o pid,ppid,comm -p <ppid>` in A | The ppid is the same on every line and names a long-lived process (not a short-lived shell that is gone after the command returns). Record the process name |
| C4 | Sandbox | Note whether starting the script asked for approval or a curl was refused | Record yes or no. It decides whether the production skill must say "run outside the sandbox" |
| C5 | Long idle | Start the script, leave A idle for at least 30 minutes (use `agy remote-control` for A if you normally do), then send from B | A still wakes. If it does not, record whether the process is still alive in `ps` and what the log says |
| C6 | Inbox after wake | When A wakes in C1, watch what it does | A calls `a2a_inbox` and handles the task as untrusted data |
| C7 | Cron backstop | In A run: `schedule` one-shot `DurationSeconds: 60` with Prompt "[a2a] heartbeat test: say pong". End the turn | A starts a new turn about 60 seconds later and answers |
| C8 | Cron survives resume | Close A's CLI, resume the same conversation, wait 3 minutes | Record whether the earlier schedule or listener is still active (expected: neither, so re-arm is needed) |

Clean up after the test: kill any leftover `/tmp/a2a-wake-spike.sh` process, remove `/tmp/a2a-wake-spike.*`, and cancel any schedule left in A (`manage_task`).

## 3. Decision rule

- C1 and C5 pass: the design stands as written (AW1 to AW4 proceed).
- C1 passes and C5 fails: conversations stop reacting while idle for long. Re-plan: the cron backstop becomes the main path and the interval and cost need a new decision.
- C1 fails: the harness does not resume on background completion. Re-plan cron-only.
- C3 shows an unstable ppid: drop the parent-pid watch from decision 5, keep the 12 h age cap.
- C4 yes: add a sandbox note to the `a2a-wake` skill.
- C7 fails: the cron backstop is not workable. Re-plan around the listener alone.

## 4. Results template

Copy to `docs/research/spike-results-2026-11-2x-agy-idle-wake.md`:

```markdown
# Spike results AW0: agy idle wake (date)

Run by: <user>. agy version: <agy --version>. Server: <url>. Sessions: A <handle>, B <handle>.

| # | Result | Evidence |
| --- | --- | --- |
| C1 | PASS / FAIL | delay <s>, first text seen: ... |
| C2 | | |
| C3 | | ppid <n> = <process> |
| C4 | | |
| C5 | | idle <min>, remote-control yes/no |
| C6 | | |
| C7 | | |
| C8 | | |

Verdict (per section 3): ...
Log excerpt (no keys): ...
```
