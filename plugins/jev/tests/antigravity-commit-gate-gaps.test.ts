import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluatePreToolGuards,
  findGitCommit,
  findGitInvocations,
  commitIncludesWorkingTree,
  resolveGitCommitDirs,
  resolveGitCwd
} from '../antigravity/guards.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';

/**
 * Review findings F2 to F5 on #72 (commit gate). Every directory is a real temporary git repository: `ws` is the
 * workspace with STAGED conflict markers, `clean` and `clean2` are clean repositories. A commit that really runs in
 * `ws` must be denied however the command line reaches it.
 */
const CONFLICT = 'one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';

describe('commit gate: directory changes the walker cannot follow exactly, several commits, piped text, --git-dir (F2-F5)', () => {
  let tmpHome = '';
  let jevConfigDir = '';
  let origHome = '';
  let origConfig = '';
  let ws = '';
  let clean = '';
  let clean2 = '';

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
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gate-gaps-')));
    jevConfigDir = path.join(tmpHome, '.config', 'jev');
    fs.mkdirSync(jevConfigDir, { recursive: true });
    origHome = process.env.HOME || '';
    origConfig = process.env.JEV_CONFIG_FILE || '';
    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(jevConfigDir, 'config.json');
    fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on' } }));
    ws = path.join(tmpHome, 'ws');
    clean = path.join(tmpHome, 'clean');
    clean2 = path.join(tmpHome, 'clean2');
    const gitWs = initRepo(ws);
    fs.writeFileSync(path.join(ws, 'c.txt'), CONFLICT);
    gitWs('add c.txt');
    initRepo(clean);
    initRepo(clean2);
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

  const rows = (): Array<Record<string, unknown>> => {
    try {
      return fs
        .readFileSync(path.join(jevConfigDir, 'antigravity_decisions.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  describe('F2: popd, cd - and expansions', () => {
    it('pushd clean && popd returns to the workspace: the commit there is denied', async () => {
      expect(await decide(ws, `pushd ${clean} >/dev/null && popd >/dev/null && git commit -m x`)).toBe('deny');
    });

    it('cd clean; cd - returns to the workspace: the commit there is denied', async () => {
      expect(await decide(ws, `cd ${clean}; cd - && git commit -m x`)).toBe('deny');
      expect(await decide(ws, `cd ${clean} && cd - >/dev/null && git commit -m x`)).toBe('deny');
    });

    it('a real directory stack: two pushd and two popd end where they started', async () => {
      expect(await decide(ws, `pushd ${clean} && pushd ${clean2} && popd && popd && git commit -m x`)).toBe('deny');
      // One popd leaves the first pushd in force: the commit runs in clean.
      expect(await decide(ws, `pushd ${clean} && pushd ${clean2} && popd && git commit -m x`)).toBe('allow');
    });

    it('a variable the line assigns itself is followed: D=dir; cd "$D"', async () => {
      expect(await decide(clean, `D=${ws}; cd "$D" && git commit -m x`)).toBe('deny');
      expect(await decide(clean, `export D=${ws} && cd "\${D}" && git commit -m x`)).toBe('deny');
    });

    it('$PWD in a cd target is followed', async () => {
      expect(await decide(tmpHome, `cd "$PWD/ws" && git commit -m x`)).toBe('deny');
      expect(await decide(clean, `cd "$PWD/../ws" && git commit -m x`)).toBe('deny');
    });

    it('a bare cd keeps both the directory before it and $HOME; cd ~ goes home exactly', async () => {
      process.env.HOME = ws;
      expect(await decide(clean, `cd && git commit -m x`)).toBe('deny');
      expect(await decide(clean, `cd ~ && git commit -m x`)).toBe('deny');
      expect(resolveGitCwd('cd && git commit -m x', clean)).toBe(clean);
      expect(resolveGitCommitDirs('cd && git commit -m x', clean)).toEqual([clean, ws]);
      expect(resolveGitCommitDirs('cd ~ && git commit -m x', clean)).toEqual([ws]);
    });

    it('an unresolvable cd keeps the directory before it as a candidate and logs unresolved_cd', async () => {
      // `$(...)` cannot be resolved: the commit may run in clean (before) or anywhere. Before it, ws is the cwd.
      expect(await decide(ws, 'cd "$(mktemp -d)" && git commit -m x')).toBe('deny');
      expect(rows().filter((r) => r.event === 'commit_gate' && r.outcome === 'unresolved_cd')).toHaveLength(1);
    });

    it('an unresolved cd is logged even when the decision is allow', async () => {
      expect(await decide(clean, 'cd "$UNKNOWN_DIR" && git commit -m x')).toBe('allow');
      const logged = rows().filter((r) => r.event === 'commit_gate' && r.outcome === 'unresolved_cd');
      expect(logged).toHaveLength(1);
      expect(logged[0].reasons).toEqual(['expansion']);
    });

    it('popd with an empty stack, a missing directory and cd - without a known previous directory are logged', async () => {
      expect(await decide(clean, 'popd && git commit -m x')).toBe('allow');
      expect(await decide(clean, 'cd - && git commit -m x')).toBe('allow');
      expect(await decide(clean, `cd ${path.join(tmpHome, 'nope')} && git commit -m x`)).toBe('allow');
      const reasons = rows()
        .filter((r) => r.outcome === 'unresolved_cd')
        .map((r) => r.reasons);
      expect(reasons).toEqual([['popd'], ['cd-'], ['missing-dir']]);
    });

    it('a cd that resolves exactly logs nothing', async () => {
      expect(await decide(ws, `cd ${clean} && git commit -m x`)).toBe('allow');
      expect(rows().filter((r) => r.outcome === 'unresolved_cd')).toHaveLength(0);
    });

    it('resolveGitCommitDirs keeps the directory before an unresolved step', () => {
      expect(resolveGitCommitDirs('cd "$UNKNOWN_DIR" && git commit -m x', clean)).toEqual([clean]);
      expect(resolveGitCommitDirs(`pushd ${clean} && popd && git commit -m x`, ws)).toEqual([ws]);
    });

    it('regressions: cd dir && git commit, a quoted directory with a space, a subshell', async () => {
      const spaced = path.join(tmpHome, 'dir with space');
      const gitSpaced = initRepo(spaced);
      fs.writeFileSync(path.join(spaced, 'c.txt'), CONFLICT);
      gitSpaced('add c.txt');
      expect(await decide(clean, `cd ${ws} && git commit -m x`)).toBe('deny');
      expect(await decide(clean, `git -C "${spaced}" commit -m x`)).toBe('deny');
      expect(await decide(clean, `cd "${spaced}" && git commit -m x`)).toBe('deny');
      expect(await decide(clean, `(cd ${ws} && git commit -m x)`)).toBe('deny');
      expect(await decide(ws, `(cd ${clean} && true); git commit -m x`)).toBe('deny');
      expect(await decide(ws, `echo "git commit"`)).toBe('allow');
    });
  });

  describe('F3: text piped into a shell', () => {
    for (const shell of ['sh', 'bash', 'zsh', 'dash']) {
      it(`echo 'git commit -m x' | ${shell} is a commit`, async () => {
        expect(await decide(ws, `echo 'git commit -m x' | ${shell}`)).toBe('deny');
      });
    }

    it('printf, a pipeline with another stage in between, and sh -s are commits too', async () => {
      expect(await decide(ws, `printf 'git commit -m x' | sh`)).toBe('deny');
      expect(await decide(ws, `printf '%s\\n' 'git commit -m x' | bash`)).toBe('deny');
      expect(await decide(ws, `echo "git commit -m x" | tee /dev/null | sh`)).toBe('deny');
      expect(await decide(ws, `echo "git commit -m x" | sh -s`)).toBe('deny');
      expect(await decide(ws, `echo "git commit -m x" | sh -`)).toBe('deny');
      expect(await decide(ws, `echo "echo hi\\ngit commit -m x" | sh`)).toBe('deny');
    });

    it('the piped text is walked like a command line: a cd inside it moves the commit', async () => {
      expect(await decide(clean, `echo 'cd ${ws} && git commit -m x' | sh`)).toBe('deny');
    });

    it('text that is not piped into a shell is data, not a commit', async () => {
      expect(await decide(ws, `echo "git commit"`)).toBe('allow');
      expect(await decide(ws, `echo 'git commit -m x' | cat`)).toBe('allow');
      expect(await decide(ws, `echo 'git commit -m x' | sh -c 'cat'`)).toBe('allow');
      expect(await decide(ws, `echo 'git commit -m x' | sh script.sh`)).toBe('allow');
      expect(await decide(ws, `echo 'git commit -m x' && sh`)).toBe('allow');
      expect(findGitCommit(`echo "git commit"`)).toBeNull();
      expect(findGitCommit(`echo 'git commit -m x' | sh`)?.subcommand).toBe('commit');
    });

    it('a here-string into a shell is a commit', async () => {
      expect(await decide(ws, `bash <<< 'git commit -m x'`)).toBe('deny');
    });
  });

  describe('F4: every commit of the line is checked', () => {
    it('a clean commit first does not hide a dirty one second', async () => {
      expect(await decide(tmpHome, `git -C ${clean} commit -m a && git -C ${ws} commit -m b`)).toBe('deny');
      expect(await decide(tmpHome, `git -C ${ws} commit -m a && git -C ${clean} commit -m b`)).toBe('deny');
      expect(await decide(tmpHome, `git -C ${clean} commit -m a; git -C ${clean2} commit -m b`)).toBe('allow');
    });

    it('commits inside sh -c and after a cd are all checked', async () => {
      expect(await decide(tmpHome, `git -C ${clean} commit -m a && sh -c 'cd ${ws} && git commit -m b'`)).toBe('deny');
      expect(await decide(tmpHome, `cd ${clean} && git commit -m a && cd ${ws} && git commit -m b`)).toBe('deny');
    });

    it('resolveGitCommitDirs is the union over all commits; findGitInvocations lists them all', () => {
      expect(resolveGitCommitDirs(`git -C ${clean} commit -m a && git -C ${ws} commit -m b`, tmpHome)).toEqual([clean, ws]);
      const commits = findGitInvocations('git commit -m a && git commit -m b').filter((g) => g.subcommand === 'commit');
      expect(commits).toHaveLength(2);
    });

    it('commitIncludesWorkingTree considers any commit; the diff mode is chosen per commit', async () => {
      expect(commitIncludesWorkingTree('git commit -m a && git commit -am b')).toBe(true);
      expect(commitIncludesWorkingTree('git commit -m a && git commit -m b')).toBe(false);
      // ws2: the conflict is only in the working tree, so only an -a commit (diff against HEAD) sees it.
      const ws2 = path.join(tmpHome, 'ws2');
      const git2 = initRepo(ws2);
      fs.writeFileSync(path.join(ws2, 'f.txt'), 'seed\n');
      git2('add f.txt');
      git2('commit -m seed');
      fs.writeFileSync(path.join(ws2, 'f.txt'), CONFLICT);
      expect(await decide(tmpHome, `git -C ${clean} commit -m a && git -C ${ws2} commit -am b`)).toBe('deny');
      expect(await decide(tmpHome, `git -C ${ws2} commit -m a && git -C ${clean} commit -m b`)).toBe('allow');
    });

    it('findGitCommit still returns the first commit for its existing callers', () => {
      expect(findGitCommit('git -C a commit -m 1 && git -C b commit -m 2')?.dashC).toEqual(['a']);
    });
  });

  describe('F5: --git-dir, --work-tree, GIT_DIR and GIT_WORK_TREE', () => {
    it('--git-dir=... --work-tree=... checks that repository, not the cwd', async () => {
      expect(await decide(clean, `git --git-dir=${ws}/.git --work-tree=${ws} commit -m x`)).toBe('deny');
    });

    it('the space-separated forms and a relative path resolved against the cwd', async () => {
      expect(await decide(clean, `git --git-dir ${ws}/.git --work-tree ${ws} commit -m x`)).toBe('deny');
      expect(await decide(tmpHome, `git --git-dir=ws/.git --work-tree=ws commit -m x`)).toBe('deny');
      expect(await decide(tmpHome, `git --git-dir ws/.git --work-tree ws commit -m x`)).toBe('deny');
    });

    it('--git-dir alone: git uses that index with the cwd as work tree', async () => {
      expect(await decide(clean, `git --git-dir=${ws}/.git commit -m x`)).toBe('deny');
      expect(await decide(clean, `git --git-dir ${ws}/.git commit -m x`)).toBe('deny');
    });

    it('--work-tree alone: the checks also run in the work tree (documented, conservative)', async () => {
      expect(await decide(clean, `git --work-tree=${ws} commit -m x`)).toBe('deny');
    });

    it('a relative --git-dir is relative to the directory -C moved to', async () => {
      expect(await decide(clean, `git -C ${tmpHome} --git-dir=ws/.git --work-tree=ws commit -m x`)).toBe('deny');
      expect(await decide(clean, `git --git-dir=ws/.git --work-tree=ws -C ${tmpHome} commit -m x`)).toBe('deny');
    });

    it('GIT_DIR / GIT_WORK_TREE as VAR= prefixes, after env, and exported earlier in the line', async () => {
      expect(await decide(clean, `GIT_DIR=${ws}/.git GIT_WORK_TREE=${ws} git commit -m x`)).toBe('deny');
      expect(await decide(clean, `GIT_DIR=${ws}/.git git commit -m x`)).toBe('deny');
      expect(await decide(clean, `env GIT_DIR=${ws}/.git GIT_WORK_TREE=${ws} git commit -m x`)).toBe('deny');
      expect(await decide(clean, `export GIT_DIR=${ws}/.git GIT_WORK_TREE=${ws}; git commit -m x`)).toBe('deny');
      expect(await decide(clean, `GIT_DIR=${ws}/.git; export GIT_DIR; git commit -m x`)).toBe('deny');
    });

    it('with --git-dir the staged/working-tree choice and the untracked scan use that repository', async () => {
      const wt = path.join(tmpHome, 'wt');
      const gitWt = initRepo(wt);
      fs.writeFileSync(path.join(wt, 'f.txt'), 'seed\n');
      gitWt('add f.txt');
      gitWt('commit -m seed');
      fs.writeFileSync(path.join(wt, 'f.txt'), CONFLICT);
      const opts = `--git-dir=${wt}/.git --work-tree=${wt}`;
      expect(await decide(clean, `git ${opts} commit -m x`)).toBe('allow');
      expect(await decide(clean, `git ${opts} commit -am x`)).toBe('deny');
      fs.writeFileSync(path.join(wt, 'f.txt'), 'seed\n');
      fs.writeFileSync(path.join(wt, 'new.txt'), CONFLICT);
      expect(await decide(clean, `git ${opts} add new.txt && git ${opts} commit -m x`)).toBe('deny');
      expect(await decide(clean, `export GIT_DIR=${wt}/.git GIT_WORK_TREE=${wt}; git add -A && git commit -m x`)).toBe('deny');
      // A VAR= prefix applies to its own command only: here the commit runs in `clean`.
      expect(await decide(clean, `GIT_DIR=${wt}/.git GIT_WORK_TREE=${wt} git add -A && git commit -m x`)).toBe('allow');
    });

    it('a clean --git-dir target is allowed even when the cwd repository has conflicts', async () => {
      expect(await decide(ws, `git --git-dir=${clean}/.git --work-tree=${clean} commit -m x`)).toBe('allow');
      expect(await decide(ws, `GIT_DIR=${clean}/.git GIT_WORK_TREE=${clean} git commit -m x`)).toBe('allow');
    });
  });
});
