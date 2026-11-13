/**
 * Parity audit: port of cognitive-engine PR #22 dispatch-keywords.test.ts (4.11 whole-word tier rule, read-only personas)
 * onto agentic-hub Jev 2.3.2. Note #22 says this file was itself ported from agentic-hub 2.3.1, so most of it should pass;
 * the failures are what #22 added (isFormattingTask, needsEdit on batch stages, edit-capable swap in single dispatch).
 *
 * Adaptations: core functions are read through a namespace import so a missing export fails one test, not the whole file.
 * The dispatch handlers run in a child process through tests/fixtures/run-dispatch.ts (copied from #22).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '../src/core/index.ts';
import { parseDispatch } from '../claude/logic.ts';
import { classifyBatchTier, resolveEditCapableSubagent } from '../src/tools/dispatch.ts';

const c = core as any;
const RUNNER = path.join(import.meta.dir, 'fixtures', 'run-dispatch.ts');
const MARKERS = ['JEV_HARNESS', 'ANTIGRAVITY_CLI', 'GEMINI_CLI', 'CORTEX_SESSION', 'CLAUDE_CODE', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'OPENCODE_SESSION', 'OPENCODE_HOME'];

describe('free-tier keyword rule (whole words, documented phrase list)', () => {
  it.each([
    ['Gather information about the storage layer'],
    ['Plan the data transformation for the import'],
    ['Edit a spec to apply a dump format decision'],
    ['Pick the output format for the report'],
    ['Check the platform conformance notes']
  ])('keeps %j on flash', (task) => {
    expect(classifyBatchTier(task)).toBe('flash');
  });

  it.each([
    ['Scaffold a new package for the bridge'],
    ['Write boilerplate for the CLI entry point'],
    ['Format the changelog'],
    ['Reformatting the tables'],
    ['Fix formatting in the README'],
    ['Please format this table'],
    ['Auto-format the sources'],
    ['format JSON'],
    ['Scaffolding the adapter']
  ])('sends %j to the free tier', (task) => {
    expect(classifyBatchTier(task)).toBe('openrouter_free');
  });

  it('still routes explicit deep reasoning to pro', () => {
    expect(classifyBatchTier('This needs deep reasoning about consistency')).toBe('pro');
  });

  it('does not treat substrings of other words as scaffold or boilerplate', () => {
    expect([c.isFreeTierMechanicalTask('The scaffoldless design'), c.isFreeTierMechanicalTask('boilerplates are fine')]).toEqual([false, false]);
  });

  it('shares the formatting forms with the effort heuristic, not the scaffold words', () => {
    expect([c.isFormattingTask('Format the changelog'), c.isFormattingTask('Scaffold a package')]).toEqual([true, false]);
  });
});

describe('every substring site uses the whole-word rule', () => {
  it('effort heuristic: "information" and a noun "format" stay medium', () => {
    const efforts = [
      c.defaultEffortForSubagent('information-desk', 'Review the user information endpoint'),
      c.defaultEffortForSubagent('code_engineer', 'Apply a dump format decision to the spec'),
      c.defaultEffortForSubagent('code_engineer', 'Format the changelog'),
      c.defaultEffortForSubagent('doc-formatter', 'Tidy it')
    ];

    expect(efforts).toEqual(['medium', 'medium', 'low', 'low']);
  });

  it('local pre-filter: a short "dump format" prompt is not free-tier, "format JSON" is', () => {
    const noun = c.evaluateLocalHeuristic('decide the dump format');
    const work = c.evaluateLocalHeuristic('format JSON indent 2');

    expect([noun, work?.tier]).toEqual([null, 'openrouter_free']);
  });

  it('scaffolding detector: whole word for scaffold and boilerplate, file names still match', () => {
    const results = [
      c.detectScaffoldingTask('Scaffolding the adapter').scaffoldFirst,
      c.detectScaffoldingTask('Write the boilerplate').scaffoldFirst,
      c.detectScaffoldingTask('Update package.json').scaffoldFirst,
      c.detectScaffoldingTask('Fix the scaffoldless design').scaffoldFirst
    ];

    expect(results).toEqual([true, true, true, false]);
  });
});

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-keywords-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function runHandler(harness: string, inputJson: { tool: 'batch' | 'single'; args: unknown; answers?: Record<string, string>; offline?: boolean }): any {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ routing: { strategy: 'keyword' } }));
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !MARKERS.includes(k) && !/KEY|TOKEN|SECRET/.test(k)) clean[k] = v;
  const proc = Bun.spawnSync(['bun', RUNNER], {
    stdin: new TextEncoder().encode(JSON.stringify(inputJson)),
    env: {
      ...clean,
      HOME: tmp,
      JEV_HARNESS: harness,
      JEV_CONFIG_FILE: path.join(tmp, 'config.json'),
      JEV_CACHE_FILE: path.join(tmp, 'cache.sqlite'),
      JEV_CLAUDE_STATE_DIR: path.join(tmp, 'state'),
      JEV_OPENROUTER_API_KEY: 'test-key'
    }
  });
  if (proc.exitCode !== 0) throw new Error(`runner failed: ${proc.stderr.toString()}`);
  return JSON.parse(proc.stdout.toString());
}

const runBatch = (harness: string, tasks: unknown[], availableSubagents: string[] = []): any =>
  runHandler(harness, { tool: 'batch', args: { tasks, availableSubagents }, offline: true });
const runSingle = (harness: string, args: { task: string }, answers: Record<string, string>): any => runHandler(harness, { tool: 'single', args, answers });

describe('jev_batch_dispatch tier rule end to end', () => {
  it.each(['claude-code', 'antigravity', 'opencode', 'cli'])('%s: the dump-format sentence is flash and the scaffold sentence is free', (harness) => {
    const plan = runBatch(harness, [
      { id: 'a', task: 'Edit a spec to apply a dump format decision' },
      { id: 'b', task: 'Scaffold a new package' },
      { id: 'c', task: 'Collect information about the transformation' }
    ]);

    expect(plan.tasks.map((t: any) => t.tier)).toEqual(['flash', 'openrouter_free', 'flash']);
  });
});

describe('read-only personas never own an editing task', () => {
  it('knows Plan and Explore are read-only, whatever the case', () => {
    expect([c.isReadOnlySubagent('Plan'), c.isReadOnlySubagent('explore'), c.isReadOnlySubagent('general-purpose'), c.isReadOnlySubagent('code-engineer')]).toEqual([true, true, false, false]);
  });

  it.each([
    ['Edit the tasklist'],
    ['Implement the parser'],
    ['Fix the quota bug'],
    ['Refactor the module'],
    ['Write the changelog entry'],
    ['Add a test for it'],
    ['Update the README'],
    ['Rename the field'],
    ['Migrate the table'],
    ['Delete the stale file'],
    ['Apply the patch'],
    ['Rewrite the intro']
  ])('%j is an editing task', (task) => {
    expect(c.taskNeedsEdit(task)).toBe(true);
  });

  it.each([
    ['Review the design'],
    ['Check the quota file'],
    ['Find where the quota file is read'],
    ['Explain how the guard works'],
    ['Summarise the plan'],
    ['Look at the written notes'],
    ['Create a picture of the flow'],
    ['Commit to a direction'],
    ['Outline the approach, no edits'],
    ['Plan it without writing anything'],
    ['Do not update the files, just read them']
  ])('%j is not an editing task (the verb list stays narrow)', (task) => {
    expect(c.taskNeedsEdit(task)).toBe(false);
  });

  it('swaps Plan for the fallback on an editing task and keeps it on a planning task', () => {
    expect([c.editCapableSubagent('Plan', 'Edit the plan document', 'general-purpose'), c.editCapableSubagent('Plan', 'Design the storage approach', 'general-purpose')]).toEqual(['general-purpose', 'Plan']);
  });

  it('leaves an editing-capable persona alone', () => {
    expect(c.editCapableSubagent('code-engineer', 'Edit the plan document', 'general-purpose')).toBe('code-engineer');
  });

  // Needs an owner decision, not a code change: #22 keeps the read-only persona outside Claude Code, the 2.3.1 test 'falls back to self outside Claude Code' (tests/dispatch-keywords.test.ts) pins the swap to self. Both cannot hold; 2.3.1 behaviour is kept.
  it.skip('resolveEditCapableSubagent swaps on Claude Code only', () => {
    const out = [resolveEditCapableSubagent('claude-code', 'Explore', 'Rewrite the notes'), resolveEditCapableSubagent('antigravity', 'Explore', 'Rewrite the notes')];

    expect(out).toEqual(['general-purpose', 'Explore']);
  });

  it('parseDispatch never returns Plan or Explore for an editing task', () => {
    const answer = (sa: string) => ({ answers: { recommendedSubagent: { choice: sa, confidence: 0.9 }, recommendedTier: { choice: 'flash', confidence: 0.9 } } });

    const out = [
      parseDispatch(answer('Plan'), 'Edit the tasklist and update the plan', 'unknown')?.subagent,
      parseDispatch(answer('Explore'), 'Find where the quota file is read', 'unknown')?.subagent
    ];

    expect(out).toEqual(['general-purpose', 'Explore']);
  });

  it('batch dispatch on Claude Code gives Plan no editing task, even without needsEdit', () => {
    const plan = runBatch('claude-code', [{ id: 'a', task: 'Plan: edit the tasklist and update the plan' }], ['Plan']);

    expect(['general-purpose', 'self']).toContain(plan.tasks[0].subagent);
  });

  it('batch dispatch honours needsEdit: false over the wording', () => {
    const plan = runBatch('claude-code', [{ id: 'a', task: 'Plan how to update the tasklist', needsEdit: false }], ['Plan']);

    expect(plan.tasks[0].subagent).toBe('Plan');
  });

  it('single dispatch on Claude Code swaps Plan for general-purpose on an editing task', () => {
    const res = runSingle('claude-code', { task: 'Edit the plan document', availableSubagents: ['Plan'] } as any, { recommendedSubagent: 'Plan', recommendedTier: 'flash' });

    expect(res.recommendedSubagent).toBe('general-purpose');
    expect(res.executionGuidance).toContain('Agent(subagent_type: "general-purpose", model: "sonnet")');
  });

  // Same owner decision as above (the 'self' fallback outside Claude Code); the batch schema release leaves non-Claude harnesses as they were.
  it.skip('single dispatch outside Claude Code is unchanged', () => {
    const res = runSingle('antigravity', { task: 'Edit the plan document', availableSubagents: ['Plan'] } as any, { recommendedSubagent: 'Plan', recommendedTier: 'flash' });

    expect(res.recommendedSubagent).toBe('Plan');
  });
});
