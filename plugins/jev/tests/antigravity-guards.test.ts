import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluatePreToolGuards,
  parseEpoch,
  computeLastDispatchEpoch,
  isExemptPath,
  hasConflictMarkers,
  commitIncludesWorkingTree,
  commandRunsGitAdd,
  findGitCommit,
  resolveGitCwd,
  type PreToolHookInput
} from '../antigravity/guards.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';

describe('antigravity guards (guards.ts)', () => {
  let tmpHome = '';
  let jevConfigDir = '';
  let agyDir = '';
  let sessionsDir = '';
  let origHome = '';
  let origConfig = '';
  let origTelemetry = '';

  beforeEach(() => {
    clearConfigCacheForTesting();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-guards-test-'));
    jevConfigDir = path.join(tmpHome, '.config', 'jev');
    agyDir = path.join(tmpHome, '.gemini', 'antigravity-cli');
    sessionsDir = path.join(jevConfigDir, 'antigravity-sessions');
    fs.mkdirSync(jevConfigDir, { recursive: true });
    fs.mkdirSync(agyDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    origHome = process.env.HOME || '';
    origConfig = process.env.JEV_CONFIG_FILE || '';
    origTelemetry = process.env.JEV_TELEMETRY_FILE || '';

    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(jevConfigDir, 'config.json');
    process.env.JEV_TELEMETRY_FILE = path.join(agyDir, 'jev_telemetry.jsonl');

    fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on' } }));
  });

  afterEach(() => {
    clearConfigCacheForTesting();
    process.env.HOME = origHome;
    if (origConfig) process.env.JEV_CONFIG_FILE = origConfig;
    else delete process.env.JEV_CONFIG_FILE;
    if (origTelemetry) process.env.JEV_TELEMETRY_FILE = origTelemetry;
    else delete process.env.JEV_TELEMETRY_FILE;

    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('parseEpoch parses number epoch, timestamp_ms, ISO strings, and handles malformed rows', () => {
    expect(parseEpoch({ epoch: 1700000000 })).toBe(1700000000);
    expect(parseEpoch({ timestamp_ms: 1700000000000 })).toBe(1700000000);
    expect(parseEpoch({ timestamp: '2026-11-16T12:00:00Z' })).toBe(Date.parse('2026-11-16T12:00:00Z') / 1000);
    expect(parseEpoch({ timestamp: '2026-11-16T12:00:00+00:00' })).toBe(Date.parse('2026-11-16T12:00:00+00:00') / 1000);
    expect(parseEpoch({ epoch: 'invalid' })).toBe(0);
    expect(parseEpoch({ timestamp: 'not-a-date' })).toBe(0);
    expect(parseEpoch(null)).toBe(0);
    expect(parseEpoch({})).toBe(0);
  });

  it('computeLastDispatchEpoch ignores PreInvocation and other-conversation telemetry, and matches correct session', () => {
    const telemFile = process.env.JEV_TELEMETRY_FILE!;
    const decisionsFile = path.join(jevConfigDir, 'antigravity_decisions.jsonl');

    const lines = [
      // 1. PreInvocation line for target session (should be ignored!)
      JSON.stringify({ epoch: 1000, tool: 'jev_dispatch', toolOrHook: 'PreInvocation', sessionId: 'c-target' }),
      // 2. Dispatch for ANOTHER session (should be ignored!)
      JSON.stringify({ epoch: 2000, tool: 'jev_dispatch', sessionId: 'c-other' }),
      // 3. Dispatch for target session (valid!)
      JSON.stringify({ epoch: 1500, tool: 'jev_dispatch', sessionId: 'c-target' }),
      // 4. Batch dispatch for target session with timestamp (valid!)
      JSON.stringify({ timestamp: '2026-11-16T15:00:00Z', tool: 'jev_batch_dispatch', sessionId: 'c-target' }),
      // 5. Malformed line
      '{"broken json'
    ];
    fs.writeFileSync(telemFile, lines.join('\n') + '\n');

    const decisionsLines = [
      // Subagent call for target session
      JSON.stringify({ epoch: 1600, tool_name: 'invoke_subagent', decision: 'allow', session_id: 'c-target' }),
      // Denied subagent call (should be ignored!)
      JSON.stringify({ epoch: 1900, tool_name: 'invoke_subagent', decision: 'deny', session_id: 'c-target' })
    ];
    fs.writeFileSync(decisionsFile, decisionsLines.join('\n') + '\n');

    const targetEpoch = computeLastDispatchEpoch('c-target', telemFile, decisionsFile);
    const expectedBatchEpoch = Date.parse('2026-11-16T15:00:00Z') / 1000;
    // Expected max is expectedBatchEpoch (> 1600)
    expect(targetEpoch).toBe(expectedBatchEpoch);

    // Other conversation does not see target's dispatch
    const otherEpoch = computeLastDispatchEpoch('c-other', telemFile, decisionsFile);
    expect(otherEpoch).toBe(2000);
  });

  it('exemptPaths (e.g. plans/, /brain/, .agents/memory/) bypass write guard', async () => {
    const inputBrain: PreToolHookInput = {
      conversationId: 'c-write',
      toolCall: {
        name: 'write_file',
        args: { Path: '/home/user/.gemini/antigravity-cli/brain/sess-1/notes.md' }
      }
    };
    const resBrain = await evaluatePreToolGuards(inputBrain);
    expect(resBrain.decision).toBe('allow');

    const inputPlan: PreToolHookInput = {
      conversationId: 'c-write',
      toolCall: {
        name: 'edit_file',
        args: { Path: 'plans/rfc-1.md' }
      }
    };
    const resPlan = await evaluatePreToolGuards(inputPlan);
    expect(resPlan.decision).toBe('allow');
  });

  it('run_command commit gate denies staged merge conflict markers', async () => {
    // Create a git repo in tmpDir
    const gitRepoDir = path.join(tmpHome, 'git-repo');
    fs.mkdirSync(gitRepoDir, { recursive: true });
    const runGit = (cmd: string) => {
      const proc = Bun.spawnSync(['sh', '-c', `git ${cmd}`], { cwd: gitRepoDir });
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    };
    runGit('init');
    runGit('config user.email "test@example.com"');
    runGit('config user.name "Test"');

    // Stage a file with conflict markers
    fs.writeFileSync(path.join(gitRepoDir, 'conflict.txt'), 'line 1\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n');
    runGit('add conflict.txt');

    const inputCommit: PreToolHookInput = {
      cwd: gitRepoDir,
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'git commit -m "commit"' }
      }
    };

    const resCommit = await evaluatePreToolGuards(inputCommit);
    expect(resCommit.decision).toBe('deny');
    expect(resCommit.reason).toContain('merge conflict markers');
  });

  function makeRepo(name = 'git-repo'): { dir: string; git: (cmd: string) => string } {
    const dir = path.join(tmpHome, name);
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
    return { dir, git };
  }

  const commitInput = (cwd: string, CommandLine: string): PreToolHookInput => ({
    cwd,
    toolCall: { name: 'run_command', args: { CommandLine } }
  });

  const readDecisions = (): Array<Record<string, unknown>> => {
    const f = path.join(jevConfigDir, 'antigravity_decisions.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };

  it('commit gate: a real Markdown setext heading ("=======" underline) is allowed', async () => {
    const { dir, git } = makeRepo('setext-repo');
    fs.writeFileSync(path.join(dir, 'doc.md'), 'Title\n=======\nBody text.\n\nSub\n---\nMore.\n');
    git('add doc.md');
    expect((await evaluatePreToolGuards(commitInput(dir, 'git commit -m "docs"'))).decision).toBe('allow');
    // The same text through the working-tree path is allowed too.
    expect((await evaluatePreToolGuards(commitInput(dir, 'git add doc.md && git commit -m "docs"'))).decision).toBe('allow');
  });

  it('hasConflictMarkers: a lone separator is not enough; a block with opening or closing markers is', () => {
    expect(hasConflictMarkers('+Heading\n+=======\n+Some text\n')).toBe(false);
    expect(hasConflictMarkers('+<<<<<<< HEAD\n+ours\n+=======\n+theirs\n+>>>>>>> branch\n')).toBe(true);
    expect(hasConflictMarkers('+x\n+=======\n+>>>>>>> branch\n')).toBe(true);
    expect(hasConflictMarkers('-<<<<<<< HEAD\n+ok\n')).toBe(false);
  });

  it('commitIncludesWorkingTree: git global options with a value do not hide git add or commit -a', () => {
    expect(commitIncludesWorkingTree('git -C repo add . && git commit -m x')).toBe(true);
    expect(commitIncludesWorkingTree('git -c user.name=x add -A && git commit -m x')).toBe(true);
    expect(commitIncludesWorkingTree('git -C repo commit -am x')).toBe(true);
    expect(commitIncludesWorkingTree('git -C repo commit -m x')).toBe(false);
  });

  it('commit gate: "git -C dir add" on the same line widens the commit to the working tree', async () => {
    const { dir, git } = makeRepo('dash-c-repo');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add a.txt');
    git('commit -m init');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n'); // NOT staged
    const res = await evaluatePreToolGuards(commitInput(dir, `git -C ${dir} add . && git -C ${dir} commit -m "x"`));
    expect(res.decision).toBe('deny');
  });

  it('commit gate: text that merely looks like markers is not blocked; a real conflict block is', async () => {
    const { dir, git } = makeRepo();
    fs.writeFileSync(path.join(dir, 'doc.md'), 'Title\n======= trailing text\n<<<<<<<< eight angle brackets\n=======-not-a-marker\n');
    git('add doc.md');
    const ok = await evaluatePreToolGuards(commitInput(dir, 'git commit -m "docs"'));
    expect(ok.decision).toBe('allow');

    // A removed (not added) conflict marker line does not count either.
    git('commit -m init');
    fs.writeFileSync(path.join(dir, 'doc.md'), 'Title\n');
    git('add doc.md');
    expect((await evaluatePreToolGuards(commitInput(dir, 'git commit -m "x"'))).decision).toBe('allow');

    // The full block, with the separator alone on its line, is blocked.
    fs.writeFileSync(path.join(dir, 'doc.md'), 'Title\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n');
    git('add doc.md');
    const bad = await evaluatePreToolGuards(commitInput(dir, 'git commit -m "x"'));
    expect(bad.decision).toBe('deny');
    expect(bad.reason).toContain('merge conflict markers');
  });

  it('commit gate: -a, --all and -am diff against HEAD, so unstaged conflict markers are blocked', async () => {
    const { dir, git } = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add a.txt');
    git('commit -m init');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n'); // NOT staged

    // Index-only commit: nothing staged, nothing to block.
    expect((await evaluatePreToolGuards(commitInput(dir, 'git commit -m "x"'))).decision).toBe('allow');
    // Working-tree forms: blocked.
    for (const cmd of ['git commit -am "x"', 'git commit -a -m "x"', 'git commit --all -m "x"', 'git commit -qam "x"']) {
      const res = await evaluatePreToolGuards(commitInput(dir, cmd));
      expect(res.decision).toBe('deny');
    }
    // A same-line git add widens the commit too.
    expect((await evaluatePreToolGuards(commitInput(dir, 'git add -A && git commit -m "x"'))).decision).toBe('deny');
    // A message that merely contains " -a " does not.
    expect((await evaluatePreToolGuards(commitInput(dir, 'git commit -m "document the -a flag"'))).decision).toBe('allow');
    // --amend is not -a.
    expect((await evaluatePreToolGuards(commitInput(dir, 'git commit --amend --no-edit'))).decision).toBe('allow');
  });

  const CONFLICT_BLOCK = 'one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';

  it('commit gate: resolves git -C and cd target directory when input.cwd is a different repo', async () => {
    const { dir: cleanDir } = makeRepo('clean-ws');
    const { dir: targetDir, git: targetGit } = makeRepo('dash-c-other-cwd');
    fs.writeFileSync(path.join(targetDir, 'c.txt'), CONFLICT_BLOCK);
    targetGit('add c.txt');
    expect((await evaluatePreToolGuards(commitInput(cleanDir, `git -C ${targetDir} commit -m "x"`))).decision).toBe('deny');
    expect((await evaluatePreToolGuards(commitInput(cleanDir, `cd ${targetDir} && git commit -m "x"`))).decision).toBe('deny');
    const denyRows = readDecisions().filter((r) => r.event === 'commit_gate' && r.outcome === 'deny');
    expect(denyRows.length).toBeGreaterThanOrEqual(2);
  });

  it('commit gate: color.ui = always in the git config does not hide staged markers', async () => {
    const { dir, git } = makeRepo('color-repo');
    git('config color.ui always');
    git('config color.diff always');
    fs.writeFileSync(path.join(dir, 'f.txt'), CONFLICT_BLOCK);
    git('add f.txt');
    expect((await evaluatePreToolGuards(commitInput(dir, 'git commit -m x'))).decision).toBe('deny');
  });

  it('commit gate: diff.external and a textconv driver do not replace the diff', async () => {
    const { dir, git } = makeRepo('extdiff-repo');
    git('config diff.external true');
    fs.writeFileSync(path.join(dir, 'f.txt'), CONFLICT_BLOCK);
    git('add f.txt');
    expect((await evaluatePreToolGuards(commitInput(dir, 'git commit -m x'))).decision).toBe('deny');

    const { dir: dir2, git: git2 } = makeRepo('textconv-repo');
    git2('config diff.blank.textconv "sh -c true"');
    fs.writeFileSync(path.join(dir2, '.gitattributes'), '*.txt diff=blank\n');
    fs.writeFileSync(path.join(dir2, 'f.txt'), CONFLICT_BLOCK);
    git2('add .gitattributes f.txt');
    expect((await evaluatePreToolGuards(commitInput(dir2, 'git commit -m x'))).decision).toBe('deny');
  });

  it('commit gate: a new untracked file added on the same line is scanned', async () => {
    const { dir, git } = makeRepo('untracked-repo');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add a.txt');
    git('commit -m init');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'f.txt'), CONFLICT_BLOCK); // untracked

    const res = await evaluatePreToolGuards(commitInput(dir, 'git add sub/f.txt && git commit -m x'));
    expect(res.decision).toBe('deny');
    expect(res.reason).toContain('sub/f.txt');
    // Run from a subdirectory with `git add -A`: the scan still covers the whole repository.
    fs.renameSync(path.join(dir, 'sub', 'f.txt'), path.join(dir, 'g.txt'));
    expect((await evaluatePreToolGuards(commitInput(path.join(dir, 'sub'), 'git add -A && git commit -m x'))).decision).toBe('deny');
    // Without a `git add`, an untracked file is not part of the commit.
    expect((await evaluatePreToolGuards(commitInput(dir, 'git commit -am x'))).decision).toBe('allow');
    // Ignored files and a setext heading in an untracked file are not blocked.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'g.txt\n');
    fs.writeFileSync(path.join(dir, 'doc.md'), 'Title\n=======\nBody.\n');
    expect((await evaluatePreToolGuards(commitInput(dir, 'git add -A && git commit -m x'))).decision).toBe('allow');
  });

  it('commit gate: an untracked file in a repository with no commit yet is still scanned', async () => {
    const { dir } = makeRepo('fresh-untracked-repo');
    fs.writeFileSync(path.join(dir, 'f.txt'), CONFLICT_BLOCK);
    expect((await evaluatePreToolGuards(commitInput(dir, 'git add f.txt && git commit -m x'))).decision).toBe('deny');
  });

  it('commit gate: a git error passes through and logs commit_gate / git_error', async () => {
    const notRepo = path.join(tmpHome, 'not-a-repo');
    fs.mkdirSync(notRepo, { recursive: true });
    const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmpHome;
    try {
      const res = await evaluatePreToolGuards(commitInput(notRepo, 'git commit -m "x"'));
      expect(res.decision).toBe('allow');
    } finally {
      if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
    }
    const rows = readDecisions().filter((r) => r.event === 'commit_gate');
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('git_error');
    expect(typeof rows[0].epoch).toBe('number');

    // `git diff HEAD` in a repo with no commit is a git error as well (the -a path).
    const { dir } = makeRepo('fresh-repo');
    const res2 = await evaluatePreToolGuards(commitInput(dir, 'git commit -am "x"'));
    expect(res2.decision).toBe('allow');
    expect(readDecisions().filter((r) => r.event === 'commit_gate')).toHaveLength(2);
  });

  it('isExemptPath matches path segments, not substrings', () => {
    const exempt = ['plans/', '/brain/', '.agents/memory/', '.agents/rules/'];
    expect(isExemptPath('plans/rfc-1.md', exempt)).toBe(true);
    expect(isExemptPath('docs/plans/rfc-1.md', exempt)).toBe(true);
    expect(isExemptPath('/home/user/.gemini/antigravity-cli/brain/sess-1/notes.md', exempt)).toBe(true);
    expect(isExemptPath('repo/.agents/memory/fact.md', exempt)).toBe(true);
    expect(isExemptPath('src/xplans/a.md', exempt)).toBe(false);
    expect(isExemptPath('src/plans-old/a.md', exempt)).toBe(false);
    expect(isExemptPath('src/plans', exempt)).toBe(false); // a FILE named plans is not a plans/ directory
    expect(isExemptPath('src/mybrain/a.md', exempt)).toBe(false);
    expect(isExemptPath('x/.agents/memoryx/a.md', exempt)).toBe(false);
    expect(isExemptPath('', exempt)).toBe(false);
    expect(isExemptPath('docs\\plans\\a.md', exempt)).toBe(true);
  });

  it('write guard: substring look-alikes are counted, and an empty target path is never recorded', async () => {
    const convId = 'c-seg';
    const edit = (p: string) => ({
      conversationId: convId,
      modelName: 'gemini-3.8-flash-low',
      toolCall: { name: 'edit_file', args: { Path: p } }
    });
    // Empty path: allowed, not recorded.
    expect((await evaluatePreToolGuards(edit(''))).decision).toBe('allow');
    const guardFile = path.join(sessionsDir, `${convId}.write-guard.json`);
    expect(fs.existsSync(guardFile)).toBe(false);

    // src/xplans/* is NOT exempt: it fills the 3-file streak.
    for (const f of ['src/xplans/a.md', 'src/xplans/b.md', 'src/xplans/c.md']) {
      expect((await evaluatePreToolGuards(edit(f))).decision).toBe('allow');
    }
    expect(JSON.parse(fs.readFileSync(guardFile, 'utf8')).files).toEqual(['src/xplans/a.md', 'src/xplans/b.md', 'src/xplans/c.md']);
    expect((await evaluatePreToolGuards(edit('src/xplans/d.md'))).decision).toBe('deny');
    // A real plans/ segment still passes.
    expect((await evaluatePreToolGuards(edit('docs/plans/d.md'))).decision).toBe('allow');
  });

  it('write guard without a conversationId passes through, logs write_guard / no_conversation_id, and never writes default.write-guard.json', async () => {
    const edit = (p: string) => ({
      modelName: 'gemini-3.8-flash-low',
      toolCall: { name: 'edit_file', args: { Path: p } }
    });
    // More files than the limit: still allowed, since no streak exists without a conversation.
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) {
      expect((await evaluatePreToolGuards(edit(`src/${f}`))).decision).toBe('allow');
    }
    expect(fs.existsSync(path.join(sessionsDir, 'default.write-guard.json'))).toBe(false);
    expect(fs.readdirSync(sessionsDir).filter((n) => n.endsWith('.write-guard.json'))).toEqual([]);
    const rows = readDecisions().filter((r) => r.event === 'write_guard');
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.outcome).toBe('no_conversation_id');
      expect(typeof r.epoch).toBe('number');
    }
  });

  it('writers prune *.write-guard.json older than 7200 s with the same stamp as the model files', async () => {
    const stale = path.join(sessionsDir, 'c-stale.write-guard.json');
    const fresh = path.join(sessionsDir, 'c-fresh.write-guard.json');
    const staleModel = path.join(sessionsDir, 'c-stale.model.json');
    fs.writeFileSync(stale, JSON.stringify({ last_dispatch_ts: 0, files: ['x'] }));
    fs.writeFileSync(fresh, JSON.stringify({ last_dispatch_ts: 0, files: ['y'] }));
    fs.writeFileSync(staleModel, JSON.stringify({ conversationId: 'c-stale', model: 'm', updated_at: 1000 }));
    const old = new Date(Date.now() - 7300 * 1000);
    fs.utimesSync(stale, old, old);

    await evaluatePreToolGuards({
      conversationId: 'c-pruner',
      modelName: 'gemini-3.8-flash-low',
      toolCall: { name: 'edit_file', args: { Path: 'src/p.ts' } }
    });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(staleModel)).toBe(false); // same mechanism: the model file is pruned in the same pass
    expect(fs.existsSync(path.join(sessionsDir, '.prune-stamp'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'c-pruner.write-guard.json'))).toBe(true);
  });

  it('multi-file write guard enforces 3-file limit on standard sessions and 6-file limit on Orchestrator', async () => {
    const convId = 'c-limit-test';
    // 1. Standard session (limit 3)
    const makeEdit = (file: string, isOrch = false, transcriptPath?: string) => ({
      conversationId: convId,
      modelName: isOrch ? 'Orchestrator (Argon)' : 'gemini-3.8-flash-low',
      transcriptPath,
      toolCall: {
        name: 'edit_file',
        args: { Path: file }
      }
    });

    // File 1, 2, 3 allowed
    expect((await evaluatePreToolGuards(makeEdit('src/a.ts'))).decision).toBe('allow');
    expect((await evaluatePreToolGuards(makeEdit('src/b.ts'))).decision).toBe('allow');
    expect((await evaluatePreToolGuards(makeEdit('src/c.ts'))).decision).toBe('allow');
    // Editing already recorded file again is allowed
    expect((await evaluatePreToolGuards(makeEdit('src/a.ts'))).decision).toBe('allow');

    // File 4 is denied on standard session (>= 3)
    const res4 = await evaluatePreToolGuards(makeEdit('src/d.ts'));
    expect(res4.decision).toBe('deny');
    expect(res4.reason).toContain('Post-Approval Transition Gate');
    expect(res4.reason).toContain('jev_batch_dispatch');

    // 2. Orchestrator session (limit 6)
    const convOrch = 'c-orch-limit';
    const makeOrchEdit = (file: string, transcriptPath?: string) => ({
      conversationId: convOrch,
      modelName: 'Orchestrator (Argon)',
      transcriptPath,
      toolCall: {
        name: 'edit_file',
        args: { Path: file }
      }
    });

    for (let i = 1; i <= 6; i++) {
      expect((await evaluatePreToolGuards(makeOrchEdit(`src/orch_${i}.ts`))).decision).toBe('allow');
    }
    // 7th file is denied on Orchestrator (>= 6)
    const resOrch7 = await evaluatePreToolGuards(makeOrchEdit('src/orch_7.ts'));
    expect(resOrch7.decision).toBe('deny');
    expect(resOrch7.reason).toContain('>= 6');
  });

  it('handles a FIFO transcriptPath safely without hanging', async () => {
    const fifoPath = path.join(tmpHome, 'test.fifo');
    try {
      Bun.spawnSync(['mkfifo', fifoPath]);
    } catch {
      // mkfifo might fail on some platforms
      return;
    }
    if (!fs.existsSync(fifoPath)) return;

    const input: PreToolHookInput = {
      conversationId: 'c-fifo',
      transcriptPath: fifoPath,
      toolCall: {
        name: 'write_file',
        args: { Path: 'src/file.ts' }
      }
    };

    // Must not hang
    const res = await evaluatePreToolGuards(input);
    expect(res.decision).toBe('allow');
  });
});

