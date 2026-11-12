import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  modelRank,
  parseDispatch,
  buildDirective,
  decideAgentCall,
  safeSessionId,
  resolveClaudeSubagentCriteria,
  CLAUDE_SUBAGENT_CRITERIA,
  type Dispatch
} from '../claude/logic.ts';
import { onUserPromptSubmit, onPreToolUse, type HookDeps } from '../claude/hook.ts';
import { memoryClaim } from './elevation-helpers.ts';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');

const flashRec: Dispatch = { subagent: 'Explore', tier: 'flash', model: 'sonnet', effort: 'medium', confidence: 0.9 };
const proRec: Dispatch = { subagent: 'general-purpose', tier: 'pro', model: 'opus', effort: 'high', confidence: 0.8 };

function deps(overrides: Partial<HookDeps> = {}): HookDeps {
  return {
    readMode: async () => 'on',
    readSessionModel: () => 'claude-sonnet-5',
    readQuotaStrategy: async () => 'unknown',
    dispatch: async () => flashRec,
    log: () => {},
    claimClamp: memoryClaim(),
    ...overrides
  };
}

describe('modelRank', () => {
  it('ranks opus above sonnet', () => {
    const opus = modelRank('claude-opus-5-5');

    const sonnet = modelRank('sonnet');

    expect(opus! > sonnet!).toBe(true);
  });

  it('treats "inherit" as unknown', () => {
    const rank = modelRank('inherit');

    expect(rank).toBeNull();
  });
});

describe('parseDispatch', () => {
  it('maps the pro tier to opus', () => {
    const data = { answers: { recommendedSubagent: { choice: 'Plan' }, recommendedTier: { choice: 'pro' } } };

    const rec = parseDispatch(data, 'Design the storage layer', 'normal');

    expect(rec?.model).toBe('opus');
  });

  it('falls back to self for a subagent Claude Code does not have', () => {
    const data = { answers: { recommendedSubagent: { choice: 'vault_librarian' }, recommendedTier: { choice: 'flash' } } };

    const rec = parseDispatch(data, 'Tidy the notes folder', 'normal');

    expect(rec?.subagent).toBe('self');
  });

  it('returns null when Jev sent no answers', () => {
    const data = { error: 'upstream' };

    const rec = parseDispatch(data, 'Anything at all', 'normal');

    expect(rec).toBeNull();
  });
});

describe('buildDirective', () => {
  it('names the session model as the ceiling', () => {
    const directive = buildDirective(flashRec, 'claude-sonnet-5', 'unknown');

    expect(directive).toContain('"claude-sonnet-5" is the hard ceiling');
  });

  it('asks for a user choice on the pro tier', () => {
    const directive = buildDirective(proRec, null, 'normal');

    expect(directive).toContain('let the user choose');
  });
});

describe('decideAgentCall', () => {
  it('asks when the delegation requests a stronger model than the session', () => {
    const call = { model: 'opus', prompt: 'Refactor the parser' };

    const verdict = decideAgentCall(call, 'claude-sonnet-5');

    expect(verdict?.decision).toBe('ask');
  });

  it('lets a cheaper model through', () => {
    const call = { model: 'haiku', prompt: 'List the files' };

    const verdict = decideAgentCall(call, 'claude-opus-5-5');

    expect(verdict).toBeNull();
  });

  it('lets an inherited model through', () => {
    const call = { prompt: 'List the files' };

    const verdict = decideAgentCall(call, 'claude-sonnet-5');

    expect(verdict).toBeNull();
  });
});

