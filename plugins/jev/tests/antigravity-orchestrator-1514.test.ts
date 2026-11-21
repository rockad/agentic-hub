/**
 * Antigravity 1.5.14 Orchestrator detection (Jev 2.3.18). From 1.5.14 an Orchestrator turn reports the model the user chose
 * (planners gemini-4-neon-*, gemini-4-argon-*, claude-opus-5-5-*, gemini-4-carbon-*; executors gemini-4-hydrogen-*,
 * claude-sonnet-5-5-*), the same ids a plain /model choice reports. The conversation is an Orchestrator one when the file
 * `annotations/<conversationId>.pbtxt` (beside the artifact directory) holds `plan_execute:true`.
 * Hermetic: temp directories and a temp HOME, fake conversation ids.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  recordAntigravitySession,
  writeAntigravitySessionModel,
  resolveAntigravityTurnModel,
  isPlannerFamilyModel,
  isExecutorFamilyModel,
  isOrchestratorModel,
  subagentCeilingRank,
  clampTierToSessionCeiling,
  readQuotaView
} from '../src/core/governance.ts';
import {
  hasOrchestratorMarker,
  hasPlanExecuteField,
  orchestratorAnnotationPath,
  ORCHESTRATOR_ANNOTATION_MAX_BYTES
} from '../src/core/orchestrator-marker.ts';
import { runPreflight } from '../antigravity/preflight.ts';
import { clearConfigCacheForTesting } from '../src/core/config.ts';

const HOOK = path.join(import.meta.dir, '..', 'antigravity', 'hook.ts');
const CONV = '00000000-0000-4000-8000-0000000000a1';

const PLANNERS = ['gemini-4-neon-high', 'gemini-4-argon-medium', 'claude-opus-5-5-high', 'gemini-4-carbon-low'];
const EXECUTORS = ['gemini-4-hydrogen-medium', 'claude-sonnet-5-5-high'];
const NEITHER = ['gemini-3.8-flash-low', 'gpt-oss-120b-medium', 'gemini-3.8-flash-high'];

let root = '';
let sessions = '';
/** The artifact directory Antigravity would pass: `annotations/` sits two levels above it. */
const artifactDir = (conv = CONV) => path.join(root, 'brain', conv);
const annotationFile = (conv = CONV) => path.join(root, 'annotations', `${conv}.pbtxt`);
function writeMarker(text = 'plan_execute:true\n', conv = CONV): void {
  fs.mkdirSync(path.dirname(annotationFile(conv)), { recursive: true });
  fs.writeFileSync(annotationFile(conv), text);
}
const rec = (name = `${CONV}.model.json`) => JSON.parse(fs.readFileSync(path.join(sessions, name), 'utf8'));
const record = (model: string, now: number, extra: { readMarker?: boolean; withDir?: boolean } = {}) =>
  recordAntigravitySession(CONV, model, now, sessions, {
    ...(extra.withDir === false ? {} : { artifactDirectoryPath: artifactDir() }),
    ...(extra.readMarker === undefined ? {} : { readMarker: extra.readMarker })
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-orch-1514-'));
  sessions = path.join(root, 'sessions');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('the annotation marker', () => {
  it('path: two levels above the artifact directory, annotations/<id>.pbtxt', () => {
    expect(orchestratorAnnotationPath(artifactDir(), CONV)).toBe(annotationFile());
  });

  it('plan_execute:true is detected, with or without a space', () => {
    writeMarker('name: "x"\nplan_execute:true\n');
    expect(hasOrchestratorMarker(artifactDir(), CONV)).toBe(true);
    writeMarker('plan_execute: true');
    expect(hasOrchestratorMarker(artifactDir(), CONV)).toBe(true);
  });

  it('absent file, plan_execute:false and look-alikes are not detected', () => {
    expect(hasOrchestratorMarker(artifactDir(), CONV)).toBe(false);
    for (const t of ['plan_execute:false', 'xplan_execute:true', 'plan_execute:trueish', 'plan_execute_x:true', '']) {
      writeMarker(t);
      expect(hasOrchestratorMarker(artifactDir(), CONV)).toBe(false);
    }
  });

  it('the field is matched as a field: the single-line real form and the multi-line form are detected', () => {
    for (const t of [
      'title:"notes" plan_execute:true',
      'title:"say \\"hi\\"" plan_execute:true other:1',
      'title: "a"\nplan_execute: true\nx: 1\n',
      'meta { plan_execute: true }',
      'a:1, plan_execute:true'
    ]) {
      writeMarker(t);
      expect(hasOrchestratorMarker(artifactDir(), CONV)).toBe(true);
    }
  });

  it('a title that mentions plan_execute:true is not the field, even when the real field is false', () => {
    for (const t of [
      'title: "notes on plan_execute:true flag" plan_execute:false',
      'title:"notes on plan_execute:true flag" plan_execute:false\n',
      "title: 'plan_execute: true' plan_execute:false",
      'title: "say \\"x\\" plan_execute:true" plan_execute:false',
      'title: "plan_execute:true"',
      '# plan_execute: true\nplan_execute: false'
    ]) {
      writeMarker(t);
      expect(hasOrchestratorMarker(artifactDir(), CONV)).toBe(false);
    }
    expect(hasPlanExecuteField('title:"a plan_execute:true b" plan_execute:false')).toBe(false);
    expect(hasPlanExecuteField('title:"a plan_execute:true b" plan_execute:true')).toBe(true);
  });

  it('unreadable (a directory in its place) is not detected, and nothing throws', () => {
    fs.mkdirSync(annotationFile(), { recursive: true });
    expect(hasOrchestratorMarker(artifactDir(), CONV)).toBe(false);
  });

  it('oversized is not detected, even with the marker at the start', () => {
    writeMarker('plan_execute:true\n' + 'x'.repeat(ORCHESTRATOR_ANNOTATION_MAX_BYTES));
    expect(hasOrchestratorMarker(artifactDir(), CONV)).toBe(false);
    writeMarker('plan_execute:true\n' + 'x'.repeat(1024));
    expect(hasOrchestratorMarker(artifactDir(), CONV)).toBe(true);
  });

  it('bad inputs never read anything', () => {
    writeMarker();
    for (const dir of [undefined, null, 42, '', 'relative/path', `${artifactDir()}\0x`, 'x'.repeat(5000)]) {
      expect(hasOrchestratorMarker(dir, CONV)).toBe(false);
    }
    for (const id of [undefined, '', '../x', 'a/b', '..', 'a..b', '.hidden', `${CONV}\0`]) {
      expect(hasOrchestratorMarker(artifactDir(), id)).toBe(false);
    }
  });
});

describe('role families', () => {
  it('planner and executor families, legacy ids included', () => {
    for (const m of [...PLANNERS, 'gemini-pro-orchestrator-g1-pro', 'Orchestrator (Argon)']) expect(isPlannerFamilyModel(m)).toBe(true);
    for (const m of [...EXECUTORS, 'gemini-flash-worker-agy']) expect(isExecutorFamilyModel(m)).toBe(true);
    for (const m of [...PLANNERS, ...EXECUTORS]) {
      expect(isPlannerFamilyModel(m) && isExecutorFamilyModel(m)).toBe(false);
    }
    for (const m of ['gemini-3.8-flash-low', 'gpt-oss-120b-medium', 'gemini-3.8-flash-high', '', null, undefined]) {
      expect(isPlannerFamilyModel(m)).toBe(false);
      expect(isExecutorFamilyModel(m)).toBe(false);
    }
  });

  it('the 1.5.14 ids are not Orchestrator by id alone: the legacy check stays false', () => {
    for (const m of [...PLANNERS, ...EXECUTORS]) expect(isOrchestratorModel(m)).toBe(false);
  });

  it('outside an Orchestrator conversation these ids are ranked by tier; inside, the ceiling is flash', () => {
    expect(subagentCeilingRank('gemini-4-neon-high')).toBe(3);
    expect(subagentCeilingRank('claude-opus-5-5-high')).toBe(3);
    expect(subagentCeilingRank('gemini-4-hydrogen-medium')).toBe(2);
    expect(subagentCeilingRank('gemini-4-neon-high', true)).toBe(2);
    expect(subagentCeilingRank('claude-opus-5-5-high', true)).toBe(2);
    expect(subagentCeilingRank('gemini-4-neon-high', false)).toBe(3);
    expect(clampTierToSessionCeiling('pro', 'gemini-4-neon-high', '').wasClamped).toBe(false);
    expect(clampTierToSessionCeiling('pro', 'gemini-4-neon-high', '', true)).toMatchObject({ wasClamped: true, ceilingTier: 'flash' });
  });
});

describe('recording the session: planner, executor and plain, for each family', () => {
  const now = Math.floor(Date.now() / 1000);

  for (const planner of PLANNERS) {
    for (const executor of EXECUTORS) {
      it(`marker present: ${planner} then ${executor}: the planner stays the session model, the executor is the turn model`, () => {
        writeMarker();
        expect(record(planner, now)).toEqual({ model: planner, orchestrator: true });
        expect(rec().orchestrator).toBe(true);
        // later turns do not need the marker: it can be gone, the stored flag carries the conversation
        fs.rmSync(annotationFile());
        expect(record(executor, now + 5)).toEqual({ model: planner, orchestrator: true, turnModel: executor });
        for (const f of [`${CONV}.model.json`, 'latest.json']) {
          expect(rec(f)).toMatchObject({ model: planner, turn_model: executor, orchestrator: true, updated_at: now + 5 });
        }
        // the planner coming back clears the turn model
        expect(record(planner, now + 10)).toEqual({ model: planner, orchestrator: true });
        expect(rec().turn_model).toBeUndefined();
      });

      it(`marker absent: ${planner} then ${executor} are plain models, the executor replaces the first`, () => {
        expect(record(planner, now)).toEqual({ model: planner, orchestrator: false });
        expect(rec().orchestrator).toBeUndefined();
        expect(record(executor, now + 5)).toEqual({ model: executor, orchestrator: false });
        expect(rec()).toMatchObject({ model: executor });
        expect(rec().turn_model).toBeUndefined();
        expect(rec().orchestrator).toBeUndefined();
      });
    }
  }

  it('marker unreadable (a directory) or oversized: plain, as with no marker', () => {
    fs.mkdirSync(annotationFile(), { recursive: true });
    expect(record('gemini-4-neon-high', now)).toEqual({ model: 'gemini-4-neon-high', orchestrator: false });
    expect(record('gemini-4-hydrogen-high', now + 1)).toEqual({ model: 'gemini-4-hydrogen-high', orchestrator: false });
    fs.rmSync(annotationFile(), { recursive: true });
    writeMarker('plan_execute:true\n' + 'x'.repeat(ORCHESTRATOR_ANNOTATION_MAX_BYTES + 1));
    expect(record('gemini-4-neon-high', now + 2).orchestrator).toBe(false);
    expect(record('gemini-4-hydrogen-high', now + 3).orchestrator).toBe(false);
  });

  it('no artifactDirectoryPath, or readMarker false: the marker is not read', () => {
    writeMarker();
    expect(record('gemini-4-neon-high', now, { withDir: false }).orchestrator).toBe(false);
    expect(record('gemini-4-neon-high', now + 1, { readMarker: false }).orchestrator).toBe(false);
    expect(record('gemini-4-neon-high', now + 2).orchestrator).toBe(true);
  });

  it('an executor id with nothing stored is stored as it is, and the conversation is an Orchestrator one', () => {
    writeMarker();
    expect(record('gemini-4-hydrogen-medium', now)).toEqual({ model: 'gemini-4-hydrogen-medium', orchestrator: true });
    expect(rec()).toMatchObject({ model: 'gemini-4-hydrogen-medium', orchestrator: true });
    expect(rec().turn_model).toBeUndefined();
    // the planner arriving later becomes the session model
    expect(record('claude-opus-5-5-high', now + 1)).toEqual({ model: 'claude-opus-5-5-high', orchestrator: true });
  });

  it('a planner replaced by another planner: the later planner is the session model', () => {
    writeMarker();
    record('gemini-4-neon-high', now);
    expect(record('claude-opus-5-5-high', now + 1)).toEqual({ model: 'claude-opus-5-5-high', orchestrator: true });
    expect(record('gemini-4-hydrogen-high', now + 2)).toEqual({ model: 'claude-opus-5-5-high', orchestrator: true, turnModel: 'gemini-4-hydrogen-high' });
  });

  it('a /model switch to a model outside both families clears the Orchestrator and replaces the stored model', () => {
    writeMarker();
    record('gemini-4-neon-high', now);
    expect(record('gemini-4-hydrogen-high', now + 1).turnModel).toBe('gemini-4-hydrogen-high');
    for (const other of NEITHER) {
      expect(isPlannerFamilyModel(other) || isExecutorFamilyModel(other)).toBe(false);
    }
    expect(record('gemini-3.8-flash-low', now + 2)).toEqual({ model: 'gemini-3.8-flash-low', orchestrator: false });
    expect(rec()).toMatchObject({ model: 'gemini-3.8-flash-low', orchestrator: false });
    expect(rec().turn_model).toBeUndefined();
    // the switch is remembered: the marker, still on disk, does not bring the Orchestrator back
    expect(record('gemini-4-hydrogen-high', now + 3)).toEqual({ model: 'gemini-4-hydrogen-high', orchestrator: false });
    expect(record('gemini-4-neon-high', now + 4)).toEqual({ model: 'gemini-4-neon-high', orchestrator: false });
  });

  it('a stale record does not stick: the marker is read again', () => {
    writeMarker();
    record('gemini-4-neon-high', now - 7201);
    expect(record('gemini-4-hydrogen-high', now)).toEqual({ model: 'gemini-4-hydrogen-high', orchestrator: true });
  });

  it('another conversation is not affected by this one', () => {
    writeMarker();
    record('gemini-4-neon-high', now);
    const other = '00000000-0000-4000-8000-0000000000b2';
    expect(recordAntigravitySession(other, 'gemini-4-hydrogen-high', now, sessions, { artifactDirectoryPath: artifactDir(other) })).toEqual({
      model: 'gemini-4-hydrogen-high',
      orchestrator: false
    });
  });

  it('a model id outside both families never reads the marker and is a plain model', () => {
    writeMarker();
    for (const m of ['gemini-3.8-flash-low', 'gpt-oss-120b-medium', 'gemini-3.8-flash-high']) {
      expect(record(m, now)).toEqual({ model: m, orchestrator: false });
    }
  });

  it('legacy ids still work, with no marker and no artifact directory', () => {
    expect(record('gemini-pro-orchestrator-g1-pro', now, { withDir: false })).toEqual({ model: 'gemini-pro-orchestrator-g1-pro', orchestrator: true });
    expect(record('gemini-flash-worker-agy', now + 1, { withDir: false })).toEqual({
      model: 'gemini-pro-orchestrator-g1-pro',
      orchestrator: true,
      turnModel: 'gemini-flash-worker-agy'
    });
    expect(rec().orchestrator).toBeUndefined();
    expect(rec().turn_model).toBe('gemini-flash-worker-agy');
    // a legacy planner with a 1.5.14 executor and no marker: a plain switch, as before
    expect(record('Orchestrator (Argon)', now + 2, { withDir: false }).orchestrator).toBe(true);
    expect(record('gemini-4-hydrogen-medium', now + 3, { withDir: false })).toEqual({ model: 'gemini-4-hydrogen-medium', orchestrator: false });
  });

  it('the legacy wrapper returns the session model only', () => {
    writeMarker();
    expect(writeAntigravitySessionModel(CONV, 'gemini-4-neon-high', now, sessions, { artifactDirectoryPath: artifactDir() })).toBe('gemini-4-neon-high');
    expect(writeAntigravitySessionModel(CONV, 'gemini-4-hydrogen-high', now + 1, sessions, { artifactDirectoryPath: artifactDir() })).toBe('gemini-4-neon-high');
    expect(writeAntigravitySessionModel('', 'x', now, sessions)).toBeUndefined();
  });

  it('the read-only counterpart gives the sticky model without writing', () => {
    writeMarker();
    record('gemini-4-argon-high', now);
    const before = fs.readFileSync(path.join(sessions, `${CONV}.model.json`), 'utf8');
    expect(resolveAntigravityTurnModel(CONV, 'gemini-4-hydrogen-medium', now + 1, sessions)).toEqual({
      model: 'gemini-4-argon-high',
      turnModel: 'gemini-4-hydrogen-medium'
    });
    expect(resolveAntigravityTurnModel(CONV, 'gemini-4-argon-high', now + 1, sessions)).toEqual({ model: 'gemini-4-argon-high' });
    expect(resolveAntigravityTurnModel(CONV, 'gemini-3.8-flash-low', now + 1, sessions)).toEqual({ model: 'gemini-3.8-flash-low' });
    expect(resolveAntigravityTurnModel('other-conv', 'gemini-4-hydrogen-medium', now + 1, sessions)).toEqual({ model: 'gemini-4-hydrogen-medium' });
    expect(resolveAntigravityTurnModel(CONV, '', now, sessions)).toEqual({ model: null });
    expect(fs.readFileSync(path.join(sessions, `${CONV}.model.json`), 'utf8')).toBe(before);
  });

  it('plain conversation: the read-only counterpart never makes an executor sticky', () => {
    record('gemini-4-argon-high', now);
    expect(resolveAntigravityTurnModel(CONV, 'gemini-4-hydrogen-medium', now + 1, sessions)).toEqual({ model: 'gemini-4-hydrogen-medium' });
  });
});

describe('quota view: variant and pools follow the stored planner', () => {
  const now = Math.floor(Date.now() / 1000);
  let origQuota: string | undefined;
  const quota = (activeModel = 'Gemini 3.8 Flash (Medium)') => {
    const file = path.join(root, 'quota-state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema: 2,
        updated_at: now,
        active_model: activeModel,
        plan_tier: 'pro',
        buckets: {
          'gemini-5h': { remaining_fraction: 0.8 },
          'gemini-weekly': { remaining_fraction: 0.7 },
          'gemini-argon-wtu-weekly': { remaining_fraction: 0.01, reset_at: now + 3600 }
        }
      })
    );
    process.env.JEV_QUOTA_STATE_FILE = file;
  };
  beforeEach(() => {
    origQuota = process.env.JEV_QUOTA_STATE_FILE;
    quota();
  });
  afterEach(() => {
    if (origQuota === undefined) delete process.env.JEV_QUOTA_STATE_FILE;
    else process.env.JEV_QUOTA_STATE_FILE = origQuota;
  });

  it('Neon (planner, marker): Orchestrator pools, the argon variant (frontier = the Argon bucket); an executor turn keeps it', async () => {
    writeMarker();
    record('gemini-4-neon-high', now);
    record('gemini-4-hydrogen-medium', now + 1);
    const view = await readQuotaView({ conversationId: CONV, overrideSessionsDir: sessions });
    expect(view.active_model).toBe('gemini-4-neon-high');
    expect(view.orchestrator).toBe(true);
    expect(view.variant).toBe('argon');
    expect(view.pools?.execution.strategy).toBe('normal');
    expect(view.pools?.frontier.weekly).toBeCloseTo(0.01, 5);
    expect(view.pools?.frontier.strategy).not.toBe('normal');
  });

  it('Carbon (planner, marker): the carbon variant (frontier = the Gemini weekly bucket)', async () => {
    writeMarker();
    record('gemini-4-carbon-medium', now);
    const view = await readQuotaView({ conversationId: CONV, overrideSessionsDir: sessions });
    expect(view.orchestrator).toBe(true);
    expect(view.variant).toBe('carbon');
    expect(view.pools?.frontier.weekly).toBeCloseTo(0.7, 5);
  });

  it('Argon and Opus planners are Orchestrator pools with the marker', async () => {
    writeMarker();
    record('gemini-4-argon-low', now);
    expect((await readQuotaView({ conversationId: CONV, overrideSessionsDir: sessions })).variant).toBe('argon');
    record('claude-opus-5-5-high', now + 1);
    const view = await readQuotaView({ conversationId: CONV, overrideSessionsDir: sessions });
    expect(view.orchestrator).toBe(true);
    expect(view.pools).toBeDefined();
  });

  it('the same ids with no marker are plain: no Orchestrator pools; Neon still reads the Argon weekly bucket', async () => {
    record('gemini-4-neon-high', now);
    const view = await readQuotaView({ conversationId: CONV, overrideSessionsDir: sessions });
    expect(view.orchestrator).toBeUndefined();
    expect(view.pools).toBeUndefined();
    expect(view.variant).toBeUndefined();
    expect(view.gemini.weekly).toBeCloseTo(0.01, 5);
    record('gemini-4-hydrogen-medium', now + 1);
    const hydrogen = await readQuotaView({ conversationId: CONV, overrideSessionsDir: sessions });
    expect(hydrogen.pools).toBeUndefined();
  });

  it('latest.json speaks for the Orchestrator flag only for the conversation that wrote it', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000b2';
    writeMarker();
    record('gemini-4-neon-high', now);
    expect(rec('latest.json').conversationId).toBe(CONV);
    // the conversation's own record is gone (missing or expired): latest.json is the fallback
    fs.rmSync(path.join(sessions, `${CONV}.model.json`));
    const own = await readQuotaView({ conversationId: CONV, overrideSessionsDir: sessions });
    expect(own.activeModelSource).toBe('latest');
    expect(own.orchestrator).toBe(true);
    expect(own.pools).toBeDefined();
    // another conversation (no record of its own) must not inherit the flag; the model still comes from latest.json
    const other = await readQuotaView({ conversationId: OTHER, overrideSessionsDir: sessions });
    expect(other.activeModelSource).toBe('latest');
    expect(other.active_model).toBe('gemini-4-neon-high');
    expect(other.orchestrator).toBeUndefined();
    expect(other.pools).toBeUndefined();
    // no conversation id at all: unknown, not Orchestrator
    const none = await readQuotaView({ overrideSessionsDir: sessions });
    expect(none.orchestrator).toBeUndefined();
  });

  it('legacy planner ids keep their pools with no flag', async () => {
    record('gemini-pro-orchestrator-g1-pro', now, { withDir: false });
    const view = await readQuotaView({ conversationId: CONV, overrideSessionsDir: sessions });
    expect(view.orchestrator).toBe(true);
    expect(view.variant).toBe('argon');
  });
});