describe('resolveGitCwd', () => {
  let root = '';
  let base = '';
  const real = (p: string) => fs.realpathSync(p);

  beforeEach(() => {
    root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gitcwd-')));
    base = path.join(root, 'base');
    for (const d of ['base', 'other', 'a/b', 'a/c', 'dir with space']) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a -C on an earlier command does not move the commit', () => {
    expect(resolveGitCwd('git -C ../other status && git commit -m x', base)).toBe(base);
  });

  it('-C after cd is relative to the directory cd moved to', () => {
    expect(resolveGitCwd('cd ../a && git -C b commit -m x', base)).toBe(path.join(root, 'a', 'b'));
  });

  it('cd counts when other commands sit between it and the commit', () => {
    expect(resolveGitCwd('cd ../a && make && git commit -m x', base)).toBe(path.join(root, 'a'));
  });

  it('plain -C, and a -C on git add is ignored for the commit', () => {
    expect(resolveGitCwd('git -C ../other commit -m x', base)).toBe(path.join(root, 'other'));
    expect(resolveGitCwd('git -C ../other add . && git commit -m x', base)).toBe(base);
  });

  it('handles quoted directory names', () => {
    expect(resolveGitCwd('cd "../dir with space" && git commit -m x', base)).toBe(path.join(root, 'dir with space'));
    expect(resolveGitCwd("git -C '../dir with space' commit -m x", base)).toBe(path.join(root, 'dir with space'));
  });

  it('does not split on separators inside quotes', () => {
    expect(resolveGitCwd('echo "a && cd ../other" && git commit -m "x; y"', base)).toBe(base);
  });

  it('applies repeated -C options in order, each relative to the previous', () => {
    expect(resolveGitCwd('git -C ../a -C b commit -m x', base)).toBe(path.join(root, 'a', 'b'));
  });

  it('follows pushd like cd', () => {
    expect(resolveGitCwd('pushd ../a && git commit -m x', base)).toBe(path.join(root, 'a'));
  });

  it('ignores a nonexistent directory and keeps the previous cwd', () => {
    expect(resolveGitCwd('cd ../nope && git commit -m x', base)).toBe(base);
    expect(resolveGitCwd('cd ../a && git -C nope commit -m x', base)).toBe(path.join(root, 'a'));
  });

  it('leaves cwd unchanged for bare cd and cd -', () => {
    expect(resolveGitCwd('cd && git commit -m x', base)).toBe(base);
    expect(resolveGitCwd('cd - && git commit -m x', base)).toBe(base);
  });

  it('handles global options before commit and returns the running cwd with no commit', () => {
    expect(resolveGitCwd('git --no-pager -c user.name=x commit -m x', base)).toBe(base);
    expect(resolveGitCwd('cd ../a; git status', base)).toBe(path.join(root, 'a'));
  });

  it('expands ~ with the configured home', () => {
    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      expect(resolveGitCwd('cd ~/other && git commit -m x', base)).toBe(path.join(root, 'other'));
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });

  it('never throws on odd input', () => {
    expect(resolveGitCwd('', base)).toBe(base);
    expect(resolveGitCwd('git commit "unterminated', base)).toBe(base);
    expect(resolveGitCwd('cd "unterminated && git commit', base)).toBe(base);
  });
});

