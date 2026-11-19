import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateAntigravitySubagentCall,
  parseElevationAnswer,
  extractAskAnswer,
  pollForAskAnswer,
  pullElevationAnswerFromTranscript,
  extractChildConversationId,
  detectAntigravityAutoApprove,
  findServedModelFromTranscript,
  MAX_TRANSCRIPT_READ_BYTES,
  buildElevationQuestion,
  resolveAntigravitySessionModel,
  cleanUserInput,
  turnId,
  readAntigravityTurn,
  writeAntigravityTurn,
  buildAntigravityTelemetryEvent,
  type AntigravityHookInput,
  type AntigravityHookDecision,
  type AntigravityTurnState
} from '../antigravity/logic.ts';
import {
  ApprovalStore,
  createAntigravityApprovalStore
} from '../antigravity/approvals.ts';

const FIXTURE_PATH = path.join(import.meta.dir, 'fixtures', 'agy-invoke-subagent.json');

describe('Antigravity PreToolUse subagent guard (logic)', () => {
  let tmpDir = '';
  let approvals: ApprovalStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-logic-test-'));
    approvals = createAntigravityApprovalStore(path.join(tmpDir, 'sessions'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows the real captured payload fixture (Model: flash_lite on flash session)', () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as AntigravityHookInput;
    const decision = evaluateAntigravitySubagentCall(raw, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1000
    });

    expect(decision.decision).toBe('pass');
    expect(decision.elevation).toBeUndefined();
  });

  it('allows when Model is omitted or inherit on a flash session', () => {
    const inputOmitted: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'run subagent',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 't1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'worker',
          Prompt: 'do task'
        }
      }
    };

    const decisionOmitted = evaluateAntigravitySubagentCall(inputOmitted, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1000
    });
    expect(decisionOmitted.decision).toBe('pass');

    const inputInherit: AntigravityHookInput = {
      ...inputOmitted,
      toolCall: {
        ...inputOmitted.toolCall,
        args: {
          ...inputOmitted.toolCall.args,
          Model: 'inherit'
        }
      }
    };
    const decisionInherit = evaluateAntigravitySubagentCall(inputInherit, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1000
    });
    expect(decisionInherit.decision).toBe('pass');
  });

  it('allows explicit Model: flash on a flash session', () => {
    const input: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'run subagent',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 't1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'worker',
          Prompt: 'do task',
          Model: 'flash'
        }
      }
    };

    const decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1000
    });
    expect(decision.decision).toBe('pass');
  });

  it('passes a tool that is not invoke_subagent', () => {
    expect(evaluateAntigravitySubagentCall({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }).decision).toBe('pass');
  });

  it('denies Model: pro on a flash session and prescribes ask_question choice', () => {
    const input: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'run subagent on pro',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 't1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert-worker',
          Prompt: 'solve hard problem',
          Model: 'pro'
        }
      }
    };

    const decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1000
    });

    expect(decision.decision).toBe('deny');
    expect(decision.reason).toContain('[jev-elevate:pro]');
    expect(decision.reason).toContain('ask_question');
    expect(decision.reason).toContain('Yes, once');
    expect(decision.reason).toContain('Yes, for the next 5 minutes');
    expect(decision.reason).toContain('Yes, for this session');
    expect(decision.reason).toContain('No, proceed on flash');
    expect(decision.elevation).toBe('denied');
  });

  it('keeps denying on the 3rd attempt without approval in the same prompt (no dialog backstop)', () => {
    const input: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'run subagent on pro',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 't1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert-worker',
          Prompt: 'solve hard problem',
          Model: 'pro'
        }
      }
    };

    // Attempt 1: deny
    const d1 = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1000
    });
    expect(d1.decision).toBe('deny');

    // Attempt 2: deny
    const d2 = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1050
    });
    expect(d2.decision).toBe('deny');

    // Attempt 3: still deny (an ask would be auto-approved under TURBO), now telling the agent to stop retrying pro
    const d3 = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1100
    });
    expect(d3.decision).toBe('deny');
    expect(d3.elevation).toBe('denied');
    expect(d3.attemptCount).toBe(3);
    expect(d3.reason).toContain('flash');
  });

  it('passes when explicit pro override is in the user prompt', () => {
    const input: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'Please use manual pro approval for this deep reasoning task',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 't1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert-worker',
          Prompt: 'solve hard problem',
          Model: 'pro'
        }
      }
    };

    const decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1000
    });
    expect(decision.decision).toBe('allow');
    expect(decision.elevation).toBe('instructed');
  });

  describe('explicit pro override matching', () => {
    const overrides = (prompt: string, elevationMode?: 'dialog', requestedModel: string = 'pro') =>
      evaluateAntigravitySubagentCall(
        {
          conversationId: 'c-ovr',
          lastUserInput: prompt,
          modelName: 'gemini-3.8-flash-low',
          toolCall: { id: 't-ovr', name: 'invoke_subagent', args: { TypeName: 'expert-worker', Prompt: 'x', Model: requestedModel } }
        },
        { approvals, sessionModelOverride: 'gemini-3.8-flash-low', elevationMode, now: () => 1000 }
      );

    for (const prompt of [
      'Please drop the jargon',
      'Do not use deep reasoning here',
      'Argonaut',
      "Don't use gemini pro for this",
      'Don’t use Claude Opus for this',
      'Never use cross-system architecture thinking',
      'Run it without manual pro approval',
      'avoid argon',
      "I don't want you to use gemini pro here",
      'Do not, under any circumstances, use gemini pro',
      'never let a subagent use gemini pro',
      'hash it with argon',
      'use argon for this',
      'Argon, please.'
    ]) {
      it(`does not treat "${prompt}" as an explicit override`, () => {
        const d = overrides(prompt);
        expect(d.elevation).not.toBe('instructed');
        // Default (choice) mode denies with the question text; dialog mode asks. Either way the elevation is not waved through.
        expect(d.decision).toBe('deny');
        expect(d.elevation).toBe('denied');
        expect(overrides(prompt, 'dialog').decision).toBe('ask');
      });
    }

    for (const prompt of [
      'use gemini pro',
      'Use Claude Opus for this',
      'manual pro approval granted',
      'use deep reasoning',
      'Do not rush, use deep reasoning',
      'run an argon subagent',
      'use argon coordinator',
      'spawn an argon agent',
      'select the argon model',
      'use gemini argon coordinator',
      'use gemini argon subagent'
    ]) {
      it(`still treats "${prompt}" as an explicit override`, () => {
        const d = overrides(prompt);
        expect(d.decision).toBe('allow');
        expect(d.elevation).toBe('instructed');
      });
    }

    it('"use gemini pro" must not approve a Claude Opus request', () => {
      const d = overrides('use gemini pro', undefined, 'claude-opus-5-5');
      expect(d.decision).toBe('deny');
      expect(d.elevation).toBe('denied');
      expect(d.reason).toContain('[jev-elevate:claude-opus-5-5]');
    });

    it('"run an argon subagent" must not approve a Claude Opus request', () => {
      const d = overrides('run an argon subagent', undefined, 'claude-opus-5-5');
      expect(d.decision).toBe('deny');
      expect(d.elevation).toBe('denied');
      expect(d.reason).toContain('[jev-elevate:claude-opus-5-5]');
    });

    it('"Use Claude Opus for this" must not approve a Gemini Argon request', () => {
      const d = overrides('Use Claude Opus for this', undefined, 'gemini-argon');
      expect(d.decision).toBe('deny');
      expect(d.elevation).toBe('denied');
      expect(d.reason).toContain('[jev-elevate:gemini-argon]');
    });

    it('"run an argon subagent" approves a Gemini Argon request', () => {
      const d = overrides('run an argon subagent', undefined, 'gemini-argon');
      expect(d.decision).toBe('allow');
      expect(d.elevation).toBe('instructed');
    });

    it('"Use Claude Opus for this" approves a Claude Opus request', () => {
      const d = overrides('Use Claude Opus for this', undefined, 'claude-opus-5-5');
      expect(d.decision).toBe('allow');
      expect(d.elevation).toBe('instructed');
    });
  });

  describe('Finding A: mixed Subagents[] and lowercase model shapes', () => {
    it('denies mixed Subagents[] with lower-tier first and pro second: {"Subagents":[{"Model":"flash"},{"Model":"pro"}]}', () => {
      const input: AntigravityHookInput = {
        conversationId: 'c-mixed',
        lastUserInput: 'run subagents',
        modelName: 'gemini-3.8-flash-low',
        toolCall: {
          id: 't-mix',
          name: 'invoke_subagent',
          args: {
            Subagents: [
              { Role: 'helper', Model: 'flash' },
              { Role: 'expert', Model: 'pro' }
            ]
          }
        }
      };

      const decision = evaluateAntigravitySubagentCall(input, {
        approvals,
        sessionModelOverride: 'gemini-3.8-flash-low',
        now: () => 1000
      });
      expect(decision.decision).toBe('deny');
      expect(decision.elevation).toBe('denied');
      expect(decision.reason).toContain('[jev-elevate:pro]');
    });

    it('denies Model: "inherit" when Subagents[] contains pro: {"Model":"inherit","Subagents":[{"Model":"pro"}]}', () => {
      const input: AntigravityHookInput = {
        conversationId: 'c-inherit-sub',
        lastUserInput: 'run subagents',
        modelName: 'gemini-3.8-flash-low',
        toolCall: {
          id: 't-inh',
          name: 'invoke_subagent',
          args: {
            Model: 'inherit',
            Subagents: [
              { Role: 'expert', Model: 'pro' }
            ]
          }
        }
      };

      const decision = evaluateAntigravitySubagentCall(input, {
        approvals,
        sessionModelOverride: 'gemini-3.8-flash-low',
        now: () => 1000
      });
      expect(decision.decision).toBe('deny');
      expect(decision.elevation).toBe('denied');
      expect(decision.reason).toContain('[jev-elevate:pro]');
    });

    it('denies lowercase model key: {"model":"pro"}', () => {
      const input: AntigravityHookInput = {
        conversationId: 'c-lc-key',
        lastUserInput: 'run subagents',
        modelName: 'gemini-3.8-flash-low',
        toolCall: {
          id: 't-lc',
          name: 'invoke_subagent',
          args: {
            TypeName: 'expert',
            Prompt: 'work',
            model: 'pro'
          }
        }
      };

      const decision = evaluateAntigravitySubagentCall(input, {
        approvals,
        sessionModelOverride: 'gemini-3.8-flash-low',
        now: () => 1000
      });
      expect(decision.decision).toBe('deny');
      expect(decision.elevation).toBe('denied');
      expect(decision.reason).toContain('[jev-elevate:pro]');
    });

    it('denies lowercase subagents array and model keys: {"subagents":[{"model":"pro"}]}', () => {
      const input: AntigravityHookInput = {
        conversationId: 'c-lc-arr',
        lastUserInput: 'run subagents',
        modelName: 'gemini-3.8-flash-low',
        toolCall: {
          id: 't-lc-arr',
          name: 'invoke_subagent',
          args: {
            subagents: [
              { role: 'expert', model: 'pro' }
            ]
          }
        }
      };

      const decision = evaluateAntigravitySubagentCall(input, {
        approvals,
        sessionModelOverride: 'gemini-3.8-flash-low',
        now: () => 1000
      });
      expect(decision.decision).toBe('deny');
      expect(decision.elevation).toBe('denied');
      expect(decision.reason).toContain('[jev-elevate:pro]');
    });
  });

  it('supports backward compatibility with older args.Subagents[] shape', () => {
    const input: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'run subagent',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 't1',
        name: 'invoke_subagent',
        args: {
          Subagents: [
            { Role: 'coder', Model: 'pro' }
          ]
        }
      }
    };

    const decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1000
    });
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toContain('[jev-elevate:pro]');
  });

  it('records approval on Yes once and consumes it on execution', () => {
    // Record deny to open 15-minute prescription window
    approvals.deny('c1', 'pro', 1000);

    // Record user answer
    const parsed = parseElevationAnswer('A1: (Recommended) Yes, once');
    expect(parsed.approved).toBe(true);
    expect(parsed.scope).toBe('once');
    approvals.record('c1', { model: 'pro', scope: 'once', created_at: 1050 });

    const input: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'run subagent on pro',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 't1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert-worker',
          Prompt: 'solve hard problem',
          Model: 'pro'
        }
      }
    };

    // First call uses the 'once' approval
    const d1 = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1100
    });
    expect(d1.decision).toBe('allow');
    expect(d1.elevation).toBe('approved');
    expect(d1.approvalScope).toBe('once');

    // Second call has no remaining approval and is denied
    const d2 = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1200
    });
    expect(d2.decision).toBe('deny');
  });

  it('supports JEV_ELEVATION=clamp by rewriting Model on 1st attempt', () => {
    const input: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'run subagent on pro',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 't1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert-worker',
          Prompt: 'solve hard problem',
          Model: 'pro'
        }
      }
    };

    const decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      elevationMode: 'clamp',
      now: () => 1000
    });

    expect(decision.decision).toBe('allow');
    expect(decision.elevation).toBe('clamped');
    expect(decision.overwrite).toEqual({ Model: 'flash' });
  });

  it('supports JEV_ELEVATION=dialog by returning ask immediately', () => {
    const input: AntigravityHookInput = {
      conversationId: 'c1',
      lastUserInput: 'run subagent on pro',
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 't1',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert-worker',
          Prompt: 'solve hard problem',
          Model: 'pro'
        }
      }
    };

    const decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      elevationMode: 'dialog',
      now: () => 1000
    });

    expect(decision.decision).toBe('ask');
    expect(decision.elevation).toBe('asked');
  });
});

