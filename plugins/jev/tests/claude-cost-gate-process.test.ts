/**
 * The cost gate (2.3.19) through the real Claude Code hook process: a temp HOME, a seeded session model, the session's effort
 * on the hook input. Choice, clamp, dialog, on-demand, off, a Workflow script, and the decisions log and telemetry row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = path.join(import.meta.dir, '..', 'claude', 'hook.ts');
let home = '';
let proj = '';

function setMode(mode: string): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ defaults: { mode } }));
}
function run(event: string, input: object, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    JEV_CONFIG_FILE: path.join(home, 'config.json'),
    JEV_OPENROUTER_API_KEY: '',
    JEV_MODEL_REFRESH: 'off',
    JEV_DOWNGRADE: 'off',
    JEV_COST_GATE: 'enforce',
    ...extraEnv
  };
  for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'JEV_ELEVATION']) {
    if (!(v in extraEnv)) delete env[v];
  }
  const proc = Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string>, cwd: proj });
  return { code: proc.exitCode, stdout: proc.stdout.toString() };
}
const agent = (toolInput: object, extra: object = {}) => ({ session_id: 'sess-cg', prompt_id: 'p1', cwd: proj, tool_name: 'Agent', tool_input: toolInput, effort: 'high', ...extra });
const hookOut = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null);
const rows = () => fs.readFileSync(path.join(home, '.config', 'jev', 'claude_decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const telemetry = () =>
  fs
    .readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'jev_telemetry.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cgproc-')));
  proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  setMode('on');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('PreToolUse Agent through the hook process: session opus at high', () => {
  beforeEach(() => void run('session-start', { session_id: 'sess-cg', model: 'claude-opus-5-5' }));

  it('choice (default): sonnet at max passes silently; opus at xhigh is denied with the effort question and the cost; opus at high passes', () => {
    expect(run('pre-tool-use', agent({ description: 'd', model: 'sonnet', effort: 'max' })).stdout).toBe('');
    expect(rows().at(-1)).toMatchObject({ decision: 'pass', cost_gate: 'pass', costEstimate: 9, sessionCost: 22.5 });

    const held = run('pre-tool-use', agent({ description: 'd', model: 'opus', effort: 'xhigh' }));
    expect(held.code).toBe(0);
    const o = hookOut(held);
    expect(o).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(o.permissionDecisionReason).toContain("costs 30 vs the session's 22.5 (opus at xhigh vs opus at high)");
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate-effort:xhigh:opus]');
    expect(rows().at(-1)).toMatchObject({ decision: 'deny', cost_gate: 'denied', effort_decision: 'denied', sessionCost: 22.5 });
    // the telemetry row carries the gate and both costs
    expect(telemetry().at(-1)).toMatchObject({ decision: 'deny', cost_gate: 'denied', costEstimate: 30, sessionCost: 22.5, costRatio: 1.333 });

    expect(hookOut(run('pre-tool-use', agent({ description: 'd', model: 'opus' })))?.permissionDecision).toBeUndefined(); // (the third agent call may carry the pre-flight reminder)
  });

  it('the answer to the effort question is read from the transcript of the real hook flow and approves exactly that effort', () => {
    run('pre-tool-use', agent({ description: 'd', model: 'opus', effort: 'xhigh' }));
    const question = '[jev-elevate-effort:xhigh:opus] Run general-purpose at xhigh?';
    run('post-tool-use', {
      session_id: 'sess-cg',
      cwd: proj,
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question }] },
      tool_response: { answers: { [question]: 'Yes, for this session' } }
    });

    expect(run('pre-tool-use', agent({ description: 'd', model: 'opus', effort: 'xhigh' })).stdout).toBe('');
    expect(rows().at(-1)).toMatchObject({ cost_gate: 'approved', effort_decision: 'approved', effort_approval_scope: 'session' });
    expect(hookOut(run('pre-tool-use', agent({ description: 'd', model: 'opus', effort: 'max' })))).toMatchObject({ permissionDecision: 'deny' });
  });

  it('clamp: the effort is lowered on the same model (allow + updatedInput), logged', () => {
    const r = run('pre-tool-use', agent({ description: 'd', prompt: 'p', model: 'opus', effort: 'max' }), { JEV_ELEVATION: 'clamp' });

    const o = hookOut(r);
    expect(o).toMatchObject({ permissionDecision: 'allow', updatedInput: { description: 'd', prompt: 'p', model: 'opus', effort: 'high' } });
    expect(rows().at(-1)).toMatchObject({ decision: 'allow', cost_gate: 'clamped', clamped_to: 'opus', clamped_effort: 'high' });
    expect(telemetry().at(-1)).toMatchObject({ cost_gate: 'clamped' });
  });

  it('dialog asks with the cost (and never for a call within it)', () => {
    const held = hookOut(run('pre-tool-use', agent({ description: 'd', model: 'opus', effort: 'xhigh' }), { JEV_ELEVATION: 'dialog' }));
    expect(held).toMatchObject({ permissionDecision: 'ask' });
    expect(held.permissionDecisionReason).toContain("costs 30 vs the session's 22.5");

    expect(run('pre-tool-use', agent({ description: 'd', model: 'sonnet', effort: 'max' }), { JEV_ELEVATION: 'dialog' }).stdout).toBe('');
  });

  it('on-demand writes the rows with the costs and decides nothing; off writes nothing', () => {
    setMode('on-demand');
    expect(run('pre-tool-use', agent({ description: 'd', model: 'opus', effort: 'max' })).stdout).toBe('');
    expect(rows().at(-1)).toMatchObject({ decision: 'pass', costEstimate: 45, sessionCost: 22.5 });
    expect(rows().at(-1)).not.toHaveProperty('cost_gate');

    setMode('off');
    const before = rows().length;
    expect(run('pre-tool-use', agent({ description: 'd', model: 'opus', effort: 'max' })).stdout).toBe('');
    expect(rows()).toHaveLength(before);
  });

  it('a Workflow script: the same rule per agent() call, with the gate on the row', () => {
    const wf = (script: string) => ({ session_id: 'sess-cg', prompt_id: 'p1', cwd: proj, tool_name: 'Workflow', tool_use_id: 'toolu_cg', effort: 'high', tool_input: { script } });

    expect(hookOut(run('pre-tool-use', wf("await agent('p', { model: 'sonnet', effort: 'max' })")))?.permissionDecision).toBeUndefined();
    expect(rows().at(-1)).toMatchObject({ tool_name: 'Workflow', workflow_guard: 'allow', cost_gate: 'pass' });

    const o = hookOut(run('pre-tool-use', wf("await agent('p', { model: 'opus', effort: 'xhigh' })")));
    expect(o).toMatchObject({ permissionDecision: 'deny' });
    expect(o.permissionDecisionReason).toContain('[jev-elevate-effort:xhigh:opus]');
    expect(rows().at(-1)).toMatchObject({ workflow_guard: 'denied', cost_gate: 'denied' });
    expect(JSON.stringify(rows())).not.toContain("agent('p'");
  });
});

describe('PreToolUse Agent through the hook process: the cost cannot be computed', () => {
  it('a session whose effort the host does not report keeps the model ceiling by rank (fallback)', () => {
    run('session-start', { session_id: 'sess-cg', model: 'claude-sonnet-5-5' });

    const o = hookOut(run('pre-tool-use', agent({ description: 'd', model: 'opus' }, { effort: undefined })));

    expect(o).toMatchObject({ permissionDecision: 'deny' });
    expect(o.permissionDecisionReason).toContain('STARTS with the marker [jev-elevate:opus]');
    expect(rows().at(-1)).toMatchObject({ cost_gate: 'fallback' });
  });
});
