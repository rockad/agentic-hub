/**
 * The MCP server contract for Jev's tools: an unknown, mistyped or missing argument is a tool error
 * (`isError: true`, "Invalid arguments for tool <name>: ..."), never silently ignored or defaulted.
 *
 * Rejections are driven through the real server over an in-memory transport for every tool. Each is refused by
 * validation before a handler runs, so none touches the network. Acceptance of valid input is checked through
 * `validateToolInput` (a handler would call the network); the end-to-end accepted calls are the tools that run
 * offline (jev_get_mode, jev_quota, and jev_batch_dispatch with the keyword router and no key).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createJevServer } from '../src/server.ts';
import { allTools, toolHandlers } from '../src/tools/index.ts';
import { toolInputSchemas } from '../src/tools/index.ts';
import { validateToolInput } from '../src/tools/validate.ts';
import { inputJsonSchema } from '../src/tools/schema.ts';

let tmp = '';
let savedEnv: NodeJS.ProcessEnv = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const v of ['JEV_HARNESS', 'ANTIGRAVITY_CLI', 'GEMINI_CLI', 'CLAUDE_CODE', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'OPENCODE_SESSION', 'OPENCODE_HOME', 'CORTEX_SESSION']) {
    delete process.env[v];
  }
  // No key, and a fetch that refuses: even a validation bug could not make a real request.
  delete process.env.JEV_OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-contract-test-'));
  process.env.JEV_HARNESS = 'cli';
  process.env.JEV_CONFIG_FILE = path.join(tmp, 'config.json');
  process.env.JEV_CACHE_FILE = path.join(tmp, 'cache.sqlite');
  fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ routing: { strategy: 'keyword' } }));
});

afterEach(() => {
  process.env = savedEnv;
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createJevServer().connect(serverSide);
  const client = new Client({ name: 'contract', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

type Call = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function call(client: Client, name: string, args?: Record<string, unknown>): Promise<Call> {
  return (await client.callTool({ name, arguments: args })) as Call;
}

function textOf(r: Call): string {
  expect(r.content).toHaveLength(1);
  expect(r.content[0].type).toBe('text');
  return r.content[0].text ?? '';
}

/** Rejected by validation: isError, one text block, the exact text. */
async function expectRejected(client: Client, name: string, args: Record<string, unknown> | undefined, issues: string[]): Promise<void> {
  const r = await call(client, name, args);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toBe(`Invalid arguments for tool ${name}: ${issues.join('\n')}`);
}

/** Per tool: the smallest valid input, a full one, and one bad input for each kind of mistake. */
const CASES: Record<
  string,
  {
    minimal: Record<string, unknown>;
    full: Record<string, unknown>;
    wrongType?: { args: Record<string, unknown>; issue: string };
    badEnum?: { args: Record<string, unknown>; issue: string };
    nestedTypo?: { args: Record<string, unknown>; issue: string };
  }
