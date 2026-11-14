/**
 * A path the Workflow guard is pointed at can be a FIFO. Opening one blocks until a writer appears, which hangs the
 * hook past its timeout and lets the call through unchecked. Every read of a script or definition file must treat
 * anything that is not a regular file as unreadable (the guard asks), never block.
 *
 * Each FIFO case runs in a child process with a timeout, so a regression fails the test instead of hanging the suite.
 * Skipped where mkfifo is unavailable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRegularFile } from '../claude/safe-read.ts';

const ROOT = path.join(import.meta.dir, '..');
const HOOK = path.join(ROOT, 'claude', 'hook.ts');
const GUARD = path.join(ROOT, 'claude', 'workflow-guard.ts');
const DEFS = path.join(ROOT, 'claude', 'agent-definitions.ts');
const SCRIPT_FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'payloads', 'PreToolUse.workflow-script.json'), 'utf8'));

const hasMkfifo = Bun.spawnSync(['sh', '-c', 'command -v mkfifo']).exitCode === 0;
const fifoIt = hasMkfifo ? it : it.skip;

let tmp = '';
let project = '';
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fifo-')));
  project = path.join(tmp, 'proj');
  fs.mkdirSync(project, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function mkfifo(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = Bun.spawnSync(['mkfifo', file]);
  if (r.exitCode !== 0) throw new Error(`mkfifo failed: ${r.stderr.toString()}`);
}

/** Run `body` (async function body that returns JSON) in a child bun with HOME at tmp; the result carries timedOut. */
function child(body: string, timeoutMs = 4000): { timedOut: boolean; value: any; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, HOME: tmp };
  for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR']) delete env[v];
  const code = `import * as g from ${JSON.stringify(GUARD)}; import * as d from ${JSON.stringify(DEFS)};
const out = await (async () => { ${body} })(); console.log(JSON.stringify(out));`;
  const proc = Bun.spawnSync(['bun', '-e', code], { env: env as Record<string, string>, timeout: timeoutMs, killSignal: 'SIGKILL' });
  const timedOut = proc.exitCode === null || proc.signalCode !== undefined && proc.signalCode !== null;
  return { timedOut, value: timedOut ? null : JSON.parse(proc.stdout.toString().trim().split('\n').at(-1) ?? 'null'), stderr: proc.stderr.toString() };
}

describe('readRegularFile', () => {
  it('reads a regular file, refuses a directory and a missing file, and caps the size', () => {
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'hello');
    expect(readRegularFile(f, 100)).toEqual({ kind: 'ok', text: 'hello', size: 5 });
    expect(readRegularFile(f, 4)).toEqual({ kind: 'too-large', size: 5 });
    expect(readRegularFile(tmp, 100).kind).toBe('not-regular');
    expect(readRegularFile(path.join(tmp, 'ghost'), 100).kind).toBe('error');
  });

  it('follows a symlink to a regular file', () => {
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'x');
    fs.symlinkSync(f, path.join(tmp, 'link'));
    expect(readRegularFile(path.join(tmp, 'link'), 10)).toMatchObject({ kind: 'ok', text: 'x' });
  });

  fifoIt('returns not-regular for a FIFO without blocking', () => {
    const f = path.join(tmp, 'fifo');
    mkfifo(f);
    const r = child(`return g.fsResolver(${JSON.stringify(project)}).readScriptFile(${JSON.stringify(f)});`);
    expect(r.timedOut).toBe(false);
    expect(r.value.error).toContain('not a regular file');
  });
});

