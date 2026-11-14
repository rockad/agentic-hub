/**
 * Read one small text file the hook was pointed at (a workflow script, an agent definition, a settings file) without
 * ever blocking. The path can come from tool input, so it can name a FIFO: opening one blocks until a writer appears,
 * and a hook that blocks past its timeout lets the call through unchecked. Same protection as the transcript reader in
 * session-model.ts: stat first and require a regular file, open with O_NONBLOCK as a second line of defence, fstat the
 * descriptor again (the path may have changed between the two), and read at most `maxBytes` + 1 bytes.
 */
import * as fs from 'node:fs';

export type RegularRead =
  | { kind: 'ok'; text: string; size: number }
  | { kind: 'not-regular' }
  | { kind: 'too-large'; size: number }
  | { kind: 'error'; message: string };

export function readRegularFile(file: string, maxBytes: number): RegularRead {
  let fd: number | null = null;
  try {
    if (!fs.statSync(file).isFile()) return { kind: 'not-regular' };
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: 'not-regular' };
    if (stat.size > maxBytes) return { kind: 'too-large', size: stat.size };
    const buf = Buffer.alloc(stat.size + 1);
    let done = 0;
    while (done < buf.length) {
      const n = fs.readSync(fd, buf, done, buf.length - done, done);
      if (n <= 0) break;
      done += n;
    }
    if (done > stat.size) return { kind: 'error', message: 'the file grew while it was read' };
    return { kind: 'ok', text: buf.subarray(0, done).toString('utf8'), size: done };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}
