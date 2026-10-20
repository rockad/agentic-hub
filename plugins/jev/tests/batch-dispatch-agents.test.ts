import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBatchDispatchTool, findAgent } from '../src/tools/dispatch.ts';

const ENV_KEYS = ['HOME', 'JEV_CACHE_FILE', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR'] as const;

let tmp = '';
let savedCwd = '';
let savedEnv: Record<string, string | undefined> = {};

function writeAgent(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: "${name} agent"\n---\n# ${name}\n`);
}

async function plannedSubagents(tasks: Array<{ id: string; task: string }>): Promise<Record<string, string>> {
  const res = await handleBatchDispatchTool({ tasks });
  const plan = JSON.parse(res.content[0]!.text) as { tasks: Array<{ taskId: string; subagent: string }> };
  return Object.fromEntries(plan.tasks.map((t) => [t.taskId, t.subagent]));
}

describe('jev_batch_dispatch with kebab-case agent names', () => {
  beforeEach(() => {
    savedCwd = process.cwd();
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-batch-agents-')));
    process.env.HOME = path.join(tmp, 'home');
    process.env.JEV_CACHE_FILE = ':memory:';
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_PROJECT_DIR;
    const workspace = path.join(tmp, 'workspace');
    const agentsDir = path.join(workspace, '.agents', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(path.join(workspace, '.git'));
    writeAgent(agentsDir, 'code-engineer');
    writeAgent(agentsDir, 'career-advisor');
    process.chdir(workspace);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('routes a resume task to the career-advisor agent', async () => {
    const subagents = await plannedSubagents([{ id: 'cv', task: 'update my resume for the new role' }]);

    expect(subagents.cv).toBe('career-advisor');
  });

  it('routes a default task to the code-engineer agent instead of self', async () => {
    const subagents = await plannedSubagents([{ id: 'code', task: 'rename the parser module' }]);

    expect(subagents.code).toBe('code-engineer');
  });
});

describe('findAgent', () => {
  it('prefers the snake_case name when both forms are discovered', () => {
    expect(findAgent(['career_advisor', 'career-advisor'], 'career_advisor')).toBe('career_advisor');
  });

  it('returns null when neither form is discovered', () => {
    expect(findAgent(['code-engineer'], 'career_advisor')).toBeNull();
  });
});
