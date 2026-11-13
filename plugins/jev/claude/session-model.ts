/**
 * The session model, learned from the transcript when SessionStart / PostModelSwitch never told the hook.
 *
 * Claude Code runs SessionStart once per session; a session whose plugins were reloaded mid-session (`/reload-plugins`),
 * that was resumed, or that runs headless (`claude -p`) can reach PreToolUse with no stored session model, and then every
 * guard (elevation, downgrade) has nothing to compare against and does nothing. The hook's stdin always carries
 * `transcript_path`; each assistant line of that JSONL has `message.model`. This module reads the tail of it, never more
 * than 256 KB, and persists what it found next to the SessionStart file, marked `source: "transcript"` so it can be
 * re-checked (SessionStart / PostModelSwitch files have no `source` and stay authoritative).
 *
 * Everything here is fail-open: any problem means null, exactly as a missing session model behaved before. No transcript
 * content is ever returned except a model id that ranks as a Claude model, and none is logged or stored.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PRIVATE_FILE_MODE, privateDir, privateFile } from '../src/shared.js';
import { modelRank } from './logic.js';

/** The most of a transcript that is ever read: its last 256 KB. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** A model learned from the transcript is checked against it again after this long. */
export const TRANSCRIPT_RECHECK_MS = 60_000;

/** What a transcript line may carry as its model: a Claude id (`claude-sonnet-5-5`), never `<synthetic>` or another provider's. */
const CLAUDE_MODEL_ID = /^claude-[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Read up to the last `bytes` bytes of `file` as text, or null. A reader is injectable so a test can count and bound the reads. */
export type TailReader = (file: string, bytes: number) => string | null;

/** Positioned read of the file's last `bytes` bytes (fs.openSync + fs.readSync); never the whole file. Null for anything that is not a regular file. */
export const readTranscriptTail: TailReader = (file, bytes) => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return null;
    const length = Math.min(stat.size, bytes);
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = fs.readSync(fd, buf, done, length - done, stat.size - length + done);
      if (n <= 0) break;
      done += n;
    }
    let text = buf.subarray(0, done).toString('utf8');
    // The tail may start in the middle of a line (or of a multi-byte character): drop that partial first line.
    if (stat.size > length) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
};

/**
 * Whether `file` is a transcript Jev may read: a `.jsonl` path whose real location is under `<home>/.claude/projects`.
 * The hook's stdin is data, not trusted: this keeps a hostile `transcript_path` from making the hook read any other file.
 */
export function isTranscriptPath(file: unknown, home: string = os.homedir()): boolean {
  if (typeof file !== 'string' || !file || file.includes('\0') || !file.endsWith('.jsonl')) return false;
  try {
    const root = fs.realpathSync(path.join(home, '.claude', 'projects'));
    const real = fs.realpathSync(path.resolve(file));
    return real.endsWith('.jsonl') && real.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

/** A model id from a transcript line that Jev can rank: a Claude id of a known family. */
function usableModel(model: unknown): string | null {
  return typeof model === 'string' && CLAUDE_MODEL_ID.test(model) && modelRank(model) !== null ? model : null;
}

/**
 * The model of the last assistant line in the tail of the transcript at `file`, or null. Skips `<synthetic>` and any id
 * that is not a rankable Claude id (the walk goes on to the next assistant line), skips sidechain lines, tolerates a partial
 * first line, an empty or missing file and binary garbage. Pure apart from the read; never throws.
 */
export function modelFromTranscript(file: string, opts: { readTail?: TailReader; home?: string } = {}): string | null {
  try {
    if (!isTranscriptPath(file, opts.home)) return null;
    const text = (opts.readTail ?? readTranscriptTail)(file, TRANSCRIPT_TAIL_BYTES);
    if (!text) return null;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || entry.type !== 'assistant' || entry.isSidechain === true) continue;
      const model = usableModel(entry.message?.model);
      if (model) return model;
    }
    return null;
  } catch {
    return null;
  }
}

/** The per-session file `<session_id>.json`: the stored model, who wrote it and, for a transcript-learned one, when it was last checked. */
export type SessionRecord = { model: string; updated_at?: string; source?: string; checked_at?: string };

export function sessionFile(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.json`);
}

/** The stored record, or null for a missing, unreadable or model-less file. */
export function readSessionRecord(dir: string, sessionId: string): SessionRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(dir, sessionId), 'utf8'));
    return raw && typeof raw.model === 'string' && raw.model ? (raw as SessionRecord) : null;
  } catch {
    return null;
  }
}

/** Write the record atomically (temp file in the same directory, then rename), owner-only. Throws when it cannot. */
export function writeSessionRecord(dir: string, sessionId: string, record: SessionRecord): void {
  privateDir(dir);
  const file = sessionFile(dir, sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: PRIVATE_FILE_MODE });
  privateFile(tmp);
  fs.renameSync(tmp, file);
  privateFile(file);
}

/** What the learner reports: the model and that it came from the transcript. Null means "nothing to add, use what is stored". */
export type LearnedModel = { model: string; source: 'transcript' };
export type SessionModelLearner = (sessionId: string, transcriptPath: string) => LearnedModel | null;

export type LearnerOptions = {
  /** The claude-sessions directory the records live in. */
  dir: string;
  /** Whose `.claude/projects` a transcript must be under; default the user's home. */
  home?: string;
  readTail?: TailReader;
  now?: () => number;
};

/**
 * The fallback the hook calls on PreToolUse and UserPromptSubmit:
 * - a record written by SessionStart / PostModelSwitch (no `source`) is authoritative: null, the transcript is not read;
 * - no record: learn from the transcript and persist it with `source: "transcript"`;
 * - a transcript-learned record is re-checked at most every 60 seconds and updated when the last assistant model differs.
 * Never throws: a failing read or write means null (or the stored model for a failed re-check).
 */
export function createSessionModelLearner(opts: LearnerOptions): SessionModelLearner {
  const now = opts.now ?? Date.now;
  const read = (file: string): string | null => modelFromTranscript(file, { readTail: opts.readTail, home: opts.home });
  return (sessionId, transcriptPath) => {
    try {
      const nowMs = now();
      const nowIso = new Date(nowMs).toISOString();
      const rec = readSessionRecord(opts.dir, sessionId);
      if (rec && rec.source !== 'transcript') return null;
      if (rec) {
        const checked = Date.parse(rec.checked_at ?? rec.updated_at ?? '');
        if (Number.isFinite(checked) && nowMs - checked >= 0 && nowMs - checked < TRANSCRIPT_RECHECK_MS) return { model: rec.model, source: 'transcript' };
      }
      const model = read(transcriptPath);
      if (!model && !rec) return null;
      const next: SessionRecord = {
        model: model ?? rec!.model,
        updated_at: rec && (!model || model === rec.model) ? (rec.updated_at ?? nowIso) : nowIso,
        source: 'transcript',
        checked_at: nowIso
      };
      // SessionStart or PostModelSwitch may have written an authoritative record while the transcript was read: it wins.
      const current = readSessionRecord(opts.dir, sessionId);
      if (current && current.source !== 'transcript') return null;
      try {
        writeSessionRecord(opts.dir, sessionId, next);
      } catch {
        // an unwritable store only costs a re-read on the next call; this call still knows the model
      }
      return { model: next.model, source: 'transcript' };
    } catch {
      return null;
    }
  };
}
