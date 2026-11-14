/**
 * The Agent/Task PreToolUse guard resolves the model a call will actually run on, not just the `model` it names:
 * the definition's `model:`, the subagent-model environment variables (CLAUDE_CODE_SUBAGENT_MODEL and _FORCE) and a
 * `jev-ladder-<id>` pin. The same environment resolution is shared with the Workflow guard (agent-definitions.ts).
 * CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL applies to Workflow agents only.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { onPostToolUse, onPreToolUse, type HookDeps, type HookInput } from '../claude/hook.ts';
import { subagentModelCandidates } from '../claude/agent-definitions.ts';
import { out, rig, type Rig } from './workflow-helpers.ts';

const SAMPLE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'posttooluse-askuserquestion.json'), 'utf8'));
const MARKED = (model: string) => `[jev-elevate:${model}] Run the deep delegation on ${model} (session sonnet): refactor the parser module?`;
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

const agents = (): string => path.join(r.project, '.claude', 'agents');
const writeAgent = (file: string, text: string): string => {
  const f = path.join(agents(), file);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};
const def = (model: string | null, name = 'deep', extra = ''): string => `---\nname: ${name}\n${model === null ? '' : `model: ${model}\n`}${extra}---\nSECRET-BODY do the thing\n`;
const call = (toolInput: Record<string, unknown>, tool = 'Agent'): HookInput => ({ session_id: 's1', prompt_id: 'p1', tool_name: tool, cwd: r.project, tool_input: toolInput as any });
const DELEGATION = { description: 'WS1: refactor', prompt: 'Refactor it.', subagent_type: 'deep' };

describe('the model comes from the definition', () => {
  it('a definition with model: opus and no model on the call is denied in a sonnet session, naming the source', async () => {
    setup();
    writeAgent('deep.md', def('opus'));

    const o = out(await onPreToolUse(call(DELEGATION), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(o.permissionDecisionReason).toContain('definition');
    expect(o.permissionDecisionReason).toContain('deep');
    expect(r.logs[0]).toMatchObject({ model_source: 'definition', elevation: 'denied', elevation_attempt: 1 });
  });

  it('the Task tool name takes the same path', async () => {
    setup();
    writeAgent('deep.md', def('opus'));

    expect(out(await onPreToolUse(call(DELEGATION, 'Task'), r.d)).permissionDecision).toBe('deny');
  });

  it('the call model beats the definition: a sonnet call passes over a definition opus, an opus call over a haiku definition is denied', async () => {
    setup();
    writeAgent('deep.md', def('opus'));
    expect(await onPreToolUse(call({ ...DELEGATION, model: 'sonnet' }), r.d)).toBeNull();
    expect(r.logs[0]).toMatchObject({ model_source: 'call' });

    writeAgent('deep.md', def('haiku'));
    const o = out(await onPreToolUse(call({ ...DELEGATION, model: 'opus' }), r.d));
    expect(o.permissionDecision).toBe('deny');
    expect(r.logs[1]).toMatchObject({ model_source: 'call' });
  });

  it('a definition at or below the session model, with inherit, or with no model passes', async () => {
    setup();
    for (const m of ['haiku', 'sonnet', 'inherit', null]) {
      writeAgent('deep.md', def(m));
      expect(await onPreToolUse(call(DELEGATION), r.d)).toBeNull();
    }
  });

  it('a plugin-qualified type is looked up in that plugin', async () => {
    setup();
    const plugin = path.join(r.tmp, 'plug');
    fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'agents', 'deep.md'), def('opus'));
    fs.mkdirSync(path.join(r.tmp, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(r.tmp, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'plug@m': [{ installPath: plugin }] } }));

    const o = out(await onPreToolUse(call({ ...DELEGATION, subagent_type: 'plug:deep' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(r.logs[0]).toMatchObject({ model_source: 'definition' });
  });

  it('a user or project definition named like a built-in type overrides it and keeps its own model', async () => {
    setup();
    for (const t of ['Explore', 'Plan', 'general-purpose', 'statusline-setup', 'claude-code-guide', 'claude']) {
      writeAgent(`${t}.md`, def('opus', t));
      const o = out(await onPreToolUse(call({ ...DELEGATION, subagent_type: t }), r.d));
      expect(o.permissionDecision).toBe('deny');
      expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    }
    expect(r.logs.every((l) => l.model_source === 'definition')).toBe(true);
  });

  it('a built-in name with a definition at or below the session model, or with no file at all, passes', async () => {
    setup();
    for (const t of ['Explore', 'general-purpose']) {
      expect(await onPreToolUse(call({ ...DELEGATION, subagent_type: t }), r.d)).toBeNull(); // no file: built-in, inherits
      for (const m of ['sonnet', 'haiku']) {
        writeAgent(`${t}.md`, def(m, t));
        expect(await onPreToolUse(call({ ...DELEGATION, subagent_type: t }), r.d)).toBeNull();
      }
    }
  });

  it('an unreadable definition named like a built-in asks, like any other type', async () => {
    setup();
    writeAgent('Explore.md', def('[opus]', 'Explore'));

    expect(out(await onPreToolUse(call({ ...DELEGATION, subagent_type: 'Explore' }), r.d)).permissionDecision).toBe('ask');
  });

  it('a definition that cannot be found passes, as before', async () => {
    setup();

    expect(await onPreToolUse(call({ ...DELEGATION, subagent_type: 'ghost' }), r.d)).toBeNull();
    expect(r.logs[0]).toMatchObject({ model_source: 'inherit' });
  });

  it('an unreadable definition opens the permission dialog with the reason, every time, never a deny', async () => {
    setup();
    writeAgent('deep.md', def('[opus]'));

    for (let i = 0; i < 4; i++) {
      const o = out(await onPreToolUse(call(DELEGATION), r.d));
      expect(o.permissionDecision).toBe('ask');
      expect(o.permissionDecisionReason).toContain('deep.md');
      expect(o.permissionDecisionReason).toContain('"deep"');
    }
    expect(r.logs[0]).toMatchObject({ elevation: 'asked', model_source: 'definition' });
  });

  it('an ambiguous definition (two files claim the name) asks', async () => {
    setup();
    writeAgent('deep.md', def('opus'));
    writeAgent('other.md', def('haiku'));

    expect(out(await onPreToolUse(call(DELEGATION), r.d)).permissionDecision).toBe('ask');
  });

  it('an unreadable definition does not ask when the call names its own model', async () => {
    setup();
    writeAgent('deep.md', def('[opus]'));

    expect(await onPreToolUse(call({ ...DELEGATION, model: 'haiku' }), r.d)).toBeNull();
  });

  it('never logs a word of the definition', async () => {
    setup();
    writeAgent('deep.md', def('opus', 'deep', 'description: PRIVATE-DESC\n'));
    writeAgent('bad.md', '---\nname: bad\nmodel: [opus]\nnonsense line without colon\n---\nSECRET-BODY\n');
    await onPreToolUse(call(DELEGATION), r.d);
    await onPreToolUse(call({ ...DELEGATION, subagent_type: 'bad' }), r.d);

    const text = JSON.stringify(r.logs);
    expect(text).not.toContain('SECRET-BODY');
    expect(text).not.toContain('PRIVATE-DESC');
    expect(text).not.toContain('nonsense line');
  });
});

describe('the model comes from the environment', () => {
  it('CLAUDE_CODE_SUBAGENT_MODEL=opus with no model on the call is denied', async () => {
    setup({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });

    const o = out(await onPreToolUse(call({ description: 'd', prompt: 'p' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('CLAUDE_CODE_SUBAGENT_MODEL');
    expect(r.logs[0]).toMatchObject({ model_source: 'env' });
  });

  it('CLAUDE_CODE_SUBAGENT_MODEL is only a default: the call model and the definition model beat it', async () => {
    setup({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });
    expect(await onPreToolUse(call({ description: 'd', model: 'haiku' }), r.d)).toBeNull();

    writeAgent('deep.md', def('haiku'));
    expect(await onPreToolUse(call(DELEGATION), r.d)).toBeNull();
    expect(r.logs[1]).toMatchObject({ model_source: 'definition' });
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE'])('FORCE=%s replaces an explicit haiku on the call with CLAUDE_CODE_SUBAGENT_MODEL', async (flag) => {
    setup({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: flag } });

    const o = out(await onPreToolUse(call({ description: 'd', model: 'haiku' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE');
    expect(r.logs[0]).toMatchObject({ model_source: 'env-force' });
  });

  it('FORCE also replaces inherit and a definition model, and never reads the definition', async () => {
    setup({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'true' } });
    writeAgent('deep.md', def('[haiku]'));

    expect(out(await onPreToolUse(call({ ...DELEGATION, model: 'inherit' }), r.d)).permissionDecision).toBe('deny');
    expect(out(await onPreToolUse(call(DELEGATION), r.d)).permissionDecision).toBe('deny');
  });

  it('FORCE with a forced model at or below the session model passes an explicit opus call', async () => {
    setup({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } });

    expect(await onPreToolUse(call({ description: 'd', model: 'opus' }), r.d)).toBeNull();
  });

  it('FORCE with no CLAUDE_CODE_SUBAGENT_MODEL runs on the session model and passes', async () => {
    setup({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } });

    expect(await onPreToolUse(call({ description: 'd', model: 'inherit' }), r.d)).toBeNull();
  });

  it('CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL does not apply to the Agent tool', async () => {
    setup({ env: { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'opus' } });

    expect(await onPreToolUse(call({ description: 'd' }), r.d)).toBeNull();
  });

  it('the opt-in clamp cannot override a forced model, so it asks', async () => {
    setup({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', JEV_ELEVATION: 'clamp' }, claimClamp: () => ({ first: true }) });

    const o = out(await onPreToolUse(call({ description: 'd', model: 'haiku' }), r.d));

    expect(o.permissionDecision).toBe('ask');
    expect(o.updatedInput).toBeUndefined();
  });

  it('the shared candidate function is the one the Workflow guard uses', () => {
    const env = { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' };
    expect(subagentModelCandidates({ call: 'haiku' }, env)).toEqual([{ model: 'haiku', source: 'call' }]);
    expect(subagentModelCandidates({ definition: 'haiku' }, env)).toEqual([{ model: 'haiku', source: 'definition' }]);
    expect(subagentModelCandidates({ ladder: 'sonnet' }, env)).toEqual([{ model: 'sonnet', source: 'ladder' }]);
    expect(subagentModelCandidates({}, env)).toEqual([{ model: 'opus', source: 'env' }]);
    expect(subagentModelCandidates({}, { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'fable' })).toEqual([{ model: null, source: 'session' }]);
    expect(subagentModelCandidates({}, { CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'fable' }, { workflow: true })).toEqual([{ model: 'fable', source: 'workflow-env' }]);
  });
});

describe('the ladder pin and the choice flow stay as they were', () => {
  it('a jev-ladder-opus type with no definition is denied (source: ladder)', async () => {
    setup();

    const o = out(await onPreToolUse(call({ description: 'd', subagent_type: 'jev-ladder-opus' }), r.d));

    expect(o.permissionDecision).toBe('deny');
    expect(r.logs[0]).toMatchObject({ model_source: 'ladder' });
  });

  it('a ladder definition file that pins the same model is one finding, and the definition model wins over the name', async () => {
    setup();
    writeAgent('jev-ladder-opus.md', def('sonnet', 'jev-ladder-opus'));

    expect(await onPreToolUse(call({ description: 'd', subagent_type: 'jev-ladder-opus' }), r.d)).toBeNull();
  });

  it('a covering approval lets the definition-model call through', async () => {
    setup();
    writeAgent('deep.md', def('opus'));
    expect(out(await onPreToolUse(call(DELEGATION), r.d)).permissionDecision).toBe('deny');
    await onPostToolUse({ ...answered(MARKED('opus'), 'Yes, for this session'), session_id: 's1' } as any, r.d);

    expect(await onPreToolUse(call(DELEGATION), r.d)).toBeNull();
    expect(r.logs.at(-1)).toMatchObject({ elevation: 'approved', model_source: 'definition' });
  });

  it('the third attempt opens the dialog, as for an explicit model', async () => {
    setup();
    writeAgent('deep.md', def('opus'));

    const decisions = [];
    for (let i = 0; i < 3; i++) decisions.push(out(await onPreToolUse(call(DELEGATION), r.d)).permissionDecision);

    expect(decisions).toEqual(['deny', 'deny', 'ask']);
  });

  it('a user instruction naming the model passes', async () => {
    setup();
    writeAgent('deep.md', def('opus'));
    r.turns.set('s1', { turn: 't1', at: 1, mode: 'on', intent: { models: ['opus'] } });

    expect(await onPreToolUse(call(DELEGATION), r.d)).toBeNull();
    expect(r.logs[0]).toMatchObject({ elevation: 'instructed', model_source: 'definition' });
  });

  it('mode off passes everything, reading nothing', async () => {
    setup({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });
    r.mode.value = 'off';
    writeAgent('deep.md', def('opus'));

    expect(await onPreToolUse(call(DELEGATION), r.d)).toBeNull();
    expect(r.logs).toHaveLength(0);
  });

  it('an unknown session model passes (nothing to compare with)', async () => {
    setup({ readSessionModel: () => null });
    writeAgent('deep.md', def('[opus]'));

    expect(await onPreToolUse(call(DELEGATION), r.d)).toBeNull();
  });

  it('a cwd that is not a directory path never throws; the call model alone decides', async () => {
    setup();
    writeAgent('deep.md', def('opus'));

    const o = await onPreToolUse({ ...call(DELEGATION), cwd: 'relative/path' }, r.d);

    expect(o).toBeNull(); // no definition is found from a relative cwd: pass, as before
  });
});
