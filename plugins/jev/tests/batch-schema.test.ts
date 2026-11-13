/**
 * The batch schema release: optional `kind` and `needsEdit` on jev_batch_dispatch stages, the stage rubric, and the
 * `editsFiles` free-tier guard (the caller's flag, else the wording). Complements the ported parity-*.test.ts cases.
 * Handlers run in a child process (tests/fixtures/run-dispatch.ts) with their own HOME and a stubbed Decisions API.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { batchDispatchToolDefinition } from '../src/tools/dispatch.ts';
import { STAGE_RUBRIC, STAGE_KINDS, isStageKind, STAGE_RUBRIC_TEXT } from '../src/stage-rubric.ts';
import { preflightReminder } from '../claude/logic.ts';

const RUNNER = path.join(import.meta.dir, 'fixtures', 'run-dispatch.ts');
const MARKERS = ['JEV_HARNESS', 'ANTIGRAVITY_CLI', 'GEMINI_CLI', 'CORTEX_SESSION', 'CLAUDE_CODE', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'OPENCODE_SESSION', 'OPENCODE_HOME'];

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-batch-schema-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(harness: string, input: { tool: 'batch' | 'single'; args: unknown; answers?: Record<string, string>; offline?: boolean }): any {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !MARKERS.includes(k) && !/KEY|TOKEN|SECRET/.test(k)) clean[k] = v;
  const proc = Bun.spawnSync(['bun', RUNNER], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: {
      ...clean,
      HOME: tmp,
      JEV_HARNESS: harness,
      JEV_CONFIG_FILE: path.join(tmp, 'config.json'),
      JEV_CACHE_FILE: path.join(tmp, 'cache.sqlite'),
      JEV_OPENROUTER_API_KEY: 'test-key'
    }
  });
  if (proc.exitCode !== 0) throw new Error(`runner failed: ${proc.stderr.toString()}`);
  return JSON.parse(proc.stdout.toString());
}

describe('stage rubric table (5.3)', () => {
  it('maps the three kinds to haiku, sonnet and opus', () => {
    expect(STAGE_KINDS.map((k) => [k, STAGE_RUBRIC[k].tier, STAGE_RUBRIC[k].model])).toEqual([
      ['mechanical', 'flash_lite', 'haiku'],
      ['settled-edit', 'flash', 'sonnet'],
      ['judgement', 'pro', 'opus']
    ]);
  });

  it('recognises a stage kind and nothing else', () => {
    expect([isStageKind('judgement'), isStageKind('Judgement'), isStageKind('toString'), isStageKind(undefined)]).toEqual([true, false, false, false]);
  });

  it('puts all three rule lines into the one-sentence rubric', () => {
    for (const k of STAGE_KINDS) expect(STAGE_RUBRIC_TEXT).toContain(STAGE_RUBRIC[k].rule);
  });
});

describe('batch tool schema (5.4)', () => {
  const item = (batchDispatchToolDefinition.inputSchema as any).properties.tasks.items;

  it('adds kind and needsEdit as optional fields of a task', () => {
    expect(item.properties.kind.enum).toEqual(['mechanical', 'settled-edit', 'judgement']);
    expect(item.properties.needsEdit.type).toBe('boolean');
    expect(item.required).toEqual(['id', 'task']);
  });
});

describe('staged-work reminder names the new fields', () => {
  it('describes kind and needsEdit in the pre-flight reminder', () => {
    const text = preflightReminder('Agent');

    expect(text).toContain('kind: mechanical | settled-edit | judgement');
    expect(text).toContain('needsEdit: true when the stream edits files');
  });
});

describe('jev_batch_dispatch output with the new fields absent', () => {
  const KEYS = [
    'taskId', 'task', 'subagent', 'tier', 'cognitiveTier', 'concreteModel', 'executionTool', 'executionGuidance',
    'dependencies', 'canRunParallel', 'scaffoldFirst', 'boilerplateType', 'effort', 'requiresUserApproval', 'estimatedCostUsd'
  ];

  it.each(['antigravity', 'opencode', 'cli'])('%s tasks keep exactly the 2.3.x keys, even when kind and needsEdit are sent', (harness) => {
    const tasks = [{ id: 'a', task: 'Tidy the notes' }, { id: 'b', task: 'Tidy the rest', kind: 'judgement', needsEdit: true }];

    const plan = run(harness, { tool: 'batch', args: { tasks }, offline: true });

    for (const t of plan.tasks) expect(Object.keys(t)).toEqual(KEYS);
  });

  it('claude-code adds kind and needsEdit to a task only when the caller sent them', () => {
    const tasks = [{ id: 'a', task: 'Tidy the notes' }, { id: 'b', task: 'Tidy the rest', kind: 'mechanical', needsEdit: false }];

    const plan = run('claude-code', { tool: 'batch', args: { tasks }, offline: true });

    const [a, b] = plan.tasks;
    expect(['kind' in a, 'needsEdit' in a]).toEqual([false, false]);
    expect([b.kind, b.needsEdit]).toEqual(['mechanical', false]);
  });

  it('claude-code ignores an unknown kind and falls back to the router and keywords', () => {
    const tasks = [{ id: 'a', task: 'Tidy the notes', kind: 'bogus' }];

    const plan = run('claude-code', { tool: 'batch', args: { tasks }, offline: true });

    expect([plan.tasks[0].tierSource, 'kind' in plan.tasks[0]]).toEqual(['keyword', false]);
  });
});

describe('editsFiles guard on the free tier (caller flag, else the wording)', () => {
  it('batch: a wording-only edit stage ("Remove the stale boilerplate files") is not sent to jev_execute_free', () => {
    const tasks = [{ id: 'a', task: 'Remove the stale boilerplate files' }, { id: 'b', task: 'Remove the stale boilerplate files', needsEdit: false }];

    const plan = run('claude-code', { tool: 'batch', args: { tasks }, offline: true });

    expect(plan.tasks.map((t: any) => [t.tier, t.executionTool])).toEqual([['flash_lite', 'Agent'], ['openrouter_free', 'jev_execute_free']]);
  });

  it('batch: a stage that only reads stays free', () => {
    const plan = run('claude-code', { tool: 'batch', args: { tasks: [{ id: 'a', task: 'Scaffold the boilerplate notes' }] }, offline: true });

    expect(plan.tasks[0].tier).toBe('openrouter_free');
  });

  const router = { recommendedSubagent: 'self', recommendedTier: 'openrouter_free' };

  it('single: an edit-wording task rated free goes to flash_lite and a delegation on Claude Code', () => {
    const res = run('claude-code', { tool: 'single', args: { task: 'Scaffold the boilerplate files and update the README' }, answers: router });

    expect([res.recommendedTier, res.rawRecommendedTier, res.executionTool]).toEqual(['flash_lite', 'openrouter_free', 'Agent']);
    expect(res.concreteModel).toBe('haiku');
  });

  it('single: a task with no edit wording stays free on Claude Code, and says it cannot edit files', () => {
    const res = run('claude-code', { tool: 'single', args: { task: 'Scaffold the boilerplate notes' }, answers: router });

    expect([res.recommendedTier, res.executionTool]).toEqual(['openrouter_free', 'jev_execute_free']);
    expect(res.executionGuidance).toContain('cannot edit files');
  });

  it('single: Antigravity is unchanged and keeps the free tier for the same wording', () => {
    const res = run('antigravity', { tool: 'single', args: { task: 'Scaffold the boilerplate files and update the README' }, answers: router });

    expect([res.recommendedTier, res.executionTool]).toEqual(['openrouter_free', 'jev_execute_free']);
  });
});
