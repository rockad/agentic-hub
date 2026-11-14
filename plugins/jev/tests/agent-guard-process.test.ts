/**
 * The real hook process for an Agent call whose model is not written on the call: a temp HOME (so ~/.claude/agents
 * and the plugin lists are the test's own), Jev mode on, a seeded sonnet session, a project with an agent definition.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
let home = '';
let proj = '';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-agproc-')));
  proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  run('session-start', { session_id: 'sess-ag', model: 'claude-sonnet-5-5' });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(event: string, input: object, extraEnv: Record<string, string> = {}) {
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
  const proc = Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string>, cwd: proj });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}
const agentCall = (toolInput: object) => ({ session_id: 'sess-ag', prompt_id: 'p1', cwd: proj, tool_name: 'Agent', tool_input: toolInput });
const writeAgent = (text: string) => {
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'deep.md'), text);
};
const hookOut = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null);
const log = () => fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('PreToolUse Agent as a process: the model the call will run on', () => {
  it('a definition with model: opus and no model on the call is denied with the marker', () => {
    writeAgent('---\nname: deep\nmodel: opus\n---\nPRIVATE-BODY\n');

    const r = run('pre-tool-use', agentCall({ description: 'd', prompt: 'p', subagent_type: 'deep' }));

    expect(r.code).toBe(0);
    const o = hookOut(r);
    expect(o).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate:opus]');
    expect(log().at(-1)).toMatchObject({ tool_name: 'Agent', model_source: 'definition', elevation: 'denied' });
    expect(JSON.stringify(log())).not.toContain('PRIVATE-BODY');
  });

  it('CLAUDE_CODE_SUBAGENT_MODEL=opus is denied; FORCE replaces an explicit haiku', () => {
    const plain = run('pre-tool-use', agentCall({ description: 'd' }), { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' });
    expect(hookOut(plain)).toMatchObject({ permissionDecision: 'deny' });

    const forced = run('pre-tool-use', agentCall({ description: 'd', model: 'haiku' }), { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    expect(hookOut(forced)).toMatchObject({ permissionDecision: 'deny' });
    expect(log().map((l) => l.model_source)).toEqual(['env', 'env-force']);
  });

  it('an unreadable definition asks, and a call with no definition at all prints nothing', () => {
    writeAgent('---\nname: deep\nmodel: [opus]\n---\n');
    expect(hookOut(run('pre-tool-use', agentCall({ description: 'd', subagent_type: 'deep' })))).toMatchObject({ permissionDecision: 'ask' });

    expect(run('pre-tool-use', agentCall({ description: 'd', subagent_type: 'ghost' })).stdout).toBe('');
  });

  it('mode off prints nothing', () => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode: 'off' } }));
    writeAgent('---\nname: deep\nmodel: opus\n---\n');

    expect(run('pre-tool-use', agentCall({ description: 'd', subagent_type: 'deep' })).stdout).toBe('');
  });
});
