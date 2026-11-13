/**
 * Script TOCTOU (ported from cognitive-engine's workflow-pin tests). The hook analyses the workflow script it reads at
 * PreToolUse; Claude Code reads the file again to run it. The hook cannot hold the file still, so it (1) re-analyses the
 * CURRENT content on every call, which covers every re-invocation of a scriptPath, (2) binds each decision to the sha256
 * of the text it analysed (decisions log, ask text, a pin keyed by tool_use_id) and (3) a PostToolUse recorder re-hashes
 * the files after the run and reports any drift.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { onPreToolUse, onWorkflowPostToolUse } from '../claude/hook.ts';
import { checkScriptText, evaluateWorkflowInput, type ScriptFact, type WorkflowResolver } from '../claude/workflow-guard.ts';
import { pruneWorkflowPins, recordWorkflowPostToolUse } from '../claude/workflow-pin.ts';
import { out, rig, wf, type Rig } from './workflow-helpers.ts';

let r: Rig;
afterEach(() => r?.cleanup());

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const SESSION = 'claude-sonnet-5-5';
const CLEAN = `await agent('p')`;
const BAD = `await agent('p', { model: 'opus' })`;
const UNPROVABLE = `await agent('p', { model: args.m })`;

function script(name: string, text: string): string {
  const file = path.join(r.tmp, name);
  fs.writeFileSync(file, text);
  return file;
}
const post = (toolInput: object, toolUseId: string | null = 'toolu_01ABC') => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Workflow',
  session_id: 's1',
  cwd: r.project,
  tool_input: toolInput,
  tool_response: {},
  ...(toolUseId !== null ? { tool_use_id: toolUseId } : {})
});
const record = (input: object) => onWorkflowPostToolUse(input as any, r.d);
const drift = () => r.logs.filter((l) => l.event === 'workflow_changed');

describe('the analysis is bound to the text it read', () => {
  const resolver: WorkflowResolver = {
    readScriptFile: (f) => (f === 'child.js' ? { text: `await agent('c')`, label: '/abs/child.js' } : { error: 'no' }),
    findNamedWorkflow: () => ({ error: 'no' }),
    agentDefinition: () => ({ found: false, model: null })
  };

  it('checkScriptText reports the sha256 and size of every text it analysed, nested ones included', () => {
    const facts: ScriptFact[] = [];
    const parent = `await workflow({ scriptPath: 'child.js' })`;
    checkScriptText(parent, SESSION, resolver, '<inline>', 0, facts);
    expect(facts).toEqual([
      { label: '<inline>', sha256: sha(parent), bytes: Buffer.byteLength(parent) },
      { label: '/abs/child.js', sha256: sha(`await agent('c')`), bytes: Buffer.byteLength(`await agent('c')`) }
    ]);
  });

  it('evaluateWorkflowInput returns the facts for an allow and for an ask', () => {
    r = rig();
    const f = script('a.js', CLEAN);
    const allow = evaluateWorkflowInput({ scriptPath: f }, r.tmp, SESSION);
    expect(allow.decision).toBe('allow');
    expect(allow.scripts).toEqual([{ label: f, sha256: sha(CLEAN), bytes: CLEAN.length }]);
    const g = script('b.js', BAD);
    const ask = evaluateWorkflowInput({ scriptPath: g }, r.tmp, SESSION);
    expect(ask.decision).toBe('ask');
    expect(ask.scripts[0].sha256).toBe(sha(BAD));
    expect(ask.message).toContain(`sha256:${sha(BAD).slice(0, 16)}`);
  });

  it('an unreadable script yields no fact', () => {
    r = rig();
    expect(evaluateWorkflowInput({ scriptPath: path.join(r.tmp, 'missing.js') }, r.tmp, SESSION).scripts).toEqual([]);
  });

  it('the decisions log of a deny carries the hashes and never the script text', async () => {
    r = rig();
    const text = `// SECRET-SCRIPT-TEXT\n${BAD}`;
    const g = script('b.js', text);

    await onPreToolUse(wf({ scriptPath: g }, r), r.d);

    expect(r.logs[0].workflow_scripts).toEqual([{ label: g, sha256: sha(text), bytes: Buffer.byteLength(text) }]);
    expect(JSON.stringify(r.logs)).not.toContain('SECRET-SCRIPT-TEXT');
  });
});

describe('every call re-analyses the current content', () => {
  it('a scriptPath edited to something that escalates is denied on the next call, though the old content was clean', async () => {
    r = rig();
    const f = script('wf.js', CLEAN);
    expect(await onPreToolUse(wf({ scriptPath: f }, r, {}, 'toolu_1'), r.d)).toBeNull();
    fs.writeFileSync(f, BAD);

    expect(out(await onPreToolUse(wf({ scriptPath: f }, r, {}, 'toolu_2'), r.d)).permissionDecision).toBe('deny');
  });

  it('a resume (resumeFromRunId) is analysed from the file like any other call', async () => {
    r = rig();
    const f = script('wf.js', BAD);

    expect(out(await onPreToolUse(wf({ scriptPath: f, resumeFromRunId: 'wf_x' }, r), r.d)).permissionDecision).toBe('deny');
  });
});

describe('pins and the PostToolUse drift check', () => {
  it('a decision writes a pin with the analysed hashes, keyed by tool_use_id, owner-only', async () => {
    r = rig();
    const f = script('wf.js', CLEAN);
    expect(await onPreToolUse(wf({ scriptPath: f }, r), r.d)).toBeNull();

    const pins = fs.readdirSync(r.pins);
    expect(pins).toHaveLength(1);
    const pin = JSON.parse(fs.readFileSync(path.join(r.pins, pins[0]), 'utf8'));
    expect(pin).toMatchObject({ tool_use_id: 'toolu_01ABC', session_id: 's1', decision: 'allow', scripts: [{ label: f, sha256: sha(CLEAN) }] });
    expect(JSON.stringify(pin)).not.toContain('agent(');
    expect([fs.statSync(r.pins).mode & 0o777, fs.statSync(path.join(r.pins, pins[0])).mode & 0o777]).toEqual([0o700, 0o600]);
  });

  it('a dialog (ask) is pinned too; a deny is not (the call never runs)', async () => {
    r = rig();
    const f = script('wf.js', UNPROVABLE);
    await onPreToolUse(wf({ scriptPath: f }, r), r.d);
    const pin = JSON.parse(fs.readFileSync(path.join(r.pins, fs.readdirSync(r.pins)[0]), 'utf8'));
    expect(pin.decision).toBe('ask');

    const g = script('bad.js', BAD);
    expect(out(await onPreToolUse(wf({ scriptPath: g }, r, {}, 'toolu_deny'), r.d)).permissionDecision).toBe('deny');
    expect(fs.readdirSync(r.pins)).toHaveLength(1);
  });

  it('unchanged files: the post check is silent and consumes the pin', async () => {
    r = rig();
    const f = script('wf.js', CLEAN);
    await onPreToolUse(wf({ scriptPath: f }, r), r.d);

    expect(await record(post({ scriptPath: f }))).toEqual({ status: 'unchanged' });
    expect(fs.readdirSync(r.pins)).toHaveLength(0);
    expect(drift()).toHaveLength(0);
  });

  it('a file edited between the analysis and the end of the run is reported, with both hashes', async () => {
    r = rig();
    const f = script('wf.js', CLEAN);
    await onPreToolUse(wf({ scriptPath: f }, r), r.d);
    fs.writeFileSync(f, BAD);

    const res = await record(post({ scriptPath: f }));

    expect(res.status).toBe('changed');
    const msg = JSON.parse(res.output!).systemMessage as string;
    expect(msg).toContain(f);
    expect(msg).toContain(sha(CLEAN).slice(0, 16));
    expect(msg).toContain(sha(BAD).slice(0, 16));
    expect(drift()[0]).toMatchObject({ event: 'workflow_changed', tool_name: 'Workflow', tool_use_id: 'toolu_01ABC', session_id: 's1', file: f, analysed_sha256: sha(CLEAN), current_sha256: sha(BAD), decision: 'allow' });
  });

  it('a file deleted after the analysis is reported as changed', async () => {
    r = rig();
    const f = script('wf.js', CLEAN);
    await onPreToolUse(wf({ scriptPath: f }, r), r.d);
    fs.rmSync(f);

    expect((await record(post({ scriptPath: f }))).status).toBe('changed');
    expect(drift()[0]).toMatchObject({ file: f, current_sha256: null });
  });

  it('a nested workflow file that changed is reported too', async () => {
    r = rig();
    const child = script('child.js', CLEAN);
    const parent = script('parent.js', `await workflow({ scriptPath: ${JSON.stringify(child)} })`);
    await onPreToolUse(wf({ scriptPath: parent }, r), r.d);
    fs.writeFileSync(child, BAD);

    expect((await record(post({ scriptPath: parent }))).status).toBe('changed');
    expect(drift()[0].file).toBe(child);
  });

  it('an inline script has no file to re-check: the pin holds, the post check is unchanged', async () => {
    r = rig();
    await onPreToolUse(wf({ script: CLEAN }, r), r.d);

    expect((await record(post({ script: CLEAN }))).status).toBe('unchanged');
  });

  it('with no pin the post check is silent (the call never reached the guard)', async () => {
    r = rig();

    expect(await record(post({ scriptPath: path.join(r.tmp, 'x.js') }))).toEqual({ status: 'no-pin' });
    expect(r.logs).toEqual([]);
  });

  it('a missing tool_use_id writes no pin and breaks nothing', async () => {
    r = rig();
    const f = script('wf.js', CLEAN);

    expect(await onPreToolUse(wf({ scriptPath: f }, r, {}, null), r.d)).toBeNull();
    expect(fs.existsSync(r.pins)).toBe(false);
    expect(await record(post({ scriptPath: f }, null))).toEqual({ status: 'no-pin' });
  });

  it('no pin directory configured (a caller that does not wire it): nothing is written, the post check is silent', async () => {
    r = rig({ workflowPinDir: undefined });
    const f = script('wf.js', CLEAN);

    expect(await onPreToolUse(wf({ scriptPath: f }, r), r.d)).toBeNull();
    expect(await record(post({ scriptPath: f }))).toEqual({ status: 'no-pin' });
  });

  it('a hostile tool_use_id cannot escape the pin directory', async () => {
    r = rig();
    const f = script('wf.js', CLEAN);

    await onPreToolUse(wf({ scriptPath: f }, r, {}, '../../evil'), r.d);

    expect(fs.existsSync(path.join(r.tmp, 'evil.json'))).toBe(false);
    for (const name of fs.readdirSync(r.pins)) expect(name).toMatch(/^[A-Za-z0-9_-]+\.json$/);
  });

  it('other tools and garbage are ignored; the recorder never throws', async () => {
    r = rig();
    const deps = { dir: r.pins, readMode: () => 'on', log: r.d.log };

    expect((await recordWorkflowPostToolUse({ tool_name: 'Bash', tool_use_id: 't' }, deps)).status).toBe('ignored');
    expect((await recordWorkflowPostToolUse(null, deps)).status).toBe('ignored');
    expect((await recordWorkflowPostToolUse({ tool_name: 'Workflow', tool_use_id: 't' }, { ...deps, readMode: () => { throw new Error('x'); } })).status).toBe('no-pin');
    expect((await record({ tool_name: 'Workflow' })).status).toBe('no-pin');
  });

  it('prunes pins older than two weeks and keeps recent ones', async () => {
    r = rig();
    await onPreToolUse(wf({ script: CLEAN }, r, {}, 'toolu_old'), r.d);
    await onPreToolUse(wf({ script: CLEAN }, r, {}, 'toolu_new'), r.d);
    const old = path.join(r.pins, 'toolu_old.json');
    const long = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, long, long);

    pruneWorkflowPins(r.pins);

    expect(fs.readdirSync(r.pins)).toEqual(['toolu_new.json']);
    pruneWorkflowPins(path.join(r.tmp, 'nowhere')); // a missing directory is not an error
  });
});
