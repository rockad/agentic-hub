import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Test isolation (#76 review R3): under plain `bun test`, Bun.spawn / Bun.spawnSync without an explicit `env` give the
 * child the environment the process STARTED with, not the modified `process.env`, so the preload's temporary HOME and
 * the scrubbed credentials never reach it. A spawned Jev process (bun hook / runner) would then read the real
 * ~/.config/zsh/secrets.env and ~/.config/jev/env. Every spawn of a bun process in the tests therefore passes `env`.
 */
const TESTS = import.meta.dir;

/** The text of the call starting at the `(` at `open`, up to its matching `)` (strings and template literals skipped). */
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

describe('test isolation: spawned bun processes get an explicit env (R3)', () => {
  it('a Bun.spawn / Bun.spawnSync of bun or process.execPath always passes env', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(TESTS).filter((f) => f.endsWith('.ts') && f !== 'spawn-env.test.ts')) {
      const src = fs.readFileSync(path.join(TESTS, file), 'utf8');
      const re = /\bBun\.spawn(?:Sync)?\(/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const call = callText(src, m.index + m[0].length - 1);
        if (!/^\(\s*\[\s*(?:['"`]bun['"`]|process\.execPath)/.test(call)) continue;
        if (!/\benv\b/.test(call)) offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a child spawned with the process env sees the temporary HOME, not the real one', () => {
    const proc = Bun.spawnSync(['sh', '-c', 'printf %s "$HOME"'], { env: { ...process.env } });
    expect(proc.stdout.toString()).toBe(process.env.HOME as string);
  });
});
