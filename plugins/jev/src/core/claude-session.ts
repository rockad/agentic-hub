/**
 * The model of the Claude Code session an MCP tool call belongs to (case study 5.11).
 *
 * The MCP tools get no hook payload, but Claude Code puts `CLAUDE_CODE_SESSION_ID` in the environment of the
 * servers it starts, and the hook (claude/hook.ts, SessionStart and PostModelSwitch) keeps the session model in
 * `~/.config/jev/claude-sessions/<id>.json`. This reads that file.
 *
 * Limits, all fail-safe because the tools only advise and the PreToolUse guard enforces: the id is fixed when
 * the server starts, so a session that is cleared or resumed under a new id reads as unknown; with the hooks off
 * nothing is stored. Nothing found means `null`, and the callers report `unknown` and never clamp.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JevTier } from '../stage-rubric.js';

/** The directory the Claude hook writes the session model to. Resolved on each call so HOME can change. */
export function claudeSessionsDir(): string {
  return path.join(os.homedir(), '.config', 'jev', 'claude-sessions');
}

/** The current Claude Code session's model, or null when it cannot be established. Never throws. */
export function activeClaudeSessionModel(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const id = env.CLAUDE_CODE_SESSION_ID;
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    const raw = JSON.parse(fs.readFileSync(path.join(claudeSessionsDir(), `${id}.json`), 'utf8'));
    return typeof raw?.model === 'string' && raw.model ? raw.model : null;
  } catch {
    return null;
  }
}

/** The Jev tier a session model can run itself (haiku, sonnet, opus or fable); null when the model is unknown. */
export function claudeModelTier(model: string | null | undefined): JevTier | null {
  if (!model) return null;
  if (/haiku/i.test(model)) return 'flash_lite';
  if (/sonnet/i.test(model)) return 'flash';
  if (/opus|fable/i.test(model)) return 'pro';
  return null;
}

/** Whether a session on this model is below opus, so an opus delegation is an escalation. Unknown counts as below. */
export function sessionBelowOpus(model: string | null | undefined): boolean {
  return claudeModelTier(model) !== 'pro';
}