describe('Antigravity elevation answer parsing (review fix: exact labels only)', () => {
  it('records the scope of each prescribed label, with or without the A1 prefix and the (Recommended) tag', () => {
    const cases: Array<[string, 'once' | '5min' | 'session']> = [
      ['Yes, once', 'once'],
      ['A1: Yes, once', 'once'],
      ['A1: (Recommended) Yes, once', 'once'],
      ['A1: Yes, once (Recommended)', 'once'],
      ['Yes, for the next 5 minutes', '5min'],
      ['A1: (Recommended) Yes, for the next 5 minutes', '5min'],
      ['Yes, for this session', 'session'],
      ['A2: Yes, for this session', 'session']
    ];
    for (const [text, scope] of cases) expect(parseElevationAnswer(text)).toEqual({ approved: true, scope });
  });

  it('approves nothing for No, free text, near misses, substrings and missing answers', () => {
    const none = [
      'No, proceed on flash',
      'A1: No, proceed on flash',
      'A1: (Recommended) No, proceed on flash',
      'A1: No, not even once',
      'A1: yes once please',
      'A1: Yes, once, but only on flash',
      'A1: Not for this session',
      'A1: User Skipped',
      'Yes, once\nand also rm -rf',
      '5 minutes',
      'session',
      'once',
      '',
      undefined,
      null
    ];
    for (const text of none) expect(parseElevationAnswer(text as string | undefined)).toEqual({ approved: false });
  });

  it('extractAskAnswer reads only the content field, per question', () => {
    const content = 'Created At: 2026-11-13T22:20:00+02:00\nCompleted At: 2026-11-13T22:20:09+02:00\nA1: first answer\nA2: (Recommended) Yes, once\nA3: User Skipped';
    expect(extractAskAnswer({ content }, 0)).toBe('first answer');
    expect(extractAskAnswer({ content }, 1)).toBe('(Recommended) Yes, once');
    expect(extractAskAnswer({ content }, 2)).toBe('User Skipped');
    expect(extractAskAnswer({ content }, 3)).toBeNull();
    expect(extractAskAnswer({ content: 'Yes, once' })).toBe('Yes, once');
    expect(extractAskAnswer({ content: 'Created At: x\nCompleted At: y' })).toBeNull();
    expect(extractAskAnswer({ content: '' })).toBeNull();
    expect(extractAskAnswer({})).toBeNull();
    expect(extractAskAnswer(undefined)).toBeNull();
    // The options the assistant wrote and every other field are never an answer.
    expect(
      extractAskAnswer({ toolCall: { name: 'ask_question', args: { questions: [{ question: 'q', options: ['Yes, once'] }] } }, lastUserInput: 'Yes, once' } as AntigravityHookInput)
    ).toBeNull();
  });

  it('extractAskAnswer reads from transcriptPath at stepIdx when content is omitted (real Antigravity PostToolUse)', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-transcript-test-'));
    try {
      const transcriptFile = path.join(testDir, 'transcript_full.jsonl');
      fs.writeFileSync(
        transcriptFile,
        '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"start"}\n' +
        '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","content":"ask"}\n' +
        '{"step_index":2,"source":"MODEL","type":"GENERIC","content":"Created At: 2026-11-14T16:37:35+02:00\\nCompleted At: 2026-11-14T16:38:00+02:00\\nA1: (Recommended) Yes, once"}\n'
      );

      const input: AntigravityHookInput = {
        conversationId: 'c-transcript',
        stepIdx: 2,
        transcriptPath: transcriptFile,
        toolCall: {
          name: 'ask_question',
          args: {
            questions: [
              {
                question: '[jev-elevate:pro] Allow subagent?',
                options: ['(Recommended) Yes, once', 'No']
              }
            ]
          }
        }
      };

      expect(extractAskAnswer(input, 0)).toBe('(Recommended) Yes, once');
      const parsed = parseElevationAnswer(extractAskAnswer(input, 0));
      expect(parsed.approved).toBe(true);
      expect(parsed.scope).toBe('once');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('extractAskAnswer returns null for a transcript larger than the cap', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cap-test-'));
    try {
      const transcriptFile = path.join(testDir, 'transcript_full.jsonl');
      fs.writeFileSync(
        transcriptFile,
        '{"step_index":2,"type":"GENERIC","content":"Created At: x\\nCompleted At: y\\nA1: Yes, once"}\n'
      );
      const input: AntigravityHookInput = {
        conversationId: 'c-cap',
        stepIdx: 2,
        transcriptPath: transcriptFile,
        toolCall: { name: 'ask_question' }
      };

      // When cap is smaller than the file size, returns null:
      expect(extractAskAnswer(input, 0, 10)).toBeNull();
      // When cap is larger than the file size, returns the answer:
      expect(extractAskAnswer(input, 0, 10_000)).toBe('Yes, once');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('extractAskAnswer reads answer from the tail when transcript is larger than the window (3 MB)', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tail-test-'));
    try {
      const transcriptFile = path.join(testDir, 'transcript_full.jsonl');
      // Create ~3 MB of padding steps
      const paddingLine = '{"step_index":0,"source":"USER","type":"USER_INPUT","content":"padding message text for large file"}\n';
      const repeatCount = Math.ceil((3 * 1024 * 1024) / paddingLine.length);
      fs.writeFileSync(transcriptFile, paddingLine.repeat(repeatCount));
      // Append target step at the end
      fs.appendFileSync(
        transcriptFile,
        '{"step_index":999,"type":"GENERIC","content":"Created At: x\\nCompleted At: y\\nA1: (Recommended) Yes, once"}\n'
      );
      const input: AntigravityHookInput = {
        conversationId: 'c-tail-large',
        stepIdx: 999,
        transcriptPath: transcriptFile,
        toolCall: { name: 'ask_question' }
      };

      expect(extractAskAnswer(input, 0)).toBe('(Recommended) Yes, once');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('extractAskAnswer returns null when transcript is larger than the window but matching step sits outside the window', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tail-outside-'));
    try {
      const transcriptFile = path.join(testDir, 'transcript_full.jsonl');
      // Target step is at the very beginning
      fs.writeFileSync(
        transcriptFile,
        '{"step_index":42,"type":"GENERIC","content":"A1: Yes, once"}\n'
      );
      // Append 2 MB of filler lines after it, pushing step 42 outside the 1 MB tail window
      const paddingLine = '{"step_index":0,"type":"GENERIC","content":"filler lines pushing earlier steps out of window"}\n';
      const repeatCount = Math.ceil((2 * 1024 * 1024) / paddingLine.length);
      fs.appendFileSync(transcriptFile, paddingLine.repeat(repeatCount));

      const input: AntigravityHookInput = {
        conversationId: 'c-tail-outside',
        stepIdx: 42,
        transcriptPath: transcriptFile,
        toolCall: { name: 'ask_question' }
      };

      expect(extractAskAnswer(input, 0)).toBeNull();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('extractAskAnswer drops the first partial line when window cuts mid-line without breaking parsing', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mid-cut-'));
    try {
      const transcriptFile = path.join(testDir, 'transcript_full.jsonl');
      // Create a file where tail window cuts right in the middle of a JSON line
      // E.g. filler 500 bytes, window = 200 bytes
      const filler = '{"step_index":1,"type":"GENERIC","content":"very long filler text that will be cut mid-line by the tail window"}\n';
      fs.writeFileSync(transcriptFile, filler.repeat(10));
      fs.appendFileSync(
        transcriptFile,
        '{"step_index":2,"type":"GENERIC","content":"A1: Yes, once"}\n'
      );
      const input: AntigravityHookInput = {
        conversationId: 'c-mid-cut',
        stepIdx: 2,
        transcriptPath: transcriptFile,
        toolCall: { name: 'ask_question' }
      };

      // Set window to 150 bytes: the window start will land inside one of the filler lines
      expect(extractAskAnswer(input, 0, 150)).toBe('Yes, once');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('reads answer from a real transcript over 1 MB when step is at the end (real check, set JEV_REAL_TRANSCRIPT)', () => {
    // Opt-in: point JEV_REAL_TRANSCRIPT at a real transcript_full.jsonl larger than 1 MB.
    const realSource = process.env.JEV_REAL_TRANSCRIPT;
    if (!realSource || !fs.existsSync(realSource)) return;
    const stat = fs.statSync(realSource);
    if (stat.size <= 1024 * 1024) return;

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-real-1m-'));
    try {
      const copyPath = path.join(testDir, 'transcript_full.jsonl');
      fs.copyFileSync(realSource, copyPath);
      // Append a synthetic answer step at the end (stepIdx 99999)
      const answerStep = '{"step_index":99999,"type":"GENERIC","content":"Created At: x\\nCompleted At: y\\nA1: (Recommended) Yes, once"}\n';
      fs.appendFileSync(copyPath, answerStep);

      const input: AntigravityHookInput = {
        conversationId: 'c-real-large',
        stepIdx: 99999,
        transcriptPath: copyPath,
        toolCall: { name: 'ask_question' }
      };

      const ans = extractAskAnswer(input, 0);
      expect(ans).toBe('(Recommended) Yes, once');
      expect(parseElevationAnswer(ans)).toEqual({ approved: true, scope: 'once' });
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('extractAskAnswer returns null if matching step has wrong type (not GENERIC)', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-type-test-'));
    try {
      const transcriptFile = path.join(testDir, 'transcript_full.jsonl');
      // Step 2 has type PLANNER_RESPONSE instead of GENERIC:
      fs.writeFileSync(
        transcriptFile,
        '{"step_index":2,"type":"PLANNER_RESPONSE","content":"Created At: x\\nCompleted At: y\\nA1: Yes, once"}\n'
      );
      const input: AntigravityHookInput = {
        conversationId: 'c-wrong-type',
        stepIdx: 2,
        transcriptPath: transcriptFile,
        toolCall: { name: 'ask_question' }
      };

      expect(extractAskAnswer(input, 0)).toBeNull();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('extractAskAnswer returns null and fails closed on duplicate step index', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dup-test-'));
    try {
      const transcriptFile = path.join(testDir, 'transcript_full.jsonl');
      // Two lines share step_index: 2
      fs.writeFileSync(
        transcriptFile,
        '{"step_index":2,"type":"GENERIC","content":"A1: Yes, once"}\n' +
        '{"step_index":2,"type":"GENERIC","content":"A1: Yes, once"}\n'
      );
      const input: AntigravityHookInput = {
        conversationId: 'c-dup',
        stepIdx: 2,
        transcriptPath: transcriptFile,
        toolCall: { name: 'ask_question' }
      };

      expect(extractAskAnswer(input, 0)).toBeNull();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('extractAskAnswer returns null if step toolCallId does not match input.toolCall.id', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-id-test-'));
    try {
      const transcriptFile = path.join(testDir, 'transcript_full.jsonl');
      fs.writeFileSync(
        transcriptFile,
        '{"step_index":2,"type":"GENERIC","toolCallId":"call_other","content":"A1: Yes, once"}\n'
      );
      const input: AntigravityHookInput = {
        conversationId: 'c-mismatch-id',
        stepIdx: 2,
        transcriptPath: transcriptFile,
        toolCall: { id: 'call_expected', name: 'ask_question' }
      };

      expect(extractAskAnswer(input, 0)).toBeNull();
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('extractAskAnswer returns null for a FIFO without blocking', () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fifo-test-'));
    try {
      const fifoPath = path.join(testDir, 'fifo_pipe');
      const r = Bun.spawnSync(['mkfifo', fifoPath]);
      if (r.exitCode === 0) {
        const input: AntigravityHookInput = {
          conversationId: 'c-fifo',
          stepIdx: 2,
          transcriptPath: fifoPath,
          toolCall: { name: 'ask_question' }
        };
        // Should return null immediately without blocking on the open FIFO
        expect(extractAskAnswer(input, 0)).toBeNull();
      }
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('keeps a multi-line free-text answer whole, so it can never equal a label', () => {
    expect(extractAskAnswer({ content: 'Created At: x\nCompleted At: y\nA1: Yes,\nonce' }, 0)).toBe('Yes,\nonce');
    expect(parseElevationAnswer('A1: Yes,\nonce')).toEqual({ approved: false });
  });
});

describe('ApprovalStore record return and wasDeniedRecently timestamp', () => {
  let tmpDir = '';
  let approvals: ApprovalStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-approvals-test-'));
    approvals = createAntigravityApprovalStore(path.join(tmpDir, 'sessions'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('wasDeniedRecently returns null when no denial exists, and timestamp when denied', () => {
    expect(approvals.wasDeniedRecently('s1', 'pro', 1000)).toBeNull();
    approvals.deny('s1', 'pro', 2000);
    expect(approvals.wasDeniedRecently('s1', 'pro', 2500)).toBe(2000);
    // After denial window expires (15 min = 900,000 ms)
    expect(approvals.wasDeniedRecently('s1', 'pro', 2000 + 16 * 60 * 1000)).toBeNull();
  });

  it('record returns false when not denied recently, and true when denied recently', () => {
    // Attempt record without prior denial -> returns false
    const ok1 = approvals.record('s1', { model: 'pro', scope: 'once', created_at: 1000 });
    expect(ok1).toBe(false);

    // Deny first -> record returns true
    approvals.deny('s1', 'pro', 2000);
    const ok2 = approvals.record('s1', { model: 'pro', scope: 'once', created_at: 2100 });
    expect(ok2).toBe(true);
  });
});

describe('pollForAskAnswer', () => {
  let testDir = '';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-poll-test-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns immediately if content is on stdin', async () => {
    const input: AntigravityHookInput = {
      content: 'A1: Yes, once'
    };
    const res = await pollForAskAnswer(input, 0, { maxWaitMs: 500, pollIntervalMs: 50 });
    expect(res).toBe('Yes, once');
  });

  it('polls and finds answer written to transcriptPath after a short delay', async () => {
    const transcriptFile = path.join(testDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptFile, '{"step_index":0,"type":"USER_INPUT","content":"start"}\n');

    const input: AntigravityHookInput = {
      transcriptPath: transcriptFile,
      stepIdx: 1
    };

    // In background, write stepIdx: 1 after 80ms
    setTimeout(() => {
      fs.appendFileSync(transcriptFile, '{"step_index":1,"type":"GENERIC","content":"A1: Yes, for this session"}\n');
    }, 80);

    const res = await pollForAskAnswer(input, 0, { maxWaitMs: 800, pollIntervalMs: 40 });
    expect(res).toBe('Yes, for this session');
  });

  it('returns null if answer never appears within maxWaitMs', async () => {
    const transcriptFile = path.join(testDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptFile, '{"step_index":0,"type":"USER_INPUT","content":"start"}\n');

    const input: AntigravityHookInput = {
      transcriptPath: transcriptFile,
      stepIdx: 1
    };

    const res = await pollForAskAnswer(input, 0, { maxWaitMs: 150, pollIntervalMs: 50 });
    expect(res).toBeNull();
  });
});

describe('pullElevationAnswerFromTranscript and PreToolUse pull fallback', () => {
  let testDir = '';
  let approvals: ApprovalStore;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pull-fallback-test-'));
    approvals = createAntigravityApprovalStore(path.join(testDir, 'sessions'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('pulls elevation answer from transcript when ask_question has tool_calls with [jev-elevate:pro]', () => {
    const transcriptFile = path.join(testDir, 'transcript.jsonl');
    const content =
      '{"step_index":1,"type":"PLANNER_RESPONSE","created_at":"2026-11-16T12:00:00.000Z","tool_calls":[{"id":"ask_call_1","name":"ask_question","args":{"questions":["[jev-elevate:pro] Allow subagent?"]}}]}\n' +
      '{"step_index":2,"type":"GENERIC","toolCallId":"ask_call_1","content":"Created At: ...\\nA1: Yes, once"}\n';
    fs.writeFileSync(transcriptFile, content);

    const pull = pullElevationAnswerFromTranscript(transcriptFile, 'pro', Date.parse('2026-11-16T12:00:00.000Z'));
    expect(pull).toEqual({ approved: true, scope: 'once' });
  });

  it('pulls elevation answer when marker is in step.content and next step is GENERIC', () => {
    const transcriptFile = path.join(testDir, 'transcript.jsonl');
    const content =
      '{"step_index":1,"type":"PLANNER_RESPONSE","content":"Calling ask_question with [jev-elevate:pro] Allow subagent?"}\n' +
      '{"step_index":2,"type":"GENERIC","content":"A1: Yes, for the next 5 minutes"}\n';
    fs.writeFileSync(transcriptFile, content);

    // A prose match has no tool call: with no recorded answer row (PostToolUse stepIdx) the next GENERIC is not trusted.
    expect(pullElevationAnswerFromTranscript(transcriptFile, 'pro')).toBeNull();
    const pull = pullElevationAnswerFromTranscript(transcriptFile, 'pro', undefined, 2);
    expect(pull).toEqual({ approved: true, scope: '5min' });
  });

  it('picks the latest ask_question when multiple exist and respects deniedAtMs tolerance', () => {
    const transcriptFile = path.join(testDir, 'transcript.jsonl');
    const content =
      '{"step_index":1,"created_at":"2026-11-16T10:00:00.000Z","type":"PLANNER_RESPONSE","content":"[jev-elevate:pro] Q1"}\n' +
      '{"step_index":2,"type":"GENERIC","content":"A1: No, proceed on flash"}\n' +
      '{"step_index":3,"created_at":"2026-11-16T11:00:00.000Z","type":"PLANNER_RESPONSE","content":"[jev-elevate:pro] Q2"}\n' +
      '{"step_index":4,"type":"GENERIC","content":"A1: Yes, for this session"}\n';
    fs.writeFileSync(transcriptFile, content);

    // If deniedAtMs is 10:55, it ignores step 1 (older than 10:55 - 5s) and matches step 3
    const pull = pullElevationAnswerFromTranscript(transcriptFile, 'pro', Date.parse('2026-11-16T10:55:00.000Z'), 4);
    expect(pull).toEqual({ approved: true, scope: 'session' });
  });

  it('evaluateAntigravitySubagentCall automatically recovers via pull fallback before deny', () => {
    const transcriptFile = path.join(testDir, 'transcript.jsonl');
    const nowMs = 1_000_000;
    // 1. Initial denial occurred at nowMs - 5000
    approvals.deny('s-pull', 'pro', nowMs - 5000);

    // 2. Transcript contains the user answering Yes, once to elevation question
    const content =
      '{"step_index":1,"created_at":"2026-11-16T12:00:00.000Z","type":"PLANNER_RESPONSE","tool_calls":[{"id":"call_q","name":"ask_question","args":{"questions":["[jev-elevate:pro] Allow expert?"]}}]}\n' +
      '{"step_index":2,"type":"GENERIC","toolCallId":"call_q","content":"A1: Yes, once"}\n';
    fs.writeFileSync(transcriptFile, content);

    // 3. Subagent is re-invoked without PostToolUse having recorded approval
    const input: AntigravityHookInput = {
      conversationId: 's-pull',
      transcriptPath: transcriptFile,
      modelName: 'gemini-3.8-flash-low',
      toolCall: {
        id: 'call_sub',
        name: 'invoke_subagent',
        args: {
          TypeName: 'expert',
          Model: 'pro'
        }
      }
    };

    const decision = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => nowMs
    });

    expect(decision.decision).toBe('allow');
    expect(decision.elevation).toBe('approved');
    expect(decision.approvalScope).toBe('once');
  });

  it('ignores intervening GENERIC tool output or deny messages containing [jev-elevate:pro]', () => {
    const transcriptFile = path.join(testDir, 'transcript.jsonl');
    const nowMs = 1_000_000;
    approvals.deny('s-pull-generic', 'pro', nowMs - 5000);

    const content =
      '{"step_index":1,"created_at":"2026-11-16T12:00:00.000Z","type":"PLANNER_RESPONSE","tool_calls":[{"name":"ask_question","args":{"questions":[{"question":"[jev-elevate:pro] Allow subagent?"}]}}]}\n' +
      '{"step_index":2,"type":"GENERIC","content":"A1: Yes, once"}\n' +
      '{"step_index":3,"type":"EPHEMERAL_MESSAGE","content":"[JEV MODE: ON]"}\n' +
      '{"step_index":4,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"tail log"}}]}\n' +
      '{"step_index":5,"type":"GENERIC","content":"{\\"reason\\":\\"[jev] Ask with [jev-elevate:pro]\\"}"}\n' +
      '{"step_index":6,"type":"PLANNER_RESPONSE","content":"Explaining [jev-elevate:pro] in prose"}\n';
    fs.writeFileSync(transcriptFile, content);

    const decision = evaluateAntigravitySubagentCall(
      {
        conversationId: 's-pull-generic',
        transcriptPath: transcriptFile,
        modelName: 'gemini-3.8-flash-low',
        toolCall: { id: 'call_sub', name: 'invoke_subagent', args: { TypeName: 'research', Model: 'pro' } }
      },
      {
        approvals,
        sessionModelOverride: 'gemini-3.8-flash-low',
        now: () => nowMs
      }
    );

    expect(decision.decision).toBe('allow');
    expect(decision.elevation).toBe('approved');
    expect(decision.approvalScope).toBe('once');
  });

  it('does not replay a consumed Yes-once pull fallback on a subsequent pro call', () => {
    const transcriptFile = path.join(testDir, 'transcript.jsonl');
    const nowMs = 1_000_000;
    approvals.deny('s-no-replay', 'pro', nowMs - 5000);

    const content =
      '{"step_index":1,"created_at":"2026-11-16T12:00:00.000Z","type":"PLANNER_RESPONSE","tool_calls":[{"name":"ask_question","args":{"questions":[{"question":"[jev-elevate:pro] Allow expert?"}]}}]}\n' +
      '{"step_index":2,"type":"GENERIC","content":"A1: Yes, once"}\n';
    fs.writeFileSync(transcriptFile, content);

    const first = evaluateAntigravitySubagentCall(
      {
        conversationId: 's-no-replay',
        transcriptPath: transcriptFile,
        modelName: 'gemini-3.8-flash-low',
        lastUserInput: 'turn 1',
        toolCall: { id: 'call_sub_1', name: 'invoke_subagent', args: { TypeName: 'research', Model: 'pro' } }
      },
      { approvals, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs }
    );
    expect(first.decision).toBe('allow');
    expect(first.approvalScope).toBe('once');

    // Subsequent pro call in the same session with a new prompt must deny, not replay the consumed once answer
    const second = evaluateAntigravitySubagentCall(
      {
        conversationId: 's-no-replay',
        transcriptPath: transcriptFile,
        modelName: 'gemini-3.8-flash-low',
        lastUserInput: 'turn 2',
        toolCall: { id: 'call_sub_2', name: 'invoke_subagent', args: { TypeName: 'research', Model: 'pro' } }
      },
      { approvals, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs + 10_000 }
    );
    expect(second.decision).toBe('deny');
  });
});

describe('child conversation ID and served model extraction', () => {
  it('extractChildConversationId parses various patterns', () => {
    expect(extractChildConversationId('Conversation ID: 00000000-0000-4000-8000-0000000000c9')).toBe('00000000-0000-4000-8000-0000000000c9');
    expect(extractChildConversationId('{"conversationId": "00000000-0000-4000-8000-0000000000c9"}')).toBe('00000000-0000-4000-8000-0000000000c9');
    expect(extractChildConversationId('Session 00000000-0000-4000-8000-0000000000c9 completed')).toBe('00000000-0000-4000-8000-0000000000c9');
    expect(extractChildConversationId('No id here')).toBeNull();
    expect(extractChildConversationId('')).toBeNull();
  });

  it('extractChildConversationId never returns the parent id and prefers an explicit conversationId field', () => {
    const parent = '00000000-0000-4000-8000-000000000001';
    const child = '00000000-0000-4000-8000-000000000002';
    // Only the parent mentioned: no child.
    expect(extractChildConversationId(`parent ${parent}`, parent)).toBeNull();
    expect(extractChildConversationId(`{"conversationId": "${parent}"}`, parent)).toBeNull();
    // Parent first, child later: the child is returned.
    expect(extractChildConversationId(`parent ${parent} spawned ${child}`, parent)).toBe(child);
    // Explicit field wins over an earlier bare UUID.
    expect(
      extractChildConversationId(`ref 00000000-0000-4000-8000-000000000003 {"conversationId": "${child}"}`, parent)
    ).toBe(child);
    // Case-insensitive parent comparison.
    expect(extractChildConversationId(`x ${parent.toUpperCase()}`, parent)).toBeNull();
    // Without a parent the old behaviour holds.
    expect(extractChildConversationId(`x ${parent}`)).toBe(parent);
  });

  it('findServedModelFromTranscript returns the model of the first row that has one, not one from the tail window', () => {
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-first-'));
    try {
      const childId = '00000000-0000-4000-8000-000000000002';
      const logs = path.join(testHome, '.gemini', 'antigravity-cli', 'brain', childId, '.system_generated', 'logs');
      fs.mkdirSync(logs, { recursive: true });
      // First model row, then more than 1 MiB of rows, then a different model at the very end.
      const filler = JSON.stringify({ step_index: 9, type: 'TOOL', content: 'x'.repeat(900) }) + '\n';
      fs.writeFileSync(
        path.join(logs, 'transcript_full.jsonl'),
        '{"step_index":0,"type":"MODEL","model":"first-model"}\n' +
          filler.repeat(1400) +
          '{"step_index":99,"type":"MODEL","model":"last-model"}\n'
      );
      expect(fs.statSync(path.join(logs, 'transcript_full.jsonl')).size).toBeGreaterThan(1024 * 1024);
      expect(findServedModelFromTranscript(childId, testHome)).toBe('first-model');
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  it('findServedModelFromTranscript finds model from child brain transcript', () => {
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-test-'));
    try {
      const childId = '00000000-0000-4000-8000-0000000000c9';
      const brainLogsDir = path.join(testHome, '.gemini', 'antigravity-cli', 'brain', childId, '.system_generated', 'logs');
      fs.mkdirSync(brainLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(brainLogsDir, 'transcript_full.jsonl'),
        '{"step_index":0,"type":"USER_INPUT","content":"start"}\n' +
        '{"step_index":1,"type":"MODEL","model":"gemini-3.8-pro-preview","content":"hi"}\n'
      );

      const found = findServedModelFromTranscript(childId, testHome);
      expect(found).toBe('gemini-3.8-pro-preview');

      // Rejects invalid childId for safety
      expect(findServedModelFromTranscript('../traversal', testHome)).toBeNull();
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe('approval store: unsafe session ids (A2)', () => {
  let tmpDir = '';
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-store-unsafe-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a path-like id is normalised: no file lands outside the sessions directory', () => {
    const sessions = path.join(tmpDir, 'a', 'b', 'sessions');
    const store = createAntigravityApprovalStore(sessions);
    store.deny('../../x', 'pro', 1000);
    expect(store.record('../../x', { model: 'pro', scope: 'once', created_at: 1001 })).toBe(true);
    expect(store.claim('a/b', 'pro', 1002)).toBeNull(); // a different normalised id ('ab')
    expect(store.claim('../../x', 'pro', 1002)?.scope).toBe('once');
    const outside = fs.readdirSync(path.join(tmpDir, 'a')).sort();
    expect(outside).toEqual(['b']);
    expect(fs.readdirSync(path.join(tmpDir, 'a', 'b')).sort()).toEqual(['sessions']);
    expect(fs.readdirSync(sessions).some((f) => f.startsWith('x.approvals'))).toBe(true);
    expect(fs.readdirSync(sessions).every((f) => !f.includes('/'))).toBe(true);
  });

  it('an id with nothing safe in it behaves as no stored state and does no file I/O', () => {
    const sessions = path.join(tmpDir, 'sessions');
    const store = createAntigravityApprovalStore(sessions);
    const before = fs.readdirSync(sessions);
    for (const id of ['', '../..', '///', undefined as unknown as string, 42 as unknown as string]) {
      store.deny(id, 'pro', 1000);
      expect(store.record(id, { model: 'pro', scope: 'session', created_at: 1001 })).toBe(false);
      expect(store.claim(id, 'pro', 1002)).toBeNull();
      expect(store.attempt(id, 'k', 'sig', 1003)).toBe(1);
      expect(store.wasDeniedRecently(id, 'pro', 1004)).toBeNull();
    }
    expect(fs.readdirSync(sessions)).toEqual(before);
    expect(fs.readdirSync(tmpDir)).toEqual(['sessions']);
  });
});

describe('pull fallback answer matching and record failure (A3, A4)', () => {
  let testDir = '';
  let approvals: ApprovalStore;
  const nowMs = 1_000_000;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pull-a3-'));
    approvals = createAntigravityApprovalStore(path.join(testDir, 'sessions'));
  });
  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const ASK_X =
    '{"step_index":1,"created_at":"2026-11-16T12:00:00.000Z","type":"PLANNER_RESPONSE","tool_calls":[{"id":"ask_X","name":"ask_question","args":{"questions":["[jev-elevate:pro] Allow?"]}}]}\n';

  it('A3: an id-bearing question with no matching row yet does not take another tool\'s GENERIC output', () => {
    const file = path.join(testDir, 't.jsonl');
    fs.writeFileSync(
      file,
      ASK_X + '{"step_index":2,"type":"GENERIC","toolCallId":"other_tool","content":"A1: Yes, once"}\n'
    );
    expect(pullElevationAnswerFromTranscript(file, 'pro', Date.parse('2026-11-16T12:00:00.000Z'))).toBeNull();

    approvals.deny('s-a3', 'pro', nowMs - 5000);
    const decision = evaluateAntigravitySubagentCall(
      {
        conversationId: 's-a3',
        transcriptPath: file,
        modelName: 'gemini-3.8-flash-low',
        toolCall: { id: 'sub', name: 'invoke_subagent', args: { TypeName: 'expert', Model: 'pro' } }
      },
      { approvals, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs }
    );
    expect(decision.decision).toBe('deny');
    expect(decision.pullFallback).toBeUndefined();
  });

  it('A3: once the question\'s own row arrives, its answer is used (and a later unrelated row is not)', () => {
    const file = path.join(testDir, 't.jsonl');
    fs.writeFileSync(
      file,
      ASK_X +
        '{"step_index":2,"type":"GENERIC","toolCallId":"other_tool","content":"A1: Yes, once"}\n' +
        '{"step_index":3,"type":"GENERIC","toolCallId":"ask_X","content":"A1: No, proceed on flash"}\n'
    );
    expect(pullElevationAnswerFromTranscript(file, 'pro', Date.parse('2026-11-16T12:00:00.000Z'))).toEqual({ approved: false });
  });

  it('A3: a question without a tool call id still falls back to the first GENERIC after it', () => {
    const file = path.join(testDir, 't.jsonl');
    fs.writeFileSync(
      file,
      '{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"ask_question","args":{"questions":["[jev-elevate:pro] Q"]}}]}\n' +
        '{"step_index":2,"type":"GENERIC","content":"A1: Yes, once"}\n'
    );
    expect(pullElevationAnswerFromTranscript(file, 'pro')).toEqual({ approved: true, scope: 'once' });
  });

  function transcriptYes(): string {
    const file = path.join(testDir, 'yes.jsonl');
    fs.writeFileSync(file, ASK_X + '{"step_index":2,"type":"GENERIC","toolCallId":"ask_X","content":"A1: Yes, once"}\n');
    return file;
  }
  const subInput = (file: string): AntigravityHookInput => ({
    conversationId: 's-a4',
    transcriptPath: file,
    modelName: 'gemini-3.8-flash-low',
    lastUserInput: 'p',
    toolCall: { id: 'sub', name: 'invoke_subagent', args: { TypeName: 'expert', Model: 'pro' } }
  });

  it('A4: when record fails the pull does not allow, falls back to deny, and a second call does not replay', () => {
    const file = transcriptYes();
    approvals.deny('s-a4', 'pro', nowMs - 5000);
    // A store without the atomic recordAndClaim (record, then claim), whose record fails.
    const failing = { ...approvals, recordAndClaim: undefined, record: () => null as unknown as boolean } as ApprovalStore;
    const first = evaluateAntigravitySubagentCall(subInput(file), { approvals: failing, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs });
    expect(first.decision).toBe('deny');
    expect(first.pullFallback).toBe('record_failed');
    const second = evaluateAntigravitySubagentCall(subInput(file), { approvals: failing, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs + 1000 });
    expect(second.decision).toBe('deny');
    expect(approvals.claim('s-a4', 'pro', nowMs + 2000)).toBeNull();
  });

  it('A4: a record that throws (lock timeout) is a failure too, not an allow', () => {
    const file = transcriptYes();
    approvals.deny('s-a4', 'pro', nowMs - 5000);
    const throwing = {
      ...approvals,
      recordAndClaim: undefined,
      record: () => {
        throw new Error('approvals lock timeout');
      }
    } as ApprovalStore;
    const d = evaluateAntigravitySubagentCall(subInput(file), { approvals: throwing, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs });
    expect(d.decision).toBe('deny');
    expect(d.pullFallback).toBe('record_failed');
  });

  it('A4: the atomic recordAndClaim failing (not stored, or a lock timeout) is a failure too', () => {
    const file = transcriptYes();
    approvals.deny('s-a4', 'pro', nowMs - 5000);
    const notStored = { ...approvals, recordAndClaim: () => ({ stored: false, approval: null }) } as ApprovalStore;
    const a = evaluateAntigravitySubagentCall(subInput(file), { approvals: notStored, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs });
    expect(a.decision).toBe('deny');
    expect(a.pullFallback).toBe('record_failed');
    const throwing = {
      ...approvals,
      recordAndClaim: () => {
        throw new Error('approvals lock timeout');
      }
    } as ApprovalStore;
    const b = evaluateAntigravitySubagentCall(subInput(file), { approvals: throwing, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs + 1000 });
    expect(b.decision).toBe('deny');
    expect(b.pullFallback).toBe('record_failed');
  });

  it('A4: when record succeeds the pull still allows and reports pullFallback true', () => {
    const file = transcriptYes();
    approvals.deny('s-a4', 'pro', nowMs - 5000);
    const d = evaluateAntigravitySubagentCall(subInput(file), { approvals, sessionModelOverride: 'gemini-3.8-flash-low', now: () => nowMs });
    expect(d.decision).toBe('allow');
    expect(d.pullFallback).toBe(true);
  });
});

describe('evaluateAntigravitySubagentCall with an id that has nothing safe in it (R2)', () => {
  it('never touches the approvals store: no stored state, decided normally', () => {
    const calls: string[] = [];
    const store = new Proxy({} as ApprovalStore, {
      get: (_t, name) => () => {
        calls.push(String(name));
        return null;
      }
    });
    const decision = evaluateAntigravitySubagentCall(
      {
        conversationId: '///',
        lastUserInput: 'run subagent on pro',
        modelName: 'gemini-3.8-flash-low',
        toolCall: { id: 't1', name: 'invoke_subagent', args: { TypeName: 'expert', Prompt: 'solve', Model: 'pro' } }
      },
      { approvals: store, sessionModelOverride: 'gemini-3.8-flash-low', now: () => 1000 }
    );
    expect(decision.decision).toBe('deny');
    expect(calls).toEqual([]);
  });
});

describe('Antigravity telemetry helpers (logic)', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-telemetry-helpers-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveAntigravitySessionModel', () => {
    it('prefers inputModelName with source "hook" over quotaView', () => {
      const res = resolveAntigravitySessionModel('  gemini-3.8-pro-low  ', {
        active_model: 'gemini-3.8-flash-low',
        activeModelSource: 'argument'
      });
      expect(res).toEqual({
        sessionModel: 'gemini-3.8-pro-low',
        sessionModelSource: 'hook'
      });
    });

    it('falls back to quotaView.active_model and activeModelSource (or "quota-state" when omitted)', () => {
      expect(
        resolveAntigravitySessionModel('', {
          active_model: '  gemini-3.8-flash-arg  ',
          activeModelSource: 'argument'
        })
      ).toEqual({
        sessionModel: 'gemini-3.8-flash-arg',
        sessionModelSource: 'argument'
      });

      expect(
        resolveAntigravitySessionModel(null, {
          active_model: 'gemini-3.8-flash-latest',
          activeModelSource: 'latest'
        })
      ).toEqual({
        sessionModel: 'gemini-3.8-flash-latest',
        sessionModelSource: 'latest'
      });

      expect(
        resolveAntigravitySessionModel(undefined, {
          active_model: 'gemini-3.8-flash-quota'
        })
      ).toEqual({
        sessionModel: 'gemini-3.8-flash-quota',
        sessionModelSource: 'quota-state'
      });
    });

    it('returns null for both fields when hook model and quotaView model are missing', () => {
      expect(resolveAntigravitySessionModel(undefined, null)).toEqual({
        sessionModel: null,
        sessionModelSource: null
      });
      expect(
        resolveAntigravitySessionModel('   ', {
          active_model: '  ',
          activeModelSource: 'quota-state'
        })
      ).toEqual({
        sessionModel: null,
        sessionModelSource: null
      });
    });
  });

  describe('cleanUserInput and turnId', () => {
    it('strips <ADDITIONAL_METADATA> and <USER_REQUEST> wrappers so PreInvocation and PreToolUse produce identical turn ids', () => {
      const plain = 'Audit telemetry events across hooks';
      const wrapped =
        '<ADDITIONAL_METADATA>\nworkspace: /home/user/projects/jev\ncursor: line 42\n</ADDITIONAL_METADATA>\n' +
        `<USER_REQUEST>\n  ${plain}  \n</USER_REQUEST>`;

      expect(cleanUserInput(wrapped)).toBe(plain);
      expect(turnId(wrapped)).toBe(turnId(plain));
      expect(turnId(wrapped)).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  describe('readAntigravityTurn and writeAntigravityTurn', () => {
    it('round-trips full and minimal turn state', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const full: AntigravityTurnState = {
        turn: 'abc123def456',
        recommendedTier: 'flash',
        recommendedSubagent: 'code-engineer',
        effort: 'medium',
        at: '2026-11-18T12:00:00.000Z'
      };
      writeAntigravityTurn(sessionsDir, 'sess-1', full);
      expect(readAntigravityTurn(sessionsDir, 'sess-1')).toEqual(full);

      const minimal: AntigravityTurnState = {
        turn: 'fedcba654321',
        at: '2026-11-18T12:05:00.000Z'
      };
      writeAntigravityTurn(sessionsDir, 'sess-1', minimal);
      expect(readAntigravityTurn(sessionsDir, 'sess-1')).toEqual(minimal);
    });

    it('returns null and no-ops safely for missing, unsafe, or malformed turn files', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      expect(readAntigravityTurn(sessionsDir, null)).toBeNull();
      expect(readAntigravityTurn(sessionsDir, undefined)).toBeNull();
      expect(readAntigravityTurn(sessionsDir, '../escape')).toBeNull();
      expect(readAntigravityTurn(sessionsDir, 'does-not-exist')).toBeNull();

      // Malformed JSON
      fs.writeFileSync(path.join(sessionsDir, 'bad-json.turn.json'), '{not json');
      expect(readAntigravityTurn(sessionsDir, 'bad-json')).toBeNull();

      // Missing or empty turn field
      fs.writeFileSync(path.join(sessionsDir, 'missing-turn.turn.json'), JSON.stringify({ at: '2026-11-18T00:00:00Z' }));
      expect(readAntigravityTurn(sessionsDir, 'missing-turn')).toBeNull();

      fs.writeFileSync(path.join(sessionsDir, 'empty-turn.turn.json'), JSON.stringify({ turn: '', at: '2026-11-18T00:00:00Z' }));
      expect(readAntigravityTurn(sessionsDir, 'empty-turn')).toBeNull();

      // writeAntigravityTurn ignores missing or unsafe sessionId without throwing
      writeAntigravityTurn(sessionsDir, '../escape', { turn: 'abc', at: '2026-11-18T00:00:00Z' });
      writeAntigravityTurn(sessionsDir, null, { turn: 'abc', at: '2026-11-18T00:00:00Z' });
      expect(fs.existsSync(path.join(tmpDir, 'escape.turn.json'))).toBe(false);
    });
  });

  describe('buildAntigravityTelemetryEvent', () => {
    it('records modelUsedSource "clamped" when decision.clampedTo is set', () => {
      const ev = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        inputModelName: 'gemini-3.8-flash-low',
        lastUserInput: 'run worker',
        args: { TypeName: 'research', Model: 'pro' },
        decision: { decision: 'allow', elevation: 'clamped', clampedTo: 'flash' }
      });

      expect(ev.modelUsed).toBe('flash');
      expect(ev.modelUsedSource).toBe('clamped');
      expect(ev.requestedModel).toBe('pro');
      expect(ev.taskSummary).toBe('subagent: research');
    });

    it('records modelUsedSource "downgraded" when downgradeLog.downgrade is "applied"', () => {
      const ev = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        inputModelName: 'gemini-3.8-flash-low',
        lastUserInput: 'run worker',
        args: { TypeName: 'code-engineer', Model: 'flash' },
        decision: { decision: 'allow', overwrite: { Model: 'flash_lite' } },
        downgradeLog: { downgrade: 'applied', downgrade_to: 'flash_lite' }
      });

      expect(ev.modelUsed).toBe('flash_lite');
      expect(ev.modelUsedSource).toBe('downgraded');
      expect(ev.downgrade).toBe('applied');
    });

    it('records modelUsedSource "requested" when args.Model is explicit without clamp/downgrade', () => {
      const ev = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        inputModelName: 'gemini-3.8-pro-low',
        lastUserInput: 'run worker',
        args: { TypeName: 'code-engineer', Model: 'flash' },
        decision: { decision: 'pass' }
      });

      expect(ev.modelUsed).toBe('flash');
      expect(ev.modelUsedSource).toBe('requested');
      expect(ev.requestedModel).toBe('flash');
    });

    it('records modelUsedSource "inherited" with sessionModel when args.Model is omitted or "inherit"', () => {
      const omittedEv = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        inputModelName: 'gemini-3.8-flash-low',
        lastUserInput: 'run worker',
        args: { TypeName: 'worker' },
        decision: { decision: 'pass' }
      });
      expect(omittedEv.modelUsed).toBe('gemini-3.8-flash-low');
      expect(omittedEv.modelUsedSource).toBe('inherited');
      expect(omittedEv.requestedModel).toBeNull();

      const inheritEv = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        inputModelName: 'gemini-3.8-flash-low',
        lastUserInput: 'run worker',
        args: { TypeName: 'worker', Model: 'inherit' },
        decision: { decision: 'pass' }
      });
      expect(inheritEv.modelUsed).toBe('gemini-3.8-flash-low');
      expect(inheritEv.modelUsedSource).toBe('inherited');
      expect(inheritEv.requestedModel).toBeNull();
    });

    it('records modelUsedSource "inherited" without modelUsed when neither the call nor the session names a model', () => {
      const ev = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        lastUserInput: 'run worker',
        args: { TypeName: 'worker' },
        decision: { decision: 'pass' }
      });
      expect('modelUsed' in ev).toBe(false);
      expect(ev.modelUsedSource).toBe('inherited');
      expect(ev.sessionModel).toBeNull();
      expect(ev.sessionModelSource).toBeNull();
    });

    it('an applied downgrade without downgrade_to falls back to the overwritten Model', () => {
      const ev = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        inputModelName: 'gemini-3.8-pro-low',
        lastUserInput: 'run worker',
        args: { TypeName: 'worker', Model: 'pro' },
        decision: { decision: 'pass', overwrite: { Model: 'flash_lite' } },
        downgradeLog: { downgrade: 'applied' }
      });
      expect(ev.modelUsed).toBe('flash_lite');
      expect(ev.modelUsedSource).toBe('downgraded');
    });

    it('a downgrade that was only asked is a denial: no modelUsed, the requested model stays', () => {
      const ev = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        inputModelName: 'gemini-3.8-pro-low',
        lastUserInput: 'run worker',
        args: { TypeName: 'worker', Model: 'pro' },
        decision: { decision: 'deny' },
        downgradeLog: { downgrade: 'asked', downgrade_to: 'flash_lite' }
      });
      expect(ev.modelUsed).toBeUndefined();
      expect(ev.modelUsedSource).toBeUndefined();
      expect(ev.requestedModel).toBe('pro');
    });

    it('joins turnState.recommendedTier only when turnState.turn matches current turn', () => {
      const prompt = '<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>\n<USER_REQUEST>\nFix bug\n</USER_REQUEST>';
      const expectedTurn = turnId('Fix bug');

      const matched = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        inputModelName: 'gemini-3.8-flash-low',
        lastUserInput: prompt,
        args: { TypeName: 'code-engineer', Model: 'flash' },
        turnState: {
          turn: expectedTurn,
          recommendedTier: 'flash',
          recommendedSubagent: 'code-engineer',
          at: '2026-11-18T12:00:00.000Z'
        },
        decision: { decision: 'pass' }
      });
      expect(matched.turn).toBe(expectedTurn);
      expect(matched.modelRecommended).toBe('flash');
      expect(matched.recommendedTier).toBe('flash');

      const mismatched = buildAntigravityTelemetryEvent({
        kind: 'agent_call',
        conversationId: 'c1',
        inputModelName: 'gemini-3.8-flash-low',
        lastUserInput: prompt,
        args: { TypeName: 'code-engineer', Model: 'flash' },
        turnState: {
          turn: '000000000000',
          recommendedTier: 'pro',
          recommendedSubagent: 'code-engineer',
          at: '2026-11-18T11:55:00.000Z'
        },
        decision: { decision: 'pass' }
      });
      expect(mismatched.turn).toBe(expectedTurn);
      expect(mismatched.modelRecommended).toBeUndefined();
      expect(mismatched.recommendedTier).toBeUndefined();
    });

    it('builds subagent_served event shape', () => {
      const ev = buildAntigravityTelemetryEvent({
        kind: 'subagent_served',
        conversationId: 'parent-1',
        childConversationId: 'child-2',
        requestedModel: 'flash',
        servedModel: 'gemini-3.8-flash-low',
        backfilled: true
      });

      expect(ev).toEqual({
        harness: 'antigravity',
        toolOrHook: 'PostToolUse',
        event: 'subagent_served',
        sessionId: 'parent-1',
        childConversationId: 'child-2',
        requestedModel: 'flash',
        servedModel: 'gemini-3.8-flash-low',
        sessionModel: null,
        sessionModelSource: null,
        backfilled: true
      });
    });

    it('subagent_served carries the session model from the hook input, else the quota view, else null', () => {
      const base = { kind: 'subagent_served' as const, conversationId: 'parent-1', childConversationId: 'child-2', servedModel: 'm' };
      expect(buildAntigravityTelemetryEvent({ ...base, inputModelName: ' gemini-3.8-flash-low ' })).toMatchObject({
        sessionModel: 'gemini-3.8-flash-low',
        sessionModelSource: 'hook'
      });
      expect(
        buildAntigravityTelemetryEvent({ ...base, quotaView: { active_model: 'quota-model', activeModelSource: 'quota-state' } as any })
      ).toMatchObject({ sessionModel: 'quota-model', sessionModelSource: 'quota-state' });
      expect(buildAntigravityTelemetryEvent({ ...base })).toMatchObject({ sessionModel: null, sessionModelSource: null });
    });
  });
});

describe('Antigravity elevation never asks in choice and clamp modes (auto-approve safe)', () => {
  let testDir = '';
  let savedHome: string | undefined;
  let approvals: ApprovalStore;

  const proCall = (overrides: Partial<AntigravityHookInput> = {}): AntigravityHookInput => ({
    conversationId: 'c-noask',
    lastUserInput: 'run subagent on pro',
    modelName: 'gemini-3.8-flash-low',
    toolCall: { id: 't1', name: 'invoke_subagent', args: { TypeName: 'expert-worker', Prompt: 'solve it', Model: 'pro' } },
    ...overrides
  });

  const writeHomeJson = (rel: string, body: string) => {
    const file = path.join(testDir, 'home', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-noask-test-'));
    savedHome = process.env.HOME;
    process.env.HOME = path.join(testDir, 'home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
    approvals = createAntigravityApprovalStore(path.join(testDir, 'sessions'));
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const deps = (extra: Record<string, unknown> = {}, now = 1000) => ({
    approvals,
    sessionModelOverride: 'gemini-3.8-flash-low',
    now: () => now,
    ...extra
  });

  describe('choice mode', () => {
    it('denies attempts 3 and 4 and never returns ask', () => {
      const decisions = [1, 2, 3, 4, 5].map((n) =>
        evaluateAntigravitySubagentCall(proCall(), deps({}, 1000 + n * 50))
      );
      for (const d of decisions) {
        expect(d.decision).toBe('deny');
        expect(d.elevation).toBe('denied');
      }
      expect(decisions.map((d) => d.attemptCount)).toEqual([1, 2, 3, 4, 5]);
    });

    it('keeps the plain question reason for attempts 1-2 and adds the stop-retrying hint from attempt 3', () => {
      const d = [1, 2, 3, 4].map((n) => evaluateAntigravitySubagentCall(proCall(), deps({}, 1000 + n * 50)));
      expect(d[0].reason).not.toContain('stop retrying');
      expect(d[1].reason).not.toContain('stop retrying');
      for (const late of [d[2], d[3]]) {
        expect(late.reason).toContain('[jev-elevate:pro]');
        expect(late.reason).toContain('stop retrying');
        expect(late.reason).toContain('Model: "flash"');
        expect(late.reason).toContain('ask_question');
      }
    });

    it('honours a "Yes, once" answer recorded after two denies at attempt 3, and consumes it only once', () => {
      const transcriptFile = path.join(testDir, 'transcript.jsonl');
      const nowMs = 1_000_000;
      fs.writeFileSync(
        transcriptFile,
        '{"step_index":1,"created_at":"2026-11-16T12:00:00.000Z","type":"PLANNER_RESPONSE","tool_calls":[{"id":"call_q","name":"ask_question","args":{"questions":["[jev-elevate:pro] Allow expert?"]}}]}\n' +
          '{"step_index":2,"type":"GENERIC","toolCallId":"call_q","content":"A1: Yes, once"}\n'
      );
      // Two denies happen before the answer row exists in the transcript.
      const empty = path.join(testDir, 'empty.jsonl');
      fs.writeFileSync(empty, '');
      const d1 = evaluateAntigravitySubagentCall(proCall({ transcriptPath: empty }), deps({}, nowMs));
      const d2 = evaluateAntigravitySubagentCall(proCall({ transcriptPath: empty }), deps({}, nowMs + 1000));
      expect(d1.decision).toBe('deny');
      expect(d2.decision).toBe('deny');

      // Attempt 3: the answer is now in the transcript; the pull fallback must still run and allow.
      const d3 = evaluateAntigravitySubagentCall(proCall({ transcriptPath: transcriptFile }), deps({}, nowMs + 2000));
      expect(d3.decision).toBe('allow');
      expect(d3.elevation).toBe('approved');
      expect(d3.approvalScope).toBe('once');
      expect(d3.pullFallback).toBe(true);

      // The same answer must not be replayed: the next pro attempt is denied again, still never ask.
      const d4 = evaluateAntigravitySubagentCall(proCall({ transcriptPath: transcriptFile }), deps({}, nowMs + 3000));
      expect(d4.decision).toBe('deny');
      expect(d4.reason).toContain('stop retrying');
    });
  });

  describe('clamp mode', () => {
    it('allows every attempt (1..3) with Model overwritten to the ceiling', () => {
      for (const n of [1, 2, 3]) {
        const d = evaluateAntigravitySubagentCall(proCall(), deps({ elevationMode: 'clamp' }, 1000 + n * 50));
        expect(d.decision).toBe('allow');
        expect(d.elevation).toBe('clamped');
        expect(d.overwrite).toEqual({ Model: 'flash' });
        expect(d.clampedTo).toBe('flash');
        expect(d.attemptCount).toBe(n);
      }
    });
  });

  describe('dialog mode', () => {
    const dialog = () => evaluateAntigravitySubagentCall(proCall(), deps({ elevationMode: 'dialog' }));

    it('returns ask with no warning when there is no Antigravity config', () => {
      const d = dialog();
      expect(d.decision).toBe('ask');
      expect(d.elevation).toBe('asked');
      expect(d.autoApproveWarning).toBeUndefined();
    });

    it('carries the warning for a TURBO permission preset and still returns ask', () => {
      writeHomeJson('.gemini/config/config.json', JSON.stringify({ permissionPreset: 'AGENT_PERMISSION_PRESET_TURBO' }));
      const d = dialog();
      expect(d.decision).toBe('ask');
      expect(d.elevation).toBe('asked');
      expect(d.autoApproveWarning).toBe(true);
    });

    it('carries the warning for toolPermission always-proceed in the CLI settings', () => {
      writeHomeJson('.gemini/antigravity-cli/settings.json', JSON.stringify({ toolPermission: 'always-proceed' }));
      const d = dialog();
      expect(d.decision).toBe('ask');
      expect(d.autoApproveWarning).toBe(true);
    });

    it('has no warning for a non-turbo preset', () => {
      writeHomeJson('.gemini/config/config.json', JSON.stringify({ permissionPreset: 'AGENT_PERMISSION_PRESET_DEFAULT' }));
      writeHomeJson('.gemini/antigravity-cli/settings.json', JSON.stringify({ toolPermission: 'ask' }));
      expect(dialog().autoApproveWarning).toBeUndefined();
    });

    it('does not throw and adds no warning for malformed or non-object JSON', () => {
      for (const body of ['{not json', '', '[]', 'null', '"AGENT_PERMISSION_PRESET_TURBO"']) {
        writeHomeJson('.gemini/config/config.json', body);
        writeHomeJson('.gemini/antigravity-cli/settings.json', body);
        const d = dialog();
        expect(d.decision).toBe('ask');
        expect(d.autoApproveWarning).toBeUndefined();
      }
    });

    it('detectAntigravityAutoApprove treats an unreadable path as not detected', () => {
      fs.mkdirSync(path.join(testDir, 'home', '.gemini', 'config', 'config.json'), { recursive: true });
      expect(detectAntigravityAutoApprove(path.join(testDir, 'home'))).toBe(false);
    });
  });
});
