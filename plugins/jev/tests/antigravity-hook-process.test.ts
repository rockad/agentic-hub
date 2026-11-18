import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const FIXTURE_PATH = path.join(import.meta.dir, 'fixtures', 'agy-invoke-subagent.json');
/** SYNTHETIC ask_question PostToolUse payload (not a real capture, see the `_synthetic` note inside); `content` says "Yes, once". */
const SYNTHETIC_ASK = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'agy-ask-question-posttooluse.synthetic.json'), 'utf8'));

let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-proc-'));
  fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
  // Write a quota-state.json with active_model as Flash
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'),
    JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' })
  );
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(event: string, input: object, extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync(['bun', HOOK, event], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: {
      ...process.env,
      HOME: home,
      JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'),
      // These tests are about the elevation guard: no downgrade rating, so no router call (the downgrade has its own tests).
      JEV_DOWNGRADE: 'off',
      ...extraEnv
    }
  });
}

describe('Antigravity hook as a process', () => {
  it('passes the captured real payload fixture through with empty stdout (no explicit allow)', () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    const proc = run('pre-tool-use', raw);

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe('');
  });

  it('denies Model: pro on a flash session with prescribed ask_question options', () => {
    const payload = {
      conversationId: 'conv-proc-1',
      lastUserInput: 'Invoke an expert agent on pro',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 'call_1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert',
          Prompt: 'solve',
          Model: 'pro'
        }
      }
    };

    const proc = run('pre-tool-use', payload);
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('[jev-elevate:pro]');
    expect(out.reason).toContain('ask_question');
  });

  it('post-tool-use records Yes once and subsequent pre-tool-use allows', () => {
    const payloadElevate = {
      conversationId: 'conv-proc-2',
      lastUserInput: 'Invoke expert on pro',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 'call_1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert',
          Prompt: 'solve',
          Model: 'pro'
        }
      }
    };

    // 1st attempt: denied
    const p1 = run('pre-tool-use', payloadElevate);
    expect(JSON.parse(p1.stdout.toString()).decision).toBe('deny');

    // User answers ask_question with 'Yes, once'
    const postPayload = {
      conversationId: 'conv-proc-2',
      toolCall: {
        id: 'call_ask',
        name: 'ask_question',
        args: {
          questions: [
            {
              question: "[jev-elevate:pro] Allow subagent 'expert' to run on pro?",
              options: ['(Recommended) Yes, once', 'No']
            }
          ]
        }
      },
      content: 'A1: (Recommended) Yes, once'
    };

    const pPost = run('post-tool-use', postPayload);
    expect(pPost.exitCode).toBe(0);

    // 2nd attempt: now allowed via approval!
    const p2 = run('pre-tool-use', payloadElevate);
    expect(p2.exitCode).toBe(0);
    const out2 = JSON.parse(p2.stdout.toString());
    expect(out2.decision).toBe('allow');

    // 3rd attempt: 'once' was consumed, so denied again!
    const p3 = run('pre-tool-use', payloadElevate);
    expect(p3.exitCode).toBe(0);
    const out3 = JSON.parse(p3.stdout.toString());
    expect(out3.decision).toBe('deny');
  });

  it('passes everything through with empty stdout when Jev mode is off', () => {
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'off' } }));

    const payload = {
      conversationId: 'conv-proc-off',
      lastUserInput: 'Invoke expert on pro',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 'call_1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert',
          Model: 'pro'
        }
      }
    };

    const proc = run('pre-tool-use', payload);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe('');
    expect(fs.existsSync(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl'))).toBe(false);
  });

  it('fails open on malformed stdin without approving anything: empty stdout on pre-tool-use, {} on post-tool-use', () => {
    const pre = Bun.spawnSync(['bun', HOOK, 'pre-tool-use'], {
      stdin: new TextEncoder().encode('{ not-json'),
      env: { ...process.env, HOME: home }
    });
    expect(pre.exitCode).toBe(0);
    expect(pre.stdout.toString().trim()).toBe('');

    const post = Bun.spawnSync(['bun', HOOK, 'post-tool-use'], {
      stdin: new TextEncoder().encode('{ not-json'),
      env: { ...process.env, HOME: home }
    });
    expect(post.exitCode).toBe(0);
    expect(JSON.parse(post.stdout.toString())).toEqual({});
  });

  it('prints empty stdout for empty stdin, for a tool other than invoke_subagent and for an unreadable config', () => {
    const empty = Bun.spawnSync(['bun', HOOK, 'pre-tool-use'], { stdin: new TextEncoder().encode(''), env: { ...process.env, HOME: home, JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json') } });
    expect(empty.stdout.toString().trim()).toBe('');

    const other = run('pre-tool-use', { conversationId: 'c', toolCall: { id: 'x', name: 'run_command', args: { CommandLine: 'ls' } } });
    expect(other.stdout.toString().trim()).toBe('');

    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), '{ broken');
    const broken = run('pre-tool-use', { conversationId: 'c', modelName: 'gemini-3.8-flash-low', toolCall: { id: 'x', name: 'invoke_subagent', args: { Model: 'pro' } } });
    expect(broken.exitCode).toBe(0);
    expect(broken.stdout.toString().trim()).toBe('');
  });

  it('post-tool-use always prints {}', () => {
    const proc = run('post-tool-use', SYNTHETIC_ASK);
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual({});
  });

  it('keeps an explicit allow where Jev deliberately approves: an instructed model and a clamp', () => {
    const instructed = run('pre-tool-use', {
      conversationId: 'conv-instructed',
      lastUserInput: 'use manual pro approval for this',
      modelName: 'gemini-3.8-flash-low',
      toolCall: { id: 'c', name: 'invoke_subagent', args: { TypeName: 'expert', Model: 'pro' } }
    });
    expect(JSON.parse(instructed.stdout.toString()).decision).toBe('allow');

    const clamped = run(
      'pre-tool-use',
      { conversationId: 'conv-clamp', lastUserInput: 'go', modelName: 'gemini-3.8-flash-low', toolCall: { id: 'c', name: 'invoke_subagent', args: { TypeName: 'expert', Model: 'pro' } } },
      { JEV_ELEVATION: 'clamp' }
    );
    expect(JSON.parse(clamped.stdout.toString())).toMatchObject({ decision: 'allow', overwrite: { Model: 'flash' } });
  });

  it('logs decisions with prompt length and sha256 hash, never raw prompt text', () => {
    const payload = {
      conversationId: 'conv-proc-privacy',
      lastUserInput: 'SECRET_PROMPT_CONTENT_NEVER_LOG_THIS',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 'call_1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'worker',
          Model: 'flash_lite'
        }
      }
    };

    run('pre-tool-use', payload);

    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).not.toContain('SECRET_PROMPT_CONTENT_NEVER_LOG_THIS');
    const parsed = JSON.parse(content.trim().split('\n')[0]);
    expect(parsed.event).toBe('agent_call');
    expect(parsed.prompt_length).toBe('SECRET_PROMPT_CONTENT_NEVER_LOG_THIS'.length);
    // The same fingerprint the telemetry lines carry: length and the first 12 hex of the sha256, never the full digest.
    expect(parsed.prompt_hash).toBe(createHash('sha256').update('SECRET_PROMPT_CONTENT_NEVER_LOG_THIS').digest('hex').slice(0, 12));
    expect(parsed.prompt_hash).toHaveLength(12);
  });

  it('does not load ~/.config/jev/env or the plugin .env: it makes no network call and needs no keys', () => {
    expect(fs.readFileSync(HOOK, 'utf8')).not.toContain('loadEnvFile');
  });
});

