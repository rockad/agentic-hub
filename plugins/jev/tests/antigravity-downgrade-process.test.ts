/**
 * Antigravity downgrade choice through the real hook process (`antigravity/hook.ts`): stdout shapes, the PostToolUse
 * recorder, the PreToolUse pull fallback and the decisions-log rows. Hermetic: a temp HOME, no key (the router cannot be
 * reached, so every rating is either seeded into the state file as a cached rating or fails open), no real ~/.config.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downgradeSignature, DOWNGRADE_LABELS, DOWNGRADE_MARKER } from '../antigravity/downgrade.ts';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const CONV = 'conv-dg-proc';

let home = '';
const sessions = () => path.join(home, '.config', 'jev', 'antigravity-sessions');
const stateFile = () => path.join(sessions(), `${CONV}.downgrade.json`);
const logFile = () => path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dg-proc-'));
  fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(event: string, input: object, env: Record<string, string> = {}) {
  return Bun.spawnSync(['bun', HOOK, event], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: {
      ...process.env,
      HOME: home,
      JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'),
      JEV_OPENROUTER_API_KEY: '',
      OPENROUTER_API_KEY: '',
      JEV_DOWNGRADE: 'ask',
      ...env
    }
  });
}

const ARGS = { TypeName: 'self', Role: 'worker', Prompt: 'rename the files in the folder' };
const SIGNATURE = downgradeSignature(ARGS);

function invoke(model: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    conversationId: CONV,
    modelName: 'gemini-3.8-flash-low',
    lastUserInput: 'sweep the folder',
    stepIdx: 10,
    toolCall: { id: 'call_sub', name: 'invoke_subagent', args: { ...ARGS, ...(model ? { Model: model } : {}) } },
    ...extra
  };
}

/** A cached rating for the delegation (what a router call within the last ten minutes would have left). */
function seedRating(p: [number, number, number, number], extraState: Record<string, unknown> = {}) {
  fs.mkdirSync(sessions(), { recursive: true });
  const choice = ['openrouter_free', 'flash_lite', 'flash', 'pro'][p.indexOf(Math.max(...p))];
  const prior = fs.existsSync(stateFile()) ? JSON.parse(fs.readFileSync(stateFile(), 'utf8')) : { entries: [] };
  fs.writeFileSync(
    stateFile(),
    JSON.stringify({ ...prior, ratings: [{ signature: SIGNATURE, choice, p, real: true, expires_at: Date.now() + 600_000 }], ...extraState })
  );
}
const state = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
const logRows = (): Record<string, any>[] =>
  fs.existsSync(logFile()) ? fs.readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

function askPost(content: string | undefined, extra: Record<string, unknown> = {}, question = `${DOWNGRADE_MARKER} Run 'self' on flash_lite?`) {
  return {
    conversationId: CONV,
    stepIdx: 12,
    toolCall: { id: 'call_ask', name: 'ask_question', args: { questions: [{ question, options: Object.values(DOWNGRADE_LABELS) }] } },
    ...(content !== undefined ? { content } : {}),
    ...extra
  };
}

