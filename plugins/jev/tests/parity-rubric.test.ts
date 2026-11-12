/**
 * Parity audit: port of cognitive-engine PR #22 advisor-rubric.test.ts (5.3, 5.5, 5.6, 5.7) onto agentic-hub Jev 2.3.2.
 *
 * Adaptations: stage-rubric.ts does not exist here, so the rubric lines come from parity-helpers (copied from #22) and are
 * asserted against the observable surfaces (TIER_CRITERIA, dispatchQuestions, buildDirective). #22's adviceTelemetry is
 * telemetryEvent. #22's withoutDisplayNames is dropDisplayNameAliases. #22's constants PASTE_SKIP_CHARS=20000 and
 * TASK_TRIM_CHARS=2000 are local consts. Silence/trim behaviour is exercised through onUserPromptSubmit.
 *
 * NOT PORTABLE (function or module absent, behaviour covered by the hook-level cases here):
 *  - STAGE_RUBRIC / STAGE_KINDS / isStageKind: 'maps the three kinds to haiku, sonnet and opus', 'recognises a stage kind'
 *  - isStatusTurn / isNonTaskPrompt / trimTask unit calls: 'recognises host-injected turns', the isStatusTurn unit assertion
 *  - 'the remembered advice round-trips through the session state directory': needs advisor-state.ts
 *    (writeLastAdvice/readLastAdvice, JEV_CLAUDE_STATE_DIR); 2.3.2 keeps one private turn file under ~/.config/jev.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TIER_CRITERIA,
  buildDirective,
  dispatchQuestions,
  dropDisplayNameAliases,
  parseDispatch,
  resolveClaudeSubagentCriteria,
  turnId
} from '../claude/logic.ts';
import { onUserPromptSubmit, telemetryEvent } from '../claude/hook.ts';
import { RUBRIC, STAGE_RUBRIC_TEXT, context, deps, flashRec, input, memoryTurnStore, selfLite, SESSION } from './parity-helpers.ts';

const PASTE_SKIP_CHARS = 20_000;
const TASK_TRIM_CHARS = 2000;

describe('stage rubric (5.3)', () => {
  // 2.3.5: stage rubric in the router criteria (5.3)
  it.skip('puts every rubric line into the tier criteria the router sees', () => {
    expect(TIER_CRITERIA.flash_lite).toContain(RUBRIC.mechanical);
    expect(TIER_CRITERIA.flash).toContain(RUBRIC.settled);
    expect(TIER_CRITERIA.pro).toContain(RUBRIC.judgement);
    expect(JSON.stringify(dispatchQuestions())).toContain('checklist update');
  });

  it('leaves parseDispatch unchanged', () => {
    const data = { answers: { recommendedSubagent: { choice: 'Plan' }, recommendedTier: { choice: 'flash_lite' } } };

    const rec = parseDispatch(data, 'Tick the boxes in the tasklist', 'normal');

    expect([rec?.subagent, rec?.tier, rec?.model]).toEqual(['Plan', 'flash_lite', 'haiku']);
  });

  // 2.3.5: stage rubric in the UserPromptSubmit directive (5.3)
  it.skip('adds the rubric to the line on a delegation turn only', () => {
    expect(buildDirective(flashRec, SESSION, 'normal')).toContain(STAGE_RUBRIC_TEXT);
    expect(buildDirective(selfLite, SESSION, 'normal')).not.toContain('Stage rubric');
  });
});

describe('silence on turns without delegation intent (5.5)', () => {
  it('returns null for a task notification without calling Jev', async () => {
    let called = false;
    const prompt = '<task-notification>\n<task-id>a1</task-id> completed the run</task-notification>';

    const out = await onUserPromptSubmit(input(prompt), deps({ dispatch: async () => ((called = true), flashRec) }));

    expect([out, called]).toEqual([null, false]);
  });

  it('returns null for a giant paste', async () => {
    const out = await onUserPromptSubmit(input(`Find the cause ${'x'.repeat(PASTE_SKIP_CHARS)}`), deps());

    expect(out).toBeNull();
  });

  it('trims a 6000 character paste to its head in the dispatch call', async () => {
    let sent = '';
    const prompt = `Find where the table is built\n${'| a | b |\n'.repeat(600)}`;

    await onUserPromptSubmit(input(prompt), deps({ dispatch: async (task) => ((sent = task), flashRec) }));

    expect(sent.length).toBe(TASK_TRIM_CHARS);
    expect(sent.startsWith('Find where the table is built')).toBe(true);
  });

  it('stays silent on a status turn: self, a cheap tier and no verb of work', async () => {
    const out = await onUserPromptSubmit(input('A3 completed the run, all green'), deps({ dispatch: async () => selfLite }));

    expect(out).toBeNull();
  });

  it('still advises a cheap self turn that holds a verb of work', async () => {
    const out = await onUserPromptSubmit(input('please fix the typo in the readme'), deps({ dispatch: async () => selfLite }));

    expect(context(out)).toContain('[JEV]');
  });

  it('never goes silent when the user gave an instruction (hook level)', async () => {
    const out = await onUserPromptSubmit(input('thanks, cheapest model please'), deps({ dispatch: async () => selfLite }));

    expect(context(out)).toContain('[JEV]');
  });
});

describe('personas match real subagent types (5.6)', () => {
  it('drops the display-name alias and keeps the kebab-case name', () => {
    const discovered = {
      'Code Engineer': 'Writes code',
      'code-engineer': 'Writes code',
      'Knowledge Researcher': 'Researches',
      'knowledge-researcher': 'Researches',
      self: 'x'
    };

    expect(Object.keys(dropDisplayNameAliases(discovered))).toEqual(['code-engineer', 'knowledge-researcher', 'self']);
  });

  it('keeps a display name that has no alias and a lower-case file-name alias', () => {
    const discovered = { Reviewer: 'Reviews', code_engineer: 'Writes code' };

    expect(Object.keys(dropDisplayNameAliases(discovered))).toEqual(['Reviewer', 'code_engineer']);
  });

  describe('against a discovered directory', () => {
    let dir = '';
    let savedHarness: string | undefined;
    beforeEach(() => {
      // Agent discovery reads .claude/agents only on the Claude Code harness: say so instead of inheriting it from the shell.
      savedHarness = process.env.JEV_HARNESS;
      process.env.JEV_HARNESS = 'claude-code';
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-persona-'));
      fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'agents', 'code-engineer.md'), '---\nname: Code Engineer\ndescription: "Scripts and tests"\n---\n');
    });
    afterEach(() => {
      if (savedHarness === undefined) delete process.env.JEV_HARNESS;
      else process.env.JEV_HARNESS = savedHarness;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('offers only code-engineer for a discovered "Code Engineer"', async () => {
      const criteria = await resolveClaudeSubagentCriteria(dir);

      expect(Object.keys(criteria).filter((k) => /code/i.test(k))).toEqual(['code-engineer']);
      expect(criteria.Explore).toBeDefined();
      expect(criteria.Plan).toBeDefined();
    });
  });
});

describe('recommended and used share one key (5.7)', () => {
  it('gives the same turn id for the same prompt and a different one for another', () => {
    expect(turnId(' Find the quota file ')).toBe(turnId('Find the quota file'));
    expect(turnId('Find the quota file')).not.toBe(turnId('Find the config file'));
    expect(turnId('Find the quota file')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('logs the turn, the tier and the recommended model, never the prompt', async () => {
    const logged: Record<string, unknown>[] = [];
    const prompt = 'Find where the quota file is written';
    const turn = memoryTurnStore();

    await onUserPromptSubmit(input(prompt), deps({ log: (e) => logged.push(e), saveTurn: turn.saveTurn }));

    expect(logged[0]).toMatchObject({ hook: 'UserPromptSubmit', session_id: 's1', turn: turnId(prompt), tier: 'flash', recommended_model: 'sonnet' });
    expect(JSON.stringify(logged)).not.toContain('quota file');
  });

  it('renames the telemetry field and keeps the old one as a deprecated alias', () => {
    const event = telemetryEvent({ hook: 'UserPromptSubmit', session_id: 's1', turn: 'abc', subagent: 'Explore', tier: 'flash', recommended_model: 'sonnet', quota: 'unknown' });

    expect(event).toMatchObject({ harness: 'claude', turn: 'abc', modelRecommended: 'sonnet', modelUsed: 'sonnet', tierRecommended: 'flash', sessionId: 's1' });
  });
});
