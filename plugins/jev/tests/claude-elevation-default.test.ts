/**
 * Jev 2.3.4 behaviour, now JEV_ELEVATION=dialog (the default became "choice"; see claude-elevation-choice.test.ts): an Agent call that names a model stronger than the session
 * model, with no instruction naming it, asks (a permission dialog) on EVERY such call, as in 2.3.3. The
 * opt-in clamp (JEV_ELEVATION=clamp) is covered in claude-elevation.test.ts. Every test here runs with JEV_ELEVATION=dialog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onUserPromptSubmit, onPreToolUse, type HookDeps, type HookInput } from '../claude/hook.ts';
import { decideAgentCall, type Dispatch } from '../claude/logic.ts';

const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };
type Log = Record<string, unknown>;

function setup(overrides: Partial<HookDeps> = {}): { d: HookDeps; logs: Log[]; claims: string[] } {
  const logs: Log[] = [];
  const claims: string[] = [];
  const turns = new Map<string, any>();
  const d: HookDeps = {
    readMode: async () => 'on',
    readSessionModel: () => 'claude-sonnet-5',
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => flashRec,
    log: (e) => logs.push(e as Log),
    // A spy: the default must never touch the clamp store.
    claimClamp: (_s, _p, sig) => (claims.push(sig), { first: true }),
    readTurn: (s) => turns.get(s ?? '') ?? null,
    saveTurn: (s, st) => void turns.set(s ?? '', st),
    ...overrides,
    // These tests cover the 2.3.4 dialog behaviour: it is no longer the default, so it is selected explicitly.
    env: 'env' in overrides && overrides.env === undefined ? undefined : { JEV_ELEVATION: 'dialog', ...(overrides.env ?? {}) }
  };
  return { d, logs, claims };
}

const FULL_INPUT = { description: 'WS1: build the skill', prompt: 'Build it.', subagent_type: 'code-engineer', model: 'opus', run_in_background: true };
const call = (tool_input: Record<string, unknown> = FULL_INPUT, extra: Partial<HookInput> = {}): HookInput => ({
  session_id: 's1',
  prompt_id: 'p1',
  tool_name: 'Agent',
  tool_input,
  ...extra
});
const out = (o: Awaited<ReturnType<typeof onPreToolUse>>) => (o?.hookSpecificOutput ?? {}) as Record<string, any>;

describe('default mode: every elevating call asks', () => {
  it('the first call asks, with no allow and no updatedInput', async () => {
    const { d } = setup();

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecision).not.toBe('allow');
    expect(o).not.toHaveProperty('updatedInput');
  });

  it('three calls in one prompt all ask', async () => {
    const { d } = setup();

    const decisions = [out(await onPreToolUse(call(), d)), out(await onPreToolUse(call(), d)), out(await onPreToolUse(call(), d))].map((o) => o.permissionDecision);

    expect(decisions).toEqual(['ask', 'ask', 'ask']);
  });

  it('a new prompt_id asks as well', async () => {
    const { d } = setup();
    await onPreToolUse(call(), d);

    const o = out(await onPreToolUse(call(FULL_INPUT, { prompt_id: 'p2' }), d));

    expect(o.permissionDecision).toBe('ask');
  });

  it('asks without a prompt_id too, and for the Task tool name', async () => {
    const { d } = setup();

    const a = out(await onPreToolUse({ session_id: 's1', tool_name: 'Agent', tool_input: FULL_INPUT }, d));
    const b = out(await onPreToolUse(call(FULL_INPUT, { tool_name: 'Task' }), d));

    expect([a.permissionDecision, b.permissionDecision]).toEqual(['ask', 'ask']);
  });

  it('says what each answer does, with the "continue on <session model>" example, and no earlier-run clause', async () => {
    const { d } = setup();

    const reason = String(out(await onPreToolUse(call(), d)).permissionDecisionReason);

    expect(reason).toContain('Yes runs it on opus');
    expect(reason).toContain('No cancels the call and stops the turn; type a comment with No to let the assistant continue (for example "continue on sonnet")');
    expect(reason).not.toContain('already ran');
    expect(reason).not.toContain('earlier');
  });

  it('logs elevation "asked" and no clamp fields', async () => {
    const { d, logs } = setup();

    await onPreToolUse(call(), d);

    expect(logs[0]).toMatchObject({ event: 'agent_call', elevation: 'asked', requested_model: 'opus' });
    expect(logs[0]).not.toHaveProperty('clamped_from');
    expect(logs[0]).not.toHaveProperty('clamped_to');
  });

  it('a remapped session alias asks too', async () => {
    const { d } = setup({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'some-other-id' } });

    const o = out(await onPreToolUse(call(), d));

    expect(o.permissionDecision).toBe('ask');
  });

  it('decideAgentCall asks for an elevating call, with the new reason', () => {
    const verdict = decideAgentCall({ model: 'opus' }, 'claude-sonnet-5');

    expect(verdict?.decision).toBe('ask');
    expect(verdict?.reason).toContain('type a comment with No to let the assistant continue');
  });
});

describe('default mode: the clamp store is never used', () => {
  it('never claims a clamp, in any elevating call', async () => {
    const { d, claims } = setup();

    await onPreToolUse(call(), d);
    await onPreToolUse(call(), d);

    expect(claims).toEqual([]);
  });

  it.each([['off'], ['CLAMP'], [''], ['true'], ['1']])('JEV_ELEVATION=%j is not the opt-in', async (value) => {
    const { d, claims } = setup({ env: { JEV_ELEVATION: value } });

    const o = out(await onPreToolUse(call(), d));

    // These values mean "choice" now (not "dialog"); this file has no approvals store, so the call falls back to the dialog.
    // What matters here is that none of them is the clamp.
    expect([o.permissionDecision, claims]).toEqual(['ask', []]);
  });

  describe('with no injected env, the process environment decides', () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.JEV_ELEVATION;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.JEV_ELEVATION;
      else process.env.JEV_ELEVATION = saved;
    });

    it('JEV_ELEVATION=dialog: asks', async () => {
      process.env.JEV_ELEVATION = 'dialog';
      const { d } = setup({ env: undefined });

      const o = out(await onPreToolUse(call(), d));

      expect(o.permissionDecision).toBe('ask');
    });

    it('JEV_ELEVATION=clamp: clamps the first call', async () => {
      process.env.JEV_ELEVATION = 'clamp';
      const { d } = setup({ env: undefined });

      const o = out(await onPreToolUse(call(), d));

      expect([o.permissionDecision, o.updatedInput.model]).toEqual(['allow', 'sonnet']);
    });
  });
});

describe('default mode: explicit instruction and untouched calls', () => {
  it('"use opus" in the prompt passes the call unchanged and logs "instructed"', async () => {
    const { d, logs } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt_id: 'p1', prompt: 'run an opus subagent to wrap findings, then commit' }, d);

    const o = await onPreToolUse(call(), d);

    expect(o).toBeNull();
    expect(logs.at(-1)).toMatchObject({ elevation: 'instructed' });
  });

  it('a stored instruction of another prompt_id does not pass the call: it asks', async () => {
    const { d } = setup();
    await onUserPromptSubmit({ session_id: 's1', prompt_id: 'p1', prompt: 'run an opus subagent to wrap findings, then commit' }, d);

    const o = out(await onPreToolUse(call(FULL_INPUT, { prompt_id: 'p2' }), d));

    expect(o.permissionDecision).toBe('ask');
  });

  it.each([
    ['at the session model', { ...FULL_INPUT, model: 'sonnet' }],
    ['below the session model', { ...FULL_INPUT, model: 'haiku' }],
    ['no model', (({ model: _m, ...rest }) => rest)(FULL_INPUT)],
    ['inherit', { ...FULL_INPUT, model: 'inherit' }]
  ])('a call %s is untouched', async (_name, input) => {
    const { d, logs } = setup();

    const o = await onPreToolUse(call(input as Record<string, unknown>), d);

    expect(o).toBeNull();
    expect(logs.at(-1)).not.toHaveProperty('elevation');
  });

  it('a Workflow and an unknown session model are untouched', async () => {
    const wf = await onPreToolUse(call({ model: 'opus' }, { tool_name: 'Workflow' }), setup().d);
    const unknown = await onPreToolUse(call(), setup({ readSessionModel: () => null }).d);

    expect([wf, unknown]).toEqual([null, null]);
  });
});

describe('the live hook process in default mode', () => {
  const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-elev-default-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (event: string, input: object) => {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_OPENROUTER_API_KEY: '' };
    env.JEV_ELEVATION = 'dialog';
    return Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env });
  };

  it('asks on every call, writes no clamp marker and returns no updatedInput', () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5' });
    const agent = { session_id: 'sx', prompt_id: 'p1', tool_name: 'Agent', tool_input: FULL_INPUT };

    const outs = [run('pre-tool-use', agent), run('pre-tool-use', agent)].map((p) => JSON.parse(p.stdout.toString()).hookSpecificOutput);

    expect(outs.map((o) => o.permissionDecision)).toEqual(['ask', 'ask']);
    expect(outs.every((o) => !('updatedInput' in o))).toBe(true);
    const sessions = path.join(home, '.config', 'jev', 'claude-sessions');
    expect(fs.readdirSync(sessions).filter((n) => n.includes('.clamp-'))).toEqual([]);
  });
});
