/**
 * The session model, learned from the transcript when SessionStart / PostModelSwitch never told the hook.
 *
 * Claude Code runs SessionStart once per session; a session whose plugins were reloaded mid-session (`/reload-plugins`),
 * that was resumed, or that runs headless (`claude -p`) can reach PreToolUse with no stored session model, and then every
 * guard (elevation, downgrade) has nothing to compare against and does nothing. The hook's stdin always carries
 * `transcript_path`; each assistant line of that JSONL has `message.model`. This module reads the end of it in 256 KB
 * chunks, going back until it finds an assistant line or has read 2 MB, and persists what it found next to the
 * SessionStart file, marked `source: "transcript"` so it can be re-checked (SessionStart / PostModelSwitch files have no
 * `source` and stay authoritative).
 *
 * Everything here is fail-open: any problem means null, exactly as a missing session model behaved before. No transcript
 * content is ever returned except a model id that ranks as a Claude model, and none is logged or stored.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PRIVATE_FILE_MODE, privateDir, privateFile } from '../src/shared.js';
import { modelRank, safeSessionId } from './logic.js';

/** One read of the transcript: 256 KB. It is also the longest line that is ever parsed (a longer line is skipped). */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** The most of a transcript that is ever read in all: its last 2 MB. */
export const TRANSCRIPT_SCAN_CAP_BYTES = 2 * 1024 * 1024;
/** Without a usable stat of the transcript, a model learned from it is checked against it again after this long. */
export const TRANSCRIPT_RECHECK_MS = 60_000;

