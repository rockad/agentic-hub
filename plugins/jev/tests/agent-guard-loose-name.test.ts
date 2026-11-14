/**
 * Claude Code matches a subagent type loosely when no agent type matches exactly: both names are normalised
 * (`NFKC`, lower case, white space, dashes and underscores removed) and a single match runs. A missing `subagent_type`
 * is `general-purpose`. The Agent guard and the Workflow guard must read the same definition Claude Code would run,
 * through the real hook process (temp HOME, Jev mode on, a sonnet session).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILTIN_AGENT_TYPES, definitionOrBuiltin, normaliseAgentName, readAgentDefinition } from '../claude/agent-definitions.ts';

const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
let home = '';
let proj = '';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-loose-')));
  proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  run('session-start', { session_id: 'sess-l', model: 'claude-sonnet-5-5' });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(event: string, input: object) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_OPENROUTER_API_KEY: '', JEV_MODEL_REFRESH: 'off', JEV_DOWNGRADE: 'off' };
  for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'JEV_ELEVATION']) delete env[v];
  const proc = Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string>, cwd: proj });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}
const agentCall = (toolInput: object) => ({ session_id: 'sess-l', prompt_id: 'p1', cwd: proj, tool_name: 'Agent', tool_input: toolInput });
const writeAgent = (file: string, name: string | null, model: string | null) => {
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'agents', file), `---\n${name ? `name: ${name}\n` : ''}${model ? `model: ${model}\n` : ''}---\nPRIVATE-BODY\n`);
};
const hookOut = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null);
const decisionOf = (r: { stdout: string }) => hookOut(r)?.permissionDecision ?? null;
const log = () => fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const callType = (subagent_type: unknown) => run('pre-tool-use', agentCall({ description: 'd', prompt: 'p', subagent_type }));

describe('normaliseAgentName', () => {
  it("is Claude Code's normalisation: NFKC, lower case, no white space, dashes or underscores", () => {
    expect(normaliseAgentName('Code_Reviewer')).toBe('codereviewer');
    expect(normaliseAgentName('CODE REVIEWER')).toBe('codereviewer');
    expect(normaliseAgentName('General–Purpose')).toBe('generalpurpose'); // en dash
    expect(normaliseAgentName('ｃｏｄｅ-reviewer')).toBe('codereviewer'); // full-width letters, NFKC
    expect(normaliseAgentName(' code reviewer ')).toBe('codereviewer');
  });
});

describe('PreToolUse Agent as a process: a type Claude Code matches loosely', () => {
  for (const type of ['Code_Reviewer', 'CODE REVIEWER', 'code reviewer', 'codereviewer', 'Code-Reviewer', 'code–reviewer']) {
    it(`code-reviewer.md with model: opus denies subagent_type ${JSON.stringify(type)}`, () => {
      writeAgent('code-reviewer.md', 'code-reviewer', 'opus');

      const r = callType(type);

      expect(r.code).toBe(0);
      const o = hookOut(r);
      expect(o).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
      expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
      expect(log().at(-1)).toMatchObject({ model_source: 'definition', elevation: 'denied' });
      expect(JSON.stringify(log())).not.toContain('PRIVATE-BODY');
    });
  }

  it('control: the exact name is denied', () => {
    writeAgent('code-reviewer.md', 'code-reviewer', 'opus');

    expect(hookOut(callType('code-reviewer'))).toMatchObject({ permissionDecision: 'deny' });
  });

  it('"explore" against Explore.md and "General-Purpose" against general-purpose.md, both opus, are denied', () => {
    writeAgent('Explore.md', 'Explore', 'opus');
    writeAgent('general-purpose.md', 'general-purpose', 'opus');

    expect(hookOut(callType('explore'))).toMatchObject({ permissionDecision: 'deny' });
    expect(hookOut(callType('General-Purpose'))).toMatchObject({ permissionDecision: 'deny' });
    expect(hookOut(callType('GENERAL PURPOSE'))).toMatchObject({ permissionDecision: 'deny' });
  });

  it('a file without a name: matches by its file name', () => {
    writeAgent('code-reviewer.md', null, 'opus');

    expect(hookOut(callType('Code_Reviewer'))).toMatchObject({ permissionDecision: 'deny' });
  });

  it('a unique normalised match for a sonnet file passes', () => {
    writeAgent('code-reviewer.md', 'code-reviewer', 'sonnet');

    const r = callType('Code_Reviewer');

    expect(decisionOf(r)).toBeNull();
    expect(log().at(-1)).toMatchObject({ model_source: 'definition' });
  });

  it('two files that normalise to the same name make the lookup ambiguous: the call asks', () => {
    writeAgent('code-reviewer.md', 'code-reviewer', 'sonnet');
    writeAgent('Code_Reviewer.md', 'Code_Reviewer', 'opus');

    const o = hookOut(callType('CODE REVIEWER'));

    expect(o).toMatchObject({ permissionDecision: 'ask' });
    expect(o.permissionDecisionReason).toContain('code-reviewer');
    // the exact names still resolve exactly, as Claude Code does
    expect(hookOut(callType('Code_Reviewer'))).toMatchObject({ permissionDecision: 'deny' });
    expect(decisionOf(callType('code-reviewer'))).toBeNull();
  });

  it('a type no file matches, loosely or not, still passes (agents the hook cannot see exist)', () => {
    writeAgent('code-reviewer.md', 'code-reviewer', 'opus');

    expect(decisionOf(callType('ghost agent'))).toBeNull();
    expect(log().at(-1)).toMatchObject({ model_source: 'inherit' });
  });

  it('a built-in type spelled loosely is a built-in: it passes with no file', () => {
    for (const type of ['general purpose', 'EXPLORE', 'plan', 'Claude_Code_Guide']) expect(decisionOf(callType(type))).toBeNull();
  });

  it('a file whose name normalises like a built-in makes the loose spelling ambiguous: it asks', () => {
    writeAgent('x.md', 'general_purpose', 'opus');

    expect(hookOut(callType('generalpurpose'))).toMatchObject({ permissionDecision: 'ask' });
    // the exact built-in name is still the built-in, as Claude Code resolves it
    expect(decisionOf(callType('general-purpose'))).toBeNull();
  });

  it('the Workflow guard reads the same definition for a loose agentType', () => {
    writeAgent('Explore.md', 'Explore', 'opus');
    fs.writeFileSync(path.join(proj, 'wf.js'), `await agent('p', { agentType: 'explore' })\n`);

    const wf = hookOut(run('pre-tool-use', { session_id: 'sess-l', prompt_id: 'p2', cwd: proj, tool_name: 'Workflow', tool_input: { scriptPath: path.join(proj, 'wf.js') } }));

    expect(wf).toMatchObject({ permissionDecision: 'deny' });
  });
});

describe('PreToolUse Agent as a process: no subagent_type is general-purpose', () => {
  const noType = () => run('pre-tool-use', agentCall({ description: 'd', prompt: 'p' }));

  it('a general-purpose.md with model: opus denies a call with no subagent_type', () => {
    writeAgent('general-purpose.md', 'general-purpose', 'opus');

    const o = hookOut(noType());

    expect(o).toMatchObject({ permissionDecision: 'deny' });
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(log().at(-1)).toMatchObject({ model_source: 'definition', elevation: 'denied' });
  });

  it('so does an empty or blank subagent_type', () => {
    writeAgent('general-purpose.md', 'general-purpose', 'opus');

    for (const t of ['', '  ', null]) expect(hookOut(callType(t))).toMatchObject({ permissionDecision: 'deny' });
  });

  it('no general-purpose file passes', () => {
    expect(decisionOf(noType())).toBeNull();
    expect(log().at(-1)).toMatchObject({ model_source: 'inherit' });
  });

  it('a sonnet general-purpose.md passes', () => {
    writeAgent('general-purpose.md', 'general-purpose', 'sonnet');

    expect(decisionOf(noType())).toBeNull();
    expect(log().at(-1)).toMatchObject({ model_source: 'definition' });
  });
});

describe('readAgentDefinition and definitionOrBuiltin on loose names', () => {
  const prevHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = prevHome;
  });

  it('a unique match is the definition, ambiguity is unreadable, and a built-in spelled loosely resolves', () => {
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    writeAgent('a.md', 'my-helper', 'opus');

    expect(readAgentDefinition('My_Helper', proj)).toEqual({ found: true, model: 'opus' });
    writeAgent('b.md', 'my_helper', 'haiku');
    expect(readAgentDefinition('MY HELPER', proj)).toMatchObject({ found: true, unreadable: expect.stringContaining('my-helper') });
    expect(readAgentDefinition('my-helper', proj)).toEqual({ found: true, model: 'opus' });

    expect(definitionOrBuiltin('EXPLORE', { found: false, model: null })).toEqual({ found: true, model: null });
    expect(definitionOrBuiltin('ghost', { found: false, model: null })).toEqual({ found: false, model: null });
    expect([...BUILTIN_AGENT_TYPES].length).toBe(6);
  });
});
