/**
 * Jev 2.3.4. An Agent call whose model is stronger than the session model, with no instruction naming it,
 * ASKS by default (a permission dialog on every such call; see the 'default mode' block at the end). The
 * rest of this file is the OPT-IN elevation clamp (env JEV_ELEVATION=clamp):
 *  - first one in a prompt, no instruction naming it: allow + updatedInput on the session model, no dialog
 *  - a second one in the same prompt: ask (that dialog is the request to elevate)
 *  - the user named that model (or a stronger one) in the prompt: passes, logged as "instructed"
 *  - at or below the session model, no model, Workflow, unknown session model: untouched
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onUserPromptSubmit, onPreToolUse, telemetryEvent, type HookDeps, type HookInput } from '../claude/hook.ts';
import { classifyElevation, modelAlias, parseUserIntent, type Dispatch } from '../claude/logic.ts';
import { memoryClaim } from './elevation-helpers.ts';

const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };

type Log = Record<string, unknown>;

/** The clamp is opt-in (JEV_ELEVATION=clamp, read from deps.env): these tests run with it on unless the mode is 'default'. */
function setup(overrides: Partial<HookDeps> = {}, mode: 'clamp' | 'default' = 'clamp'): { d: HookDeps; logs: Log[] } {
  const logs: Log[] = [];
  const turns = new Map<string, any>();
  const d: HookDeps = {
    readMode: async () => 'on',
    readSessionModel: () => 'claude-sonnet-5',
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => flashRec,
    log: (e) => logs.push(e as Log),
    claimClamp: memoryClaim(),
    readTurn: (s) => turns.get(s ?? '') ?? null,
    saveTurn: (s, st) => void turns.set(s ?? '', st),
    ...overrides,
    env: { ...(mode === 'clamp' ? { JEV_ELEVATION: 'clamp' } : {}), ...(overrides.env ?? {}) }
  };
  return { d, logs };
}

const FULL_INPUT = {
  description: 'WS1: build the handoff skill',
  prompt: 'Build the skill. Design is final.',
  subagent_type: 'code-engineer',
  model: 'opus',
  run_in_background: true,
  name: 'ws1',
  isolation: 'worktree'
};

const call = (tool_input: Record<string, unknown> = FULL_INPUT, extra: Partial<HookInput> = {}): HookInput => ({
  session_id: 's1',
  prompt_id: 'p1',
  tool_name: 'Agent',
  tool_input,
  ...extra
});

const out = (o: Awaited<ReturnType<typeof onPreToolUse>>) => (o?.hookSpecificOutput ?? {}) as Record<string, any>;

describe('1. the first elevating call of a prompt is clamped', () => {
  it('allows it with no dialog on the session model', async () => {
    const { d } = setup();

    const o = out(await onPreToolUse(call(), d));

    expect([o.hookEventName, o.permissionDecision, o.updatedInput.model]).toEqual(['PreToolUse', 'allow', 'sonnet']);
  });

  it('never returns permissionDecision "ask" on the first call', async () => {
    const { d } = setup();

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).not.toBe('ask');
  });

  it('updatedInput holds every original field plus the new model and nothing else', async () => {
    const { d } = setup();

    const o = out(await onPreToolUse(call(), d));

    expect(o.updatedInput).toEqual({ ...FULL_INPUT, model: 'sonnet' });
    expect(Object.keys(o.updatedInput).sort()).toEqual(Object.keys(FULL_INPUT).sort());
  });

  it('does not mutate the original tool input', async () => {
    const { d } = setup();
    const input = { ...FULL_INPUT };

    await onPreToolUse(call(input), d);

    expect(input.model).toBe('opus');
  });

  it('maps a full session model id to its alias', async () => {
    const { d } = setup({ readSessionModel: () => 'claude-opus-5-5' });

    const o = out(await onPreToolUse(call({ ...FULL_INPUT, model: 'fable' }), d));

    expect(o.updatedInput.model).toBe('opus');
  });

  it('clamps a request given as a full model id', async () => {
    const { d } = setup();

    const o = out(await onPreToolUse(call({ ...FULL_INPUT, model: 'claude-opus-5-5' }), d));

    expect([o.permissionDecision, o.updatedInput.model]).toEqual(['allow', 'sonnet']);
  });

  // 2.3.4 (review): the note no longer tells the assistant to call again (that made a loop); it reports and asks in chat.
  it('tells the assistant what happened: no re-call, report, ask in chat, a reply naming the model passes', async () => {
    const { d } = setup();

    const ctx = String(out(await onPreToolUse(call(), d)).additionalContext);

    expect(ctx).toContain('Jev ran this delegation on sonnet instead of opus');
    expect(ctx).toContain('Do not call it again on your own');
    expect(ctx).toContain('Report the result');
    expect(ctx).toContain('ask the user in chat; a reply naming opus passes without another prompt');
    expect(ctx).not.toContain('call the agent again');
  });

  it('keeps the context to one short paragraph', async () => {
    const { d } = setup();

    const ctx = String(out(await onPreToolUse(call(), d)).additionalContext);

    expect(ctx.includes('\n')).toBe(false);
    expect(ctx.length).toBeLessThan(600);
  });

  it('also covers the Task tool name', async () => {
    const { d } = setup();

    const o = out(await onPreToolUse(call(FULL_INPUT, { tool_name: 'Task' }), d));

    expect(o.permissionDecision).toBe('allow');
  });
});

