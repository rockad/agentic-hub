/**
 * The pure result of the Workflow guard that the hook turns into a response: `decision`, `reasons`, `highestRequested`,
 * the split between elevations and unverifiable sites, and agentic-hub's own ranking (family-first, intent, catalogue).
 */
import { describe, it, expect } from 'bun:test';
import { evaluateWorkflowInput, NO_FS_RESOLVER } from '../claude/workflow-guard.ts';
import type { RankContext } from '../claude/logic.ts';

const SESSION = 'claude-sonnet-5-5';
const evalScript = (script: string, session: string | null = SESSION, ctx = {}) => evaluateWorkflowInput({ script }, '/nowhere', session, NO_FS_RESOLVER, { env: {}, ...ctx });

describe('the result', () => {
  it('allow: no reasons, no highest model, no sites', () => {
    const d = evalScript(`await agent('p')`);

    expect(d).toMatchObject({ decision: 'allow', reasons: [], sites: [], elevations: [], unverifiable: [], instructed: false, message: '', models: [] });
    expect(d.highestRequested).toBeUndefined();
    expect(d.scripts).toHaveLength(1);
  });

  it('names the strongest uninstructed elevation, with the session alias', () => {
    const d = evalScript(`await agent('a', {model: 'opus'})\nawait agent('b', {model: 'fable'})\nawait agent('c', {model: 'haiku'})`);

    expect(d.decision).toBe('ask');
    expect(d.highestRequested).toBe('fable');
    expect(d.highestElevation).toMatchObject({ requested: 'fable', sessionAlias: 'sonnet', kind: 'elevating' });
    expect(d.elevations).toHaveLength(2);
    expect(d.unverifiable).toEqual([]);
    expect(d.models).toEqual(['opus', 'fable', 'haiku']);
    expect(d.reasons[0]).toMatch(/^<inline>:1:\d+ agent\(\) call: model "opus" is stronger than the session model "claude-sonnet-5-5"$/);
  });

  it('keeps elevations and unverifiable sites apart, in script order in `reasons`', () => {
    const d = evalScript(`await agent('a', {model: args.m})\nawait agent('b', {model: 'opus'})`);

    expect(d.elevations).toHaveLength(1);
    expect(d.unverifiable).toHaveLength(1);
    expect(d.sites.map((s) => s.kind)).toEqual(['unverifiable', 'elevation']);
    expect(d.reasons).toHaveLength(2);
    expect(d.highestRequested).toBe('opus');
  });

  it('a named model passes: no sites, `instructed` set, the model still listed', () => {
    const d = evalScript(`await agent('a', {model: 'opus'})`, SESSION, { intent: { models: ['opus'] } });

    expect(d).toMatchObject({ decision: 'allow', instructed: true, models: ['opus'] });
    expect(evalScript(`await agent('a', {model: 'fable'})`, SESSION, { intent: { models: ['opus'] } }).decision).toBe('ask');
  });

  it('clips a script-supplied literal in a reason', () => {
    const long = 'x'.repeat(300);
    const d = evalScript(`await agent('a', {model: '${long}'})`);

    expect(d.reasons[0]).not.toContain(long);
    expect(d.reasons[0]).toContain('is not a model Jev can rank');
    expect(d.models.every((m) => m.length === 300)).toBe(true); // the raw list is for the caller, which clips what it logs
  });
});

describe('agentic-hub ranking', () => {
  it('is family-first: the family decides across families, a version step inside a family is not an elevation', () => {
    expect(evalScript(`await agent('a', {model: 'claude-opus-5-5'})`).decision).toBe('ask');
    expect(evalScript(`await agent('a', {model: 'claude-sonnet-5'})`).decision).toBe('allow');
    expect(evalScript(`await agent('a', {model: 'claude-opus-5-5'})`, 'claude-opus-4-8').decision).toBe('allow');
    expect(evalScript(`await agent('a', {model: 'sonnet'})`, 'claude-haiku-5-5').decision).toBe('ask');
  });

  it('an id the family table does not know asks as unverifiable, with or without a catalogue', () => {
    const cat = { models: [{ id: 'claude-sonnet-5-5', status: 'ok' }] } as any;
    for (const ctx of [{}, { rank: { cat } as RankContext }]) {
      const d = evalScript(`await agent('a', {model: 'gpt-5'})`, SESSION, ctx);
      expect(d.unverifiable).toHaveLength(1);
      expect(d.elevations).toEqual([]);
    }
  });

  it('a session model Jev cannot rank makes every literal unverifiable; an inheriting script still passes', () => {
    expect(evalScript(`await agent('a', {model: 'haiku'})`, 'some-other-model').unverifiable).toHaveLength(1);
    expect(evalScript(`await agent('a')`, 'some-other-model').decision).toBe('allow');
  });
});

describe('the subagent model variables', () => {
  const env = (e: Record<string, string>) => ({ env: e });

  it('CLAUDE_CODE_SUBAGENT_MODEL_FORCE replaces the call model, inherit included', () => {
    const d = evalScript(`await agent('a', {model: 'haiku'})`, SESSION, env({ CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }));

    expect(d.highestRequested).toBe('opus');
    expect(d.reasons[0]).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE');
  });

  it('a workflow model and a different forced model are both ranked (the first elevation is reported per call)', () => {
    const d = evalScript(`await agent('a')`, SESSION, env({ CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL: 'fable', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'true' }));

    expect(d.highestRequested).toBe('fable');
    expect(d.models).toEqual(['haiku', 'fable']);
  });

  it('a variable set to inherit or empty is not a model', () => {
    expect(evalScript(`await agent('a')`, SESSION, env({ CLAUDE_CODE_SUBAGENT_MODEL: 'inherit', CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: '  ' })).decision).toBe('allow');
  });

  it('the meta.phases model is a display hint: ranked as written, no environment override', () => {
    const d = evalScript(`export const meta = { name: 'a', description: 'b', phases: [{ title: 'T', model: 'opus' }] }`, SESSION, env({ CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'haiku' }));

    expect(d.highestRequested).toBe('opus');
    expect(d.reasons[0]).toContain('progress-display hint');
  });
});

describe('a missing parser', () => {
  it('is a finding that asks, never a crash (the other hooks keep working without acorn)', async () => {
    const { setAcornLoaderForTesting } = await import('../claude/workflow-guard.ts');
    setAcornLoaderForTesting(() => {
      throw new Error("Cannot find package 'acorn'");
    });
    try {
      const d = evalScript(`await agent('p')`);

      expect(d.decision).toBe('ask');
      expect(d.reasons[0]).toContain('acorn parser is not available');
    } finally {
      setAcornLoaderForTesting(null);
    }
    expect(evalScript(`await agent('p')`).decision).toBe('allow');
  });
});
