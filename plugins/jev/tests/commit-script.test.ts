import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const COMMIT_SCRIPT = path.resolve(import.meta.dir, '..', 'scripts', 'commit.ts');
const MESSAGE = 'feat: add note $(touch pwned) done';

// Stands in for OpenRouter: the free model proposes MESSAGE, the judge accepts it.
const FETCH_STUB = `
globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = url.includes('/decisions')
    ? { answers: { valid_commit: { noul: 0.9 } } }
    : { choices: [{ message: { content: ${JSON.stringify(MESSAGE)} } }], model: 'stub' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
`;

function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(['git', ...args], { cwd });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr.toString()}`);
  return res.stdout.toString();
}

describe('scripts/commit.ts with a model-proposed message', () => {
  let tmp = '';
  let repo = '';
  let exitCode = -1;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-commit-'));
    const home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(home);
    fs.mkdirSync(repo);
    const stub = path.join(tmp, 'fetch-stub.ts');
    fs.writeFileSync(stub, FETCH_STUB);

    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'note.txt'), 'hello\n');
    git(repo, 'add', 'note.txt');

    const res = Bun.spawnSync(['bun', '--preload', stub, COMMIT_SCRIPT], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? '', HOME: home, OPENROUTER_API_KEY: 'sk-test-commit' },
      stdout: 'pipe',
      stderr: 'pipe'
    });
    exitCode = res.exitCode;
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('exits successfully', () => {
    expect(exitCode).toBe(0);
  });

  it('does not run shell substitutions from the message', () => {
    expect(fs.existsSync(path.join(repo, 'pwned'))).toBe(false);
  });

  it('commits the message verbatim', () => {
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe(MESSAGE);
  });
});
