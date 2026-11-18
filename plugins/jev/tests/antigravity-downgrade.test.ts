/**
 * Antigravity downgrade choice (`[jev-downgrade:flash_lite]`), logic level: hermetic (temp directory, injected router and
 * clock, no network, no real home). The hook as a process is covered by antigravity-downgrade-process.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DOWNGRADE_LABELS,
  DOWNGRADE_MARKER,
  applyAntigravityDowngrade,
  delegationTask,
  downgradeSignature,
  findDowngradeQuestion,
  parseDowngradeAnswer,
  userNamedFlash,
  type DowngradeDeps
} from '../antigravity/downgrade.ts';
import { evaluateAntigravitySubagentCall, type AntigravityHookDecision, type AntigravityHookInput } from '../antigravity/logic.ts';
import { createAntigravityApprovalStore, createAntigravityDowngradeStore, type ApprovalStore, type DowngradeStore } from '../antigravity/approvals.ts';
import type { TierRating } from '../src/core/downgrade-state.ts';
import { HAIKU, OPUS, SONNET, rating } from './downgrade-helpers.ts';
import type { QuotaView } from '../src/core/governance.ts';

const FLASH_SESSION = 'gemini-3.8-flash-low';
const ORCH_SESSION = 'Orchestrator (Argon)';
const T0 = 1_800_000_000_000;

let dir = '';
let sessionsDir = '';
let approvals: ApprovalStore;
let store: DowngradeStore;
let now = T0;
let routerCalls = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-downgrade-'));
  sessionsDir = path.join(dir, 'sessions');
  approvals = createAntigravityApprovalStore(sessionsDir);
  store = createAntigravityDowngradeStore(sessionsDir);
  now = T0;
  routerCalls = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(args: Record<string, unknown>, extra: Partial<AntigravityHookInput> = {}): AntigravityHookInput {
  return {
    conversationId: 'conv-dg',
    modelName: FLASH_SESSION,
    lastUserInput: 'sweep the folder',
    stepIdx: 10,
    toolCall: { id: 'call_sub', name: 'invoke_subagent', args: { TypeName: 'self', Role: 'worker', Prompt: 'rename the files in the folder', ...args } },
    ...extra
  };
}

/** A router stand-in that counts its calls. */
function router(r: TierRating | null | 'throw' | 'hang'): NonNullable<DowngradeDeps['rateTask']> {
  return async (_task, signal) => {
    routerCalls++;
    if (r === 'throw') throw new Error('router down');
    if (r === 'hang') return new Promise<TierRating | null>((resolve) => signal?.addEventListener('abort', () => resolve(null)));
    return r;
  };
}

function deps(over: Partial<DowngradeDeps> = {}): DowngradeDeps {
  return { store, jevMode: 'on', sessionModel: FLASH_SESSION, env: {}, rateTask: router(HAIKU), now: () => now, ratingTimeoutMs: 100, ...over };
}

/** The whole PreToolUse decision: the v2.3.16 checks first, the downgrade only on a pass. */
async function decide(
  input: AntigravityHookInput,
  over: Partial<DowngradeDeps> = {},
  opts: { mode?: 'on' | 'on-demand'; session?: string; quotaView?: QuotaView } = {}
) {
  const mode = opts.mode ?? 'on';
  const session = opts.session ?? FLASH_SESSION;
  const base = evaluateAntigravitySubagentCall(input, { approvals, sessionModelOverride: session, mode, quotaView: opts.quotaView, now: () => now });
  return applyAntigravityDowngrade(input, base, deps({ jevMode: mode, sessionModel: session, ...over }));
}

const ask = { env: { JEV_DOWNGRADE: 'ask' } };
const auto = { env: { JEV_DOWNGRADE: 'auto' } };