describe('commit detection shares the segment walker (A1)', () => {
  let tmpHome = '';
  let jevConfigDir = '';
  let origHome = '';
  let origConfig = '';

  beforeEach(() => {
    clearConfigCacheForTesting();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-guards-a1-'));
    jevConfigDir = path.join(tmpHome, '.config', 'jev');
    fs.mkdirSync(jevConfigDir, { recursive: true });
    origHome = process.env.HOME || '';
    origConfig = process.env.JEV_CONFIG_FILE || '';
    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(jevConfigDir, 'config.json');
    fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on' } }));
  });

  afterEach(() => {
    clearConfigCacheForTesting();
    process.env.HOME = origHome;
    if (origConfig) process.env.JEV_CONFIG_FILE = origConfig;
    else delete process.env.JEV_CONFIG_FILE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const CONFLICT = 'one\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';

  function repoAt(rel: string): { dir: string; git: (cmd: string) => string } {
    const dir = path.join(tmpHome, rel);
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
    return { dir, git };
  }

  const cmdInput = (cwd: string, CommandLine: string): PreToolHookInput => ({
    cwd,
    toolCall: { name: 'run_command', args: { CommandLine } }
  });

  it('a quoted -C path with a space still reaches the gate (staged conflict denies)', async () => {
    const { dir, git } = repoAt('dir with space');
    fs.writeFileSync(path.join(dir, 'c.txt'), CONFLICT);
    git('add c.txt');
    const elsewhere = path.join(tmpHome, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    const res = await evaluatePreToolGuards(cmdInput(elsewhere, `git -C "${dir}" commit -m "x"`));
    expect(res.decision).toBe('deny');
    const res2 = await evaluatePreToolGuards(cmdInput(elsewhere, `git -C '${dir}' commit -m "x"`));
    expect(res2.decision).toBe('deny');
  });

  it('a -c k=v global option with a quoted value does not hide the commit', async () => {
    const { dir, git } = repoAt('c-opt-repo');
    fs.writeFileSync(path.join(dir, 'c.txt'), CONFLICT);
    git('add c.txt');
    const res = await evaluatePreToolGuards(cmdInput(dir, 'git -c "user.name=a b" commit -m "x"'));
    expect(res.decision).toBe('deny');
  });

  it('env and VAR= prefixes do not hide the commit', async () => {
    const { dir, git } = repoAt('env-prefix-repo');
    fs.writeFileSync(path.join(dir, 'c.txt'), CONFLICT);
    git('add c.txt');
    expect((await evaluatePreToolGuards(cmdInput(dir, 'env GIT_AUTHOR_NAME=x git commit -m "x"'))).decision).toBe('deny');
    expect((await evaluatePreToolGuards(cmdInput(dir, 'GIT_AUTHOR_NAME=x git commit -m "x"'))).decision).toBe('deny');
  });

  it('a commit inside sh -c is still detected', async () => {
    const { dir, git } = repoAt('shell-c-repo');
    fs.writeFileSync(path.join(dir, 'c.txt'), CONFLICT);
    git('add c.txt');
    expect((await evaluatePreToolGuards(cmdInput(dir, `bash -c 'git commit -m "x"'`))).decision).toBe('deny');
  });

  it('commit text inside an echo is not a commit: no diff is taken and nothing is logged', async () => {
    const { dir, git } = repoAt('echo-repo');
    fs.writeFileSync(path.join(dir, 'c.txt'), CONFLICT);
    git('add c.txt');
    const res = await evaluatePreToolGuards(cmdInput(dir, `echo "run git commit -m later"`));
    expect(res.decision).toBe('allow');
    const log = path.join(jevConfigDir, 'antigravity_decisions.jsonl');
    expect(fs.existsSync(log)).toBe(false);
    expect(findGitCommit('echo "run git commit -m later"')).toBeNull();
    expect(findGitCommit('git -C "a b" commit -m x')?.dashC).toEqual(['a b']);
  });

  it('git add with a quoted -C path widens the commit to the working tree', async () => {
    const { dir, git } = repoAt('add dir with space');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add a.txt');
    git('commit -m init');
    fs.writeFileSync(path.join(dir, 'a.txt'), CONFLICT); // NOT staged
    expect(commandRunsGitAdd(`git -C "${dir}" add . && git -C "${dir}" commit -m x`)).toBe(true);
    expect(commitIncludesWorkingTree(`git -C "${dir}" add . && git -C "${dir}" commit -m x`)).toBe(true);
    expect(commitIncludesWorkingTree(`git -C "${dir}" commit -am x`)).toBe(true);
    expect(commitIncludesWorkingTree(`git -C "${dir}" commit -m "fix -a flag"`)).toBe(false);
    const res = await evaluatePreToolGuards(cmdInput(tmpHome, `git -C "${dir}" add . && git -C "${dir}" commit -m "x"`));
    expect(res.decision).toBe('deny');
  });
});

describe('write guard path normalisation (A6)', () => {
  let tmpHome = '';
  let origHome = '';
  let origConfig = '';
  let sessionsDir = '';
  let cwd = '';

  beforeEach(() => {
    clearConfigCacheForTesting();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-guards-a6-'));
    const jevDir = path.join(tmpHome, '.config', 'jev');
    sessionsDir = path.join(jevDir, 'antigravity-sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    cwd = path.join(tmpHome, 'ws');
    fs.mkdirSync(cwd, { recursive: true });
    origHome = process.env.HOME || '';
    origConfig = process.env.JEV_CONFIG_FILE || '';
    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(jevDir, 'config.json');
    fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on' }, harnesses: { antigravity: { writeGuard: { maxFiles: 1 } } } }));
  });
  afterEach(() => {
    clearConfigCacheForTesting();
    process.env.HOME = origHome;
    if (origConfig) process.env.JEV_CONFIG_FILE = origConfig;
    else delete process.env.JEV_CONFIG_FILE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const edit = (p: string, convId = 'c-a6') => ({
    conversationId: convId,
    cwd,
    modelName: 'gemini-3.8-flash-low',
    toolCall: { name: 'edit_file', args: { Path: p } }
  });

  it('src/a.ts, ./src/a.ts and <cwd>/src/a.ts are one file; a different file is the second', async () => {
    expect((await evaluatePreToolGuards(edit('src/a.ts'))).decision).toBe('allow');
    expect((await evaluatePreToolGuards(edit('./src/a.ts'))).decision).toBe('allow');
    expect((await evaluatePreToolGuards(edit(path.join(cwd, 'src', 'a.ts')))).decision).toBe('allow');
    expect((await evaluatePreToolGuards(edit('src/../src/a.ts'))).decision).toBe('allow');
    const streak = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'c-a6.write-guard.json'), 'utf8'));
    expect(streak.files).toEqual(['src/a.ts']);
    expect((await evaluatePreToolGuards(edit('src/b.ts'))).decision).toBe('deny');
  });

  it('the exempt check sees the normalised path: ./plans/x.md and <cwd>/plans/x.md are exempt', async () => {
    expect((await evaluatePreToolGuards(edit('src/a.ts', 'c-ex'))).decision).toBe('allow');
    expect((await evaluatePreToolGuards(edit('./plans/x.md', 'c-ex'))).decision).toBe('allow');
    expect((await evaluatePreToolGuards(edit(path.join(cwd, 'plans', 'x.md'), 'c-ex'))).decision).toBe('allow');
    const streak = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'c-ex.write-guard.json'), 'utf8'));
    expect(streak.files).toEqual(['src/a.ts']);
  });

  it('a workspace that sits under a directory named like an exempt path does not exempt everything', async () => {
    const underPlans = path.join(tmpHome, 'plans', 'proj');
    fs.mkdirSync(underPlans, { recursive: true });
    const e = (p: string) => ({ ...edit(p, 'c-anc'), cwd: underPlans });
    expect((await evaluatePreToolGuards(e('src/a.ts'))).decision).toBe('allow');
    expect((await evaluatePreToolGuards(e(path.join(underPlans, 'src', 'b.ts')))).decision).toBe('deny');
  });

  it('a path outside the workspace is kept absolute', async () => {
    const outside = path.join(tmpHome, 'other', 'z.ts');
    expect((await evaluatePreToolGuards(edit(outside, 'c-out'))).decision).toBe('allow');
    expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, 'c-out.write-guard.json'), 'utf8')).files).toEqual([outside]);
  });
});