describe('2. a second elevating call in the same prompt asks', () => {
  it('returns ask for the second call', async () => {
    const { d } = setup();
    await onPreToolUse(call(), d);

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.updatedInput).toBeUndefined();
  });

  it('says what each answer does, and that the same delegation already ran when it did', async () => {
    const { d } = setup();
    await onPreToolUse(call(), d);

    const reason = String(out(await onPreToolUse(call(), d)).permissionDecisionReason);

    expect(reason).toContain('Yes runs it on opus');
    expect(reason).toContain('No cancels the call and stops the turn; type a comment with No to let the assistant continue');
    expect(reason).toContain('The same delegation already ran on sonnet earlier in this prompt');
  });

  it('does not say a run happened when the repeat is a different delegation', async () => {
    const { d } = setup();
    await onPreToolUse(call(), d);

    const reason = String(out(await onPreToolUse(call({ ...FULL_INPUT, description: 'WS2: something else' }), d)).permissionDecisionReason);

    expect(reason).toContain('Yes runs it on opus');
    expect(reason).not.toContain('already ran');
  });

  it('does not say a run happened when no clamp ran (no prompt key, failing store, absent store)', async () => {
    const noKey = out(await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: FULL_INPUT }, setup().d));
    const broken = out(
      await onPreToolUse(call(), setup({ claimClamp: () => { throw new Error('disk full'); } }).d)
    );
    const absent = out(await onPreToolUse(call(), setup({ claimClamp: undefined }).d));

    for (const o of [noKey, broken, absent]) {
      expect(o.permissionDecision).toBe('ask');
      expect(String(o.permissionDecisionReason)).not.toContain('already ran');
    }
  });

  it('does not say a run happened when a parallel call cannot tell what the first one was', async () => {
    const { d } = setup({ claimClamp: () => ({ first: false }) });

    const reason = String(out(await onPreToolUse(call(), d)).permissionDecisionReason);

    expect(reason).not.toContain('already ran');
  });

  it('keeps asking on a third call', async () => {
    const { d } = setup();
    await onPreToolUse(call(), d);
    await onPreToolUse(call(), d);

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).toBe('ask');
  });

  it('asks for any stronger model after a clamp, not only the same one', async () => {
    const { d } = setup();
    await onPreToolUse(call(), d);

    const o = out(await onPreToolUse(call({ ...FULL_INPUT, model: 'fable' }), d));

    expect(o.permissionDecision).toBe('ask');
  });

  it('a call at the session model in between does not use up or reset the clamp', async () => {
    const { d } = setup();
    await onPreToolUse(call(), d);
    expect(await onPreToolUse(call({ ...FULL_INPUT, model: 'sonnet' }), d)).toBeNull();

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).toBe('ask');
  });

  it('a different prompt_id resets: the first call of the new prompt is clamped again', async () => {
    const { d } = setup();
    await onPreToolUse(call(), d);
    await onPreToolUse(call(), d);

    const o = out(await onPreToolUse(call(FULL_INPUT, { prompt_id: 'p2' }), d));

    expect(o.permissionDecision).toBe('allow');
  });

  it('another session has its own clamp', async () => {
    const { d } = setup();
    await onPreToolUse(call(), d);

    const o = out(await onPreToolUse(call(FULL_INPUT, { session_id: 's2' }), d));

    expect(o.permissionDecision).toBe('allow');
  });

  it('without a prompt_id, the stored turn id scopes the clamp', async () => {
    const { d } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt: 'wrap the findings in the docs and commit' }, d);
    const bare = { session_id: 's1', tool_name: 'Agent', tool_input: FULL_INPUT };

    const first = out(await onPreToolUse(bare, d));
    const second = out(await onPreToolUse(bare, d));

    expect([first.permissionDecision, second.permissionDecision]).toEqual(['allow', 'ask']);
  });

  it('asks when the clamp state cannot be read (no prompt id, no stored turn)', async () => {
    const { d } = setup();

    const o = out(await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: FULL_INPUT }, d));

    expect(o.permissionDecision).toBe('ask');
  });

  it('asks, never clamps, when the claim store is absent or throws', async () => {
    const absent = setup({ claimClamp: undefined });
    const broken = setup({
      claimClamp: () => {
        throw new Error('disk full');
      }
    });

    const a = out(await onPreToolUse(call(), absent.d));
    const b = out(await onPreToolUse(call(), broken.d));

    expect([a.permissionDecision, b.permissionDecision]).toEqual(['ask', 'ask']);
  });
});

