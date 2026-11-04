# R4: Claude Code hooks and background-task wake, for the heartbeat plan

Author: Claude Code (macp), 2026-11-03. Research only; no hook or setting was edited. Sources: the official hooks reference (https://code.claude.com/docs/en/hooks, read via a fetch tool that returned the first 100k of about 284k characters, so later sections were not read) and what I observed in this session. Labels: **docs** (official page as returned by the fetch tool), **observed** (seen in this session), **unverified**.

## 1. Events useful for the heartbeat (docs)

- `SessionStart` (matchers: startup, resume, clear, compact, fork): session begins or resumes. Use: create the file, state `idle`.
- `UserPromptSubmit`: a prompt is submitted, and also on turns Claude starts on its own. Use: `state=working`. Default timeout 30 s for command hooks.
- `Stop`: Claude finishes responding. Use: `state=idle`. Payload includes `last_assistant_message`; exit code 2 would keep Claude working, so the hook must exit 0.
- `Notification` (matchers include `permission_prompt`, `idle_prompt`): Use: `waiting-user` when Claude asks for permission or sits idle waiting for input.
- `SessionEnd` (matchers: clear, resume, logout, prompt_input_exit, other): Use: `closing`, then remove the file. Budget: hooks share 1.5 s by default, raisable to 60 s per hook. A killed or crashed session does not run it, which is the stale-file signal the heartbeat wants.
- Also present: `PreToolUse`, `PostToolUse` (tool events), `SubagentStart/Stop`, `StopFailure` (turn ended by an API error), `TeammateIdle`, `PreModelSwitch/PostModelSwitch`.

## 2. Syntax (docs)

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "/path/to/hook.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
```

- Locations: `~/.claude/settings.json` (all projects), `.claude/settings.json`, `.claude/settings.local.json`; also plugins.
- Stdin JSON for every event: `session_id`, `prompt_id` (absent before first input), `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`; `agent_id` and `agent_type` inside subagents.
- Exit 0 is success (stdout JSON applied if it is a single object); exit 2 is a blocking error on events that can block; any other code is a non-blocking error shown as a notice in the transcript. Hooks of one event run in parallel. Hooks run without a controlling terminal. `async: true` hooks run in the background with no enforced timeout.
- Settings and hooks also run inside subagents, so a heartbeat hook can fire for subagent activity; filter on `agent_id` being absent if only the main session should write.

## 3. Mapping to the heartbeat spec states

- `SessionStart` to `idle`, `UserPromptSubmit` to `working`, `Stop` to `idle`, `Notification(permission_prompt)` to `waiting-user`, `Notification(idle_prompt)` to `idle` (or `waiting-user`), `SessionEnd` to `closing` and delete.
- `blocked` has no hook of its own; it would be set by the agent (for example by a command it runs) or left unused.
- Writing the file is a small shell command: build JSON with `jq`, write a temp file, `mv` it into place (atomic rename, as the spec requires).

## 4. Liveness: hooks do not give it (key finding)

- Hooks fire on events only. An idle session fires nothing, so a hook-only heartbeat goes stale during a long idle period even though the session is alive. Liveness needs a periodic writer.
- The only periodic mechanism I used in this session is the **Monitor tool**: a background shell loop whose stdout lines become notifications (observed: this session's bridge watchers; each Monitor has a timeout, at most 30 minutes, then expires with a notice and must be re-armed). A loop that writes `updated_at` every 30 s would work, but it dies at expiry and when the session ends (observed: after this session was restarted, four earlier monitors were reported as "didn't finish before the previous session ended" and were marked stopped, with no end marker).
- Consequence: a Monitor-based liveness writer produces gaps up to the time the model takes to re-arm after expiry, and the file goes stale at once when the session dies. Both are acceptable for a staleness rule of 3 x refresh, as long as the planner accepts that a freshly expired monitor can look briefly stale.
- A stray background process outside the session (a script started by a hook with `nohup`, or `async: true`) would survive the session and report "alive" for a dead session. The pid check in the spec (`kill -0` on a pid that belongs to the session) would need the writer's pid to be the session's, not the helper's; I did not find a documented way for a hook to learn the Claude Code process id (unverified).

## 5. Waking an idle session (observed)

- An idle Claude Code session wakes when a Monitor event arrives: this session was woken repeatedly by the bridge watcher, and the harness delivers each event as a notification message. Cross-session messages (`SendMessage`) also wake it (observed, 5b to macp).
- Limits (observed): events arrive as system notifications, not as user input; a Monitor lasts at most 30 minutes; ending the session ends the watcher.

## 6. Edits the user would have to approve (not done)

- Hook entries for `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification` and `SessionEnd` in `~/.claude/settings.json`, plus a small script under `~/.agents/` that writes the file. This is a change to the user's configuration and falls under the scope rule (bridge v2 is planning only).

## 7. Not answered

- Whether a hook can learn the Claude Code pid or a stable session label; exact `Notification` matcher semantics; the rest of the hooks page (about 184k characters unread); Antigravity's hook model (the planner reported `SessionStart`, `PreToolUse`, `PostToolUse` under `~/.gemini/config/hooks/`, unverified by me).
