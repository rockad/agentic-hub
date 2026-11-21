/**
 * The Antigravity `run_workflow` guard through the real hook process (antigravity/hook.ts): choice, clamp, dialog,
 * on-demand and off, plus the pin store and the PostToolUse drift recorder. Hermetic: a temporary home, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const CLEAN = 'await agent("p", model="flash")';
const PRO = 'await agent("p", model="pro")';
const DYN = 'await agent("p", model=tier)';

let home = '';
let jevDir = '';

function setMode(mode: string): void {
  fs.writeFileSync(path.join(jevDir, 'config.json'), JSON.stringify({ defaults: { mode } }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wf-proc-'));
  jevDir = path.join(home, '.config', 'jev');
  fs.mkdirSync(jevDir, { recursive: true });
  setMode('on');
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(event: string, input: object, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    JEV_CONFIG_FILE: path.join(jevDir, 'config.json'),
    JEV_DOWNGRADE: 'off',
    ...extraEnv
  };
  if (!('JEV_ELEVATION' in extraEnv)) delete env.JEV_ELEVATION;
  return Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string> });
}

const pre = (args: object, id = 'call_wf', conv = 'conv-wf-proc') => ({
  conversationId: conv,
  lastUserInput: 'run the review workflow',
  modelName: 'gemini-3.8-flash-low',
  toolCall: { id, name: 'run_workflow', args }
});
const post = (args: object, id = 'call_wf', conv = 'conv-wf-proc') => ({ conversationId: conv, toolCall: { id, name: 'run_workflow', args }, content: 'done' });
const answer = (conv = 'conv-wf-proc') => ({
  conversationId: conv,
  toolCall: { id: 'call_ask', name: 'ask_question', args: { questions: [{ question: '[jev-elevate:pro] Allow run_workflow to launch pro agents?', options: ['(Recommended) Yes, once', 'No'] }] } },
  content: 'A1: (Recommended) Yes, once'
});
const stdout = (p: { stdout: Buffer }) => p.stdout.toString().trim();
const pinDir = () => path.join(jevDir, 'antigravity-workflow-pins');
const pins = () => (fs.existsSync(pinDir()) ? fs.readdirSync(pinDir()) : []);
function rows(): Array<Record<string, any>> {
  const f = path.join(jevDir, 'antigravity_decisions.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const wfRows = () => rows().filter((r) => r.event === 'workflow_call');

describe('run_workflow through the hook process: choice (default)', () => {
  it('a clean script passes with nothing printed, and is pinned under the tool call id', () => {
    const p = run('pre-tool-use', pre({ Script: CLEAN }));
    expect(p.exitCode).toBe(0);
    expect(stdout(p)).toBe('');
    expect(pins()).toEqual(['call_wf.json']);
    const pin = JSON.parse(fs.readFileSync(path.join(pinDir(), 'call_wf.json'), 'utf8'));
    expect(pin.scripts[0].sha256).toBe(sha(CLEAN));
    expect(JSON.stringify(pin)).not.toContain('agent(');
  });

  it('a pro literal is denied with the [jev-elevate:pro] question, never ask; no pin; the log has no script text', () => {
    const p = run('pre-tool-use', pre({ Script: PRO }));
    const out = JSON.parse(stdout(p));
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('[jev-elevate:pro]');
    expect(out.reason).toContain(sha(PRO).slice(0, 12));
    expect(pins()).toEqual([]);
    const r = wfRows();
    expect(r).toHaveLength(1);
    expect(r[0].decision).toBe('deny');
    expect(r[0].harness).toBe('antigravity');
    expect(JSON.stringify(r)).not.toContain('agent(');
    expect(JSON.stringify(r)).not.toContain('run the review workflow');
  });

  it('Yes, once on the question allows the next attempt, pins it, and is used up by one run', () => {
    expect(JSON.parse(stdout(run('pre-tool-use', pre({ Script: PRO })))).decision).toBe('deny');
    expect(run('post-tool-use', answer()).exitCode).toBe(0);
    const ok = run('pre-tool-use', pre({ Script: PRO }, 'call_wf2'));
    expect(JSON.parse(stdout(ok)).decision).toBe('allow');
    expect(pins()).toEqual(['call_wf2.json']);
    expect(JSON.parse(stdout(run('pre-tool-use', pre({ Script: PRO }, 'call_wf3')))).decision).toBe('deny');
  });

  it('an unverifiable script is a deny with guidance (never ask), and the script text never reaches the log', () => {
    const p = run('pre-tool-use', pre({ Script: DYN }));
    const out = JSON.parse(stdout(p));
    expect(out.decision).toBe('deny');
    expect(out.reason).not.toContain('[jev-elevate');
    expect(pins()).toEqual([]);
    expect(JSON.stringify(rows())).not.toContain('model=tier');
  });

  it('an unreadable ScriptPath is denied, never asked', () => {
    const p = run('pre-tool-use', pre({ ScriptPath: path.join(home, 'missing.py') }));
    expect(JSON.parse(stdout(p)).decision).toBe('deny');
  });

  it('a tool call other than run_workflow is untouched by the guard', () => {
    const p = run('pre-tool-use', { conversationId: 'c', modelName: 'gemini-3.8-flash-low', toolCall: { id: 'x', name: 'view_file', args: {} } });
    expect(p.exitCode).toBe(0);
    expect(stdout(p)).toBe('');
    expect(wfRows()).toEqual([]);
  });
});

describe('run_workflow through the hook process: clamp and dialog', () => {
  it('clamp is the choice flow and never asks', () => {
    const el = JSON.parse(stdout(run('pre-tool-use', pre({ Script: PRO }), { JEV_ELEVATION: 'clamp' })));
    expect(el.decision).toBe('deny');
    expect(el.reason).toContain('[jev-elevate:pro]');
    const un = JSON.parse(stdout(run('pre-tool-use', pre({ Script: DYN }), { JEV_ELEVATION: 'clamp' })));
    expect(un.decision).toBe('deny');
  });

  it('dialog asks for an elevation and for an unverifiable script, and pins the ask', () => {
    const el = JSON.parse(stdout(run('pre-tool-use', pre({ Script: PRO }, 'call_a'), { JEV_ELEVATION: 'dialog' })));
    expect(el.decision).toBe('ask');
    const un = JSON.parse(stdout(run('pre-tool-use', pre({ Script: DYN }, 'call_b'), { JEV_ELEVATION: 'dialog' })));
    expect(un.decision).toBe('ask');
    expect(pins().sort()).toEqual(['call_a.json', 'call_b.json']);
  });

  it('dialog still passes a clean script', () => {
    const p = run('pre-tool-use', pre({ Script: CLEAN }), { JEV_ELEVATION: 'dialog' });
    expect(stdout(p)).toBe('');
  });
});

describe('run_workflow through the hook process: on-demand and off make no decision', () => {
  it('on-demand: pass for pro and for unverifiable, no pin, one skipped row', () => {
    setMode('on-demand');
    for (const s of [PRO, DYN]) {
      const p = run('pre-tool-use', pre({ Script: s }));
      expect(p.exitCode).toBe(0);
      expect(stdout(p)).toBe('');
    }
    expect(pins()).toEqual([]);
    expect(wfRows().every((r) => r.workflow_guard === 'skipped')).toBe(true);
  });

  it('off: pass, nothing written at all', () => {
    setMode('off');
    const p = run('pre-tool-use', pre({ Script: PRO }));
    expect(p.exitCode).toBe(0);
    expect(stdout(p)).toBe('');
    expect(pins()).toEqual([]);
    expect(fs.existsSync(path.join(jevDir, 'antigravity_decisions.jsonl'))).toBe(false);
  });
});

describe('run_workflow pin store and the PostToolUse drift recorder', () => {
  const scriptFile = () => path.join(home, 'wf.py');

  it('logs workflow_changed when the file differs after the run, marks the pin drifted and keeps it, prints {}', () => {
    fs.writeFileSync(scriptFile(), CLEAN);
    expect(stdout(run('pre-tool-use', pre({ ScriptPath: scriptFile() })))).toBe('');
    expect(pins()).toEqual(['call_wf.json']);
    fs.writeFileSync(scriptFile(), PRO);
    const p = run('post-tool-use', post({ ScriptPath: scriptFile() }));
    expect(p.exitCode).toBe(0);
    expect(stdout(p)).toBe('{}');
    expect(pins()).toEqual(['call_wf.json']); // kept as the record
    expect(JSON.parse(fs.readFileSync(path.join(pinDir(), 'call_wf.json'), 'utf8'))).toMatchObject({ drifted: true, drift: [{ file: scriptFile(), current: sha(PRO) }] });
    const d = rows().filter((r) => r.event === 'workflow_changed');
    expect(d).toHaveLength(1);
    expect(d[0].analysed_sha256).toBe(sha(CLEAN));
    expect(d[0].current_sha256).toBe(sha(PRO));
    expect(d[0].harness).toBe('antigravity');
    expect(JSON.stringify(d)).not.toContain('agent(');
  });

  it('an unchanged file logs nothing but still consumes the pin', () => {
    fs.writeFileSync(scriptFile(), CLEAN);
    run('pre-tool-use', pre({ ScriptPath: scriptFile() }));
    expect(stdout(run('post-tool-use', post({ ScriptPath: scriptFile() })))).toBe('{}');
    expect(pins()).toEqual([]);
    expect(rows().filter((r) => r.event === 'workflow_changed')).toEqual([]);
  });

  it('an inline script has no file to re-check: no drift event', () => {
    run('pre-tool-use', pre({ Script: CLEAN }));
    run('post-tool-use', post({ Script: CLEAN }));
    expect(pins()).toEqual([]);
    expect(rows().filter((r) => r.event === 'workflow_changed')).toEqual([]);
  });

  it('a post-tool-use without a pin is silent', () => {
    expect(stdout(run('post-tool-use', post({ Script: CLEAN }, 'never_pinned')))).toBe('{}');
  });

  it('off writes nothing and leaves the pin for a later prune', () => {
    fs.writeFileSync(scriptFile(), CLEAN);
    run('pre-tool-use', pre({ ScriptPath: scriptFile() }));
    fs.writeFileSync(scriptFile(), PRO);
    setMode('off');
    run('post-tool-use', post({ ScriptPath: scriptFile() }));
    expect(rows().filter((r) => r.event === 'workflow_changed')).toEqual([]);
    expect(pins()).toEqual(['call_wf.json']);
  });

  it('on-demand still logs the drift of a pin written while on, silently', () => {
    fs.writeFileSync(scriptFile(), CLEAN);
    run('pre-tool-use', pre({ ScriptPath: scriptFile() }));
    fs.writeFileSync(scriptFile(), PRO);
    setMode('on-demand');
    const p = run('post-tool-use', post({ ScriptPath: scriptFile() }));
    expect(stdout(p)).toBe('{}');
    expect(rows().filter((r) => r.event === 'workflow_changed')).toHaveLength(1);
  });

  it('prunes pins older than two weeks on a later call', () => {
    fs.mkdirSync(pinDir(), { recursive: true });
    const old = path.join(pinDir(), 'old.json');
    fs.writeFileSync(old, '{}');
    const past = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    fs.utimesSync(old, past, past);
    run('pre-tool-use', pre({ Script: CLEAN }));
    expect(pins()).toEqual(['call_wf.json']);
  });
});
