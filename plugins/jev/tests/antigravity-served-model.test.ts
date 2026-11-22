/**
 * Antigravity cost and guidance follow the model a subagent is actually SERVED on (2.3.19, verified on Antigravity 1.5.14).
 * `invoke_subagent`'s Model is an enum (inherit | flash_lite | flash | pro) served as flash-lite, Hydrogen at high and Hydrogen
 * at xhigh under every parent; inherit is the parent's own model. Covers the mapping (src/core/served-model.ts), the cost gate and
 * the cost fields built on it, the guidance texts, the "served below requested" notice (mode on only, once per pair), and that
 * Claude Code, which serves what it is asked, is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ANTIGRAVITY_SERVED_VERIFIED_ON,
  ARGON_HOW_SENTENCE,
  PRO_SERVED_SENTENCE,
  SERVED_BY_ENUM,
  requestedTierOf,
  servedBelowNotice,
  servedBelowRequested,
  servedModelExpected,
  servedModelGuidance,
  servedModelLabel,
  servedQuestionPhrase,
  subagentEnumOf
} from '../src/core/served-model.ts';
import { antigravityClampModel, antigravityCostGate, antigravityMarkerModel } from '../src/core/cost-gate.ts';
import { antigravityCostFields, costFields } from '../src/core/cost-estimate.ts';
import { evaluateAntigravitySubagentCall, antigravityCostGateState, type AntigravityHookInput } from '../antigravity/logic.ts';
import { createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';
import { queueServedNotice, servedNoticeSteps, takeServedNotices } from '../antigravity/served-notice.ts';
import { evaluateAntigravityWorkflowCall } from '../antigravity/workflow-guard.ts';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const PREFLIGHT = path.join(import.meta.dir, '..', 'antigravity', 'preflight.ts');
const ARGON_HIGH = 'gemini-4-argon-high'; // pro 15 * 1.5 = 22.5
const HYDROGEN_HIGH = 'gemini-4-hydrogen-tiered-high'; // flash 3 * 1.5 = 4.5
const HYDROGEN_XHIGH = 'gemini-4-hydrogen-tiered-xhigh'; // flash 3 * 2 = 6
const HYDROGEN_MEDIUM = 'gemini-4-hydrogen-medium'; // flash 3 * 1 = 3

describe('the served-model table (verified on Antigravity 1.5.14)', () => {
  it('states the version it was verified on and the three served models', () => {
    expect(ANTIGRAVITY_SERVED_VERIFIED_ON).toBe('1.5.14');
    expect(SERVED_BY_ENUM).toEqual({
      flash_lite: { servedModel: 'gemini-3.5-flash-lite', effort: null },
      flash: { servedModel: 'gemini-4-hydrogen-tiered-high', effort: 'high' },
      pro: { servedModel: 'gemini-4-hydrogen-tiered-xhigh', effort: 'xhigh' }
    });
  });

  it('a named Model is served as the table says, under every parent; inherit and omitted are the parent', () => {
    for (const parent of [ARGON_HIGH, 'gemini-4-neon-xhigh', 'claude-opus-5-5-high', HYDROGEN_MEDIUM]) {
      expect(servedModelExpected('pro', parent)).toMatchObject({ kind: 'enum', servedModel: HYDROGEN_XHIGH, effort: 'xhigh', tier: 'flash' });
      expect(servedModelExpected('flash', parent)).toMatchObject({ kind: 'enum', servedModel: HYDROGEN_HIGH, effort: 'high', tier: 'flash' });
      expect(servedModelExpected('flash_lite', parent)).toMatchObject({ kind: 'enum', servedModel: 'gemini-3.5-flash-lite', effort: null, tier: 'flash_lite' });
      expect(servedModelExpected('inherit', parent)).toMatchObject({ kind: 'parent', servedModel: parent });
      expect(servedModelExpected(undefined, parent)).toMatchObject({ kind: 'parent', servedModel: parent });
    }
    expect(servedModelExpected('inherit', ARGON_HIGH)).toMatchObject({ effort: 'high', tier: 'pro' });
    expect(servedModelExpected('inherit', 'claude-opus-5-5-high')).toMatchObject({ effort: 'high', tier: 'pro' });
    // an id that is not an enum value is taken as written
    expect(servedModelExpected('gemini-3.8-flash-high', ARGON_HIGH)).toMatchObject({ kind: 'as-requested', servedModel: 'gemini-3.8-flash-high', effort: 'high', tier: 'flash' });
    // no parent known: nothing is claimed
    expect(servedModelExpected('inherit', undefined)).toMatchObject({ kind: 'parent', servedModel: null, tier: null });
  });

  it('the enum is read case-insensitively and flash-lite is flash_lite', () => {
    expect(subagentEnumOf(' PRO ')).toBe('pro');
    expect(subagentEnumOf('flash-lite')).toBe('flash_lite');
    expect(subagentEnumOf('inherit')).toBeNull();
    expect(subagentEnumOf('gemini-4-argon-high')).toBeNull();
    expect(requestedTierOf('pro')).toBe('pro'); // what the agent asked for, in the words of the enum
  });

  it('labels the served ids a person would read', () => {
    expect(servedModelLabel(HYDROGEN_XHIGH)).toBe('Gemini 4 Hydrogen (xhigh)');
    expect(servedModelLabel(HYDROGEN_HIGH)).toBe('Gemini 4 Hydrogen (high)');
    expect(servedModelLabel('gemini-4-argon-high')).toBe('Gemini 4 Argon (high)');
    expect(servedModelLabel('gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite');
  });
});

describe('the cost gate prices an enum value by the model it is served on', () => {
  it('Model "pro" costs as Hydrogen at xhigh (flash weight times 2), not as pro', () => {
    const gate = antigravityCostGate('pro', 'pro', ARGON_HIGH);
    expect(gate).toMatchObject({ kind: 'pass', callCost: 6, callModel: HYDROGEN_XHIGH, callEffort: 'xhigh', sessionCost: 22.5 });
    expect(antigravityCostFields('pro', ARGON_HIGH)).toMatchObject({ costEstimate: 6, sessionCost: 22.5, costRatio: 0.267, servedModelExpected: HYDROGEN_XHIGH });
  });

  it('on an Argon session every enum value passes; the only way onto Argon is inherit on an Argon session (the parent\'s cost)', () => {
    for (const m of ['flash_lite', 'flash', 'pro']) expect(antigravityCostGate(m, 'pro', ARGON_HIGH).kind).toBe('pass');
    expect(antigravityCostFields('inherit', ARGON_HIGH)).toMatchObject({ costEstimate: 22.5, costRatio: 1, servedModelExpected: ARGON_HIGH });
  });

  it('Model inherit or omitted costs as the parent\'s model', () => {
    expect(antigravityCostFields('inherit', 'gemini-4-neon-xhigh')).toMatchObject({ costEstimate: 30, sessionCost: 30, costRatio: 1, servedModelExpected: 'gemini-4-neon-xhigh' });
    expect(antigravityCostFields(undefined, 'claude-opus-5-5-high')).toMatchObject({ costEstimate: 22.5, costRatio: 1, servedModelExpected: 'claude-opus-5-5-high' });
  });

  it('on a flash ceiling: flash and flash_lite pass at every session effort (the ceiling alias is the floor), pro is held unless the session is at xhigh', () => {
    for (const session of ['gemini-4-hydrogen-low', HYDROGEN_MEDIUM, 'gemini-4-hydrogen-high']) {
      expect(antigravityCostGate('flash', 'flash', session).kind).toBe('pass');
      expect(antigravityCostGate('flash_lite', 'flash', session).kind).toBe('pass');
      expect(antigravityCostGate('pro', 'flash', session)).toMatchObject({ kind: 'over', cause: 'effort', callCost: 6 });
    }
    expect(antigravityCostGate('pro', 'flash', 'gemini-4-hydrogen-xhigh').kind).toBe('pass');
  });

  it('under an Orchestrator (flash ceiling at the planner\'s effort) the same rule holds', () => {
    // planner Argon at high: the ceiling is flash at high (4.5), pro is Hydrogen xhigh (6)
    expect(antigravityCostGate('pro', 'flash', ARGON_HIGH)).toMatchObject({ kind: 'over', callCost: 6, limit: 4.5 });
    expect(antigravityCostGate('pro', 'flash', 'gemini-4-argon-xhigh').kind).toBe('pass');
  });

  it('a full id is held to the session\'s own cost as before (the floor is for enum values only)', () => {
    expect(antigravityCostGate('gemini-3.8-flash-high', 'flash', 'gemini-3.8-flash-low')).toMatchObject({ kind: 'over', cause: 'effort' });
  });

  it('what the user named in the prompt still lets pro through, as instructed', () => {
    const input: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'use manual pro approval for this',
      modelName: 'gemini-3.8-flash-low',
      toolCall: { id: 't1', name: 'invoke_subagent', args: { TypeName: 'w', Model: 'pro' } }
    };
    expect(evaluateAntigravitySubagentCall(input, { sessionModelOverride: 'gemini-3.8-flash-low', now: () => 1 })).toMatchObject({ decision: 'allow', elevation: 'instructed' });
  });

  it('an enum value is its own marker (pro, not pro-xhigh) and a clamp lowers the value itself', () => {
    const gate = antigravityCostGate('pro', 'flash', 'gemini-3.8-flash-low');
    if (gate.kind !== 'over') throw new Error('expected over');
    expect(antigravityMarkerModel('pro', gate)).toBe('pro');
    // pro (6) and flash... flash at high is 4.5 and the limit is 4.5: flash is what fits
    expect(antigravityClampModel('pro', gate, 'flash')).toBe('flash');
  });
});

describe('the decision, the reason and the cost_gate state', () => {
  let dir = '';
  let approvals: ApprovalStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-served-'));
    approvals = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sub = (model: string | undefined, session: string): AntigravityHookInput => ({
    conversationId: 'c1',
    lastUserInput: 'run it',
    modelName: session,
    toolCall: { id: 't1', name: 'invoke_subagent', args: { TypeName: 'worker', ...(model ? { Model: model } : {}) } }
  });
  const decide = (input: AntigravityHookInput, elevationMode: 'choice' | 'dialog' | 'clamp' = 'choice') =>
    evaluateAntigravitySubagentCall(input, { approvals, sessionModelOverride: input.modelName, elevationMode, now: () => 1_000 });

  it('pro that is held says plainly what it runs on, and how to reach Argon', () => {
    const held = decide(sub('pro', HYDROGEN_MEDIUM));
    expect(held).toMatchObject({ decision: 'deny', elevation: 'denied' });
    expect(held.reason).toContain(PRO_SERVED_SENTENCE);
    expect(held.reason).toContain(ARGON_HOW_SENTENCE);
    expect(held.reason).toContain('says plainly "Model "pro" is served on Gemini 4 Hydrogen (xhigh), flash class"');
    expect(held.reason).toContain("'[jev-elevate:pro]'");
    expect(antigravityCostGateState(sub('pro', HYDROGEN_MEDIUM), held, {})).toBe('denied');
  });

  it('pro that no longer exceeds the gate simply passes (its real cost is flash class)', () => {
    expect(decide(sub('pro', ARGON_HIGH))).toEqual({ decision: 'pass' });
    expect(decide(sub('pro', 'gemini-4-hydrogen-xhigh'))).toEqual({ decision: 'pass' });
    expect(antigravityCostGateState(sub('pro', ARGON_HIGH), { decision: 'pass' }, {})).toBe('pass');
  });

  it('the dialog reason says it too, and the clamp lowers pro to the enum value that fits', () => {
    const asked = decide(sub('pro', HYDROGEN_MEDIUM), 'dialog');
    expect(asked.decision).toBe('ask');
    expect(asked.reason).toContain(PRO_SERVED_SENTENCE);
    expect(decide(sub('pro', HYDROGEN_MEDIUM), 'clamp')).toMatchObject({ decision: 'allow', elevation: 'clamped', overwrite: { Model: 'flash' }, clampedTo: 'flash' });
    expect(decide(sub('pro', 'gemini-4-hydrogen-low'), 'clamp')).toMatchObject({ overwrite: { Model: 'flash' } });
  });

  it('an approval of pro covers pro (the effort is in what pro is)', () => {
    approvals.deny('c1', 'pro', 500);
    approvals.record('c1', { model: 'pro', scope: 'session', created_at: 600 });
    expect(decide(sub('pro', HYDROGEN_MEDIUM))).toMatchObject({ decision: 'allow', elevation: 'approved', approvalScope: 'session' });
  });

  it('an approval of the enum pro does not cover a real pro-class full id; a full-id approval does, and the question never says Hydrogen for it (2.3.19 review)', () => {
    const FLASH_LOW_SESSION = 'gemini-3.8-flash-low';
    approvals.deny('c1', 'pro', 500);
    approvals.record('c1', { model: 'pro', scope: 'session', created_at: 600 });
    // the enum approval is real: it covers the enum value
    expect(decide(sub('pro', FLASH_LOW_SESSION))).toMatchObject({ decision: 'allow', elevation: 'approved' });
    for (const id of ['gemini-4-argon-high', 'claude-opus-5-5-high', 'gemini-4-argon']) {
      const held = decide(sub(id, FLASH_LOW_SESSION));
      expect(held).toMatchObject({ decision: 'deny', elevation: 'denied' });
      expect(held.reason).not.toContain('Hydrogen');
      expect(held.reason).not.toContain('[jev-elevate:pro]');
    }
    // the full id is asked under its own marker, and an approval of that marker covers it
    const asked = decide(sub('gemini-4-argon-high', FLASH_LOW_SESSION));
    expect(asked.reason).toContain("'[jev-elevate:pro-high]'");
    approvals.deny('c1', 'pro-high', 700);
    approvals.record('c1', { model: 'pro-high', scope: 'session', created_at: 800 });
    expect(decide(sub('gemini-4-argon-high', FLASH_LOW_SESSION))).toMatchObject({ decision: 'allow', elevation: 'approved' });
    expect(decide(sub('claude-opus-5-5-high', FLASH_LOW_SESSION))).toMatchObject({ decision: 'allow', elevation: 'approved' });
  });

  it('the clamp of a full id lands within the limit: flash_lite when the ceiling alias (Hydrogen at high) costs more than the session', () => {
    // flash ceiling on a low-effort session: limit 1.5, `flash` is served at 4.5
    const clamped = decide(sub('gemini-4-argon-low', 'gemini-3.8-flash-low'), 'clamp');
    expect(clamped).toMatchObject({ decision: 'allow', elevation: 'clamped', overwrite: { Model: 'flash_lite' }, clampedTo: 'flash_lite' });
  });

  it('flash is never held on a flash ceiling, so "No, proceed on flash" cannot loop', () => {
    for (const session of ['gemini-4-hydrogen-low', HYDROGEN_MEDIUM, 'gemini-4-hydrogen-high']) expect(decide(sub('flash', session))).toEqual({ decision: 'pass' });
  });
});

describe('the guidance texts', () => {
  it('a text for pro says it runs on Hydrogen (xhigh) and how to reach Argon; flash and flash_lite say what they are; a full id says nothing', () => {
    expect(servedModelGuidance('pro')).toBe(`${PRO_SERVED_SENTENCE} ${ARGON_HOW_SENTENCE}`);
    expect(PRO_SERVED_SENTENCE).toContain('Gemini 4 Hydrogen (xhigh)');
    expect(PRO_SERVED_SENTENCE).toContain('flash-class');
    expect(ARGON_HOW_SENTENCE).toBe('A subagent on Argon needs the session itself on Gemini 4 Argon, with Model "inherit".');
    expect(servedModelGuidance('flash')).toBe('Model "flash" is served on Gemini 4 Hydrogen (high), flash class.');
    expect(servedModelGuidance('gemini-3.8-flash-high')).toBe('');
    expect(servedQuestionPhrase('pro')).toBe('Model "pro" is served on Gemini 4 Hydrogen (xhigh), flash class');
  });
});

describe('servedBelowRequested', () => {
  it('pro served on Hydrogen xhigh is below what pro names; the same tier or higher, inherit and unranked ids are not', () => {
    expect(servedBelowRequested('pro', HYDROGEN_XHIGH)).toMatchObject({ requested: 'pro', requestedTier: 'pro', servedTier: 'flash', servedModel: HYDROGEN_XHIGH });
    expect(servedBelowRequested('flash', HYDROGEN_HIGH)).toBeNull();
    expect(servedBelowRequested('flash_lite', 'gemini-3.5-flash-lite')).toBeNull();
    expect(servedBelowRequested('flash', 'gemini-3.5-flash-lite')).toMatchObject({ servedTier: 'flash_lite' });
    expect(servedBelowRequested('inherit', HYDROGEN_HIGH)).toBeNull();
    expect(servedBelowRequested(undefined, HYDROGEN_HIGH)).toBeNull();
    expect(servedBelowRequested('pro', 'gpt-oss-120b-medium')).toBeNull();
    expect(servedBelowRequested('pro', ARGON_HIGH)).toBeNull();
  });

  it('the line is short, names both, and says how to reach Argon only for pro', () => {
    const b = servedBelowRequested('pro', HYDROGEN_XHIGH)!;
    expect(servedBelowNotice(b)).toBe(
      '[jev] Subagent asked for pro, served on gemini-4-hydrogen-tiered-xhigh (flash class). For Argon, run the session on Gemini 4 Argon and use Model: inherit.'
    );
    expect(servedBelowNotice(servedBelowRequested('flash', 'gemini-3.5-flash-lite')!)).toBe('[jev] Subagent asked for flash, served on gemini-3.5-flash-lite (flash_lite class).');
  });
});

describe('the notice queue (mode on only, once per conversation per pair)', () => {
  let dir = '';
  beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-notice-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const SESSION = '00000000-0000-4000-8000-000000000042';

  it('mode on queues one line once per (requested, served) pair and delivers it once', () => {
    expect(queueServedNotice(dir, SESSION, 'pro', HYDROGEN_XHIGH, 'on')).toContain('asked for pro, served on gemini-4-hydrogen-tiered-xhigh');
    expect(queueServedNotice(dir, SESSION, 'pro', HYDROGEN_XHIGH, 'on')).toBeNull(); // the same pair again
    expect(takeServedNotices(dir, SESSION, 'on')).toHaveLength(1);
    expect(takeServedNotices(dir, SESSION, 'on')).toEqual([]); // delivered once
    expect(queueServedNotice(dir, SESSION, 'pro', HYDROGEN_XHIGH, 'on')).toBeNull(); // and remembered after delivery
    // a different pair is a different notice; another conversation has its own
    expect(queueServedNotice(dir, SESSION, 'flash', 'gemini-3.5-flash-lite', 'on')).not.toBeNull();
    expect(queueServedNotice(dir, '00000000-0000-4000-8000-000000000043', 'pro', HYDROGEN_XHIGH, 'on')).not.toBeNull();
  });

  it('on-demand and off queue nothing and write no file; a call that was served as asked queues nothing', () => {
    expect(queueServedNotice(dir, SESSION, 'pro', HYDROGEN_XHIGH, 'on-demand')).toBeNull();
    expect(queueServedNotice(dir, SESSION, 'pro', HYDROGEN_XHIGH, 'off')).toBeNull();
    expect(queueServedNotice(dir, SESSION, 'flash', HYDROGEN_HIGH, 'on')).toBeNull();
    expect(queueServedNotice(dir, SESSION, 'inherit', HYDROGEN_HIGH, 'on')).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(takeServedNotices(dir, SESSION, 'on-demand')).toEqual([]);
  });

  it('the injection step shows the user the line (systemMessage with user_markdown)', () => {
    expect(servedNoticeSteps(['[jev] x'])).toEqual([{ systemMessage: { systemMessage: '[jev] x', metadata: { user_markdown: '[jev] x' } } }]);
  });
});

describe('the hook and the pre-flight, as processes', () => {
  let home = '';
  const CONV = '00000000-0000-4000-8000-0000000000aa';
  const CHILD = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-served-proc-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 4 Hydrogen (Medium)' }));
    const logs = path.join(home, '.gemini', 'antigravity-cli', 'brain', CHILD, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), `{"step_index":0,"model":"${HYDROGEN_XHIGH}","type":"MODEL","content":"hello"}\n`);
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const setMode = (mode: string) => fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode } }));
  const env = () => ({
    ...process.env,
    HOME: home,
    JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'),
    JEV_TELEMETRY_FILE: path.join(home, 'telemetry.jsonl'),
    JEV_QUOTA_STATE_FILE: path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'),
    JEV_DOWNGRADE: 'off'
  });
  const hook = (event: string, input: object) => Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env() });
  const preflight = () =>
    Bun.spawnSync(['bun', PREFLIGHT], {
      stdin: new TextEncoder().encode(JSON.stringify({ conversationId: CONV, modelName: 'gemini-4-hydrogen-medium', lastUserInput: 'continue please', invocationNum: 2 })),
      env: env()
    });
  const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const decisions = () => lines(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl'));
  const post = (model: string) =>
    hook('post-tool-use', {
      conversationId: CONV,
      modelName: 'gemini-4-hydrogen-medium',
      toolCall: { id: `call_${model}`, name: 'invoke_subagent', args: { TypeName: 'coder', Model: model } },
      content: `Subagent started. Conversation ID: ${CHILD}`
    });
  const notice = (res: ReturnType<typeof preflight>): string[] => {
    const out = JSON.parse(res.stdout.toString() || '{}');
    return (out.injectSteps ?? []).filter((s: any) => s.systemMessage).map((s: any) => s.systemMessage.metadata.user_markdown);
  };

  it('mode on: the PostToolUse prints {} and the next pre-flight shows the notice once; a repeat of the same pair adds nothing', () => {
    setMode('on');
    const res = post('pro');
    expect(res.stdout.toString().trim()).toBe('{}');
    expect(decisions().find((e) => e.event === 'subagent_served')).toMatchObject({ requested_model: 'pro', served_model: HYDROGEN_XHIGH });

    const first = notice(preflight());
    expect(first).toEqual([
      '[jev] Subagent asked for pro, served on gemini-4-hydrogen-tiered-xhigh (flash class). For Argon, run the session on Gemini 4 Argon and use Model: inherit.'
    ]);
    expect(notice(preflight())).toEqual([]);

    post('pro');
    expect(notice(preflight())).toEqual([]);
  });

  it('mode on-demand: the served row is still written (telemetry) and nothing is shown or queued', () => {
    setMode('on-demand');
    post('pro');
    expect(decisions().find((e) => e.event === 'subagent_served')).toMatchObject({ requested_model: 'pro', served_model: HYDROGEN_XHIGH });
    expect(lines(path.join(home, 'telemetry.jsonl')).find((e) => e.event === 'subagent_served')).toMatchObject({ requestedModel: 'pro', servedModel: HYDROGEN_XHIGH });
    expect(notice(preflight())).toEqual([]);
    expect(fs.readdirSync(path.join(home, '.config', 'jev', 'antigravity-sessions')).filter((f) => f.endsWith('.served-notice.json'))).toEqual([]);
  });

  it('mode off: nothing is written at all', () => {
    setMode('off');
    post('pro');
    expect(fs.existsSync(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl'))).toBe(false);
    expect(notice(preflight())).toEqual([]);
  });

  it('a call served as asked (flash on Hydrogen high) shows nothing', () => {
    setMode('on');
    const logs = path.join(home, '.gemini', 'antigravity-cli', 'brain', CHILD, '.system_generated', 'logs');
    fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), `{"step_index":0,"model":"${HYDROGEN_HIGH}","type":"MODEL"}\n`);
    post('flash');
    expect(notice(preflight())).toEqual([]);
  });

  it('a served model found late (the backfill of a pending call) queues the notice too, and the pre-flight delivers it', () => {
    setMode('on');
    const parentTranscript = path.join(home, 'parent-transcript.jsonl');
    const LATE_CHILD = 'b1b2c3d4-e5f6-7890-abcd-ef1234567890';
    fs.writeFileSync(parentTranscript, '{"step_index":0,"type":"USER_INPUT","content":"hi"}\n');
    hook('post-tool-use', {
      conversationId: CONV,
      stepIdx: 1,
      transcriptPath: parentTranscript,
      toolCall: { id: 'call_late', name: 'invoke_subagent', args: { TypeName: 'research', Model: 'pro' } }
    });
    expect(notice(preflight())).toEqual([]); // nothing is known yet

    fs.appendFileSync(parentTranscript, JSON.stringify({ step_index: 1, type: 'GENERIC', content: `Created subagent ${LATE_CHILD}` }) + '\n');
    const logs = path.join(home, '.gemini', 'antigravity-cli', 'brain', LATE_CHILD, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), `{"step_index":1,"type":"PLANNER_RESPONSE","model":"${HYDROGEN_XHIGH}"}\n`);

    // the pre-flight itself flushes the pending record, then delivers what that queued
    expect(notice(preflight())).toEqual([
      '[jev] Subagent asked for pro, served on gemini-4-hydrogen-tiered-xhigh (flash class). For Argon, run the session on Gemini 4 Argon and use Model: inherit.'
    ]);
    expect(decisions().find((e) => e.event === 'subagent_served' && e.backfilled === true)).toMatchObject({ requested_model: 'pro' });
  });

  it('the decisions row and the telemetry row of the call keep requested_model and add servedModelExpected', () => {
    setMode('on');
    const res = hook('pre-tool-use', {
      conversationId: CONV,
      lastUserInput: 'Invoke a coder',
      modelName: ARGON_HIGH,
      toolCall: { id: 'call_pre', name: 'invoke_subagent', args: { TypeName: 'coder', Prompt: 'x', Model: 'pro' } }
    });
    expect(res.stdout.toString().trim()).toBe(''); // pro on an Argon session passes: its real cost is flash class
    const row = decisions().find((e) => e.event === 'agent_call')!;
    expect(row).toMatchObject({ requested_model: 'pro', decision: 'pass', cost_gate: 'pass', costEstimate: 6, sessionCost: 22.5, servedModelExpected: HYDROGEN_XHIGH });
    expect(lines(path.join(home, 'telemetry.jsonl')).find((e) => e.event === 'agent_call')).toMatchObject({ requestedModel: 'pro', servedModelExpected: HYDROGEN_XHIGH, costEstimate: 6 });
  });
});

describe('run_workflow: the same served model rule for agent(model=...) literals', () => {
  let tmp = '';
  let approvals: ApprovalStore;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wf-served-'));
    approvals = createAntigravityApprovalStore(path.join(tmp, 'sessions'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const wf = (session: string, script: string) =>
    evaluateAntigravityWorkflowCall(
      { conversationId: 'conv-wf', modelName: session, lastUserInput: 'run the workflow', toolCall: { id: 'call_wf', name: 'run_workflow', args: { Script: script } } },
      { mode: 'on', sessionModel: session, approvals, pinDir: path.join(tmp, 'pins'), now: () => 1_000_000, definitions: { definition: () => ({ found: false, model: null }) } }
    );
  const PRO = 'await agent("p", model="pro")';

  it('a pro literal on a flash session is held and the reason says what pro runs on and how to reach Argon', () => {
    const r = wf('gemini-4-hydrogen-medium', PRO);
    expect(r.decision.decision).toBe('deny');
    expect(r.decision.reason).toContain(PRO_SERVED_SENTENCE);
    expect(r.decision.reason).toContain(ARGON_HOW_SENTENCE);
    expect(r.decision.reason).toContain('[jev-elevate:pro]');
  });

  it('a pro literal on an Argon session passes: it costs Hydrogen at xhigh, below the session', () => {
    expect(wf(ARGON_HIGH, PRO).decision.decision).toBe('pass');
  });
});

describe('the Orchestrator and standard directives of the pre-flight', () => {
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-directive-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const directive = (modelName: string): string => {
    const res = Bun.spawnSync(['bun', PREFLIGHT], {
      stdin: new TextEncoder().encode(JSON.stringify({ conversationId: '00000000-0000-4000-8000-0000000000bb', modelName, lastUserInput: 'please refactor the billing module', invocationNum: 1 })),
      env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'), JEV_TELEMETRY_FILE: path.join(home, 't.jsonl'), JEV_QUOTA_STATE_FILE: path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json') }
    });
    return String(JSON.parse(res.stdout.toString()).injectSteps?.[0]?.ephemeralMessage ?? '');
  };

  it('the Orchestrator directive says what pro runs on and how to reach Argon, and no longer sends the agent to pro for a pro-class model', () => {
    const d = directive('gemini-pro-orchestrator-g1-pro');
    expect(d).toContain('ORCHESTRATOR ENFORCEMENT');
    expect(d).toContain(PRO_SERVED_SENTENCE);
    expect(d).toContain(ARGON_HOW_SENTENCE);
    expect(d).toContain('Do not request "pro" to get a pro-class model');
    expect(d).not.toContain('Pro elevation requires [jev-elevate:pro]');
  });

  it('the standard directive says it too', () => {
    const d = directive('gemini-4-hydrogen-medium');
    expect(d).toContain('AGGRESSIVE ENFORCEMENT');
    expect(d).toContain(PRO_SERVED_SENTENCE);
    expect(d).toContain(ARGON_HOW_SENTENCE);
    expect(d).not.toContain('Pro tier (pro) strictly requires explicit manual user approval');
  });
});

describe('Claude Code is unchanged: it serves what it is asked', () => {
  it('its cost fields price the requested model as written and carry no servedModelExpected', () => {
    const fields = costFields({ model: 'opus', effort: 'high' }, { model: 'opus', effort: 'high' });
    expect(fields).toEqual({ costEstimate: 22.5, sessionCost: 22.5, costRatio: 1, costWeightsVersion: 1 });
    expect('servedModelExpected' in fields).toBe(false);
    // opus costs as opus (pro weight), sonnet as sonnet: nothing is re-priced by an enum
    expect(costFields({ model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'high' })).toMatchObject({ costEstimate: 4.5, costRatio: 0.2 });
    expect(costFields({ model: 'opus', effort: 'xhigh' }, { model: 'sonnet', effort: 'high' })).toMatchObject({ costEstimate: 30, costRatio: 6.667 });
  });

  it('the Claude hook rows are the same as before: no served field, and no notice state is ever written', async () => {
    const { onPreToolUse } = await import('../claude/hook.ts');
    const { rig } = await import('./workflow-helpers.ts');
    const r = rig({}, 'claude-sonnet-5-5');
    try {
      const o = await onPreToolUse(
        { session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', cwd: r.project, tool_input: { description: 'd', model: 'opus' } as any, effort: 'high' },
        r.d
      );
      expect(JSON.stringify(o)).toContain('deny');
      const row = r.logs.at(-1) as Record<string, any>;
      expect(row).toMatchObject({ decision: 'deny', costEstimate: 22.5 });
      expect('servedModelExpected' in row).toBe(false);
    } finally {
      r.cleanup();
    }
  });
});
