/**
 * Session model and model-used source in telemetry (Claude Code hook, and the helper both harnesses share).
 *
 * Contract: every record that knows the session model carries sessionModel and sessionModelSource; UserPromptSubmit
 * carries modelRecommended only; PreToolUse agent_call carries modelUsed = clamped ?? downgraded ?? requested ?? session
 * model and modelUsedSource = clamped | downgraded | requested | inherited.
 */
import { describe, it, expect } from 'bun:test';
import { onPreToolUse, onUserPromptSubmit, telemetryEvent, type HookDeps } from '../claude/hook.ts';
import { resolveModelUsed } from '../src/core/telemetry.ts';
import { flashRec } from './parity-helpers.ts';
import { memoryClaim } from './elevation-helpers.ts';

describe('resolveModelUsed (shared by both harnesses)', () => {
  it('clamped wins over everything', () => {
    expect(resolveModelUsed({ clampedTo: 'sonnet', downgradedTo: 'haiku', requested: 'opus', sessionModel: 'claude-sonnet-5-5' })).toEqual({
      modelUsed: 'sonnet',
      modelUsedSource: 'clamped'
    });
  });

  it('an applied downgrade wins over the requested and the session model', () => {
    expect(resolveModelUsed({ downgradedTo: 'haiku', requested: 'opus', sessionModel: 'claude-sonnet-5-5' })).toEqual({
      modelUsed: 'haiku',
      modelUsedSource: 'downgraded'
    });
  });

  it('the requested model wins over the session model', () => {
    expect(resolveModelUsed({ requested: 'opus', sessionModel: 'claude-sonnet-5-5' })).toEqual({ modelUsed: 'opus', modelUsedSource: 'requested' });
  });

  it('a call that named no model inherits the session model', () => {
    expect(resolveModelUsed({ sessionModel: 'claude-sonnet-5-5' })).toEqual({ modelUsed: 'claude-sonnet-5-5', modelUsedSource: 'inherited' });
    expect(resolveModelUsed({ requested: null, sessionModel: 'claude-sonnet-5-5' }).modelUsedSource).toBe('inherited');
  });

  it('the literal "inherit" is no model: it inherits', () => {
    expect(resolveModelUsed({ requested: 'inherit', sessionModel: 'claude-sonnet-5-5' })).toEqual({
      modelUsed: 'claude-sonnet-5-5',
      modelUsedSource: 'inherited'
    });
    expect(resolveModelUsed({ requested: ' Inherit ' }).modelUsedSource).toBe('inherited');
  });

  it('no model named and no session model: modelUsed is absent, the source is still inherited', () => {
    const r = resolveModelUsed({});
    expect(r).toEqual({ modelUsedSource: 'inherited' });
    expect('modelUsed' in r).toBe(false);
    expect(resolveModelUsed({ requested: '', sessionModel: null, clampedTo: undefined })).toEqual({ modelUsedSource: 'inherited' });
  });
});

describe('telemetryEvent: PreToolUse agent_call', () => {
  const pre = (extra: Record<string, unknown>) => ({ hook: 'PreToolUse', event: 'agent_call', session_id: 's1', turn: 't1', ...extra });

  it('clamped: modelUsed is the session alias the call was clamped to', () => {
    const e = telemetryEvent(pre({ requested_model: 'opus', clamped_to: 'sonnet', sessionModel: 'claude-sonnet-5-5', session_model_source: 'stored' }));
    expect(e).toMatchObject({ modelUsed: 'sonnet', modelUsedSource: 'clamped', sessionModel: 'claude-sonnet-5-5', sessionModelSource: 'stored' });
  });

  it('downgraded: only when the downgrade was applied', () => {
    const applied = telemetryEvent(pre({ requested_model: 'opus', downgrade: 'applied', downgrade_to: 'haiku', sessionModel: 'claude-sonnet-5-5' }));
    expect(applied).toMatchObject({ modelUsed: 'haiku', modelUsedSource: 'downgraded' });

    for (const downgrade of ['asked', 'skipped', 'answered']) {
      const e = telemetryEvent(pre({ requested_model: 'opus', downgrade, downgrade_to: 'haiku', sessionModel: 'claude-sonnet-5-5' }));
      expect(e).toMatchObject({ modelUsed: 'opus', modelUsedSource: 'requested' });
    }
  });

  it('requested: the model the call named', () => {
    const e = telemetryEvent(pre({ requested_model: 'haiku', sessionModel: 'claude-sonnet-5-5', session_model_source: 'transcript' }));
    expect(e).toMatchObject({ modelUsed: 'haiku', modelUsedSource: 'requested', sessionModelSource: 'transcript' });
  });

  it('inherited: no model on the call, so the session model', () => {
    const e = telemetryEvent(pre({ requested_model: null, model: null, sessionModel: 'claude-sonnet-5-5', session_model_source: 'stored' }));
    expect(e).toMatchObject({ modelUsed: 'claude-sonnet-5-5', modelUsedSource: 'inherited' });
  });

  it('inherited with an unknown session model: modelUsed absent, source inherited, session fields null', () => {
    const e = telemetryEvent(pre({ requested_model: null, sessionModel: null, session_model_source: null }));
    expect('modelUsed' in e).toBe(false);
    expect(e).toMatchObject({ modelUsedSource: 'inherited', sessionModel: null, sessionModelSource: null });
  });

  it('an entry written without a session-model lookup carries no session fields', () => {
    const e = telemetryEvent(pre({ requested_model: 'opus' }));
    expect('sessionModel' in e).toBe(false);
    expect('sessionModelSource' in e).toBe(false);
  });
});

