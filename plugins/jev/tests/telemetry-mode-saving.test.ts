/**
 * 2.3.19, Stream C: every telemetry row carries `mode` ("on" or "on-demand", never "off"), and a row that carries a downgrade
 * suggestion or application carries `costSaving`: the requested (model, effort) minus the downgrade target at the same effort.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { telemetryMode } from '../src/core/mode-policy.ts';
import { antigravityDowngradeSaving, downgradeCostSaving } from '../src/core/cost-estimate.ts';
import { logJevTelemetry } from '../src/core/telemetry.ts';
import { buildAntigravityTelemetryEvent } from '../antigravity/logic.ts';
import { downgradeSavingField, onPreToolUse, onUserPromptSubmit, telemetryEvent, type HookDeps, type HookInput } from '../claude/hook.ts';
import { memoryApprovals } from './elevation-helpers.ts';
import type { Dispatch } from '../claude/logic.ts';

describe('telemetryMode', () => {
  it('is on or on-demand for the modes that write telemetry, and nothing for off or an unknown value', () => {
    expect(telemetryMode('on')).toBe('on');
    expect(telemetryMode('on-demand')).toBe('on-demand');
    expect(telemetryMode('off')).toBeUndefined();
    expect(telemetryMode('bogus')).toBeUndefined();
    expect(telemetryMode(undefined)).toBeUndefined();
    expect(telemetryMode(null)).toBeUndefined();
  });
});

describe('downgradeCostSaving', () => {
  it('is the requested cost minus the target cost at the same effort (weights: opus 15, sonnet 3, haiku 1)', () => {
    expect(downgradeCostSaving('opus', 'haiku', 'medium')).toBe(14);
    expect(downgradeCostSaving('opus', 'haiku', 'high')).toBe(21);
    expect(downgradeCostSaving('opus', 'sonnet', 'low')).toBe(6);
    expect(downgradeCostSaving('claude-opus-5-5', 'claude-haiku-5-5', 'xhigh')).toBe(28);
  });

  it('takes medium when no literal effort is known', () => {
    expect(downgradeCostSaving('opus', 'haiku')).toBe(14);
    expect(downgradeCostSaving('opus', 'haiku', 'higher')).toBe(14);
  });

  it('is null when either model has no tier', () => {
    expect(downgradeCostSaving('opus', 'mystery-model', 'high')).toBeNull();
    expect(downgradeCostSaving('mystery-model', 'haiku', 'high')).toBeNull();
    expect(downgradeCostSaving(undefined, 'haiku', 'high')).toBeNull();
  });
});

describe('antigravityDowngradeSaving', () => {
  it('prices flash as Hydrogen at high and flash_lite at the same effort: 3 x 1.5 - 1 x 1.5 = 3', () => {
    expect(antigravityDowngradeSaving('flash', 'flash_lite', 'gemini-3.8-flash-low')).toBe(3);
  });

  it('prices an inherited model as the parent, at the parent effort', () => {
    // flash-class parent at low: 3 x 0.5 - 1 x 0.5 = 1
    expect(antigravityDowngradeSaving(null, 'flash_lite', 'gemini-3.8-flash-low')).toBe(1);
    expect(antigravityDowngradeSaving('inherit', 'flash_lite', 'gemini-3.8-flash-high')).toBe(3);
  });

  it('is null when the parent model is unknown for an inherited call', () => {
    expect(antigravityDowngradeSaving(null, 'flash_lite', null)).toBeNull();
  });
});

describe('Antigravity telemetry rows carry mode', () => {
  const base = { conversationId: 'c1', inputModelName: 'gemini-3.8-flash-low' };
  const agentCall = (extra: Record<string, unknown> = {}) =>
    buildAntigravityTelemetryEvent({
      kind: 'agent_call',
      ...base,
      lastUserInput: 'run worker',
      args: { TypeName: 'research', Model: 'flash' },
      decision: { decision: 'pass' },
      ...extra
    } as any);

  it.each(['on', 'on-demand'] as const)('every kind writes mode "%s"', (mode) => {
    expect(agentCall({ mode }).mode).toBe(mode);
    expect(buildAntigravityTelemetryEvent({ kind: 'pre_invocation', ...base, lastUserInput: 'plan the work', mode }).mode).toBe(mode);
    expect(buildAntigravityTelemetryEvent({ kind: 'subagent_served', ...base, servedModel: 'm', mode }).mode).toBe(mode);
    expect(
      buildAntigravityTelemetryEvent({
        kind: 'agent_call_recommendation',
        conversationId: 'c1',
        turn: 't',
        recommendedTier: 'flash',
        call: { callKey: 'k', at: 1, decision: 'pass', requestedModel: 'flash', toolName: 'invoke_subagent', sessionModel: null, sessionModelSource: null },
        mode
      }).mode
    ).toBe(mode);
  });

  it('never writes off or an unknown mode, and a caller that passes none writes none', () => {
    expect('mode' in agentCall({ mode: 'off' })).toBe(false);
    expect('mode' in agentCall({ mode: 'bogus' })).toBe(false);
    expect('mode' in agentCall()).toBe(false);
  });

  it('a row with a suggested or applied downgrade carries costSaving; any other row carries none', () => {
    expect(agentCall({ downgradeLog: { downgrade: 'asked', downgrade_to: 'flash_lite' } }).costSaving).toBe(3);
    expect(agentCall({ downgradeLog: { downgrade: 'applied', downgrade_to: 'flash_lite' } }).costSaving).toBe(3);
    for (const d of ['answered', 'skipped', 'discarded']) {
      expect('costSaving' in agentCall({ downgradeLog: { downgrade: d, downgrade_to: 'flash_lite' } })).toBe(false);
    }
    expect('costSaving' in agentCall()).toBe(false);
  });

  it('costSaving is null when the cost of either side is unknown', () => {
    expect(agentCall({ downgradeLog: { downgrade: 'asked', downgrade_to: 'mystery' } }).costSaving).toBeNull();
  });
});

describe('logJevTelemetry', () => {
  const dirs: string[] = [];
  const prev = process.env.JEV_TELEMETRY_FILE;
  afterEach(() => {
    if (prev === undefined) delete process.env.JEV_TELEMETRY_FILE;
    else process.env.JEV_TELEMETRY_FILE = prev;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const written = async (mode: unknown): Promise<Record<string, unknown>> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mode-'));
    dirs.push(dir);
    process.env.JEV_TELEMETRY_FILE = path.join(dir, 't.jsonl');
    await logJevTelemetry({ harness: 'claude', toolOrHook: 'x', mode: mode as any });
    return JSON.parse(fs.readFileSync(process.env.JEV_TELEMETRY_FILE, 'utf8').trim());
  };

  it('writes the mode it was given and drops anything else', async () => {
    expect((await written('on')).mode).toBe('on');
    expect((await written('on-demand')).mode).toBe('on-demand');
    expect('mode' in (await written('off'))).toBe(false);
    expect('mode' in (await written(undefined))).toBe(false);
  });
});

describe('Claude Code rows carry mode', () => {
  const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };
  function deps(mode: string, logs: Record<string, unknown>[]): HookDeps {
    const turns = new Map<string, any>();
    return {
      readMode: async () => mode,
      readSessionModel: () => 'claude-sonnet-5',
      readQuotaStrategy: async () => 'unknown',
      dispatch: async () => flashRec,
      log: (e) => logs.push(e as Record<string, unknown>),
      readTurn: (s) => turns.get(s ?? '') ?? null,
      saveTurn: (s, st) => void turns.set(s ?? '', st),
      approvals: memoryApprovals(),
      now: () => 1_800_000_000_000,
      env: {}
    };
  }
  const agent: HookInput = {
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Agent',
    tool_input: { description: 'WS1: refactor', prompt: 'Refactor it.', subagent_type: 'code-engineer', model: 'haiku' }
  };
  const prompt: HookInput = { session_id: 's1', prompt_id: 'p1', prompt: 'Refactor the telemetry module and add tests' };

  it.each(['on', 'on-demand'] as const)('mode %s: the prompt row and the agent_call row, in the decisions log and in the telemetry event', async (mode) => {
    const logs: Record<string, unknown>[] = [];
    const d = deps(mode, logs);
    await onUserPromptSubmit(prompt, d);
    await onPreToolUse(agent, d);
    const rows = logs.filter((l) => l.hook === 'UserPromptSubmit' || l.event === 'agent_call');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.mode).toBe(mode);
      expect(telemetryEvent(row).mode).toBe(mode);
    }
  });

  it('mode off writes no row at all, so no row says off', async () => {
    const logs: Record<string, unknown>[] = [];
    const d = deps('off', logs);
    await onUserPromptSubmit(prompt, d);
    await onPreToolUse(agent, d);
    expect(logs).toEqual([]);
  });

  it('telemetryEvent writes only on or on-demand', () => {
    expect(telemetryEvent({ hook: 'PreToolUse', mode: 'on' }).mode).toBe('on');
    expect('mode' in telemetryEvent({ hook: 'PreToolUse', mode: 'off' })).toBe(false);
    expect('mode' in telemetryEvent({ hook: 'PreToolUse' })).toBe(false);
  });
});

describe('Claude Code downgradeSavingField and costSaving', () => {
  const call = (extra: Record<string, unknown> = {}) => ({ subagent_type: 'x', ...extra }) as any;

  it('asked and applied carry the saving at the call effort, else the definition effort, else the session effort, else medium', () => {
    const log = { downgrade: 'asked', downgrade_from: 'opus', downgrade_to: 'haiku' };
    expect(downgradeSavingField(log, call({ effort: 'high' }), null, 'low')).toEqual({ costSaving: 21 });
    expect(downgradeSavingField(log, call(), { definitionEffort: 'low' } as any, 'high')).toEqual({ costSaving: 7 });
    expect(downgradeSavingField({ ...log, downgrade: 'applied' }, call(), null, 'xhigh')).toEqual({ costSaving: 28 });
    expect(downgradeSavingField(log, call(), null, null)).toEqual({ costSaving: 14 });
  });

  it('is null (the field present) when either cost is unknown, and absent on any other downgrade state', () => {
    expect(downgradeSavingField({ downgrade: 'applied', downgrade_from: 'opus', downgrade_to: 'mystery' }, call(), null, 'high')).toEqual({ costSaving: null });
    for (const downgrade of ['answered', 'skipped', 'discarded', undefined]) {
      expect(downgradeSavingField({ downgrade, downgrade_from: 'opus', downgrade_to: 'haiku' }, call(), null, 'high')).toEqual({});
    }
  });

  it('telemetryEvent carries it through, null included, on the PreToolUse row only', () => {
    expect(telemetryEvent({ hook: 'PreToolUse', event: 'agent_call', costSaving: 14 }).costSaving).toBe(14);
    expect(telemetryEvent({ hook: 'PreToolUse', event: 'agent_call', costSaving: null }).costSaving).toBeNull();
    expect('costSaving' in telemetryEvent({ hook: 'PreToolUse', event: 'agent_call' })).toBe(false);
    expect('costSaving' in telemetryEvent({ hook: 'UserPromptSubmit', costSaving: 3 })).toBe(false);
  });
});