describe('2b. a remapped session alias asks instead of clamping', () => {
  it.each([
    ['sonnet', 'claude-sonnet-5', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
    ['haiku', 'claude-haiku-4', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
    ['opus', 'claude-opus-5-5', 'ANTHROPIC_DEFAULT_OPUS_MODEL']
  ])('%s session with %s remapped: the first elevating call asks, never clamps', async (_alias, session, variable) => {
    const requested = session.includes('opus') ? 'fable' : 'opus';
    const { d, logs } = setup({ readSessionModel: () => session, env: { [variable]: 'some-other-model-id' } });

    const o = out(await onPreToolUse(call({ ...FULL_INPUT, model: requested }), d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.updatedInput).toBeUndefined();
    expect(logs.at(-1)).toMatchObject({ elevation: 'asked', clamp_skipped: 'alias-remapped' });
  });

  it('a remap of a different alias does not stop the clamp', async () => {
    const { d } = setup({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'x', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'y' } });

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).toBe('allow');
  });

  it('a remap does not use up the clamp claim', async () => {
    const claims: string[] = [];
    const { d } = setup({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' }, claimClamp: (s, p, sig) => (claims.push(sig), { first: true }) });

    await onPreToolUse(call(), d);

    expect(claims).toEqual([]);
  });

  it('an empty variable is not a remap', async () => {
    const { d } = setup({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: '' } });

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).toBe('allow');
  });
});

describe('2c. a stored instruction belongs to its own prompt (stale intent)', () => {
  it('a host-injected turn with a new prompt_id does not inherit the previous prompt\'s "use opus"', async () => {
    const { d, logs } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt_id: 'p1', prompt: 'run an opus subagent to wrap findings, then commit' }, d);

    const o = out(await onPreToolUse(call(FULL_INPUT, { prompt_id: 'p2' }), d));

    expect(o.permissionDecision).toBe('allow');
    expect(o.updatedInput.model).toBe('sonnet');
    expect(logs.at(-1)).toMatchObject({ elevation: 'clamped', intent_stale: true });
  });

  it('the same prompt_id keeps the instruction', async () => {
    const { d } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt_id: 'p1', prompt: 'run an opus subagent to wrap findings, then commit' }, d);

    const o = await onPreToolUse(call(FULL_INPUT, { prompt_id: 'p1' }), d);

    expect(o).toBeNull();
  });

  it('UserPromptSubmit stores the prompt_id in the turn state', async () => {
    const saved: any[] = [];
    const { d } = setup({ saveTurn: (_s, st) => void saved.push(st) });

    await onUserPromptSubmit({ session_id: 's1', prompt_id: 'p9', prompt: 'wrap the findings in the docs and commit' }, d);

    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((st) => st.promptId === 'p9')).toBe(true);
  });

  it('a state with no promptId (or a call with no prompt_id) keeps the marker-only behaviour', async () => {
    const { d } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt: 'run an opus subagent to wrap findings, then commit' }, d);

    const o = await onPreToolUse(call(FULL_INPUT, { prompt_id: 'p2' }), d);

    expect(o).toBeNull();
  });
});

