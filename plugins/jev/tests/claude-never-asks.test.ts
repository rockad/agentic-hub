/**
 * Claude Code never asks outside dialog mode (2.3.18). A harness that auto-approves (`permission_mode` auto or
 * bypassPermissions) approves a hook `ask` without showing it, so in choice and clamp mode every path that used to ask
 * either passes (the user's own instruction) or is denied with guidance. Dialog mode (`JEV_ELEVATION=dialog`) is the
 * only opt-in that may still ask.
 *
 * The five paths: an unranked model, a remapped session alias under clamp, a forced subagent model, an unreadable or
 * ambiguous agent definition, an effort above the interim threshold, and a Workflow the analysis cannot clear.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPreToolUse, type HookDeps, type HookInput } from '../claude/hook.ts';
import { buildCatalogue } from '../src/core/catalogue.ts';
import type { RankContext } from '../claude/logic.ts';
import { out, rig, wf, type Rig } from './workflow-helpers.ts';

const CAT = buildCatalogue(
  'claude-code',
  ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].map((id) => ({ id, ok: true })),
  'probe',
  null,
  new Date('2026-11-12T10:00:00.000Z')
);
const RANK: RankContext = { cat: CAT };

let r: Rig;
afterEach(() => r?.cleanup());

const agentsDir = (): string => path.join(r.project, '.claude', 'agents');
const writeAgent = (file: string, text: string): void => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), file), text);
};
const agent = (toolInput: Record<string, unknown>, permission_mode?: string): HookInput => ({
  session_id: 's1',
  prompt_id: 'p1',
  tool_name: 'Agent',
  cwd: r.project,
  ...(permission_mode ? { permission_mode } : {}),
  tool_input: toolInput as any
});

type Scenario = {
  name: string;
  env: Record<string, string>;
  rank?: boolean;
  files?: Array<[string, string]>;
  input: (permission: string) => HookInput;
};

const OPUS_SCRIPT = `await agent('p', {model: 'opus'})`;
const scenarios: Scenario[] = [
  { name: 'an unranked model', env: {}, rank: true, input: (p) => agent({ description: 'd', model: 'claude-zephyr-1' }, p) },
  { name: 'a remapped session alias', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'some-other-id' }, input: (p) => agent({ description: 'd', model: 'opus' }, p) },
  { name: 'a forced subagent model above the session', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }, input: (p) => agent({ description: 'd', model: 'haiku' }, p) },
  { name: 'an unreadable definition', env: {}, files: [['deep.md', '---\nname: deep\nmodel: [opus]\n---\nbody\n']], input: (p) => agent({ description: 'd', subagent_type: 'deep' }, p) },
  { name: 'an ambiguous definition', env: {}, files: [['deep.md', '---\nname: deep\nmodel: opus\n---\n'], ['other.md', '---\nname: deep\nmodel: haiku\n---\n']], input: (p) => agent({ description: 'd', subagent_type: 'deep' }, p) },
  { name: 'effort max on the call', env: {}, input: (p) => agent({ description: 'd', effort: 'max' }, p) },
  { name: 'effort xhigh on the definition', env: {}, files: [['deep.md', '---\nname: deep\neffort: xhigh\n---\n']], input: (p) => agent({ description: 'd', subagent_type: 'deep' }, p) },
  { name: 'a relative "higher" that reaches xhigh', env: {}, input: (p) => ({ ...agent({ description: 'd', effort: 'higher' }, p), effort: { level: 'high' } }) as HookInput },
  { name: 'an elevating model with an effort above the threshold', env: {}, input: (p) => agent({ description: 'd', model: 'opus', effort: 'max' }, p) },
  { name: 'a Workflow with an unverifiable site', env: {}, input: (p) => ({ ...wf({ script: `await agent('p', {model: args.m})` }, r), permission_mode: p }) },
  { name: 'a Workflow that cannot be parsed', env: {}, input: (p) => ({ ...wf({ script: `await agent('p', {model: )` }, r), permission_mode: p }) },
  { name: 'a Workflow that elevates', env: {}, input: (p) => ({ ...wf({ script: OPUS_SCRIPT }, r), permission_mode: p }) }
];

describe.each(['auto', 'bypassPermissions', 'default'])('permission_mode %s: nothing in choice or clamp ever returns ask', (permission) => {
  for (const mode of ['choice', 'clamp']) {
    for (const s of scenarios) {
      it(`${mode}: ${s.name}`, async () => {
        r = rig({ env: { JEV_ELEVATION: mode, ...s.env }, ...(s.rank ? { rankContext: () => RANK } : {}) });
        for (const [file, text] of s.files ?? []) writeAgent(file, text);

        for (let attempt = 1; attempt <= 4; attempt++) {
          const o = out(await onPreToolUse(s.input(permission), r.d));
          expect(o.permissionDecision).not.toBe('ask');
        }
        expect(r.logs.every((l) => l.decision !== 'ask' && l.elevation !== 'asked')).toBe(true);
        expect(r.logs.some((l) => 'auto_approve_warning' in l)).toBe(false);
      });
    }
  }
});

describe('dialog mode is the only mode that still asks (and it warns under auto-approve)', () => {
  it.each(scenarios.filter((s) => !s.name.startsWith('a forced')))('dialog: %s asks', async (s) => {
    r = rig({ env: { JEV_ELEVATION: 'dialog', ...s.env }, ...(s.rank ? { rankContext: () => RANK } : {}) });
    for (const [file, text] of s.files ?? []) writeAgent(file, text);

    const o = out(await onPreToolUse(s.input('auto'), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(r.logs.at(-1)).toMatchObject({ decision: 'ask', auto_approve_warning: true });
  });
});

describe('the five decided paths, each in choice and clamp', () => {
  const both = ['choice', 'clamp'];

  it.each(both)('1. an unranked model is denied with the rank guidance; %s', async (mode) => {
    r = rig({ env: { JEV_ELEVATION: mode }, rankContext: () => RANK });

    const o = out(await onPreToolUse(agent({ description: 'd', model: 'claude-zephyr-1' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain("Jev cannot rank 'claude-zephyr-1' (not in the catalogue, unknown family); re-invoke with opus, sonnet or haiku, or omit model / inherit");
    expect(await onPreToolUse(agent({ description: 'd', model: 'inherit' }), r.d)).toBeNull();
    expect(await onPreToolUse(agent({ description: 'd', model: 'haiku' }), r.d)).toBeNull();
  });

  it('1. a remapped session alias is denied under clamp, keeping clamp_skipped; choice is untouched by the remap (the choice question)', async () => {
    r = rig({ env: { JEV_ELEVATION: 'clamp', ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' } });
    const o = out(await onPreToolUse(agent({ description: 'd', model: 'opus' }), r.d));
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain("the session alias 'sonnet' is remapped by ANTHROPIC_DEFAULT_SONNET_MODEL, so Jev cannot clamp to it");
    expect(r.logs[0]).toMatchObject({ clamp_skipped: 'alias-remapped', elevation: 'denied' });
    r.cleanup();

    r = rig({ env: { JEV_ELEVATION: 'choice', ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' } });
    expect(out(await onPreToolUse(agent({ description: 'd', model: 'opus' }), r.d)).permissionDecisionReason).toContain('[jev-elevate:opus]');
  });

  it.each(both)('2. a forced model passes as the user\'s own instruction, logged with the forced model; %s', async (mode) => {
    r = rig({ env: { JEV_ELEVATION: mode, CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } });

    expect(await onPreToolUse(agent({ description: 'd', model: 'haiku' }), r.d)).toBeNull();

    expect(r.logs[0]).toMatchObject({ decision: 'pass', elevation: 'instructed', instructed_by: 'env-force', forced_model: 'opus', model_source: 'env-force' });
  });

  it.each(both)('3. an unreadable definition is denied naming the type only, and an explicit call model passes; %s', async (mode) => {
    r = rig({ env: { JEV_ELEVATION: mode } });
    writeAgent('deep.md', '---\nname: deep\nmodel: [opus]\nSECRET-LINE\n---\nSECRET-BODY\n');

    const o = out(await onPreToolUse(agent({ description: 'd', subagent_type: 'deep' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('"deep"');
    expect(o.permissionDecisionReason).toContain('Re-invoke with an explicit model on the call');
    expect(JSON.stringify([o, r.logs])).not.toContain('SECRET');
    for (const model of ['sonnet', 'haiku', 'inherit']) expect(await onPreToolUse(agent({ description: 'd', subagent_type: 'deep', model }), r.d)).toBeNull();
  });

  it.each(both)('4. effort max is denied with the effort question; a prompt naming it passes as instructed; %s', async (mode) => {
    r = rig({ env: { JEV_ELEVATION: mode } });

    const o = out(await onPreToolUse(agent({ description: 'd', effort: 'max' }), r.d));
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:max]');

    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', intent: { models: [], effort: 'max' } });
    expect(await onPreToolUse(agent({ description: 'd', effort: 'max' }), r.d)).toBeNull();
    expect(r.logs.at(-1)).toMatchObject({ effort_decision: 'instructed' });
  });

  it.each(both)('5. a Workflow: unverifiable is denied with what to fix; an elevation takes the choice flow; %s', async (mode) => {
    r = rig({ env: { JEV_ELEVATION: mode } });

    const bad = out(await onPreToolUse(wf({ script: `await agent('p', {model: args.m})` }, r), r.d));
    expect(bad.permissionDecision).toBe('deny');
    expect(bad.permissionDecisionReason).toContain('1 site(s) Jev cannot verify');

    const up = out(await onPreToolUse(wf({ script: OPUS_SCRIPT }, r, {}, 'toolu_2'), r.d));
    expect(up.permissionDecision).toBe('deny');
    expect(up.permissionDecisionReason).toContain('[jev-elevate:opus]');
  });
});

describe('the effort approval on the real hook process and the file store (one process per event)', () => {
  const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
  const SAMPLE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'posttooluse-askuserquestion.json'), 'utf8'));
  let home = '';
  let proj = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-effort-'));
    proj = path.join(home, 'proj');
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (event: string, input: object) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'),
      JEV_OPENROUTER_API_KEY: '',
      OPENROUTER_API_KEY: '',
      JEV_MODEL_REFRESH: 'off',
      JEV_DOWNGRADE: 'off',
      JEV_ELEVATION: ''
    };
    for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE']) delete env[v];
    const p = Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string>, cwd: proj });
    return p.stdout.toString() ? JSON.parse(p.stdout.toString()).hookSpecificOutput : null;
  };
  const pre = (toolInput: object) => run('pre-tool-use', { session_id: 'sx', prompt_id: 'p1', cwd: proj, tool_name: 'Agent', permission_mode: 'auto', tool_input: toolInput });
  const answer = (question: string, label: string) => {
    const s = structuredClone(SAMPLE);
    for (const part of [s.tool_input, s.tool_response]) {
      part.questions[0].question = question;
      part.answers = { [question]: label };
    }
    run('post-tool-use', { ...s, session_id: 'sx' });
  };
  const Q = '[jev-elevate-effort:max] Run the delegation at max effort (session high): refactor the parser?';

  it('deny, the answer is recorded, the next attempt passes; a No re-invokes at high, which passes; auto never asks', () => {
    run('session-start', { session_id: 'sx', model: 'claude-sonnet-5-5' });

    const first = pre({ description: 'd', effort: 'max' });
    expect(first).toMatchObject({ permissionDecision: 'deny' });
    expect(first.permissionDecisionReason).toContain('[jev-elevate-effort:max]');

    answer(Q, 'No, run at high');
    expect(pre({ description: 'd', effort: 'max' })).toMatchObject({ permissionDecision: 'deny' }); // a No approves nothing
    expect(pre({ description: 'd', effort: 'high' })?.permissionDecision).toBeUndefined(); // the re-invoke at high passes

    answer(Q, 'Yes, for this session');
    expect(pre({ description: 'd', effort: 'max' })?.permissionDecision).toBeUndefined();

    const state = JSON.parse(fs.readFileSync(path.join(home, '.config', 'jev', 'claude-sessions', 'sx.approvals.json'), 'utf8'));
    expect(state.effortApprovals).toMatchObject([{ level: 'max', scope: 'session' }]);
  });
});
