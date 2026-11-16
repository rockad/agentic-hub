import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluatePreToolGuards,
  parseEpoch,
  computeLastDispatchEpoch,
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
