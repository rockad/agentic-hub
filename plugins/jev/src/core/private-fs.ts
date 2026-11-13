import * as fs from 'node:fs';

/**
 * Owner-only modes for what Jev creates under `~/.config/jev`.
 * Same contract as the helpers in `claude/hook.ts` (which keeps its own copies until integration).
 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Create `dir` (and parents) owner-only, and tighten it when it already existed with looser modes. Never throws. */
export function privateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch {
    // the caller's next write reports the real failure
  }
  try {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // best-effort: not our directory, or a filesystem without modes
  }
}

/** Tighten a state file to owner-only after a write: `mode` on write applies only when the file is created. Never throws. */
export function privateFile(file: string): void {
  try {
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } catch {
    // best-effort
  }
}
