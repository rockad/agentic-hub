/**
 * The one-line confirmation of an elevation answer, for the assistant (2.3.21): `[jev] Recorded: pro, once (this turn) up to high.
 * Relaunch now.` or `[jev] Not recorded: <reason>. <what to do>.` (src/core/elevation-answer.ts).
 *
 * The PostToolUse output of Antigravity is documented as `{}` only, and no other PostToolUse channel to the model is verified, so the
 * line is queued for the conversation and delivered by the next pre-invocation hook (the one Antigravity channel that injects a step
 * for the model: an `ephemeralMessage`), once, before the model's next step. That step is normally the retry of the delegation, so
 * the assistant reads what was recorded just before it relaunches. A mode without decisions queues and delivers nothing: off writes nothing, and on-demand writes no state, so its `Not recorded: ... mode` is in the `elevation_answer` row only.
 *
 * State: one 0600 file per conversation, `<session>.answer-notice.json`, `{ pending: string[] }`, under a directory lock, bounded.
 * It holds only the confirmation lines (model names, scopes, reasons), never a prompt or an answer text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withDirLockOrSkip } from '../src/core/dir-lock.js';
import type { JevMode } from '../src/core/config.js';
import { modeBehaviour } from '../src/core/mode-policy.js';
import { privateDir, privateFile, PRIVATE_FILE_MODE } from '../src/core/private-fs.js';
import { safeSessionId } from '../src/shared.js';

const LOCK_WAIT_MS = 250;
/** A conversation never holds more than this many undelivered lines. */
const MAX_PENDING = 8;

function noticeFile(sessionsDir: string, sessionId: string | null | undefined): string | null {
  const safe = safeSessionId(sessionId);
  return safe ? path.join(sessionsDir, `${safe}.answer-notice.json`) : null;
}

const lockOf = (file: string): string => file.replace(/\.json$/, '.lock');

function readPending(file: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { pending?: unknown } | null;
    return Array.isArray(raw?.pending) ? raw!.pending.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function writePending(file: string, pending: string[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pending }) + '\n', { mode: PRIVATE_FILE_MODE });
  privateFile(tmp);
  fs.renameSync(tmp, file);
  privateFile(file);
}

/** Queue one confirmation line for the conversation. True when it was queued (a mode without decisions, no conversation or a failure queue nothing). Never throws. */
export function queueAnswerNotice(sessionsDir: string, sessionId: string | null | undefined, line: string, mode: JevMode | string | null | undefined): boolean {
  try {
    // Mode `on` only: on-demand makes no decisions and writes no state (no sessions directory); its answers still write the `elevation_answer` row.
    if (!modeBehaviour(mode).decisions) return false;
    const file = noticeFile(sessionsDir, sessionId);
    if (!file) return false;
    privateDir(sessionsDir);
    const queued = withDirLockOrSkip(
      lockOf(file),
      () => {
        writePending(file, [...readPending(file), line].slice(-MAX_PENDING));
        return true;
      },
      () => {
        // a lock timeout skips the line (fail open)
      },
      { waitMs: LOCK_WAIT_MS }
    );
    return queued === true;
  } catch {
    return false;
  }
}

/** The queued lines of a conversation, which are then cleared (each is delivered once). Empty when there are none or on a failure. Never throws. */
export function takeAnswerNotices(sessionsDir: string, sessionId: string | null | undefined, mode: JevMode | string | null | undefined): string[] {
  try {
    if (!modeBehaviour(mode).decisions) return [];
    const file = noticeFile(sessionsDir, sessionId);
    if (!file || !fs.existsSync(file)) return [];
    const taken = withDirLockOrSkip(
      lockOf(file),
      () => {
        const lines = readPending(file);
        if (lines.length === 0) return [] as string[];
        writePending(file, []);
        return lines;
      },
      () => {
        // a lock timeout leaves the lines for the next hook
      },
      { waitMs: LOCK_WAIT_MS }
    );
    return taken ?? [];
  } catch {
    return [];
  }
}
