/**
 * The Antigravity `run_workflow` static guard (antigravity/workflow-guard.ts): the Python tokenizer and analyser, the Q3
 * idioms, and the hook decision in choice, clamp, dialog, on-demand and (through the hook, which never gets there) off.
 * Pure: no real home, no network, the approval store lives in a temporary directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  analyzePythonScript,
  evaluateAntigravityWorkflowCall,
  evaluateWorkflowInput,
  tokenizePython,
  workflowChoiceReason,
  workflowSignature,
  type DefinitionResolver
} from '../antigravity/workflow-guard.ts';
import { createAntigravityApprovalStore, type ApprovalStore } from '../antigravity/approvals.ts';
import type { AntigravityHookInput } from '../antigravity/logic.ts';
import type { ScriptFact } from '../src/core/workflow-pin.ts';

const FLASH = 'gemini-3.8-flash-low';
const ORCH_WORKER = 'gemini-flash-worker-agy';
const ORCH_PLANNER = 'gemini-pro-orchestrator-g1-pro';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function analyse(script: string, sessionModel = FLASH, extra: { lastUserInput?: string; definitions?: DefinitionResolver } = {}) {
  const facts: ScriptFact[] = [];
  const seen = { models: [] as string[], instructed: false };
  const sites = analyzePythonScript(script, '<inline>', { sessionModel, seen, ...extra }, facts);
  return { sites, facts, seen };
}
const kinds = (script: string, model = FLASH) => analyse(script, model).sites.map((s) => s.kind);

describe('tokenizePython', () => {
  it('skips comments and keeps every string literal as one token', () => {
    const toks = tokenizePython(`# agent(model="pro")\nx = 'agent(model="pro")' + """multi\nline agent(""" + r"a\\"b"\n`);
    expect(toks.filter((t) => t.t === 'name').map((t) => t.v)).toEqual(['x']);
    expect(toks.filter((t) => t.t === 'str').length).toBe(3);
  });

  it('rejects a string that never ends', () => {
    expect(() => tokenizePython(`x = "abc\ny = 1`)).toThrow();
    expect(() => tokenizePython(`x = """abc`)).toThrow();
  });

  it('reads string prefixes, line positions and line continuations', () => {
    const toks = tokenizePython(`a = f"{x}"\nb = rb'..' \\\n  + c`);
    expect(toks.find((t) => t.v === 'b')?.line).toBe(2);
    expect(toks.find((t) => t.v === 'c')?.line).toBe(3);
    expect(toks.filter((t) => t.t === 'str').map((t) => t.prefix)).toEqual(['f', 'rb']);
  });
});

describe('analyzePythonScript: what passes', () => {
  it('a script with no agent call has nothing to find', () => {
    expect(analyse('x = 1\nprint(x)\n').sites).toEqual([]);
  });

  it('a mention of agent(model="pro") in a comment, a string or a docstring is never read as code', () => {
    const s = `# agent(model="pro")\nnote = 'agent(model="pro")'\n"""\nagent(model="pro")\n"""\nawait agent("p", model="flash")\n`;
    expect(analyse(s).sites).toEqual([]);
  });

  it('literal models at or below the ceiling, keyword and positional, with None and inherit', () => {
    const s = [
      'await agent("p", model="flash")',
      'await agent("p", model="flash_lite", type_name="self")',
      'await agent("p", None, None, "self", "inherit", "flash")',
      'await agent("p", model=None)',
      'await agent("p", model="inherit")',
      'await agent("p")'
    ].join('\n');
    const r = analyse(s);
    expect(r.sites).toEqual([]);
    expect(r.seen.models).toEqual(['flash', 'flash_lite', 'flash']);
  });

  it('the Q3 script shape: a nested async def passed by reference to parallel(), multi-line keyword calls, type_name self', () => {
    const s = `
async def main(items):
    async def helper(item):
        return await agent(
            prompt=f"summarise {item}",
            type_name="self",
            model="flash",
        )
    return await parallel(items, helper)
`;
    expect(analyse(s).sites).toEqual([]);
  });

  it('the same nested shape with a pro model is one elevation, found inside the helper', () => {
    const s = `
async def main(items):
    async def helper(item):
        return await agent(
            prompt="x",
            type_name="self",
            model="pro",
        )
    return await parallel(items, helper)
`;
    const r = analyse(s);
    expect(r.sites.map((x) => [x.kind, x.tier, x.line])).toEqual([['elevation', 'pro', 4]]);
  });

  it('re.compile and other attributes named like an escape are not escapes', () => {
    expect(analyse('import re\np = re.compile("a")\nawait agent("p")').sites).toEqual([]);
  });

  it('a pro session may use pro; an Orchestrator worker may not', () => {
    expect(analyse('await agent("p", model="pro")', 'gemini-3.1-pro').sites).toEqual([]);
    expect(kinds('await agent("p", model="pro")', ORCH_WORKER)).toEqual(['elevation']);
    expect(analyse('await agent("p", model="flash")', ORCH_WORKER).sites).toEqual([]);
  });

  it('a model the user named in the prompt passes (instructed)', () => {
    const r = analyse('await agent("p", model="pro")', FLASH, { lastUserInput: 'use gemini pro for the review' });
    expect(r.sites).toEqual([]);
    expect(r.seen.instructed).toBe(true);
  });
});

describe('analyzePythonScript: elevations', () => {
  it('keyword and positional literal pro are elevations over a flash session, with their position', () => {
    const r = analyse('x = 1\nawait agent("p", model="pro")\nawait agent("p", None, None, "self", "inherit", "gemini-3.1-pro")');
    expect(r.sites.map((s) => [s.kind, s.tier, s.line])).toEqual([
      ['elevation', 'pro', 2],
      ['elevation', 'pro', 3]
    ]);
  });

  it('a literal with different casing and spaces is read as written', () => {
    expect(analyse('await agent("p", model=" PRO ")').sites[0]?.tier).toBe('pro');
  });
});

describe('analyzePythonScript: unverifiable idioms', () => {
  const cases: Array<[string, string]> = [
    ['a variable model', 'tier = "pro"\nawait agent("p", model=tier)'],
    ['an expression model', 'await agent("p", model="fl" + "ash")'],
    ['a conditional model', 'await agent("p", model="pro" if x else "flash")'],
    ['an f-string model', 'await agent("p", model=f"{t}")'],
    ['an implicit concatenation', 'await agent("p", model="fl" "ash")'],
    ['a bytes model', 'await agent("p", model=b"pro")'],
    ['a positional dynamic model', 'await agent("p", None, None, "self", "inherit", tier)'],
    ['**kwargs', 'await agent("p", **opts)'],
    ['*args', 'await agent(*a)'],
    ['an aliased agent', 'a = agent\nawait a("p", model="pro")'],
    ['agent passed by reference', 'await parallel(items, agent)'],
    ['an attribute agent', 'await ctx.agent("p")'],
    ['a local definition named agent', 'def agent(p):\n    pass'],
    ['a decorator', '@agent\ndef f(): pass'],
    ['exec', 'exec("await agent(\'p\', model=\'pro\')")'],
    ['eval', 'x = eval("1")'],
    ['importlib', 'import importlib\nm = importlib.import_module("x")'],
    ['__import__', 'm = __import__("os")'],
    ['globals()', 'g = globals()["agent"]'],
    ['an f-string expression naming agent', 'x = f"{agent}"'],
    ['an unknown model name', 'await agent("p", model="turbo")'],
    ['an openrouter model', 'await agent("p", model="openrouter/free")'],
    ['an unclosed string', 'x = "abc\nawait agent("p")'],
    ['an unbalanced call', 'await agent("p", model="flash"'],
    ['a duplicated model', 'await agent("p", None, None, "self", "inherit", "flash", model="pro")'],
    ['a dynamic type_name with no model', 'await agent("p", type_name=kind)'],
    ['an unknown definition with no model', 'await agent("p", type_name="research")']
  ];
  for (const [name, script] of cases) {
    it(name, () => {
      const r = analyse(script);
      expect(r.sites.length).toBeGreaterThan(0);
      expect(r.sites.every((s) => s.kind === 'unverifiable')).toBe(true);
    });
  }

  it('an omitted or inherit model under an Orchestrator session is unverifiable (Decision 2), in both Orchestrator ids', () => {
    for (const m of [ORCH_WORKER, ORCH_PLANNER]) {
      expect(kinds('await agent("p")', m)).toEqual(['unverifiable']);
      expect(kinds('await agent("p", model="inherit")', m)).toEqual(['unverifiable']);
      expect(kinds('await agent("p", model="flash")', m)).toEqual([]);
    }
  });

  it('a named definition supplies the model when model is absent: its pro is an elevation, its flash passes, none inherits', () => {
    const defs: DefinitionResolver = {
      definition: (n) => (n === 'deep' ? { found: true, model: 'pro' } : n === 'plain' ? { found: true, model: null } : n === 'cheap' ? { found: true, model: 'flash' } : { found: false, model: null })
    };
    expect(analyse('await agent("p", type_name="deep")', FLASH, { definitions: defs }).sites.map((s) => s.kind)).toEqual(['elevation']);
    expect(analyse('await agent("p", type_name="cheap")', FLASH, { definitions: defs }).sites).toEqual([]);
    expect(analyse('await agent("p", type_name="plain")', FLASH, { definitions: defs }).sites).toEqual([]);
    // An explicit model wins over the definition.
    expect(analyse('await agent("p", type_name="deep", model="flash")', FLASH, { definitions: defs }).sites).toEqual([]);
    // Positional type_name (slot 3).
    expect(analyse('await agent("p", None, None, "deep")', FLASH, { definitions: defs }).sites.map((s) => s.kind)).toEqual(['elevation']);
  });

  it('the report carries positions and reasons, never the script text', () => {
    const secret = 'SECRET_PAYLOAD_TEXT';
    const r = analyse(`token = "${secret}"\nawait agent("${secret}", model=tier)`);
    expect(JSON.stringify(r.sites)).not.toContain(secret);
  });

  it('an oversized script is unverifiable and is not hashed', () => {
    const r = analyse('x = 1\n'.repeat(120_000));
    expect(r.sites[0]?.kind).toBe('unverifiable');
    expect(r.facts).toEqual([]);
  });
});

describe('evaluateWorkflowInput', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wf-guard-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ev = (args: unknown, where: object = { cwd: dir }) => evaluateWorkflowInput(args, where, { sessionModel: FLASH, definitions: { definition: () => ({ found: false, model: null }) } });

  it('reads Script, hashes it and allows a clean one', () => {
    const script = 'await agent("p", model="flash")';
    const d = ev({ Script: script });
    expect(d.decision).toBe('allow');
    expect(d.scripts).toEqual([{ label: '<inline>', sha256: sha(script), bytes: Buffer.byteLength(script) }]);
  });

  it('reads ScriptPath relative to Cwd, then the hook cwd, and tolerates the lowercase spellings', () => {
    fs.writeFileSync(path.join(dir, 's.py'), 'await agent("p", model="pro")');
    for (const args of [{ ScriptPath: 's.py', Cwd: dir }, { script_path: 's.py', cwd: dir }, { scriptPath: 's.py' }]) {
      const d = ev(args);
      expect(d.elevations.length).toBe(1);
      expect(d.scripts[0].label).toBe(path.join(dir, 's.py'));
    }
  });

  it('analyses Script and ScriptPath together', () => {
    fs.writeFileSync(path.join(dir, 's.py'), 'await agent("p", model="pro")');
    const d = ev({ script: 'await agent("p", model=tier)', ScriptPath: 's.py' });
    expect(d.unverifiable.length).toBe(1);
    expect(d.elevations.length).toBe(1);
    expect(d.scripts.length).toBe(2);
  });

  it('is unverifiable for a missing, directory, FIFO or oversized ScriptPath and for a bad shape', () => {
    fs.mkdirSync(path.join(dir, 'd'));
    fs.writeFileSync(path.join(dir, 'big.py'), 'x = 1\n'.repeat(120_000));
    for (const args of [{ ScriptPath: 'nope.py' }, { ScriptPath: 'd' }, { ScriptPath: 'big.py' }, {}, { Script: '' }, { Script: 3 }, null, [], { ScriptPath: '' }]) {
      const d = ev(args);
      expect(d.decision).toBe('ask');
      expect(d.unverifiable.length).toBeGreaterThan(0);
    }
  });

  it('a FIFO at ScriptPath is unverifiable and never blocks', () => {
    const fifo = path.join(dir, 'p.fifo');
    const mk = Bun.spawnSync(['mkfifo', fifo]);
    if (mk.exitCode !== 0) return; // no mkfifo here
    const t0 = Date.now();
    const d = ev({ ScriptPath: fifo });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(d.unverifiable.length).toBe(1);
  });
});

describe('evaluateAntigravityWorkflowCall', () => {
  let tmp = '';
  let approvals: ApprovalStore;
  let pins = '';
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wf-call-'));
    approvals = createAntigravityApprovalStore(path.join(tmp, 'sessions'));
    pins = path.join(tmp, 'pins');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const call = (script: string, extra: Partial<AntigravityHookInput> = {}): AntigravityHookInput => ({
    conversationId: 'conv-wf',
    modelName: FLASH,
    lastUserInput: 'run the review workflow',
    stepIdx: 4,
    toolCall: { id: 'call_wf', name: 'run_workflow', args: { Script: script } },
    ...extra
  });
  const deps = (mode: 'on' | 'on-demand' = 'on', extra: object = {}) => ({
    mode,
    sessionModel: FLASH,
    approvals,
    pinDir: pins,
    now: () => 1_000_000,
    definitions: { definition: () => ({ found: false, model: null }) },
    ...extra
  });
  const CLEAN = 'await agent("p", model="flash")';
  const PRO = 'await agent("p", model="pro")';
  const DYN = 'await agent("p", model=tier)';

  it('a clean script passes with nothing printed (pass) and is pinned under the tool call id', () => {
    const r = evaluateAntigravityWorkflowCall(call(CLEAN), deps());
    expect(r.decision.decision).toBe('pass');
    expect(r.log.workflow_guard).toBe('allow');
    expect(fs.readdirSync(pins)).toEqual(['call_wf.json']);
    const pin = JSON.parse(fs.readFileSync(path.join(pins, 'call_wf.json'), 'utf8'));
    expect(pin.scripts[0].sha256).toBe(sha(CLEAN));
    expect(pin.decision).toBe('allow');
  });

  it('a tool call other than run_workflow is untouched', () => {
    const r = evaluateAntigravityWorkflowCall({ ...call(CLEAN), toolCall: { id: 'x', name: 'invoke_subagent', args: {} } }, deps());
    expect(r.decision.decision).toBe('pass');
    expect(r.log).toEqual({});
  });

  describe('choice (default)', () => {
    it('a pro literal is denied with the [jev-elevate:pro] question and the script hash, and the denial is recorded', () => {
      const r = evaluateAntigravityWorkflowCall(call(PRO), deps());
      expect(r.decision.decision).toBe('deny');
      expect(r.decision.reason).toContain('[jev-elevate:pro]');
      expect(r.decision.reason).toContain(`sha256:${sha(PRO).slice(0, 12)}`);
      expect(r.decision.reason).toContain('ask_question');
      expect(r.decision.reason).not.toContain('agent("p"');
      expect(r.log.workflow_guard).toBe('denied');
      expect(approvals.wasDeniedRecently('conv-wf', 'pro', 1_000_000)).toBe(1_000_000);
      expect(fs.existsSync(pins)).toBe(false); // a denied call does not run: no pin
    });

    it('a covering approval allows the call and pins it; once is used up by one run', () => {
      evaluateAntigravityWorkflowCall(call(PRO), deps());
      approvals.record('conv-wf', { model: 'pro', scope: 'once', created_at: 1_000_000 });
      const ok = evaluateAntigravityWorkflowCall(call(PRO), deps());
      expect(ok.decision.decision).toBe('allow');
      expect(ok.decision.elevation).toBe('approved');
      expect(ok.decision.approvalScope).toBe('once');
      expect(fs.readdirSync(pins)).toEqual(['call_wf.json']);
      const again = evaluateAntigravityWorkflowCall(call(PRO), deps());
      expect(again.decision.decision).toBe('deny');
    });

    it('a session approval covers a different script too', () => {
      evaluateAntigravityWorkflowCall(call(PRO), deps());
      approvals.record('conv-wf', { model: 'pro', scope: 'session', created_at: 1_000_000 });
      expect(evaluateAntigravityWorkflowCall(call('await agent("q", model="gemini-3.1-pro")'), deps()).decision.decision).toBe('allow');
    });

    it('never asks, attempt after attempt, and from the third attempt says to stop retrying', () => {
      const reasons: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = evaluateAntigravityWorkflowCall(call(PRO), deps());
        expect(r.decision.decision).toBe('deny');
        reasons.push(r.decision.reason ?? '');
      }
      expect(reasons[0]).not.toContain('stop retrying');
      expect(reasons[2]).toContain('stop retrying');
    });

    it('an unverifiable script is a deny with the sites and what to change, never an ask, and no question marker', () => {
      const r = evaluateAntigravityWorkflowCall(call(`x = 1\n${DYN}`), deps());
      expect(r.decision.decision).toBe('deny');
      expect(r.decision.reason).toContain(':2:');
      expect(r.decision.reason).toContain('not a string literal');
      expect(r.decision.reason).not.toContain('[jev-elevate:');
      expect(r.log.workflow_guard).toBe('denied-unverifiable');
      expect(r.log.workflow_reasons).toBe(1);
    });

    it('a script with both: one deny, the unverifiable fix first (no question yet)', () => {
      const r = evaluateAntigravityWorkflowCall(call(`${PRO}\n${DYN}`), deps());
      expect(r.decision.decision).toBe('deny');
      expect(r.decision.reason).not.toContain('[jev-elevate:');
    });

    it('a model the prompt named is allowed as instructed', () => {
      const r = evaluateAntigravityWorkflowCall(call(PRO, { lastUserInput: 'use gemini pro please' }), deps());
      expect(r.decision.decision).toBe('allow');
      expect(r.decision.elevation).toBe('instructed');
      expect(r.log.workflow_guard).toBe('passed-instructed');
    });

    it('under an Orchestrator worker: flash passes, pro is denied with the ceiling flash, an omitted model is unverifiable', () => {
      const o = deps('on', { sessionModel: ORCH_WORKER });
      expect(evaluateAntigravityWorkflowCall(call(CLEAN, { modelName: ORCH_WORKER }), o).decision.decision).toBe('pass');
      const pro = evaluateAntigravityWorkflowCall(call(PRO, { modelName: ORCH_WORKER }), o);
      expect(pro.decision.reason).toContain("session ceiling 'flash'");
      const omitted = evaluateAntigravityWorkflowCall(call('await agent("p")', { modelName: ORCH_WORKER }), o);
      expect(omitted.decision.decision).toBe('deny');
      expect(omitted.log.workflow_guard).toBe('denied-unverifiable');
    });
  });

  describe('clamp', () => {
    it('is the choice flow (a script cannot be clamped) and never asks', () => {
      const e = deps('on', { elevationMode: 'clamp' });
      const pro = evaluateAntigravityWorkflowCall(call(PRO), e);
      expect(pro.decision.decision).toBe('deny');
      expect(pro.decision.reason).toContain('[jev-elevate:pro]');
      expect(pro.decision.overwrite).toBeUndefined();
      const dyn = evaluateAntigravityWorkflowCall(call(DYN), e);
      expect(dyn.decision.decision).toBe('deny');
      approvals.record('conv-wf', { model: 'pro', scope: 'session', created_at: 1_000_000 });
      expect(evaluateAntigravityWorkflowCall(call(PRO), e).decision.decision).toBe('allow');
    });
  });

  describe('dialog', () => {
    const d = () => deps('on', { elevationMode: 'dialog' });
    it('asks for an elevation and for an unverifiable script, listing the sites, and pins the ask', () => {
      const a = evaluateAntigravityWorkflowCall(call(PRO), d());
      expect(a.decision.decision).toBe('ask');
      expect(a.decision.elevation).toBe('asked');
      expect(a.decision.reason).toContain('above the session ceiling');
      expect(a.log.workflow_guard).toBe('asked');
      const b = evaluateAntigravityWorkflowCall(call(DYN), d());
      expect(b.decision.decision).toBe('ask');
      expect(JSON.parse(fs.readFileSync(path.join(pins, 'call_wf.json'), 'utf8')).decision).toBe('ask');
    });
    it('a clean script still passes', () => {
      expect(evaluateAntigravityWorkflowCall(call(CLEAN), d()).decision.decision).toBe('pass');
    });
    it('records nothing in the approval store and counts no attempt', () => {
      evaluateAntigravityWorkflowCall(call(PRO), d());
      expect(approvals.wasDeniedRecently('conv-wf', 'pro', 1_000_000)).toBeNull();
    });
  });

  describe('on-demand and off', () => {
    it('on-demand makes no decision for any script: pass, no analysis, no pin, no approval or attempt state', () => {
      for (const s of [CLEAN, PRO, DYN, 'await agent("p"']) {
        const r = evaluateAntigravityWorkflowCall(call(s), deps('on-demand'));
        expect(r.decision).toEqual({ decision: 'pass' });
        expect(r.log).toEqual({ workflow_guard: 'skipped' });
      }
      expect(fs.existsSync(pins)).toBe(false);
      expect(approvals.wasDeniedRecently('conv-wf', 'pro', 1_000_000)).toBeNull();
    });
    it('off makes no decision either (the hook returns before it gets here)', () => {
      const r = evaluateAntigravityWorkflowCall(call(PRO), { ...deps(), mode: 'off' as any });
      expect(r.decision.decision).toBe('pass');
      expect(fs.existsSync(pins)).toBe(false);
    });
  });

  it('an internal error fails open (pass, workflow_guard: error)', () => {
    const boom = { ...deps(), approvals: { claim: () => { throw new Error('boom'); } } as unknown as ApprovalStore };
    const r = evaluateAntigravityWorkflowCall(call(PRO), boom);
    expect(r.decision.decision).toBe('pass');
    expect(r.log.workflow_guard).toBe('error');
  });

  it('the log carries hashes, models and counts, never script text', () => {
    const secret = 'SECRET_PAYLOAD_TEXT';
    const r = evaluateAntigravityWorkflowCall(call(`note = "${secret}"\nawait agent("${secret}", model="pro")`), deps());
    expect(JSON.stringify(r.log)).not.toContain(secret);
    expect(JSON.stringify(r.decision)).not.toContain(secret);
    expect((r.log.workflow_scripts as any[])[0].sha256).toBeTruthy();
  });
});

describe('texts', () => {
  it('the choice reason uses the marker, four options in order, and the stop text from attempt 3', () => {
    const facts: ScriptFact[] = [{ label: '<inline>', sha256: 'a'.repeat(64), bytes: 1 }];
    const top = { file: '<inline>', line: 1, col: 1, reason: 'x', kind: 'elevation' as const, tier: 'pro' as const, rank: 3, requested: 'pro' };
    const r = workflowChoiceReason(top, 'flash', facts, 1);
    expect(r).toContain("'[jev-elevate:pro]'");
    expect(r).toContain('sha256:aaaaaaaaaaaa');
    expect(r.indexOf('Yes, once')).toBeLessThan(r.indexOf('Yes, for the next 5 minutes'));
    expect(r.indexOf('Yes, for this session')).toBeLessThan(r.indexOf('No, proceed on flash'));
    expect(workflowChoiceReason(top, 'flash', facts, 3)).toContain('stop retrying');
  });

  it('the signature is stable for the same hashes and differs when the script changes', () => {
    const a: ScriptFact[] = [{ label: '<inline>', sha256: sha('one'), bytes: 3 }];
    const b: ScriptFact[] = [{ label: '<inline>', sha256: sha('two'), bytes: 3 }];
    expect(workflowSignature(a)).toBe(workflowSignature([...a]));
    expect(workflowSignature(a)).not.toBe(workflowSignature(b));
  });
});
