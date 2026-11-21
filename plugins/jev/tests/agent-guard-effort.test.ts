/**
 * INTERIM narrow effort rule on the Agent/Task path (cognitive-engine RFC 007 says do not build further): a literal
 * `xhigh` or `max` on the call's `effort`, or on the effort of the definition behind its `subagent_type`, or a "higher"
 * that reaches one. Choice and clamp (never an ask: a harness that auto-approves would approve a dialog unseen) deny with
 * the prescribed `[jev-elevate-effort:<level>]` question; a covering approval, or a prompt that names the effort, passes.
 * Dialog mode (`JEV_ELEVATION=dialog`) keeps the permission dialog. Unrecognised levels, non-string values and the
 * "higher than the session" comparison are NOT checked here. `maxEffortLevel: "high"` in Claude Code settings is the
 * non-interim control.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { onPostToolUse, onPreToolUse, type HookDeps, type HookInput } from '../claude/hook.ts';
import { parseUserIntent } from '../claude/logic.ts';
import { out, rig, type Rig } from './workflow-helpers.ts';
import { HAIKU, catalogue as pricedCatalogue, memoryDowngrades } from './downgrade-helpers.ts';

const SAMPLE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'posttooluse-askuserquestion.json'), 'utf8'));
const EFFORT_Q = (level: string) => `[jev-elevate-effort:${level}] Run the deep delegation at ${level} effort (session high): refactor the parser module?`;
const MODEL_Q = (model: string) => `[jev-elevate:${model}] Run the deep delegation on ${model} (session sonnet): refactor the parser module?`;
function answered(question: string, label: string): HookInput {
  const s = structuredClone(SAMPLE);
  for (const part of [s.tool_input, s.tool_response]) {
    part.questions[0].question = question;
    part.answers = { [question]: label };
  }
  return { ...s, session_id: 's1' } as HookInput;
}

let r: Rig;
afterEach(() => r?.cleanup());
const setup = (overrides: Partial<HookDeps> = {}) => (r = rig(overrides));
const dialog = (overrides: Partial<HookDeps> = {}) => setup({ ...overrides, env: { JEV_ELEVATION: 'dialog', ...(overrides.env ?? {}) } });
const writeAgent = (file: string, text: string): void => {
  const f = path.join(r.project, '.claude', 'agents', file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const MAX_ONLY = { description: 'd', effort: 'max' };
const call = (toolInput: Record<string, unknown>, tool = 'Agent'): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: tool, cwd: r.project, tool_input: toolInput as any });

describe('call effort', () => {
  it.each(['xhigh', 'max'])('effort %s on the call is denied (never asked) with the prescribed question, the four options and the interim wording', async (effort) => {
    setup();

    const o = out(await onPreToolUse(call({ description: 'd', effort }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain(`effort "${effort}"`);
    expect(o.permissionDecisionReason).toContain('interim');
    expect(o.permissionDecisionReason).toContain(`STARTS with the marker [jev-elevate-effort:${effort}]`);
    for (const label of ['Yes, once', 'Yes, for the next 5 minutes', 'Yes, for this session', 'No, run at high']) expect(o.permissionDecisionReason).toContain(`'${label}'`);
    expect(r.logs[0]).toMatchObject({ decision: 'deny', elevation: 'denied', effort_level: effort, effort_decision: 'denied', elevation_attempt: 1 });
    expect(r.logs[0]).not.toHaveProperty('effort_ask');
  });

  it('the Task tool name takes the same path', async () => {
    setup();

    expect(out(await onPreToolUse(call({ description: 'd', effort: 'max' }, 'Task'), r.d)).permissionDecision).toBe('deny');
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

  it('is denied every time, never asked; from the third attempt of the same delegation the reason says to stop retrying', async () => {
    setup();

    const reasons: string[] = [];
    for (let i = 0; i < 4; i++) {
      const o = out(await onPreToolUse(call({ description: 'd', effort: 'max' }), r.d));
      expect(o.permissionDecision).toBe('deny');
      reasons.push(o.permissionDecisionReason);
    }

    expect(reasons[1]).not.toContain('stop retrying');
    expect(reasons[2]).toContain(`attempt 3 for the same delegation: stop retrying 'max'`);
    expect(reasons[2]).toContain('explicit effort: "high"');
    expect(r.logs.map((l) => l.elevation_attempt)).toEqual([1, 2, 3, 4]);
  });

  it('a different delegation counts on its own', async () => {
    setup();
    for (let i = 0; i < 3; i++) await onPreToolUse(call({ description: 'one', effort: 'max' }), r.d);

    const o = out(await onPreToolUse(call({ description: 'two', effort: 'max' }), r.d));

    expect(o.permissionDecisionReason).not.toContain('stop retrying');
    expect(r.logs.at(-1)).toMatchObject({ elevation_attempt: 1 });
  });

  it.each(['Yes, for this session', 'Yes, once'])(
    'a model verdict keeps priority: the elevation question first, the effort question follows once it is approved ("%s")',
    async (label) => {
      setup();

      const first = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));

      expect(first.permissionDecision).toBe('deny');
      expect(first.permissionDecisionReason).toContain('[jev-elevate:opus]');
      expect(first.permissionDecisionReason).not.toContain('jev-elevate-effort');

      await onPostToolUse(answered(MODEL_Q('opus'), label), r.d);
      const second = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));
      expect(second.permissionDecision).toBe('deny');
      expect(second.permissionDecisionReason).toContain('[jev-elevate-effort:max]');
      // the deny for the effort did not use up the model answer: the approval is still on record
      expect(r.approvals.states.get('s1')?.approvals).toHaveLength(1);
    }
  );

  it('under the opt-in clamp the effort deny is not hidden by the clamp allow; once approved the clamp applies', async () => {
    setup({ env: { JEV_ELEVATION: 'clamp' } });

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.updatedInput).toBeUndefined();
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:max]');

    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);
    const again = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));
    expect(again.permissionDecision).toBe('allow');
    expect(again.updatedInput).toMatchObject({ model: 'sonnet' });
  });

  it('mode off and an unknown session model do not change what passes: off passes, unknown still denies (effort needs no session model)', async () => {
    setup();
    r.mode.value = 'off';
    expect(await onPreToolUse(call({ description: 'd', effort: 'max' }), r.d)).toBeNull();

    r.mode.value = 'on';
    r.d.readSessionModel = () => null;
    expect(out(await onPreToolUse(call({ description: 'd', effort: 'max' }), r.d)).permissionDecision).toBe('deny');
  });

  it('a Workflow is unchanged: no effort question from the Agent path', async () => {
    setup();

    expect(out(await onPreToolUse(call({ script: "await agent('p')", effort: 'max' }, 'Workflow'), r.d)).permissionDecision).toBeUndefined();
  });

  it('dialog mode keeps the permission dialog: it asks every time, with the interim wording, and logs no effort decision', async () => {
    dialog();

    for (let i = 0; i < 4; i++) {
      const o = out(await onPreToolUse(call({ description: 'd', effort: 'max' }), r.d));
      expect(o.permissionDecision).toBe('ask');
      expect(o.permissionDecisionReason).toContain('interim');
    }
    expect(r.logs[0]).toMatchObject({ decision: 'ask', elevation: 'asked', effort_ask: true });
    expect(r.logs[0]).not.toHaveProperty('effort_decision');
  });

  it('dialog mode: a model elevation on the same call keeps its own dialog; the effort dialog follows on the retry', async () => {
    dialog();

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecisionReason).not.toContain('effort');
  });
});

describe('the effort approval, end to end (deny, answer, retry)', () => {
  const MAX = { description: 'd', effort: 'max' };

  it.each([
    ['Yes, once', 'once'],
    ['Yes, for the next 5 minutes', '5min'],
    ['Yes, for this session', 'session']
  ])('deny, then "%s" is recorded, then the next attempt passes (scope %s)', async (label, scope) => {
    setup();
    expect(out(await onPreToolUse(call(MAX), r.d)).permissionDecision).toBe('deny');

    await onPostToolUse(answered(EFFORT_Q('max'), label), r.d);

    expect(await onPreToolUse(call(MAX), r.d)).toBeNull();
    expect(r.logs.at(-1)).toMatchObject({ decision: 'pass', effort_level: 'max', effort_decision: 'approved', effort_approval_scope: scope });
  });

  it('a once covers exactly one launch; a session covers every one', async () => {
    setup();
    await onPreToolUse(call(MAX), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);

    expect(await onPreToolUse(call(MAX), r.d)).toBeNull();
    expect(out(await onPreToolUse(call(MAX), r.d)).permissionDecision).toBe('deny'); // spent

    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, for this session'), r.d);
    for (let i = 0; i < 3; i++) expect(await onPreToolUse(call(MAX), r.d)).toBeNull();
  });

  it('a 5-minute approval expires', async () => {
    let now = 1_800_000_000_000;
    setup({ now: () => now });
    await onPreToolUse(call(MAX), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, for the next 5 minutes'), r.d);

    now += 4 * 60_000;
    expect(await onPreToolUse(call(MAX), r.d)).toBeNull();
    now += 2 * 60_000;
    expect(out(await onPreToolUse(call(MAX), r.d)).permissionDecision).toBe('deny');
  });

  it('an approval of max covers xhigh, an approval of xhigh does not cover max', async () => {
    setup();
    await onPreToolUse(call({ description: 'd', effort: 'max' }), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, for this session'), r.d);
    expect(await onPreToolUse(call({ description: 'd', effort: 'xhigh' }), r.d)).toBeNull();
    r.cleanup();

    setup();
    await onPreToolUse(call({ description: 'd', effort: 'xhigh' }), r.d);
    await onPostToolUse(answered(EFFORT_Q('xhigh'), 'Yes, for this session'), r.d);
    expect(await onPreToolUse(call({ description: 'd', effort: 'xhigh' }), r.d)).toBeNull();
    expect(out(await onPreToolUse(call({ description: 'd', effort: 'max' }), r.d)).permissionDecision).toBe('deny');
  });

  it('"No, run at high" is not an approval, and the re-invoke at effort high passes (a call effort overrides a definition that says max)', async () => {
    setup();
    writeAgent('deep.md', '---\nname: deep\neffort: max\n---\nbody\n');
    const first = out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d));
    expect(first.permissionDecision).toBe('deny');
    expect(first.permissionDecisionReason).toContain('agent definition "deep"');

    await onPostToolUse(answered(EFFORT_Q('max'), 'No, run at high'), r.d);
    expect(out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d)).permissionDecision).toBe('deny'); // nothing was approved

    expect(await onPreToolUse(call({ description: 'd', subagent_type: 'deep', effort: 'high' }), r.d)).toBeNull();
    expect(r.logs.at(-1)).toMatchObject({ decision: 'pass' });
    expect(r.logs.at(-1)).not.toHaveProperty('effort_decision');
  });

  it('a "higher" that reaches xhigh takes the same flow', async () => {
    setup();
    const withSession = (): HookInput => ({ ...call({ description: 'd', effort: 'higher' }), effort: { level: 'high' } }) as HookInput;
    expect(out(await onPreToolUse(withSession(), r.d)).permissionDecisionReason).toContain('[jev-elevate-effort:xhigh]');

    await onPostToolUse(answered(EFFORT_Q('xhigh'), 'Yes, once'), r.d);
    expect(await onPreToolUse(withSession(), r.d)).toBeNull();
  });

  it('an answer with no recent denial for that level records nothing (the marker is not a secret)', async () => {
    setup();

    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, for this session'), r.d);

    expect(r.approvals.states.get('s1')?.effortApprovals ?? []).toEqual([]);
    expect(out(await onPreToolUse(call(MAX), r.d)).permissionDecision).toBe('deny');
  });

  it('an effort answer never approves a model, and a model answer never approves an effort', async () => {
    setup();
    await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d);
    await onPreToolUse(call(MAX), r.d);

    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, for this session'), r.d);
    expect(r.approvals.states.get('s1')?.approvals ?? []).toEqual([]);
    await onPostToolUse(answered(MODEL_Q('opus'), 'Yes, for this session'), r.d);

    expect(r.approvals.states.get('s1')?.effortApprovals).toHaveLength(1); // only the first answer
    expect(r.approvals.states.get('s1')?.approvals).toHaveLength(1);
  });

  it('the recorder respects the mode: an answer given in on-demand records nothing, and neither does one after a mode change', async () => {
    setup();
    await onPreToolUse(call(MAX), r.d);

    r.mode.value = 'on-demand';
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, for this session'), r.d);
    r.mode.value = 'on';
    expect(r.approvals.states.get('s1')?.effortApprovals ?? []).toEqual([]);
    expect(out(await onPreToolUse(call(MAX), r.d)).permissionDecision).toBe('deny');

    // the denial just recorded predates a mode change stamped after it
    const stamped = new Date(1_800_000_000_000 + 1000).toISOString();
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, for this session'), { ...r.d, readConfig: () => ({ defaults: { modeChangedAt: stamped } }) });
    expect(r.approvals.states.get('s1')?.effortApprovals ?? []).toEqual([]);
  });
});

describe('a prompt that names the effort passes as instructed', () => {
  const MAX = { description: 'd', effort: 'max' };
  const turn = (prompt: string) => r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', intent: parseUserIntent(prompt) });

  it.each(['use max effort for this', 'Run it with max effort', 'set the effort to max', 'go with maximum effort', 'Please launch it at max effort.'])('"%s"', async (prompt) => {
    setup();
    turn(prompt);

    expect(await onPreToolUse(call(MAX), r.d)).toBeNull();
    expect(r.logs[0]).toMatchObject({ decision: 'pass', effort_level: 'max', effort_decision: 'instructed' });
  });

  it('xhigh named covers xhigh only; max named covers both', async () => {
    setup();
    turn('use xhigh effort');
    expect(await onPreToolUse(call({ description: 'd', effort: 'xhigh' }), r.d)).toBeNull();
    expect(out(await onPreToolUse(call(MAX), r.d)).permissionDecision).toBe('deny');

    turn('use max effort');
    expect(await onPreToolUse(call({ description: 'd', effort: 'xhigh' }), r.d)).toBeNull();
  });

  it.each(['do not use max effort', 'what does max effort cost?', 'the agent will use max effort for judges', 'compare with max effort later'])('"%s" is not an instruction', async (prompt) => {
    setup();
    turn(prompt);

    expect(out(await onPreToolUse(call(MAX), r.d)).permissionDecision).toBe('deny');
  });

  it('an instruction from an earlier prompt (another prompt id) is not an instruction now', async () => {
    setup();
    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', promptId: 'earlier', intent: parseUserIntent('use max effort') });

    expect(out(await onPreToolUse(call(MAX), r.d)).permissionDecision).toBe('deny');
  });

  it('the effort instruction does not stand in for a model instruction', async () => {
    setup();
    turn('use max effort');

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus', effort: 'max' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
  });
});

describe('definition effort', () => {
  const def = (effort: string | null, model: string | null = null) => `---\nname: deep\n${model ? `model: ${model}\n` : ''}${effort === null ? '' : `effort: ${effort}\n`}---\nbody\n`;

  it.each(['xhigh', 'max'])('a definition with effort: %s is denied with the question, with or without a model on the call', async (effort) => {
    setup();
    writeAgent('deep.md', def(effort));

    for (const extra of [{}, { model: 'sonnet' }, { model: 'haiku' }]) {
      const o = out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep', ...extra }), r.d));
      expect(o.permissionDecision).toBe('deny');
      expect(o.permissionDecisionReason).toContain('definition');
      expect(o.permissionDecisionReason).toContain(`"${effort}"`);
      expect(o.permissionDecisionReason).toContain(`[jev-elevate-effort:${effort}]`);
    }
  });

  it('dialog mode asks for a definition effort, as before', async () => {
    dialog();
    writeAgent('deep.md', def('max'));

    const o = out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecisionReason).toContain('definition');
  });

  it('effort low, medium, high or none passes; an unrecognised definition effort is not checked', async () => {
    setup();
    for (const e of ['low', 'medium', 'high', null, 'ludicrous']) {
      writeAgent('deep.md', def(e));
      expect(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d)).toBeNull();
    }
  });

  it('a definition named like a built-in type is read like any other, so its effort is denied', async () => {
    setup();
    writeAgent('Explore.md', def('max').replace('name: deep', 'name: Explore'));
    expect(out(await onPreToolUse(call({ description: 'd', subagent_type: 'Explore' }), r.d)).permissionDecision).toBe('deny');

    fs.rmSync(path.join(r.project, '.claude', 'agents', 'Explore.md'));
    expect(await onPreToolUse(call({ description: 'd', subagent_type: 'Explore' }), r.d)).toBeNull(); // no file claims the name
  });

  it('a definition that cannot be found adds nothing; an unreadable one, with a call model of its own, adds nothing', async () => {
    setup();
    expect(await onPreToolUse(call({ description: 'd', subagent_type: 'ghost' }), r.d)).toBeNull();

    writeAgent('deep.md', '---\nname: deep\neffort: [max]\n---\n');
    expect(await onPreToolUse(call({ description: 'd', subagent_type: 'deep', model: 'haiku' }), r.d)).toBeNull();
  });

  it('an effort deny never carries definition text into the log or the reason', async () => {
    setup();
    writeAgent('deep.md', `---\nname: deep\neffort: max\ndescription: PRIVATE-DESC\n---\nSECRET-BODY\n`);

    const o = out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d));

    for (const text of [JSON.stringify(r.logs), o.permissionDecisionReason]) {
      expect(text).not.toContain('PRIVATE-DESC');
      expect(text).not.toContain('SECRET-BODY');
    }
  });

  it('once the model is covered (the user named it), the effort deny is the verdict', async () => {
    setup();
    writeAgent('deep.md', def('max', 'opus'));
    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', intent: { models: ['opus'] } });

    const o = out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('jev-elevate-effort:max');
  });

  it('a model elevation from the definition keeps its choice flow; the effort question follows once it is approved', async () => {
    setup();
    writeAgent('deep.md', def('max', 'opus'));

    const first = out(await onPreToolUse(call({ description: 'd', subagent_type: 'deep' }), r.d));

    expect(first.permissionDecision).toBe('deny');
    expect(first.permissionDecisionReason).toContain('[jev-elevate:opus]');
  });
});

describe('relative effort values ("lower" | "higher": one step from the agent\'s normal effort)', () => {
  const withSession = (level: string | null, toolInput: Record<string, unknown>): HookInput => ({ ...call(toolInput), ...(level ? { effort: { level } } : {}) }) as HookInput;
  const def = (effort: string | null) => `---\nname: deep\n${effort === null ? '' : `effort: ${effort}\n`}---\nbody\n`;

  it('"higher" is denied when the session effort is high (one step is xhigh), with the interim wording', async () => {
    setup();

    const o = out(await onPreToolUse(withSession('high', { description: 'd', effort: 'higher' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('higher');
    expect(o.permissionDecisionReason).toContain('xhigh');
    expect(o.permissionDecisionReason).toContain('interim');
    expect(r.logs[0]).toMatchObject({ effort_level: 'xhigh', effort_decision: 'denied' });
  });

  it('dialog mode asks for it, with effort_ask logged', async () => {
    dialog();

    expect(out(await onPreToolUse(withSession('high', { description: 'd', effort: 'higher' }), r.d)).permissionDecision).toBe('ask');
    expect(r.logs[0]).toMatchObject({ effort_ask: true });
  });

  it.each(['xhigh', 'max'])('"higher" is denied when the session effort is already %s', async (level) => {
    setup();

    expect(out(await onPreToolUse(withSession(level, { description: 'd', effort: 'higher' }), r.d)).permissionDecision).toBe('deny');
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

  it('the base is the definition\'s effort when it sets one: high is denied, medium passes, whatever the session says', async () => {
    setup();
    writeAgent('deep.md', def('high'));
    expect(out(await onPreToolUse(withSession('low', { description: 'd', subagent_type: 'deep', effort: 'higher' }), r.d)).permissionDecision).toBe('deny');

    writeAgent('deep.md', def('medium'));
    expect(await onPreToolUse(withSession('max', { description: 'd', subagent_type: 'deep', effort: 'higher' }), r.d)).toBeNull();
  });

  it('a definition effort that is not a known level makes the base unknown: not guessed, passes', async () => {
    setup();
    writeAgent('deep.md', def('ludicrous'));

    expect(await onPreToolUse(withSession('high', { description: 'd', subagent_type: 'deep', effort: 'higher' }), r.d)).toBeNull();
  });
});

describe('one answer, one run: an approval is consumed only by a call that actually goes ahead', () => {
  const BOTH = { description: 'd', model: 'opus', effort: 'max' };
  const states = () => r.approvals.states.get('s1');
  const denied = async (input: Record<string, unknown>) => out(await onPreToolUse(call(input), r.d));

  it('model once + effort once: the third attempt passes, both approvals are consumed exactly once, and the fourth is denied again', async () => {
    setup();

    expect((await denied(BOTH)).permissionDecisionReason).toContain('[jev-elevate:opus]');
    await onPostToolUse(answered(MODEL_Q('opus'), 'Yes, once'), r.d);

    expect((await denied(BOTH)).permissionDecisionReason).toContain('[jev-elevate-effort:max]'); // the effort gate denies...
    expect(states()?.approvals).toHaveLength(1); // ...and the model answer is still there
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);
    expect(states()?.effortApprovals).toHaveLength(1);

    expect(await onPreToolUse(call(BOTH), r.d)).toBeNull(); // the third attempt runs
    expect(r.logs.at(-1)).toMatchObject({ decision: 'pass', elevation: 'approved', approval_scope: 'once', effort_decision: 'approved', effort_approval_scope: 'once' });
    expect(states()?.approvals ?? []).toEqual([]); // both spent, once each
    expect(states()?.effortApprovals ?? []).toEqual([]);

    // once means once: the next call (a retry, or a parallel call of the same shape) is denied for the model again
    expect((await denied(BOTH)).permissionDecisionReason).toContain('[jev-elevate:opus]');
  });

  it('the effort answer given first is not spent by the model deny either: effort once, then model once, then it runs', async () => {
    setup();
    await onPreToolUse(call(MAX_ONLY), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);

    expect((await denied(BOTH)).permissionDecisionReason).toContain('[jev-elevate:opus]'); // a model deny: the effort answer is untouched
    expect(states()?.effortApprovals).toHaveLength(1);
    await onPostToolUse(answered(MODEL_Q('opus'), 'Yes, once'), r.d);

    expect(await onPreToolUse(call(BOTH), r.d)).toBeNull();
    expect(states()?.approvals ?? []).toEqual([]);
    expect(states()?.effortApprovals ?? []).toEqual([]);
  });

  it('a once effort answer is not used up by a call that is denied for something else (an unreadable definition)', async () => {
    setup();
    await onPreToolUse(call(MAX_ONLY), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);
    writeAgent('deep.md', '---\nname: deep\neffort: [max]\n---\n');

    const o = await denied({ description: 'd', subagent_type: 'deep', effort: 'max' });

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('unreadable or ambiguous');
    expect(states()?.effortApprovals).toHaveLength(1);
    expect(await onPreToolUse(call(MAX_ONLY), r.d)).toBeNull(); // still good for the call that does run
    expect(states()?.effortApprovals ?? []).toEqual([]);
  });

  it('effort once + the downgrade question: the downgrade deny does not use up the effort answer; the retry runs and spends it', async () => {
    // Decided: an accepted effort still gets the downgrade question (the effort question first, the downgrade after it). This
    // pins that, and the invariant that a once is not spent by a call that is denied.
    setup({ downgrades: memoryDowngrades(), rankContext: () => pricedCatalogue(), rateTask: async () => HAIKU });
    const input = { description: 'WS1: refactor the parser', prompt: 'Refactor it.', model: 'sonnet', effort: 'max' };
    await onPreToolUse(call(input), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);

    const asked = await denied(input);
    expect(asked.permissionDecision).toBe('deny');
    expect(asked.permissionDecisionReason).toContain('[jev-downgrade:');
    expect(states()?.effortApprovals).toHaveLength(1);

    const marker = /\[jev-downgrade:[a-z_-]+\]/.exec(asked.permissionDecisionReason)![0];
    await onPostToolUse(answered(`${marker} Run the delegation on haiku instead of sonnet?`, 'No, keep sonnet'), r.d);

    expect(await onPreToolUse(call(input), r.d)).toBeNull();
    expect(r.logs.at(-1)).toMatchObject({ decision: 'pass', effort_decision: 'approved', effort_approval_scope: 'once' });
    expect(states()?.effortApprovals ?? []).toEqual([]);
    expect((await denied(input)).permissionDecisionReason).toContain('[jev-elevate-effort:max]');
  });

  it('a parallel call that spent the once between the peek and the consume wins; this call is denied and consumes nothing', async () => {
    setup();
    await onPreToolUse(call(MAX_ONLY), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);
    const peekEffort = r.approvals.peekEffort!;
    r.approvals.peekEffort = (s, level, nowMs) => {
      const hit = peekEffort(s, level, nowMs);
      r.approvals.consume!(s, { effort: level }, nowMs); // the other call goes ahead first
      return hit;
    };

    const o = await denied(MAX_ONLY);

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:max]');
    expect(r.logs.at(-1)).toMatchObject({ decision: 'deny', effort_decision: 'denied' });
    expect(r.logs.at(-1)).not.toHaveProperty('effort_approval_scope');
    expect(states()?.effortApprovals ?? []).toEqual([]); // spent once, by the other call
  });

  it('a standing session approval is never spent: peek and consume leave it for every call', async () => {
    setup();
    await onPreToolUse(call(BOTH), r.d);
    await onPostToolUse(answered(MODEL_Q('opus'), 'Yes, for this session'), r.d);
    await onPreToolUse(call(BOTH), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, for this session'), r.d);

    for (let i = 0; i < 3; i++) expect(await onPreToolUse(call(BOTH), r.d)).toBeNull();
    expect(states()?.approvals).toHaveLength(1);
    expect(states()?.effortApprovals).toHaveLength(1);
  });
});

describe('Workflow effort follows the Agent rule (instructed passes, otherwise the choice question, approvals as for Agent)', () => {
  const wfCall = (script: string, id = 'toolu_1'): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: 'Workflow', cwd: r.project, tool_use_id: id, tool_input: { script } as any });
  const SCRIPT = `await agent('a', {effort: 'max'})\nawait agent('b', {effort: 'max'})\nawait agent('c', {effort: 'xhigh'})`;
  const states = () => r.approvals.states.get('s1');

  it('is denied with the prescribed effort question naming the number of held agents; never unverifiable, never asked', async () => {
    setup();

    const o = out(await onPreToolUse(wfCall(SCRIPT), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate-effort:max]');
    expect(o.permissionDecisionReason).toContain('2 agents at max, 1 agent at xhigh');
    expect(o.permissionDecisionReason).toContain('covers the whole script');
    for (const label of ['Yes, once', 'Yes, for the next 5 minutes', 'Yes, for this session', 'No, run at high']) expect(o.permissionDecisionReason).toContain(`'${label}'`);
    expect(r.logs[0]).toMatchObject({ decision: 'deny', workflow_guard: 'denied', effort_level: 'max', effort_decision: 'denied', workflow_effort_sites: 3, elevation_attempt: 1 });
  });

  it('a prompt that names the effort passes; xhigh named does not cover max', async () => {
    setup();
    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', intent: parseUserIntent('use max effort') });
    expect(await onPreToolUse(wfCall(SCRIPT), r.d)).toBeNull();
    expect(r.logs[0]).toMatchObject({ decision: 'pass', workflow_guard: 'passed-instructed' });

    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', intent: parseUserIntent('use xhigh effort') });
    expect(out(await onPreToolUse(wfCall(SCRIPT), r.d)).permissionDecision).toBe('deny');
  });

  it('a once answer covers the whole script, once: the run spends it, the next call is denied again', async () => {
    setup();
    await onPreToolUse(wfCall(SCRIPT), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);

    expect(await onPreToolUse(wfCall(SCRIPT), r.d)).toBeNull();
    expect(r.logs.at(-1)).toMatchObject({ decision: 'pass', workflow_guard: 'allow', effort_decision: 'approved', effort_approval_scope: 'once', elevation: 'approved' });
    expect(states()?.effortApprovals ?? []).toEqual([]);
    expect(out(await onPreToolUse(wfCall(SCRIPT, 'toolu_2'), r.d)).permissionDecision).toBe('deny');
  });

  it('model once + effort once on one Workflow: the model question first, then the effort; neither is spent by a deny; the third attempt runs', async () => {
    setup();
    const both = `${SCRIPT}\nawait agent('d', {model: 'opus'})`;
    expect(out(await onPreToolUse(wfCall(both), r.d)).permissionDecisionReason).toContain('[jev-elevate:opus]');
    await onPostToolUse(answered(MODEL_Q('opus'), 'Yes, once'), r.d);

    expect(out(await onPreToolUse(wfCall(both), r.d)).permissionDecisionReason).toContain('[jev-elevate-effort:max]');
    expect(states()?.approvals).toHaveLength(1); // not spent by the effort deny
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);

    expect(await onPreToolUse(wfCall(both), r.d)).toBeNull();
    expect(states()?.approvals ?? []).toEqual([]);
    expect(states()?.effortApprovals ?? []).toEqual([]);
  });

  it('a once spent by a parallel call between the peek and the consume is not spent twice', async () => {
    setup();
    await onPreToolUse(wfCall(SCRIPT), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);
    const peekEffort = r.approvals.peekEffort!;
    r.approvals.peekEffort = (s, level, nowMs) => {
      const hit = peekEffort(s, level, nowMs);
      r.approvals.consume!(s, { effort: level }, nowMs);
      return hit;
    };

    expect(out(await onPreToolUse(wfCall(SCRIPT), r.d)).permissionDecision).toBe('deny');
  });

  it('an effort a script names as xhigh is covered by an approval of max, and a definition effort takes the same route', async () => {
    setup();
    writeAgent('deep.md', '---\nname: deep\neffort: xhigh\n---\nbody\n');
    const o = out(await onPreToolUse(wfCall(`await agent('p', {agentType: 'deep'})`), r.d));
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:xhigh]');

    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, for this session'), r.d); // no denial for max: ignored
    expect(out(await onPreToolUse(wfCall(`await agent('p', {agentType: 'deep'})`), r.d)).permissionDecision).toBe('deny');
    await onPostToolUse(answered(EFFORT_Q('xhigh'), 'Yes, for this session'), r.d);
    expect(await onPreToolUse(wfCall(`await agent('p', {agentType: 'deep'})`), r.d)).toBeNull();
  });

  it('an unrecognised or non-literal effort stays unverifiable and mixed with an effort site is denied as unverifiable (the closing sentence says where effort goes)', async () => {
    setup();

    const o = out(await onPreToolUse(wfCall(`await agent('a', {effort: 'max'})\nawait agent('b', {effort: args.e})`), r.d));

    expect(o.permissionDecisionReason).toContain('Jev cannot verify');
    expect(o.permissionDecisionReason).toContain('put to the user as a question');
    expect(r.logs[0]).toMatchObject({ workflow_guard: 'denied-unverifiable' });
  });

  it('dialog mode asks, as before', async () => {
    dialog();

    expect(out(await onPreToolUse(wfCall(SCRIPT), r.d)).permissionDecision).toBe('ask');
  });
});

describe('a lost approval race never turns into an allow (JEV_DOWNGRADE=auto)', () => {
  const INPUT = { description: 'WS1: refactor the parser', prompt: 'Refactor it.', model: 'sonnet', effort: 'max' };
  const states = () => r.approvals.states.get('s1');
  const autoRig = () => setup({ env: { JEV_DOWNGRADE: 'auto' }, downgrades: memoryDowngrades(), rankContext: () => pricedCatalogue(), rateTask: async () => HAIKU });
  const approveEffortOnce = async () => {
    await onPreToolUse(call(INPUT), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);
  };

  it('control: with the effort approved and nothing racing, auto applies the downgrade (allow + updatedInput) and spends the once', async () => {
    autoRig();
    await approveEffortOnce();

    const o = out(await onPreToolUse(call(INPUT), r.d));

    expect(o.permissionDecision).toBe('allow');
    expect(o.updatedInput).toMatchObject({ model: 'haiku' });
    expect(r.logs.at(-1)).toMatchObject({ decision: 'allow', downgrade: 'applied' });
    expect(states()?.effortApprovals ?? []).toEqual([]);
  });

  it('consume returns null (a parallel call spent the once): the output is a deny with no updatedInput, and the log agrees', async () => {
    autoRig();
    await approveEffortOnce();
    const peekEffort = r.approvals.peekEffort!;
    r.approvals.peekEffort = (s, level, nowMs) => {
      const hit = peekEffort(s, level, nowMs);
      r.approvals.consume!(s, { effort: level }, nowMs); // the other call goes ahead first
      return hit;
    };

    const o = out(await onPreToolUse(call(INPUT), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:max]');
    expect(o.updatedInput).toBeUndefined();
    expect(r.logs.at(-1)).toMatchObject({ decision: 'deny', elevation: 'denied', effort_decision: 'denied', downgrade: 'discarded' });
    expect(r.logs.at(-1)).not.toHaveProperty('approval_scope');
  });

  it('the consume throws under the lock (swallowed by the hook): still a deny, no updatedInput, and the approval is not spent', async () => {
    autoRig();
    await approveEffortOnce();
    r.approvals.consume = () => {
      throw new Error('lock timeout');
    };

    const o = out(await onPreToolUse(call(INPUT), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.updatedInput).toBeUndefined();
    expect(r.logs.at(-1)).toMatchObject({ decision: 'deny', downgrade: 'discarded' });
    expect(states()?.effortApprovals).toHaveLength(1);
  });

  it('a model once whose consume returns null (lost between the peek and the consume) is a deny with the model question and no updatedInput', async () => {
    autoRig();
    const MODEL_INPUT = { description: 'WS1: refactor the parser', prompt: 'Refactor it.', model: 'opus' };
    await onPreToolUse(call(MODEL_INPUT), r.d);
    await onPostToolUse(answered(MODEL_Q('opus'), 'Yes, once'), r.d);
    r.approvals.consume = () => null;

    const o = out(await onPreToolUse(call(MODEL_INPUT), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(o.updatedInput).toBeUndefined();
    expect(r.logs.at(-1)).toMatchObject({ decision: 'deny', elevation: 'denied' });
    expect(r.logs.at(-1)).not.toHaveProperty('approval_scope');
  });
});

describe('a deny that drops a clamp says so (JEV_ELEVATION=clamp)', () => {
  const INPUT = { description: 'WS1: refactor the parser', prompt: 'Refactor it.', model: 'opus', effort: 'max' };
  const clampRig = () => setup({ env: { JEV_ELEVATION: 'clamp' } });
  const states = () => r.approvals.states.get('s1');
  const approveEffortOnce = async () => {
    await onPreToolUse(call(INPUT), r.d);
    await onPostToolUse(answered(EFFORT_Q('max'), 'Yes, once'), r.d);
  };

  it('control: with the effort once approved and nothing racing, the clamp goes ahead (allow + updatedInput) and spends the once', async () => {
    clampRig();
    await approveEffortOnce();

    const o = out(await onPreToolUse(call(INPUT), r.d));

    expect(o.permissionDecision).toBe('allow');
    expect(o.updatedInput).toMatchObject({ model: 'sonnet' });
    expect(r.logs.at(-1)).toMatchObject({ decision: 'allow', elevation: 'clamped', clamped_from: 'opus', clamped_to: 'sonnet' });
    expect(r.logs.at(-1)).not.toHaveProperty('clamp');
    expect(states()?.effortApprovals ?? []).toEqual([]);
  });

  it('clamp + effort once + consume returning null: a deny, no updatedInput, no clamped_from, and the log says the clamp was discarded', async () => {
    clampRig();
    await approveEffortOnce();
    r.approvals.consume = () => null; // the once is gone between the peek and the consume

    const o = out(await onPreToolUse(call(INPUT), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:max]');
    expect(o.updatedInput).toBeUndefined();
    expect(r.logs.at(-1)).toMatchObject({ decision: 'deny', elevation: 'denied', effort_decision: 'denied', clamp: 'discarded', clamp_to: 'sonnet' });
    expect(r.logs.at(-1)).not.toHaveProperty('clamped_from');
  });

  it('the effort question itself is a deny that drops the clamp: logged as discarded, nothing clamped', async () => {
    clampRig();

    const o = out(await onPreToolUse(call(INPUT), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.updatedInput).toBeUndefined();
    expect(r.logs.at(-1)).toMatchObject({ decision: 'deny', clamp: 'discarded', clamp_to: 'sonnet' });
    expect(r.logs.at(-1)).not.toHaveProperty('clamped_from');
  });

  it('a clamp with no deny after it is not logged as discarded', async () => {
    clampRig();

    const o = out(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d));

    expect(o.permissionDecision).toBe('allow');
    expect(r.logs.at(-1)).toMatchObject({ elevation: 'clamped', clamped_from: 'opus' });
    expect(r.logs.at(-1)).not.toHaveProperty('clamp');
  });
});
