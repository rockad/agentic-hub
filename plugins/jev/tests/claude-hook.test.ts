import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  modelRank,
  parseDispatch,
  buildDirective,
  decideAgentCall,
  decideByTier,
  safeSessionId,
  type Dispatch
} from '../claude/logic.ts';
import { onUserPromptSubmit, onPreToolUse, type HookDeps } from '../claude/hook.ts';

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

describe('decideByTier', () => {
  it('asks when Jev recommends the pro tier', () => {
    const call = { description: 'Redesign the auth flow' };

    const verdict = decideByTier(call, proRec);

    expect(verdict?.decision).toBe('ask');
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
  it('returns an ask decision for an Agent call above the ceiling', async () => {
    const input = { session_id: 's1', tool_name: 'Agent', tool_input: { model: 'opus', prompt: 'Refactor the parser' } };

    const out = await onPreToolUse(input, deps());

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
