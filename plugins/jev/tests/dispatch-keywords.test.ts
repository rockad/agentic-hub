import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isFreeTierMechanicalTask,
  isReadOnlySubagent,
  taskNeedsEdit,
  editCapableSubagent
} from '../src/core/heuristics.ts';
import {
  classifyBatchTier,
  buildExecutionGuidance,
  ceilingModelForHarness,
  resolveEditCapableSubagent
} from '../src/tools/dispatch.ts';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');

/**
 * Whole-word tier rule. Documented choice: the keyword means formatting WORK, so the bare word
 * "format" does not count ("dump format decision" is a noun). Only scaffold*, boilerplate,
 * formatting, reformat*, auto-format, and "format <object>" (the, this, all, code, files, json ...) do.
 */
describe('free-tier keyword rule (whole words, documented phrase list)', () => {
  it('does not treat "information" as formatting work', () => {
    const tier = classifyBatchTier('Gather information about the storage layer');

    expect(tier).toBe('flash');
  });

  it('does not treat "transformation" as formatting work', () => {
    const tier = classifyBatchTier('Plan the data transformation for the import');

    expect(tier).toBe('flash');
  });

  it('does not treat "format" as a noun as formatting work: "apply a dump format decision"', () => {
    const tier = classifyBatchTier('Edit a spec to apply a dump format decision');

    expect(tier).toBe('flash');
  });

  it('keeps "scaffold a new package" on the free tier', () => {
    const tier = classifyBatchTier('Scaffold a new package for the bridge');

    expect(tier).toBe('openrouter_free');
  });

  it('keeps "write boilerplate" on the free tier', () => {
    const tier = classifyBatchTier('Write boilerplate for the CLI entry point');

    expect(tier).toBe('openrouter_free');
  });

  it('counts the phrase "format the" as formatting work', () => {
    expect(isFreeTierMechanicalTask('Format the changelog')).toBe(true);
  });

  it('counts "reformatting" and "formatting" as formatting work', () => {
    expect([isFreeTierMechanicalTask('Reformatting the tables'), isFreeTierMechanicalTask('Fix formatting in the README')]).toEqual([true, true]);
  });

  it('still routes explicit deep reasoning to pro', () => {
    const tier = classifyBatchTier('This needs deep reasoning about consistency');

    expect(tier).toBe('pro');
  });
});

describe('read-only personas never own an editing task', () => {
  it('knows Plan and Explore are read-only', () => {
    expect([isReadOnlySubagent('Plan'), isReadOnlySubagent('explore'), isReadOnlySubagent('general-purpose')]).toEqual([true, true, false]);
  });

  it('detects an editing task by whole-word verb', () => {
    expect([taskNeedsEdit('Update the tasklist and commit'), taskNeedsEdit('Find where the quota file is read')]).toEqual([true, false]);
  });

  it('swaps Plan for the fallback on an editing task', () => {
    const subagent = editCapableSubagent('Plan', 'Edit the plan document', 'general-purpose');

    expect(subagent).toBe('general-purpose');
  });

  it('keeps Plan on a pure planning task', () => {
    const subagent = editCapableSubagent('Plan', 'Design the storage approach', 'general-purpose');

    expect(subagent).toBe('Plan');
  });

  it('falls back to self outside Claude Code', () => {
    const subagent = resolveEditCapableSubagent('antigravity', 'Explore', 'Rewrite the notes');

    expect(subagent).toBe('self');
  });
});

