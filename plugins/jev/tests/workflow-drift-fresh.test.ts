/**
 * Drift and a fresh analysis, both harnesses. PostToolUse logs `workflow_changed` and marks the pin `drifted` (the pin is kept
 * as the record). PreToolUse never reads a pin as a verdict: a file changed after a check is analysed again, from disk, on
 * the next run (even with the same tool call id, as a resume has) and gets the normal verdict for what it says now.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPreToolUse, onWorkflowPostToolUse } from '../claude/hook.ts';
import { evaluateAntigravityWorkflowCall } from '../antigravity/workflow-guard.ts';
import { recordRunWorkflowPostToolUse } from '../antigravity/workflow-pin.ts';
import { out, rig, wf, type Rig } from './workflow-helpers.ts';

describe('Claude Code Workflow', () => {
  let r: Rig;
  afterEach(() => r?.cleanup());
  const pinOf = (): Record<string, any> => JSON.parse(fs.readFileSync(path.join(r.pins, fs.readdirSync(r.pins)[0]), 'utf8'));

  it('drift is logged and the pin is marked drifted and kept; a clean run drops its pin', async () => {
    r = rig();
    const f = path.join(r.tmp, 'wf.js');
    fs.writeFileSync(f, `await agent('p')`);
    await onPreToolUse(wf({ scriptPath: f }, r), r.d);
    fs.writeFileSync(f, `await agent('p', { model: 'opus' })`);

    const res = await onWorkflowPostToolUse({ hook_event_name: 'PostToolUse', tool_name: 'Workflow', session_id: 's1', cwd: r.project, tool_use_id: 'toolu_01ABC', tool_input: { scriptPath: f } } as any, r.d);

    expect(res.status).toBe('changed');
    expect(r.logs.filter((l) => l.event === 'workflow_changed')).toHaveLength(1);
    expect(fs.readdirSync(r.pins)).toHaveLength(1);
    expect(pinOf()).toMatchObject({ drifted: true, decision: 'allow', drift: [{ file: f }] });
  });

  it('a file changed after a check is analysed fresh on the next run, with the same tool call id, and gets the normal verdict', async () => {
    r = rig();
    const f = path.join(r.tmp, 'wf.js');
    fs.writeFileSync(f, `await agent('p')`);
    expect(await onPreToolUse(wf({ scriptPath: f }, r, {}, 'toolu_same'), r.d)).toBeNull(); // allowed, pinned
    expect(fs.readdirSync(r.pins)).toHaveLength(1);

    fs.writeFileSync(f, `await agent('p', { model: 'opus' })`); // changed after the check
    const next = out(await onPreToolUse(wf({ scriptPath: f }, r, {}, 'toolu_same'), r.d));

    expect(next.permissionDecision).toBe('deny'); // the normal choice-flow verdict, not the pin's earlier allow
    expect(next.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(r.logs.at(-1)).toMatchObject({ workflow_guard: 'denied' });

    fs.writeFileSync(f, `await agent('p', { model: args.m })`); // and again: unverifiable
    expect(out(await onPreToolUse(wf({ scriptPath: f }, r, {}, 'toolu_same'), r.d)).permissionDecisionReason).toContain('Jev cannot verify');
    fs.writeFileSync(f, `await agent('p')`); // and back to clean: allowed again
    expect(await onPreToolUse(wf({ scriptPath: f }, r, {}, 'toolu_same'), r.d)).toBeNull();
  });

  it('a drifted pin never makes a later call pass or fail by itself: the reported file is judged on its content', async () => {
    r = rig();
    const f = path.join(r.tmp, 'wf.js');
    fs.writeFileSync(f, `await agent('p')`);
    await onPreToolUse(wf({ scriptPath: f }, r, {}, 'toolu_a'), r.d);
    fs.writeFileSync(f, `await agent('p', { model: 'opus' })`);
    await onWorkflowPostToolUse({ hook_event_name: 'PostToolUse', tool_name: 'Workflow', session_id: 's1', cwd: r.project, tool_use_id: 'toolu_a', tool_input: { scriptPath: f } } as any, r.d);

    fs.writeFileSync(f, `await agent('p')`); // restored to what the pin had analysed
    expect(await onPreToolUse(wf({ scriptPath: f }, r, {}, 'toolu_a'), r.d)).toBeNull();
  });
});

describe('Antigravity run_workflow', () => {
  let dir = '';
  let pins = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-drift-'));
    pins = path.join(dir, 'pins');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const SESSION = 'gemini-3.8-flash-low';
  const CLEAN = `await agent("p")\n`;
  const PRO = `await agent("p", model="pro")\n`;
  const pre = (file: string) =>
    evaluateAntigravityWorkflowCall({ conversationId: 'c1', modelName: SESSION, cwd: dir, toolCall: { id: 'call_same', name: 'run_workflow', args: { ScriptPath: file } } } as any, {
      mode: 'on',
      sessionModel: SESSION,
      elevationMode: 'choice',
      pinDir: pins
    });

  it('drift is logged, the pin is marked drifted and kept', async () => {
    const f = path.join(dir, 'wf.py');
    fs.writeFileSync(f, CLEAN);
    expect(pre(f).decision.decision).toBe('pass');
    fs.writeFileSync(f, PRO);
    const logs: Record<string, unknown>[] = [];

    await recordRunWorkflowPostToolUse(
      { conversationId: 'c1', toolCall: { id: 'call_same', name: 'run_workflow', args: { ScriptPath: f } } } as any,
      { dir: pins, readMode: () => 'on', log: (e: Record<string, unknown>) => logs.push(e) } as any
    );

    expect(logs.filter((l) => l.event === 'workflow_changed')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(pins, 'call_same.json'), 'utf8'))).toMatchObject({ drifted: true });
  });

  it('a file changed after a check is analysed fresh on the next run (same tool call id) and gets the normal verdict', () => {
    const f = path.join(dir, 'wf.py');
    fs.writeFileSync(f, CLEAN);
    expect(pre(f).decision.decision).toBe('pass');

    fs.writeFileSync(f, PRO);
    const next = pre(f);

    expect(next.decision.decision).toBe('deny');
    expect(next.decision.reason).toContain('[jev-elevate:pro]');
    expect(next.log).toMatchObject({ workflow_guard: 'denied' });

    fs.writeFileSync(f, `await agent("p", model=variable)\n`);
    expect(pre(f).log).toMatchObject({ workflow_guard: 'denied-unverifiable' });
    fs.writeFileSync(f, CLEAN);
    expect(pre(f).decision.decision).toBe('pass');
  });
});