describe('PreToolUse never turns a tier rating into a permission dialog (case study 2026-11-11)', () => {
  // The turn state the UserPromptSubmit hook would have stored: a pro rating for the user's prompt.
  const proTurn = { turn: 't1', intent: { models: [] }, rec: { subagent: 'code-engineer', tier: 'pro' as const, model: 'opus' as const } };
  const agentCall = (model?: string) => ({
    session_id: 's1',
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'code-engineer',
      description: 'WS1: build the handoff skill',
      prompt: 'Build the skill. Design is final. Verify before reporting.',
      ...(model ? { model } : {})
    }
  });

  it('lets a call pinned to the session model through, whatever the rating', async () => {
    const out = await onPreToolUse(agentCall('sonnet'), deps({ readTurn: () => proTurn, dispatch: async () => proRec }));

    expect(out).toBeNull();
  });

  it('lets a call pinned below the session model through', async () => {
    const out = await onPreToolUse(agentCall('haiku'), deps({ readTurn: () => proTurn, dispatch: async () => proRec }));

    expect(out).toBeNull();
  });

  it('lets a call with no model through (it runs on the session model)', async () => {
    const out = await onPreToolUse(agentCall(), deps({ readTurn: () => proTurn, dispatch: async () => proRec }));

    expect(out).toBeNull();
  });

  it('does not send the delegation brief to Jev', async () => {
    let dispatchCalls = 0;
    const counting = deps({
      readTurn: () => proTurn,
      dispatch: async () => {
        dispatchCalls += 1;
        return proRec;
      }
    });

    await onPreToolUse(agentCall('sonnet'), counting);

    expect(dispatchCalls).toBe(0);
  });

  it('logs the prompt-time recommendation next to the model the call asked for', async () => {
    const entries: Array<Record<string, unknown>> = [];

    await onPreToolUse(agentCall('sonnet'), deps({ readTurn: () => proTurn, log: (e) => entries.push(e as Record<string, unknown>) }));

    expect(entries[0]).toMatchObject({ tier: 'pro', recommended_model: 'opus', requested_model: 'sonnet', reason: null });
  });

  // 2.3.4: the first elevating call of a prompt is clamped; the dialog is for the repeat. These two
  // asserted the dialog on the first call (2.3.2/2.3.3) and now make the call twice.
  it('still asks for a repeated model above the ceiling, and says what No does', async () => {
    const d = deps({ readTurn: () => proTurn });
    await onPreToolUse(agentCall('opus'), d);

    const out = await onPreToolUse(agentCall('opus'), d);

    expect(String(out?.hookSpecificOutput.permissionDecisionReason)).toContain('No cancels the delegation');
  });

  it('does not tell a rejected delegation to be retried on a cheaper model by itself', async () => {
    const d = deps({ readTurn: () => proTurn });
    await onPreToolUse(agentCall('opus'), d);

    const out = await onPreToolUse(agentCall('opus'), d);

    expect(String(out?.hookSpecificOutput.permissionDecisionReason)).not.toContain('deny and re-run');
  });
});

describe('safeSessionId', () => {
  it('strips path characters', () => {
    const id = safeSessionId('../../etc/passwd');

    expect(id).toBe('etcpasswd');
  });
});

describe('onUserPromptSubmit', () => {
  it('injects the directive as additionalContext in mode on', async () => {
    const input = { session_id: 's1', prompt: 'Find where the quota file is written' };

    const out = await onUserPromptSubmit(input, deps());

    expect(String(out?.hookSpecificOutput.additionalContext)).toContain('[JEV]');
  });

  it('stays silent in mode on-demand', async () => {
    const input = { session_id: 's1', prompt: 'Find where the quota file is written' };

    const out = await onUserPromptSubmit(input, deps({ readMode: async () => 'on-demand' }));

    expect(out).toBeNull();
  });

  it('stays silent when Jev is unreachable', async () => {
    const input = { session_id: 's1', prompt: 'Find where the quota file is written' };

    const out = await onUserPromptSubmit(input, deps({ dispatch: async () => null }));

    expect(out).toBeNull();
  });
});