/** What a transcript line may carry as its model: a Claude id (`claude-sonnet-5-5`), never `<synthetic>` or another provider's. */
const CLAUDE_MODEL_ID = /^claude-[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Read one chunk of `file`: the `bytes` bytes that end `skip` bytes before the end of the file (clamped at the start of
 * the file), raw, so it may begin or end in the middle of a line. A chunk shorter than `bytes` reaches the start of the
 * file; an empty one means `skip` is at or beyond it; null means the file cannot be read. A reader is injectable so a
 * test can count and bound the reads.
 */
export type TailReader = (file: string, bytes: number, skip: number) => Buffer | string | null;

/**
 * Positioned read of one chunk (fs.openSync + fs.readSync); never the whole file. Null for anything that is not a regular
 * file. The file is stat-ed BEFORE it is opened: opening a FIFO named like a transcript blocks until a writer appears, and
 * the open also asks for O_NONBLOCK as a second line of defence.
 */
export const readTranscriptChunk: TailReader = (file, bytes, skip) => {
  let fd: number | null = null;
  try {
    if (!fs.statSync(file).isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const end = stat.size - skip;
    if (end <= 0) return Buffer.alloc(0);
    const start = Math.max(0, end - bytes);
    const length = end - start;
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = fs.readSync(fd, buf, done, length - done, start + done);
      if (n <= 0) break;
      done += n;
    }
    return buf.subarray(0, done);
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

/** The model of the last usable assistant line among the complete lines of `block` (newest first), or null. */
function modelFromLines(block: Buffer): string | null {
  let end = block.length;
  while (end >= 0) {
    const nl = end > 0 ? block.lastIndexOf(0x0a, end - 1) : -1;
    const line = block.subarray(nl + 1, end);
    end = nl;
    // A line longer than one chunk is never parsed (an assistant line that large, a huge Write input, reads as no line).
    if (line.length > 0 && line.length <= TRANSCRIPT_TAIL_BYTES) {
      const text = line.toString('utf8').trim();
      if (text.startsWith('{')) {
        try {
          const entry = JSON.parse(text);
          if (entry && entry.type === 'assistant' && entry.isSidechain !== true) {
            const model = usableModel(entry.message?.model);
            if (model) return model;
          }
        } catch {
          // not a JSON line: skip it
        }
      }
    }
    if (nl < 0) break;
  }
  return null;
}

/**
 * The model of the last assistant line near the end of the transcript at `file`, or null. Scans backwards in 256 KB chunks
 * until it finds one or has read 2 MB (a pasted image or a large tool_result at the end is common, so the first chunk may
 * hold no complete assistant line); a line that crosses a chunk boundary is joined from its two halves, and a line longer
 * than 256 KB is never parsed. Skips `<synthetic>` and any id that is not a rankable Claude id (the walk goes on to the
 * next assistant line), skips sidechain lines, tolerates a partial first line, an empty or missing file and binary garbage.
 * A file that grows during the scan can garble the one line at a chunk boundary, which then fails to parse and is skipped.
 * Pure apart from the reads; never throws.
 */
export function modelFromTranscript(file: string, opts: { readTail?: TailReader; home?: string } = {}): string | null {
  try {
    if (!isTranscriptPath(file, opts.home)) return null;
    const read = opts.readTail ?? readTranscriptChunk;
    // The start of the previously read (later) chunk up to its first newline: the end of a line that begins in the next chunk.
    let carry: Buffer = Buffer.alloc(0);
    for (let skip = 0; skip < TRANSCRIPT_SCAN_CAP_BYTES; skip += TRANSCRIPT_TAIL_BYTES) {
      const raw = read(file, TRANSCRIPT_TAIL_BYTES, skip);
      if (raw === null || raw === undefined) return null;
      const chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
      // The file ended exactly on the previous chunk's start: what was carried is a whole line.
      if (chunk.length === 0) return modelFromLines(carry);
      const atStart = chunk.length < TRANSCRIPT_TAIL_BYTES;
      const data = Buffer.concat([chunk, carry]);
      if (atStart) return modelFromLines(data);
      // The chunk may start in the middle of a line: that first piece waits for the next, earlier chunk.
      const nl = data.indexOf(0x0a);
      if (nl < 0) {
        carry = data.length > TRANSCRIPT_TAIL_BYTES ? Buffer.alloc(0) : data;
        continue;
      }
      carry = data.subarray(0, nl);
      if (carry.length > TRANSCRIPT_TAIL_BYTES) carry = Buffer.alloc(0);
      const model = modelFromLines(data.subarray(nl + 1));
      if (model) return model;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The per-session file `<session_id>.json`: the stored model, who wrote it, for a transcript-learned one when it was last
 * checked and the size and mtime of the transcript when it was read (a change in either means the model may have changed).
 */
export type SessionRecord = { model: string; updated_at?: string; source?: string; checked_at?: string; size?: number; mtime_ms?: number };

/**
 * The path of a session's file. The id is a file name: only what the hook's safeSessionId would keep unchanged
 * ([A-Za-z0-9_-]+) is accepted, so `../../evil` can neither read nor write outside the directory. Throws otherwise.
 */
export function sessionFile(dir: string, sessionId: string): string {
  if (typeof sessionId !== 'string' || safeSessionId(sessionId) !== sessionId) throw new Error('invalid session id');
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

/** Makes each temp file name unique within the process, so two writes in flight never share one. */
let tmpSeq = 0;

/** Write the record atomically (temp file in the same directory, then rename), owner-only. Throws when it cannot. */
export function writeSessionRecord(dir: string, sessionId: string, record: SessionRecord, beforeRename?: () => void): void {
  const file = sessionFile(dir, sessionId);
  privateDir(dir);
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: PRIVATE_FILE_MODE });
  privateFile(tmp);
  beforeRename?.();
  fs.renameSync(tmp, file);
  privateFile(file);
}

/**
 * Write a transcript-learned record without losing an authoritative one. SessionStart / PostModelSwitch may write their
 * record (no `source`) between the learner's last look and its rename, and the rename would then replace it. So the
 * file is hard-linked aside just before the rename and read after it: if what the rename replaced was authoritative and the
 * file still holds ours, the authoritative record goes back. Returns false when it had to restore one (the caller reports
 * "nothing to add"). `beforeRename` is the injection point for a test that plays SessionStart in that window.
 */
function writeTranscriptRecord(dir: string, sessionId: string, record: SessionRecord, beforeRename?: () => void): boolean {
  const file = sessionFile(dir, sessionId);
  const backup = `${file}.${process.pid}.bak`;
  let linked = false;
  try {
    writeSessionRecord(dir, sessionId, record, () => {
      beforeRename?.();
      try {
        fs.linkSync(file, backup);
        linked = true;
      } catch {
        // no file to replace
      }
    });
    if (!linked) return true;
    let prior: SessionRecord | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(backup, 'utf8'));
      prior = raw && typeof raw.model === 'string' && raw.model ? (raw as SessionRecord) : null;
    } catch {
      prior = null;
    }
    if (prior && prior.source !== 'transcript' && readSessionRecord(dir, sessionId)?.source === 'transcript') {
      writeSessionRecord(dir, sessionId, prior);
      return false;
    }
    return true;
  } finally {
    if (linked) {
      try {
        fs.unlinkSync(backup);
      } catch {
        // nothing to do
      }
    }
  }
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
  /** Test hook: runs after the record is prepared and before it replaces the file, where SessionStart could land. */
  beforeWrite?: () => void;
};

/** The transcript's size and mtime, from one stat; null when it is not a readable transcript path (then there is nothing to compare). */
function statTranscript(file: string, home?: string): { size: number; mtime_ms: number } | null {
  try {
    if (!isTranscriptPath(file, home)) return null;
    const st = fs.statSync(file);
    return st.isFile() ? { size: st.size, mtime_ms: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * The fallback the hook calls on PreToolUse and UserPromptSubmit:
 * - a record written by SessionStart / PostModelSwitch (no `source`) is authoritative: null, the transcript is not read;
 * - no record: learn from the transcript and persist it with `source: "transcript"`, with the transcript's size and mtime_ms;
 * - a transcript-learned record is re-read when the transcript's size or mtime_ms differs from the stored values (one stat
 *   per call), so a model switch is seen on the next call, and not at all while the file is unchanged. Only when the
 *   transcript cannot be stat-ed does the old rule apply: re-check at most every 60 seconds.
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
      // Stat before reading: bytes appended during the read make the next call's stat differ, so they are never missed.
      const st = statTranscript(transcriptPath, opts.home);
      if (rec) {
        if (st) {
          if (rec.size === st.size && rec.mtime_ms === st.mtime_ms) return { model: rec.model, source: 'transcript' };
        } else {
          const checked = Date.parse(rec.checked_at ?? rec.updated_at ?? '');
          if (Number.isFinite(checked) && nowMs - checked >= 0 && nowMs - checked < TRANSCRIPT_RECHECK_MS) return { model: rec.model, source: 'transcript' };
        }
      }
      const model = read(transcriptPath);
      if (!model && !rec) return null;
      const next: SessionRecord = {
        model: model ?? rec!.model,
        updated_at: rec && (!model || model === rec.model) ? (rec.updated_at ?? nowIso) : nowIso,
        source: 'transcript',
        checked_at: nowIso,
        ...(st ?? {})
      };
      // SessionStart or PostModelSwitch may have written an authoritative record while the transcript was read: it wins.
      const current = readSessionRecord(opts.dir, sessionId);
      if (current && current.source !== 'transcript') return null;
      try {
        // ...and one that lands between that look and the rename is put back by the write itself.
        if (!writeTranscriptRecord(opts.dir, sessionId, next, opts.beforeWrite)) return null;
      } catch {
        // an unwritable store only costs a re-read on the next call; this call still knows the model
      }
      return { model: next.model, source: 'transcript' };
    } catch {
      return null;
    }
  };
}
