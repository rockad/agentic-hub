/**
 * INTERIM narrow effort rule on the Agent/Task path (cognitive-engine RFC 007 says do not build further): a literal
 * `xhigh` or `max` on the call's `effort`, or on the effort of the definition behind its `subagent_type`, opens the
 * permission dialog. Dialog only: never the model choice flow, never a deny. Unrecognised levels, non-string values
 * and the "higher than the session" comparison are NOT checked here. `maxEffortLevel: "high"` in Claude Code settings
 * is the non-interim control.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { onPreToolUse, type HookDeps, type HookInput } from '../claude/hook.ts';
import { out, rig, type Rig } from './workflow-helpers.ts';

let r: Rig;
afterEach(() => r?.cleanup());
const setup = (overrides: Partial<HookDeps> = {}) => (r = rig(overrides));
const writeAgent = (file: string, text: string): void => {
  const f = path.join(r.project, '.claude', 'agents', file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const call = (toolInput: Record<string, unknown>, tool = 'Agent'): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: tool, cwd: r.project, tool_input: toolInput as any });

describe('call effort', () => {
  it.each(['xhigh', 'max'])('effort %s on the call asks (dialog), with the interim wording', async (effort) => {
    setup();

    const o = out(await onPreToolUse(call({ description: 'd', effort }), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecisionReason).toContain(`effort "${effort}"`);
    expect(o.permissionDecisionReason).toContain('interim');
    expect(r.logs[0]).toMatchObject({ effort_ask: true });
  });

  it('the Task tool name takes the same path', async () => {
    setup();

    expect(out(await onPreToolUse(call({ description: 'd', effort: 'max' }, 'Task'), r.d)).permissionDecision).toBe('ask');
  });

  it('low, medium and high pass', async () => {
    setup();
    for (const effort of ['low', 'medium', 'high']) expect(await onPreToolUse(call({ description: 'd', effort }), r.d)).toBeNull();
  });

  it('unrecognised levels, non-string values and the comparison with the session are not checked', async () => {
    setup();
    for (const effort of ['ludicrous', 'HIGH', 5, null, { a: 1 }, ['max'], '']) {
      expect(await onPreToolUse(call({ description: 'd', effort }), r.d)).toBeNull();
    }
  });

  it('asks every time (a dialog cannot loop), whatever the elevation counter says', async () => {
    setup();
    for (let i = 0; i < 4; i++) expect(out(await onPreToolUse(call({ description: 'd', effort: 'max' }), r.d)).permissionDecision).toBe('ask');
  });

  it('is never a deny and never the model choice flow, even with a model above the session on the same call', async () => {
    setup();

    const first = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));

    // The model elevation keeps its own verdict (the deny that prescribes the question); the effort ask follows on the retry.
    expect(first.permissionDecision).toBe('deny');
    expect(first.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(first.permissionDecisionReason).not.toContain('effort');
  });

  it('under the opt-in clamp the effort dialog is not hidden by the clamp allow', async () => {
    setup({ env: { JEV_ELEVATION: 'clamp' }, claimClamp: () => ({ first: true }) });

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.updatedInput).toBeUndefined();
  });

  it('mode off and an unknown session model do not change what passes: off passes, unknown still asks (effort needs no session model)', async () => {
    setup();
    r.mode.value = 'off';
    expect(await onPreToolUse(call({ description: 'd', effort: 'max' }), r.d)).toBeNull();

    r.mode.value = 'on';
    r.d.readSessionModel = () => null;
    expect(out(await onPreToolUse(call({ description: 'd', effort: 'max' }), r.d)).permissionDecision).toBe('ask');
  });

  it('a Workflow is unchanged: no effort ask from the Agent path', async () => {
    setup();

    expect(out(await onPreToolUse(call({ script: "await agent('p')", effort: 'max' }, 'Workflow'), r.d)).permissionDecision).toBeUndefined();
  });
});

describe('definition effort', () => {
  const def = (effort: string | null, model: string | null = null) => `---\nname: deep\n${model ? `model: ${model}\n` : ''}${effort === null ? '' : `effort: ${effort}\n`}---\nbody\n`;

  it.each(['xhigh', 'max'])('a definition with effort: %s asks, with or without a model on the call', async (effort) => {
    setup();
    writeAgent('deep.md', def(effort));

    for (const extra of [{}, { model: 'sonnet' }, { model: 'haiku' }]) {
      const o = out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep', ...extra }), r.d));
      expect(o.permissionDecision).toBe('ask');
      expect(o.permissionDecisionReason).toContain('definition');
      expect(o.permissionDecisionReason).toContain(`"${effort}"`);
    }
  });

  it('effort low, medium, high or none passes; an unrecognised definition effort is not checked', async () => {
    setup();
    for (const e of ['low', 'medium', 'high', null, 'ludicrous']) {
      writeAgent('deep.md', def(e));
      expect(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d)).toBeNull();
    }
  });

  it('a definition named like a built-in type is read like any other, so its effort asks', async () => {
    setup();
    writeAgent('Explore.md', def('max').replace('name: deep', 'name: Explore'));
    expect(out(await onPreToolUse(call({ description: 'd', subagent_type: 'Explore' }), r.d)).permissionDecision).toBe('ask');

    fs.rmSync(path.join(r.project, '.claude', 'agents', 'Explore.md'));
    expect(await onPreToolUse(call({ description: 'd', subagent_type: 'Explore' }), r.d)).toBeNull(); // no file claims the name
  });

  it('a definition that cannot be found adds nothing; an unreadable one, with a call model of its own, adds nothing', async () => {
    setup();
    expect(await onPreToolUse(call({ description: 'd', subagent_type: 'ghost' }), r.d)).toBeNull();

    writeAgent('deep.md', '---\nname: deep\neffort: [max]\n---\n');
    expect(await onPreToolUse(call({ description: 'd', subagent_type: 'deep', model: 'haiku' }), r.d)).toBeNull();
  });

  it('an effort ask never carries definition text into the log', async () => {
    setup();
    writeAgent('deep.md', `---\nname: deep\neffort: max\ndescription: PRIVATE-DESC\n---\nSECRET-BODY\n`);

    await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d);

    expect(JSON.stringify(r.logs)).not.toContain('PRIVATE-DESC');
    expect(JSON.stringify(r.logs)).not.toContain('SECRET-BODY');
  });

  it('once the model is covered (the user named it), the effort ask is the verdict', async () => {
    setup();
    writeAgent('deep.md', def('max', 'opus'));
    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', intent: { models: ['opus'] } });

    const o = out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecisionReason).toContain('effort');
  });

  it('a model elevation from the definition keeps its choice flow; the effort ask follows once it is approved', async () => {
    setup();
    writeAgent('deep.md', def('max', 'opus'));

    const first = out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d));

    expect(first.permissionDecision).toBe('deny');
    expect(first.permissionDecisionReason).toContain('[jev-elevate:opus]');
  });
});

describe('relative effort values ("lower" | "higher": one step from the agent\'s normal effort)', () => {
  const withSession = (level: string | null, toolInput: Record<string, unknown>): HookInput => ({ ...call(toolInput), ...(level ? { effort: { level } } : {}) } as HookInput);
  const def = (effort: string | null) => `---\nname: deep\n${effort === null ? '' : `effort: ${effort}\n`}---\nbody\n`;

  it('"higher" asks when the session effort is high (one step is xhigh), with the interim wording', async () => {
    setup();

    const o = out(await onPreToolUse(withSession('high', { description: 'd', effort: 'higher' }), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecisionReason).toContain('higher');
    expect(o.permissionDecisionReason).toContain('xhigh');
    expect(o.permissionDecisionReason).toContain('interim');
    expect(r.logs[0]).toMatchObject({ effort_ask: true });
  });

  it.each(['xhigh', 'max'])('"higher" asks when the session effort is already %s', async (level) => {
    setup();

    expect(out(await onPreToolUse(withSession(level, { description: 'd', effort: 'higher' }), r.d)).permissionDecision).toBe('ask');
  });

  it.each(['low', 'medium'])('"higher" passes when the session effort is %s (one step stays below xhigh)', async (level) => {
    setup();

    expect(await onPreToolUse(withSession(level, { description: 'd', effort: 'higher' }), r.d)).toBeNull();
  });

  it('"lower" always passes, whatever the session effort', async () => {
    setup();
    for (const level of ['low', 'high', 'xhigh', 'max']) expect(await onPreToolUse(withSession(level, { description: 'd', effort: 'lower' }), r.d)).toBeNull();
  });

  it('with no session effort available, "higher" is not guessed: it passes', async () => {
    setup();

    expect(await onPreToolUse(withSession(null, { description: 'd', effort: 'higher' }), r.d)).toBeNull();
    expect(await onPreToolUse(withSession('ludicrous', { description: 'd', effort: 'higher' }), r.d)).toBeNull();
  });

  it('the base is the definition\'s effort when it sets one: high asks, medium passes, whatever the session says', async () => {
    setup();
    writeAgent('deep.md', def('high'));
    expect(out(await onPreToolUse(withSession('low', { description: 'd', subagent_type: 'deep', effort: 'higher' }), r.d)).permissionDecision).toBe('ask');

    writeAgent('deep.md', def('medium'));
    expect(await onPreToolUse(withSession('max', { description: 'd', subagent_type: 'deep', effort: 'higher' }), r.d)).toBeNull();
  });

  it('a definition effort that is not a known level makes the base unknown: not guessed, passes', async () => {
    setup();
    writeAgent('deep.md', def('ludicrous'));

    expect(await onPreToolUse(withSession('high', { description: 'd', subagent_type: 'deep', effort: 'higher' }), r.d)).toBeNull();
  });
});
