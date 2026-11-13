/**
 * Parity audit: port of cognitive-engine PR #22 dispatch-harness.test.ts (5.4, 5.11) onto agentic-hub Jev 2.3.2.
 *
 * Adaptations: #22's dispatchStyle() (tools/harness.ts) is buildExecutionGuidance() here. The stored Claude session model
 * is written where agentic-hub's hook writes it (HOME/.config/jev/claude-sessions/<id>.json) so a tool that reads it would
 * find it; the child process gets HOME=tmp and CLAUDE_CODE_SESSION_ID.
 *
 * NOT PORTABLE (modules absent in agentic-hub: src/claude-active-session.ts, src/session-model.ts, src/tools/harness.ts,
 * and helpers claudeCeiling/escalationNote/claudeKeywordTier in tools/dispatch.ts):
 *  - 'session model for the tools (5.11)': reads the model of the session named in the environment; is unknown without a
 *    session id; finds the transcript of a session under the config dir; turns a model into the tier it can run itself
 *  - 'reports the ceiling on Claude Code and never lowers the tier' (claudeCeiling/escalationNote unit assertions)
 *  - 'claudeKeywordTier' table (6 cases; its behaviour is covered by parity-dispatch-keywords classifyBatchTier cases)
 *  - the freeTierCriteria assertion of 'keeps the Antigravity wording verbatim' (tier criteria are inline in the handler)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildExecutionGuidance } from '../src/tools/dispatch.ts';

const RUNNER = path.join(import.meta.dir, 'fixtures', 'run-dispatch.ts');
const MARKERS = ['JEV_HARNESS', 'ANTIGRAVITY_CLI', 'GEMINI_CLI', 'CORTEX_SESSION', 'CLAUDE_CODE', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'OPENCODE_SESSION', 'OPENCODE_HOME'];

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-dispatch-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function runTool(harness: string, inputJson: { tool: 'batch' | 'single'; args: unknown; answers?: Record<string, string>; offline?: boolean }, env: Record<string, string> = {}): any {
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
      JEV_OPENROUTER_API_KEY: 'test-key',
      ...env
    }
  });
  if (proc.exitCode !== 0) throw new Error(`runner failed: ${proc.stderr.toString()}`);
  return JSON.parse(proc.stdout.toString());
}

/** Store the session model both where #22 reads it (JEV_CLAUDE_STATE_DIR) and where agentic-hub's hook writes it. */
const claudeEnv = () => {
  const body = JSON.stringify({ model: 'claude-sonnet-5-5', updated_at: new Date().toISOString() }) + '\n';
  for (const dir of [path.join(tmp, 'state'), path.join(tmp, '.config', 'jev', 'claude-sessions')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-x.json'), body);
  }
  return { CLAUDE_CODE_SESSION_ID: 'sess-x' };
};

const stages = (extra: Record<string, unknown> = {}) => ({
  tasks: [
    { id: 'ws1', task: 'Record the decision that reverses the storage choice', kind: 'judgement', needsEdit: true },
    { id: 'ws2', task: 'Fold the settled decisions into the spec', kind: 'settled-edit', needsEdit: true },
    { id: 'ws3', task: 'Tick the boxes in the master tasklist', kind: 'mechanical', needsEdit: true }
  ],
  ...extra
});

describe('harness style table (5.11), via buildExecutionGuidance', () => {
  it('keeps the Antigravity wording verbatim for antigravity, opencode and cli', () => {
    for (const h of ['antigravity', 'opencode', 'cli'] as const) {
      expect(buildExecutionGuidance(h, false, 'code_engineer', 'flash').executionGuidance).toBe('Delegate to subagent via invoke_subagent(Role: "code_engineer", Model: "flash").');
      expect(buildExecutionGuidance(h, true, 'x', 'y', true).executionGuidance).toBe(
        'CRITICAL QUOTA RULE: Jev evaluated this task as free-tier eligible. Do NOT call invoke_subagent. Execute directly via jev_execute_free or jev_agent_free at $0.00 cost (0 Gemini quota).'
      );
      expect(buildExecutionGuidance(h, true, 'x', 'y', false).executionGuidance).toBe(
        'CRITICAL QUOTA RULE: Free-tier eligible. Do NOT call invoke_subagent. Execute directly via jev_execute_free or jev_agent_free at $0.00 cost (0 Gemini quota).'
      );
    }
  });

  it('speaks Agent() and agent() on Claude Code, with no Antigravity vocabulary', () => {
    const text = [
      buildExecutionGuidance('claude-code', false, 'code-engineer', 'sonnet').executionGuidance,
      buildExecutionGuidance('claude-code', true, 'x', 'y', true).executionGuidance,
      buildExecutionGuidance('claude-code', true, 'x', 'y', false).executionGuidance
    ].join(' ');

    expect(text).toContain('Agent(subagent_type: "code-engineer", model: "sonnet")');
    expect(text).toContain('agent({ agentType: "code-engineer", model: "sonnet" })');
    expect(text).not.toMatch(/invoke_subagent|Gemini/);
  });

  it('maps the self persona to general-purpose on Claude Code', () => {
    expect(buildExecutionGuidance('claude-code', false, 'self', 'haiku').executionGuidance).toContain('subagent_type: "general-purpose"');
  });
});

describe('jev_batch_dispatch on Claude Code (5.4, 5.11)', () => {
  it('maps judgement, settled-edit and mechanical stages to opus, sonnet and haiku', () => {
    const plan = runTool('claude-code', { tool: 'batch', args: stages() }, claudeEnv());

    expect(plan.tasks.map((t: any) => [t.taskId, t.tier, t.concreteModel, t.tierSource])).toEqual([
      ['ws1', 'pro', 'opus', 'kind'],
      ['ws2', 'flash', 'sonnet', 'kind'],
      ['ws3', 'flash_lite', 'haiku', 'kind']
    ]);
  });

  it('returns Agent() guidance and the stored session model, not the Antigravity ones', () => {
    const plan = runTool('claude-code', { tool: 'batch', args: stages() }, claudeEnv());

    expect(plan.activeSessionModel).toBe('claude-sonnet-5-5');
    for (const t of plan.tasks) {
      expect(t.executionTool).toBe('Agent');
      expect(t.executionGuidance).toContain('Agent(subagent_type:');
      expect(t.executionGuidance).not.toContain('invoke_subagent');
    }
  });

  it('flags opus as above the session model instead of clamping it away', () => {
    const plan = runTool('claude-code', { tool: 'batch', args: stages() }, claudeEnv());

    const [opus, sonnet] = plan.tasks;
    expect([opus.requiresUserApproval, sonnet.requiresUserApproval]).toEqual([true, false]);
    expect(opus.executionGuidance).toContain('Opus is above the session model (claude-sonnet-5-5)');
    expect(plan.requiresUserApproval).toBe(true);
  });

  it('reports an unknown session model as unknown', () => {
    const plan = runTool('claude-code', { tool: 'batch', args: stages() }, { CLAUDE_CODE_SESSION_ID: 'no-such-session' });

    expect(plan.activeSessionModel).toBe('unknown');
  });

  it('never gives an edit stage a read-only persona, even when the router picks one', () => {
    const args = {
      availableSubagents: ['Plan'],
      tasks: [
        { id: 'a', task: 'Rewrite the plan document', kind: 'settled-edit', needsEdit: true },
        { id: 'b', task: 'Outline the approach, no edits', kind: 'settled-edit' }
      ]
    };

    const plan = runTool('claude-code', { tool: 'batch', args, answers: { sa_a: 'Plan', sa_b: 'Plan' } }, claudeEnv());

    const [a, b] = plan.tasks;
    expect(['Plan', 'Explore']).not.toContain(a.subagent);
    expect(b.subagent).toBe('Plan');
  });

  it('asks the router for the tier of a stage with no kind, under the rubric', () => {
    const args = { tasks: [{ id: 'a', task: 'Reconcile two disagreeing designs' }] };

    const plan = runTool('claude-code', { tool: 'batch', args, answers: { tier_a: 'pro' } }, claudeEnv());

    expect([plan.tasks[0].tier, plan.tasks[0].tierSource]).toEqual(['pro', 'router']);
  });

  it('falls back to whole-word keywords offline, so "information" is not formatting', () => {
    const args = { tasks: [{ id: 'a', task: 'Collect the information and transformation notes' }] };

    const plan = runTool('claude-code', { tool: 'batch', args, offline: true }, claudeEnv());

    expect([plan.tasks[0].tier, plan.tasks[0].tierSource]).toEqual(['flash', 'keyword']);
  });

  it('keeps a needsEdit stage off the free tier', () => {
    const args = { tasks: [{ id: 'a', task: 'Scaffold the boilerplate files', needsEdit: true }, { id: 'b', task: 'Scaffold the boilerplate files' }] };

    const plan = runTool('claude-code', { tool: 'batch', args, offline: true }, claudeEnv());

    expect(plan.tasks.map((t: any) => t.tier)).toEqual(['flash_lite', 'openrouter_free']);
    expect(plan.tasks[1].executionTool).toBe('jev_execute_free');
    expect(plan.tasks[1].executionGuidance).not.toContain('Gemini');
  });

  it('keeps a stage whose wording says it edits off the free tier, unless needsEdit is false', () => {
    const task = 'Scaffold the boilerplate files and update the README';
    const args = { tasks: [{ id: 'a', task }, { id: 'b', task, needsEdit: false }] };

    const plan = runTool('claude-code', { tool: 'batch', args, offline: true }, claudeEnv());

    expect(plan.tasks.map((t: any) => t.tier)).toEqual(['flash_lite', 'openrouter_free']);
    expect(plan.tasks[0].executionTool).not.toBe('jev_execute_free');
  });

  it('offers the router only real subagent types', () => {
    const args = { tasks: [{ id: 'a', task: 'Write it', kind: 'mechanical' }] };

    const plan = runTool('claude-code', { tool: 'batch', args, answers: { sa_a: 'general-purpose' } }, claudeEnv());

    expect(plan.tasks[0].subagent).toBe('general-purpose');
  });
});

describe('Antigravity and OpenCode are unchanged (5.11)', () => {
  it.each(['antigravity', 'opencode', 'cli'])('%s batch keeps invoke_subagent, the keyword tier and no Claude fields', (harness) => {
    const args = {
      availableSubagents: ['Plan', 'self'],
      tasks: [
        { id: 'a', task: 'Scaffold the notes', kind: 'judgement', needsEdit: true },
        { id: 'b', task: 'Tidy the rest' }
      ]
    };

    const plan = runTool(harness, { tool: 'batch', args, answers: { sa_a: 'Plan', sa_b: 'self' } }, claudeEnv());

    const [a, b] = plan.tasks;
    expect([a.tier, a.executionTool]).toEqual(['openrouter_free', 'jev_execute_free']);
    expect(a.executionGuidance).toBe(
      'CRITICAL QUOTA RULE: Free-tier eligible. Do NOT call invoke_subagent. Execute directly via jev_execute_free or jev_agent_free at $0.00 cost (0 Gemini quota).'
    );
    expect([b.tier, b.executionTool]).toEqual(['flash', 'invoke_subagent']);
    expect(b.executionGuidance).toBe(`Delegate to subagent via invoke_subagent(Role: "${b.subagent}", Model: "${b.concreteModel}").`);
    for (const t of plan.tasks) expect(['kind', 'needsEdit', 'tierSource'].filter((k) => k in t)).toEqual([]);
    expect(plan.activeSessionModel).toBe('unknown');
  });

  it.each(['antigravity', 'opencode', 'cli'])('%s single dispatch keeps invoke_subagent and has no Claude session field', (harness) => {
    const res = runTool(harness, { tool: 'single', args: { task: 'Design the storage layer' }, answers: { recommendedSubagent: 'self', recommendedTier: 'pro' } }, claudeEnv());

    expect(res.executionTool).toBe('invoke_subagent');
    expect(res.executionGuidance).toBe(`Delegate to subagent via invoke_subagent(Role: "self", Model: "${res.concreteModel}").`);
    expect('activeSessionModel' in res).toBe(false);
  });

  it('Antigravity still clamps to the quota file model, which Claude Code does not read', () => {
    fs.mkdirSync(path.join(tmp, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.gemini', 'antigravity-cli', 'quota-state.json'),
      JSON.stringify({ schema: 2, buckets: {}, active_model: 'flash', updated_at: Math.floor(Date.now() / 1000) })
    );
    const args = { task: 'Design the storage layer' };
    const answers = { recommendedSubagent: 'self', recommendedTier: 'pro' };

    const agy = runTool('antigravity', { tool: 'single', args, answers });
    const claude = runTool('claude-code', { tool: 'single', args, answers }, claudeEnv());

    expect([agy.wasClampedByCeiling, agy.recommendedTier]).toEqual([true, 'flash']);
    expect([claude.wasClampedByCeiling, claude.recommendedTier]).toEqual([false, 'pro']);
  });
});

describe('jev_dispatch on Claude Code (5.11)', () => {
  it('returns Agent() guidance, the session model and an opus escalation note', () => {
    const res = runTool('claude-code', { tool: 'single', args: { task: 'Reconcile two disagreeing designs' }, answers: { recommendedSubagent: 'self', recommendedTier: 'pro' } }, claudeEnv());

    expect(res.executionTool).toBe('Agent');
    expect(res.executionGuidance).toContain('Agent(subagent_type: "general-purpose", model: "opus")');
    expect(res.executionGuidance).toContain('the Jev guard will ask the user once');
    expect(res.activeSessionModel).toBe('claude-sonnet-5-5');
    expect([res.wasClampedByCeiling, res.requiresUserApproval]).toEqual([false, true]);
  });
});