> = {
  jev_route: {
    minimal: { context: 'a note', options: ['x', 'y'] },
    full: { context: 'a note', options: ['x', 'y'], criteria: { x: 'the first' }, instruction: 'pick one' },
    wrongType: { args: { context: 'a note', options: 'x' }, issue: 'Expected array, received string at options' }
  },
  jev_judge: {
    minimal: { context: 'output', condition: 'is it done?' },
    full: { context: 'output', condition: 'is it done?' },
    wrongType: { args: { context: 'output', condition: 7 }, issue: 'Expected string, received number at condition' }
  },
  jev_score: {
    minimal: { context: 'text' },
    full: { context: 'text', rubric: 'clarity', criteria: ['bad', 'good'] },
    wrongType: { args: { context: 'text', criteria: 'bad' }, issue: 'Expected array, received string at criteria' }
  },
  jev_dispatch: {
    minimal: { task: 'Fix the bug' },
    full: { task: 'Fix the bug', availableSubagents: ['self', 'code-engineer'] },
    wrongType: { args: { task: 'Fix the bug', availableSubagents: 'self' }, issue: 'Expected array, received string at availableSubagents' }
  },
  jev_batch_dispatch: {
    minimal: { tasks: [{ id: 'a', task: 'Write the docs' }] },
    full: {
      tasks: [
        { id: 'a', task: 'Write the docs', kind: 'mechanical', needsEdit: true },
        { id: 'b', task: 'Review the docs', dependencies: ['a'], kind: 'judgement', needsEdit: false }
      ],
      availableSubagents: ['self']
    },
    wrongType: { args: { tasks: [{ id: 'a', task: 'x', needsEdit: 'yes' }] }, issue: 'Expected boolean, received string at tasks[0].needsEdit' },
    badEnum: {
      args: { tasks: [{ id: 'a', task: 'x', kind: 'hard' }] },
      issue: "Invalid enum value. Expected 'mechanical' | 'settled-edit' | 'judgement', received 'hard' at tasks[0].kind"
    },
    nestedTypo: {
      args: { tasks: [{ id: 'a', task: 'x', needsEdits: true }] },
      issue: "Unrecognized key(s) in object: 'needsEdits' at tasks[0]\nUnrecognized key 'needsEdits' at tasks[0]; did you mean 'needsEdit'?"
    }
  },
  jev_agent_free: {
    minimal: { prompt: 'refactor' },
    full: { prompt: 'refactor', cwd: '/tmp', model: 'openrouter/free', timeoutMs: 5000 },
    wrongType: { args: { prompt: 'refactor', timeoutMs: '5000' }, issue: 'Expected number, received string at timeoutMs' }
  },
  jev_execute_free: {
    minimal: { prompt: 'summarise' },
    full: { prompt: 'summarise', systemInstruction: 'be brief', model: 'openrouter/free' },
    wrongType: { args: { prompt: ['summarise'] }, issue: 'Expected string, received array at prompt' }
  },
  jev_execute_free_guarded: {
    minimal: { prompt: 'summarise' },
    full: { prompt: 'summarise', systemInstruction: 'be brief', condition: 'complete?', model: 'openrouter/free' },
    wrongType: { args: { prompt: 'summarise', condition: false }, issue: 'Expected string, received boolean at condition' }
  },
  jev_set_mode: {
    minimal: { mode: 'on' },
    full: { mode: 'on-demand' },
    wrongType: { args: { mode: 1 }, issue: "Expected 'off' | 'on-demand' | 'on', received number at mode" },
    badEnum: { args: { mode: 'maybe' }, issue: "Invalid enum value. Expected 'off' | 'on-demand' | 'on', received 'maybe' at mode" }
  },
  jev_get_mode: {
    minimal: {},
    full: {}
  },
  jev_quota: {
    minimal: {},
    full: { refresh: true },
    wrongType: { args: { refresh: 'yes' }, issue: 'Expected boolean, received string at refresh' }
  },
  jev_select_model: {
    minimal: { task: 'size this up' },
    full: {
      task: 'size this up',
      candidates: [
        { id: 'a', tier: 'cheap', providerModel: 'p/a', costInPerMTok: 1, costOutPerMTok: 2, label: 'A' },
        { id: 'b', providerModel: 'p/b', costInPerMTok: 0, costOutPerMTok: 0 }
      ],
      quotaStrategy: 'conserve'
    },
    wrongType: { args: { task: 'x', candidates: [{ id: 'a', providerModel: 'p', costInPerMTok: '1', costOutPerMTok: 2 }] }, issue: 'Expected number, received string at candidates[0].costInPerMTok' },
    badEnum: {
      args: { task: 'x', quotaStrategy: 'frugal' },
      issue: "Invalid enum value. Expected 'normal' | 'conserve' | 'free_only' | 'unknown', received 'frugal' at quotaStrategy"
    },
    nestedTypo: {
      args: { task: 'x', candidates: [{ id: 'a', providerModel: 'p', costInPerMTok: 1, costOutPerMTok: 2, price: 3 }] },
      issue: "Unrecognized key(s) in object: 'price' at candidates[0]"
    }
  }
};

/** Required fields (a missing one is rejected), as advertised. */
const REQUIRED: Record<string, string[]> = {
  jev_route: ['context', 'options'],
  jev_judge: ['context', 'condition'],
  jev_score: ['context'],
  jev_dispatch: ['task'],
  jev_batch_dispatch: ['tasks'],
  jev_agent_free: ['prompt'],
  jev_execute_free: ['prompt'],
  jev_execute_free_guarded: ['prompt'],
  jev_set_mode: ['mode'],
  jev_get_mode: [],
  jev_quota: [],
  jev_select_model: ['task']
};

