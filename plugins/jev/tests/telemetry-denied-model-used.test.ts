/**
 * Denied calls carry no modelUsed (R2). A `decision: 'deny'` agent_call never ran, so its telemetry row leaves
 * `modelUsed` AND `modelUsedSource` unset on both harnesses; the model the call asked for stays (`requestedModel` on
 * Antigravity, `requested_model` in the Claude Code decisions log). Every call that goes ahead (pass, allow) and the
 * native ask (the run may or may not happen) keep their modelUsed.
 */
import { describe, it, expect } from 'bun:test';
import { buildAntigravityTelemetryEvent } from '../antigravity/logic.ts';
import { onPreToolUse, telemetryEvent, type HookDeps, type HookInput } from '../claude/hook.ts';
import { memoryApprovals } from './elevation-helpers.ts';
import type { Dispatch } from '../claude/logic.ts';

const agy = (decision: any, args: Record<string, unknown> = { TypeName: 'research', Model: 'pro' }, extra: Record<string, unknown> = {}) =>
  buildAntigravityTelemetryEvent({
    kind: 'agent_call',
    conversationId: 'c1',
    inputModelName: 'gemini-3.8-flash-low',
    lastUserInput: 'run worker',
    args,
    decision,
    ...extra
  } as any);

describe('Antigravity agent_call: modelUsed only when the call goes ahead', () => {
  it('deny: no modelUsed, no modelUsedSource, requestedModel and decision stay', () => {
    const ev = agy({ decision: 'deny', elevation: 'denied', reason: 'above the ceiling' });
    expect('modelUsed' in ev).toBe(false);
    expect('modelUsedSource' in ev).toBe(false);
    expect(ev.requestedModel).toBe('pro');
    expect(ev.decision).toBe('deny');
    expect(ev.elevation).toBe('denied');
  });

  it('deny with a requested model of "flash" (a downgrade question denial) leaves them unset too', () => {
    const ev = agy({ decision: 'deny' }, { TypeName: 'x', Model: 'flash' }, { downgradeLog: { downgrade: 'asked' } });
    expect(ev.modelUsed).toBeUndefined();
    expect(ev.modelUsedSource).toBeUndefined();
    expect(ev.requestedModel).toBe('flash');
    expect(ev.downgrade).toBe('asked');
  });

  it.each([['pass'], ['allow'], ['ask'], ['force_ask']])('%s keeps modelUsed and modelUsedSource', (decision) => {
    const ev = agy({ decision }, { TypeName: 'x', Model: 'flash' });
    expect(ev.modelUsed).toBe('flash');
    expect(ev.modelUsedSource).toBe('requested');
  });
});

describe('Claude Code agent_call: decision, and modelUsed only when the call goes ahead', () => {
  const pre = (extra: Record<string, unknown>) => ({ hook: 'PreToolUse', event: 'agent_call', session_id: 's1', turn: 't1', ...extra });

  it('telemetryEvent: decision deny leaves modelUsed and modelUsedSource unset and keeps the decision', () => {
    const e = telemetryEvent(pre({ decision: 'deny', requested_model: 'opus', sessionModel: 'claude-sonnet-5-5' }));
    expect('modelUsed' in e).toBe(false);
    expect('modelUsedSource' in e).toBe(false);
    expect(e.decision).toBe('deny');
    expect(e.requestedModel).toBe('opus');
  });

  it.each([['pass'], ['allow'], ['ask']])('telemetryEvent: %s keeps modelUsed', (decision) => {
    const e = telemetryEvent(pre({ decision, requested_model: 'haiku', sessionModel: 'claude-sonnet-5-5' }));
    expect(e).toMatchObject({ modelUsed: 'haiku', modelUsedSource: 'requested', decision });
  });

  const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };
  function deps(logs: Record<string, unknown>[]): HookDeps {
    const turns = new Map<string, any>();
    return {
      readMode: async () => 'on',
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
  const call = (model: string): HookInput => ({
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Agent',
    tool_input: { description: 'WS1: refactor', prompt: 'Refactor it.', subagent_type: 'code-engineer', model }
  });

  it('the hook logs decision "deny" for the choice-flow denial and the telemetry row has no modelUsed', async () => {
    const logs: Record<string, unknown>[] = [];
    await onPreToolUse(call('opus'), deps(logs));
    expect(logs[0]).toMatchObject({ event: 'agent_call', decision: 'deny', requested_model: 'opus' });
    const e = telemetryEvent(logs[0]);
    expect('modelUsed' in e).toBe(false);
    expect('modelUsedSource' in e).toBe(false);
  });

  it('the hook logs decision "pass" for a call within the ceiling, with modelUsed', async () => {
    const logs: Record<string, unknown>[] = [];
    await onPreToolUse(call('haiku'), deps(logs));
    expect(logs[0]).toMatchObject({ event: 'agent_call', decision: 'pass' });
    expect(telemetryEvent(logs[0])).toMatchObject({ modelUsed: 'haiku', modelUsedSource: 'requested', decision: 'pass' });
  });

  it('a native ask keeps modelUsed (the run may go ahead)', async () => {
    const logs: Record<string, unknown>[] = [];
    const d = { ...deps(logs), env: { JEV_ELEVATION: 'dialog' } };
    await onPreToolUse(call('opus'), d);
    expect(logs[0]).toMatchObject({ decision: 'ask' });
    expect(telemetryEvent(logs[0])).toMatchObject({ modelUsed: 'opus', modelUsedSource: 'requested' });
  });
});