describe('Antigravity downgrade: the hook process', () => {
  it('ask mode: the first flash call is denied with the question, a retry passes with empty stdout', () => {
    seedRating([0.03, 0.83, 0.14, 0]);
    const first = run('pre-tool-use', invoke('flash'));
    expect(first.exitCode).toBe(0);
    const out = JSON.parse(first.stdout.toString());
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('[jev-downgrade:flash_lite]');
    expect(out.overwrite).toBeUndefined();

    const retry = run('pre-tool-use', invoke('flash'));
    expect(retry.exitCode).toBe(0);
    expect(retry.stdout.toString()).toBe('');

    const row = logRows().filter((r) => r.event === 'agent_call')[0];
    expect(row.downgrade).toBe('asked');
    expect(row.downgrade_needed).toBe('flash_lite');
    expect(row.downgrade_rating).toBe('cached');
    expect(row.decision).toBe('deny');
    expect(logRows().filter((r) => r.event === 'agent_call')[1].downgrade_skip).toBe('already-asked');
    expect(JSON.stringify(logRows())).not.toContain('rename the files');
  });

  it('auto mode: allow + overwrite Model flash_lite for explicit, omitted and inherit Model', () => {
    seedRating([0.03, 0.83, 0.14, 0]);
    for (const model of ['flash', undefined, 'inherit']) {
      const proc = run('pre-tool-use', invoke(model), { JEV_DOWNGRADE: 'auto' });
      expect(proc.exitCode).toBe(0);
      expect(JSON.parse(proc.stdout.toString())).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
    }
    expect(logRows().filter((r) => r.downgrade === 'applied').length).toBe(3);
  });

  it('off: prints nothing, writes no downgrade state', () => {
    const proc = run('pre-tool-use', invoke('flash'), { JEV_DOWNGRADE: 'off' });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe('');
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it('no key: the router cannot be reached, the call passes with empty stdout (fail open)', () => {
    const proc = run('pre-tool-use', invoke('flash'));
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe('');
    const row = logRows().filter((r) => r.event === 'agent_call')[0];
    expect(row.downgrade).toBe('skipped');
    expect(row.downgrade_skip).toBe('no-rating');
  });

  it('Jev mode on-demand: no downgrade, empty stdout', () => {
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on-demand' } }));
    seedRating([0.03, 0.83, 0.14, 0]);
    const proc = run('pre-tool-use', invoke('flash'), { JEV_DOWNGRADE: 'auto' });
    expect(proc.stdout.toString()).toBe('');
    expect(logRows().filter((r) => r.event === 'agent_call')[0].downgrade_skip).toBe('jev-mode');
  });

  it('a v2.3.16 deny still wins: pro above the ceiling is denied by the elevation flow, not rewritten', () => {
    seedRating([0.03, 0.83, 0.14, 0]);
    const proc = run('pre-tool-use', invoke('pro'), { JEV_DOWNGRADE: 'auto' });
    const out = JSON.parse(proc.stdout.toString());
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('[jev-elevate:pro]');
    expect(out.overwrite).toBeUndefined();
  });

  describe('PostToolUse on ask_question records the answer', () => {
    function asked() {
      seedRating([0.03, 0.83, 0.14, 0]);
      expect(JSON.parse(run('pre-tool-use', invoke('flash')).stdout.toString()).decision).toBe('deny');
    }

    it('Yes, flash_lite -> the retried flash call is rewritten to flash_lite', () => {
      asked();
      const post = run('post-tool-use', askPost(`A1: ${DOWNGRADE_LABELS.yes}`));
      expect(post.exitCode).toBe(0);
      expect(post.stdout.toString().trim()).toBe('{}');
      const retry = run('pre-tool-use', invoke('flash'));
      expect(JSON.parse(retry.stdout.toString())).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
      const row = logRows().find((r) => r.event === 'ask_answer')!;
      expect(row.marker).toBe('downgrade');
      expect(row.outcome).toBe('recorded');
      expect(row.parsed).toEqual({ choice: 'yes' });
      expect(row.marker_found).toBe(true);
      expect(row.row_found).toBe(true);
    });

    it('No, keep flash -> the retry passes with empty stdout', () => {
      asked();
      run('post-tool-use', askPost(`A1: (Recommended) ${DOWNGRADE_LABELS.keep}`));
      const retry = run('pre-tool-use', invoke('flash'));
      expect(retry.stdout.toString()).toBe('');
      expect(logRows().filter((r) => r.event === 'agent_call').pop()!.downgrade).toBe('answered');
    });

    it("No, and don't ask again -> nothing is evaluated for the conversation", () => {
      asked();
      run('post-tool-use', askPost(`A1: ${DOWNGRADE_LABELS.off}`));
      expect(state().off).toBeDefined();
      const other = invoke('flash');
      (other.toolCall.args as Record<string, unknown>).Prompt = 'a different task';
      const retry = run('pre-tool-use', other);
      expect(retry.stdout.toString()).toBe('');
      expect(logRows().filter((r) => r.event === 'agent_call').pop()!.downgrade_skip).toBe('session-off');
    });

    it('an answer is consumed once: the same answer again records nothing', () => {
      asked();
      expect(run('post-tool-use', askPost(`A1: ${DOWNGRADE_LABELS.keep}`)).exitCode).toBe(0);
      expect(run('post-tool-use', askPost(`A1: ${DOWNGRADE_LABELS.off}`)).exitCode).toBe(0);
      const rows = logRows().filter((r) => r.event === 'ask_answer');
      expect(rows.map((r) => r.outcome)).toEqual(['recorded', 'not_asked']);
      expect(state().off).toBeUndefined();
    });

    it('free text or an inexact label records nothing (outcome rejected)', () => {
      asked();
      run('post-tool-use', askPost('A1: No, keep flash_lite'));
      run('post-tool-use', askPost('A1: sure, why not'));
      expect(logRows().filter((r) => r.event === 'ask_answer').map((r) => r.outcome)).toEqual(['rejected', 'rejected']);
      expect(state().entries.every((e: any) => !e.answered)).toBe(true);
    });

    it('reads the answer from the transcript when content is not on stdin (bounded tail, around stepIdx)', () => {
      asked();
      const file = path.join(home, 'transcript.jsonl');
      fs.writeFileSync(file, JSON.stringify({ step_index: 12, type: 'GENERIC', toolCallId: 'call_ask', content: `A1: ${DOWNGRADE_LABELS.yes}` }) + '\n');
      const post = run('post-tool-use', askPost(undefined, { transcriptPath: file }));
      expect(post.stdout.toString().trim()).toBe('{}');
      expect(logRows().find((r) => r.event === 'ask_answer')!.outcome).toBe('recorded');
    });

    it('a question that only mentions the marker is not a downgrade question', () => {
      asked();
      run('post-tool-use', askPost(`A1: ${DOWNGRADE_LABELS.off}`, {}, `Is it fine to say ${DOWNGRADE_MARKER} here?`));
      const row = logRows().find((r) => r.event === 'ask_answer')!;
      expect(row.marker).toBeUndefined();
      expect(state().off).toBeUndefined();
    });

    it('an elevation question is still recorded by the elevation flow (no regression)', () => {
      const pro = run('pre-tool-use', invoke('pro'));
      expect(JSON.parse(pro.stdout.toString()).decision).toBe('deny');
      run('post-tool-use', askPost('A1: Yes, once', {}, "[jev-elevate:pro] Allow subagent 'self' to run on pro?"));
      const row = logRows().find((r) => r.event === 'ask_answer')!;
      expect(row.outcome).toBe('recorded');
      expect(row.marker).toBeUndefined();
    });
  });

  describe('PreToolUse pull fallback (the answer row arrived after PostToolUse returned)', () => {
    function asked(): string {
      seedRating([0.03, 0.83, 0.14, 0]);
      expect(JSON.parse(run('pre-tool-use', invoke('flash')).stdout.toString()).decision).toBe('deny');
      return path.join(home, 'transcript.jsonl');
    }
    const rows = (q: string, label: string, id = 'q_late') => [
      { step_index: 11, type: 'PLANNER_RESPONSE', tool_calls: [{ id, name: 'ask_question', args: { questions: [{ question: q, options: Object.values(DOWNGRADE_LABELS) }] } }] },
      { step_index: 12, type: 'GENERIC', toolCallId: id, content: `Created At: a\nA1: ${label}` }
    ];
    const write = (file: string, list: object[]) => fs.writeFileSync(file, list.map((r) => JSON.stringify(r)).join('\n') + '\n');

    it('Yes pulled from the transcript -> overwrite; logged with downgrade_pull', () => {
      const file = asked();
      write(file, rows(`${DOWNGRADE_MARKER} Run it?`, DOWNGRADE_LABELS.yes));
      const retry = run('pre-tool-use', invoke('flash', { transcriptPath: file }));
      expect(JSON.parse(retry.stdout.toString())).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
      expect(logRows().filter((r) => r.event === 'agent_call').pop()!.downgrade_pull).toBe(true);
      // the answer is consumed: the late PostToolUse for the same question records nothing
      run('post-tool-use', askPost(`A1: ${DOWNGRADE_LABELS.off}`));
      expect(logRows().filter((r) => r.event === 'ask_answer').pop()!.outcome).toBe('not_asked');
    });

    it('No, keep flash and the session-off answer pulled from the transcript', () => {
      const file = asked();
      write(file, rows(`${DOWNGRADE_MARKER} Run it?`, DOWNGRADE_LABELS.keep));
      expect(run('pre-tool-use', invoke('flash', { transcriptPath: file })).stdout.toString()).toBe('');
      expect(logRows().filter((r) => r.event === 'agent_call').pop()!.downgrade).toBe('answered');
    });

    it("don't ask again, pulled -> switches the conversation off", () => {
      const file = asked();
      write(file, rows(`${DOWNGRADE_MARKER} Run it?`, DOWNGRADE_LABELS.off));
      expect(run('pre-tool-use', invoke('flash', { transcriptPath: file })).stdout.toString()).toBe('');
      expect(state().off).toBeDefined();
    });

    it('an answer row that is not there yet passes the retry once, nothing is guessed', () => {
      const file = asked();
      write(file, [rows(`${DOWNGRADE_MARKER} Run it?`, 'x')[0]]);
      expect(run('pre-tool-use', invoke('flash', { transcriptPath: file })).stdout.toString()).toBe('');
      expect(state().entries.every((e: any) => !e.answered)).toBe(true);
    });
  });
});
