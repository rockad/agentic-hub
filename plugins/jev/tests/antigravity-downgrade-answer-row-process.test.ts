/**
 * The downgrade answer row through the real hook process, with a real-shaped (id-less) transcript: PostToolUse records
 * the ask's stepIdx on the pending question even when the row is not written yet (no_row), and the PreToolUse pull then
 * reads only that row, never the output of a tool that ran in parallel with the ask.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downgradeMarker, downgradeSignature, DOWNGRADE_LABELS } from '../antigravity/downgrade.ts';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const CONV = 'conv-dg-row';

let home = '';
const sessions = () => path.join(home, '.config', 'jev', 'antigravity-sessions');
const stateFile = () => path.join(sessions(), `${CONV}.downgrade.json`);
const logFile = () => path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
const state = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
const logRows = (): Record<string, any>[] =>
  fs.existsSync(logFile()) ? fs.readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dg-row-proc-'));
  fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(event: string, input: object) {
  return Bun.spawnSync(['bun', HOOK, event], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: {
      ...process.env,
      HOME: home,
      JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'),
      JEV_OPENROUTER_API_KEY: '',
      OPENROUTER_API_KEY: '',
      JEV_DOWNGRADE: 'ask'
    }
  });
}

const ARGS = { TypeName: 'self', Role: 'worker', Prompt: 'rename the files in the folder' };
const SIGNATURE = downgradeSignature(ARGS);
const QUESTION = `${downgradeMarker(SIGNATURE)} Run 'self' on flash_lite?`;
const YES = DOWNGRADE_LABELS.yes;
const KEEP = DOWNGRADE_LABELS.keep;
const HEADER = 'Created At: 2027-01-15T10:00:05+02:00\nCompleted At: 2027-01-15T10:00:09+02:00\n';

const invoke = (extra: Record<string, unknown> = {}) => ({
  conversationId: CONV,
  modelName: 'gemini-3.8-flash-low',
  lastUserInput: 'sweep the folder',
  stepIdx: 3,
  toolCall: { name: 'invoke_subagent', args: { ...ARGS, Model: 'flash' } },
  ...extra
});
// The ask has no tool call id here, like a real PostToolUse for Antigravity; its answer row is step 7.
const askPost = () => ({
  conversationId: CONV,
  stepIdx: 7,
  toolCall: { name: 'ask_question', args: { questions: [{ question: QUESTION, options: Object.values(DOWNGRADE_LABELS) }] } }
});
const planner = { step_index: 5, type: 'PLANNER_RESPONSE', content: '', tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo hi' } }, { name: 'ask_question', args: askPost().toolCall.args }] };
const cmdOutput = { step_index: 6, type: 'GENERIC', content: `${HEADER}Command output:\nA1: ${YES}` };
const askRow = (label: string) => ({ step_index: 7, type: 'GENERIC', content: `${HEADER}A1: ${label}` });
const write = (file: string, rows: object[]) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

function asked(): string {
  fs.mkdirSync(sessions(), { recursive: true });
  fs.writeFileSync(
    stateFile(),
    JSON.stringify({ entries: [], ratings: [{ signature: SIGNATURE, choice: 'flash_lite', p: [0.03, 0.83, 0.14, 0], real: true, expires_at: Date.now() + 600_000 }] })
  );
  expect(JSON.parse(run('pre-tool-use', invoke()).stdout.toString()).decision).toBe('deny');
  return path.join(home, 'transcript_full.jsonl');
}

describe('Antigravity downgrade: the recorded answer row, through the hook process', () => {
  it('PostToolUse with no row yet records stepIdx 7 on the pending question and logs no_row', () => {
    asked();
    expect(run('post-tool-use', askPost()).stdout.toString().trim()).toBe('{}');
    const row = logRows().find((r) => r.event === 'ask_answer')!;
    expect(row.outcome).toBe('no_row');
    expect(row.answer_step_recorded).toBe(true);
    expect(state().entries.find((e: any) => !e.answered).answer_step).toBe(7);
  });

  it('the pull reads row 7 only: the parallel output saying "Yes, flash_lite" is not taken, the ask\'s own "No" is', () => {
    const file = asked();
    run('post-tool-use', askPost());
    write(file, [planner, cmdOutput, askRow(KEEP)]);
    const retry = run('pre-tool-use', invoke({ transcriptPath: file }));
    expect(retry.stdout.toString()).toBe('');
    const row = logRows().filter((r) => r.event === 'agent_call').pop()!;
    expect(row.downgrade).toBe('answered');
    expect(row.downgrade_pull).toBe(true);
    expect(state().entries.find((e: any) => e.answered).ask_id).toBe('step:7#0');
  });

  it('with row 7 not written yet, only the parallel output is there: nothing is applied', () => {
    const file = asked();
    run('post-tool-use', askPost());
    write(file, [planner, cmdOutput]);
    const retry = run('pre-tool-use', invoke({ transcriptPath: file }));
    expect(retry.stdout.toString()).toBe('');
    expect(logRows().filter((r) => r.event === 'agent_call').pop()!.downgrade_skip).toBe('already-asked');
    expect(state().entries.every((e: any) => !e.answered)).toBe(true);
  });

  it('without a PostToolUse (no recorded row) a multi-tool planner step is never read', () => {
    const file = asked();
    write(file, [planner, cmdOutput, askRow(YES)]);
    const retry = run('pre-tool-use', invoke({ transcriptPath: file }));
    expect(retry.stdout.toString()).toBe('');
    expect(state().entries.every((e: any) => !e.answered)).toBe(true);
  });

  it('a Yes in the ask\'s own row applies flash_lite, and a late PostToolUse for it records nothing again', () => {
    const file = asked();
    run('post-tool-use', askPost());
    write(file, [planner, cmdOutput, askRow(YES)]);
    const retry = run('pre-tool-use', invoke({ transcriptPath: file }));
    expect(JSON.parse(retry.stdout.toString())).toEqual({ decision: 'allow', overwrite: { Model: 'flash_lite' } });
    run('post-tool-use', { ...askPost(), content: `A1: ${DOWNGRADE_LABELS.off}` });
    expect(logRows().filter((r) => r.event === 'ask_answer').pop()!.outcome).toBe('not_asked');
    expect(state().off).toBeUndefined();
  });

  it('PostToolUse that finds the row itself consumes it under the step key (no "undefined#0")', () => {
    asked();
    run('post-tool-use', { ...askPost(), content: `A1: ${YES}` });
    expect(logRows().find((r) => r.event === 'ask_answer')!.outcome).toBe('recorded');
    expect(state().entries.find((e: any) => e.answered).ask_id).toBe('step:7#0');
  });
});
