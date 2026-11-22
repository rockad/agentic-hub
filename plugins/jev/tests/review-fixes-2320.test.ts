/**
 * 2.3.20 review fixes: the `mode` of an MCP tool row follows the running harness; a Workflow / `run_workflow` deny is `cost` only when
 * the rank ceiling would not have held it too (as on the single-call paths); the cause list and the `default` effort docs say what the code does.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPreToolUse, type HookInput } from '../claude/hook.ts';
import { buildCatalogue } from '../src/core/catalogue.ts';
import type { RankContext } from '../claude/logic.ts';
import { DENY_CAUSES } from '../src/core/deny-cause.ts';
import { createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';
import { evaluateAntigravitySubagentCall, type AntigravityHookInput } from '../antigravity/logic.ts';
import { evaluateAntigravityWorkflowCall } from '../antigravity/workflow-guard.ts';
import { logTelemetry, telemetryFile } from '../src/core/telemetry.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';
import { rig, wf, type Rig } from './workflow-helpers.ts';

const ROOT = path.resolve(import.meta.dir, '..');

describe('mode of an MCP tool row follows the running harness', () => {
  const saved = { cfg: process.env.JEV_CONFIG_FILE, harness: process.env.JEV_HARNESS };
  let dir = '';
  const rows = (): any[] => {
    try {
      return fs.readFileSync(telemetryFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const config = (c: unknown) => {
    fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify(c));
    clearConfigCacheForTesting();
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rowmode-'));
    process.env.JEV_CONFIG_FILE = path.join(dir, 'config.json');
    process.env.JEV_HARNESS = 'claude-code';
    fs.rmSync(telemetryFile(), { force: true });
    clearConfigCacheForTesting();
  });
  afterEach(() => {
    if (saved.cfg === undefined) delete process.env.JEV_CONFIG_FILE; else process.env.JEV_CONFIG_FILE = saved.cfg;
    if (saved.harness === undefined) delete process.env.JEV_HARNESS; else process.env.JEV_HARNESS = saved.harness;
    clearConfigCacheForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a row with no harness reads the mode of the harness the server runs under, not Antigravity', async () => {
    config({ defaults: { mode: 'on' }, harnesses: { 'claude-code': { mode: 'on' }, antigravity: { mode: 'off' } } });
    await logTelemetry({ tool: 'jev_judge', status: 'success' });
    expect(rows()[0]).toMatchObject({ tool: 'jev_judge', mode: 'on' });
  });

  it('an Antigravity on-demand setting does not leak into a Claude Code call that ran in mode on', async () => {
    config({ harnesses: { 'claude-code': { mode: 'on' }, antigravity: { mode: 'on-demand' } } });
    for (const tool of ['jev_route', 'jev_score', 'jev_execute_free', 'jev_quota', 'jev_select_model']) await logTelemetry({ tool, status: 'success' });
    expect(rows().map((x) => x.mode)).toEqual(['on', 'on', 'on', 'on', 'on']);
  });

  it('an on-demand Claude Code server writes on-demand whatever Antigravity is set to', async () => {
    config({ harnesses: { 'claude-code': { mode: 'on-demand' }, antigravity: { mode: 'on' } } });
    await logTelemetry({ tool: 'jev_judge', status: 'success' });
    expect(rows()[0].mode).toBe('on-demand');
  });

  it('off under the running harness writes no mode, even when another harness is on', async () => {
    config({ harnesses: { 'claude-code': { mode: 'off' }, antigravity: { mode: 'on' } } });
    await logTelemetry({ tool: 'jev_judge', status: 'success' });
    expect('mode' in rows()[0]).toBe(false);
  });

  it('a row that names its harness still reads that harness', async () => {
    config({ harnesses: { 'claude-code': { mode: 'on-demand' }, antigravity: { mode: 'on' } } });
    await logTelemetry({ tool: 'jev_dispatch', harness: 'antigravity', status: 'success' });
    expect(rows()[0]).toMatchObject({ harness: 'antigravity', mode: 'on' });
  });
});

describe('Claude Code Workflow denyCause matches the Agent path', () => {
  let r: Rig;
  afterEach(() => r?.cleanup());
  const CAT = buildCatalogue('claude-code', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].map((id) => ({ id, ok: true })), 'probe', null, new Date('2026-11-12T10:00:00.000Z'));
  const RANK: RankContext = { cat: CAT };
  const row = () => r.logs.at(-1) as Record<string, any>;
  const agentCall = (toolInput: Record<string, unknown>): HookInput => ({
    session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', cwd: r.project, tool_input: toolInput as any, effort: 'high'
  });

  it('enforce: an opus agent under sonnet@high is tier on the Agent path and on the Workflow path', async () => {
    r = rig({ costGateMode: () => 'enforce', rankContext: () => RANK });
    await onPreToolUse(agentCall({ description: 'd', model: 'opus' }), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'tier' });
    await onPreToolUse(wf({ script: `await agent('p', {model: 'opus'})` }, r, { effort: 'high' }), r.d);
    expect(row()).toMatchObject({ tool_name: 'Workflow', decision: 'deny', denyCause: 'tier' });
  });

  it('enforce, dialog mode: the ask carries askCause tier', async () => {
    r = rig({ costGateMode: () => 'enforce', rankContext: () => RANK, env: { JEV_ELEVATION: 'dialog' } });
    await onPreToolUse(wf({ script: `await agent('p', {model: 'opus'})` }, r, { effort: 'high' }), r.d);
    expect(row()).toMatchObject({ decision: 'ask', askCause: 'tier' });
  });

  it('enforce: a same-model agent held only by its effort is still cost', async () => {
    r = rig({ costGateMode: () => 'enforce', rankContext: () => RANK });
    await onPreToolUse(wf({ script: `await agent('p', {model: 'sonnet', effort: 'max'})` }, r, { effort: 'medium' }), r.d);
    expect(row()).toMatchObject({ decision: 'deny', denyCause: 'cost' });
  });
});

describe('Antigravity run_workflow denyCause matches invoke_subagent', () => {
  let dir = '';
  let approvals: ApprovalStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rf-'));
    approvals = createAntigravityApprovalStore(path.join(dir, 'sessions'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const FLASH = 'gemini-3.8-flash-low';
  const PRO_HIGH = 'gemini-3.5-pro-high';
  const wfCall = (script: string, session: string): AntigravityHookInput => ({
    conversationId: 'c1', modelName: session, lastUserInput: 'run it', stepIdx: 4,
    toolCall: { id: 'w1', name: 'run_workflow', args: { Script: script } }
  });
  const wfDeps = (session: string, extra: object = {}) => ({
    mode: 'on' as const, sessionModel: session, approvals, now: () => 1_000_000, costGateMode: 'enforce' as const,
    definitions: { definition: () => ({ found: false, model: null }) }, ...extra
  });

  it('enforce: a full id above the ceiling is tier in both, not cost', () => {
    const single = evaluateAntigravitySubagentCall(
      { conversationId: 'c1', lastUserInput: 'run it', modelName: FLASH, toolCall: { id: 't1', name: 'invoke_subagent', args: { TypeName: 'worker', Prompt: 'x', Model: 'gemini-4-argon-high' } } },
      { approvals, sessionModelOverride: FLASH, elevationMode: 'choice', now: () => 1_000, costGateMode: 'enforce' } as any
    );
    expect(single).toMatchObject({ decision: 'deny', cause: 'tier' });
    const flow = evaluateAntigravityWorkflowCall(wfCall('await agent("p", model="gemini-4-argon-high")', FLASH), wfDeps(FLASH));
    expect(flow.decision).toMatchObject({ decision: 'deny', cause: 'tier' });
  });

  it('enforce, dialog: the ask carries the tier cause', () => {
    const flow = evaluateAntigravityWorkflowCall(wfCall('await agent("p", model="gemini-4-argon-high")', FLASH), wfDeps(FLASH, { elevationMode: 'dialog' }));
    expect(flow.decision).toMatchObject({ decision: 'ask', cause: 'tier' });
  });

  it('enforce, Orchestrator: the cause is orchestrator, not cost', () => {
    const flow = evaluateAntigravityWorkflowCall(wfCall('await agent("p", model="gemini-4-argon-high")', FLASH), wfDeps(FLASH, { sessionOrchestrator: true }));
    expect(flow.decision).toMatchObject({ decision: 'deny', cause: 'orchestrator' });
  });

  it('enforce: a same-tier call held only by its effort is still cost', () => {
    const flow = evaluateAntigravityWorkflowCall(wfCall('await agent("p", model="gemini-3.5-pro-xhigh")', PRO_HIGH), wfDeps(PRO_HIGH));
    expect(flow.decision).toMatchObject({ decision: 'deny', cause: 'cost' });
  });
});

describe('documented vocabulary matches the code', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  it('quota is a cause, and the README lists every cause in DENY_CAUSES', () => {
    expect(DENY_CAUSES).toContain('quota');
    for (const c of DENY_CAUSES) expect(readme).toContain('`' + c + '`');
  });

  it('the `default` effort docs name the assumed high of an unknown Claude Code session model', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'src/core/join-keys.ts'), 'utf8');
    expect(doc).toContain('ASSUMED_CLAUDE_SESSION_EFFORT');
    expect(readme).toContain('cost fields computed at `high`');
  });
});
