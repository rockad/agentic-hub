/**
 * Session model fallback: when SessionStart / PostModelSwitch never ran for a session (plugins reloaded mid-session, a
 * resumed or headless session), the hook learns the model from the tail of the transcript and persists it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPreToolUse, onUserPromptSubmit, type HookDeps, type HookInput } from '../claude/hook.ts';
import {
  TRANSCRIPT_RECHECK_MS,
  TRANSCRIPT_TAIL_BYTES,
  createSessionModelLearner,
  isTranscriptPath,
  modelFromTranscript,
  readSessionRecord,
  readTranscriptTail,
  writeSessionRecord,
  type TailReader
} from '../claude/session-model.ts';
import type { Dispatch } from '../claude/logic.ts';
import { memoryApprovals } from './elevation-helpers.ts';
import { HAIKU, catalogue, memoryDowngrades } from './downgrade-helpers.ts';

const T0 = 1_800_000_000_000;
let home = '';
let sessions = '';
let projectDir = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sm-'));
  projectDir = path.join(home, '.claude', 'projects', 'proj');
  sessions = path.join(home, '.config', 'jev', 'claude-sessions');
  fs.mkdirSync(projectDir, { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const assistant = (model: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'hello' }] }, ...extra });
const user = (text = 'hi') => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
function transcript(lines: string[], name = 'sess.jsonl'): string {
  const file = path.join(projectDir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('modelFromTranscript', () => {
  it('returns the model of the last assistant line', () => {
    const f = transcript([assistant('claude-opus-5-5'), user(), assistant('claude-sonnet-5-5'), user()]);
    expect(modelFromTranscript(f, { home })).toBe('claude-sonnet-5-5');
  });

  it('skips <synthetic> and ids that are not Claude models, and walks on to the next assistant line', () => {
    const f = transcript([assistant('claude-sonnet-5-5'), assistant('<synthetic>'), assistant('gpt-5'), assistant('claude-nonsense-1'), assistant('claude-sonnet-5-5 ; rm')]);
    expect(modelFromTranscript(f, { home })).toBe('claude-sonnet-5-5');
  });

  it('skips sidechain lines', () => {
    const f = transcript([assistant('claude-sonnet-5-5'), assistant('claude-haiku-5-5', { isSidechain: true })]);
    expect(modelFromTranscript(f, { home })).toBe('claude-sonnet-5-5');
  });

  it('is null when there is no usable assistant line', () => {
    expect(modelFromTranscript(transcript([user(), assistant('<synthetic>')]), { home })).toBeNull();
  });

  it('tolerates a partial first line in the tail', () => {
    const f = transcript([assistant('claude-opus-5-5')]);
    const tail: TailReader = () => `ssistant","message":{"model":"claude-haiku-5-5"}}\n${assistant('claude-sonnet-5-5')}\n`;
    expect(modelFromTranscript(f, { home, readTail: tail })).toBe('claude-sonnet-5-5');
    // a partial line alone says nothing
    expect(modelFromTranscript(f, { home, readTail: () => '{"type":"assistant","message":{"model":"claude-haiku' })).toBeNull();
  });

  it('is null for an empty file, a missing file and binary garbage, and never throws', () => {
    const empty = path.join(projectDir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    expect(modelFromTranscript(empty, { home })).toBeNull();
    expect(modelFromTranscript(path.join(projectDir, 'missing.jsonl'), { home })).toBeNull();
    const junk = path.join(projectDir, 'junk.jsonl');
    fs.writeFileSync(junk, Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37 + 11) % 256)));
    expect(modelFromTranscript(junk, { home })).toBeNull();
    expect(modelFromTranscript(transcript(['{"type":"assistant"', 'null', '[]', '"x"', '{"type":"assistant","message":null}']), { home })).toBeNull();
    expect(modelFromTranscript(transcript([assistant('claude-sonnet-5-5')]), { home, readTail: () => { throw new Error('boom'); } })).toBeNull();
    expect(modelFromTranscript(undefined as unknown as string, { home })).toBeNull();
  });

  it('reads only the tail of a 2 MB file: a line far from the end is ignored', () => {
    const filler = user('x'.repeat(1000));
    const lines = [assistant('claude-opus-5-5'), ...Array.from({ length: 2200 }, () => filler)];
    const f = transcript(lines);
    expect(fs.statSync(f).size).toBeGreaterThan(2 * 1024 * 1024);
    // the only assistant line is about 2 MB from the end, outside the 256 KB tail
    expect(modelFromTranscript(f, { home })).toBeNull();
    // and the injected reader is asked for exactly the tail size, nothing more
    const asked: number[] = [];
    modelFromTranscript(f, { home, readTail: (file, bytes) => (asked.push(bytes), readTranscriptTail(file, bytes)) });
    expect(asked).toEqual([TRANSCRIPT_TAIL_BYTES]);
    expect(TRANSCRIPT_TAIL_BYTES).toBe(256 * 1024);
  });

  it('the default reader returns at most the tail, starting on a line boundary', () => {
    const f = transcript([user('a'.repeat(400_000)), assistant('claude-haiku-5-5')]);
    const text = readTranscriptTail(f, TRANSCRIPT_TAIL_BYTES)!;
    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_TAIL_BYTES);
    expect(text.startsWith('{"type":"assistant"')).toBe(true);
    expect(modelFromTranscript(f, { home })).toBe('claude-haiku-5-5');
  });

  describe('path safety', () => {
    it('reads only a .jsonl under <home>/.claude/projects', () => {
      const good = transcript([assistant('claude-sonnet-5-5')]);
      expect(isTranscriptPath(good, home)).toBe(true);

      const outside = path.join(home, 'elsewhere.jsonl');
      fs.writeFileSync(outside, assistant('claude-sonnet-5-5') + '\n');
      expect(modelFromTranscript(outside, { home })).toBeNull();

      const wrongExt = path.join(projectDir, 'notes.txt');
      fs.writeFileSync(wrongExt, assistant('claude-sonnet-5-5') + '\n');
      expect(modelFromTranscript(wrongExt, { home })).toBeNull();

      expect(modelFromTranscript(path.join(projectDir, '..', '..', '..', 'elsewhere.jsonl'), { home })).toBeNull();
      expect(isTranscriptPath('/etc/passwd', home)).toBe(false);
      expect(isTranscriptPath('', home)).toBe(false);
      expect(isTranscriptPath(`${good}\0.jsonl`, home)).toBe(false);
    });

    it('does not follow a symlink out of the projects directory', () => {
      const outside = path.join(home, 'secret.jsonl');
      fs.writeFileSync(outside, assistant('claude-sonnet-5-5') + '\n');
      const link = path.join(projectDir, 'link.jsonl');
      fs.symlinkSync(outside, link);
      expect(isTranscriptPath(link, home)).toBe(false);
      expect(modelFromTranscript(link, { home })).toBeNull();
    });

    it('refuses a directory that is named like a transcript', () => {
      const dir = path.join(projectDir, 'dir.jsonl');
      fs.mkdirSync(dir);
      expect(modelFromTranscript(dir, { home })).toBeNull();
    });
  });
});

describe('the learner (stored record, 60 second re-check)', () => {
  function learner(extra: { reads?: string[]; clock?: { t: number } } = {}) {
    const clock = extra.clock ?? { t: T0 };
    const reads = extra.reads ?? [];
    const l = createSessionModelLearner({
      dir: sessions,
      home,
      now: () => clock.t,
      readTail: (file, bytes) => (reads.push(file), readTranscriptTail(file, bytes))
    });
    return { l, clock, reads };
  }

  it('learns a missing model, writes the record owner-only with source, updated_at and checked_at', () => {
    const f = transcript([user(), assistant('claude-sonnet-5-5')]);
    const { l } = learner();

    expect(l('s1', f)).toEqual({ model: 'claude-sonnet-5-5', source: 'transcript' });

    const rec = readSessionRecord(sessions, 's1')!;
    expect(rec).toMatchObject({ model: 'claude-sonnet-5-5', source: 'transcript', updated_at: new Date(T0).toISOString(), checked_at: new Date(T0).toISOString() });
    expect(fs.statSync(path.join(sessions, 's1.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(sessions).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(sessions).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('does not read the transcript again within 60 seconds', () => {
    const f = transcript([assistant('claude-sonnet-5-5')]);
    const { l, clock, reads } = learner();
    l('s1', f);
    clock.t += TRANSCRIPT_RECHECK_MS - 1;

    expect(l('s1', f)).toEqual({ model: 'claude-sonnet-5-5', source: 'transcript' });
    expect(reads.length).toBe(1);
  });

  it('after 60 seconds re-checks, and updates the file when the last assistant model differs', () => {
    const f = transcript([assistant('claude-opus-5-5')]);
    const { l, clock, reads } = learner();
    l('s1', f);
    fs.appendFileSync(f, assistant('claude-sonnet-5-5') + '\n');
    clock.t += TRANSCRIPT_RECHECK_MS;

    expect(l('s1', f)).toEqual({ model: 'claude-sonnet-5-5', source: 'transcript' });
    expect(reads.length).toBe(2);
    expect(readSessionRecord(sessions, 's1')).toMatchObject({ model: 'claude-sonnet-5-5', source: 'transcript', updated_at: new Date(clock.t).toISOString(), checked_at: new Date(clock.t).toISOString() });
  });

  it('a re-check that agrees keeps updated_at and moves checked_at', () => {
    const f = transcript([assistant('claude-opus-5-5')]);
    const { l, clock } = learner();
    l('s1', f);
    clock.t += 2 * TRANSCRIPT_RECHECK_MS;
    l('s1', f);
    expect(readSessionRecord(sessions, 's1')).toMatchObject({ updated_at: new Date(T0).toISOString(), checked_at: new Date(clock.t).toISOString() });
  });

  it('a re-check that finds nothing keeps the stored model (and does not re-read every call)', () => {
    const f = transcript([assistant('claude-opus-5-5')]);
    const { l, clock, reads } = learner();
    l('s1', f);
    fs.writeFileSync(f, 'garbage\n');
    clock.t += TRANSCRIPT_RECHECK_MS;

    expect(l('s1', f)).toEqual({ model: 'claude-opus-5-5', source: 'transcript' });
    expect(l('s1', f)).toEqual({ model: 'claude-opus-5-5', source: 'transcript' });
    expect(reads.length).toBe(2);
  });

  it('a SessionStart / PostModelSwitch record (no source) is authoritative: the transcript is never read', () => {
    writeSessionRecord(sessions, 's1', { model: 'claude-opus-5-5', updated_at: new Date(T0).toISOString() });
    const f = transcript([assistant('claude-sonnet-5-5')]);
    const { l, clock, reads } = learner();
    clock.t += 10 * TRANSCRIPT_RECHECK_MS;

    expect(l('s1', f)).toBeNull();
    expect(reads.length).toBe(0);
    expect(readSessionRecord(sessions, 's1')).toMatchObject({ model: 'claude-opus-5-5' });
  });

  it('fails open: a corrupt or missing transcript, an outside path and a failing reader are all null and write nothing', () => {
    const { l } = learner();
    expect(l('s1', transcript(['not json at all']))).toBeNull();
    expect(l('s1', path.join(projectDir, 'missing.jsonl'))).toBeNull();
    const outside = path.join(home, 'x.jsonl');
    fs.writeFileSync(outside, assistant('claude-sonnet-5-5') + '\n');
    expect(l('s1', outside)).toBeNull();
    const boom = createSessionModelLearner({ dir: sessions, home, readTail: () => { throw new Error('boom'); } });
    expect(boom('s1', transcript([assistant('claude-sonnet-5-5')]))).toBeNull();
    expect(fs.existsSync(path.join(sessions, 's1.json'))).toBe(false);
  });

  it('still answers when the store cannot be written', () => {
    fs.mkdirSync(path.dirname(sessions), { recursive: true });
    fs.writeFileSync(sessions, 'a file where the directory should be');
    const f = transcript([assistant('claude-sonnet-5-5')]);
    expect(createSessionModelLearner({ dir: sessions, home })('s1', f)).toEqual({ model: 'claude-sonnet-5-5', source: 'transcript' });
  });
});

describe('through the hook (no session file, a transcript whose last assistant model is sonnet)', () => {
  const flashRec: Dispatch = { subagent: 'general-purpose', tier: 'flash', model: 'sonnet', effort: 'low', confidence: 0.9 };
  const turn = { turn: 't1', promptId: 'p1', intent: { models: [] }, rec: { subagent: 'general-purpose', tier: 'flash', model: 'sonnet' }, recEffort: 'low' };

  function setup(opts: { clock?: { t: number }; withLearner?: boolean } = {}) {
    const logs: Record<string, unknown>[] = [];
    const reads: string[] = [];
    const clock = opts.clock ?? { t: T0 };
    const learn = createSessionModelLearner({
      dir: sessions,
      home,
      now: () => clock.t,
      readTail: (file, bytes) => (reads.push(file), readTranscriptTail(file, bytes))
    });
    const d: HookDeps = {
      readMode: async () => 'on',
      // the live reader: the stored file, whoever wrote it
      readSessionModel: (id) => (id ? (readSessionRecord(sessions, id)?.model ?? null) : null),
      ...(opts.withLearner === false ? {} : { learnSessionModel: learn }),
      readQuotaStrategy: async () => 'unknown',
      dispatch: async () => flashRec,
      log: (e) => logs.push(e),
      readTurn: () => turn as any,
      saveTurn: () => {},
      approvals: memoryApprovals(),
      downgrades: memoryDowngrades(),
      rankContext: () => catalogue(),
      rateTask: async () => HAIKU,
      now: () => clock.t,
      env: {}
    };
    return { d, logs, reads, clock };
  }
  const agent = (tool_input: Record<string, unknown>, extra: Partial<HookInput> = {}): HookInput => ({
    session_id: 's1',
    prompt_id: 'p1',
    tool_name: 'Agent',
    tool_input,
    ...extra
  });
  const out = (o: Awaited<ReturnType<typeof onPreToolUse>>) => (o?.hookSpecificOutput ?? {}) as Record<string, any>;

  it('a model-less call for a trivial task now gets the downgrade question, and the session file is written', async () => {
    const f = transcript([user(), assistant('claude-sonnet-5-5')]);
    const { d, logs } = setup();

    const o = out(await onPreToolUse(agent({ description: "Get today's date from the shell", prompt: 'Run date.' }, { transcript_path: f }), d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-downgrade:haiku]');
    expect(readSessionRecord(sessions, 's1')).toMatchObject({ model: 'claude-sonnet-5-5', source: 'transcript' });
    expect(logs[0]).toMatchObject({ sessionModel: 'claude-sonnet-5-5', session_model_source: 'transcript' });
  });

  it('an explicit opus call now gets the elevation deny', async () => {
    const f = transcript([assistant('claude-sonnet-5-5')]);
    const { d, logs } = setup();

    const o = out(await onPreToolUse(agent({ description: 'Review the parser', prompt: 'Review it.', model: 'opus' }, { transcript_path: f }), d));

    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('[jev-elevate:opus]');
    expect(logs[0]).toMatchObject({ sessionModel: 'claude-sonnet-5-5', session_model_source: 'transcript', elevation: 'denied' });
  });

  it('without transcript_path, or when the transcript is corrupt, nothing changes: no guard, no file', async () => {
    const { d, logs } = setup();
    const call = { description: "Get today's date from the shell", prompt: 'Run date.' };
    expect(await onPreToolUse(agent(call), d)).toBeNull();
    expect(await onPreToolUse(agent(call, { transcript_path: transcript(['garbage', '{']) }), d)).toBeNull();
    expect(await onPreToolUse(agent(call, { transcript_path: '/etc/passwd' }), d)).toBeNull();
    expect(fs.existsSync(path.join(sessions, 's1.json'))).toBe(false);
    expect(logs.every((l) => l.sessionModel === null && l.session_model_source === null)).toBe(true);
  });

  it('a deps without the learner behaves as before', async () => {
    const f = transcript([assistant('claude-sonnet-5-5')]);
    const { d, logs } = setup({ withLearner: false });
    const o = out(await onPreToolUse(agent({ description: 'x', prompt: 'y', model: 'opus' }, { transcript_path: f }), d));
    // no session model: no elevation guard (today's behaviour); the transcript is not consulted and nothing is written
    expect(o.permissionDecisionReason ?? '').not.toContain('[jev-elevate');
    expect(logs[0]).toMatchObject({ sessionModel: null, session_model_source: null });
    expect(fs.existsSync(path.join(sessions, 's1.json'))).toBe(false);
  });

  it('a second call does not read the transcript again', async () => {
    const f = transcript([assistant('claude-sonnet-5-5')]);
    const { d, reads, logs } = setup();
    await onPreToolUse(agent({ description: 'a', prompt: 'b', model: 'opus' }, { transcript_path: f }), d);
    await onPreToolUse(agent({ description: 'c', prompt: 'd', model: 'opus' }, { transcript_path: f }), d);
    expect(reads.length).toBe(1);
    expect(logs.map((l) => l.session_model_source)).toEqual(['transcript', 'transcript']);
  });

  it('a transcript that disagrees after 60 seconds updates the stored model', async () => {
    const f = transcript([assistant('claude-sonnet-5-5')]);
    const { d, clock, logs } = setup();
    await onPreToolUse(agent({ description: 'a', prompt: 'b', model: 'opus' }, { transcript_path: f }), d);
    // the user switched to opus while no hook ran
    fs.appendFileSync(f, assistant('claude-opus-5-5') + '\n');
    clock.t += TRANSCRIPT_RECHECK_MS;

    await onPreToolUse(agent({ description: 'a', prompt: 'b', model: 'opus' }, { transcript_path: f }), d);

    expect(logs[1]).toMatchObject({ sessionModel: 'claude-opus-5-5', session_model_source: 'transcript' });
    expect(logs[1].elevation).toBeUndefined();
    expect(readSessionRecord(sessions, 's1')?.model).toBe('claude-opus-5-5');
  });

  it('a stored SessionStart model stays authoritative and is logged as stored', async () => {
    writeSessionRecord(sessions, 's1', { model: 'claude-opus-5-5' });
    const f = transcript([assistant('claude-sonnet-5-5')]);
    const { d, reads, logs } = setup();

    await onPreToolUse(agent({ description: 'a', prompt: 'b', model: 'opus' }, { transcript_path: f }), d);

    expect(reads.length).toBe(0);
    expect(logs[0]).toMatchObject({ sessionModel: 'claude-opus-5-5', session_model_source: 'stored' });
  });

  it('UserPromptSubmit learns it too and logs the source, never any transcript content', async () => {
    const f = transcript([assistant('claude-sonnet-5-5')]);
    const { d, logs } = setup();

    const o = await onUserPromptSubmit({ session_id: 's1', prompt: 'Find where the quota file is written', transcript_path: f }, d);

    expect(o).not.toBeNull();
    expect(logs[0]).toMatchObject({ hook: 'UserPromptSubmit', sessionModel: 'claude-sonnet-5-5', session_model_source: 'transcript' });
    expect(readSessionRecord(sessions, 's1')).toMatchObject({ source: 'transcript' });
    expect(JSON.stringify(logs)).not.toContain('hello');
    expect(JSON.stringify(logs)).not.toContain(f);
  });
});