describe('the Workflow guard never blocks on a FIFO', () => {
  fifoIt('scriptPath naming a FIFO asks (unverifiable), within the timeout', () => {
    const f = path.join(tmp, 'script.fifo');
    mkfifo(f);
    const r = child(`return g.evaluateWorkflowInput({ scriptPath: ${JSON.stringify(f)} }, ${JSON.stringify(project)}, 'claude-sonnet-5-5');`);

    expect(r.timedOut).toBe(false);
    expect(r.value.decision).toBe('ask');
    expect(r.value.reasons.join(' ')).toContain('not a regular file');
  });

  fifoIt('a named workflow whose file is a FIFO asks', () => {
    mkfifo(path.join(project, '.claude', 'workflows', 'pipe.js'));
    const r = child(`return g.evaluateWorkflowInput({ name: 'pipe' }, ${JSON.stringify(project)}, 'claude-sonnet-5-5');`);

    expect(r.timedOut).toBe(false);
    expect(r.value.decision).toBe('ask');
    expect(r.value.reasons.join(' ')).toContain('not a regular file');
  });

  fifoIt('a nested workflow() whose file is a FIFO asks (by name and by scriptPath)', () => {
    mkfifo(path.join(project, '.claude', 'workflows', 'nested.js'));
    mkfifo(path.join(project, 'nested.fifo.js'));
    const r = child(
      `const a = g.evaluateWorkflowInput({ script: "await workflow('nested')" }, ${JSON.stringify(project)}, 'claude-sonnet-5-5');
       const b = g.evaluateWorkflowInput({ script: "await workflow({scriptPath: 'nested.fifo.js'})" }, ${JSON.stringify(project)}, 'claude-sonnet-5-5');
       return { a: [a.decision, a.reasons.join(' ')], b: [b.decision, b.reasons.join(' ')] };`
    );

    expect(r.timedOut).toBe(false);
    expect(r.value.a[0]).toBe('ask');
    expect(r.value.a[1]).toContain('not a regular file');
    expect(r.value.b[0]).toBe('ask');
    expect(r.value.b[1]).toContain('not a regular file');
  });

  fifoIt('an agent definition file that is a FIFO is unreadable (ask), not a hang', () => {
    mkfifo(path.join(project, '.claude', 'agents', 'pipe-agent.md'));
    const r = child(
      `const def = d.readAgentDefinition('pipe-agent', ${JSON.stringify(project)});
       const e = g.evaluateWorkflowInput({ script: "await agent('p', {agentType: 'pipe-agent'})" }, ${JSON.stringify(project)}, 'claude-sonnet-5-5');
       return { def, decision: e.decision };`
    );

    expect(r.timedOut).toBe(false);
    expect(r.value.def.unreadable).toContain('not a regular file');
    expect(r.value.decision).toBe('ask');
  });

  fifoIt('a FIFO among the agent files that is not the requested agent does not block the lookup', () => {
    mkfifo(path.join(project, '.claude', 'agents', 'other.md'));
    fs.writeFileSync(path.join(project, '.claude', 'agents', 'deep.md'), '---\nname: deep\nmodel: opus\n---\n');
    const r = child(`return d.readAgentDefinition('deep', ${JSON.stringify(project)});`);

    expect(r.timedOut).toBe(false);
    expect(r.value).toMatchObject({ found: true, model: 'opus' });
  });

  fifoIt('installed_plugins.json and settings.json as FIFOs are skipped, not blocked on', () => {
    mkfifo(path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'));
    mkfifo(path.join(tmp, '.claude', 'settings.json'));
    const r = child(`return d.readAgentDefinition('ghost', ${JSON.stringify(project)});`);

    expect(r.timedOut).toBe(false);
    expect(r.value.found).toBe(false);
  });
});

describe('the real hook process with a FIFO scriptPath', () => {
  fifoIt('answers ask within about 2 seconds', () => {
    const fifo = path.join(tmp, 'script.fifo');
    mkfifo(fifo);
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
    const env: Record<string, string | undefined> = { ...process.env, HOME: tmp, JEV_CONFIG_FILE: path.join(tmp, 'config.json'), JEV_OPENROUTER_API_KEY: '', JEV_MODEL_REFRESH: 'off' };
    for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL', 'JEV_ELEVATION']) delete env[v];
    const spawn = (event: string, input: object, timeout: number) => {
      const t0 = Date.now();
      const proc = Bun.spawnSync(['bun', HOOK, event], { stdin: new TextEncoder().encode(JSON.stringify(input)), env: env as Record<string, string>, timeout, killSignal: 'SIGKILL' });
      return { code: proc.exitCode, stdout: proc.stdout.toString(), ms: Date.now() - t0 };
    };
    spawn('session-start', { session_id: 'sess-fifo', model: 'claude-sonnet-5-5' }, 5000);

    const r = spawn('pre-tool-use', { ...SCRIPT_FIXTURE, session_id: 'sess-fifo', cwd: project, tool_use_id: 'toolu_fifo', tool_input: { scriptPath: fifo } }, 5000);

    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2500);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });
});