describe('telemetryEvent: UserPromptSubmit', () => {
  it('carries modelRecommended and the session model, and neither modelUsed nor modelUsedSource', () => {
    const e = telemetryEvent({
      hook: 'UserPromptSubmit',
      session_id: 's1',
      turn: 't1',
      recommended_model: 'sonnet',
      sessionModel: 'claude-sonnet-5-5',
      session_model_source: 'stored'
    });
    expect(e).toMatchObject({ modelRecommended: 'sonnet', sessionModel: 'claude-sonnet-5-5', sessionModelSource: 'stored' });
    expect('modelUsed' in e).toBe(false);
    expect('modelUsedSource' in e).toBe(false);
  });

  it('stays free of modelUsed even when a requested or clamped model is somehow on the entry', () => {
    const e = telemetryEvent({ hook: 'UserPromptSubmit', session_id: 's1', requested_model: 'opus', clamped_to: 'sonnet', model: 'opus', sessionModel: null });
    expect('modelUsed' in e).toBe(false);
    expect(e.sessionModel).toBeNull();
  });
});

describe('through the real handlers', () => {
  const setup = (overrides: Partial<HookDeps> = {}) => {
    const logs: Record<string, unknown>[] = [];
    const turns = new Map<string, any>();
    const d: HookDeps = {
      readMode: async () => 'on',
      readSessionModel: () => 'claude-sonnet-5-5',
      readQuotaStrategy: async () => 'unknown',
      dispatch: async () => flashRec,
      log: (e) => logs.push(e as Record<string, unknown>),
      claimClamp: memoryClaim(),
      readTurn: (s) => turns.get(s ?? '') ?? null,
      saveTurn: (s, st) => void turns.set(s ?? '', st),
      ...overrides,
      env: { JEV_ELEVATION: 'clamp', ...(overrides.env ?? {}) }
    };
    return { d, logs };
  };

  it('the prompt record has the baseline and the advice, never modelUsed and never the prompt text', async () => {
    const { d, logs } = setup();
    const prompt = 'Refactor the zebra-striped invoice exporter and rename quokkaWidget everywhere';

    await onUserPromptSubmit({ session_id: 's1', prompt }, d);

    expect(logs).toHaveLength(1);
    const event = telemetryEvent(logs[0]);
    expect(event).toMatchObject({
      toolOrHook: 'UserPromptSubmit',
      sessionModel: 'claude-sonnet-5-5',
      sessionModelSource: 'stored',
      modelRecommended: 'sonnet'
    });
    expect('modelUsed' in event).toBe(false);
    expect(JSON.stringify(event)).not.toContain('zebra');
    expect(JSON.stringify(event)).not.toContain('quokka');
  });

  it('an Agent call that names a model above the session is clamped, and says so', async () => {
    const { d, logs } = setup();

    await onPreToolUse({ session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_input: { description: 'x', prompt: 'secret-brief-text', subagent_type: 'Explore', model: 'opus' } }, d);

    const event = telemetryEvent(logs[0]);
    expect(event).toMatchObject({ modelUsed: 'sonnet', modelUsedSource: 'clamped', sessionModel: 'claude-sonnet-5-5', sessionModelSource: 'stored' });
    expect(JSON.stringify(event)).not.toContain('secret-brief-text');
  });

  it('an Agent call that names a model within the ceiling is requested', async () => {
    const { d, logs } = setup();

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { description: 'x', prompt: 'y', subagent_type: 'Explore', model: 'haiku' } }, d);

    expect(telemetryEvent(logs[0])).toMatchObject({ modelUsed: 'haiku', modelUsedSource: 'requested' });
  });

  it('an Agent call with no model, or "inherit", is inherited from the session', async () => {
    for (const tool_input of [
      { description: 'x', prompt: 'y', subagent_type: 'Explore' },
      { description: 'x', prompt: 'y', subagent_type: 'Explore', model: 'inherit' }
    ]) {
      const { d, logs } = setup();
      await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input }, d);
      expect(telemetryEvent(logs[0])).toMatchObject({ modelUsed: 'claude-sonnet-5-5', modelUsedSource: 'inherited', sessionModel: 'claude-sonnet-5-5' });
    }
  });

  it('an Agent call with no model and no known session model: modelUsed absent, source inherited', async () => {
    const { d, logs } = setup({ readSessionModel: () => null });

    await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: { description: 'x', prompt: 'y', subagent_type: 'Explore' } }, d);

    const event = telemetryEvent(logs[0]);
    expect('modelUsed' in event).toBe(false);
    expect(event).toMatchObject({ modelUsedSource: 'inherited', sessionModel: null, sessionModelSource: null });
  });
});
