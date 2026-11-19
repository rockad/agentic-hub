import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluatePreToolGuards, findGitCommit, findGitInvocations, resolveGitCommitPlan } from '../antigravity/guards.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';

/**
 * Review findings on the commit gate walker (follow-up to F2 and F4 on #72): where a `cd` really takes effect in the
 * shell. A backgrounded command, a pipeline stage and a conditional run (`false && cd dir`) do not move the commit
 * that follows; `eval cd dir` does. `ws` holds STAGED conflict markers, `clean` is a clean repository: a commit that
 * really runs in `ws` must be denied, one that really runs in `clean` must be allowed.
 */
const CONFLICT = 'one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';

describe('commit gate: which cd moves the commit (shell semantics)', () => {
  let tmpHome = '';
  let jevConfigDir = '';
  let origHome = '';
  let origConfig = '';
  let ws = '';
  let clean = '';

  const initRepo = (dir: string): ((cmd: string) => string) => {
    fs.mkdirSync(dir, { recursive: true });
    const git = (cmd: string): string => {
      const proc = Bun.spawnSync(['sh', '-c', `git ${cmd}`], { cwd: dir });
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
      return proc.stdout.toString();
    };
    git('init');
    git('config user.email "test@example.com"');
    git('config user.name "Test"');
    git('config commit.gpgsign false');
    return git;
  };

  beforeEach(() => {
    clearConfigCacheForTesting();
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gate-shell-')));
    jevConfigDir = path.join(tmpHome, '.config', 'jev');
    fs.mkdirSync(jevConfigDir, { recursive: true });
    origHome = process.env.HOME || '';
    origConfig = process.env.JEV_CONFIG_FILE || '';
    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(jevConfigDir, 'config.json');
    fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on' } }));
    ws = path.join(tmpHome, 'ws');
    clean = path.join(tmpHome, 'clean');
    const gitWs = initRepo(ws);
    fs.writeFileSync(path.join(ws, 'c.txt'), CONFLICT);
    gitWs('add c.txt');
    initRepo(clean);
  });

  afterEach(() => {
    clearConfigCacheForTesting();
    process.env.HOME = origHome;
    if (origConfig) process.env.JEV_CONFIG_FILE = origConfig;
    else delete process.env.JEV_CONFIG_FILE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const decide = async (cwd: string, CommandLine: string) =>
    (await evaluatePreToolGuards({ cwd, toolCall: { name: 'run_command', args: { CommandLine } } })).decision;

  const unresolvedRows = (): Array<Record<string, unknown>> => {
    try {
      return fs
        .readFileSync(path.join(jevConfigDir, 'antigravity_decisions.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.event === 'commit_gate' && r.outcome === 'unresolved_cd');
    } catch {
      return [];
    }
  };

  describe('a backgrounded cd runs in a subshell', () => {
    it('cd dir & git commit commits in the original directory', async () => {
      expect(await decide(ws, `cd ${clean} & git commit -m x`)).toBe('deny');
      expect(await decide(clean, `cd ${ws} & git commit -m x`)).toBe('allow');
      expect(await decide(ws, `cd ${clean} &\ngit commit -m x`)).toBe('deny');
    });

    it('an export or assignment in the background does not reach the commit either', async () => {
      expect(await decide(ws, `export GIT_DIR=${clean}/.git & git commit -m x`)).toBe('deny');
    });

    it('a quoted & or a redirection like 2>&1 is not a background marker', async () => {
      expect(await decide(ws, `cd ${clean} 2>&1 && git commit -m x`)).toBe('allow');
      expect(await decide(ws, `cd ${clean} && git commit -m "a & b"`)).toBe('allow');
    });
  });

  describe('a pipeline stage', () => {
    it('cd in a non-last stage does not move the commit', async () => {
      expect(await decide(ws, `cd ${clean} | true; git commit -m x`)).toBe('deny');
      expect(await decide(ws, `true | cd ${clean} | true; git commit -m x`)).toBe('deny');
    });

    it('cd in the last stage keeps both directories (zsh runs it in the current shell)', async () => {
      expect(await decide(ws, `true | cd ${clean}; git commit -m x`)).toBe('deny');
      expect(await decide(clean, `true | cd ${ws}; git commit -m x`)).toBe('deny');
      expect(resolveGitCommitPlan(`true | cd ${clean}; git commit -m x`, ws).targets.map((t) => t.cwd)).toEqual([clean, ws]);
    });
  });

  describe('a conditional cd', () => {
    it('cd after && that a later ; or newline or || commit does not depend on keeps the directory before it', async () => {
      expect(await decide(ws, `false && cd ${clean}; git commit -m x`)).toBe('deny');
      expect(await decide(ws, `false && cd ${clean}\ngit commit -m x`)).toBe('deny');
      expect(await decide(ws, `false && cd ${clean} || git commit -m x`)).toBe('deny');
      expect(await decide(clean, `false && cd ${ws}; git commit -m x`)).toBe('deny');
    });

    it('cd after || keeps the directory before it even when && follows', async () => {
      expect(await decide(ws, `false || cd ${clean} && git commit -m x`)).toBe('deny');
      expect(await decide(clean, `true || cd ${ws} && git commit -m x`)).toBe('deny');
    });

    it('a commit chained with && after the cd runs only once the cd worked: the moved directory only', async () => {
      expect(await decide(ws, `cd ${clean} && git commit -m x`)).toBe('allow');
      expect(await decide(ws, `true && cd ${clean} && git commit -m x`)).toBe('allow');
      expect(await decide(ws, `git status && cd ${clean} && git add -A && git commit -m x`)).toBe('allow');
      expect(await decide(clean, `true && cd ${ws} && git commit -m x`)).toBe('deny');
    });

    it('is logged as unresolved_cd with the reason conditional, and the plan lists both directories', async () => {
      expect(await decide(ws, `false && cd ${clean}; git commit -m x`)).toBe('deny');
      const rows = unresolvedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].reasons).toContain('conditional');
      expect(resolveGitCommitPlan(`false && cd ${clean}; git commit -m x`, ws).targets.map((t) => t.cwd)).toEqual([clean, ws]);
    });
  });

  describe('eval runs in the current shell, sh -c in a child', () => {
    it('eval cd dir moves the commit that follows', async () => {
      expect(await decide(clean, `eval cd ${ws}; git commit -m x`)).toBe('deny');
      expect(await decide(clean, `eval "cd ${ws}" && git commit -m x`)).toBe('deny');
    });

    it('eval cd into a clean directory is not a false positive', async () => {
      expect(await decide(ws, `eval cd ${clean}; git commit -m x`)).toBe('allow');
    });

    it('a commit inside eval is still checked from the states before it', async () => {
      expect(await decide(ws, `eval 'git commit -m x'`)).toBe('deny');
      expect(await decide(ws, `cd ${clean} && eval 'git commit -m x'`)).toBe('allow');
    });

    it('sh -c, bash -c and piped shells are child processes: their cd does not move the commit', async () => {
      expect(await decide(ws, `sh -c 'cd ${clean}'; git commit -m x`)).toBe('deny');
      expect(await decide(ws, `bash -c "cd ${clean}" && git commit -m x`)).toBe('deny');
      expect(await decide(ws, `echo 'cd ${clean}' | sh; git commit -m x`)).toBe('deny');
    });
  });

  describe('a long pipeline of piped shells stays linear', () => {
    const many = (n: number) => Array(n).fill('echo "git status" | sh').join(' | ') + '; git commit -m x';

    it('1000 echo | sh stages are scanned in well under a second', () => {
      const cmd = many(1000);
      let t = Date.now();
      expect(findGitCommit(cmd)?.subcommand).toBe('commit');
      const findMs = Date.now() - t;
      t = Date.now();
      expect(resolveGitCommitPlan(cmd, tmpHome).targets).toHaveLength(1);
      const planMs = Date.now() - t;
      expect(findMs).toBeLessThan(400);
      expect(planMs).toBeLessThan(400);
    });

    it('an echo text still reaches the first shell after it, also through other stages', () => {
      expect(findGitCommit(`echo 'git commit -m x' | tee out.txt | sh`)?.subcommand).toBe('commit');
      expect(findGitInvocations(`echo 'git commit -m x' | sh | sh`).filter((g) => g.subcommand === 'commit')).toHaveLength(1);
      // The second shell reads the first shell's output, not the echo.
      expect(findGitInvocations(`echo 'git add -A' | sh | echo 'git status' | sh`).map((g) => g.subcommand)).toEqual(['add', 'status']);
    });
  });
});