describe('PreToolUse hook (a process, a temp HOME)', () => {
  let home = '';
  let telemetry = '';
  const homeSessions = () => path.join(home, '.config', 'jev', 'antigravity-sessions');

  beforeEach(() => {
    home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json'), JSON.stringify({ active_model: 'Gemini 3.8 Flash (Medium)' }));
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ defaults: { mode: 'on' } }));
    telemetry = path.join(home, 'telemetry.jsonl');
  });

  function run(modelName: string, model?: string, stepIdx = 3, withArtifactDir = true) {
    return Bun.spawnSync(['bun', HOOK, 'pre-tool-use'], {
      stdin: new TextEncoder().encode(
        JSON.stringify({
          conversationId: CONV,
          ...(withArtifactDir ? { artifactDirectoryPath: artifactDir() } : {}),
          modelName,
          lastUserInput: 'tidy the synthetic notes',
          stepIdx,
          toolCall: { id: `call_${stepIdx}`, name: 'invoke_subagent', args: { TypeName: 'research', Prompt: 'read', ...(model ? { Model: model } : {}) } }
        })
      ),
      env: {
        ...process.env,
        HOME: home,
        JEV_CONFIG_FILE: path.join(home, '.config', 'jev', 'config.json'),
        JEV_TELEMETRY_FILE: telemetry,
        JEV_OPENROUTER_API_KEY: '',
        OPENROUTER_API_KEY: '',
        JEV_DOWNGRADE: 'off'
      }
    });
  }
  const out = (p: ReturnType<typeof run>) => {
    const t = p.stdout.toString().trim();
    return t ? JSON.parse(t) : {};
  };
  const stored = (name = `${CONV}.model.json`) => JSON.parse(fs.readFileSync(path.join(homeSessions(), name), 'utf8'));
  const rows = (): Array<Record<string, unknown>> =>
    fs.existsSync(telemetry)
      ? fs
          .readFileSync(telemetry, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  for (const [planner, executor] of [
    ['gemini-4-neon-high', 'gemini-4-hydrogen-medium'],
    ['claude-opus-5-5-high', 'claude-sonnet-5-5-high'],
    ['gemini-4-argon-medium', 'gemini-4-hydrogen-low']
  ]) {
    it(`marker: ${planner} then ${executor}: the Orchestrator rules apply to every turn`, () => {
      writeMarker();
      expect(out(run(planner, 'flash'))).toEqual({}); // an explicit flash passes
      expect(stored()).toMatchObject({ model: planner, orchestrator: true });

      const denied = out(run(executor, undefined, 4));
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('Under Orchestrator, set Model explicitly');
      expect(stored()).toMatchObject({ model: planner, turn_model: executor, orchestrator: true });
      expect(stored('latest.json').model).toBe(planner);

      expect(out(run(executor, 'inherit', 5)).decision).toBe('deny');
      const pro = out(run(executor, 'pro', 6));
      expect(pro.decision).toBe('deny');
      expect(pro.reason).toContain('[jev-elevate:pro]');
      expect(out(run(executor, 'flash', 7))).toEqual({});
      // the planner turn is under the same rules
      expect(out(run(planner, undefined, 8)).decision).toBe('deny');
      expect(stored().model).toBe(planner);
    });

    it(`no marker: ${planner} and ${executor} are plain models (nothing denied for an omitted Model)`, () => {
      expect(out(run(planner, undefined, 3))).toEqual({});
      expect(out(run(executor, undefined, 4))).toEqual({});
      expect(stored().orchestrator).toBeUndefined();
      expect(stored().model).toBe(executor);
    });
  }

  it('no marker: a Neon session is plain and may name pro; with the marker the same call is denied', () => {
    expect(out(run('gemini-4-neon-high', 'pro'))).toEqual({});
    fs.rmSync(path.join(homeSessions(), `${CONV}.model.json`));
    writeMarker();
    const r = out(run('gemini-4-neon-high', 'pro', 4));
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('[jev-elevate:pro]');
  });

  it('a call without artifactDirectoryPath cannot detect the marker: the legacy rules apply', () => {
    writeMarker();
    expect(out(run('gemini-4-hydrogen-medium', undefined, 3, false))).toEqual({});
    expect(stored().orchestrator).toBeUndefined();
  });

  it('legacy ids still work through the hook', () => {
    run('gemini-pro-orchestrator-g1-pro', 'flash', 3, false);
    const denied = out(run('gemini-flash-worker-agy', undefined, 4, false));
    expect(denied.decision).toBe('deny');
    expect(stored().model).toBe('gemini-pro-orchestrator-g1-pro');
    expect(stored().turn_model).toBe('gemini-flash-worker-agy');
  });

  it('telemetry rows carry the sticky planner as sessionModel and the executor id as turnModel (T26)', () => {
    writeMarker();
    run('gemini-4-neon-high', 'flash', 3);
    run('gemini-4-hydrogen-medium', 'flash', 4);
    const calls = rows().filter((r) => r.event === 'agent_call');
    expect(calls.length).toBe(2);
    const [planner, executor] = calls;
    expect(planner.sessionModel).toBe('gemini-4-neon-high');
    expect(planner.turnModel).toBeUndefined();
    expect(executor.sessionModel).toBe('gemini-4-neon-high');
    expect(executor.turnModel).toBe('gemini-4-hydrogen-medium');
    // the planner turn reported its own id; the executor turn's session model is the stored sticky planner
    expect(planner.sessionModelSource).toBe('hook');
    expect(executor.sessionModelSource).toBe('session-record');
    expect(executor.costRatio).not.toBeNull();
    // the decisions log agrees
    const log = fs
      .readFileSync(path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === 'agent_call');
    expect(log[1].session_model).toBe('gemini-4-neon-high');
    expect(log[1].turn_model).toBe('gemini-4-hydrogen-medium');
  });

  it('a /model switch out of the Orchestrator in the middle of the conversation: the rules stop applying', () => {
    writeMarker();
    expect(out(run('gemini-4-neon-high', 'flash', 3))).toEqual({});
    expect(out(run('gemini-4-hydrogen-medium', undefined, 4)).decision).toBe('deny');
    // the user switches to a model outside both families: a plain session, an omitted Model passes
    expect(out(run('gemini-3.8-flash-low', undefined, 5))).toEqual({});
    expect(stored()).toMatchObject({ model: 'gemini-3.8-flash-low', orchestrator: false });
  });
});

