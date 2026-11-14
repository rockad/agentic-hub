/** The agent definition reader the Workflow guard uses: strict front matter, lookup order, conflicts. */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILTIN_AGENT_TYPES, agentLookupDirs, effortReason, parseFrontmatter, readAgentDefinition, userClaudeDir } from '../claude/agent-definitions.ts';
import { restoreEnv, snapshotEnv } from './workflow-env.ts';

let tmp = '';
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = snapshotEnv();
  for (const v of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR']) delete process.env[v];
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-agentdef-')));
  process.env.HOME = tmp;
});
afterEach(() => {
  restoreEnv(saved);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (file: string, text: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const project = (): string => path.join(tmp, 'proj');

describe('parseFrontmatter', () => {
  const fm = (text: string) => parseFrontmatter(text);

  it('reads plain, quoted and commented values', () => {
    expect(fm('---\nname: a\nmodel: opus\neffort: high\n---\n')).toEqual({ name: { kind: 'value', value: 'a' }, model: { kind: 'value', value: 'opus' }, effort: { kind: 'value', value: 'high' } });
    expect(fm(`---\nmodel: 'opus'\n---\n`).model).toEqual({ kind: 'value', value: 'opus' });
    expect(fm('---\nmodel: "claude-opus-5-5"   # the big one\n---\n').model).toEqual({ kind: 'value', value: 'claude-opus-5-5' });
    expect(fm('---\nmodel: opus # c\n---\n').model).toEqual({ kind: 'value', value: 'opus' });
  });

  it('no front matter, or a block without the keys, is none (inherits)', () => {
    expect(fm('just text\n').model).toEqual({ kind: 'none' });
    expect(fm('---\ndescription: x\n---\n').model).toEqual({ kind: 'none' });
    expect(fm('---\nmodel:\n---\n').model).toEqual({ kind: 'none' });
  });

  it('ignores a leading BOM and CRLF line endings; CR-only endings are unreadable (Claude Code reads no front matter there)', () => {
    expect(fm('﻿---\r\nmodel: opus\r\n---\r\n').model).toEqual({ kind: 'value', value: 'opus' });
    expect(fm('---\rmodel: opus\r---\r').model.kind).toBe('unreadable');
  });

  it('keys and values it cannot establish are unreadable, never none', () => {
    const bad: Array<[string, string]> = [
      ['quoted key', '---\n"model": opus\n---\n'],
      ['case variant', '---\nModel: opus\n---\n'],
      ['duplicate', '---\nmodel: haiku\nmodel: opus\n---\n'],
      ['multi-line value', '---\nmodel: op\n  us\n---\n'],
      ['block scalar', '---\nmodel: |\n  opus\n---\n'],
      ['flow value', '---\nmodel: [opus]\n---\n'],
      ['anchor', '---\nmodel: &a opus\n---\n'],
      ['alias', '---\nmodel: *a\n---\n'],
      ['tag', '---\nmodel: !!str opus\n---\n'],
      ['escape in a double quote', '---\nmodel: "op\\x75s"\n---\n'],
      ['unterminated quote', '---\nmodel: "opus\n---\n'],
      ['merge key', '---\n<<: *base\nmodel: haiku\n---\n'],
      ['unterminated block', '---\nmodel: haiku\n'],
      ['not a mapping', '---\n- model: opus\n---\n']
    ];
    for (const [name, text] of bad) {
      const f = fm(text);
      expect([name, f.model.kind]).toEqual([name, 'unreadable']);
    }
  });

  it('a nested key called model is not the top-level one', () => {
    expect(fm('---\nmeta:\n  model: opus\n---\n').model).toEqual({ kind: 'none' });
  });
});

describe('effortReason', () => {
  it('low, medium, high pass; xhigh and max ask; the rest cannot be checked', () => {
    for (const e of ['low', 'medium', 'high']) expect(effortReason(e, 'x')).toBeNull();
    for (const e of ['xhigh', 'max']) expect(effortReason(e, 'x')).toContain('interim effort threshold');
    for (const e of ['ultra', '', 'HIGH']) expect(effortReason(e, 'x')).toContain('not a level Jev recognises');
    expect(effortReason(5, 'x')).toContain('not a string');
    expect(effortReason(null, 'x')).toContain('null');
  });
});

describe('readAgentDefinition', () => {
  it('finds a project definition by file name or by front matter name, and reports model and effort', () => {
    write(path.join(project(), '.claude', 'agents', 'deep.md'), '---\nmodel: opus\neffort: max\n---\n');
    write(path.join(project(), '.claude', 'agents', 'nested', 'x.md'), '---\nname: renamed\nmodel: haiku\n---\n');

    expect(readAgentDefinition('deep', project())).toEqual({ found: true, model: 'opus', effort: 'max' });
    expect(readAgentDefinition('renamed', project())).toEqual({ found: true, model: 'haiku' });
    expect(readAgentDefinition('ghost', project())).toEqual({ found: false, model: null });
  });

  it('looks in the project (up to the git root), then the user dir, then plugin dirs', () => {
    fs.mkdirSync(path.join(project(), '.git'), { recursive: true });
    write(path.join(project(), '.claude', 'agents', 'p.md'), '---\nmodel: opus\n---\n');
    write(path.join(tmp, '.claude', 'agents', 'u.md'), '---\nmodel: haiku\n---\n');
    const plugin = path.join(tmp, 'plug');
    write(path.join(plugin, 'agents', 'pa.md'), '---\nmodel: sonnet\n---\n');
    write(path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'plug@m': [{ installPath: plugin }] } }));
    const sub = path.join(project(), 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });

    expect(readAgentDefinition('p', sub).model).toBe('opus');
    expect(readAgentDefinition('u', sub).model).toBe('haiku');
    expect(readAgentDefinition('pa', sub).model).toBe('sonnet');
    expect(readAgentDefinition('plug:pa', sub).model).toBe('sonnet');
    expect(readAgentDefinition('other:pa', sub).found).toBe(false);
    expect(readAgentDefinition('plug:p', sub).found).toBe(false); // a namespaced name only looks in that plugin
  });

  it('the project definition decides over the user one', () => {
    write(path.join(project(), '.claude', 'agents', 'x.md'), '---\nmodel: haiku\n---\n');
    write(path.join(tmp, '.claude', 'agents', 'x.md'), '---\nmodel: opus\n---\n');

    expect(readAgentDefinition('x', project()).model).toBe('haiku');
  });

  it('CLAUDE_CONFIG_DIR replaces ~/.claude, a relative value resolves against the cwd', () => {
    process.env.HOME = path.join(tmp, 'home'); // a sibling of proj, so the project walk never reaches it
    write(path.join(tmp, 'home', '.claude', 'agents', 'stale.md'), '---\nmodel: opus\n---\n');
    write(path.join(tmp, 'cfg', 'agents', 'live.md'), '---\nmodel: opus\n---\n');
    process.env.CLAUDE_CONFIG_DIR = '../cfg';

    expect(userClaudeDir(project())).toBe(path.join(tmp, 'cfg'));
    expect(readAgentDefinition('live', project()).model).toBe('opus');
    expect(readAgentDefinition('stale', project()).found).toBe(false);
    process.env.CLAUDE_CONFIG_DIR = '';
    expect(userClaudeDir(project())).toBe(path.join(tmp, 'home', '.claude'));
    expect(readAgentDefinition('stale', project()).model).toBe('opus');
  });

  it('conflicts are unreadable: two claimants, a file that declares another name, a nested project definition that disagrees', () => {
    write(path.join(project(), '.claude', 'agents', 'dup.md'), '---\nmodel: haiku\n---\n');
    write(path.join(project(), '.claude', 'agents', 'sub', 'dup2.md'), '---\nname: dup\nmodel: opus\n---\n');
    write(path.join(project(), '.claude', 'agents', 'liar.md'), '---\nname: someone-else\nmodel: haiku\n---\n');

    expect(readAgentDefinition('dup', project()).unreadable).toContain('more than one file');
    expect(readAgentDefinition('liar', project()).unreadable).toContain('declares the name "someone-else"');

    const nestedCwd = path.join(project(), 'inner');
    fs.mkdirSync(path.join(project(), '.git'), { recursive: true });
    write(path.join(nestedCwd, '.claude', 'agents', 'split.md'), '---\nmodel: haiku\n---\n');
    write(path.join(project(), '.claude', 'agents', 'split.md'), '---\nmodel: opus\n---\n');
    expect(readAgentDefinition('split', nestedCwd).unreadable).toContain('more than one place');
  });

  it('an unreadable model or effort in the winning file is reported as unreadable', () => {
    write(path.join(project(), '.claude', 'agents', 'odd.md'), '---\nmodel: [opus]\n---\n');

    expect(readAgentDefinition('odd', project())).toMatchObject({ found: true, unreadable: expect.stringContaining('odd.md') });
  });

  it('a name that is not a plain file name finds nothing and searches nowhere', () => {
    for (const n of ['../x', 'a/b', 'a:b:c', '', '.hidden']) {
      expect(readAgentDefinition(n, project()).found).toBe(false);
      expect(agentLookupDirs(n, project())).toEqual([]);
    }
  });

  it('the built-in types are the six Claude Code ships', () => {
    expect([...BUILTIN_AGENT_TYPES].sort()).toEqual(['Explore', 'Plan', 'claude', 'claude-code-guide', 'general-purpose', 'statusline-setup']);
  });
});