describe('every tool has a strict schema', () => {
  it('lists the twelve tools', () => {
    expect(allTools.map((t) => t.name).sort()).toEqual(Object.keys(CASES).sort());
  });

  it('has a handler and a schema for every listed tool, and nothing else', () => {
    const listed = allTools.map((t) => t.name).sort();
    expect(Object.keys(toolHandlers).sort()).toEqual(listed);
    expect(Object.keys(toolInputSchemas).sort()).toEqual(listed);
  });

  it('serves exactly the tools the server registers, each with a schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(12);
    for (const tool of tools) {
      expect(toolInputSchemas[tool.name]).toBeDefined();
      expect(toolHandlers[tool.name]).toBeDefined();
      expect(tool.inputSchema).toEqual(inputJsonSchema(toolInputSchemas[tool.name]));
    }
  });

  it('uses strict objects, so an advertised object never allows extra keys, at any depth', () => {
    const walk = (node: any, where: string): void => {
      if (node?.type === 'object' && node.properties) {
        expect([where, node.additionalProperties]).toEqual([where, false]);
        for (const [k, v] of Object.entries(node.properties)) walk(v, `${where}.${k}`);
      }
      if (node?.type === 'array') walk(node.items, `${where}[]`);
    };
    for (const t of allTools) {
      walk(t.inputSchema, t.name);
      expect((t.inputSchema as any).$schema).toBeUndefined();
    }
  });
});

describe('the advertised JSON schemas keep the documented shape', () => {
  const byName = (n: string): any => allTools.find((t) => t.name === n)!.inputSchema;
  const props = (n: string): string[] => Object.keys(byName(n).properties ?? {});

  it('keeps property names and required lists for every tool', () => {
    const expected: Record<string, { props: string[]; required: string[] }> = {
      jev_route: { props: ['context', 'options', 'criteria', 'instruction'], required: ['context', 'options'] },
      jev_judge: { props: ['context', 'condition'], required: ['context', 'condition'] },
      jev_score: { props: ['context', 'rubric', 'criteria'], required: ['context'] },
      jev_dispatch: { props: ['task', 'availableSubagents'], required: ['task'] },
      jev_batch_dispatch: { props: ['tasks', 'availableSubagents'], required: ['tasks'] },
      jev_agent_free: { props: ['prompt', 'cwd', 'model', 'timeoutMs'], required: ['prompt'] },
      jev_execute_free: { props: ['prompt', 'systemInstruction', 'model'], required: ['prompt'] },
      jev_execute_free_guarded: { props: ['prompt', 'systemInstruction', 'condition', 'model'], required: ['prompt'] },
      jev_set_mode: { props: ['mode'], required: ['mode'] },
      jev_get_mode: { props: [], required: [] },
      jev_quota: { props: ['refresh'], required: [] },
      jev_select_model: { props: ['task', 'candidates', 'quotaStrategy'], required: ['task'] }
    };
    for (const [name, e] of Object.entries(expected)) {
      expect([name, props(name)]).toEqual([name, e.props]);
      expect([name, byName(name).required ?? []]).toEqual([name, e.required]);
    }
  });

  it('keeps the batch task fields and the enums', () => {
    const item = byName('jev_batch_dispatch').properties.tasks.items;
    expect(Object.keys(item.properties)).toEqual(['id', 'task', 'dependencies', 'kind', 'needsEdit']);
    expect(item.required).toEqual(['id', 'task']);
    expect(item.properties.kind.enum).toEqual(['mechanical', 'settled-edit', 'judgement']);
    expect(item.properties.needsEdit.type).toBe('boolean');
    expect(item.properties.dependencies).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(byName('jev_set_mode').properties.mode.enum).toEqual(['off', 'on-demand', 'on']);
    const sel = byName('jev_select_model').properties;
    expect(sel.quotaStrategy.enum).toEqual(['normal', 'conserve', 'free_only', 'unknown']);
    expect(Object.keys(sel.candidates.items.properties)).toEqual(['id', 'tier', 'providerModel', 'costInPerMTok', 'costOutPerMTok', 'label']);
    expect(sel.candidates.items.required).toEqual(['id', 'providerModel', 'costInPerMTok', 'costOutPerMTok']);
    expect(sel.candidates.items.properties.tier.enum).toEqual(['free', 'cheap', 'standard', 'expensive']);
  });

  it('keeps descriptions on the top-level properties', () => {
    for (const t of allTools) {
      for (const [k, v] of Object.entries<any>((t.inputSchema as any).properties ?? {})) {
        expect([t.name, k, typeof v.description]).toEqual([t.name, k, 'string']);
      }
    }
  });
});