describe('3. an explicit instruction in the prompt passes through', () => {
  it('"use opus" passes an opus call unchanged: no clamp, no dialog', async () => {
    const { d } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt: 'run an opus subagent to wrap findings, then commit' }, d);

    const o = await onPreToolUse(call(), d);

    expect(o).toBeNull();
  });

  it('passes every call of the prompt, not only the first', async () => {
    const { d } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt: 'use opus for the review agents' }, d);

    const outs = [await onPreToolUse(call(), d), await onPreToolUse(call(), d)];

    expect(outs).toEqual([null, null]);
  });

  it('a stronger named model covers a weaker elevated request', async () => {
    const { d } = setup({ readSessionModel: () => 'claude-haiku-4' });
    await onUserPromptSubmit({ session_id: 's1', prompt: 'use opus for the review agents' }, d);

    const o = await onPreToolUse(call({ ...FULL_INPUT, model: 'sonnet' }), d);

    expect(o).toBeNull();
  });

  it('naming only sonnet does not cover an opus request: it is clamped', async () => {
    const { d } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt: 'use sonnet for the review agents' }, d);

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).toBe('allow');
  });

  it('a negated mention is not an instruction', async () => {
    const { d } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt: "don't use opus, wrap the findings in the docs" }, d);

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).toBe('allow');
  });

  it('logs the instructed call', async () => {
    const { d, logs } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt: 'run an opus subagent to wrap findings, then commit' }, d);

    await onPreToolUse(call(), d);

    expect(logs.at(-1)).toMatchObject({ event: 'agent_call', elevation: 'instructed', requested_model: 'opus' });
    expect(logs.at(-1)).not.toHaveProperty('clamped_from');
  });

  it('the instruction is read by the existing parser', () => {
    expect(parseUserIntent('use opus').models).toEqual(['opus']);
  });
});

describe('4. everything else is untouched', () => {
  it.each([
    ['a model at the session model', { ...FULL_INPUT, model: 'sonnet' }],
    ['a model below the session model (haiku)', { ...FULL_INPUT, model: 'haiku' }],
    ['no model', (({ model: _m, ...rest }) => rest)(FULL_INPUT)],
    ['an inherited model', { ...FULL_INPUT, model: 'inherit' }]
  ])('%s', async (_name, input) => {
    const { d, logs } = setup();

    const o = await onPreToolUse(call(input as Record<string, unknown>), d);

    expect(o).toBeNull();
    expect(logs.at(-1)).not.toHaveProperty('elevation');
  });

  it('a haiku request under a haiku session is untouched', async () => {
    const { d } = setup({ readSessionModel: () => 'claude-haiku-4' });

    const o = await onPreToolUse(call({ ...FULL_INPUT, model: 'haiku' }), d);

    expect(o).toBeNull();
  });

  it('a Workflow call is never gated', async () => {
    const { d } = setup();

    const o = await onPreToolUse(call({ model: 'opus' }, { tool_name: 'Workflow' }), d);

    expect(o).toBeNull();
  });

  it('an unknown session model leaves the call alone', async () => {
    const { d } = setup({ readSessionModel: () => null });

    const o = await onPreToolUse(call(), d);

    expect(o).toBeNull();
  });

  it('an unrecognised session model leaves the call alone', async () => {
    const { d } = setup({ readSessionModel: () => 'some-other-model' });

    const o = await onPreToolUse(call(), d);

    expect(o).toBeNull();
  });

  it('Jev mode off or on-demand does nothing', async () => {
    const { d } = setup({ readMode: async () => 'on-demand' });

    const o = await onPreToolUse(call(), d);

    expect(o).toBeNull();
  });

  it('tools other than Agent, Task and Workflow are ignored', async () => {
    const { d } = setup();

    const o = await onPreToolUse(call(FULL_INPUT, { tool_name: 'Bash' }), d);

    expect(o).toBeNull();
  });
});

