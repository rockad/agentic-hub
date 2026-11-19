import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const hooks = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'hooks.json'), 'utf8'))['jev-subagent-guard'];

describe('Antigravity hooks.json shapes', () => {
  it('PreInvocation is a FLAT list of command handlers (no matcher or nested hooks)', () => {
    expect(Array.isArray(hooks.PreInvocation)).toBe(true);
    expect(hooks.PreInvocation.length).toBeGreaterThan(0);
    for (const h of hooks.PreInvocation) {
      expect(h.type).toBe('command');
      expect(typeof h.command).toBe('string');
      expect(h.hooks).toBeUndefined();
      expect(h.matcher).toBeUndefined();
      expect(typeof h.timeout).toBe('number');
    }
    expect(hooks.PreInvocation[0].command).toBe('bun run ./antigravity/preflight.ts');
  });

  it('PreToolUse and PostToolUse keep the matcher + hooks shape', () => {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      expect(Array.isArray(hooks[event])).toBe(true);
      for (const entry of hooks[event]) {
        expect(typeof entry.matcher).toBe('string');
        expect(Array.isArray(entry.hooks)).toBe(true);
        for (const h of entry.hooks) {
          expect(h.type).toBe('command');
          expect(typeof h.command).toBe('string');
        }
      }
    }
  });
});