describe('commit gate log rows carry the session id (A9)', () => {
  let tmpHome = '';
  let origHome = '';
  let origConfig = '';
  let jevConfigDir = '';

  beforeEach(() => {
    clearConfigCacheForTesting();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-guards-a9-'));
    jevConfigDir = path.join(tmpHome, '.config', 'jev');
    fs.mkdirSync(jevConfigDir, { recursive: true });
    origHome = process.env.HOME || '';
    origConfig = process.env.JEV_CONFIG_FILE || '';
    process.env.HOME = tmpHome;
    process.env.JEV_CONFIG_FILE = path.join(jevConfigDir, 'config.json');
    fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ defaults: { mode: 'on' } }));
  });
  afterEach(() => {
    clearConfigCacheForTesting();
    process.env.HOME = origHome;
    if (origConfig) process.env.JEV_CONFIG_FILE = origConfig;
    else delete process.env.JEV_CONFIG_FILE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const rows = (): Array<Record<string, unknown>> =>
    fs
      .readFileSync(path.join(jevConfigDir, 'antigravity_decisions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('an untracked git error row has session_id', async () => {
    const notRepo = path.join(tmpHome, 'not-a-repo');
    fs.mkdirSync(notRepo, { recursive: true });
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmpHome;
    try {
      await evaluatePreToolGuards({
        conversationId: 'c-a9-err',
        cwd: notRepo,
        toolCall: { name: 'run_command', args: { CommandLine: 'git add . && git commit -m x' } }
      });
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
    const gitErrors = rows().filter((r) => r.event === 'commit_gate' && r.outcome === 'git_error');
    expect(gitErrors.map((r) => r.stage ?? 'diff').sort()).toEqual(['diff', 'untracked']);
    for (const r of gitErrors) expect(r.session_id).toBe('c-a9-err');
  });

  it('an untracked_limit row has session_id', async () => {
    const repo = path.join(tmpHome, 'many');
    fs.mkdirSync(repo, { recursive: true });
    for (const cmd of ['init', 'config user.email t@example.com', 'config user.name T', 'config commit.gpgsign false']) {
      expect(Bun.spawnSync(['sh', '-c', `git ${cmd}`], { cwd: repo }).exitCode).toBe(0);
    }
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'x\n');
    Bun.spawnSync(['sh', '-c', 'git add seed.txt && git commit -m seed'], { cwd: repo });
    const dir = path.join(repo, 'bulk');
    fs.mkdirSync(dir);
    for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
    const res = await evaluatePreToolGuards({
      conversationId: 'c-a9-limit',
      cwd: repo,
      toolCall: { name: 'run_command', args: { CommandLine: 'git add . && git commit -m x' } }
    });
    expect(res.decision).toBe('allow');
    const limit = rows().filter((r) => r.outcome === 'untracked_limit');
    expect(limit).toHaveLength(1);
    expect(limit[0].session_id).toBe('c-a9-limit');
  });
});