describe('Antigravity elevation answer through the real hook process (SYNTHETIC ask_question payload)', () => {
  const elevate = (conv: string) => ({
    conversationId: conv,
    lastUserInput: 'Invoke expert on pro',
    modelName: 'gemini-3.8-flash-low',
    toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } }
  });
  const pre = (conv: string) => JSON.parse(run('pre-tool-use', elevate(conv)).stdout.toString());
  /** The synthetic payload for this conversation; `content` replaced, or removed when undefined. */
  const answered = (conv: string, content: string | undefined, extra: Record<string, unknown> = {}) => {
    const p: Record<string, any> = { ...SYNTHETIC_ASK, conversationId: conv, ...extra };
    if (content === undefined) delete p.content;
    else p.content = content;
    return p;
  };
  const approvalsOf = (conv: string) => {
    const file = path.join(home, '.config', 'jev', 'antigravity-sessions', `${conv}.approvals.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).approvals : [];
  };

  it('SYNTHETIC: a payload with no content field approves nothing, although args.questions[].options lists "Yes, once"', () => {
    expect(SYNTHETIC_ASK.toolCall.args.questions[0].options).toContain('(Recommended) Yes, once');
    expect(pre('c-nocontent').decision).toBe('deny');

    const post = run('post-tool-use', answered('c-nocontent', undefined));

    expect(post.exitCode).toBe(0);
    expect(approvalsOf('c-nocontent')).toEqual([]);
    expect(pre('c-nocontent').decision).toBe('deny');
  });

  it('SYNTHETIC: "No, not even once" approves nothing', () => {
    expect(pre('c-notonce').decision).toBe('deny');

    run('post-tool-use', answered('c-notonce', 'Created At: x\nCompleted At: y\nA1: No, not even once'));

    expect(approvalsOf('c-notonce')).toEqual([]);
    expect(pre('c-notonce').decision).toBe('deny');
  });

  it('SYNTHETIC: the exact No label approves nothing', () => {
    expect(pre('c-no').decision).toBe('deny');

    run('post-tool-use', answered('c-no', 'Created At: x\nCompleted At: y\nA1: No, proceed on flash'));

    expect(approvalsOf('c-no')).toEqual([]);
    expect(pre('c-no').decision).toBe('deny');
  });

  it('SYNTHETIC: an option-list-only or answer-less payload records nothing, whatever else it carries', () => {
    expect(pre('c-list').decision).toBe('deny');
    for (const content of [undefined, '', 'Created At: x\nCompleted At: y', 'Created At: x\nCompleted At: y\nA1: User Skipped']) {
      run('post-tool-use', answered('c-list', content, { lastUserInput: 'Yes, once', toolAction: 'Yes, for this session' }));
    }
    expect(approvalsOf('c-list')).toEqual([]);
  });

  it('SYNTHETIC: each exact label records its scope (the recommended tag and the A1 prefix are stripped)', () => {
    const cases: Array<[string, string]> = [
      ['A1: Yes, once', 'once'],
      ['A1: (Recommended) Yes, once', 'once'],
      ['A1: Yes, for the next 5 minutes', '5min'],
      ['A1: Yes, for this session', 'session']
    ];
    cases.forEach(([content, scope], i) => {
      const conv = `c-label-${i}`;
      expect(pre(conv).decision).toBe('deny');

      run('post-tool-use', answered(conv, `Created At: x\nCompleted At: y\n${content}`));

      expect(approvalsOf(conv)).toMatchObject([{ model: 'pro', scope }]);
      expect(pre(conv).decision).toBe('allow');
    });
  });

  it('SYNTHETIC: the denial tie still applies: an answer with no earlier denial records nothing', () => {
    run('post-tool-use', answered('c-tie', 'A1: Yes, for this session'));

    expect(approvalsOf('c-tie')).toEqual([]);
    expect(pre('c-tie').decision).toBe('deny');
  });

  it('SYNTHETIC: with several questions the marker question\'s own answer line is read', () => {
    const questions = [
      { question: 'Unrelated?', options: ['a', 'b'] },
      { question: "[jev-elevate:pro] Allow subagent 'expert' to run on pro?", options: ['Yes, once', 'No, proceed on flash'] }
    ];
    const withArgs = (conv: string, content: string) => answered(conv, content, { toolCall: { ...SYNTHETIC_ASK.toolCall, args: { questions } } });

    expect(pre('c-multi-a').decision).toBe('deny');
    run('post-tool-use', withArgs('c-multi-a', 'A1: Yes, once\nA2: No, proceed on flash'));
    expect(approvalsOf('c-multi-a')).toEqual([]);

    expect(pre('c-multi-b').decision).toBe('deny');
    run('post-tool-use', withArgs('c-multi-b', 'A1: whatever\nA2: Yes, once'));
    expect(approvalsOf('c-multi-b')).toMatchObject([{ model: 'pro', scope: 'once' }]);
  });

  it('handles a FIFO as transcriptPath in PostToolUse without hanging, recording nothing', () => {
    const fifoPath = path.join(home, 'transcript_fifo');
    const mk = Bun.spawnSync(['mkfifo', fifoPath]);
    if (mk.exitCode === 0) {
      expect(pre('c-fifo-proc').decision).toBe('deny');
      const start = Date.now();
      const post = run('post-tool-use', answered('c-fifo-proc', undefined, {
        transcriptPath: fifoPath,
        stepIdx: 2
      }));
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(3000);
      expect(post.exitCode).toBe(0);
      expect(post.stdout.toString().trim()).toBe('{}');
      expect(approvalsOf('c-fifo-proc')).toEqual([]);
    }
  });

  it('handles a transcript larger than the window (1.5 MB) with answer at the end: records approval in PostToolUse and subsequent pre-tool-use allows', () => {
    const largeFile = path.join(home, 'large_transcript_end.jsonl');
    // Write 1.5MB of padding before the target step (exceeds 1MB window)
    const padding = '{"step_index":0,"type":"GENERIC","content":"padding"}\n'.repeat(30_000);
    const line = '{"step_index":1,"type":"GENERIC","content":"A1: Yes, once"}\n';
    fs.writeFileSync(largeFile, padding + line);

    expect(pre('c-tail-proc').decision).toBe('deny');
    const post = run('post-tool-use', answered('c-tail-proc', undefined, {
      transcriptPath: largeFile,
      stepIdx: 1
    }));
    expect(post.exitCode).toBe(0);
    expect(post.stdout.toString().trim()).toBe('{}');
    expect(approvalsOf('c-tail-proc')).toMatchObject([{ model: 'pro', scope: 'once' }]);
    expect(pre('c-tail-proc').decision).toBe('allow');
  });

  it('handles a transcript larger than the window with answer outside the tail window: records nothing and pre-tool-use stays denied', () => {
    const largeFile = path.join(home, 'large_transcript_outside.jsonl');
    // Target step is at the very beginning
    const targetLine = '{"step_index":1,"type":"GENERIC","content":"A1: Yes, once"}\n';
    // 1.5 MB of padding after the target step, pushing it outside the 1 MB window
    const padding = '{"step_index":0,"type":"GENERIC","content":"padding"}\n'.repeat(30_000);
    fs.writeFileSync(largeFile, targetLine + padding);

    expect(pre('c-outside-proc').decision).toBe('deny');
    const post = run('post-tool-use', answered('c-outside-proc', undefined, {
      transcriptPath: largeFile,
      stepIdx: 1
    }));
    expect(post.exitCode).toBe(0);
    expect(post.stdout.toString().trim()).toBe('{}');
    expect(approvalsOf('c-outside-proc')).toEqual([]);
    expect(pre('c-outside-proc').decision).toBe('deny');
  });

  it('includes numeric epoch alongside timestamp in antigravity_decisions.jsonl', () => {
    const payload = {
      conversationId: 'c-epoch',
      modelName: 'gemini-3.8-flash-low',
      toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'worker', Model: 'flash' } }
    };
    run('pre-tool-use', payload);
    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(typeof last.epoch).toBe('number');
    expect(last.epoch).toBeGreaterThan(1_700_000_000);
    expect(typeof last.timestamp).toBe('string');
  });

  it('PostToolUse ask_question logs ask_answer line with exact required fields and outcome', () => {
    // 1. Initial deny so elevation is expected
    pre('c-ask-diag');

    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    const linesBefore = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').length : 0;

    // 2. PostToolUse with Yes, once on stdin
    const post = run('post-tool-use', answered('c-ask-diag', 'A1: (Recommended) Yes, once', { stepIdx: 5 }));
    expect(post.exitCode).toBe(0);
    expect(post.stdout.toString().trim()).toBe('{}');

    const linesAfter = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    expect(linesAfter.length).toBeGreaterThan(linesBefore);
    const entry = JSON.parse(linesAfter[linesAfter.length - 1]);

    expect(entry.event).toBe('ask_answer');
    expect(entry.session_id).toBe('c-ask-diag');
    expect(entry.stepIdx).toBe(5);
    expect(entry.content_on_stdin).toBe(true);
    expect(entry.marker_found).toBe(true);
    expect(entry.row_found).toBe(true);
    expect(entry.parsed).toEqual({ approved: true, scope: 'once' });
    expect(entry.outcome).toBe('recorded');
    expect(typeof entry.epoch).toBe('number');
    expect(typeof entry.timestamp).toBe('string');
  });

  it('PostToolUse ask_question logs outcome: rejected when user selects No', () => {
    pre('c-ask-rej');
    run('post-tool-use', answered('c-ask-rej', 'A1: No, proceed on flash', { stepIdx: 2 }));

    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);

    expect(entry.event).toBe('ask_answer');
    expect(entry.outcome).toBe('rejected');
    expect(entry.parsed).toEqual({ approved: false, scope: null });
  });

  it('PostToolUse ask_question logs outcome: not_denied when user approves without prior denial', () => {
    // No prior pre-tool-use deny for c-ask-notdenied
    run('post-tool-use', answered('c-ask-notdenied', 'A1: Yes, once', { stepIdx: 2 }));

    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);

    expect(entry.event).toBe('ask_answer');
    expect(entry.outcome).toBe('not_denied');
  });

  it('PostToolUse ask_question logs outcome: not_elevation when questions array lacks elevation marker', () => {
    const payload = {
      conversationId: 'c-nomark',
      toolCall: {
        id: 'call_q',
        name: 'ask_question',
        args: { questions: ['What color is the sky?'] }
      },
      content: 'A1: Blue'
    };
    run('post-tool-use', payload);

    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);

    expect(entry.event).toBe('ask_answer');
    expect(entry.outcome).toBe('not_elevation');
    expect(entry.marker_found).toBe(false);
  });

  it('PostToolUse ask_question without the elevation marker does not poll for an answer (returns at once)', () => {
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '{"step_index":0,"type":"USER_INPUT","content":"hi"}\n');
    const payload = {
      conversationId: 'c-nopoll',
      transcriptPath,
      stepIdx: 7, // no such row: a poll would wait the full 2 s
      toolCall: { id: 'call_q', name: 'ask_question', args: { questions: [{ question: 'Which flavour?' }] } }
    };
    const started = Date.now();
    const proc = run('post-tool-use', payload);
    const elapsed = Date.now() - started;
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe('{}');

    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.event).toBe('ask_answer');
    expect(entry.outcome).toBe('not_elevation');
    expect(entry.row_found).toBe(false);
    // Process start-up dominates; a 2 s poll would push well past this bound.
    expect(elapsed).toBeLessThan(1800);
  });

  it('PostToolUse invoke_subagent never takes the parent conversation id as the child id', () => {
    const parentId = '00000000-0000-4000-8000-000000000001';
    const parentLogs = path.join(home, '.gemini', 'antigravity-cli', 'brain', parentId, '.system_generated', 'logs');
    fs.mkdirSync(parentLogs, { recursive: true });
    fs.writeFileSync(path.join(parentLogs, 'transcript_full.jsonl'), '{"step_index":0,"model":"parent-model","type":"MODEL"}\n');
    const payload = {
      conversationId: parentId,
      content: `Subagent finished for parent ${parentId}`,
      toolCall: { id: 'call_s', name: 'invoke_subagent', args: { TypeName: 'worker', Model: 'flash' } }
    };
    run('post-tool-use', payload);
    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.event).toBe('subagent_served');
    expect(entry.child_conversation_id).toBeNull();
    expect(entry.served_model).toBeNull();
  });

  it('PostToolUse invoke_subagent logs subagent_served with child conversation ID and served model', () => {
    const childId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    // Create child transcript in simulated brain dir
    const brainLogs = path.join(home, '.gemini', 'antigravity-cli', 'brain', childId, '.system_generated', 'logs');
    fs.mkdirSync(brainLogs, { recursive: true });
    fs.writeFileSync(
      path.join(brainLogs, 'transcript_full.jsonl'),
      '{"step_index":0,"model":"gemini-3.8-pro-preview","type":"MODEL","content":"hello"}\n'
    );

    const payload = {
      conversationId: 'c-parent-session',
      toolCall: {
        id: 'call_sub',
        name: 'invoke_subagent',
        args: { TypeName: 'coder', Model: 'pro' }
      },
      content: `Subagent started. Conversation ID: ${childId}`
    };

    const res = run('post-tool-use', payload);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim()).toBe('{}');

    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);

    expect(entry.event).toBe('subagent_served');
    expect(entry.harness).toBe('antigravity');
    expect(entry.session_id).toBe('c-parent-session');
    expect(entry.child_conversation_id).toBe(childId);
    expect(entry.requested_model).toBe('pro');
    expect(entry.served_model).toBe('gemini-3.8-pro-preview');
  });

  it('defers and backfills subagent_served when PostToolUse runs before transcript rows flush', () => {
    const parentId = '00000000-0000-4000-8000-000000000010';
    const childId = 'b1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const parentTranscript = path.join(home, 'parent-transcript.jsonl');
    fs.writeFileSync(parentTranscript, '{"step_index":0,"type":"USER_INPUT","content":"hi"}\n');

    // PostToolUse runs before stepIdx 1 is flushed
    const postRes = run('post-tool-use', {
      conversationId: parentId,
      stepIdx: 1,
      transcriptPath: parentTranscript,
      toolCall: { id: 'call_sub_1', name: 'invoke_subagent', args: { TypeName: 'research', Model: 'pro' } }
    });
    expect(postRes.exitCode).toBe(0);

    // Now parent transcript flushes step 1 and child transcript flushes its first model row
    fs.appendFileSync(
      parentTranscript,
      JSON.stringify({ step_index: 1, type: 'GENERIC', content: `Created subagent ${childId}` }) + '\n'
    );
    const brainLogs = path.join(home, '.gemini', 'antigravity-cli', 'brain', childId, '.system_generated', 'logs');
    fs.mkdirSync(brainLogs, { recursive: true });
    fs.writeFileSync(
      path.join(brainLogs, 'transcript_full.jsonl'),
      '{"step_index":0,"type":"EPHEMERAL_MESSAGE","model":null}\n{"step_index":1,"type":"PLANNER_RESPONSE","model":"gemini-4-hydrogen-tiered-xhigh"}\n'
    );

    // Next hook invocation flushes the pending served entry
    const nextRes = run('pre-tool-use', {
      conversationId: parentId,
      modelName: 'gemini-4-hydrogen-high',
      toolCall: { id: 'call_sub_2', name: 'invoke_subagent', args: { TypeName: 'research', Model: 'flash' } }
    });
    expect(nextRes.exitCode).toBe(0);

    const logFile = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    const entries = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const served = entries.find((e) => e.event === 'subagent_served' && e.child_conversation_id === childId);
    expect(served).toBeDefined();
    expect(served.served_model).toBe('gemini-4-hydrogen-tiered-xhigh');
    expect(served.requested_model).toBe('pro');
    expect(served.backfilled).toBe(true);
  });
});

describe('Antigravity hook: unsafe conversation ids (A2)', () => {
  const ELEVATE = (id: string) => ({
    conversationId: id,
    lastUserInput: 'Invoke expert on pro',
    modelName: 'gemini-3.8-flash-low',
    toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } }
  });

  /** Every regular file under the temp home, relative to it. */
  function filesUnder(dir: string, base = dir): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...filesUnder(p, base));
      else out.push(path.relative(base, p));
    }
    return out;
  }

  for (const id of ['../../x', 'a/b']) {
    it(`id ${JSON.stringify(id)} makes the decision and writes nothing outside antigravity-sessions`, () => {
      const proc = run('pre-tool-use', ELEVATE(id));
      expect(proc.exitCode).toBe(0);
      expect(JSON.parse(proc.stdout.toString()).decision).toBe('deny');

      const sessions = path.join(home, '.config', 'jev', 'antigravity-sessions');
      const all = filesUnder(home);
      const stray = all.filter(
        (f) => /approvals|write-guard|pending-served|\.model\.json/.test(f) && !f.startsWith(path.join('.config', 'jev', 'antigravity-sessions') + path.sep)
      );
      expect(stray).toEqual([]);
      for (const f of fs.readdirSync(sessions)) expect(f).not.toMatch(/[\\/]/);
      // Log rows carry the normalised id.
      const rows = fs
        .readFileSync(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const call = rows.find((r) => r.event === 'agent_call');
      expect(call.session_id).toBe(id === '../../x' ? 'x' : 'ab');
    });
  }

  it('post-tool-use with an unsafe id records under the normalised id only', () => {
    expect(JSON.parse(run('pre-tool-use', ELEVATE('../../x')).stdout.toString()).decision).toBe('deny');
    const post = run('post-tool-use', {
      conversationId: '../../x',
      toolCall: {
        id: 'call_ask',
        name: 'ask_question',
        args: { questions: [{ question: "[jev-elevate:pro] Allow subagent 'expert' to run on pro?", options: ['(Recommended) Yes, once', 'No'] }] }
      },
      content: 'A1: (Recommended) Yes, once'
    });
    expect(post.exitCode).toBe(0);
    expect(JSON.parse(run('pre-tool-use', ELEVATE('../../x')).stdout.toString()).decision).toBe('allow');
    expect(fs.existsSync(path.join(home, '.config', 'x.approvals.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.config', 'jev', 'antigravity-sessions', 'x.approvals.json'))).toBe(true);
  });
});

describe('Antigravity hook: an id with nothing safe in it means no stored state (R2)', () => {
  const ELEVATE = (id: string) => ({
    conversationId: id,
    lastUserInput: 'Invoke expert on pro',
    modelName: 'gemini-3.8-flash-low',
    toolCall: { id: 'call_1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } }
  });
  const ANSWER = (id: string) => ({
    conversationId: id,
    toolCall: {
      id: 'call_ask',
      name: 'ask_question',
      args: { questions: [{ question: "[jev-elevate:pro] Allow subagent 'expert' to run on pro?", options: ['Yes, for this session', 'No'] }] }
    },
    content: 'A1: Yes, for this session'
  });
  const sessionsDir = () => path.join(home, '.config', 'jev', 'antigravity-sessions');

  it('two different unsafe ids do not share an approval, and no state file is written for them', () => {
    expect(JSON.parse(run('pre-tool-use', ELEVATE('///')).stdout.toString()).decision).toBe('deny');
    const post = run('post-tool-use', ANSWER('///'));
    expect(post.exitCode).toBe(0);
    // A different unsafe conversation must not inherit the first one's "Yes, for this session".
    expect(JSON.parse(run('pre-tool-use', ELEVATE('@@@')).stdout.toString()).decision).toBe('deny');
    const files = fs.existsSync(sessionsDir()) ? fs.readdirSync(sessionsDir()) : [];
    expect(files.filter((f) => /approvals/.test(f))).toEqual([]);
  });

  it('an unsafe id is not mapped onto the shared default-session file either', () => {
    run('pre-tool-use', ELEVATE('@@@'));
    run('post-tool-use', ANSWER('@@@'));
    const files = fs.existsSync(sessionsDir()) ? fs.readdirSync(sessionsDir()) : [];
    expect(files).not.toContain('default-session.approvals.json');
  });
});
