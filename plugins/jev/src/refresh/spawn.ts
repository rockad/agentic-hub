import { spawn } from 'node:child_process';

export interface SpawnOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started (for example `claude` is not installed). */
  error?: string;
}

/** Runs a command to completion. Injected into the Claude Code discoverer so tests never run `claude`. */
export type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => Promise<SpawnResult>;

const MAX_OUTPUT = 1024 * 1024;

/** Real spawner: stdin from /dev/null, output captured (capped), killed after `timeoutMs`. Never rejects. */
export const defaultSpawner: Spawner = (cmd, args, opts) =>
  new Promise<SpawnResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: Omit<SpawnResult, 'stdout' | 'stderr' | 'timedOut'> & Partial<SpawnResult>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...r });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // detached: the child leads its own process group, so a timeout can kill it together with anything it started
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (err: any) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: String(err?.message ?? err) });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (typeof child.pid === 'number' && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      // Do not wait for 'close': it waits for pipes a grandchild may still hold open.
      child.stdout?.destroy();
      child.stderr?.destroy();
      done({ code: null });
    }, opts.timeoutMs);
    child.stdout?.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += String(d);
    });
    child.on('error', (err) => done({ code: null, error: String(err?.message ?? err) }));
    child.on('close', (code) => done({ code }));
  });