/** A transcript with the downgrade question and, when given, the answer row (the tail shape of a real transcript). */
function transcript(rows: object[]): string {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
const questionRow = (idx: number, id: string, at?: string) => ({
  step_index: idx,
  type: 'PLANNER_RESPONSE',
  ...(at ? { created_at: at } : {}),
  tool_calls: [{ id, name: 'ask_question', args: { questions: [{ question: `${DOWNGRADE_MARKER} Run 'self' on flash_lite?`, options: Object.values(DOWNGRADE_LABELS) }] } }]
});
const answerRow = (idx: number, id: string, label: string) => ({ step_index: idx, type: 'GENERIC', toolCallId: id, content: `Created At: x\nCompleted At: y\nA1: ${label}` });

describe('candidates and ordering with the v2.3.16 checks', () => {
  it('never turns a deny into an allow: a base deny is returned untouched and the router is not called', async () => {
    const r = await decide(call({ Model: 'openrouter_free' }), ask);
    expect(r.decision.decision).toBe('deny');
    expect(routerCalls).toBe(0);
    expect(r.log).toEqual({});

    const bad = await decide(call({ Model: 'banana' }), ask);
    expect(bad.decision.decision).toBe('deny');
    expect(routerCalls).toBe(0);
  });

  it('leaves an ask or an elevation decision of the base alone (pro above the flash ceiling)', async () => {
    const r = await decide(call({ Model: 'pro' }), auto);
    expect(r.decision.decision).toBe('deny');
    expect(r.decision.elevation).toBe('denied');
    expect(routerCalls).toBe(0);
    const od = await decide(call({ Model: 'pro' }), auto, { mode: 'on-demand' });
    expect(od.decision.decision).toBe('ask');
    expect(routerCalls).toBe(0);
  });

  it('keeps the Orchestrator explicit-Model rule first: omitted and inherit are denied, never downgraded', async () => {
    for (const input of [call({}), call({ Model: 'inherit' })]) {
      const r = await decide(input, auto, { session: ORCH_SESSION });
      expect(r.decision.decision).toBe('deny');
      expect(r.decision.reason).toContain('set Model explicitly');
      expect(routerCalls).toBe(0);
    }
  });

  it('downgrades an explicit flash under Orchestrator (the ceiling is flash)', async () => {
    const r = await decide(call({ Model: 'flash' }), auto, { session: ORCH_SESSION });
    expect(r.decision).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
  });

  it('is not asked for flash_lite, pro on a pro session, or a nested Subagents array', async () => {
    for (const input of [call({ Model: 'flash_lite' }), call({ Model: 'pro' }, { modelName: 'Gemini 3.1 Pro' }), call({ Model: 'flash', Subagents: [{ Model: 'flash' }] })]) {
      const r = await decide(input, auto, { session: input.modelName === 'Gemini 3.1 Pro' ? 'Gemini 3.1 Pro' : FLASH_SESSION });
      expect(r.decision.decision).toBe('pass');
      expect(routerCalls).toBe(0);
    }
  });

  it('does not run in Jev mode on-demand (a native ask cannot deliver the downgrade): logged as skipped', async () => {
    const r = await decide(call({ Model: 'flash' }), ask, { mode: 'on-demand' });
    expect(r.decision.decision).toBe('pass');
    expect(r.log.downgrade).toBe('skipped');
    expect(r.log.downgrade_skip).toBe('jev-mode');
    expect(routerCalls).toBe(0);
  });

  it('skips when the user asked for flash in the prompt', async () => {
    const r = await decide(call({ Model: 'flash' }, { lastUserInput: 'Please use flash for the subagents' }), ask);
    expect(r.decision.decision).toBe('pass');
    expect(r.log.downgrade_skip).toBe('instructed');
    expect(routerCalls).toBe(0);
  });

  it('an omitted Model needs a downgrade mode that was set on purpose; an explicit flash does not', async () => {
    const omitted = await decide(call({}), {});
    expect(omitted.decision.decision).toBe('pass');
    expect(omitted.log.downgrade_skip).toBe('not-configured');
    expect(routerCalls).toBe(0);
    const explicit = await decide(call({ Model: 'flash' }), {});
    expect(explicit.decision.decision).toBe('deny'); // the default mode is ask
    expect(routerCalls).toBe(1);
  });

  it('a configured mode (config.json) counts as set on purpose for an omitted Model', async () => {
    const r = await decide(call({}), { downgradeConfig: () => 'auto' });
    expect(r.decision).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
  });

  it('a quota-conserve flash call is already denied by the base (mode on) and never reaches the router', async () => {
    const conserve = {
      active_model: FLASH_SESSION,
      strategy: 'conserve',
      active: { pool: 'gemini', strategy: 'conserve', min_remaining: 0.2 }
    } as unknown as QuotaView;
    const r = await decide(call({ Model: 'flash' }), ask, { quotaView: conserve });
    expect(r.decision.decision).toBe('deny');
    expect(r.decision.reason).toContain('conserve');
    expect(routerCalls).toBe(0);
  });
});

describe('ask mode', () => {
  it('denies once with the prescribed [jev-downgrade:flash_lite] question and the three exact options', async () => {
    const r = await decide(call({ Model: 'flash' }), ask);
    expect(r.decision.decision).toBe('deny');
    const reason = r.decision.reason ?? '';
    expect(reason).toContain('[jev-downgrade:flash_lite]');
    expect(reason).toContain('ask_question');
    expect(reason).toContain(`'Yes, flash_lite', 'No, keep flash', 'No, and don't ask again this session'`);
    expect(r.log.downgrade).toBe('asked');
    expect(r.log.downgrade_needed).toBe('flash_lite');
    expect(r.log.downgrade_from).toBe('flash');
    expect(r.log.downgrade_to).toBe('flash_lite');
    expect(typeof r.log.taskHash).toBe('string');
    expect(JSON.stringify(r.log)).not.toContain('rename the files');
    expect(reason.length).toBeLessThan(900);
  });

  it('asks about the omitted-Model call in its own words', async () => {
    const r = await decide(call({}), ask);
    expect(r.decision.decision).toBe('deny');
    expect(r.decision.reason).toContain('no Model');
  });

  it('asks at most once per delegation: the retry passes without a second router call', async () => {
    expect((await decide(call({ Model: 'flash' }), ask)).decision.decision).toBe('deny');
    const retry = await decide(call({ Model: 'flash' }), ask);
    expect(retry.decision.decision).toBe('pass');
    expect(retry.log.downgrade_skip).toBe('already-asked');
    expect(routerCalls).toBe(1);
  });

  it('records no approval and counts no elevation attempt (a separate state)', async () => {
    await decide(call({ Model: 'flash' }), ask);
    expect(fs.existsSync(path.join(sessionsDir, 'conv-dg.approvals.json'))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, 'conv-dg.downgrade.json'))).toBe(true);
    expect(fs.statSync(path.join(sessionsDir, 'conv-dg.downgrade.json')).mode & 0o777).toBe(0o600);
  });

  it('a different delegation is asked about on its own', async () => {
    await decide(call({ Model: 'flash' }), ask);
    const other = await decide(call({ Model: 'flash', Prompt: 'summarise the changelog' }), ask);
    expect(other.decision.decision).toBe('deny');
    expect(routerCalls).toBe(2);
  });

  it('a task that needs flash or pro is not offered a downgrade', async () => {
    for (const r of [SONNET, OPUS]) {
      const res = await decide(call({ Model: 'flash', Prompt: `p-${routerCalls}` }), { ...ask, rateTask: router(r) });
      expect(res.decision.decision).toBe('pass');
      expect(res.log.downgrade_skip).toBe('not-needed');
    }
  });

  describe('the answer, recorded from PostToolUse (store.answer)', () => {
    it('Yes: the retried call is run on flash_lite (allow + overwrite)', async () => {
      await decide(call({ Model: 'flash' }), ask);
      expect(store.answer('conv-dg', 'yes', 'ask_1', now)).toBe(true);
      const r = await decide(call({ Model: 'flash' }), ask);
      expect(r.decision).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
      expect(r.log.downgrade).toBe('applied');
      expect(r.log.downgrade_via).toBe('answer');
      expect(routerCalls).toBe(1);
      // the assistant that re-invokes with flash_lite itself is not touched
      expect((await decide(call({ Model: 'flash_lite' }), ask)).decision.decision).toBe('pass');
    });

    it('No, keep flash: this delegation passes as it is and is not asked again', async () => {
      await decide(call({ Model: 'flash' }), ask);
      expect(store.answer('conv-dg', 'keep', 'ask_1', now)).toBe(true);
      const r = await decide(call({ Model: 'flash' }), ask);
      expect(r.decision.decision).toBe('pass');
      expect(r.log.downgrade).toBe('answered');
      // another delegation is still asked
      expect((await decide(call({ Model: 'flash', Prompt: 'something else' }), ask)).decision.decision).toBe('deny');
    });

    it("No, and don't ask again this session: nothing is evaluated for the conversation, no router call", async () => {
      await decide(call({ Model: 'flash' }), ask);
      expect(store.answer('conv-dg', 'off', 'ask_1', now)).toBe(true);
      const before = routerCalls;
      for (const prompt of ['one', 'two']) {
        const r = await decide(call({ Model: 'flash', Prompt: prompt }), ask);
        expect(r.decision.decision).toBe('pass');
        expect(r.log.downgrade_skip).toBe('session-off');
      }
      expect(routerCalls).toBe(before);
      // other conversations are not affected
      expect((await decide(call({ Model: 'flash', Prompt: 'one' }, { conversationId: 'conv-other' }), ask)).decision.decision).toBe('deny');
    });

    it('an answer is recorded once: the same answer again records nothing (no replay)', async () => {
      await decide(call({ Model: 'flash' }), ask);
      expect(store.answer('conv-dg', 'keep', 'ask_1', now)).toBe(true);
      expect(store.answer('conv-dg', 'off', 'ask_1', now)).toBe(false);
      expect(store.answer('conv-dg', 'yes', 'ask_1', now)).toBe(false);
      expect(store.choiceFor('conv-dg', downgradeSignature(call({ Model: 'flash' }).toolCall!.args), now)).toBe('keep');
    });

    it('an answer nobody asked for records nothing', () => {
      expect(store.answer('conv-dg', 'off', 'ask_x', now)).toBe(false);
      expect(store.peek('conv-dg', 'whatever', now).off).toBe(false);
    });

    it('a Yes holds for ten minutes and then the delegation is rated again', async () => {
      await decide(call({ Model: 'flash' }), ask);
      store.answer('conv-dg', 'yes', 'ask_1', now);
      now += 9 * 60_000;
      expect((await decide(call({ Model: 'flash' }), ask)).decision.decision).toBe('allow');
      now += 2 * 60_000;
      expect((await decide(call({ Model: 'flash' }), ask)).decision.decision).toBe('deny');
      expect(routerCalls).toBe(2);
    });
  });

  describe('the answer, pulled from the transcript at PreToolUse (the row can arrive after PostToolUse)', () => {
    for (const [label, expected] of [
      [DOWNGRADE_LABELS.yes, 'allow'],
      [DOWNGRADE_LABELS.keep, 'pass'],
      [DOWNGRADE_LABELS.off, 'pass']
    ] as const) {
      it(`pulls "${label}"`, async () => {
        await decide(call({ Model: 'flash' }), ask);
        const file = transcript([questionRow(11, 'ask_q1'), answerRow(12, 'ask_q1', label)]);
        now += 5_000;
        const r = await decide(call({ Model: 'flash' }, { transcriptPath: file }), ask);
        expect(r.decision.decision).toBe(expected);
        expect(r.log.downgrade_pull).toBe(true);
        if (label === DOWNGRADE_LABELS.yes) expect(r.decision.overwrite).toEqual({ Model: 'flash_lite' });
        if (label === DOWNGRADE_LABELS.off) {
          expect(r.log.downgrade_skip).toBe('session-off');
          expect(store.peek('conv-dg', 'any', now).off).toBe(true);
        }
        expect(routerCalls).toBe(1);
      });
    }

    it('passes (asked once) when the answer row is not in the transcript yet', async () => {
      await decide(call({ Model: 'flash' }), ask);
      const file = transcript([questionRow(11, 'ask_q1')]);
      const r = await decide(call({ Model: 'flash' }, { transcriptPath: file }), ask);
      expect(r.decision.decision).toBe('pass');
      expect(r.log.downgrade_skip).toBe('already-asked');
    });

    it('a free-text or near-miss answer in the row records nothing', async () => {
      await decide(call({ Model: 'flash' }), ask);
      for (const label of ['No, keep flash_lite', 'yes please', 'Yes, flash', 'No, not even once']) {
        const file = transcript([questionRow(11, 'ask_q1'), answerRow(12, 'ask_q1', label)]);
        const r = await decide(call({ Model: 'flash' }, { transcriptPath: file }), ask);
        expect(r.decision.decision).toBe('pass');
        expect(r.log.downgrade_skip).toBe('already-asked');
      }
      expect(store.choiceFor('conv-dg', downgradeSignature(call({ Model: 'flash' }).toolCall!.args), now)).toBeNull();
    });

    it('never reads the answer from the question or its options (only from the result row)', async () => {
      await decide(call({ Model: 'flash' }), ask);
      const file = transcript([questionRow(11, 'ask_q1')]); // the options list "Yes, flash_lite"
      const r = await decide(call({ Model: 'flash' }, { transcriptPath: file }), ask);
      expect(r.decision.decision).toBe('pass');
      expect(store.choiceFor('conv-dg', downgradeSignature(call({ Model: 'flash' }).toolCall!.args), now)).toBeNull();
    });

    it('does not replay: an answer already recorded for one delegation never answers the next one', async () => {
      // delegation A is asked and answered Yes through PostToolUse (tool call ask_q1)
      await decide(call({ Model: 'flash' }), ask);
      expect(store.answer('conv-dg', 'yes', 'ask_q1', now)).toBe(true);
      // delegation B is asked later; the transcript still holds question 1 and its Yes, and B's question was never asked
      now += 60_000;
      const b = call({ Model: 'flash', Prompt: 'translate the readme' }, { stepIdx: 30 });
      expect((await decide(b, ask)).decision.decision).toBe('deny');
      const file = transcript([questionRow(11, 'ask_q1', '2026-11-18T10:00:00.000Z'), answerRow(12, 'ask_q1', DOWNGRADE_LABELS.yes)]);
      now += 5_000;
      const r = await decide({ ...b, transcriptPath: file }, ask);
      expect(r.decision.decision).toBe('pass');
      expect(r.log.downgrade_skip).toBe('already-asked');
    });

    it('does not replay an older question that predates the denial step (no tool call id, no timestamp)', async () => {
      const first = call({ Model: 'flash' }, { stepIdx: 40 });
      await decide(first, ask);
      const file = transcript([questionRow(11, 'old_q'), answerRow(12, 'old_q', DOWNGRADE_LABELS.yes)]);
      const r = await decide({ ...first, transcriptPath: file }, ask);
      expect(r.decision.decision).toBe('pass');
      expect(r.log.downgrade_skip).toBe('already-asked');
    });

    it('a question after the denial step is picked up; the pulled answer is then consumed (a second pull records nothing)', async () => {
      await decide(call({ Model: 'flash' }, { stepIdx: 10 }), ask);
      const file = transcript([questionRow(11, 'q_new'), answerRow(12, 'q_new', DOWNGRADE_LABELS.keep)]);
      const input = call({ Model: 'flash' }, { transcriptPath: file });
      expect((await decide(input, ask)).log.downgrade_pull).toBe(true);
      expect(store.answer('conv-dg', 'off', 'q_new', now)).toBe(false);
    });
  });
});

