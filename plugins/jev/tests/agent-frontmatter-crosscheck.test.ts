/**
 * The agent definition reader is cross-checked against Claude Code's own frontmatter pipeline (its block regex,
 * Bun.YAML.parse, then its quoting fallback): wherever the plugin's strict reader and that pipeline disagree on
 * `name`, `model` or `effort`, the field is unreadable and the guard asks, instead of reading "no model" where Claude
 * Code reads `opus`. The inputs are cognitive-engine's (packages/jev/tests: agent-frontmatter-differential,
 * agent-frontmatter, agent-name-matching, agent-lookup-consistency, agent-definition-root), adapted to this plugin's
 * API. Cases where the reference's own stricter reader goes further than Claude Code are listed in
 * "reference cases the plugin reads as Claude Code does" and assert the agreed answer instead.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { onPreToolUse, type HookDeps } from '../claude/hook.ts';
import { agentLookupDirs, parseFrontmatter, readAgentDefinition, readClaudeCodeName } from '../claude/agent-definitions.ts';
import { out, rig, wf, type Rig } from './workflow-helpers.ts';

let r: Rig;
afterEach(() => r?.cleanup());
const setup = (overrides: Partial<HookDeps> = {}) => {
  r = rig(overrides);
  fs.mkdirSync(path.join(r.project, '.git'), { recursive: true });
  return r;
};

const fm = (body: string, eol = '\n') => ['---', ...body.split('\n'), '---', 'body', ''].join(eol);
const BOM = '\uFEFF';
const projectAgents = () => path.join(r.project, '.claude', 'agents');
const userAgents = () => path.join(r.tmp, '.claude', 'agents');
const put = (dir: string, rel: string, text: string): string => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const model = (text: string) => parseFrontmatter(text).model;
const VALUE = (value: string) => ({ kind: 'value', value });
const NONE = { kind: 'none' };
const UNREADABLE = expect.objectContaining({ kind: 'unreadable' });

const agentVerdict = async (subagent: string, cwd = r.project) =>
  out(await onPreToolUse({ session_id: 's1', prompt_id: 'p1', tool_name: 'Agent', cwd, tool_input: { description: 'd', subagent_type: subagent } as any }, r.d)).permissionDecision as string | undefined;
const workflowVerdict = async (agentType: string) =>
  out(await onPreToolUse(wf({ script: `await agent('p', {agentType: '${agentType}'})` }, r), r.d)).permissionDecision as string | undefined;

describe('the three shapes Claude Code reads as opus and the strict reader read as nothing', () => {
  const shapes: Array<[string, string]> = [
    ['a top-level flow mapping', '---\n{name: x, model: opus}\n---\nbody\n'],
    ['a block indented as a whole by two spaces', '---\n  name: x\n  model: opus\n---\nbody\n'],
    ['a tab-indented model line', '---\nname: x\n\tmodel: opus\n---\nbody\n']
  ];
  for (const [name, text] of shapes) {
    it(`${name}: model is unreadable, not none`, () => {
      expect(model(text)).toEqual(UNREADABLE);
    });
    it(`${name}: readAgentDefinition reports it unreadable`, () => {
      setup();
      put(projectAgents(), 'x.md', text);
      const def = readAgentDefinition('x', r.project);
      expect(def.found).toBe(true);
      expect(def.unreadable).toBeDefined();
    });
    it(`${name}: Workflow agent(p, {agentType}) asks (no model was set in the script)`, async () => {
      setup();
      put(projectAgents(), 'x.md', text);
      expect(await workflowVerdict('x')).toBe('ask');
    });
    it(`${name}: the Agent tool asks, never denies`, async () => {
      setup();
      put(projectAgents(), 'x.md', text);
      expect(await agentVerdict('x')).toBe('ask');
    });
  }

  it('a flow mapping with no model in it reads model none (both agree); the name it hides is unreadable, so the lookup still asks', async () => {
    setup();
    put(projectAgents(), 'x.md', '---\n{name: x}\n---\nbody\n');
    expect(parseFrontmatter('---\n{name: x}\n---\n')).toEqual({ name: UNREADABLE, model: NONE, effort: NONE });
    expect(await agentVerdict('x')).toBe('ask');
  });

  it('a tab-only indented model (no sibling key) is unreadable too', () => {
    expect(model('---\n\tmodel: opus\n---\nbody\n')).toEqual(UNREADABLE);
  });
});

describe('a hidden second claimant makes the lookup ambiguous', () => {
  const claimants: Array<[string, string]> = [
    ['a flow-mapping name', '---\n{name: helper, model: opus}\n---\nbody\n'],
    ['an indented block', '---\n  name: helper\n  model: opus\n---\nbody\n'],
    ['an escape-encoded name', '---\nname: "\\x68elper"\nmodel: opus\n---\nbody\n'],
    ['an escape-encoded name by unicode', '---\nname: "hel\\u0070er"\nmodel: opus\n---\nbody\n']
  ];
  for (const [name, text] of claimants) {
    it(`helper.md (haiku) and another file claiming "helper" through ${name}: unreadable, not helper.md's haiku`, async () => {
      setup();
      put(projectAgents(), 'helper.md', fm('name: helper\nmodel: haiku'));
      put(projectAgents(), 'zz.md', text);

      const def = readAgentDefinition('helper', r.project);

      expect(def.found).toBe(true);
      expect(def.unreadable).toBeDefined();
      expect(await workflowVerdict('helper')).toBe('ask');
      expect(await agentVerdict('helper')).toBe('ask');
    });
  }

  it('a file whose name only Claude Code can read, naming another agent, is not a claimant', () => {
    setup();
    put(projectAgents(), 'helper.md', fm('name: helper\nmodel: haiku'));
    put(projectAgents(), 'zz.md', '---\nname: "\\x6fther"\nmodel: opus\n---\n');

    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'haiku' });
  });

  it('a file Claude Code rejects outright could be anything: ambiguous', () => {
    setup();
    put(projectAgents(), 'helper.md', fm('name: helper\nmodel: haiku'));
    put(projectAgents(), 'zz.md', '---\nname: "\\xZZ"\nmodel: opus\n---\n');

    expect(readAgentDefinition('helper', r.project).unreadable).toBeDefined();
  });

  it('readClaudeCodeName gives the name the pipeline reads, and unreadable without a parser', () => {
    expect(readClaudeCodeName('---\n{name: helper}\n---\n')).toEqual(VALUE('helper'));
    expect(readClaudeCodeName('---\nmodel: haiku\n---\n')).toEqual(NONE);
    expect(readClaudeCodeName('---\nname: 5\n---\n').kind).toBe('unreadable');
    expect(readClaudeCodeName('---\nname: helper\n---\n', null).kind).toBe('unreadable');
  });
});

describe('frontmatter shapes that name a model (reference agent-frontmatter.test.ts, "ask" list)', () => {
  const read: Array<[string, string]> = [
    ['plain key', fm('model: opus')],
    ['space before the colon', fm('model : opus')],
    ['quoted value', fm('model: "opus"')],
    ['single-quoted value', fm("model: 'opus'")],
    ['trailing comment', fm('model: opus # the big one')],
    ['UTF-8 BOM before the block', `${BOM}${fm('model: opus')}`],
    ['CRLF line endings', fm('name: q\nmodel: opus', '\r\n')],
    ['opening delimiter with trailing spaces', '---  \nmodel: opus\n---\nbody\n'],
    ['model after a multi-line block scalar that mentions another model', fm('description: |\n  model: haiku\n  more\nmodel: opus')],
    ['model after a description containing a colon', fm('description: Use this: when needed\nmodel: opus')]
  ];
  for (const [name, text] of read) {
    it(`reads opus: ${name}`, () => expect(model(text)).toEqual(VALUE('opus')));
  }
});

describe('frontmatter whose model cannot be established is unreadable (reference list)', () => {
  const unreadable: Array<[string, string]> = [
    ['double-quoted key', fm('"model": opus')],
    ['single-quoted key', fm("'model': opus")],
    ['BOM and quoted key', `${BOM}${fm('"model": opus')}`],
    ['flow-style mapping', fm('{model: opus}')],
    ['flow-style mapping with quoted keys', fm('{"model": "opus"}')],
    ['sequence value', fm('model:\n  - opus')],
    ['flow sequence value', fm('model: [opus]')],
    ['mapping value', fm('model:\n  name: opus')],
    ['flow mapping value', fm('model: {name: opus}')],
    ['block scalar value', fm('model: |\n  opus')],
    ['folded scalar value', fm('model: >\n  opus')],
    ['anchor on the value', fm('model: &m opus')],
    ['alias as the value', fm('x: &m opus\nmodel: *m')],
    ['tag on the value', fm('model: !!str opus')],
    ['merge key', fm('base: &b {model: opus}\n<<: *b')],
    ['duplicate model key', fm('model: haiku\nmodel: opus')],
    ['duplicate via a quoted key', fm('model: haiku\n"model": opus')],
    ['upper-case key', fm('Model: opus')],
    ['all-caps key', fm('MODEL: opus')],
    ['full-width lookalike key', fm('ｍｏｄｅｌ: opus')],
    ['key with an escape', fm('"m\\u006fdel": opus')],
    ['no space after the colon', fm('model:opus')],
    ['unterminated quoted value', fm('model: "opus')],
    ['value with an escape', fm('model: "op\\u0075s"')],
    ['sequence item at the top level', fm('- model: opus')],
    ['explicit key', fm('? model\n: opus')],
    ['unterminated frontmatter block', '---\nmodel: opus\nbody never closes\n'],
    ['Unicode line separator in the block', fm('name: q\u2028model: opus')],
    // Claude Code's block regex needs `\n`, so with CR-only line endings it reads no frontmatter at all
    ['CR-only line endings', fm('name: q\nmodel: opus', '\r')],
    ['model after a multi-line quoted description', fm('description: "line one\nmodel: haiku"\nmodel: opus')],
    // Claude Code only sees a block closed by `---`, so it reads no frontmatter at all here
    ['a document end marker closing the block', '---\nmodel: haiku\n...\nbody\n'],
    // the fallback quoting turns a trailing comment into part of the value
    ['a trailing comment after a throwing first parse', fm('bad: x: y\nmodel: haiku # cheap')],
    ['a blank line before the opening delimiter', `\n${fm('model: opus')}`],
    ['a space before the opening delimiter', ` ${fm('model: opus')}`]
  ];
  for (const [name, text] of unreadable) {
    it(`unreadable: ${name}`, () => expect(model(text)).toEqual(UNREADABLE));
  }

  it('every one of them asks through the Agent guard, never "no model"', async () => {
    setup();
    for (const [name, text] of unreadable) {
      put(projectAgents(), 'q.md', text);
      const verdict = await agentVerdict('q');
      expect({ name, verdict }).toEqual({ name, verdict: 'ask' });
    }
  });

  it('and through the Workflow guard', async () => {
    setup();
    for (const [name, text] of unreadable) {
      put(projectAgents(), 'q.md', text);
      const verdict = await workflowVerdict('q');
      expect({ name, verdict }).toEqual({ name, verdict: 'ask' });
    }
  });
});

describe('frontmatter that is read exactly allows what it should (reference "allows" list)', () => {
  const none: Array<[string, string]> = [
    ['an empty model value', fm('name: q\nmodel:')],
    ['no model key', fm('name: q\ndescription: does things')],
    ['no frontmatter at all', 'Just a body, with model: opus in it.\n'],
    ['a BOM and no frontmatter', `${BOM}Just a body.\n`],
    ['an empty file', ''],
    ['a nested model key', fm('tools:\n  model: opus\nname: q')],
    ['a model mentioned in a block scalar only', fm('description: |\n  model: opus\nname: q')],
    ['a model mentioned in a comment only', fm('# model: opus\nname: q')],
    ['a model mentioned in the body only', '---\nname: q\n---\nmodel: opus\n']
  ];
  for (const [name, text] of none) it(`none: ${name}`, () => expect(model(text)).toEqual(NONE));

  const haiku: Array<[string, string]> = [
    ['a cheaper model', fm('model: haiku')],
    ['a cheaper model with a BOM', `${BOM}${fm('model: haiku')}`],
    ['a cheaper model with CRLF', fm('model: haiku', '\r\n')],
    ['a cheaper model, space before the colon', fm('model : haiku')],
    ['a colon in an earlier description (the fallback repairs the first parse)', fm('description: Use this: when needed\nmodel: haiku')],
    ['single-line quoted and flow values', fm('description: "one line"\ntools: [Read, Grep]\nmodel: haiku')]
  ];
  for (const [name, text] of haiku) it(`haiku: ${name}`, () => expect(model(text)).toEqual(VALUE('haiku')));

  it('reads the value, not a lookalike from a block scalar', async () => {
    setup();
    put(projectAgents(), 'q.md', fm('description: |\n  model: haiku\nmodel: opus'));
    expect(readAgentDefinition('q', r.project)).toEqual({ found: true, model: 'opus' });
  });

  it('reads quoted and BOM forms of the key to the same model, or unreadable (never a different one)', () => {
    for (const text of [fm('model: opus'), fm('model: "opus"'), `${BOM}${fm("model : 'opus'")}`, fm('model: opus', '\r\n')]) {
      expect(model(text)).toEqual(VALUE('opus'));
    }
  });
});

describe('reference cases the plugin reads as Claude Code does (its strict reader is stricter there)', () => {
  it('a quoted or flow value over several lines: both pipelines read the same model, so it is read', () => {
    for (const text of [
      fm('description: "line one\n  line two"\nmodel: haiku'),
      fm("description: 'line one\n  line two'\nmodel: haiku"),
      fm('tools: [Read,\n  Grep]\nmodel: haiku'),
      fm('meta: {a: 1,\n  b: 2}\nmodel: haiku')
    ]) {
      expect(model(text)).toEqual(VALUE('haiku'));
    }
  });

  it('a quoted or flow description that hides a top-level looking model line: the model read is opus, never none', () => {
    for (const text of [
      '---\nname: smug\ndescription: "a#b\nmodel: opus\nz: c"\nbad: x: y\n---',
      "---\nname: smug\ndescription: 'a#b\nmodel: opus\nz: c'\nbad: x: y\n---",
      '---\nname: smug\ndescription: [a#,\nmodel: opus\nz: c]\nbad: x: y\n---'
    ]) {
      const m = model(text);
      expect(m.kind === 'unreadable' || (m.kind === 'value' && m.value === 'opus')).toBe(true);
    }
  });

  it('an unclosed flow value after a model: the fallback repairs it in Claude Code, so haiku is read', () => {
    expect(model(fm('model: haiku\nbad: [x\nother: y'))).toEqual(VALUE('haiku'));
  });
});

describe('the cross-check, with and without a YAML parser', () => {
  it('without a parser the strict answer stands, but a line the fallback could rewrite is unreadable', () => {
    expect(parseFrontmatter(fm('name: q\nmodel: haiku'), null).model).toEqual(VALUE('haiku'));
    expect(parseFrontmatter(fm('description: Use this: when needed\nmodel: haiku'), null).model).toEqual(UNREADABLE);
  });

  it('a parser that throws on both attempts makes the frontmatter unreadable', () => {
    const boom = () => {
      throw new Error('nope');
    };
    const f = parseFrontmatter(fm('model: haiku\nname: q\neffort: low'), boom);
    expect(f.model).toEqual(UNREADABLE);
    expect(f.name).toEqual(UNREADABLE);
    expect(f.effort).toEqual(UNREADABLE);
  });

  it('a value Claude Code would read as a non-string is unreadable', () => {
    expect(parseFrontmatter(fm('model: 5'), () => ({ model: 5 })).model).toEqual(UNREADABLE);
    expect(parseFrontmatter(fm('effort: 5')).effort).toEqual(UNREADABLE); // the real parser reads the integer 5
  });

  it('the declared name is read like the model: plain, quoted, single-quoted', () => {
    expect(parseFrontmatter(fm('name: helper'), null).name).toEqual(VALUE('helper'));
    expect(parseFrontmatter(fm('name: "helper"'), null).name).toEqual(VALUE('helper'));
    expect(parseFrontmatter(fm("name: 'helper' # c")).name).toEqual(VALUE('helper'));
  });

  it('no name, an empty name, no frontmatter', () => {
    expect(parseFrontmatter(fm('model: haiku'), null).name).toEqual(NONE);
    expect(parseFrontmatter(fm('name:'), null).name).toEqual(NONE);
    expect(parseFrontmatter('body only', null).name).toEqual(NONE);
  });

  it('a name that the strict reader and Claude Code read differently is unreadable', () => {
    // `bad: x: y` breaks the first parse; the fallback quotes `name: helper # c` whole.
    expect(parseFrontmatter(fm('bad: x: y\nname: helper # c')).name).toEqual(UNREADABLE);
  });

  it('a name problem does not make the model unreadable; a block that cannot be read at all makes both unreadable', () => {
    const f = parseFrontmatter(fm('name: "x\\u0041"\nmodel: haiku'), null);
    expect(f.name).toEqual(UNREADABLE);
    expect(f.model).toEqual(VALUE('haiku'));
    const g = parseFrontmatter('---\nname: x\n', null);
    expect(g.name).toEqual(UNREADABLE);
    expect(g.model).toEqual(UNREADABLE);
  });
});

describe('definitions are found by their declared name (reference agent-name-matching.test.ts)', () => {
  it('the file name and the declared name disagree: unreadable, not helper.md and haiku', async () => {
    setup();
    put(projectAgents(), 'helper.md', fm('name: other\nmodel: haiku'));
    put(projectAgents(), 'zz.md', fm('name: helper\nmodel: opus'));

    const def = readAgentDefinition('helper', r.project);

    expect(def.found).toBe(true);
    expect(def.unreadable).toBeDefined();
    expect(await agentVerdict('helper')).toBe('ask');
  });

  it('a file with another file name but the right name is the definition; quoted names match; subdirectories are scanned', () => {
    setup();
    put(projectAgents(), 'zz.md', fm('name: helper\nmodel: opus'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'opus' });
    put(projectAgents(), 'zz.md', fm('name: "helper"\nmodel: haiku'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'haiku' });
    fs.rmSync(path.join(projectAgents(), 'zz.md'));
    put(projectAgents(), 'team/deep/zz.md', fm('name: helper\nmodel: haiku'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'haiku' });
  });

  it('a file named like the agent with no name key, or the same name, is the definition', () => {
    setup();
    put(projectAgents(), 'helper.md', fm('model: haiku'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'haiku' });
    put(projectAgents(), 'helper.md', fm('name: helper\nmodel: haiku'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'haiku' });
  });

  it('a file with another file name and no name key is not a claimant', () => {
    setup();
    put(projectAgents(), 'zz.md', fm('model: opus'));
    put(userAgents(), 'helper.md', fm('model: haiku'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'haiku' });
  });

  it('the nearest directory still decides; a user-level file with a different file name is found by its name', () => {
    setup();
    put(projectAgents(), 'zz.md', fm('name: helper\nmodel: haiku'));
    put(userAgents(), 'helper.md', fm('model: opus'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'haiku' });
    fs.rmSync(path.join(projectAgents(), 'zz.md'));
    fs.rmSync(path.join(userAgents(), 'helper.md'));
    put(userAgents(), 'zz.md', fm('name: helper\nmodel: opus'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'opus' });
  });

  it('an installed plugin agent is found by its name too', () => {
    setup();
    const installPath = path.join(r.tmp, '.claude', 'plugins', 'cache', 'p-m');
    put(path.join(installPath, 'agents'), 'zz.md', fm('name: helper\nmodel: opus'));
    put(path.join(r.tmp, '.claude', 'plugins'), 'installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user', installPath, version: '1' }] } }));
    expect(readAgentDefinition('p:helper', r.project)).toEqual({ found: true, model: 'opus' });
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'opus' });
  });

  it('a directory named like the definition is not a definition', () => {
    setup();
    fs.mkdirSync(path.join(projectAgents(), 'helper.md'), { recursive: true });
    put(userAgents(), 'helper.md', fm('model: haiku'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'haiku' });
  });

  it('more than one claimant is unreadable: two declared, one in a subdirectory, one by file name and one by declared name; the conflict names the files', () => {
    setup();
    put(projectAgents(), 'a.md', fm('name: helper\nmodel: haiku'));
    put(projectAgents(), 'b.md', fm('name: helper\nmodel: opus'));
    const both = readAgentDefinition('helper', r.project).unreadable ?? '';
    expect(both).toContain('a.md');
    expect(both).toContain('b.md');
    fs.rmSync(path.join(projectAgents(), 'a.md'));
    fs.rmSync(path.join(projectAgents(), 'b.md'));

    put(projectAgents(), 'helper.md', fm('name: helper\nmodel: haiku'));
    put(projectAgents(), 'sub/x.md', fm('name: helper\nmodel: opus'));
    expect(readAgentDefinition('helper', r.project).unreadable).toBeDefined();
    fs.rmSync(path.join(projectAgents(), 'sub'), { recursive: true });

    put(projectAgents(), 'helper.md', fm('model: haiku'));
    put(projectAgents(), 'zz.md', fm('name: helper\nmodel: opus'));
    expect(readAgentDefinition('helper', r.project).unreadable).toBeDefined();
  });

  it('a name that cannot be read is a conflict, never a quiet skip', () => {
    setup();
    const cases: Array<[string, () => void]> = [
      ['an escape in the name of the file named like the agent', () => put(projectAgents(), 'helper.md', fm('name: "hel\\u0070er"\nmodel: haiku'))],
      ['a duplicate name key', () => put(projectAgents(), 'helper.md', fm('name: helper\nname: other\nmodel: haiku'))],
      ['an unreadable block', () => put(projectAgents(), 'helper.md', '---\nname: helper\nmodel: haiku\nno closing delimiter\n')],
      [
        'another file with an unreadable name that mentions the agent',
        () => {
          put(projectAgents(), 'helper.md', fm('name: helper\nmodel: haiku'));
          put(projectAgents(), 'zz.md', fm('name: "hel\\u0070er"\nmodel: opus'));
        }
      ],
      ['the same in the user directory', () => put(userAgents(), 'helper.md', fm('name: other\nmodel: haiku'))]
    ];
    for (const [name, arrange] of cases) {
      fs.rmSync(projectAgents(), { recursive: true, force: true });
      fs.rmSync(userAgents(), { recursive: true, force: true });
      arrange();
      expect({ name, unreadable: readAgentDefinition('helper', r.project).unreadable !== undefined }).toEqual({ name, unreadable: true });
    }
  });

  it('another file with an unreadable name that never mentions the agent is ignored', () => {
    setup();
    put(projectAgents(), 'helper.md', fm('name: helper\nmodel: haiku'));
    put(projectAgents(), 'zz.md', fm('name: "other\\u0021"\nmodel: opus'));
    expect(readAgentDefinition('helper', r.project)).toEqual({ found: true, model: 'haiku' });
  });

  it('never fewer definitions than before: a plain <name>.md, nothing found, a path-like name', () => {
    setup();
    put(projectAgents(), 'q.md', fm('model: opus'));
    expect(readAgentDefinition('q', r.project)).toEqual({ found: true, model: 'opus' });
    expect(readAgentDefinition('nope', r.project)).toEqual({ found: false, model: null });
    expect(readAgentDefinition('../q', r.project)).toEqual({ found: false, model: null });
  });
});

describe('the first definition found decides (reference agent-frontmatter.test.ts)', () => {
  it('a nearer definition with no model does not fall through to a farther one that has a model', () => {
    setup();
    put(projectAgents(), 'q.md', fm('name: q'));
    put(userAgents(), 'q.md', fm('model: haiku'));
    expect(readAgentDefinition('q', r.project)).toEqual({ found: true, model: null });
  });

  it('a nearer unreadable model is not replaced by a cheap model from a farther file', async () => {
    setup();
    put(projectAgents(), 'q.md', fm('{model: opus}'));
    put(userAgents(), 'q.md', fm('model: haiku'));
    expect(await agentVerdict('q')).toBe('ask');
  });
});

describe('a subdirectory definition cannot shadow the root definition (reference agent-definition-root.test.ts)', () => {
  const define = (dir: string, name: string, m: string | null): string =>
    put(path.join(dir, '.claude', 'agents'), `${name}.md`, m === null ? `---\nname: ${name}\n---\nbody\n` : `---\nname: ${name}\nmodel: ${m}\n---\nbody\n`);
  const sub = () => path.join(r.project, 'sub');
  const deep = () => path.join(sub(), 'deep');
  const arrange = () => {
    setup();
    fs.mkdirSync(deep(), { recursive: true });
  };

  it('root opus, subdirectory haiku, cwd in the subdirectory: unreadable, naming both files', async () => {
    arrange();
    const rootFile = define(r.project, 'x', 'opus');
    const subFile = define(sub(), 'x', 'haiku');

    const def = readAgentDefinition('x', sub());

    expect(def.unreadable).toContain(rootFile);
    expect(def.unreadable).toContain(subFile);
    expect(await agentVerdict('x', sub())).toBe('ask');
  });

  it('root haiku, subdirectory opus; two levels down; a nearer definition with no model against a root one that has one', async () => {
    arrange();
    define(r.project, 'x', 'haiku');
    define(sub(), 'x', 'opus');
    expect(await agentVerdict('x', sub())).toBe('ask');
    define(r.project, 'x', 'opus');
    define(sub(), 'x', 'haiku');
    expect(await agentVerdict('x', deep())).toBe('ask');
    define(sub(), 'x', null);
    expect(await agentVerdict('x', sub())).toBe('ask');
  });

  it('a nearer unreadable frontmatter against a root definition asks', async () => {
    arrange();
    define(r.project, 'x', 'haiku');
    put(path.join(sub(), '.claude', 'agents'), 'x.md', '---\n{model: haiku}\n---\n');
    expect(await agentVerdict('x', sub())).toBe('ask');
  });

  it('CLAUDE_PROJECT_DIR set: the root definition is found from a deep cwd, and a conflicting deep one asks', async () => {
    arrange();
    process.env.CLAUDE_PROJECT_DIR = r.project;
    define(r.project, 'x', 'opus');
    expect(readAgentDefinition('x', deep())).toEqual({ found: true, model: 'opus' });
    define(deep(), 'x', 'haiku');
    expect(await agentVerdict('x', deep())).toBe('ask');
  });

  it('definitions that agree (same model; case; inherit versus none) are not a conflict', () => {
    arrange();
    define(r.project, 'x', 'Haiku');
    define(sub(), 'x', 'haiku');
    expect(readAgentDefinition('x', sub()).unreadable).toBeUndefined();
    define(r.project, 'y', null);
    define(sub(), 'y', 'inherit');
    expect(readAgentDefinition('y', sub()).unreadable).toBeUndefined();
  });

  it('a user-level definition is shadowed by the project one; a user-level one alone is found; none anywhere is not found', () => {
    arrange();
    define(r.project, 'x', 'haiku');
    define(r.tmp, 'x', 'opus'); // ~/.claude/agents (HOME is the temp dir)
    expect(readAgentDefinition('x', sub())).toEqual({ found: true, model: 'haiku' });
    define(r.tmp, 'u', 'haiku');
    expect(readAgentDefinition('u', sub())).toEqual({ found: true, model: 'haiku' });
    expect(readAgentDefinition('absent', sub())).toEqual({ found: false, model: null });
  });
});

describe('plugin lookup prefers enabled plugins and still searches all (reference agent-lookup-consistency.test.ts)', () => {
  const install = (key: string, agents: Record<string, string>): void => {
    const installPath = path.join(r.tmp, '.claude', 'plugins', 'cache', key.replace('@', '-'));
    for (const [name, front] of Object.entries(agents)) put(path.join(installPath, 'agents'), `${name}.md`, `---\n${front}\n---\nbody\n`);
    const manifest = path.join(r.tmp, '.claude', 'plugins', 'installed_plugins.json');
    let doc: any = { version: 2, plugins: {} };
    try {
      doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    } catch {
      // first plugin
    }
    doc.plugins[key] = [{ scope: 'user', installPath, version: '1.0.0' }];
    put(path.dirname(manifest), path.basename(manifest), JSON.stringify(doc));
  };
  const settings = (dir: string, name: string, body: unknown) => put(dir, name, typeof body === 'string' ? body : JSON.stringify(body));
  const arrange = () => {
    setup();
    install('aaa@mk', { dup: 'model: opus' }); // first in the manifest, but disabled
    install('bbb@mk', { dup: 'model: haiku' }); // enabled
    install('ccc@mk', { only: 'model: sonnet' }); // not mentioned in settings
  };

  it('without readable settings the order is the manifest order; an enabled plugin goes first; none is left out', () => {
    arrange();
    expect(readAgentDefinition('dup', r.project).model).toBe('opus');
    settings(path.join(r.tmp, '.claude'), 'settings.json', { enabledPlugins: { 'aaa@mk': false, 'bbb@mk': true } });
    expect(readAgentDefinition('dup', r.project).model).toBe('haiku');
    expect(readAgentDefinition('only', r.project)).toEqual({ found: true, model: 'sonnet' });
    expect(readAgentDefinition('aaa:dup', r.project)).toEqual({ found: true, model: 'opus' });
    const dirs = agentLookupDirs('dup', r.project);
    for (const k of ['aaa-mk', 'bbb-mk', 'ccc-mk']) expect(dirs.some((d) => d.includes(k))).toBe(true);
  });

  it('project settings and settings.local.json count, the later layer winning', () => {
    arrange();
    settings(path.join(r.tmp, '.claude'), 'settings.json', { enabledPlugins: { 'bbb@mk': true } });
    settings(path.join(r.project, '.claude'), 'settings.json', { enabledPlugins: { 'aaa@mk': true } });
    settings(path.join(r.project, '.claude'), 'settings.local.json', { enabledPlugins: { 'bbb@mk': false } });
    expect(readAgentDefinition('dup', r.project).model).toBe('opus');
  });

  it('odd settings fall back to the manifest order and never throw; only true enables; project and user dirs come first', () => {
    arrange();
    for (const body of ['{ not json', '[]', '"x"', JSON.stringify({ enabledPlugins: 'yes' }), JSON.stringify({ enabledPlugins: ['bbb@mk'] }), JSON.stringify({ enabledPlugins: { 'bbb@mk': 'true' } })]) {
      settings(path.join(r.tmp, '.claude'), 'settings.json', body);
      expect(readAgentDefinition('dup', r.project)).toEqual({ found: true, model: 'opus' });
    }
    settings(path.join(r.tmp, '.claude'), 'settings.json', { enabledPlugins: { 'bbb@mk': true } });
    put(path.join(r.project, '.claude', 'agents'), 'dup.md', '---\nmodel: sonnet\n---\n');
    expect(readAgentDefinition('dup', r.project).model).toBe('sonnet');
  });
});