describe('PreInvocation pre-flight (in process, a temp HOME)', () => {
  let home = '';
  let origEnv: Record<string, string | undefined> = {};
  const KEYS = ['HOME', 'JEV_CONFIG_FILE', 'JEV_TELEMETRY_FILE', 'JEV_QUOTA_STATE_FILE'] as const;
  const homeSessions = () => path.join(home, '.config', 'jev', 'antigravity-sessions');

  beforeEach(() => {
    clearConfigCacheForTesting();
    home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    origEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.HOME = home;
    process.env.JEV_CONFIG_FILE = path.join(home, '.config', 'jev', 'config.json');
    process.env.JEV_TELEMETRY_FILE = path.join(home, 'telemetry.jsonl');
    process.env.JEV_QUOTA_STATE_FILE = path.join(home, '.gemini', 'antigravity-cli', 'quota-state.json');
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(
      process.env.JEV_QUOTA_STATE_FILE,
      JSON.stringify({
        schema: 2,
        updated_at: now,
        active_model: 'gemini-4-hydrogen-medium',
        plan_tier: 'pro',
        buckets: {
          'gemini-5h': { remaining_fraction: 0.8 },
          'gemini-weekly': { remaining_fraction: 0.8 },
          'gemini-argon-wtu-weekly': { remaining_fraction: 0.0, reset_at: now + 3600 }
        }
      })
    );
  });
  afterEach(() => {
    clearConfigCacheForTesting();
    for (const k of KEYS) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }
  });

  const setMode = (mode: string) => fs.writeFileSync(process.env.JEV_CONFIG_FILE!, JSON.stringify({ defaults: { mode } }));
  async function pre(modelName: string, task: string, extra: Record<string, unknown> = {}, deps: Parameters<typeof runPreflight>[1] = {}): Promise<any> {
    let stdout = '';
    const orig = console.log;
    console.log = (m: string) => {
      stdout += m;
    };
    try {
      await runPreflight(
        JSON.stringify({ conversationId: CONV, artifactDirectoryPath: artifactDir(), modelName, lastUserInput: task, invocationNum: 1, ...extra }),
        { autoHeal: () => {}, callJev: async () => null, ...deps }
      );
    } finally {
      console.log = orig;
    }
    return JSON.parse(stdout);
  }
  const stored = () => JSON.parse(fs.readFileSync(path.join(homeSessions(), `${CONV}.model.json`), 'utf8'));
  const telemetryRows = (): Array<Record<string, unknown>> => {
    const f = process.env.JEV_TELEMETRY_FILE!;
    return fs.existsSync(f)
      ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };

  it('mode on: the Orchestrator directive and the Argon-exhausted warning apply on the planner turn and on the executor turn', async () => {
    setMode('on');
    writeMarker();
    const planner = await pre('gemini-4-neon-high', 'please refactor the billing module');
    const pm = planner.injectSteps[0].ephemeralMessage as string;
    expect(pm).toContain('ORCHESTRATOR ENFORCEMENT');
    expect(pm).toContain('ARGON EXHAUSTED WARNING');

    const executor = await pre('gemini-4-hydrogen-medium', 'now implement the plan we agreed', { invocationNum: 2 });
    const em = executor.injectSteps[0].ephemeralMessage as string;
    expect(em).toContain('ORCHESTRATOR ENFORCEMENT');
    expect(em).toContain('ARGON EXHAUSTED WARNING');
    expect(stored()).toMatchObject({ model: 'gemini-4-neon-high', turn_model: 'gemini-4-hydrogen-medium', orchestrator: true });
  });

  it('mode on, no marker: the same ids are plain, so no Orchestrator directive and no Argon warning on a Hydrogen turn', async () => {
    setMode('on');
    const r = await pre('gemini-4-hydrogen-medium', 'please refactor the billing module');
    const msg = (r.injectSteps?.[0]?.ephemeralMessage ?? '') as string;
    expect(msg).not.toContain('ORCHESTRATOR ENFORCEMENT');
    expect(msg).not.toContain('ARGON EXHAUSTED WARNING');
    expect(stored().orchestrator).toBeUndefined();
  });

  it('legacy ids still get the Orchestrator directive in the pre-flight', async () => {
    setMode('on');
    const r = await pre('gemini-pro-orchestrator-g1-pro', 'please refactor the billing module', { artifactDirectoryPath: undefined });
    expect(r.injectSteps[0].ephemeralMessage).toContain('ORCHESTRATOR ENFORCEMENT');
  });

  it('on-demand: the prompt row carries the sticky planner as sessionModel and the executor id as turnModel', async () => {
    setMode('on-demand');
    writeMarker();
    await pre('gemini-4-argon-high', 'please refactor the billing module');
    await pre('gemini-4-hydrogen-medium', 'now implement the plan we agreed');
    const prompts = telemetryRows().filter((r) => r.toolOrHook === 'PreInvocation');
    expect(prompts.length).toBe(2);
    expect(prompts[0].sessionModel).toBe('gemini-4-argon-high');
    expect(prompts[0].turnModel).toBeUndefined();
    expect(prompts[1].sessionModel).toBe('gemini-4-argon-high');
    expect(prompts[1].turnModel).toBe('gemini-4-hydrogen-medium');
    expect(prompts[0].sessionModelSource).toBe('hook');
    expect(prompts[1].sessionModelSource).toBe('session-record');
  });

  it('under the deadline budget the marker is not read (the legacy rules apply) and the skip is logged', async () => {
    setMode('on-demand');
    writeMarker();
    await pre('gemini-4-neon-high', 'please refactor the billing module', {}, { deadlineMs: 20 });
    await Bun.sleep(300);
    expect(stored().orchestrator).toBeUndefined();
    const log = path.join(home, '.config', 'jev', 'antigravity_decisions.jsonl');
    expect(fs.readFileSync(log, 'utf8')).toContain('orchestrator-marker');
  });
});
