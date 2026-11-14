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
});
