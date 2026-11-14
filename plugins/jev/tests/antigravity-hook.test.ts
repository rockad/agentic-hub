import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateAntigravitySubagentCall,
  parseElevationAnswer,
  extractAskAnswer,
  buildElevationQuestion,
  type AntigravityHookInput,
  type AntigravityHookDecision
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

  it('triggers dialog backstop (ask) on 3rd attempt without approval in the same prompt', () => {
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

    // Attempt 3: ask (backstop)
    const d3 = evaluateAntigravitySubagentCall(input, {
      approvals,
      sessionModelOverride: 'gemini-3.8-flash-low',
      now: () => 1100
    });
    expect(d3.decision).toBe('ask');
    expect(d3.elevation).toBe('asked');
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
      'Do not rush, use deep reasoning'
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

  it('keeps a multi-line free-text answer whole, so it can never equal a label', () => {
    expect(extractAskAnswer({ content: 'Created At: x\nCompleted At: y\nA1: Yes,\nonce' }, 0)).toBe('Yes,\nonce');
    expect(parseElevationAnswer('A1: Yes,\nonce')).toEqual({ approved: false });
  });
});