describe('valid input passes validation', () => {
  it.each(Object.keys(CASES))('%s accepts its minimal and its full input', (name) => {
    for (const args of [CASES[name].minimal, CASES[name].full]) {
      const v = validateToolInput(name, args);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.data).toEqual(args);
    }
  });

  it('treats absent arguments as {} for the argument-less tools', () => {
    for (const name of ['jev_get_mode', 'jev_quota']) {
      const v = validateToolInput(name, undefined);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.data).toEqual({});
    }
  });
});

describe('invalid input is an isError result, through the real server', () => {
  it.each(Object.keys(CASES))('%s rejects an unknown key', async (name) => {
    const client = await connect();
    await expectRejected(client, name, { ...CASES[name].minimal, bogus: 1 }, ["Unrecognized key(s) in object: 'bogus'"]);
  });

  it.each(Object.keys(CASES).filter((n) => REQUIRED[n].length > 0))('%s rejects each missing required field', async (name) => {
    const client = await connect();
    for (const field of REQUIRED[name]) {
      const { [field]: _gone, ...rest } = CASES[name].minimal;
      await expectRejected(client, name, rest, [`Required at ${field}`]);
    }
  });

  it.each(Object.keys(CASES).filter((n) => REQUIRED[n].length > 0))('%s rejects an empty object', async (name) => {
    const client = await connect();
    await expectRejected(client, name, {}, REQUIRED[name].map((f) => `Required at ${f}`));
  });

  it.each(Object.keys(CASES).filter((n) => CASES[n].wrongType))('%s rejects a wrong type', async (name) => {
    const client = await connect();
    await expectRejected(client, name, CASES[name].wrongType!.args, [CASES[name].wrongType!.issue]);
  });

  it.each(Object.keys(CASES).filter((n) => CASES[n].badEnum))('%s rejects a bad enum value', async (name) => {
    const client = await connect();
    await expectRejected(client, name, CASES[name].badEnum!.args, [CASES[name].badEnum!.issue]);
  });

  it.each(Object.keys(CASES).filter((n) => CASES[n].nestedTypo))('%s rejects a typo in a nested object', async (name) => {
    const client = await connect();
    await expectRejected(client, name, CASES[name].nestedTypo!.args, [CASES[name].nestedTypo!.issue]);
  });

  it('rejects a non-object argument', async () => {
    expect(validateToolInput('jev_get_mode', 'on')).toEqual({
      ok: false,
      result: { isError: true, content: [{ type: 'text', text: 'Invalid arguments for tool jev_get_mode: Expected object, received string' }] }
    });
  });

  it('leaves an unknown tool name to the handler lookup, as before', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'jev_nope', arguments: {} })).rejects.toThrow('Unknown tool: jev_nope');
  });
});

describe('argument-less tools', () => {
  it('jev_get_mode and jev_quota accept {} and no arguments at all, end to end', async () => {
    const client = await connect();
    for (const name of ['jev_get_mode', 'jev_quota']) {
      for (const args of [{}, undefined]) {
        const r = await call(client, name, args);
        expect([name, r.isError]).toEqual([name, undefined]);
        expect(() => JSON.parse(textOf(r))).not.toThrow();
      }
    }
  });

  it('jev_get_mode and jev_quota reject any key', async () => {
    const client = await connect();
    await expectRejected(client, 'jev_get_mode', { verbose: true }, ["Unrecognized key(s) in object: 'verbose'"]);
    await expectRejected(client, 'jev_quota', { refesh: true }, ["Unrecognized key(s) in object: 'refesh'", "Unrecognized key 'refesh'; did you mean 'refresh'?"]);
  });
});