describe('5. the decisions-log record', () => {
  it('a clamp logs clamped_from, clamped_to and elevation "clamped", keeping the existing fields', async () => {
    const { d, logs } = setup();

    await onPreToolUse(call(), d);

    expect(logs[0]).toMatchObject({
      hook: 'PreToolUse',
      event: 'agent_call',
      session_id: 's1',
      tool_name: 'Agent',
      subagent_type: 'code-engineer',
      model: 'opus',
      requested_model: 'opus',
      sessionModel: 'claude-sonnet-5',
      elevation: 'clamped',
      clamped_from: 'opus',
      clamped_to: 'sonnet'
    });
    expect(logs[0]).toHaveProperty('preflight_reminder');
  });

  it('a repeat logs elevation "asked" and no clamp fields', async () => {
    const { d, logs } = setup();
    await onPreToolUse(call(), d);

    await onPreToolUse(call(), d);

    expect(logs[1]).toMatchObject({ elevation: 'asked' });
    expect(logs[1]).not.toHaveProperty('clamped_to');
  });

  it('an untouched call has no elevation field', async () => {
    const { d, logs } = setup();

    await onPreToolUse(call({ ...FULL_INPUT, model: 'sonnet' }), d);

    expect(logs[0]).not.toHaveProperty('elevation');
  });

  it('telemetry reports the model the call actually ran on', () => {
    const event = telemetryEvent({ hook: 'PreToolUse', session_id: 's1', requested_model: 'opus', clamped_to: 'sonnet' });

    expect(event.modelUsed).toBe('sonnet');
  });
});

describe('pure helpers', () => {
  it('modelAlias maps ids to aliases', () => {
    expect([modelAlias('claude-sonnet-5'), modelAlias('opus'), modelAlias('inherit'), modelAlias(null)]).toEqual(['sonnet', 'opus', null, null]);
  });

  it('classifyElevation: elevating, instructed, null', () => {
    expect(classifyElevation({ model: 'opus' }, 'claude-sonnet-5')?.kind).toBe('elevating');
    expect(classifyElevation({ model: 'opus' }, 'claude-sonnet-5', { models: ['opus'] })?.kind).toBe('instructed');
    expect(classifyElevation({ model: 'sonnet' }, 'claude-sonnet-5')).toBeNull();
  });
});

describe('the live hook process (private state dir, real claim)', () => {
  const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-elev-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (event: string, input: object) =>
    Bun.spawnSync(['bun', HOOK, event], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      env: { ...process.env, JEV_ELEVATION: 'clamp', HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_OPENROUTER_API_KEY: '' }
    });
  const parse = (p: ReturnType<typeof run>) => (p.stdout.toString() ? JSON.parse(p.stdout.toString()).hookSpecificOutput : null);
  const sessions = () => path.join(home, '.config', 'jev', 'claude-sessions');
  const mode = (p: string) => fs.statSync(p).mode & 0o777;

  it('clamps the first call, asks the second, resets on a new prompt_id, with owner-only state', () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    const agent = (prompt_id: string) => ({ session_id: 'sx', prompt_id, tool_name: 'Agent', tool_input: FULL_INPUT });

    const first = parse(run('pre-tool-use', agent('p1')));
    const second = parse(run('pre-tool-use', agent('p1')));
    const third = parse(run('pre-tool-use', agent('p2')));

    expect([first.permissionDecision, second.permissionDecision, third.permissionDecision]).toEqual(['allow', 'ask', 'allow']);
    expect(first.updatedInput).toEqual({ ...FULL_INPUT, model: 'sonnet' });
    const markers = fs.readdirSync(sessions()).filter((n) => n.includes('.clamp-'));
    expect(markers).toEqual(['sx.clamp-p2']);
    expect([mode(sessions()), mode(path.join(sessions(), markers[0]))]).toEqual([0o700, 0o600]);
  });

  it('logs the clamp to the decisions file', () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });

    run('pre-tool-use', { session_id: 'sx', prompt_id: 'p1', tool_name: 'Agent', tool_input: FULL_INPUT });

    const lines = fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ elevation: 'clamped', clamped_from: 'opus', clamped_to: 'sonnet' });
  });
});
