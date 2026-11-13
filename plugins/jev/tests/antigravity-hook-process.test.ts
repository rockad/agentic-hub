import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const FIXTURE_PATH = path.join(import.meta.dir, 'fixtures', 'agy-invoke-subagent.json');

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
  it('allows the captured real payload fixture', () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    const proc = run('pre-tool-use', raw);

    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());
    expect(out.decision).toBe('allow');
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

  it('allows everything when Jev mode is off', () => {
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
    const out = JSON.parse(proc.stdout.toString());
    expect(out.decision).toBe('allow');
  });

  it('fails open on malformed stdin', () => {
    const proc = Bun.spawnSync(['bun', HOOK, 'pre-tool-use'], {
      stdin: new TextEncoder().encode('{ not-json'),
      env: { ...process.env, HOME: home }
    });
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());
    expect(out.decision).toBe('allow');
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
    expect(typeof parsed.prompt_hash).toBe('string');
  });
});
