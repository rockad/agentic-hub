/**
 * The Workflow guard inside the PreToolUse hook (claude/hook.ts): a literal model above the session model takes the
 * Agent tool's choice flow (deny with the prescribed [jev-elevate:<model>] question, approvals, the per-script attempt
 * counter, the dialog on the third attempt); anything the static analysis cannot prove opens the permission dialog;
 * a user instruction naming the model passes. Mode off and an unknown session model leave the call alone.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { onPostToolUse, onPreToolUse, type HookDeps } from '../claude/hook.ts';
import { parseElevationAnswer, type RankContext } from '../claude/logic.ts';
import { workflowSignature } from '../claude/workflow-guard.ts';
import { out, rig, wf, type Rig } from './workflow-helpers.ts';

const SAMPLE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'posttooluse-askuserquestion.json'), 'utf8'));
const MARKED = (model: string) => `[jev-elevate:${model}] Run the Workflow on ${model} (session sonnet): refactor the parser module?`;
function answered(question: string, label: string): Record<string, any> {
  const s = structuredClone(SAMPLE);
  for (const part of [s.tool_input, s.tool_response]) {
    part.questions[0].question = question;
    part.answers = { [question]: label };
  }
  return s;
}

let r: Rig;
afterEach(() => r?.cleanup());
const setup = (overrides: Partial<HookDeps> = {}, session?: string) => (r = rig(overrides, session));

const OPUS = `export const meta = { name: 'x', description: 'y' }\nconst a = await agent('SECRET-PROMPT', { model: 'opus' })\nreturn a`;
const INHERIT = `const a = await agent('p')\nreturn a`;
const answer = async (label: string, model = 'opus') => {
  r.d.approvals!.deny('s1', model, r.d.now!());
  await onPostToolUse({ ...answered(MARKED(model), label), session_id: 's1' } as any, r.d);
};

describe('the elevation choice flow for a Workflow', () => {
  it('denies a literal opus in a sonnet session with the [jev-elevate:opus] marker, and logs hashes, never the script', async () => {
    setup();

    const o = out(await onPreToolUse(wf({ script: OPUS }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate:opus]');
    expect(o.permissionDecisionReason).toContain("exactly four options in this order and with these labels: 'Yes, once', 'Yes, for the next 5 minutes', 'Yes, for this session', 'No, proceed on sonnet'");
    expect(o.permissionDecisionReason).toContain('Workflow');
    expect(o.permissionDecisionReason).not.toContain('SECRET');
    const log = r.logs[0];
    expect(log).toMatchObject({ tool_name: 'Workflow', workflow_guard: 'denied', workflow_models: ['opus'], elevation: 'denied', elevation_attempt: 1, workflow_highest: 'opus' });
    expect((log.workflow_scripts as any[])[0]).toMatchObject({ label: '<inline>', bytes: Buffer.byteLength(OPUS) });
    expect(JSON.stringify(r.logs)).not.toContain('SECRET');
    expect(JSON.stringify(r.logs)).not.toContain('await agent');
  });

  it('names the strongest model of several, and logs every literal ranked', async () => {
    setup();
    const script = `await agent('a', {model: 'haiku'})\nawait agent('b', {model: 'opus'})\nawait agent('c', {model: 'fable'})`;

    const o = out(await onPreToolUse(wf({ script }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:fable]');
    expect(r.logs[0]).toMatchObject({ workflow_models: ['haiku', 'opus', 'fable'], workflow_highest: 'fable' });
  });

  it('a user instruction naming the model passes, logged passed-instructed', async () => {
    setup();
    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', intent: { models: ['opus'] } });

    expect(await onPreToolUse(wf({ script: OPUS }, r), r.d)).toBeNull();

    expect(r.logs[0]).toMatchObject({ workflow_guard: 'passed-instructed', elevation: 'instructed', workflow_models: ['opus'] });
  });

  it('an instruction that names a different, weaker model does not cover it', async () => {
    setup();
    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', intent: { models: ['sonnet'] } });

    expect(out(await onPreToolUse(wf({ script: OPUS }, r), r.d)).permissionDecision).toBe('deny');
  });

  it('a stale instruction (another prompt id) is not an instruction', async () => {
    setup();
    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', promptId: 'older', intent: { models: ['opus'] } });

    expect(out(await onPreToolUse(wf({ script: OPUS }, r), r.d)).permissionDecision).toBe('deny');
  });

  it.each([['once'], ['5min'], ['session']] as const)('an approved opus passes (%s), then the retried call is the same script', async (scope) => {
    setup();
    expect(out(await onPreToolUse(wf({ script: OPUS }, r), r.d)).permissionDecision).toBe('deny');
    await answer(scope === 'once' ? 'Yes, once' : scope === '5min' ? 'Yes, for the next 5 minutes' : 'Yes, for this session');

    const retry = await onPreToolUse(wf({ script: OPUS }, r, {}, 'toolu_02'), r.d);

    expect(retry).toBeNull();
    expect(r.logs.at(-1)).toMatchObject({ workflow_guard: 'allow', elevation: 'approved', approval_scope: scope });
  });

  it('an approval of opus covers a sonnet-or-lower script, a "once" is consumed by the first launch', async () => {
    setup();
    await onPreToolUse(wf({ script: OPUS }, r), r.d);
    await answer('Yes, once');

    expect(await onPreToolUse(wf({ script: OPUS }, r, {}, 'toolu_02'), r.d)).toBeNull();
    expect(out(await onPreToolUse(wf({ script: OPUS }, r, {}, 'toolu_03'), r.d)).permissionDecision).toBe('deny');
  });

  it('an approval of sonnet does not cover opus', async () => {
    setup();
    await onPreToolUse(wf({ script: OPUS }, r), r.d);
    await answer('Yes, for this session', 'sonnet');

    expect(out(await onPreToolUse(wf({ script: OPUS }, r), r.d)).permissionDecision).toBe('deny');
  });

  it('every attempt of the same script is denied (never asked); from the third the reason says to stop retrying; a different script counts on its own', async () => {
    setup();
    const outs = [];
    for (let i = 1; i <= 4; i++) outs.push(out(await onPreToolUse(wf({ script: OPUS }, r, {}, `toolu_${i}`), r.d)));
    const other = out(await onPreToolUse(wf({ script: `${OPUS}\n// another` }, r, {}, 'toolu_9'), r.d));

    expect(outs.map((o) => o.permissionDecision)).toEqual(['deny', 'deny', 'deny', 'deny']);
    expect(outs.map((o) => String(o.permissionDecisionReason).includes('stop retrying'))).toEqual([false, false, true, true]);
    expect(r.logs[2]).toMatchObject({ workflow_guard: 'denied', elevation: 'denied', elevation_attempt: 3 });
    expect(other.permissionDecision).toBe('deny');
    expect(String(other.permissionDecisionReason)).not.toContain('stop retrying');
  });

  it('the attempt counter is keyed by a signature of the script hashes', () => {
    const a = workflowSignature([{ label: '<inline>', sha256: 'a'.repeat(64), bytes: 1 }]);
    const b = workflowSignature([{ label: '<inline>', sha256: 'b'.repeat(64), bytes: 1 }]);

    expect(a).toMatch(/^wf:[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it('without a working approvals store it still denies, never asks (no counter, so no stop-retrying text)', async () => {
    setup({ approvals: undefined });

    const o = out(await onPreToolUse(wf({ script: OPUS }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(String(o.permissionDecisionReason)).not.toContain('stop retrying');
  });

  it('JEV_ELEVATION=dialog asks at once, with the sites listed', async () => {
    setup({ env: { JEV_ELEVATION: 'dialog' } });
    const o = out(await onPreToolUse(wf({ script: OPUS }, r), r.d));
    expect(o.permissionDecision).toBe('ask');
    expect(o).not.toHaveProperty('updatedInput');
    expect(o.permissionDecisionReason).toContain('<inline>:2:');
  });

  it('JEV_ELEVATION=clamp takes the choice flow (a script cannot be clamped): deny with the prescribed question, approval passes, never ask', async () => {
    setup({ env: { JEV_ELEVATION: 'clamp' } });

    const o = out(await onPreToolUse(wf({ script: OPUS }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o).not.toHaveProperty('updatedInput');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(r.logs[0]).toMatchObject({ workflow_guard: 'denied', elevation: 'denied', elevation_attempt: 1 });

    await answer('Yes, for this session');
    expect(await onPreToolUse(wf({ script: OPUS }, r, {}, 'toolu_2'), r.d)).toBeNull();
  });

  it('the PostToolUse recorder accepts the answer to the Workflow question like any other marked question', () => {
    setup();
    const a = parseElevationAnswer({ ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 's1' }, 1);

    expect(a).toMatchObject({ model: 'opus', scope: 'session' });
  });
});

describe('what passes', () => {
  it('an agent() with no model inherits the session model', async () => {
    setup();

    expect(await onPreToolUse(wf({ script: INHERIT }, r), r.d)).toBeNull();
    expect(r.logs[0]).toMatchObject({ workflow_guard: 'allow', workflow_models: [] });
  });

  it.each([['sonnet'], ['haiku'], ['claude-sonnet-5-5'], ['inherit']])('a literal %s in a sonnet session', async (m) => {
    setup();

    expect(await onPreToolUse(wf({ script: `await agent('p', {model: '${m}'})` }, r), r.d)).toBeNull();
  });

  it('an opus session may run an opus workflow', async () => {
    setup({}, 'claude-opus-5-5');

    expect(await onPreToolUse(wf({ script: OPUS }, r), r.d)).toBeNull();
  });

  it('mode off and on-demand leave a Workflow alone (on-demand only records a pass row), whatever it holds', async () => {
    setup();
    for (const mode of ['off', 'on-demand']) {
      r.mode.value = mode;
      expect(await onPreToolUse(wf({ script: OPUS }, r), r.d)).toBeNull();
    }
    // Off writes nothing; on-demand leaves the Workflow alone (no output) and only records the pass row.
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatchObject({ event: 'agent_call', tool_name: 'Workflow', decision: 'pass' });
  });

  // 2.3.19: this used to expect null for an unknown session model (fail open). It is now assumed sonnet (fail closed).
  it('an unknown session model is assumed sonnet: a literal opus is denied, and the reason says so', async () => {
    setup({ readSessionModel: () => null });

    const o = (await onPreToolUse(wf({ script: OPUS }, r), r.d))?.hookSpecificOutput as Record<string, any>;

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(o.permissionDecisionReason).toContain('The session model is not known yet, so Jev assumes sonnet.');
    expect(r.logs.at(-1)).toMatchObject({ workflow_guard: 'denied', sessionModel: 'sonnet', session_model_source: 'assumed', sessionModelAssumed: true });
  });

  it('a Workflow is not rated for a downgrade', async () => {
    let rated = 0;
    setup({ rateTask: async () => (rated++, null), downgrades: {} as any });

    await onPreToolUse(wf({ script: INHERIT }, r), r.d);

    expect(rated).toBe(0);
  });

  it('the version of a model inside one family is not an elevation (the Agent guard says the same)', async () => {
    setup({}, 'claude-opus-4-8');

    expect(await onPreToolUse(wf({ script: `await agent('p', {model: 'claude-opus-5-5'})` }, r), r.d)).toBeNull();
  });
});

describe('what is understood, and what is denied with guidance (dialog mode asks)', () => {
  it("`const M = 'opus'` then `model: M` is understood: the model is ranked as if written", async () => {
    setup();

    const o = out(await onPreToolUse(wf({ script: `const M = 'opus'\nawait agent('p', {model: M})` }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(await onPreToolUse(wf({ script: `const M = 'haiku'\nawait agent('p', {model: M})` }, r), r.d)).toBeNull();
  });

  it.each([
    ['a model from args', `await agent('p', {model: args.model})`, 'model is not a plain string literal'],
    ['a model from a let', `let m = 'opus'\nawait agent('p', {model: m})`, 'model is not a plain string literal'],
    ['an unparseable script', `await agent('p', {model: )`, 'does not parse'],
    ['an aliased agent', `const a = agent\nawait a('p', {model: 'opus'})`, 'aliased'],
    ['a spread of options', `await agent('p', {...opts})`, 'spread'],
    ['a dynamic import', `await import('x')`, 'dynamic import'],
    ['an escape identifier', `globalThis.agent('p')`, 'globalThis'],
    ['an unknown model', `await agent('p', {model: 'gpt-5'})`, 'not a model Jev can rank'],
    ['an effort level Jev does not recognise', `await agent('p', {effort: 'ludicrous'})`, 'not a level Jev recognises'],
    ['an effort that is not a literal', `await agent('p', {effort: args.level})`, 'effort is not a plain string literal']
  ])('%s is denied with guidance in choice and clamp (never asked), and asks in dialog mode', async (_n, script, why) => {
    for (const mode of ['choice', 'clamp']) {
      setup({ env: { JEV_ELEVATION: mode } });

      const o = out(await onPreToolUse(wf({ script }, r), r.d));

      expect(o.permissionDecision).toBe('deny');
      expect(o.permissionDecisionReason).toContain(why);
      expect(o.permissionDecisionReason).toContain('Change the Workflow');
      expect(o.permissionDecisionReason).toMatch(/\d+ site\(s\) Jev cannot verify/);
      expect(r.logs[0]).toMatchObject({ decision: 'deny', workflow_guard: 'denied-unverifiable', elevation: 'denied', workflow_reasons: expect.any(Number) });
      expect(r.logs[0]).not.toHaveProperty('elevation_attempt');
      // the reason carries sites and reasons, never script text
      expect(String(o.permissionDecisionReason)).not.toContain(script);
      r.cleanup();
    }

    setup({ env: { JEV_ELEVATION: 'dialog' } });
    const asked = out(await onPreToolUse(wf({ script }, r), r.d));
    expect(asked.permissionDecision).toBe('ask');
    expect(asked.permissionDecisionReason).toContain(why);
    expect(asked.permissionDecisionReason).toContain('sha256:');
    expect(r.logs[0]).toMatchObject({ workflow_guard: 'asked', elevation: 'asked' });
  });

  it('a mix of an elevation and an unverifiable site is denied once, naming both; fixing the unverifiable site then reaches the choice question', async () => {
    setup();

    const o = out(await onPreToolUse(wf({ script: `await agent('a', {model: 'opus'})\nawait agent('b', {model: args.m})` }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('stronger than the session model');
    expect(o.permissionDecisionReason).toContain('not a plain string literal');
    expect(o.permissionDecisionReason).not.toContain('[jev-elevate:');

    const fixed = out(await onPreToolUse(wf({ script: `await agent('a', {model: 'opus'})\nawait agent('b', {model: 'haiku'})` }, r, {}, 'toolu_2'), r.d));
    expect(fixed.permissionDecisionReason).toContain('[jev-elevate:opus]');
  });

  it('a Workflow input with none of script, scriptPath or name is denied', async () => {
    setup();

    expect(out(await onPreToolUse(wf({ args: { a: 1 } }, r), r.d)).permissionDecision).toBe('deny');
  });

  it('an unrankable id in a catalogue session is denied as unverifiable (never as a choice question it cannot name)', async () => {
    const cat = { models: [{ id: 'claude-sonnet-5-5', status: 'ok' }] } as any;
    setup({ rankContext: () => ({ cat }) as RankContext });

    const o = out(await onPreToolUse(wf({ script: `await agent('p', {model: 'some-new-model'})` }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).not.toContain('[jev-elevate:');
  });
});

describe('agent definitions', () => {
  const agents = (): string => {
    const dir = path.join(r.project, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('an agentType whose definition names opus is caught', async () => {
    setup();
    fs.writeFileSync(path.join(agents(), 'deep.md'), '---\nname: deep\nmodel: opus\n---\nbody\n');

    const o = out(await onPreToolUse(wf({ script: `await agent('p', {agentType: 'deep'})` }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(r.logs[0]).toMatchObject({ workflow_models: ['opus'] });
  });

  it('an agentType whose definition names no model, or a lower one, inherits or passes', async () => {
    setup();
    fs.writeFileSync(path.join(agents(), 'plain.md'), '---\nname: plain\ndescription: x\n---\n');
    fs.writeFileSync(path.join(agents(), 'cheap.md'), '---\nmodel: haiku\n---\n');

    expect(await onPreToolUse(wf({ script: `await agent('p', {agentType: 'plain'})\nawait agent('q', {agentType: 'cheap'})` }, r), r.d)).toBeNull();
  });

  it('an agentType with no definition is denied; an explicit model on the call wins over the definition', async () => {
    setup();
    fs.writeFileSync(path.join(agents(), 'deep.md'), '---\nmodel: opus\n---\n');

    expect(out(await onPreToolUse(wf({ script: `await agent('p', {agentType: 'ghost'})` }, r), r.d)).permissionDecision).toBe('deny');
    expect(await onPreToolUse(wf({ script: `await agent('p', {agentType: 'deep', model: 'haiku'})` }, r), r.d)).toBeNull();
  });
});

describe('scriptPath and name', () => {
  it('a scriptPath file is read and analysed on every call', async () => {
    setup();
    const file = path.join(r.project, 'wf.js');
    fs.writeFileSync(file, INHERIT);
    expect(await onPreToolUse(wf({ scriptPath: file }, r, {}, 'toolu_1'), r.d)).toBeNull();

    fs.writeFileSync(file, OPUS);

    expect(out(await onPreToolUse(wf({ scriptPath: file }, r, {}, 'toolu_2'), r.d)).permissionDecision).toBe('deny');
  });

  it('a saved workflow name is resolved from .claude/workflows, and a nested workflow() one level', async () => {
    setup();
    const dir = path.join(r.project, '.claude', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'parent.js'), `await workflow('child')`);
    fs.writeFileSync(path.join(dir, 'child.js'), `await agent('c', {model: 'opus'})`);

    const o = out(await onPreToolUse(wf({ name: 'parent' }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(r.logs[0].workflow_scripts).toHaveLength(2);
  });
});

describe('the environment model variables', () => {
  it('CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL replaces the call model: an opus there makes an inheriting script an elevation', async () => {
    setup({ env: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'opus' } });

    const o = out(await onPreToolUse(wf({ script: INHERIT }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(r.logs[0]).toMatchObject({ workflow_models: ['opus'] });
  });

  it('CLAUDE_CODE_SUBAGENT_MODEL applies only when the call and its definition name no model', async () => {
    setup({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });

    expect(out(await onPreToolUse(wf({ script: INHERIT }, r), r.d)).permissionDecision).toBe('deny');
    expect(await onPreToolUse(wf({ script: `await agent('p', {model: 'haiku'})` }, r, {}, 'toolu_2'), r.d)).toBeNull();
  });
});

describe('failing open', () => {
  it('an internal error in the guard never blocks: the call passes, logged as an error', async () => {
    setup({ workflowResolver: () => { throw new Error('boom'); } });

    expect(await onPreToolUse(wf({ script: OPUS }, r), r.d)).toBeNull();
    expect(r.logs[0]).toMatchObject({ workflow_guard: 'error' });
  });

  it('an oversized script is denied (the analysis refuses it), it is not an internal error', async () => {
    setup();

    const o = out(await onPreToolUse(wf({ script: `// ${'x'.repeat(600 * 1024)}\nawait agent('p')` }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('byte limit');
  });
});
