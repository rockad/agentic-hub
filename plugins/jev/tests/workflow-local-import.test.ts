/**
 * A local import is unverifiable in both Workflow guards.
 *
 * Antigravity `run_workflow` (Python): an `import` or `from ... import` whose top-level name is a sibling `<name>.py` file or
 * `<name>/` package next to the script, or under its Cwd, and any relative import, cannot be analysed (the imported file may
 * launch agents): denied with "inline the agent() calls or remove the local import"; the standard library and installed
 * packages stay allowed; dialog mode asks.
 *
 * Claude Code `Workflow` (JS): the guard already treats EVERY import of a module as unverifiable, local or not: a static
 * `import`/`export ... from` declaration, a dynamic `import()` and `require` (an escape name), so a relative import is covered
 * by the existing rule. These tests pin that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzePythonScript, evaluateAntigravityWorkflowCall, evaluateWorkflowInput } from '../antigravity/workflow-guard.ts';
import { checkScriptText } from '../claude/workflow-guard.ts';
import { onPreToolUse } from '../claude/hook.ts';
import { out, rig, wf, type Rig } from './workflow-helpers.ts';

let dir = '';
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-localimp-')));
  fs.writeFileSync(path.join(dir, 'helpers.py'), 'def go():\n    pass\n');
  fs.mkdirSync(path.join(dir, 'mypkg'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'near.py'), 'X = 1\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SESSION = 'gemini-3.8-flash-low';
const analyse = (script: string, dirs: string[]) => {
  const scripts: any[] = [];
  return analyzePythonScript(script, '<inline>', { sessionModel: SESSION, seen: { models: [], instructed: false }, localModuleDirs: dirs }, scripts);
};

describe('Antigravity run_workflow: local imports', () => {
  it.each([
    ['import helpers', 'helpers'],
    ['import os, helpers', 'helpers'],
    ['import helpers as h', 'helpers'],
    ['from helpers import go', 'helpers'],
    ['from helpers.sub import go', 'helpers'],
    ['import mypkg', 'mypkg'],
    ['from mypkg import thing', 'mypkg'],
    ['import mypkg.sub.deeper', 'mypkg'],
    ['if True: import helpers', 'helpers'],
    ['x = 1; import helpers', 'helpers'],
    ['def f():\n    import helpers\n    return helpers', 'helpers']
  ])('%j is unverifiable and says what to do', (script, name) => {
    const s = analyse(`${script}\nawait agent("p")\n`, [dir]);

    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe('unverifiable');
    expect(s[0].reason).toContain(`'${name}'`);
    expect(s[0].reason).toContain('inline the agent() calls or remove the local import');
  });

  it.each(['from . import x', 'from .helpers import go', 'from .. import x', 'from ... import x'])('a relative import %j is unverifiable whatever is on disk', (script) => {
    const s = analyse(`${script}\n`, []);

    expect(s).toHaveLength(1);
    expect(s[0].reason).toContain('relative import');
  });

  it('the standard library, installed packages and names with no sibling stay allowed', () => {
    const script = 'import os, sys, json\nfrom pathlib import Path\nimport numpy as np\nfrom collections import OrderedDict\nimport asyncio\nawait agent("p")\n';

    expect(analyse(script, [dir])).toEqual([]);
  });

  it('only the import statement counts: the word in a comment, a string, an attribute or `yield from` does not', () => {
    const script = '# import helpers\ns = "import helpers"\nx = obj.import_helpers\nasync def g():\n    yield from helpers_list\n    raise ValueError("a") from helpers_err\n';

    expect(analyse(script, [dir])).toEqual([]);
  });

  it.each([
    ['fastmod.pyw', 'fastmod'],
    ['compiled.pyc', 'compiled'],
    ['native.so', 'native'],
    ['native2.cpython-312-x86_64-linux-gnu.so', 'native2'],
    ['native3.abi3.so', 'native3'],
    ['winmod.pyd', 'winmod'],
    ['winmod2.cp312-win_amd64.pyd', 'winmod2']
  ])('a sibling %s is a local module the import machinery would load', (file, name) => {
    fs.writeFileSync(path.join(dir, file), '');

    const s = analyse(`import ${name}\n`, [dir]);

    expect(s).toHaveLength(1);
    expect(s[0].reason).toContain(`'${name}'`);
  });

  it('files that are not importable modules do not count (a .txt, a .pyi stub, another name with the same prefix)', () => {
    for (const f of ['notes.txt', 'stubby.pyi', 'prefixed_extra.py']) fs.writeFileSync(path.join(dir, f), '');

    expect(analyse('import notes\nimport stubby\nimport prefixed\n', [dir])).toEqual([]);
  });

  describe('a directory: a package counts, a namespace directory for a name that is not in the standard library or that holds an importable file', () => {
    it('a plain data directory named like a standard library module does not shadow it', () => {
      fs.mkdirSync(path.join(dir, 'secrets'));
      fs.writeFileSync(path.join(dir, 'secrets', 'token.txt'), 'x');

      expect(analyse('import secrets\nfrom secrets import token_hex\n', [dir])).toEqual([]);
    });

    it('the same directory with an __init__.py is a real package and is unverifiable', () => {
      fs.mkdirSync(path.join(dir, 'secrets'));
      fs.writeFileSync(path.join(dir, 'secrets', '__init__.py'), '');

      const s = analyse('import secrets\n', [dir]);

      expect(s).toHaveLength(1);
      expect(s[0].reason).toContain("'secrets'");
    });

    it('a stdlib-named namespace directory holding an importable file is local (the stdlib module may be missing at runtime)', () => {
      fs.mkdirSync(path.join(dir, 'tkinter'));
      fs.writeFileSync(path.join(dir, 'tkinter', 'evil.py'), 'print(1)\n');

      const s = analyse('import tkinter.evil\n', [dir]);

      expect(s).toHaveLength(1);
      expect(s[0].reason).toContain("'tkinter'");
    });

    it.each(['mod.pyc', 'ext.so', 'ext.cpython-312-x86_64-linux-gnu.so', 'ext.pyd'])('a stdlib-named namespace directory holding %s is local', (file) => {
      fs.mkdirSync(path.join(dir, 'cgi'));
      fs.writeFileSync(path.join(dir, 'cgi', file), '');

      expect(analyse('import cgi\n', [dir])).toHaveLength(1);
    });

    it('a stdlib-named namespace directory holding only a subpackage with a module is local', () => {
      fs.mkdirSync(path.join(dir, 'telnetlib', 'inner'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'telnetlib', 'inner', 'x.py'), '');

      expect(analyse('import telnetlib\n', [dir])).toHaveLength(1);
    });

    it('a stdlib-named directory with only data files, empty subdirectories or cached bytecode is not local', () => {
      fs.mkdirSync(path.join(dir, 'secrets'));
      fs.writeFileSync(path.join(dir, 'secrets', 'data.json'), '{}');
      fs.mkdirSync(path.join(dir, 'json'));
      fs.mkdirSync(path.join(dir, 'json', 'empty'));
      fs.mkdirSync(path.join(dir, 'json', '__pycache__'));
      fs.writeFileSync(path.join(dir, 'json', '__pycache__', 'x.cpython-312.pyc'), '');
      fs.writeFileSync(path.join(dir, 'json', 'notes.md'), '');

      expect(analyse('import secrets\nimport json\nfrom secrets import token_hex\n', [dir])).toEqual([]);
    });

    it('a plain directory with a name that is not in the standard library can provide it, so it is unverifiable', () => {
      fs.mkdirSync(path.join(dir, 'plainpkg'));
      fs.writeFileSync(path.join(dir, 'plainpkg', 'data.json'), '{}');

      expect(analyse('import plainpkg\n', [dir])).toHaveLength(1);
    });
  });

  it('a sibling under the script directory is found, one only under the Cwd is found too, and one elsewhere is not', () => {
    const where = { cwd: dir };
    const check = (script: string, extra: Record<string, unknown> = {}) =>
      evaluateWorkflowInput({ Script: script, ...extra }, where, { sessionModel: SESSION });
    // inline: the Cwd
    expect(check('import helpers').unverifiable).toHaveLength(1);
    expect(check('import near').unverifiable).toHaveLength(0);
    // a ScriptPath in a subdirectory: its own directory, then the Cwd
    fs.writeFileSync(path.join(dir, 'sub', 'flow.py'), 'import near\nimport helpers\nimport nothing_local\n');
    const d = evaluateWorkflowInput({ ScriptPath: 'sub/flow.py' }, where, { sessionModel: SESSION });
    expect(d.unverifiable.map((s) => s.reason)).toEqual([expect.stringContaining("'near'"), expect.stringContaining("'helpers'")]);
  });

  it('through the hook: choice and clamp deny with the guidance, dialog asks, on-demand passes untouched', () => {
    fs.writeFileSync(path.join(dir, 'flow.py'), 'import helpers\nawait agent("p")\n');
    const call = (mode: string, elevationMode: 'choice' | 'dialog' | 'clamp') =>
      evaluateAntigravityWorkflowCall(
        { conversationId: 'c1', modelName: SESSION, cwd: dir, toolCall: { id: 't1', name: 'run_workflow', args: { ScriptPath: 'flow.py' } } } as any,
        { mode: mode as any, sessionModel: SESSION, elevationMode }
      );

    for (const m of ['choice', 'clamp'] as const) {
      const r = call('on', m);
      expect(r.decision.decision).toBe('deny');
      expect(r.decision.reason).toContain('inline the agent(...) calls or remove the local import');
      expect(r.log).toMatchObject({ workflow_guard: 'denied-unverifiable' });
    }
    const asked = call('on', 'dialog');
    expect(asked.decision.decision).toBe('ask');
    expect(asked.decision.reason).toContain("'helpers'");
    expect(call('on-demand', 'choice').decision.decision).toBe('pass');
  });
});

describe('Antigravity run_workflow: runpy, pkgutil and zipimport are not analysable (like importlib)', () => {
  it.each([
    ['import runpy\nrunpy.run_path("other.py")'],
    ['import pkgutil\nm = pkgutil.get_loader("x")'],
    ['import zipimport\nz = zipimport.zipimporter("a.zip")'],
    ['from runpy import run_module'],
    ['from pkgutil import iter_modules'],
    ['import importlib']
  ])('%j is unverifiable', (script) => {
    const s = analyse(`${script}\nawait agent("p")\n`, []);

    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.kind === 'unverifiable')).toBe(true);
    expect(s.some((x) => x.reason.includes('is not analysable'))).toBe(true);
  });

  it('an attribute of that name (obj.runpy) and an f-string naming one are handled like the existing escapes', () => {
    expect(analyse('x = obj.runpy\ny = cfg.pkgutil\n', [])).toEqual([]);
    expect(analyse('s = f"{runpy.run_path(p)}"\n', []).length).toBeGreaterThan(0);
  });
});

describe('Claude Code Workflow (JS): a relative import is already unverifiable (every import is)', () => {
  const SESSION_CLAUDE = 'claude-sonnet-5-5';
  it.each([
    ['a static import', `import helper from './helper.js'\nawait agent('p')`],
    ['a side-effect import', `import './helper.js'\nawait agent('p')`],
    ['a named import', `import { go } from '../lib/go.mjs'\nawait agent('p')`],
    ['a dynamic import', `const m = await import('./helper.js')\nawait agent('p')`],
    ['a require', `const m = require('./helper.js')\nawait agent('p')`],
    ['a re-export', `export * from './helper.js'\nawait agent('p')`],
    ['a named re-export', `export { go } from './helper.js'\nawait agent('p')`]
  ])('%s', (_n, script) => {
    const sites = checkScriptText(script, SESSION_CLAUDE);

    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((s) => s.kind === 'unverifiable')).toBe(true);
  });

  describe('through the hook', () => {
    let r: Rig;
    afterEach(() => r?.cleanup());

    it('is denied with guidance, never run', async () => {
      r = rig();

      const o = out(await onPreToolUse(wf({ script: `import helper from './helper.js'\nawait agent('p')` }, r), r.d));

      expect(o.permissionDecision).toBe('deny');
      expect(o.permissionDecisionReason).toContain('Jev cannot verify');
      expect(r.logs[0]).toMatchObject({ workflow_guard: 'denied-unverifiable' });
    });
  });
});