describe('onPreToolUse', () => {
  // 2.3.4: was "returns an ask decision for an Agent call above the ceiling" on the first call.
  it('returns an ask decision for a repeated Agent call above the ceiling', async () => {
    const input = { session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', tool_input: { model: 'opus', prompt: 'Refactor the parser' } };
    const d = deps();
    await onPreToolUse(input, d);

    const out = await onPreToolUse(input, d);

    expect(out?.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('ignores tools other than Agent', async () => {
    const input = { session_id: 's1', tool_name: 'Bash', tool_input: { model: 'opus' } };

    const out = await onPreToolUse(input, deps());

    expect(out).toBeNull();
  });
});

describe('hook process', () => {
  it('exits 0 and prints nothing on malformed stdin', () => {
    const stdin = new TextEncoder().encode('not json');

    const proc = Bun.spawnSync(['bun', path.join(PLUGIN_ROOT, 'claude/hook.ts'), 'user-prompt-submit'], { stdin });

    expect([proc.exitCode, proc.stdout.toString()]).toEqual([0, '']);
  });
});

describe('plugin manifest', () => {
  it('points Claude Code at the hooks file', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8'));
    // Claude Code reads hooks/hooks.json by default, or the path in the manifest's "hooks" field.
    const hooksFile = path.join(PLUGIN_ROOT, manifest.hooks ?? 'hooks/hooks.json');

    const events = fs.existsSync(hooksFile) ? Object.keys(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks) : [];

    expect(events).toContain('SessionStart');
  });
});

describe('custom agent discovery and dispatch in Claude Code', () => {
  it('discovers custom workspace agents and merges with Claude built-ins', async () => {
    const fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jev-claude-agents-'));
    try {
      const agentsDir = path.join(fixtureDir, '.agents', 'agents');
      await fs.promises.mkdir(agentsDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(agentsDir, 'code_engineer.md'),
        '---\nname: code_engineer\ndescription: "Software engineering and automation specialist"\n---\n# Code Engineer'
      );
      await fs.promises.writeFile(
        path.join(agentsDir, 'career_advisor.md'),
        '---\nname: career_advisor\ndescription: "Executive career partner"\n---\n# Career Advisor'
      );

      const criteria = await resolveClaudeSubagentCriteria(fixtureDir);
      expect(criteria.Explore).toBeDefined();
      expect(criteria.Plan).toBeDefined();
      expect(criteria['general-purpose']).toBeDefined();
      expect(criteria.self).toBeDefined();
      expect(criteria.code_engineer).toBe('Software engineering and automation specialist');
      expect(criteria.career_advisor).toBe('Executive career partner');
    } finally {
      await fs.promises.rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it('parses custom personas in dispatch when criteria includes them', () => {
    const data = {
      answers: {
        recommendedSubagent: { choice: 'code_engineer' },
        recommendedTier: { choice: 'flash' }
      }
    };
    const criteria = {
      ...CLAUDE_SUBAGENT_CRITERIA,
      code_engineer: 'Software engineering specialist'
    };

    const rec = parseDispatch(data, 'Refactor the data pipeline', 'normal', criteria);

    expect(rec?.subagent).toBe('code_engineer');
    expect(rec?.model).toBe('sonnet');
    expect(rec?.tier).toBe('flash');
  });

  it('formats custom agent action directive with Agent(subagent_type, model)', () => {
    const customRec: Dispatch = {
      subagent: 'code_engineer',
      tier: 'flash',
      model: 'sonnet',
      effort: 'medium',
      confidence: 0.95
    };

    const directive = buildDirective(customRec, 'claude-sonnet-5', 'normal');

    expect(directive).toContain(
      'Action: Delegate to custom persona via Agent(subagent_type: "code_engineer", model: "sonnet").'
    );
  });
});

describe('withTimeout', () => {
  it('aborts the AbortSignal when timeout expires', async () => {
    const { withTimeout } = await import('../claude/hook.ts');
    let aborted = false;
    let signalReceived: AbortSignal | undefined;

    const result = await withTimeout((signal) => {
      signalReceived = signal;
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise((resolve) => setTimeout(() => resolve('done'), 100));
    }, 20);

    expect(result).toBeNull();
    expect(aborted).toBe(true);
    expect(signalReceived?.aborted).toBe(true);
  });

  it('resolves value before timeout without aborting', async () => {
    const { withTimeout } = await import('../claude/hook.ts');
    let signalReceived: AbortSignal | undefined;

    const result = await withTimeout((signal) => {
      signalReceived = signal;
      return Promise.resolve('quick');
    }, 50);

    expect(result).toBe('quick');
    expect(signalReceived?.aborted).toBe(false);
  });
});
