/**
 * The "served below requested" notice of an Antigravity subagent (2.3.19, mode `on` only).
 *
 * `Model: "pro"` is served on Gemini 4 Hydrogen at xhigh, a flash-class model (src/core/served-model.ts), so an agent that asked
 * for `pro` believing it was a pro-class model must be told once what it got. When the PostToolUse record of an `invoke_subagent`
 * call (or a late backfill of it) finds the SERVED model, and its tier is below the tier the call's `Model` named, this module
 * queues one short line for the conversation. The line reaches the user through the pre-invocation hook, the one Antigravity
 * channel that injects a step the user sees (`systemMessage` with `metadata.user_markdown`); the PostToolUse output of Antigravity
 * is documented as `{}` only, so nothing is printed there.
 *
 * Rules:
 * - Mode `on` only (`modeBehaviour(mode).routingAdvice`): `off` writes nothing, `on-demand` keeps the `subagent_served` telemetry
 *   rows it always had and nothing else.
 * - At most once per conversation per (requested, served) pair: the pairs already queued are remembered in the conversation's own file,
 *   so a second `pro` call served on the same model adds nothing.
 * - Best effort: any failure (a lock timeout, an unreadable file) skips the notice and never blocks a call.
 *
 * The state is one 0600 file per conversation, `<session>.served-notice.json`, `{ shown: string[], pending: string[] }`, under a
 * directory lock. It holds the model names and the notice lines, never a prompt.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withDirLockOrSkip } from '../src/core/dir-lock.js';
import type { JevMode } from '../src/core/config.js';
import { modeBehaviour } from '../src/core/mode-policy.js';
import { privateDir, privateFile, PRIVATE_FILE_MODE } from '../src/core/private-fs.js';
import { servedBelowNotice, servedBelowRequested } from '../src/core/served-model.js';
import { safeSessionId } from '../src/shared.js';

type NoticeState = { shown: string[]; pending: string[] };

const LOCK_WAIT_MS = 250;
/** Bounds: a conversation never remembers or holds more than this. */
const MAX_SHOWN = 64;
const MAX_PENDING = 8;

function noticeFile(sessionsDir: string, sessionId: string | null | undefined): string | null {
  const safe = safeSessionId(sessionId);
  return safe ? path.join(sessionsDir, `${safe}.served-notice.json`) : null;
}

const lockOf = (file: string): string => file.replace(/\.json$/, '.lock');

function readState(file: string): NoticeState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<NoticeState> | null;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
    return { shown: strings(raw?.shown), pending: strings(raw?.pending) };
  } catch {
    return { shown: [], pending: [] };
  }
}

function writeState(file: string, state: NoticeState): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: PRIVATE_FILE_MODE });
  privateFile(tmp);
  fs.renameSync(tmp, file);
  privateFile(file);
}

/**
 * Queue the notice for one served subagent when its served model is of a lower tier than the `Model` it asked for, once per
 * (requested, served) pair for the conversation. Returns the queued line, or null when nothing was queued (mode other than `on`,
 * not below, already shown, no conversation, or a failure). Never throws.
 */
export function queueServedNotice(
  sessionsDir: string,
  sessionId: string | null | undefined,
  requested: unknown,
  servedModel: unknown,
  mode: JevMode | string | null | undefined
): string | null {
  try {
    if (!modeBehaviour(mode).routingAdvice) return null;
    const below = servedBelowRequested(requested, servedModel);
    if (!below) return null;
    const file = noticeFile(sessionsDir, sessionId);
    if (!file) return null;
    privateDir(sessionsDir);
    const pair = `${below.requested}>${below.servedModel.toLowerCase()}`;
    const line = servedBelowNotice(below);
    const queued = withDirLockOrSkip(
      lockOf(file),
      () => {
        const state = readState(file);
        if (state.shown.includes(pair)) return null;
        state.shown = [...state.shown, pair].slice(-MAX_SHOWN);
        state.pending = [...state.pending, line].slice(-MAX_PENDING);
        writeState(file, state);
        return line;
      },
      () => {
        // a lock timeout skips the notice (fail open)
      },
      { waitMs: LOCK_WAIT_MS }
    );
    return queued ?? null;
  } catch {
    return null;
  }
}

/** The queued lines of a conversation, which are then cleared (each is delivered once). Empty when there are none or on a failure. Never throws. */
export function takeServedNotices(sessionsDir: string, sessionId: string | null | undefined, mode: JevMode | string | null | undefined): string[] {
  try {
    if (!modeBehaviour(mode).routingAdvice) return [];
    const file = noticeFile(sessionsDir, sessionId);
    if (!file || !fs.existsSync(file)) return [];
    const taken = withDirLockOrSkip(
      lockOf(file),
      () => {
        const state = readState(file);
        if (state.pending.length === 0) return [] as string[];
        const lines = state.pending;
        writeState(file, { shown: state.shown, pending: [] });
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

/** The pre-invocation injection steps that show the user the queued lines: one `systemMessage` step per line (the model sees it too). */
export function servedNoticeSteps(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.map((line) => ({ systemMessage: { systemMessage: line, metadata: { user_markdown: line } } }));
}
