/**
 * The real hook process for a Workflow call: a temp HOME, Jev mode on, a seeded session model, the payloads captured by
 * cognitive-engine (tests/fixtures/payloads) adapted to carry a model above the session's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'payloads', 'PreToolUse.workflow-script.json'), 'utf8'));
let home = '';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-wfproc-')));
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
  setMode('on');
  run('session-start', { session_id: 'sess-wf', model: 'claude-sonnet-5-5' });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function setMode(mode: string): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode } }));
}
function run(event: string, input: object) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, 'config.json'), JEV_OPENROUTER_API_KEY: '', JEV_MODEL_REFRESH: 'off' };
  for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'JEV_ELEVATION']) delete env[v];
  const proc = Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string> });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}
const payload = (toolInput: object, toolUseId = 'toolu_01ABC') => ({ ...FIXTURE, session_id: 'sess-wf', cwd: path.join(home, 'proj'), tool_use_id: toolUseId, tool_input: toolInput });
/** The permission decision on stdout, or null: the pre-flight reminder (additionalContext, existing behaviour for a Workflow) may be there without one. */
const decision = (r: { stdout: string }): string | null => (r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision ?? null) : null);
const log = () => fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('PreToolUse Workflow as a process', () => {
  it('the captured script fixture (agent on sonnet) is silent in a sonnet session', () => {
    const r = run('pre-tool-use', payload(FIXTURE.tool_input));

    expect(r.code).toBe(0);
    expect(decision(r)).toBeNull();
    expect(log().at(-1)).toMatchObject({ tool_name: 'Workflow', workflow_guard: 'allow', workflow_models: ['sonnet'] });
  });

  it('the same script with model opus is denied with the [jev-elevate:opus] marker', () => {
    const script = String(FIXTURE.tool_input.script).replace("model: 'sonnet'", "model: 'opus'");
    expect(script).toContain("model: 'opus'");

    const r = run('pre-tool-use', payload({ script }));

    expect(r.code).toBe(0);
    const o = JSON.parse(r.stdout).hookSpecificOutput;
    expect(o).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate:opus]');
    const entry = log().at(-1);
    expect(entry).toMatchObject({ workflow_guard: 'denied', workflow_models: ['opus'], elevation: 'denied', elevation_attempt: 1 });
    expect(JSON.stringify(log())).not.toContain('Single agent replies ok');
    expect(JSON.stringify(log())).not.toContain('Reply with just the word ok');
  });

  it('a script with no model passes silently', () => {
    const r = run('pre-tool-use', payload({ script: "const r = await agent('Reply with just the word ok.')\nreturn r" }));

    expect(r.code).toBe(0);
    expect(decision(r)).toBeNull();
  });

  it('an unparseable script opens the permission dialog (ask), exit 0', () => {
    const r = run('pre-tool-use', payload({ script: "await agent('p', {model: )" }));

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });

  it('mode off passes whatever the script holds and writes no pin', () => {
    setMode('off');

    const r = run('pre-tool-use', payload({ script: "await agent('p', {model: 'opus'})" }));

    expect(r.code).toBe(0);
    expect(r.stdout).toBe(''); // mode off: not even the reminder
    expect(fs.existsSync(path.join(home, '.config', 'jev', 'workflow-pins'))).toBe(false);
  });
});

describe('the drift recorder as a process', () => {
  it('prints nothing for an unchanged file, a systemMessage when it changed, and logs workflow_changed', () => {
    const file = path.join(home, 'proj', 'wf.js');
    fs.writeFileSync(file, "await agent('p')");
    const post = (id: string) => ({ hook_event_name: 'PostToolUse', tool_name: 'Workflow', session_id: 'sess-wf', tool_use_id: id, tool_input: { scriptPath: file }, tool_response: {} });

    expect(decision(run('pre-tool-use', payload({ scriptPath: file }, 'toolu_a')))).toBeNull();
    expect(run('post-tool-use', post('toolu_a'))).toMatchObject({ code: 0, stdout: '' });

    expect(decision(run('pre-tool-use', payload({ scriptPath: file }, 'toolu_b')))).toBeNull();
    fs.writeFileSync(file, "await agent('p', {model: 'opus'})");
    const loud = run('post-tool-use', post('toolu_b'));

    expect(loud.code).toBe(0);
    expect(JSON.parse(loud.stdout).systemMessage).toContain('changed');
    expect(log().filter((l) => l.event === 'workflow_changed')).toHaveLength(1);
    expect(run('post-tool-use', post('toolu_c'))).toMatchObject({ code: 0, stdout: '' }); // no pin
  });

  it('garbage on stdin never fails the host turn', () => {
    const proc = Bun.spawnSync(['bun', HOOK, 'post-tool-use'], { stdin: new TextEncoder().encode('{ not json'), env: { ...process.env, HOME: home } as Record<string, string> });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe('');
  });
});
