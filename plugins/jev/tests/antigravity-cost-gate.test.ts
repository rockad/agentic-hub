/**
 * The cost gate (2.3.19) in the Antigravity hook: one gate for the model and the effort (the suffix of the model id) of an
 * `invoke_subagent` call and of the agent(...) calls of a `run_workflow` script. Choice, clamp, dialog, on-demand and off, through
 * the pure guards and through the real hook process; the decisions log and the telemetry row carry `cost_gate` and both costs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateAntigravitySubagentCall, antigravityCostGateState, type AntigravityHookInput } from '../antigravity/logic.ts';
import { createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';
import { evaluateAntigravityWorkflowCall } from '../antigravity/workflow-guard.ts';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const PRO_HIGH = 'gemini-3.5-pro-high'; // 15 * 1.5 = 22.5
const FLASH_LOW = 'gemini-3.8-flash-low'; // 3 * 0.5 = 1.5

let dir = '';
let approvals: ApprovalStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cg-'));
  approvals = createAntigravityApprovalStore(path.join(dir, 'sessions'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sub = (model: string | undefined, session: string, prompt = 'run it'): AntigravityHookInput => ({
  conversationId: 'c1',
  lastUserInput: prompt,
  modelName: session,
  toolCall: { id: 't1', name: 'invoke_subagent', args: { TypeName: 'worker', Prompt: 'work', ...(model ? { Model: model } : {}) } }
});
const decide = (input: AntigravityHookInput, elevationMode: 'choice' | 'dialog' | 'clamp' = 'choice') =>
  evaluateAntigravitySubagentCall(input, { approvals, sessionModelOverride: input.modelName, elevationMode, now: () => 1_000 });

describe('invoke_subagent: the gate', () => {
  it('session pro at high (22.5): flash at max passes, pro at xhigh is held (the effort question), pro at high passes', () => {
    expect(decide(sub('gemini-3.8-flash-max', PRO_HIGH))).toEqual({ decision: 'pass' });
    expect(decide(sub('gemini-3.5-pro-high', PRO_HIGH))).toEqual({ decision: 'pass' });

    const held = decide(sub('gemini-3.5-pro-xhigh', PRO_HIGH));
    expect(held).toMatchObject({ decision: 'deny', elevation: 'denied' });
    expect(held.reason).toContain("'[jev-elevate:pro-xhigh]'");
    expect(held.reason).toContain("it costs 30 vs the session's 22.5 (gemini-3.5-pro-xhigh at xhigh vs pro at high)");
    expect(antigravityCostGateState(sub('gemini-3.5-pro-xhigh', PRO_HIGH), held, {})).toBe('denied');
  });

  it('an enum value is priced by the model it is served on: flash on a flash-low session passes, pro on it is held with what it really is', () => {
    expect(decide(sub('flash', FLASH_LOW))).toEqual({ decision: 'pass' });
    const held = decide(sub('pro', FLASH_LOW));
    expect(held).toMatchObject({ decision: 'deny' });
    expect(held.reason).toContain("'[jev-elevate:pro]'");
    // pro is served on Hydrogen at xhigh (6), against the flash ceiling served at high (4.5)
    expect(held.reason).toContain('it costs 6 vs the allowed 4.5 (gemini-4-hydrogen-tiered-xhigh at xhigh vs gemini-4-hydrogen-tiered-high at high)');
    expect(held.reason).toContain('Model "pro" runs on Gemini 4 Hydrogen (xhigh), a flash-class model, not on Argon');
    expect(held.reason).toContain('A subagent on Argon needs the session itself on Gemini 4 Argon, with Model "inherit"');
    expect(held.reason).toContain('followed by a short question that says plainly "Model "pro" is served on Gemini 4 Hydrogen (xhigh), flash class"');
  });

  it('an effort that the call raises on its own model is held too (flash at high on a flash-low session)', () => {
    expect(decide(sub('gemini-3.8-flash-high', FLASH_LOW))).toMatchObject({ decision: 'deny' });
  });

  it('a model the cost gate cannot place falls back to the ceiling by rank, as before', () => {
    // an id the tier table does not know is not a recognised subagent model at all: denied with guidance, as before 2.3.19
    expect(decide(sub('gpt-oss-120b-medium', FLASH_LOW))).toMatchObject({ decision: 'deny' });
    // a recognised family id with no tier word (gemini-...-ultra) has no cost: the rank (flash, the default) is compared with the ceiling
    expect(decide(sub('gemini-9-ultra', FLASH_LOW))).toEqual({ decision: 'pass' });
    expect(antigravityCostGateState(sub('gemini-9-ultra', FLASH_LOW), { decision: 'pass' }, {})).toBe('fallback');
  });

  it('what the user named in the prompt raises the baseline: the call is allowed as instructed', () => {
    expect(decide(sub('pro', FLASH_LOW, 'use manual pro approval for this'))).toMatchObject({ decision: 'allow', elevation: 'instructed' });
  });

  it('an approval of pro-xhigh covers pro-xhigh, pro-high and pro-medium, not pro-max; the bare pro stands for at most high', () => {
    // a session pro at medium (15): pro-xhigh (30) needs approval
    const session = 'gemini-3.5-pro-medium';
    approvals.deny('c1', 'pro-xhigh', 500);
    approvals.record('c1', { model: 'pro-xhigh', scope: 'session', created_at: 600 });

    expect(decide(sub('gemini-3.5-pro-xhigh', session))).toMatchObject({ decision: 'allow', elevation: 'approved', approvalScope: 'session' });
    expect(decide(sub('gemini-3.5-pro-max', session))).toMatchObject({ decision: 'deny' });
    // a record that names no effort (before 2.3.19) covers the model at high, not at xhigh
    const store = createAntigravityApprovalStore(path.join(dir, 'legacy'));
    store.deny('c1', 'pro', 500);
    store.record('c1', { model: 'pro', scope: 'session', created_at: 600 });
    const withStore = (m: string) => evaluateAntigravitySubagentCall(sub(m, FLASH_LOW), { approvals: store, sessionModelOverride: FLASH_LOW, elevationMode: 'choice', now: () => 1_000 });
    expect(withStore('pro')).toMatchObject({ decision: 'allow', elevation: 'approved' });
    expect(withStore('pro-xhigh')).toMatchObject({ decision: 'deny' });
  });

  it('pro costs as Hydrogen at xhigh: it passes on a flash-xhigh session (its real cost is the session\'s), is held on a flash-high one', () => {
    expect(decide(sub('pro', 'gemini-3.8-flash-xhigh'))).toEqual({ decision: 'pass' });
    const held = decide(sub('pro', 'gemini-3.8-flash-high'));
    expect(held).toMatchObject({ decision: 'deny' });
    expect(held.reason).toContain("'[jev-elevate:pro]'"); // an enum value carries its effort in what it is: the marker is the plain value
  });

  it('clamp: the ceiling model when the model is what is too much; the same model at a lowered effort when only the effort is', () => {
    const model = decide(sub('gemini-3.5-pro-xhigh', 'gemini-3.8-flash-high'), 'clamp');
    expect(model).toMatchObject({ decision: 'allow', elevation: 'clamped', overwrite: { Model: 'flash' }, clampedTo: 'flash', clampedEffort: 'high' });

    const effort = decide(sub('gemini-3.5-pro-xhigh', PRO_HIGH), 'clamp');
    expect(effort).toMatchObject({ decision: 'allow', elevation: 'clamped', overwrite: { Model: 'gemini-3.5-pro-high' }, clampedEffort: 'high' });

    const bare = decide(sub('pro', FLASH_LOW), 'clamp');
    expect(bare).toMatchObject({ overwrite: { Model: 'flash' }, clampedTo: 'flash' });
    expect(antigravityCostGateState(sub('pro', FLASH_LOW), bare, {})).toBe('clamped');
  });

  it('dialog asks with the cost, never denies', () => {
    const held = decide(sub('gemini-3.5-pro-xhigh', PRO_HIGH), 'dialog');
    expect(held).toMatchObject({ decision: 'ask', elevation: 'asked' });
    expect(held.reason).toContain("it costs 30 vs the session's 22.5");
  });

  it('on-demand decides nothing', () => {
    expect(evaluateAntigravitySubagentCall(sub('gemini-3.5-pro-max', FLASH_LOW), { approvals, mode: 'on-demand', sessionModelOverride: FLASH_LOW })).toEqual({ decision: 'pass' });
  });
});

describe('run_workflow: the same rule per agent(...) call', () => {
  const wf = (script: string, session = PRO_HIGH) => ({
    conversationId: 'cw',
    lastUserInput: 'run the workflow',
    modelName: session,
    toolCall: { id: 'w1', name: 'run_workflow', args: { Script: script } }
  });
  const run = (script: string, session = PRO_HIGH, elevationMode: 'choice' | 'dialog' | 'clamp' = 'choice') =>
    evaluateAntigravityWorkflowCall(wf(script, session), { mode: 'on', sessionModel: session, approvals, elevationMode, now: () => 1_000 });

  it('flash at max passes on a pro-high session; pro at xhigh is the question with the effort in the marker', () => {
    const ok = run('await agent("p", model="gemini-3.8-flash-max")');
    expect(ok.decision).toEqual({ decision: 'pass' });
    expect(ok.log).toMatchObject({ workflow_guard: 'allow', cost_gate: 'pass' });

    const held = run('await agent("p", model="gemini-3.5-pro-xhigh")');
    expect(held.decision).toMatchObject({ decision: 'deny', elevation: 'denied' });
    expect(held.decision.reason).toContain("'[jev-elevate:pro-xhigh]'");
    expect(held.decision.reason).toContain("its most costly agent costs 30 vs the session's 22.5");
    expect(held.log).toMatchObject({ workflow_guard: 'denied', cost_gate: 'denied' });
    expect(JSON.stringify(held.log)).not.toContain('agent(');
  });

  it('an approval covers the whole script at the approved effort or lower', () => {
    approvals.deny('cw', 'pro-xhigh', 500);
    approvals.record('cw', { model: 'pro-xhigh', scope: 'session', created_at: 600 });

    const ok = run('await agent("a", model="gemini-3.5-pro-xhigh")\nawait agent("b", model="gemini-3.5-pro-high")');
    expect(ok.decision).toMatchObject({ decision: 'allow', elevation: 'approved' });
    expect(ok.log).toMatchObject({ cost_gate: 'approved' });
    expect(run('await agent("a", model="gemini-3.5-pro-max")').decision).toMatchObject({ decision: 'deny' });
  });

  it('what the user named lets it through; clamp is the choice flow; dialog asks; on-demand passes untouched', () => {
    const named = evaluateAntigravityWorkflowCall({ ...wf('await agent("p", model="pro")', FLASH_LOW), lastUserInput: 'use manual pro approval' }, { mode: 'on', sessionModel: FLASH_LOW, approvals });
    expect(named.decision).toMatchObject({ decision: 'allow', elevation: 'instructed' });

    expect(run('await agent("p", model="pro")', FLASH_LOW, 'clamp').decision).toMatchObject({ decision: 'deny' });
    expect(run('await agent("p", model="pro")', FLASH_LOW, 'dialog').decision).toMatchObject({ decision: 'ask' });
    const off = evaluateAntigravityWorkflowCall(wf('await agent("p", model="gemini-3.5-pro-max")'), { mode: 'on-demand', sessionModel: PRO_HIGH, approvals });
    expect(off.decision).toEqual({ decision: 'pass' });
  });

  it('a model the gate cannot place keeps the ceiling by rank', () => {
    const r = run('await agent("p", model=tier)');
    expect(r.decision).toMatchObject({ decision: 'deny' });
    expect(r.log).toMatchObject({ cost_gate: 'fallback' });
  });
});

describe('through the hook process', () => {
  let home = '';
  const jev = () => path.join(home, '.config', 'jev');
  const setMode = (mode: string) => fs.writeFileSync(path.join(jev(), 'config.json'), JSON.stringify({ defaults: { mode } }));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cgproc-'));
    fs.mkdirSync(jev(), { recursive: true });
    setMode('on');
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const runHook = (input: object, extraEnv: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(jev(), 'config.json'), JEV_DOWNGRADE: 'off', ...extraEnv };
    if (!('JEV_ELEVATION' in extraEnv)) delete env.JEV_ELEVATION;
    const p = Bun.spawnSync(['bun', HOOK, 'pre-tool-use'], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string> });
    return p.stdout.toString().trim();
  };
  const decisions = () => {
    const f = path.join(jev(), 'antigravity_decisions.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const telemetry = () => {
    const f = path.join(home, '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  it('choice: flash at max passes, pro at xhigh is denied with the cost; the rows carry cost_gate and both costs', () => {
    expect(runHook(sub('gemini-3.8-flash-max', PRO_HIGH))).toBe('');
    expect(decisions().at(-1)).toMatchObject({ decision: 'pass', cost_gate: 'pass', costEstimate: 9, sessionCost: 22.5 });

    const held = JSON.parse(runHook(sub('gemini-3.5-pro-xhigh', PRO_HIGH)));
    expect(held.decision).toBe('deny');
    expect(held.reason).toContain("it costs 30 vs the session's 22.5");
    expect(decisions().at(-1)).toMatchObject({ decision: 'deny', cost_gate: 'denied', costEstimate: 30, sessionCost: 22.5 });
    expect(telemetry().at(-1)).toMatchObject({ decision: 'deny', cost_gate: 'denied', costEstimate: 30, sessionCost: 22.5 });
  });

  it('clamp: an explicit allow with the overwrite, clamped_to and clamped_effort on the row', () => {
    const o = JSON.parse(runHook(sub('gemini-3.5-pro-xhigh', PRO_HIGH), { JEV_ELEVATION: 'clamp' }));

    expect(o).toMatchObject({ decision: 'allow' });
    expect(JSON.stringify(o)).toContain('gemini-3.5-pro-high');
    expect(decisions().at(-1)).toMatchObject({ decision: 'allow', cost_gate: 'clamped', clamped_to: 'gemini-3.5-pro-high', clamped_effort: 'high' });
  });

  it('dialog asks; on-demand passes with the costs and no cost_gate; off writes nothing', () => {
    expect(JSON.parse(runHook(sub('gemini-3.5-pro-xhigh', PRO_HIGH), { JEV_ELEVATION: 'dialog' }))).toMatchObject({ decision: 'ask' });
    expect(decisions().at(-1)).toMatchObject({ decision: 'ask', cost_gate: 'denied' });

    setMode('on-demand');
    expect(runHook(sub('gemini-3.5-pro-max', PRO_HIGH))).toBe('');
    expect(decisions().at(-1)).toMatchObject({ decision: 'pass', costEstimate: 45, sessionCost: 22.5 });
    expect(decisions().at(-1)).not.toHaveProperty('cost_gate');

    setMode('off');
    const before = decisions().length;
    expect(runHook(sub('gemini-3.5-pro-max', PRO_HIGH))).toBe('');
    expect(decisions()).toHaveLength(before);
  });

  it('the answer to the question for pro-xhigh is recorded by PostToolUse and covers that effort and lower, not max', () => {
    const held = JSON.parse(runHook(sub('gemini-3.5-pro-xhigh', PRO_HIGH)));
    expect(held.reason).toContain("'[jev-elevate:pro-xhigh]'");

    const post = {
      conversationId: 'c1',
      toolCall: {
        id: 'call_ask',
        name: 'ask_question',
        args: { questions: [{ question: "[jev-elevate:pro-xhigh] Allow subagent 'worker' to run on gemini-3.5-pro-xhigh?", options: ['(Recommended) Yes, for this session', 'No'] }] }
      },
      content: 'A1: (Recommended) Yes, for this session'
    };
    const p = Bun.spawnSync(['bun', HOOK, 'post-tool-use'], {
      stdin: new TextEncoder().encode(JSON.stringify(post)),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(jev(), 'config.json'), JEV_DOWNGRADE: 'off' } as Record<string, string>
    });
    expect(p.exitCode).toBe(0);

    expect(JSON.parse(runHook(sub('gemini-3.5-pro-xhigh', PRO_HIGH)))).toMatchObject({ decision: 'allow' });
    expect(decisions().at(-1)).toMatchObject({ decision: 'allow', elevation: 'approved', cost_gate: 'approved' });
    expect(JSON.parse(runHook(sub('gemini-3.5-pro-max', PRO_HIGH)))).toMatchObject({ decision: 'deny' });
  });

  it('run_workflow: the gate is on the workflow row', () => {
    const wf = (script: string) => ({ conversationId: 'cw', lastUserInput: 'run it', modelName: PRO_HIGH, toolCall: { id: 'w1', name: 'run_workflow', args: { Script: script } } });

    expect(runHook(wf('await agent("p", model="gemini-3.8-flash-max")'))).toBe('');
    expect(decisions().find((r) => r.event === 'workflow_call')).toMatchObject({ workflow_guard: 'allow', cost_gate: 'pass' });

    const held = JSON.parse(runHook(wf('await agent("p", model="gemini-3.5-pro-xhigh")')));
    expect(held.decision).toBe('deny');
    expect(decisions().filter((r) => r.event === 'workflow_call').at(-1)).toMatchObject({ workflow_guard: 'denied', cost_gate: 'denied' });
  });
});
