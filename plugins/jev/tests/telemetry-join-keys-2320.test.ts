/**
 * 2.3.20 telemetry join keys and effort source.
 *
 * - `toolUseId` (Claude Code) / `callKey` (Antigravity): the host's tool call id on every agent_call row (a deny included), on the
 *   PostToolUse rows of the same calls, and `childConversationId` on `subagent_served`: the join to measured usage.
 * - `effortRequested` / `effortSource` on agent_call rows of both harnesses.
 * - An Antigravity Opus session draws the Argon pool (the session's own active pool, and so the pre-flight low-quota notice).
 * - Mode semantics: off writes nothing; on-demand rows carry the keys.
 *
 * Unit tests, then one hook process per harness asserting the fields on the rows it really wrote.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPreToolUse, telemetryEvent, type HookInput } from '../claude/hook.ts';
import { antigravityEffortFields, callKeyField, effortFields, joinToken, toolUseIdField, JOIN_TOKEN_MAX } from '../src/core/join-keys.ts';
import { antigravityCallId, antigravityEffortFor, buildAntigravityTelemetryEvent, pendingCallFromEvent } from '../antigravity/logic.ts';
import { poolForTier, readQuotaView, sessionDrawsArgonBuckets } from '../src/core/governance.ts';
import { runPreflight } from '../antigravity/preflight.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';
import { rig, wf, type Rig } from './workflow-helpers.ts';

describe('join tokens', () => {
  it('a short token passes (trimmed); absent, empty, long or malformed ids are omitted', () => {
    expect(joinToken('toolu_01ABCdef')).toBe('toolu_01ABCdef');
    expect(joinToken('  call_1  ')).toBe('call_1');
    expect(joinToken('a1b2-c3.d4:e5')).toBe('a1b2-c3.d4:e5');
    expect(joinToken('x'.repeat(JOIN_TOKEN_MAX))).toBe('x'.repeat(JOIN_TOKEN_MAX));
    for (const bad of [undefined, null, 7, {}, '', '   ', 'x'.repeat(JOIN_TOKEN_MAX + 1), 'has space', 'a/b', '../x', 'a"b', 'line\nbreak', 'a;rm']) {
      expect(joinToken(bad)).toBeUndefined();
    }
  });

  it('toolUseIdField and callKeyField write the key only for a valid id', () => {
    expect(toolUseIdField('toolu_1')).toEqual({ toolUseId: 'toolu_1' });
    expect(toolUseIdField('bad id')).toEqual({});
    expect(callKeyField('call_1')).toEqual({ callKey: 'call_1' });
    expect(callKeyField(undefined)).toEqual({});
  });

  it('antigravityCallId reads toolCall.id only', () => {
    expect(antigravityCallId({ toolCall: { id: 'c1' } })).toBe('c1');
    expect(antigravityCallId({ toolCall: {} })).toBeUndefined();
    expect(antigravityCallId({})).toBeUndefined();
    expect(antigravityCallId({ toolCall: { id: 'bad id' } })).toBeUndefined();
  });

  it('pendingCallFromEvent keeps the host id as callId, and none when the event had none', () => {
    expect(pendingCallFromEvent({ harness: 'antigravity', toolOrHook: 'PreToolUse', callKey: 'c1' }, 'c1').callId).toBe('c1');
    const stepOnly = pendingCallFromEvent({ harness: 'antigravity', toolOrHook: 'PreToolUse' }, 'step:4');
    expect(stepOnly.callId).toBeUndefined();
    expect(stepOnly.callKey).toBe('step:4');
  });
});

describe('effort source', () => {
  it('effortFields: requested, inherited, default and clamped', () => {
    expect(effortFields({ named: 'xhigh', sessionKnown: true })).toEqual({ effortRequested: 'xhigh', effortSource: 'requested' });
    expect(effortFields({ named: 'HIGH', sessionKnown: false })).toEqual({ effortRequested: 'high', effortSource: 'requested' });
    expect(effortFields({ sessionKnown: true })).toEqual({ effortSource: 'inherited' });
    expect(effortFields({ sessionKnown: false })).toEqual({ effortSource: 'default' });
    expect(effortFields({ named: 'higher', sessionKnown: true })).toEqual({ effortSource: 'inherited' }); // relative: not a literal
    expect(effortFields({ named: 'xhigh', sessionKnown: true, clampedFrom: 'xhigh' })).toEqual({ effortRequested: 'xhigh', effortSource: 'clamped' });
  });

  it('Antigravity mapping: enum values have a fixed served effort (requested), flash_lite and inherit follow the session', () => {
    const F = 'gemini-3.8-flash-low';
    expect(antigravityEffortFor('flash', F)).toEqual({ effortRequested: 'high', effortSource: 'requested' });
    expect(antigravityEffortFor('pro', F)).toEqual({ effortRequested: 'xhigh', effortSource: 'requested' });
    expect(antigravityEffortFor('flash_lite', F)).toEqual({ effortSource: 'inherited' });
    expect(antigravityEffortFor('inherit', F)).toEqual({ effortSource: 'inherited' });
    expect(antigravityEffortFor(undefined, F)).toEqual({ effortSource: 'inherited' });
    // a full id carries its own effort as the suffix
    expect(antigravityEffortFor('gemini-4-argon-high', F)).toEqual({ effortRequested: 'high', effortSource: 'requested' });
    expect(antigravityEffortFor('gemini-4-argon', F)).toEqual({ effortSource: 'inherited' });
    // a session model with no effort suffix: the default (medium) is what the cost fields used
    expect(antigravityEffortFor('inherit', 'Gemini 3.8 Flash')).toEqual({ effortSource: 'default' });
    expect(antigravityEffortFor('flash_lite', null)).toEqual({ effortSource: 'default' });
    expect(antigravityEffortFor('pro', null)).toEqual({ effortRequested: 'xhigh', effortSource: 'requested' });
  });

  it('Antigravity clamp: lowered to a different effort is clamped (requested is what it asked for); an unchanged effort is not', () => {
    expect(antigravityEffortFor('pro', 'gemini-3.8-flash-low', 'high')).toEqual({ effortRequested: 'xhigh', effortSource: 'clamped' });
    expect(antigravityEffortFor('pro', 'gemini-3.8-flash-low', 'xhigh')).toEqual({ effortRequested: 'xhigh', effortSource: 'requested' });
    expect(antigravityEffortFields({ servedEffort: null, sessionModel: 'x-high' })).toEqual({ effortSource: 'inherited' });
  });

  it('the Antigravity agent_call telemetry row carries effortSource, effortRequested and callKey, and the served row callKey', () => {
    const call = buildAntigravityTelemetryEvent({
      kind: 'agent_call',
      conversationId: 'c',
      inputModelName: 'gemini-3.8-flash-low',
      args: { TypeName: 't', Model: 'pro' },
      decision: { decision: 'deny', cause: 'tier' },
      callKey: 'call_9'
    });
    expect(call).toMatchObject({ callKey: 'call_9', effortRequested: 'xhigh', effortSource: 'requested', denyCause: 'tier', costWeightsVersion: 1 });
    const noId = buildAntigravityTelemetryEvent({ kind: 'agent_call', conversationId: 'c', inputModelName: 'gemini-3.8-flash-low', args: { TypeName: 't' }, decision: { decision: 'pass' } });
    expect('callKey' in noId).toBe(false);
    expect(noId.effortSource).toBe('inherited');
    const served = buildAntigravityTelemetryEvent({ kind: 'subagent_served', conversationId: 'c', childConversationId: 'k', callKey: 'call_9', requestedModel: 'pro', servedModel: 'gemini-4-hydrogen-tiered-xhigh' });
    expect(served).toMatchObject({ callKey: 'call_9', childConversationId: 'k' });
    expect('callKey' in buildAntigravityTelemetryEvent({ kind: 'subagent_served', conversationId: 'c', childConversationId: 'k', callKey: 'bad id' })).toBe(false);
  });
});

describe('Claude Code rows (in process)', () => {
  let r: Rig;
  afterEach(() => r?.cleanup());
  const call = (toolInput: Record<string, unknown>, extra: Partial<HookInput> = {}): HookInput => ({
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Agent',
    cwd: r.project,
    tool_input: toolInput as any,
    tool_use_id: 'toolu_01AGENT',
    ...extra
  });
  const row = () => r.logs.at(-1) as Record<string, any>;
  const tel = () => telemetryEvent(row());

  it('a pass row carries toolUseId and effortSource requested for a literal effort on the call', async () => {
    r = rig();
    await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'low' }, { effort: 'high' }), r.d);
    expect(row()).toMatchObject({ decision: 'pass', toolUseId: 'toolu_01AGENT', effortRequested: 'low', effortSource: 'requested' });
    expect(tel()).toMatchObject({ toolUseId: 'toolu_01AGENT', effortRequested: 'low', effortSource: 'requested', costWeightsVersion: 1 });
  });

  it('an agent definition effort is requested too; none named and the session reported one is inherited; none at all is default', async () => {
    r = rig();
    await onPreToolUse(call({ description: 'd', model: 'sonnet' }, { effort: 'high' }), r.d);
    expect(row()).toMatchObject({ effortSource: 'inherited' });
    expect('effortRequested' in row()).toBe(false);
    await onPreToolUse(call({ description: 'd', model: 'sonnet' }), r.d);
    expect(row()).toMatchObject({ effortSource: 'default' });
    expect(tel()).toMatchObject({ effortSource: 'default' });
    expect('effortRequested' in tel()).toBe(false);
    // an unknown session model is held as sonnet at high, but the effort was not reported: still a default
    r.cleanup();
    r = rig({ readSessionModel: () => null });
    await onPreToolUse(call({ description: 'd', model: 'sonnet' }), r.d);
    expect(row()).toMatchObject({ sessionModelAssumed: true, effortSource: 'default' });
    const dir = path.join(r.project, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'deep.md'), '---\nname: deep\ndescription: d\nmodel: sonnet\neffort: medium\n---\nbody\n');
    await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d);
    expect(row()).toMatchObject({ effortRequested: 'medium', effortSource: 'requested' });
  });

  it('a denied call carries the keys too (the effort it asked for stays on the row)', async () => {
    r = rig();
    await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }, { effort: 'high' }), r.d);
    expect(row()).toMatchObject({ decision: 'deny', toolUseId: 'toolu_01AGENT', effortRequested: 'xhigh', effortSource: 'requested' });
    expect(tel()).toMatchObject({ decision: 'deny', toolUseId: 'toolu_01AGENT', effortRequested: 'xhigh', effortSource: 'requested' });
  });

  it('the clamp that lowered the effort is clamped, and effortRequested is what the call asked for', async () => {
    r = rig({ costGateMode: () => 'enforce', env: { JEV_ELEVATION: 'clamp' } }, 'claude-sonnet-5-5');
    await onPreToolUse(call({ description: 'd', model: 'sonnet', effort: 'xhigh' }, { effort: 'medium' }), r.d);
    expect(row()).toMatchObject({ elevation: 'clamped', clamped_effort: 'medium', effortRequested: 'xhigh', effortSource: 'clamped' });
    expect(tel()).toMatchObject({ effortRequested: 'xhigh', effortSource: 'clamped' });
  });

  it('a model-only clamp leaves the effort alone (requested, not clamped)', async () => {
    r = rig({ env: { JEV_ELEVATION: 'clamp' } }, 'claude-sonnet-5-5');
    await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'low' }, { effort: 'high' }), r.d);
    expect(row()).toMatchObject({ elevation: 'clamped', effortSource: 'requested', effortRequested: 'low' });
  });

  it('a Workflow row carries toolUseId for the workflow as a whole and no effort fields', async () => {
    r = rig();
    await onPreToolUse(wf({ script: `await agent('p', {model: 'opus'})` }, r), r.d);
    expect(row()).toMatchObject({ tool_name: 'Workflow', decision: 'deny', toolUseId: 'toolu_01ABC' });
    expect('effortSource' in row()).toBe(false);
    expect(tel().toolUseId).toBe('toolu_01ABC');
    expect('effortSource' in tel()).toBe(false);
  });

  it('an absent or malformed tool_use_id is omitted, never guessed', async () => {
    r = rig();
    await onPreToolUse(call({ description: 'd', model: 'sonnet' }, { tool_use_id: undefined }), r.d);
    expect('toolUseId' in row()).toBe(false);
    await onPreToolUse(call({ description: 'd', model: 'sonnet' }, { tool_use_id: 'has space/../x' }), r.d);
    expect('toolUseId' in row()).toBe(false);
    expect('toolUseId' in tel()).toBe(false);
    await onPreToolUse(call({ description: 'd', model: 'sonnet' }, { tool_use_id: 'x'.repeat(300) }), r.d);
    expect('toolUseId' in row()).toBe(false);
  });

  it('on-demand rows carry the keys (decision pass, no decisions made)', async () => {
    r = rig();
    r.mode.value = 'on-demand';
    await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'xhigh' }), r.d);
    expect(row()).toMatchObject({ decision: 'pass', mode: 'on-demand', toolUseId: 'toolu_01AGENT', effortRequested: 'xhigh', effortSource: 'requested' });
    await onPreToolUse(wf({ script: `await agent('p')` }, r), r.d);
    expect(row()).toMatchObject({ tool_name: 'Workflow', mode: 'on-demand', toolUseId: 'toolu_01ABC' });
    expect(tel()).toMatchObject({ toolUseId: 'toolu_01ABC', mode: 'on-demand' });
  });

  it('off writes nothing', async () => {
    r = rig();
    r.mode.value = 'off';
    await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d);
    await onPreToolUse(wf({ script: `await agent('p')` }, r), r.d);
    expect(r.logs).toEqual([]);
  });

  it('the drift row carries toolUseId', async () => {
    r = rig();
    const file = path.join(r.project, 'wf.js');
    fs.writeFileSync(file, `await agent('p')`);
    await onPreToolUse(wf({ scriptPath: file }, r, {}, 'toolu_drift'), r.d);
    fs.writeFileSync(file, `await agent('p', {model: 'opus'})`);
    const { onWorkflowPostToolUse } = await import('../claude/hook.ts');
    await onWorkflowPostToolUse({ tool_name: 'Workflow', session_id: 's1', tool_use_id: 'toolu_drift', tool_input: { scriptPath: file } } as any, r.d);
    const drift = r.logs.find((l) => l.event === 'workflow_changed') as Record<string, any>;
    expect(drift).toMatchObject({ hook: 'PostToolUse', toolUseId: 'toolu_drift', tool_use_id: 'toolu_drift' });
    expect(telemetryEvent(drift).toolUseId).toBe('toolu_drift');
  });
});

describe('Antigravity session pool: an Opus session draws the Argon pool (1.5.14)', () => {
  let root = '';
  let origQuota: string | undefined;
  const now = Math.floor(Date.now() / 1000);
  const bucket = (f: number) => ({ remaining_fraction: f, reset_at: now + 3600 });
  const writeQuota = (activeModel: string, argon = 0.01) => {
    const file = path.join(root, 'quota-state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema: 2,
        updated_at: now,
        active_model: activeModel,
        buckets: {
          'gemini-5h': bucket(0.8),
          'gemini-weekly': bucket(0.7),
          'gemini-argon-wtu-weekly': bucket(argon),
          '3p-5h': bucket(0.9),
          '3p-weekly': bucket(0.6)
        }
      })
    );
    process.env.JEV_QUOTA_STATE_FILE = file;
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pool-'));
    origQuota = process.env.JEV_QUOTA_STATE_FILE;
  });
  afterEach(() => {
    if (origQuota === undefined) delete process.env.JEV_QUOTA_STATE_FILE;
    else process.env.JEV_QUOTA_STATE_FILE = origQuota;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const view = () => readQuotaView({ overrideSessionsDir: path.join(root, 'sessions') });

  it('sessionDrawsArgonBuckets: Argon, Neon and Opus; not Carbon, Sonnet or Gemini', () => {
    for (const m of ['claude-opus-5-5-high', 'gemini-4-argon-high', 'gemini-4-neon-xhigh', 'Claude Opus 5.5 (High)']) expect(sessionDrawsArgonBuckets(m)).toBe(true);
    for (const m of ['gemini-4-carbon-high', 'claude-sonnet-5-5-high', 'gemini-4-hydrogen-medium', 'Gemini 3.8 Flash (Medium)', '', undefined]) expect(sessionDrawsArgonBuckets(m)).toBe(false);
  });

  it('an Opus session reads the Argon bucket, not the 3p buckets', async () => {
    writeQuota('claude-opus-5-5-high');
    const v = await view();
    expect(v.active.pool).toBe('gemini');
    expect(v.active.weekly).toBeCloseTo(0.01, 5);
    expect(v.active.strategy).toBe('free_only');
    expect(poolForTier(v, 'inherit')).toBe(v.active);
    expect(poolForTier(v, 'claude-sonnet-5-5-high')).toMatchObject({ pool: '3p', weekly: 0.6 });
  });

  it('an Argon session is unchanged, a Sonnet session still draws 3p, a Gemini session the Gemini buckets, Carbon the Gemini weekly', async () => {
    writeQuota('gemini-4-argon-high');
    expect((await view()).active.weekly).toBeCloseTo(0.01, 5);
    writeQuota('claude-sonnet-5-5-high');
    expect(await view()).toMatchObject({ active: { pool: '3p', five_hour: 0.9, weekly: 0.6, strategy: 'normal' } });
    writeQuota('Gemini 3.8 Flash (Medium)');
    expect(await view()).toMatchObject({ active: { pool: 'gemini', five_hour: 0.8, weekly: 0.7 } });
    writeQuota('gemini-4-carbon-high');
    expect(await view()).toMatchObject({ active: { pool: 'gemini', weekly: 0.7 } });
  });

  it('an Opus session with no Argon bucket falls back to the Gemini buckets (as Argon does), never to 3p', async () => {
    const file = path.join(root, 'quota-state.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 2, updated_at: now, active_model: 'claude-opus-5-5-high', buckets: { 'gemini-5h': bucket(0.8), 'gemini-weekly': bucket(0.7), '3p-5h': bucket(0.9), '3p-weekly': bucket(0.6) } }));
    process.env.JEV_QUOTA_STATE_FILE = file;
    expect(await view()).toMatchObject({ active: { pool: 'gemini', weekly: 0.7 } });
  });

  describe('the pre-flight low-quota notice follows it', () => {
    let home = '';
    const KEYS = ['HOME', 'JEV_CONFIG_FILE', 'JEV_TELEMETRY_FILE'] as const;
    let orig: Record<string, string | undefined> = {};
    beforeEach(() => {
      clearConfigCacheForTesting();
      home = path.join(root, 'home');
      fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
      orig = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
      process.env.HOME = home;
      process.env.JEV_CONFIG_FILE = path.join(home, '.config', 'jev', 'config.json');
      process.env.JEV_TELEMETRY_FILE = path.join(home, 'telemetry.jsonl');
      fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on-demand' } }));
    });
    afterEach(() => {
      clearConfigCacheForTesting();
      for (const k of KEYS) {
        if (orig[k] === undefined) delete process.env[k];
        else process.env[k] = orig[k];
      }
    });
    async function notice(modelName: string): Promise<string> {
      let out = '';
      const log = console.log;
      console.log = (m: string) => {
        out += m;
      };
      try {
        await runPreflight(JSON.stringify({ conversationId: '00000000-0000-4000-8000-0000000000b1', modelName, lastUserInput: 'please refactor the billing module', invocationNum: 1 }), {
          autoHeal: () => {},
          callJev: async () => null
        });
      } finally {
        console.log = log;
      }
      const parsed = out ? JSON.parse(out) : {};
      return String(parsed.injectSteps?.[0]?.ephemeralMessage ?? '');
    }

    it('Opus with the Argon pool low gets the one-line notice; Sonnet with healthy 3p buckets does not', async () => {
      writeQuota('claude-opus-5-5-high', 0.02);
      expect(await notice('claude-opus-5-5-high')).toContain('quota notice');
      writeQuota('claude-sonnet-5-5-high', 0.02);
      expect(await notice('claude-sonnet-5-5-high')).not.toContain('quota notice');
    });
  });
});

describe('the Claude Code hook process', () => {
  const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
  let home = '';
  const setMode = (mode: string) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode } }));
  const decisions = () => {
    const f = path.join(home, '.config', 'jev', 'claude_decisions.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const telemetry = () => {
    const f = path.join(home, 'telemetry.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-join-claude-'));
    fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
    setMode('on');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (event: string, input: object) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      JEV_CONFIG_FILE: path.join(home, 'config.json'),
      JEV_TELEMETRY_FILE: path.join(home, 'telemetry.jsonl'),
      JEV_OPENROUTER_API_KEY: '',
      JEV_MODEL_REFRESH: 'off'
    };
    for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'JEV_ELEVATION']) delete env[v];
    return Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string> });
  };
  const agent = (toolInput: object, id = 'toolu_01PROC', extra: object = {}) => ({
    session_id: 'sx',
    prompt_id: 'p1',
    tool_name: 'Agent',
    cwd: path.join(home, 'proj'),
    effort: 'high',
    tool_use_id: id,
    tool_input: toolInput,
    ...extra
  });

  it('on: a deny row and a pass row carry toolUseId and the effort fields in the decisions log and in the telemetry row', () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    const denied = run('pre-tool-use', agent({ description: 'd', prompt: 'p', subagent_type: 'general-purpose', model: 'opus', effort: 'xhigh' }, 'toolu_01DENY'));
    expect(JSON.parse(denied.stdout.toString()).hookSpecificOutput.permissionDecision).toBe('deny');
    run('pre-tool-use', agent({ description: 'd', prompt: 'p', subagent_type: 'general-purpose', model: 'sonnet' }, 'toolu_01PASS'));
    const wfRun = run('pre-tool-use', agent({ script: `await agent('p', {model: 'opus'})` }, 'toolu_01WF', { tool_name: 'Workflow' }));
    expect(wfRun.exitCode).toBe(0);

    const byId = (rows: any[], id: string) => rows.find((r) => (r.toolUseId ?? r.tool_use_id) === id && (r.event === 'agent_call' || r.toolOrHook === 'PreToolUse'));
    const d = decisions();
    expect(byId(d, 'toolu_01DENY')).toMatchObject({ event: 'agent_call', decision: 'deny', denyCause: 'tier', toolUseId: 'toolu_01DENY', effortRequested: 'xhigh', effortSource: 'requested' });
    expect(byId(d, 'toolu_01PASS')).toMatchObject({ decision: 'pass', toolUseId: 'toolu_01PASS', effortSource: 'inherited' });
    expect(byId(d, 'toolu_01WF')).toMatchObject({ tool_name: 'Workflow', toolUseId: 'toolu_01WF' });
    expect('effortSource' in byId(d, 'toolu_01WF')).toBe(false);

    const t = telemetry();
    expect(byId(t, 'toolu_01DENY')).toMatchObject({ harness: 'claude', decision: 'deny', denyCause: 'tier', toolUseId: 'toolu_01DENY', effortRequested: 'xhigh', effortSource: 'requested', costWeightsVersion: 1 });
    expect(byId(t, 'toolu_01PASS')).toMatchObject({ toolUseId: 'toolu_01PASS', effortSource: 'inherited' });
    expect(byId(t, 'toolu_01WF')).toMatchObject({ toolUseId: 'toolu_01WF' });
  });

  it('on-demand: the rows carry the keys', () => {
    setMode('on-demand');
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    const p = run('pre-tool-use', agent({ description: 'd', prompt: 'p', subagent_type: 'general-purpose', model: 'opus', effort: 'max' }, 'toolu_01OD'));
    expect(p.stdout.toString()).toBe(''); // no decision
    const row = decisions().find((r) => r.toolUseId === 'toolu_01OD');
    expect(row).toMatchObject({ event: 'agent_call', decision: 'pass', mode: 'on-demand', effortRequested: 'max', effortSource: 'requested' });
    expect(telemetry().find((r) => r.toolUseId === 'toolu_01OD')).toMatchObject({ mode: 'on-demand', effortRequested: 'max', effortSource: 'requested' });
  });

  it('off writes nothing', () => {
    setMode('off');
    run('pre-tool-use', agent({ description: 'd', prompt: 'p', subagent_type: 'general-purpose', model: 'opus' }, 'toolu_01OFF'));
    expect(decisions().filter((r) => r.toolUseId === 'toolu_01OFF')).toEqual([]);
    expect(telemetry()).toEqual([]);
  });

  it('the Workflow drift row (PostToolUse) carries toolUseId in the decisions log and the telemetry row', () => {
    const file = path.join(home, 'proj', 'wf.js');
    fs.writeFileSync(file, `await agent('p')`);
    const wfInput = (toolUseId: string) => ({ session_id: 'sx', tool_name: 'Workflow', cwd: path.join(home, 'proj'), tool_use_id: toolUseId, tool_input: { scriptPath: file } });
    run('pre-tool-use', wfInput('toolu_01DR'));
    fs.writeFileSync(file, `await agent('p', {model: 'opus'})`);
    run('post-tool-use', { ...wfInput('toolu_01DR'), hook_event_name: 'PostToolUse', tool_response: {} });
    expect(decisions().find((r) => r.event === 'workflow_changed')).toMatchObject({ hook: 'PostToolUse', toolUseId: 'toolu_01DR' });
    expect(telemetry().find((r) => r.toolOrHook === 'PostToolUse')).toMatchObject({ toolUseId: 'toolu_01DR' });
  });
});

describe('the Antigravity hook process', () => {
  const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
  const CONV = '00000000-0000-4000-8000-0000000000c1';
  const CHILD = '00000000-0000-4000-8000-0000000000c2';
  const SESSION_MODEL = 'gemini-3.8-flash-low';
  let home = '';
  let jevDir = '';
  const setMode = (mode: string) => fs.writeFileSync(path.join(jevDir, 'config.json'), JSON.stringify({ defaults: { mode } }));
  const readJsonl = (f: string): Array<Record<string, any>> => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const decisions = () => readJsonl(path.join(jevDir, 'antigravity_decisions.jsonl'));
  const telemetry = () => readJsonl(path.join(home, 'telemetry.jsonl'));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-join-'));
    jevDir = path.join(home, '.config', 'jev');
    fs.mkdirSync(jevDir, { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
    setMode('on');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (event: string, input: object) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      JEV_CONFIG_FILE: path.join(jevDir, 'config.json'),
      JEV_TELEMETRY_FILE: path.join(home, 'telemetry.jsonl'),
      JEV_DOWNGRADE: 'off'
    };
    for (const v of ['JEV_ELEVATION', 'JEV_COST_GATE']) delete env[v];
    return Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string> });
  };
  const sub = (id: string | undefined, model?: string) => ({
    conversationId: CONV,
    lastUserInput: 'run it',
    modelName: SESSION_MODEL,
    toolCall: { ...(id ? { id } : {}), name: 'invoke_subagent', args: { TypeName: 'worker', Prompt: 'x', ...(model ? { Model: model } : {}) } }
  });

  it('on: a deny row and a pass row carry callKey and the effort fields; the PostToolUse subagent_served row carries callKey and childConversationId', () => {
    const denied = run('pre-tool-use', sub('call_deny', 'pro'));
    expect(JSON.parse(denied.stdout.toString()).decision).toBe('deny');
    run('pre-tool-use', sub('call_pass', 'flash_lite'));

    const ac = (rows: any[], key: string) => rows.find((r) => r.event === 'agent_call' && r.callKey === key);
    expect(ac(decisions(), 'call_deny')).toMatchObject({ decision: 'deny', denyCause: 'tier', call_key: 'call_deny', effortRequested: 'xhigh', effortSource: 'requested', quotaPool: 'gemini' });
    expect(ac(decisions(), 'call_pass')).toMatchObject({ decision: 'pass', effortSource: 'inherited' });
    expect('effortRequested' in ac(decisions(), 'call_pass')).toBe(false);
    expect(ac(telemetry(), 'call_deny')).toMatchObject({ harness: 'antigravity', decision: 'deny', denyCause: 'tier', effortRequested: 'xhigh', effortSource: 'requested', costWeightsVersion: 1 });
    expect(ac(telemetry(), 'call_pass')).toMatchObject({ decision: 'pass', effortSource: 'inherited' });

    // The child conversation's transcript names the model it was served on; the tool return names the child.
    const childDir = path.join(home, '.gemini', 'antigravity-cli', 'brain', CHILD);
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, 'transcript.jsonl'), JSON.stringify({ model: 'gemini-3.5-flash-lite' }) + '\n');
    run('post-tool-use', { ...sub('call_pass', 'flash_lite'), content: JSON.stringify({ conversationId: CHILD }) });
    const servedDecision = decisions().find((r) => r.event === 'subagent_served');
    expect(servedDecision).toMatchObject({ callKey: 'call_pass', child_conversation_id: CHILD, served_model: 'gemini-3.5-flash-lite' });
    const servedTelemetry = telemetry().find((r) => r.event === 'subagent_served');
    expect(servedTelemetry).toMatchObject({ callKey: 'call_pass', childConversationId: CHILD, servedModel: 'gemini-3.5-flash-lite', requestedModel: 'flash_lite' });
  });

  it('parallel calls of one step keep their own callKey', () => {
    run('pre-tool-use', sub('call_a', 'flash'));
    run('pre-tool-use', sub('call_b', 'flash'));
    const keys = telemetry().filter((r) => r.event === 'agent_call').map((r) => r.callKey);
    expect(keys.sort()).toEqual(['call_a', 'call_b']);
  });

  it('a call with no tool call id (or a malformed one) has no callKey on any row, and the late-recommendation key still works', () => {
    run('pre-tool-use', sub(undefined, 'flash'));
    run('pre-tool-use', sub('bad id with spaces', 'flash'));
    const rows = [...decisions().filter((r) => r.event === 'agent_call'), ...telemetry().filter((r) => r.event === 'agent_call')];
    expect(rows.length).toBe(4);
    for (const r of rows) expect('callKey' in r).toBe(false);
  });

  it('run_workflow rows carry callKey', () => {
    const pre = run('pre-tool-use', { conversationId: CONV, lastUserInput: 'go', modelName: SESSION_MODEL, toolCall: { id: 'call_wf', name: 'run_workflow', args: { Script: 'await agent("p", model="flash")' } } });
    expect(pre.exitCode).toBe(0);
    expect(decisions().find((r) => r.event === 'workflow_call')).toMatchObject({ callKey: 'call_wf', call_key: 'call_wf' });
  });

  it('on-demand: the rows carry the keys; off writes nothing', () => {
    setMode('on-demand');
    run('pre-tool-use', sub('call_od', 'pro'));
    expect(decisions().find((r) => r.event === 'agent_call')).toMatchObject({ callKey: 'call_od', effortRequested: 'xhigh', effortSource: 'requested' });
    expect(telemetry().find((r) => r.event === 'agent_call')).toMatchObject({ callKey: 'call_od', mode: 'on-demand', effortSource: 'requested' });
    fs.rmSync(path.join(jevDir, 'antigravity_decisions.jsonl'), { force: true });
    fs.rmSync(path.join(home, 'telemetry.jsonl'), { force: true });
    setMode('off');
    run('pre-tool-use', sub('call_off', 'pro'));
    expect(decisions()).toEqual([]);
    expect(telemetry()).toEqual([]);
  });
});
