/**
 * 2.3.20 telemetry precision: `denyCause` / `askCause` on held calls (both harnesses), `quotaPool` by the model a subagent is served on,
 * and `mode` (plus `previousMode` for jev_set_mode) on the rows MCP tools write.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPreToolUse, telemetryEvent, type HookInput } from '../claude/hook.ts';
import { buildCatalogue } from '../src/core/catalogue.ts';
import type { RankContext } from '../claude/logic.ts';
import { causeFields, asDenyCause } from '../src/core/deny-cause.ts';
import { quotaPoolOfModel, servedQuotaPool } from '../src/core/served-model.ts';
import { poolForTier, type QuotaView } from '../src/core/governance.ts';
import { createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';
import {
  buildAntigravityTelemetryEvent,
  evaluateAntigravitySubagentCall,
  quotaPoolField,
  subagentQuotaPool,
  type AntigravityHookInput
} from '../antigravity/logic.ts';
import { evaluateAntigravityWorkflowCall } from '../antigravity/workflow-guard.ts';
import { logTelemetry, telemetryFile } from '../src/core/telemetry.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';
import { handleSetModeTool } from '../src/tools/mode.ts';
import { rig, wf, type Rig } from './workflow-helpers.ts';

describe('deny-cause helpers', () => {
  it('causeFields names a deny denyCause, an ask askCause, and nothing else', () => {
    expect(causeFields('deny', 'tier')).toEqual({ denyCause: 'tier' });
    expect(causeFields('ask', 'cost')).toEqual({ askCause: 'cost' });
    expect(causeFields('force_ask', 'cost')).toEqual({ askCause: 'cost' });
    expect(causeFields('pass', 'tier')).toEqual({});
    expect(causeFields('deny', undefined)).toEqual({});
    expect(asDenyCause('effort-interim')).toBe('effort-interim');
    expect(asDenyCause('nope')).toBeUndefined();
  });
});

describe('quota pool by the model served (Antigravity 1.5.14)', () => {
  it('quotaPoolOfModel: Gemini families, enum values by served model, Opus on Argon, Sonnet on 3p', () => {
    expect(quotaPoolOfModel('flash_lite')).toBe('gemini');
    expect(quotaPoolOfModel('flash')).toBe('gemini');
    expect(quotaPoolOfModel('pro')).toBe('gemini'); // served on gemini-4-hydrogen-tiered-xhigh
    expect(quotaPoolOfModel('gemini-4-hydrogen-tiered-xhigh')).toBe('gemini');
    expect(quotaPoolOfModel('gemini-3.5-flash-lite')).toBe('gemini');
    expect(quotaPoolOfModel('gemini-4-argon-high')).toBe('argon');
    expect(quotaPoolOfModel('gemini-4-neon-xhigh')).toBe('argon');
    expect(quotaPoolOfModel('gemini-4-carbon-high')).toBe('argon');
    expect(quotaPoolOfModel('claude-opus-5-5-high')).toBe('argon');
    expect(quotaPoolOfModel('claude-sonnet-5-5-high')).toBe('3p');
    expect(quotaPoolOfModel('claude-haiku-5-5')).toBe('3p');
    expect(quotaPoolOfModel('inherit')).toBeNull();
    expect(quotaPoolOfModel('')).toBeNull();
  });

  it('servedQuotaPool: inherit is the parent pool; an enum value ignores the parent', () => {
    expect(servedQuotaPool('inherit', 'claude-sonnet-5-5-high')).toBe('3p');
    expect(servedQuotaPool(undefined, 'gemini-4-argon-high')).toBe('argon');
    expect(servedQuotaPool('inherit', 'claude-opus-5-5-high')).toBe('argon');
    expect(servedQuotaPool('pro', 'gemini-4-argon-high')).toBe('gemini');
    expect(servedQuotaPool('pro', 'claude-sonnet-5-5-high')).toBe('gemini');
    expect(servedQuotaPool('inherit', null)).toBe('gemini');
    expect(servedQuotaPool('claude-opus-5-5-high', 'gemini-4-hydrogen-tiered-high')).toBe('argon');
  });

  it('subagentQuotaPool prefers the model the call was really served on', () => {
    expect(subagentQuotaPool('inherit', 'claude-sonnet-5-5-high', 'gemini-4-argon-high')).toBe('3p');
    expect(subagentQuotaPool('pro', null, 'gemini-4-argon-high')).toBe('gemini');
    expect(quotaPoolField('inherit', null, null)).toEqual({});
    expect(quotaPoolField('pro', null, null)).toEqual({ quotaPool: 'gemini' });
  });

  const thresholds = { normal_min: 0.3, conserve_min: 0.1, five_hour_normal_min: 0.3, five_hour_conserve_min: 0.1, weekly_normal_min: 0.2, weekly_conserve_min: 0.1 };
  const bucket = (f: number) => ({ remaining_fraction: f, effective_remaining_fraction: f }) as any;
  const view = (active_model: string): QuotaView => ({
    source: 't',
    schema: 2,
    stale: false,
    updated_at: 1,
    active_model,
    buckets: {
      'gemini-5h': bucket(0.8),
      'gemini-weekly': bucket(0.7),
      'gemini-argon-wtu-weekly': bucket(0.05),
      '3p-5h': bucket(0.9),
      '3p-weekly': bucket(0.4)
    },
    gemini: { five_hour: 0.8, weekly: 0.7, min_remaining: 0.7 },
    strategy: 'normal',
    thresholds,
    geminiRemainingFraction: 0.7,
    active: { pool: 'gemini', five_hour: 0.8, weekly: 0.7, min_remaining: 0.7, strategy: 'normal' }
  });

  it('a non-Orchestrator view: pro draws Gemini (not Argon), Argon draws the worse of Argon and Gemini, Sonnet draws 3p', () => {
    const v = view('gemini-4-hydrogen-tiered-high');
    expect(poolForTier(v, 'pro')).toBe(v.active);
    expect(poolForTier(v, 'flash')).toBe(v.active);
    const argon = poolForTier(v, 'gemini-4-argon-high');
    expect(argon).toMatchObject({ pool: 'frontier', weekly: 0.05, strategy: 'free_only' });
    expect(poolForTier(v, 'claude-opus-5-5-high')).toMatchObject({ pool: 'frontier', weekly: 0.05 });
    expect(poolForTier(v, 'claude-sonnet-5-5-high')).toMatchObject({ pool: '3p', five_hour: 0.9, weekly: 0.4, min_remaining: 0.4 });
    expect(poolForTier(v, 'inherit')).toBe(v.active);
  });

  it('inherit follows the parent: a Sonnet parent is the 3p pool', () => {
    const v = view('claude-sonnet-5-5-high');
    v.active = { pool: '3p', five_hour: 0.9, weekly: 0.4, min_remaining: 0.4, strategy: 'normal' };
    expect(poolForTier(v, 'inherit')).toBe(v.active);
    expect(poolForTier(v, 'pro')).toMatchObject({ weekly: 0.7 });
  });

  it('the agent_call and subagent_served telemetry rows carry quotaPool', () => {
    const base = { conversationId: 'c', inputModelName: 'gemini-4-argon-high', decision: { decision: 'pass' as const } };
    const call = (Model?: string) =>
      buildAntigravityTelemetryEvent({ kind: 'agent_call', ...base, args: Model ? { Model, TypeName: 't' } : { TypeName: 't' } });
    expect(call('pro').quotaPool).toBe('gemini');
    expect(call('flash_lite').quotaPool).toBe('gemini');
    expect(call().quotaPool).toBe('argon'); // inherit under an Argon parent
    expect(call('claude-opus-5-5-high').quotaPool).toBe('argon');
    const sonnetParent = buildAntigravityTelemetryEvent({ kind: 'agent_call', ...base, inputModelName: 'claude-sonnet-5-5-high', args: { TypeName: 't' } });
    expect(sonnetParent.quotaPool).toBe('3p');
    const served = buildAntigravityTelemetryEvent({
      kind: 'subagent_served',
      conversationId: 'c',
      childConversationId: 'k',
      requestedModel: 'inherit',
      servedModel: 'claude-sonnet-5-5-high',
      inputModelName: 'claude-sonnet-5-5-high'
    });
    expect(served.quotaPool).toBe('3p');
  });
});

describe('Antigravity denyCause / askCause', () => {
  let dir = '';
  let approvals: ApprovalStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dc-'));
    approvals = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const FLASH = 'gemini-3.8-flash-low';
  const PRO_HIGH = 'gemini-3.5-pro-high';
  const sub = (model: string | undefined, session: string, extra: Partial<AntigravityHookInput> = {}): AntigravityHookInput => ({
    conversationId: 'c1',
    lastUserInput: 'run it',
    modelName: session,
    toolCall: { id: 't1', name: 'invoke_subagent', args: { TypeName: 'worker', Prompt: 'x', ...(model ? { Model: model } : {}) } },
    ...extra
  });
  const decide = (input: AntigravityHookInput, o: Record<string, unknown> = {}) =>
    evaluateAntigravitySubagentCall(input, { approvals, sessionModelOverride: input.modelName, elevationMode: 'choice', now: () => 1_000, ...o } as any);

  it('tier: a stronger model than the session (shadow: the rank ceiling)', () => {
    expect(decide(sub('pro', FLASH))).toMatchObject({ decision: 'deny', cause: 'tier' });
  });

  it('tier under enforce for a full id above the ceiling, even when the gate is over too', () => {
    expect(decide(sub('gemini-4-argon-low', FLASH), { costGateMode: 'enforce' })).toMatchObject({ decision: 'deny', cause: 'tier' });
  });

  it('cost: the enforced gate held a same-tier call by its effort', () => {
    expect(decide(sub('gemini-3.5-pro-xhigh', PRO_HIGH), { costGateMode: 'enforce' })).toMatchObject({ decision: 'deny', cause: 'cost' });
  });

  it('orchestrator: the omitted-model rule, and the flash ceiling', () => {
    expect(decide(sub(undefined, 'gemini-4-argon-high'), { sessionOrchestrator: true })).toMatchObject({ decision: 'deny', cause: 'orchestrator' });
    expect(decide(sub('pro', FLASH), { sessionOrchestrator: true })).toMatchObject({ decision: 'deny', cause: 'orchestrator' });
  });

  it('unranked: an unrecognised or free model', () => {
    expect(decide(sub('gpt-oss-120b-medium', FLASH))).toMatchObject({ decision: 'deny', cause: 'unranked' });
    expect(decide(sub('openrouter/free', FLASH))).toMatchObject({ decision: 'deny', cause: 'unranked' });
  });

  it('dialog ask carries the cause (askCause on the row)', () => {
    const d = decide(sub('pro', FLASH), { elevationMode: 'dialog' });
    expect(d).toMatchObject({ decision: 'ask', cause: 'tier' });
    expect(causeFields(d.decision, d.cause)).toEqual({ askCause: 'tier' });
  });

  it('a pass carries no cause, and the telemetry row has denyCause only on a deny', () => {
    const held = decide(sub('pro', FLASH));
    const row = buildAntigravityTelemetryEvent({ kind: 'agent_call', conversationId: 'c1', inputModelName: FLASH, args: { Model: 'pro' }, decision: held });
    expect(row).toMatchObject({ decision: 'deny', denyCause: 'tier' });
    expect(row.askCause).toBeUndefined();
    const ok = buildAntigravityTelemetryEvent({ kind: 'agent_call', conversationId: 'c1', inputModelName: FLASH, args: { Model: 'flash' }, decision: { decision: 'pass' } });
    expect(ok.denyCause).toBeUndefined();
  });

  it('quota block: its own cause, never a cost-gate disagreement', () => {
    const quotaView: QuotaView = {
      source: 't', schema: 2, stale: false, updated_at: 1, active_model: FLASH, buckets: {},
      gemini: { five_hour: 0.01, weekly: 0.01, min_remaining: 0.01 }, strategy: 'free_only',
      thresholds: { normal_min: 0.3, conserve_min: 0.1, five_hour_normal_min: 0.3, five_hour_conserve_min: 0.1, weekly_normal_min: 0.2, weekly_conserve_min: 0.1 },
      geminiRemainingFraction: 0.01,
      active: { pool: 'gemini', five_hour: 0.01, weekly: 0.01, min_remaining: 0.01, strategy: 'free_only' }
    };
    expect(decide(sub('flash', FLASH), { quotaView })).toMatchObject({ decision: 'deny', cause: 'quota' });
  });

  it('pro is judged against the Gemini pool, not the exhausted Argon pool (2.3.20)', () => {
    const t = { normal_min: 0.3, conserve_min: 0.1, five_hour_normal_min: 0.3, five_hour_conserve_min: 0.1, weekly_normal_min: 0.2, weekly_conserve_min: 0.1 };
    const quotaView: QuotaView = {
      source: 't', schema: 2, stale: false, updated_at: 1, active_model: 'gemini-4-hydrogen-tiered-high', buckets: {},
      gemini: { five_hour: 0.8, weekly: 0.8, min_remaining: 0.8 }, strategy: 'normal', thresholds: t, geminiRemainingFraction: 0.8,
      active: { pool: 'gemini', five_hour: 0.8, weekly: 0.8, min_remaining: 0.8, strategy: 'normal' },
      orchestrator: true, variant: 'argon',
      pools: {
        execution: { pool: 'execution', five_hour: 0.8, weekly: 0.8, min_remaining: 0.8, strategy: 'normal' },
        frontier: { pool: 'frontier', five_hour: null, weekly: 0, min_remaining: 0, strategy: 'free_only' }
      }
    };
    const d = decide(sub('pro', 'gemini-4-hydrogen-tiered-xhigh'), { quotaView, sessionOrchestrator: false });
    expect(d.cause).not.toBe('quota');
  });

  const wfCall = (script: string): AntigravityHookInput => ({
    conversationId: 'c1', modelName: FLASH, lastUserInput: 'run it', stepIdx: 4,
    toolCall: { id: 'w1', name: 'run_workflow', args: { Script: script } }
  });
  const wfDeps = (extra: object = {}) => ({
    mode: 'on' as const, sessionModel: FLASH, approvals, now: () => 1_000_000,
    definitions: { definition: () => ({ found: false, model: null }) }, ...extra
  });

  it('run_workflow: a script that cannot be verified is unverifiable; a pro agent is tier; a dialog ask carries the cause', () => {
    const dyn = evaluateAntigravityWorkflowCall(wfCall('await agent("p", model=tier)'), wfDeps());
    expect(dyn.decision).toMatchObject({ decision: 'deny', cause: 'unverifiable' });
    const pro = evaluateAntigravityWorkflowCall(wfCall('await agent("p", model="pro")'), wfDeps());
    expect(pro.decision).toMatchObject({ decision: 'deny', cause: 'tier' });
    const dialog = evaluateAntigravityWorkflowCall(wfCall('await agent("p", model="pro")'), wfDeps({ elevationMode: 'dialog' }));
    expect(dialog.decision).toMatchObject({ decision: 'ask', cause: 'tier' });
    const orch = evaluateAntigravityWorkflowCall(wfCall('await agent("p", model="pro")'), wfDeps({ sessionOrchestrator: true }));
    expect(orch.decision).toMatchObject({ decision: 'deny', cause: 'orchestrator' });
  });
});

describe('Claude Code denyCause / askCause', () => {
  let r: Rig;
  afterEach(() => r?.cleanup());
  const CAT = buildCatalogue('claude-code', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].map((id) => ({ id, ok: true })), 'probe', null, new Date('2026-11-12T10:00:00.000Z'));
  const RANK: RankContext = { cat: CAT };
  const call = (toolInput: Record<string, unknown>, extra: Partial<HookInput> = {}): HookInput => ({
    session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', cwd: r.project, tool_input: toolInput as any, effort: 'high', ...extra
  });
  const row = () => r.logs.at(-1) as Record<string, any>;

  it('tier: opus under a sonnet session (shadow and enforce)', async () => {
    r = rig({ rankContext: () => RANK });
    await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'tier' });
    expect(row().askCause).toBeUndefined();
    r.cleanup();
    r = rig({ costGateMode: () => 'enforce', rankContext: () => RANK });
    await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'tier' });
  });

  it('cost: the enforced gate held a same-model call by its effort', async () => {
    r = rig({ costGateMode: () => 'enforce' }, 'claude-sonnet-5-5');
    await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'high' }, { effort: 'medium' }), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'cost' });
  });

  it('effort-interim: the interim xhigh rule applies where the gate does not judge (shadow)', async () => {
    r = rig({}, 'claude-opus-5-5');
    await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'effort-interim' });
  });

  it('unranked: a model Jev cannot rank', async () => {
    r = rig({ rankContext: () => RANK });
    await onPreToolUse(call({ description: 'd', model: 'claude-zephyr-1' }), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'unranked' });
  });

  it('dialog mode: the ask row carries askCause, not denyCause', async () => {
    r = rig({ env: { JEV_ELEVATION: 'dialog' }, rankContext: () => RANK });
    await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d);
    expect(row()).toMatchObject({ decision: 'ask', askCause: 'tier' });
    expect(row().denyCause).toBeUndefined();
  });

  it('assumed session model keeps the real cause and adds sessionModelAssumed', async () => {
    r = rig({ readSessionModel: () => null, rankContext: () => RANK });
    await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'tier', sessionModelAssumed: true });
  });

  it('Workflow: unverifiable script, an opus agent (tier), and the dialog ask', async () => {
    r = rig({ rankContext: () => RANK });
    await onPreToolUse(wf({ script: `await agent('p', {model: args.m})` }, r), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'unverifiable' });
    await onPreToolUse(wf({ script: `await agent('p', {model: 'opus'})` }, r), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'tier' });
    r.cleanup();
    r = rig({ env: { JEV_ELEVATION: 'dialog' }, rankContext: () => RANK });
    await onPreToolUse(wf({ script: `await agent('p', {model: 'opus'})` }, r), r.d);
    expect(row()).toMatchObject({ decision: 'ask', askCause: 'tier' });
  });

  it('a downgrade question is denyCause downgrade (the cause field of the verdict)', () => {
    expect(causeFields('deny', 'downgrade')).toEqual({ denyCause: 'downgrade' });
  });

  it('the telemetry event carries denyCause and askCause from the row', () => {
    const ev = telemetryEvent({ hook: 'PreToolUse', event: 'agent_call', decision: 'deny', denyCause: 'cost', tool_name: 'Agent' });
    expect(ev.denyCause).toBe('cost');
    const ask = telemetryEvent({ hook: 'PreToolUse', event: 'agent_call', decision: 'ask', askCause: 'unranked', tool_name: 'Agent' });
    expect(ask.askCause).toBe('unranked');
    expect(telemetryEvent({ hook: 'PreToolUse', event: 'agent_call', decision: 'deny', denyCause: 'bogus' }).denyCause).toBeUndefined();
  });
});

describe('mode on MCP tool rows', () => {
  const saved = { cfg: process.env.JEV_CONFIG_FILE, harness: process.env.JEV_HARNESS };
  let dir = '';
  const rows = (): any[] => {
    try {
      return fs.readFileSync(telemetryFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mode-rows-'));
    process.env.JEV_CONFIG_FILE = path.join(dir, 'config.json');
    process.env.JEV_HARNESS = 'antigravity';
    fs.rmSync(telemetryFile(), { force: true });
    clearConfigCacheForTesting();
  });
  afterEach(() => {
    if (saved.cfg === undefined) delete process.env.JEV_CONFIG_FILE; else process.env.JEV_CONFIG_FILE = saved.cfg;
    if (saved.harness === undefined) delete process.env.JEV_HARNESS; else process.env.JEV_HARNESS = saved.harness;
    clearConfigCacheForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const setMode = (m: string, harness: string) => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ harnesses: { [harness]: { mode: m } } }));
    clearConfigCacheForTesting();
  };

  it('a tool row carries the mode in effect for the harness it names', async () => {
    setMode('on', 'antigravity');
    await logTelemetry({ tool: 'jev_judge', status: 'success' });
    setMode('on-demand', 'antigravity');
    await logTelemetry({ tool: 'jev_route', status: 'success' });
    expect(rows().map((x) => [x.tool, x.mode])).toEqual([['jev_judge', 'on'], ['jev_route', 'on-demand']]);
  });

  it('a Claude Code dispatch row reads the claude-code mode', async () => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ harnesses: { antigravity: { mode: 'on-demand' }, 'claude-code': { mode: 'on' } } }));
    clearConfigCacheForTesting();
    await logTelemetry({ tool: 'jev_dispatch', harness: 'claude-code', status: 'success' });
    expect(rows()[0]).toMatchObject({ tool: 'jev_dispatch', harness: 'claude-code', mode: 'on' });
  });

  it('off: a row that is still written omits mode, never writes off', async () => {
    setMode('off', 'antigravity');
    await logTelemetry({ tool: 'jev_judge', status: 'success' });
    await logTelemetry({ tool: 'jev_get_mode', mode: 'off', status: 'success' });
    for (const x of rows()) expect('mode' in x).toBe(false);
    expect(rows()).toHaveLength(2);
  });

  it('jev_set_mode records the mode after the change and previousMode', async () => {
    setMode('on-demand', 'antigravity');
    await handleSetModeTool({ mode: 'on' });
    const set = rows().find((x) => x.tool === 'jev_set_mode');
    expect(set).toMatchObject({ mode: 'on', previousMode: 'on-demand' });
    await handleSetModeTool({ mode: 'off' });
    const off = rows().filter((x) => x.tool === 'jev_set_mode').at(-1);
    expect(off.previousMode).toBe('on');
    expect('mode' in off).toBe(false);
  });
});
