/**
 * 2.3.19: an unknown Claude Code session model fails CLOSED. When no model is known (a brand-new or headless session before
 * its transcript is written, no SessionStart record) the session is held as `sonnet`, and as `high` effort when its effort is
 * not reported either, so an opus subagent (or an xhigh / max effort) takes the normal approval flow: choice denies with the
 * prescribed question, clamp runs it on sonnet, dialog asks, approvals work as usual. Agent/Task and Workflow agent() literals
 * alike. The rows say `session_model_source: "assumed"` and `sessionModelAssumed: true`; the real model is used the moment it
 * is known (nothing is sticky); no downgrade is offered against an assumed model; on-demand and off decide nothing, as ever.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPreToolUse, telemetryEvent, type HookInput } from '../claude/hook.ts';
import { out, rig, wf, type Rig } from './workflow-helpers.ts';

let r: Rig;
afterEach(() => r?.cleanup());

const NOTE = 'The session model is not known yet, so Jev assumes sonnet.';
const unknownRig = (overrides: Parameters<typeof rig>[0] = {}): Rig => (r = rig({ readSessionModel: () => null, ...overrides }));
const setEnv = (env: Record<string, string>) => void ((r.d as any).env = env);

const call = (toolInput: Record<string, unknown>, extra: Partial<HookInput> = {}): HookInput => ({
  session_id: 's1',
  prompt_id: 'p1',
  tool_name: 'Agent',
  cwd: r.project,
  tool_input: toolInput as any,
  // the session effort is not reported either unless a test gives one
  ...extra
});
const row = () => r.logs.at(-1) as Record<string, any>;
const OPUS = { description: 'WS1: refactor the parser', prompt: 'Refactor it.', subagent_type: 'code-engineer', model: 'opus' };

describe('an unknown session model: choice (default)', () => {
  it('an opus call is denied with the prescribed question, the assumed-model sentence, and the row says assumed', async () => {
    unknownRig();

    const o = out(await onPreToolUse(call(OPUS), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(o.permissionDecisionReason).toContain("'No, proceed on sonnet'");
    expect(o.permissionDecisionReason.endsWith(NOTE)).toBe(true);
    expect(o.permissionDecisionReason.split(NOTE)).toHaveLength(2); // exactly once
    expect(row()).toMatchObject({ decision: 'deny', elevation: 'denied', sessionModel: 'sonnet', session_model_source: 'assumed', sessionModelAssumed: true });
  });

  it('the telemetry row carries the flag and the source', async () => {
    unknownRig();
    await onPreToolUse(call(OPUS), r.d);

    expect(telemetryEvent(row())).toMatchObject({ decision: 'deny', sessionModel: 'sonnet', sessionModelSource: 'assumed', sessionModelAssumed: true });
  });

  it('the Task tool name is held too', async () => {
    unknownRig();

    expect(out(await onPreToolUse(call(OPUS, { tool_name: 'Task' }), r.d)).permissionDecision).toBe('deny');
  });

  it('an approval works as usual: a "Yes, for this session" for opus lets the retry through, and the row is still marked assumed', async () => {
    unknownRig();
    r.approvals.states.set('s1', { approvals: [{ model: 'opus', scope: 'session', created_at: 0 }] } as any);

    expect(await onPreToolUse(call(OPUS), r.d)).toBeNull();

    expect(row()).toMatchObject({ decision: 'pass', elevation: 'approved', approval_scope: 'session', session_model_source: 'assumed', sessionModelAssumed: true });
  });

  it('a call that names no model, "inherit", sonnet and haiku all pass, with no deny and no sentence', async () => {
    unknownRig();

    for (const model of [undefined, 'inherit', 'sonnet', 'haiku']) {
      const input: Record<string, unknown> = { description: 'd', prompt: 'p', subagent_type: 'Explore', ...(model ? { model } : {}) };
      expect(await onPreToolUse(call(input), r.d)).toBeNull();
      expect(row()).toMatchObject({ decision: 'pass', session_model_source: 'assumed', sessionModelAssumed: true });
    }
  });

  it('an unknown session model and an unknown effort: sonnet at xhigh is held for its effort (the assumed session is sonnet at high)', async () => {
    unknownRig();

    const o = out(await onPreToolUse(call({ description: 'd', prompt: 'p', model: 'sonnet', effort: 'xhigh' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:xhigh');
    expect(o.permissionDecisionReason).toContain('costs 6 vs the session\'s 4.5 (sonnet at xhigh vs sonnet at high)');
    expect(o.permissionDecisionReason.endsWith(NOTE)).toBe(true);
    expect(row()).toMatchObject({ cost_gate: 'denied', effort_decision: 'denied', sessionModelAssumed: true, effort_session: 'high' });
  });

  it('an unknown session model and an unknown effort: sonnet at high passes, an effort the hook does report is used', async () => {
    unknownRig();

    expect(await onPreToolUse(call({ description: 'd', prompt: 'p', model: 'sonnet', effort: 'high' }), r.d)).toBeNull();
    // the session effort IS reported (medium): sonnet at high costs 4.5 vs 3, so it is held
    expect(out(await onPreToolUse(call({ description: 'd', prompt: 'p', model: 'sonnet', effort: 'high' }, { effort: 'medium' as any }), r.d)).permissionDecision).toBe('deny');
  });

  it('an agent definition with model opus (not written on the call) is held too', async () => {
    unknownRig();
    fs.mkdirSync(path.join(r.project, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(r.project, '.claude', 'agents', 'deep.md'), '---\nname: deep\nmodel: opus\n---\nbody\n');

    const o = out(await onPreToolUse(call({ description: 'd', prompt: 'p', subagent_type: 'deep' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
  });
});

describe('an unknown session model: clamp and dialog', () => {
  it('clamp: the opus call runs on sonnet (allow + updatedInput), never asks', async () => {
    unknownRig();
    setEnv({ JEV_ELEVATION: 'clamp' });

    const o = out(await onPreToolUse(call(OPUS), r.d));

    expect(o.permissionDecision).toBe('allow');
    expect(o.updatedInput).toMatchObject({ model: 'sonnet' });
    expect(row()).toMatchObject({ decision: 'allow', elevation: 'clamped', clamped_from: 'opus', clamped_to: 'sonnet', sessionModelAssumed: true });
  });

  it('dialog: the opus call asks, and the text says the model is assumed', async () => {
    unknownRig();
    setEnv({ JEV_ELEVATION: 'dialog' });

    const o = out(await onPreToolUse(call(OPUS), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecisionReason).toContain('stronger than the session model "sonnet"');
    expect(o.permissionDecisionReason.endsWith(NOTE)).toBe(true);
    expect(row()).toMatchObject({ decision: 'ask', elevation: 'asked', sessionModelAssumed: true });
  });

  it('dialog: an xhigh effort on sonnet asks as well', async () => {
    unknownRig();
    setEnv({ JEV_ELEVATION: 'dialog' });

    const o = out(await onPreToolUse(call({ description: 'd', prompt: 'p', model: 'sonnet', effort: 'max' }), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecisionReason.endsWith(NOTE)).toBe(true);
  });
});

describe('an unknown session model: on-demand and off decide nothing', () => {
  it('on-demand passes an opus call with no decision (a pass row, no assumption)', async () => {
    unknownRig();
    r.mode.value = 'on-demand';

    expect(await onPreToolUse(call(OPUS), r.d)).toBeNull();

    expect(row()).toMatchObject({ decision: 'pass' });
    expect(row()).not.toHaveProperty('elevation');
    expect(row()).not.toHaveProperty('sessionModelAssumed');
  });

  it('off writes nothing and decides nothing', async () => {
    unknownRig();
    r.mode.value = 'off';

    expect(await onPreToolUse(call(OPUS), r.d)).toBeNull();

    expect(r.logs).toHaveLength(0);
  });
});

describe('the model becomes known later in the session', () => {
  it('the real model is used from then on: nothing sticks', async () => {
    let known: string | null = null;
    unknownRig({ readSessionModel: () => known });

    expect(out(await onPreToolUse(call(OPUS), r.d)).permissionDecision).toBe('deny');
    expect(row()).toMatchObject({ sessionModel: 'sonnet', session_model_source: 'assumed' });

    known = 'claude-opus-5-5';
    expect(await onPreToolUse(call(OPUS), r.d)).toBeNull();
    expect(row()).toMatchObject({ decision: 'pass', sessionModel: 'claude-opus-5-5', session_model_source: 'stored' });
    expect(row()).not.toHaveProperty('sessionModelAssumed');

    known = 'claude-sonnet-5-5';
    expect(out(await onPreToolUse(call(OPUS), r.d)).permissionDecision).toBe('deny');
    expect(row()).toMatchObject({ sessionModel: 'claude-sonnet-5-5', session_model_source: 'stored' });
    expect(row()).not.toHaveProperty('sessionModelAssumed');
    expect(out(await onPreToolUse(call(OPUS), r.d)).permissionDecisionReason).not.toContain(NOTE);
  });

  it('a known model with an unknown effort is as before (no assumed effort): opus on opus passes', async () => {
    r = rig({}, 'claude-opus-5-5');

    expect(await onPreToolUse(call(OPUS), r.d)).toBeNull();
    expect(row()).not.toHaveProperty('sessionModelAssumed');
  });
});

describe('no downgrade is offered against an assumed model', () => {
  it('the rating is never asked for', async () => {
    let rated = 0;
    unknownRig({ rateTask: async () => (rated++, null), downgrades: {} as any });

    await onPreToolUse(call({ description: 'd', prompt: 'p', subagent_type: 'Explore', model: 'sonnet' }), r.d);

    expect(rated).toBe(0);
    expect(row()).not.toHaveProperty('downgrade');
  });
});

describe('Workflow agent() literals', () => {
  const OPUS_SCRIPT = `export const meta = { name: 'x', description: 'y' }\nconst a = await agent('p', { model: 'opus' })\nreturn a`;

  it('a literal opus is denied with the marker, the sentence, and an assumed row (choice)', async () => {
    unknownRig();

    const o = out(await onPreToolUse(wf({ script: OPUS_SCRIPT }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(o.permissionDecisionReason.endsWith(NOTE)).toBe(true);
    expect(row()).toMatchObject({ workflow_guard: 'denied', sessionModel: 'sonnet', session_model_source: 'assumed', sessionModelAssumed: true });
  });

  it('clamp mode takes the choice flow for a script (it cannot be clamped)', async () => {
    unknownRig();
    setEnv({ JEV_ELEVATION: 'clamp' });

    expect(out(await onPreToolUse(wf({ script: OPUS_SCRIPT }, r), r.d)).permissionDecision).toBe('deny');
  });

  it('dialog asks', async () => {
    unknownRig();
    setEnv({ JEV_ELEVATION: 'dialog' });

    const o = out(await onPreToolUse(wf({ script: OPUS_SCRIPT }, r), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.permissionDecisionReason.endsWith(NOTE)).toBe(true);
  });

  it('a literal xhigh effort on sonnet is held for its effort', async () => {
    unknownRig();
    const script = `await agent('p', { model: 'sonnet', effort: 'xhigh' })`;

    const o = out(await onPreToolUse(wf({ script }, r), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:xhigh');
  });

  it('a script with no model above sonnet passes', async () => {
    unknownRig();

    expect(await onPreToolUse(wf({ script: `await agent('p', { model: 'haiku' })\nawait agent('q', { model: 'sonnet' })` }, r), r.d)).toBeNull();
  });

  it('on-demand and off leave the script alone', async () => {
    unknownRig();
    r.mode.value = 'on-demand';
    expect(await onPreToolUse(wf({ script: OPUS_SCRIPT }, r), r.d)).toBeNull();
    r.mode.value = 'off';
    expect(await onPreToolUse(wf({ script: OPUS_SCRIPT }, r), r.d)).toBeNull();
  });
});

describe('through the hook process (no SessionStart, no transcript)', () => {
  const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
  let home = '';
  let proj = '';

  const setMode = (mode: string): void => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode } }));
  const run = (input: object, extraEnv: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      JEV_CONFIG_FILE: path.join(home, 'config.json'),
      JEV_OPENROUTER_API_KEY: '',
      JEV_MODEL_REFRESH: 'off',
      JEV_DOWNGRADE: 'off',
      ...extraEnv
    };
    for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'JEV_ELEVATION']) {
      if (!(v in extraEnv)) delete env[v];
    }
    const p = Bun.spawnSync(['bun', HOOK, 'pre-tool-use'], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string>, cwd: proj });
    return { code: p.exitCode, stdout: p.stdout.toString() };
  };
  const agentIn = (toolInput: object, extra: object = {}) => ({ session_id: 'sess-un', prompt_id: 'p1', cwd: proj, tool_name: 'Agent', tool_input: toolInput, ...extra });
  const hookOut = (x: { stdout: string }) => (x.stdout ? JSON.parse(x.stdout).hookSpecificOutput : null);
  const rows = () => fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const telemetry = () =>
    fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const setup = (): void => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-assumed-')));
    proj = path.join(home, 'proj');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    setMode('on');
  };
  const teardown = (): void => fs.rmSync(home, { recursive: true, force: true });

  it('choice: opus is denied with the question and the sentence; the decisions and telemetry rows say assumed', () => {
    setup();
    try {
      const o = hookOut(run(agentIn(OPUS)));

      expect(o.permissionDecision).toBe('deny');
      expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
      expect(o.permissionDecisionReason.endsWith(NOTE)).toBe(true);
      expect(rows().at(-1)).toMatchObject({ decision: 'deny', sessionModel: 'sonnet', session_model_source: 'assumed', sessionModelAssumed: true });
      expect(telemetry().at(-1)).toMatchObject({ decision: 'deny', sessionModel: 'sonnet', sessionModelSource: 'assumed', sessionModelAssumed: true });
    } finally {
      teardown();
    }
  });

  it('clamp runs it on sonnet, dialog asks', () => {
    setup();
    try {
      const c = hookOut(run(agentIn(OPUS), { JEV_ELEVATION: 'clamp' }));
      expect(c.permissionDecision).toBe('allow');
      expect(c.updatedInput).toMatchObject({ model: 'sonnet' });
      expect(hookOut(run(agentIn(OPUS), { JEV_ELEVATION: 'dialog' })).permissionDecision).toBe('ask');
    } finally {
      teardown();
    }
  });

  it('sonnet and haiku pass; on-demand passes opus; off writes nothing', () => {
    setup();
    try {
      expect(run(agentIn({ description: 'd', prompt: 'p', model: 'sonnet' })).stdout).toBe('');
      expect(run(agentIn({ description: 'd', prompt: 'p', model: 'haiku' })).stdout).toBe('');
      setMode('on-demand');
      expect(run(agentIn(OPUS)).stdout).toBe('');
      expect(rows().at(-1)).toMatchObject({ decision: 'pass' });
      const before = rows().length;
      setMode('off');
      expect(run(agentIn(OPUS)).stdout).toBe('');
      expect(rows()).toHaveLength(before);
    } finally {
      teardown();
    }
  });

  it('once a model is stored (SessionStart), the real model is used', () => {
    setup();
    try {
      expect(hookOut(run(agentIn(OPUS))).permissionDecision).toBe('deny');
      Bun.spawnSync(['bun', HOOK, 'session-start'], {
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'sess-un', model: 'claude-opus-5-5' })),
        env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_OPENROUTER_API_KEY: '', JEV_MODEL_REFRESH: 'off' } as Record<string, string>,
        cwd: proj
      });
      expect(run(agentIn(OPUS)).stdout).toBe('');
      expect(rows().at(-1)).toMatchObject({ decision: 'pass', sessionModel: 'claude-opus-5-5' });
      expect(rows().at(-1)).not.toHaveProperty('sessionModelAssumed');
    } finally {
      teardown();
    }
  });

  it('a Workflow with a literal opus is denied', () => {
    setup();
    try {
      const o = hookOut(run({ session_id: 'sess-un', prompt_id: 'p1', cwd: proj, tool_name: 'Workflow', tool_input: { script: `await agent('p', { model: 'opus' })` } }));

      expect(o.permissionDecision).toBe('deny');
      expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
      expect(o.permissionDecisionReason.endsWith(NOTE)).toBe(true);
    } finally {
      teardown();
    }
  });
});
