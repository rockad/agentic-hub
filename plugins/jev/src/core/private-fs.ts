/**
 * Owner-only modes for what Jev writes under the user's home: state, telemetry and audit logs.
 * `mode` on mkdir or write applies only when the entry is created, so each helper also chmods an
 * entry that already exists with looser modes (older releases wrote 0755 directories and 0644 files).
 */
import * as fs from 'node:fs';

/** Mode of a directory Jev creates, and of one `privateDir` tightens: owner-only. */
export const PRIVATE_DIR_MODE = 0o700;
/** Mode of a file Jev creates, and of one `privateFile` tightens: owner-only. */
export const PRIVATE_FILE_MODE = 0o600;

/** Create `dir` (and parents) owner-only, and tighten it when it already existed with looser modes. The chmod never throws. */
export function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // best-effort: not our directory, or a filesystem without modes
  }
}

/** Tighten a state or log file to owner-only after a write. Never throws. */
export function privateFile(file: string): void {
  try {
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } catch {
    // best-effort
  }
}
