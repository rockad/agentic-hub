/**
 * The Claude hook as a process: telemetry appends are flushed before exit, and everything it creates
 * under ~/.config/jev is owner-only (0700 directories, 0600 files).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { flushPendingLogs, onUserPromptSubmit, trackPendingLog, LOG_FLUSH_TIMEOUT_MS } from '../claude/hook.ts';
import { envNotice } from '../claude/logic.ts';

const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-hook-proc-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(event: string, input: object) {
  return Bun.spawnSync(['bun', HOOK, event], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_OPENROUTER_API_KEY: '' }
  });
}

const mode = (p: string): number => fs.statSync(p).mode & 0o777;
const jevDir = (): string => path.join(home, '.config', 'jev');

describe('hook exit flush', () => {
  it('has a 1 second budget', () => {
    expect(LOG_FLUSH_TIMEOUT_MS).toBe(1000);
  });

  it('returns at once when nothing is pending', async () => {
    const start = performance.now();
    await flushPendingLogs();
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('waits for a slow pending append', async () => {
    let done = false;
    trackPendingLog(new Promise((resolve) => setTimeout(() => ((done = true), resolve(null)), 150)));

    await flushPendingLogs();

    expect(done).toBe(true);
  });

  it('gives up on an append that never settles, after the budget', async () => {
    trackPendingLog(new Promise(() => {}));
    const start = performance.now();

    await flushPendingLogs(200);

    expect(performance.now() - start).toBeLessThan(600);
  });

  it('writes the telemetry line before the process exits', () => {
    const proc = run('pre-tool-use', { session_id: 's1', tool_name: 'Workflow', tool_input: {} });
    const telemetry = path.join(home, '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl');

    expect(proc.exitCode).toBe(0);
    const lines = fs.readFileSync(telemetry, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.toolOrHook === 'PreToolUse' && l.sessionId === 's1')).toBe(true);
  });
});

describe('environment notice (warn only)', () => {
  it('names a remapped alias and an effort override, never their values', () => {
    expect(envNotice({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'some-model-id', CLAUDE_CODE_EFFORT_LEVEL: 'high' })).toBe(
      'ANTHROPIC_DEFAULT_OPUS_MODEL remaps the model alias; CLAUDE_CODE_EFFORT_LEVEL overrides the advised effort'
    );
  });

  it('says nothing when none of them is set', () => {
    expect(envNotice({ PATH: '/bin' })).toBeUndefined();
  });

  it('is one field on the UserPromptSubmit log and changes nothing else', async () => {
    const logged: Record<string, unknown>[] = [];
    const out = await onUserPromptSubmit(
      { session_id: 's1', prompt: 'Find where the quota file is written' },
      {
        readMode: async () => 'on',
        readSessionModel: () => 'claude-sonnet-5-5',
        readQuotaStrategy: async () => 'unknown',
        dispatch: async () => ({ subagent: 'Explore', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 }),
        log: (e) => logged.push(e),
        env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' }
      }
    );

    expect(logged[0].env_notice).toBe('ANTHROPIC_DEFAULT_SONNET_MODEL remaps the model alias');
    expect(String(out?.hookSpecificOutput.additionalContext)).not.toContain('ANTHROPIC');
  });
});

describe('private state', () => {
  it('creates the config directory and the decisions log owner-only, with session_id next to session', () => {
    run('pre-tool-use', { session_id: 's1', tool_name: 'Workflow', tool_input: {} });
    const log = path.join(jevDir(), 'claude_decisions.jsonl');

    expect([mode(jevDir()), mode(log)]).toEqual([0o700, 0o600]);
    expect(JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0])).toMatchObject({ event: 'agent_call', session: 's1', session_id: 's1' });
  });

  it('tightens a directory and files that already exist with looser modes', () => {
    const sessions = path.join(jevDir(), 'claude-sessions');
    const log = path.join(jevDir(), 'claude_decisions.jsonl');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(log, '');
    fs.writeFileSync(path.join(sessions, 's1.json'), '{}\n');
    fs.writeFileSync(path.join(sessions, 's1.turn.json'), '{}\n');
    for (const d of [jevDir(), sessions]) fs.chmodSync(d, 0o755);
    for (const f of [log, path.join(sessions, 's1.json'), path.join(sessions, 's1.turn.json')]) fs.chmodSync(f, 0o644);

    run('session-start', { session_id: 's1', model: 'claude-sonnet-5-5' });
    run('user-prompt-submit', { session_id: 's1', prompt: 'hello' });
    run('pre-tool-use', { session_id: 's1', tool_name: 'Workflow', tool_input: {} });

    expect([mode(jevDir()), mode(sessions), mode(log), mode(path.join(sessions, 's1.json')), mode(path.join(sessions, 's1.turn.json'))]).toEqual([0o700, 0o700, 0o600, 0o600, 0o600]);
  });

  it('creates the session directory, the session file and the turn file owner-only', () => {
    run('session-start', { session_id: 's1', model: 'claude-sonnet-5-5' });
    run('user-prompt-submit', { session_id: 's1', prompt: 'hello' });
    const sessions = path.join(jevDir(), 'claude-sessions');

    expect([mode(sessions), mode(path.join(sessions, 's1.json')), mode(path.join(sessions, 's1.turn.json'))]).toEqual([0o700, 0o600, 0o600]);
  });
});