describe('"did you mean" hints for unknown keys', () => {
  it('suggests the schema key within edit distance 2', () => {
    const r = validateToolInput('jev_set_mode', { mod: 'on' });
    expect(r).toEqual({
      ok: false,
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: "Invalid arguments for tool jev_set_mode: Required at mode\nUnrecognized key(s) in object: 'mod'\nUnrecognized key 'mod'; did you mean 'mode'?"
          }
        ]
      }
    });
  });

  it('suggests at the nested level, with the path', () => {
    const r = validateToolInput('jev_batch_dispatch', { tasks: [{ id: 'a', task: 'x' }, { id: 'b', task: 'y', dependancies: ['a'] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.content[0].text).toBe(
        "Invalid arguments for tool jev_batch_dispatch: Unrecognized key(s) in object: 'dependancies' at tasks[1]\n" +
          "Unrecognized key 'dependancies' at tasks[1]; did you mean 'dependencies'?"
      );
    }
  });

  it('knows the two real mistakes: description -> task, dependsOn -> dependencies', () => {
    const r = validateToolInput('jev_batch_dispatch', { tasks: [{ id: 'a', task: 'x', description: 'y', dependsOn: ['b'] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.result.content[0].text).toBe(
        "Invalid arguments for tool jev_batch_dispatch: Unrecognized key(s) in object: 'description', 'dependsOn' at tasks[0]\n" +
          "Unrecognized key 'dependsOn' at tasks[0]; did you mean 'dependencies'?"
      );
    }
  });

  it('gives no hint for a far key, and none that points at a key the caller already sent', () => {
    const far = validateToolInput('jev_judge', { context: 'c', condition: 'x', zzzzzz: 1 });
    expect(far.ok === false && far.result.content[0].text).toBe("Invalid arguments for tool jev_judge: Unrecognized key(s) in object: 'zzzzzz'");
    const present = validateToolInput('jev_batch_dispatch', { tasks: [{ id: 'a', task: 'x', description: 'y' }] });
    expect(present.ok === false && present.result.content[0].text).toBe(
      "Invalid arguments for tool jev_batch_dispatch: Unrecognized key(s) in object: 'description' at tasks[0]"
    );
  });

  it('does not suggest an unrelated short key', () => {
    const r = validateToolInput('jev_batch_dispatch', { tasks: [{ id: 'a', task: 'x', x: 1 }] });
    expect(r.ok === false && r.result.content[0].text).toBe("Invalid arguments for tool jev_batch_dispatch: Unrecognized key(s) in object: 'x' at tasks[0]");
  });
});

describe('the incident: jev_batch_dispatch with description and dependsOn', () => {
  it('is rejected, with a hint for both mistakes', async () => {
    const client = await connect();
    const r = await call(client, 'jev_batch_dispatch', {
      tasks: [
        { id: 'docs', description: 'Write the docs' },
        { id: 'review', description: 'Review the docs', dependsOn: ['docs'] }
      ]
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      [
        'Invalid arguments for tool jev_batch_dispatch: Required at tasks[0].task',
        "Unrecognized key(s) in object: 'description' at tasks[0]",
        "Unrecognized key 'description' at tasks[0]; did you mean 'task'?",
        'Required at tasks[1].task',
        "Unrecognized key(s) in object: 'description', 'dependsOn' at tasks[1]",
        "Unrecognized key 'description' at tasks[1]; did you mean 'task'?",
        "Unrecognized key 'dependsOn' at tasks[1]; did you mean 'dependencies'?"
      ].join('\n')
    );
  });
});

describe('jev_batch_dispatch semantic checks', () => {
  const rejected = (tasks: unknown[]): string | undefined => {
    const v = validateToolInput('jev_batch_dispatch', { tasks });
    return v.ok ? undefined : v.result.content[0].text;
  };
  const P = 'Invalid arguments for tool jev_batch_dispatch: ';

  it('keeps the empty "tasks" array error', async () => {
    const client = await connect();
    await expectRejected(client, 'jev_batch_dispatch', { tasks: [] }, ['jev_batch_dispatch requires a non-empty "tasks" array']);
  });

  it('rejects an empty or blank task', () => {
    expect(rejected([{ id: 'a', task: '' }])).toBe(`${P}Must be a non-empty string at tasks[0].task`);
    expect(rejected([{ id: 'a', task: 'x' }, { id: 'b', task: '   \n' }])).toBe(`${P}Must be a non-empty string at tasks[1].task`);
  });

  it('rejects an empty or blank id', () => {
    expect(rejected([{ id: '', task: 'x' }])).toBe(`${P}Must be a non-empty string at tasks[0].id`);
    expect(rejected([{ id: 'a', task: 'x' }, { id: ' ', task: 'y' }])).toBe(`${P}Must be a non-empty string at tasks[1].id`);
  });

  it('names duplicate ids and where they are', () => {
    expect(rejected([{ id: 'a', task: 'x' }, { id: 'b', task: 'y' }, { id: 'a', task: 'z' }])).toBe(`${P}Duplicate task id 'a' at tasks[0], tasks[2]`);
    expect(rejected([{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }, { id: 'b', task: 'z' }, { id: 'b', task: 'w' }])).toBe(
      `${P}Duplicate task id 'a' at tasks[0], tasks[1]\nDuplicate task id 'b' at tasks[2], tasks[3]`
    );
  });

  it('names a dependency on a missing id', () => {
    expect(rejected([{ id: 'a', task: 'x' }, { id: 'b', task: 'y', dependencies: ['a', 'zzz'] }])).toBe(
      `${P}Unknown dependency 'zzz' at tasks[1].dependencies[1]: no task has that id`
    );
  });

  it('rejects a self-dependency', () => {
    expect(rejected([{ id: 'a', task: 'x', dependencies: ['a'] }])).toBe(`${P}Task 'a' depends on itself at tasks[0].dependencies[0]`);
  });

  it('names the cycle path', () => {
    expect(
      rejected([
        { id: 'a', task: 'x', dependencies: ['b'] },
        { id: 'b', task: 'y', dependencies: ['a'] }
      ])
    ).toBe(`${P}Dependency cycle: a -> b -> a`);
    expect(
      rejected([
        { id: 'root', task: 'r' },
        { id: 'a', task: 'x', dependencies: ['root', 'c'] },
        { id: 'b', task: 'y', dependencies: ['a'] },
        { id: 'c', task: 'z', dependencies: ['b'] }
      ])
    ).toBe(`${P}Dependency cycle: a -> c -> b -> a`);
  });

  it('reports every problem at once, in a fixed order', () => {
    expect(
      rejected([
        { id: 'a', task: '', dependencies: ['a', 'nope'] },
        { id: 'a', task: 'y' }
      ])
    ).toBe(
      [
        `${P}Must be a non-empty string at tasks[0].task`,
        "Duplicate task id 'a' at tasks[0], tasks[1]",
        "Task 'a' depends on itself at tasks[0].dependencies[0]",
        "Unknown dependency 'nope' at tasks[0].dependencies[1]: no task has that id"
      ].join('\n')
    );
  });

  it('accepts a valid DAG, a diamond, and an independent set', () => {
    const diamond = [
      { id: 'root', task: 'r' },
      { id: 'l', task: 'x', dependencies: ['root'] },
      { id: 'r', task: 'y', dependencies: ['root'] },
      { id: 'join', task: 'z', dependencies: ['l', 'r'] }
    ];
    expect(validateToolInput('jev_batch_dispatch', { tasks: diamond }).ok).toBe(true);
    expect(validateToolInput('jev_batch_dispatch', { tasks: [{ id: 'a', task: 'x', dependencies: [] }, { id: 'b', task: 'y' }] }).ok).toBe(true);
  });

  it('runs a valid batch end to end (keyword router, no network)', async () => {
    const client = await connect();
    const r = await call(client, 'jev_batch_dispatch', {
      tasks: [
        { id: 'a', task: 'Scaffold the package' },
        { id: 'b', task: 'Review the package', dependencies: ['a'] }
      ]
    });
    expect(r.isError).toBeUndefined();
    const plan = JSON.parse(textOf(r));
    expect(plan.tasks.map((t: any) => [t.taskId, t.dependencies])).toEqual([['a', []], ['b', ['a']]]);
  });
});

describe('jev_dispatch empty task', () => {
  it('is an isError result in the same form, keeping the old wording', async () => {
    const client = await connect();
    await expectRejected(client, 'jev_dispatch', { task: '' }, ['jev_dispatch requires a non-empty "task" string']);
  });
});