describe('auto mode', () => {
  it('explicit Model flash: allow + overwrite Model flash_lite, logged as applied', async () => {
    const r = await decide(call({ Model: 'flash' }), auto);
    expect(r.decision).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
    expect(r.log.downgrade).toBe('applied');
    expect(r.log.downgrade_via).toBe('auto');
    expect(r.log.downgrade_from).toBe('flash');
    expect(r.log.downgrade_to).toBe('flash_lite');
  });

  it('omitted Model and Model inherit on a flash session: the same overwrite', async () => {
    for (const input of [call({}), call({ Model: 'inherit' })]) {
      const r = await decide(input, { ...auto, rateTask: router(HAIKU) });
      expect(r.decision).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
    }
  });

  it('a lowercase `model` argument is overwritten under its own key', async () => {
    const input = call({});
    delete (input.toolCall!.args as Record<string, unknown>).Model;
    (input.toolCall!.args as Record<string, unknown>).model = 'flash';
    const r = await decide(input, auto);
    expect(r.decision.overwrite).toEqual({ model: 'flash_lite' });
  });

  it('no question, no state of a pending question; a task that needs flash is left alone', async () => {
    const r = await decide(call({ Model: 'flash' }), { ...auto, rateTask: router(SONNET) });
    expect(r.decision.decision).toBe('pass');
    expect(fs.existsSync(path.join(sessionsDir, 'conv-dg.downgrade.json'))).toBe(true); // only the cached rating
    expect(store.peek('conv-dg', downgradeSignature(call({ Model: 'flash' }).toolCall!.args), now).asked).toBe(false);
  });

  it('respects an earlier "No, keep flash" and the session-off answer', async () => {
    await decide(call({ Model: 'flash' }), ask);
    store.answer('conv-dg', 'keep', 'ask_1', now);
    expect((await decide(call({ Model: 'flash' }), auto)).decision.decision).toBe('pass');
    store.answer('conv-dg', 'off', 'x', now); // nothing pending: ignored
    expect((await decide(call({ Model: 'flash', Prompt: 'new one' }), auto)).decision.overwrite).toEqual({ Model: 'flash_lite' });
  });
});

