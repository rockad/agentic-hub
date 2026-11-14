/**
 * A resumed session: a SessionStart payload that carries no `model` (Claude Code names only `source`) must not leave
 * a stale session record in charge. The record is deleted, so the transcript learner reads the model of the last
 * turn instead; a payload that does carry a model still overwrites the record, and PostModelSwitch is untouched.
 * Real hook process, temp HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
let home = '';
let proj = '';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-resume-')));
  proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(event: string, input: object) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_OPENROUTER_API_KEY: '', JEV_MODEL_REFRESH: 'off', JEV_DOWNGRADE: 'off' };
  for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'JEV_ELEVATION']) delete env[v];
  const proc = Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string>, cwd: proj });
  return { code: proc.exitCode, stdout: proc.stdout.toString() };
}
const transcript = (model: string): string => {
  const dir = path.join(home, '.claude', 'projects', 'x');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's1.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model } })}\n`);
  return file;
};
const sessionFile = () => path.join(home, '.config', 'jev', 'claude-sessions', 's1.json');
/** A sonnet Agent call; the session model decides whether it passes (opus or sonnet) or is an elevation (haiku). */
const sonnetCall = (transcript_path: string) =>
  JSON.parse(run('pre-tool-use', { session_id: 's1', prompt_id: 'p1', cwd: proj, transcript_path, tool_name: 'Agent', tool_input: { description: 'd', model: 'sonnet' } }).stdout || '{}').hookSpecificOutput?.permissionDecision ?? null;

describe('SessionStart without a model (a resume)', () => {
  it('a stale opus record plus a transcript whose last turn is haiku: the next call is judged against haiku', () => {
    const t = transcript('claude-haiku-5-5');
    run('session-start', { session_id: 's1', model: 'claude-opus-5-5' });
    expect(JSON.parse(fs.readFileSync(sessionFile(), 'utf8')).model).toBe('claude-opus-5-5');

    expect(run('session-start', { session_id: 's1', source: 'resume' }).code).toBe(0);

    expect(fs.existsSync(sessionFile())).toBe(false);
    expect(sonnetCall(t)).toBe('deny'); // sonnet is above haiku: an elevation
    expect(JSON.parse(fs.readFileSync(sessionFile(), 'utf8'))).toMatchObject({ model: 'claude-haiku-5-5', source: 'transcript' });
  });

  it('control: without the resume event the stale opus record would let the sonnet call through', () => {
    const t = transcript('claude-haiku-5-5');
    run('session-start', { session_id: 's1', model: 'claude-opus-5-5' });

    expect(sonnetCall(t)).toBeNull();
  });

  it('a resume that does carry a model overwrites the record, as before', () => {
    const t = transcript('claude-haiku-5-5');
    run('session-start', { session_id: 's1', model: 'claude-opus-5-5' });

    run('session-start', { session_id: 's1', source: 'resume', model: 'claude-sonnet-5-5' });

    expect(JSON.parse(fs.readFileSync(sessionFile(), 'utf8')).model).toBe('claude-sonnet-5-5');
    expect(sonnetCall(t)).toBeNull();
  });

  it('a resume with no record and no transcript leaves nothing stored and nothing printed', () => {
    const r = run('session-start', { session_id: 's1', source: 'resume' });

    expect(r).toEqual({ code: 0, stdout: '' });
    expect(fs.existsSync(sessionFile())).toBe(false);
  });

  it('a PostModelSwitch without a model never deletes the record', () => {
    run('session-start', { session_id: 's1', model: 'claude-opus-5-5' });

    run('post-model-switch', { session_id: 's1' });

    expect(JSON.parse(fs.readFileSync(sessionFile(), 'utf8')).model).toBe('claude-opus-5-5');
  });

  it('only the session record goes: the turn state and an unsafe session id are left alone', () => {
    run('session-start', { session_id: 's1', model: 'claude-opus-5-5' });
    const turn = path.join(home, '.config', 'jev', 'claude-sessions', 's1.turn.json');
    fs.writeFileSync(turn, '{}\n');

    run('session-start', { session_id: 's1', source: 'resume' });
    run('session-start', { session_id: '../../etc/x', source: 'resume' });

    expect(fs.existsSync(turn)).toBe(true);
  });
});