describe('harness-aware dispatch text', () => {
  it('uses Agent(...) wording and the Claude model name in claude-code', () => {
    const out = buildExecutionGuidance('claude-code', false, 'code-engineer', 'sonnet');

    expect(out).toEqual({
      executionTool: 'Agent',
      executionGuidance:
        'Delegate via Agent(subagent_type: "code-engineer", model: "sonnet") or, inside a Workflow, agent({ agentType: "code-engineer", model: "sonnet" }).'
    });
  });

  it('says to handle it directly for self in claude-code', () => {
    const out = buildExecutionGuidance('claude-code', false, 'self', 'sonnet');

    expect(out.executionGuidance).toContain('directly');
  });

  it('uses no Gemini or invoke_subagent wording for a free task in claude-code', () => {
    const out = buildExecutionGuidance('claude-code', true, 'self', 'openrouter/free');

    expect(/Gemini|invoke_subagent/.test(out.executionGuidance)).toBe(false);
  });

  it('keeps the Antigravity wording in antigravity', () => {
    const out = buildExecutionGuidance('antigravity', false, 'code-engineer', 'flash');

    expect(out).toEqual({
      executionTool: 'invoke_subagent',
      executionGuidance: 'Delegate to subagent via invoke_subagent(Role: "code-engineer", Model: "flash").'
    });
  });

  it('keeps the Gemini quota wording for a free task in antigravity', () => {
    const out = buildExecutionGuidance('antigravity', true, 'self', 'openrouter/free');

    expect(out.executionGuidance).toContain('0 Gemini quota');
  });

  it('keeps the single-dispatch free wording when asked for it', () => {
    const out = buildExecutionGuidance('antigravity', true, 'self', 'openrouter/free', true);

    expect(out.executionGuidance).toContain('Jev evaluated this task as free-tier eligible');
  });

  it('has no Antigravity ceiling model in claude-code, and keeps it elsewhere', () => {
    expect([ceilingModelForHarness('claude-code', 'Gemini 3.8 Flash'), ceilingModelForHarness('antigravity', 'Gemini 3.8 Flash')]).toEqual([
      undefined,
      'Gemini 3.8 Flash'
    ]);
  });
});

/**
 * handleBatchDispatchTool end to end, in a child process with its own HOME (telemetry and the
 * quota file resolve from the home directory at import time) and keyword routing (no network).
 */
function runBatch(harness: string, tasks: unknown[], availableSubagents: string[]): any {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-batch-home-'));
  const cfg = path.join(home, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ routing: { strategy: 'keyword' } }));
  const script =
    "const m = await import('./src/tools/dispatch.ts');" +
    `const r = await m.handleBatchDispatchTool(${JSON.stringify({ tasks, availableSubagents })});` +
    'console.log(r.content[0].text);';
  const env = { PATH: process.env.PATH ?? '', HOME: home, JEV_HARNESS: harness, JEV_CONFIG_FILE: cfg };
  const proc = Bun.spawnSync(['bun', '-e', script], { cwd: PLUGIN_ROOT, env });
  return JSON.parse(proc.stdout.toString().trim());
}

describe('jev_batch_dispatch under a harness', () => {
  it('returns Agent(...) guidance and no ceiling clamp under claude-code', () => {
    const plan = runBatch('claude-code', [{ id: 'a', task: 'Implement the code engineer update to the parser' }], ['code-engineer']);

    expect(plan.tasks[0].executionGuidance).toBe(
      'Delegate via Agent(subagent_type: "code-engineer", model: "sonnet") or, inside a Workflow, agent({ agentType: "code-engineer", model: "sonnet" }).'
    );
  });

  it('never gives the read-only Plan persona an editing task under claude-code', () => {
    const plan = runBatch('claude-code', [{ id: 'a', task: 'Plan: edit the tasklist and update the plan' }], ['Plan']);

    expect(plan.tasks[0].subagent).toBe('general-purpose');
  });

  it('reports the Claude session model as unknown rather than the Antigravity model', () => {
    const plan = runBatch('claude-code', [{ id: 'a', task: 'Implement the update' }], []);

    expect(plan.activeSessionModel).toBe('unknown');
  });

  it('keeps invoke_subagent wording under antigravity', () => {
    const plan = runBatch('antigravity', [{ id: 'a', task: 'Implement the code engineer update to the parser' }], ['code-engineer']);

    expect(plan.tasks[0].executionTool).toBe('invoke_subagent');
  });

  it('puts the dump-format sentence on flash and the scaffold sentence on the free tier', () => {
    const plan = runBatch('claude-code', [
      { id: 'a', task: 'Edit a spec to apply a dump format decision' },
      { id: 'b', task: 'Scaffold a new package' }
    ], []);

    expect(plan.tasks.map((t: any) => t.tier)).toEqual(['flash', 'openrouter_free']);
  });
});