describe('off and the configuration', () => {
  it('JEV_DOWNGRADE=off: no downgrade, no router call, no log', async () => {
    const r = await decide(call({ Model: 'flash' }), { env: { JEV_DOWNGRADE: 'off' } });
    expect(r.decision.decision).toBe('pass');
    expect(r.log).toEqual({});
    expect(routerCalls).toBe(0);
  });

  it('models.downgrade.mode = off in the config disables it, and the environment overrides the config', async () => {
    expect((await decide(call({ Model: 'flash' }), { downgradeConfig: () => 'off' })).decision.decision).toBe('pass');
    expect(routerCalls).toBe(0);
    const r = await decide(call({ Model: 'flash' }), { downgradeConfig: () => 'off', env: { JEV_DOWNGRADE: 'auto' } });
    expect(r.decision.overwrite).toEqual({ Model: 'flash_lite' });
    const r2 = await decide(call({ Model: 'flash', Prompt: 'b' }), { downgradeConfig: () => 'auto', env: { JEV_DOWNGRADE: 'off' } });
    expect(r2.decision.decision).toBe('pass');
  });

  it('an invalid mode is ignored (the default, ask)', async () => {
    const r = await decide(call({ Model: 'flash' }), { env: { JEV_DOWNGRADE: 'banana' }, downgradeConfig: () => 'sometimes' });
    expect(r.decision.decision).toBe('deny');
  });

  it('no store, no conversation id or a conversation id that is not a safe name: no downgrade', async () => {
    expect((await decide(call({ Model: 'flash' }), { ...ask, store: undefined })).log.downgrade_skip).toBe('no-store');
    expect((await decide(call({ Model: 'flash' }, { conversationId: undefined }), ask)).log.downgrade_skip).toBe('no-session');
    // an id with nothing safe in it has no state file at all; one with unsafe characters is cleaned and stays inside the directory
    const bad = await decide(call({ Model: 'flash' }, { conversationId: '../..' }), ask);
    expect(bad.decision.decision).toBe('pass');
    expect(bad.log.downgrade_skip).toBe('store-error');
    expect(routerCalls).toBe(0);
    await decide(call({ Model: 'flash' }, { conversationId: '../escape' }), ask);
    expect(fs.existsSync(path.join(sessionsDir, 'escape.downgrade.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'escape.downgrade.json'))).toBe(false);
  });
});

describe('the rating fails open', () => {
  it('a router that never answers: times out, the call passes, nothing is stored as asked', async () => {
    const started = Date.now();
    const r = await decide(call({ Model: 'flash' }), { ...ask, rateTask: router('hang'), ratingTimeoutMs: 40 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.decision.decision).toBe('pass');
    expect(r.log.downgrade_skip).toBe('no-rating');
    expect(typeof r.log.downgrade_rating_ms).toBe('number');
    expect(store.peek('conv-dg', downgradeSignature(call({ Model: 'flash' }).toolCall!.args), now).asked).toBe(false);
  });

  it('a router that throws, returns nothing or is absent: the call passes (also in auto)', async () => {
    for (const rateTask of [router('throw'), router(null), undefined]) {
      for (const env of [ask.env, auto.env]) {
        const r = await decide(call({ Model: 'flash' }), { env, rateTask });
        expect(r.decision.decision).toBe('pass');
        expect(['no-rating', 'no-router']).toContain(r.log.downgrade_skip as string);
      }
    }
  });

  it('a missing key (the real router client throws) fails open', async () => {
    const { liveRateTask } = await import('../antigravity/downgrade.ts');
    const saved = { a: process.env.JEV_OPENROUTER_API_KEY, b: process.env.OPENROUTER_API_KEY };
    delete process.env.JEV_OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const r = await decide(call({ Model: 'flash' }), { ...ask, rateTask: liveRateTask, ratingTimeoutMs: 1500 });
      expect(r.decision.decision).toBe('pass');
      expect(r.log.downgrade_skip).toBe('no-rating');
    } finally {
      if (saved.a !== undefined) process.env.JEV_OPENROUTER_API_KEY = saved.a;
      if (saved.b !== undefined) process.env.OPENROUTER_API_KEY = saved.b;
    }
  });

  it('the egress policy can stop the router call; a call with no task text is not rated', async () => {
    const e = await decide(call({ Model: 'flash' }), { ...ask, egressAllowed: () => false });
    expect(e.log.downgrade_skip).toBe('egress');
    const t = await decide(call({ Model: 'flash', Role: '', Prompt: '  ' }), ask);
    expect(t.log.downgrade_skip).toBe('no-task');
    expect(routerCalls).toBe(0);
  });

  it('a store that throws never throws out of the evaluation', async () => {
    const broken = new Proxy({} as DowngradeStore, { get: () => () => { throw new Error('disk'); } });
    const r = await decide(call({ Model: 'flash' }), { ...ask, store: broken });
    expect(r.decision.decision).toBe('pass');
    expect(r.log.downgrade_skip).toBe('store-error');
  });
});

describe('the threshold', () => {
  const at = (p: [number, number, number, number]) => router(rating(p));

  it('P(openrouter_free + flash_lite) = 0.6 downgrades; 0.59 does not', async () => {
    const hit = await decide(call({ Model: 'flash', Prompt: 'edge-a' }), { ...auto, rateTask: at([0.3, 0.3, 0.4, 0]) });
    expect(hit.decision.decision).toBe('allow');
    expect(hit.log.downgrade_probability).toBe(0.6);
    const miss = await decide(call({ Model: 'flash', Prompt: 'edge-b' }), { ...auto, rateTask: at([0.3, 0.29, 0.41, 0]) });
    expect(miss.decision.decision).toBe('pass');
    expect(miss.log.downgrade_skip).toBe('not-needed');
  });

  it('openrouter_free alone at 0.6 downgrades; flash_lite alone at 0.6 downgrades', async () => {
    expect((await decide(call({ Model: 'flash', Prompt: 'a' }), { ...auto, rateTask: at([0.6, 0, 0.4, 0]) })).decision.decision).toBe('allow');
    expect((await decide(call({ Model: 'flash', Prompt: 'b' }), { ...auto, rateTask: at([0, 0.6, 0.4, 0]) })).decision.decision).toBe('allow');
  });

  it('the configured minimum probability moves the edge (clamped to 0.5..0.95)', async () => {
    const p = at([0.3, 0.3, 0.4, 0]);
    expect((await decide(call({ Model: 'flash', Prompt: 'c' }), { ...auto, rateTask: p, downgradeMinProbability: () => 0.7 })).decision.decision).toBe('pass');
    expect((await decide(call({ Model: 'flash', Prompt: 'd' }), { ...auto, rateTask: p, downgradeMinProbability: () => 0.1 })).decision.decision).toBe('allow');
    expect((await decide(call({ Model: 'flash', Prompt: 'e' }), { env: { JEV_DOWNGRADE: 'auto', JEV_DOWNGRADE_MIN_PROBABILITY: '0.9' }, rateTask: p })).decision.decision).toBe('pass');
  });

  it('a one-hot rating (the API sent no probabilities) on flash_lite downgrades, on flash does not', async () => {
    expect((await decide(call({ Model: 'flash', Prompt: 'x1' }), { ...auto, rateTask: router({ choice: 'flash_lite', p: { openrouter_free: 0, flash_lite: 1, flash: 0, pro: 0 }, real: false }) })).decision.decision).toBe('allow');
    expect((await decide(call({ Model: 'flash', Prompt: 'x2' }), { ...auto, rateTask: router({ choice: 'flash', p: { openrouter_free: 0, flash_lite: 0, flash: 1, pro: 0 }, real: false }) })).decision.decision).toBe('pass');
  });
});

describe('the rating cache', () => {
  it('a verdict is cached by signature for 10 minutes: one router call, then a new one', async () => {
    await decide(call({ Model: 'flash' }), auto);
    await decide(call({ Model: 'flash' }), auto);
    await decide(call({}), { ...auto, env: { JEV_DOWNGRADE: 'auto' } }); // the same delegation with the model omitted
    expect(routerCalls).toBe(1);
    now += 9 * 60_000;
    await decide(call({ Model: 'flash' }), auto);
    expect(routerCalls).toBe(1);
    now += 2 * 60_000;
    const r = await decide(call({ Model: 'flash' }), auto);
    expect(routerCalls).toBe(2);
    expect(r.log.downgrade_rating).toBeUndefined();
  });

  it('a cached rating is flagged in the log; a different prompt is a different signature', async () => {
    await decide(call({ Model: 'flash' }), auto);
    expect((await decide(call({ Model: 'flash' }), auto)).log.downgrade_rating).toBe('cached');
    await decide(call({ Model: 'flash', Prompt: 'something else entirely' }), auto);
    expect(routerCalls).toBe(2);
  });

  it('a negative verdict is cached too (a retry of a task that needs flash does not call the router again)', async () => {
    await decide(call({ Model: 'flash' }), { ...auto, rateTask: router(SONNET) });
    await decide(call({ Model: 'flash' }), { ...auto, rateTask: router(SONNET) });
    expect(routerCalls).toBe(1);
  });
});

describe('pure helpers', () => {
  it('parseDowngradeAnswer takes the three exact labels only', () => {
    expect(parseDowngradeAnswer('Yes, flash_lite')).toBe('yes');
    expect(parseDowngradeAnswer('A1: (Recommended) Yes, flash_lite')).toBe('yes');
    expect(parseDowngradeAnswer('Yes, flash_lite (Recommended)')).toBe('yes');
    expect(parseDowngradeAnswer('No, keep flash')).toBe('keep');
    expect(parseDowngradeAnswer("No, and don't ask again this session")).toBe('off');
    expect(parseDowngradeAnswer('No, and don’t ask again this session')).toBe('off');
    for (const bad of ['yes, flash_lite', 'Yes, flash', 'Yes', 'No', 'No, keep flash_lite', 'No, keep flash please', 'Yes, flash_lite and more', 'No, and dont ask again this session', '', null, undefined]) {
      expect(parseDowngradeAnswer(bad as string)).toBeNull();
    }
  });

  it('findDowngradeQuestion finds the question that STARTS with the marker', () => {
    expect(findDowngradeQuestion([{ question: `${DOWNGRADE_MARKER} Run it on flash_lite?` }])).toBe(0);
    expect(findDowngradeQuestion(['other', `  ${DOWNGRADE_MARKER.toUpperCase()} x`])).toBe(1);
    expect(findDowngradeQuestion([{ question: `Please [jev-downgrade:flash_lite] later` }])).toBeNull();
    expect(findDowngradeQuestion([{ question: '[jev-downgrade:pro] x' }])).toBeNull();
    expect(findDowngradeQuestion(`${DOWNGRADE_MARKER} x`)).toBe(0);
    expect(findDowngradeQuestion(undefined)).toBeNull();
  });

  it('delegationTask is the role plus the first 1000 characters of the prompt', () => {
    const t = delegationTask({ Role: 'worker', Prompt: 'x'.repeat(5000) });
    expect(t).toBe(`worker\n\n${'x'.repeat(1000)}`);
    expect(delegationTask({})).toBe('');
    expect(delegationTask(undefined)).toBe('');
  });

  it('downgradeSignature: SHA-256 prefix; model-independent; only the first 1000 prompt characters count', () => {
    const a = downgradeSignature({ TypeName: 'self', Role: 'w', Prompt: 'p'.repeat(1000) + 'A', Model: 'flash' });
    const b = downgradeSignature({ TypeName: 'self', Role: 'w', Prompt: 'p'.repeat(1000) + 'B' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(downgradeSignature({ TypeName: 'self', Role: 'w', Prompt: 'q' })).not.toBe(downgradeSignature({ TypeName: 'other', Role: 'w', Prompt: 'q' }));
  });

  it('userNamedFlash: an imperative counts, a negation, prose and flash_lite do not', () => {
    expect(userNamedFlash('Use flash for the subagents')).toBe(true);
    expect(userNamedFlash('run it with gemini 3.8 flash')).toBe(false); // "with" alone is not an imperative here
    expect(userNamedFlash('please run flash agents')).toBe(true);
    expect(userNamedFlash('do not use flash here')).toBe(false);
    expect(userNamedFlash('use flash_lite for this')).toBe(false);
    expect(userNamedFlash('flash is cheaper than pro')).toBe(false);
    expect(userNamedFlash(undefined)).toBe(false);
  });
});
