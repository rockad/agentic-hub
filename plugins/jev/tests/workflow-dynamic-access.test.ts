/**
 * Antigravity `run_workflow` guard: string-based dynamic access is unverifiable (fail closed), the same as importlib / exec.
 *
 * Each bypass below reaches a sibling `evil.py` (or a hidden `agent(...)` call) by a name the tokenizer cannot read, so
 * without the rule the script analyses CLEAN. Common code (a plain `getattr(obj, "name")`, `os`, `json`, `pathlib`,
 * `asyncio`, `collections`) must stay clean.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzePythonScript } from '../antigravity/workflow-guard.ts';

const SESSION = 'gemini-3.8-flash-low';
let dir = '';
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-dynacc-')));
  fs.writeFileSync(path.join(dir, 'evil.py'), 'print("evil")\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const analyse = (script: string) => {
  const scripts: any[] = [];
  return analyzePythonScript(script, '<inline>', { sessionModel: SESSION, seen: { models: [], instructed: false }, localModuleDirs: [dir] }, scripts);
};

describe('string-based dynamic access is unverifiable', () => {
  it.each([
    ["getattr(sys.modules['builtins'], '__imp'+'ort__')('evil')"],
    ["import pydoc\npydoc.locate('evil')"],
    ["from pydoc import locate\nlocate('evil')"],
    ["import pydoc\npydoc.importfile('/tmp/x/evil.py')"],
    ["import unittest\nunittest.defaultTestLoader.loadTestsFromName('evil')"],
    ["loader.loadTestsFromName('evil')"],
    ["loader.loadTestsFromModule(m)"],
    ["import pickle\npickle.loads(blob)"],
    ["import marshal\nmarshal.loads(blob)"],
    ["import shelve\nshelve.open('x')"],
    ["import dill\ndill.loads(blob)"],
    ["import cloudpickle\ncloudpickle.loads(blob)"],
    ["import inspect\ninspect.currentframe()"],
    ["getattr(sys.modules[__name__], 'ag'+'ent')('p', None, 'r', model='pro')"],
    ["import sys\nm = sys.modules\n"],
    ["import sys as s\nm = s.modules\n"],
    ["from sys import modules\n"],
    ["from sys import (\n    path,\n    modules,\n)\n"],
    ["from sys import *\n"],
    ["x = os.__dict__\n"],
    ["x = mod.__dict__['evil']\n"],
    ["x = frame.f_globals\n"],
    ["x = frame.f_locals\n"],
    ["x = globals()\n"],
    ["x = locals()\n"],
    ["x = vars(os)\n"],
    ["x = __builtins__\n"],
    ["import builtins\n"],
    ["x = fn.__globals__\n"],
    ["x = object.__subclasses__()\n"]
  ])('%j', (script) => {
    const sites = analyse(`${script}\n`);

    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((s) => s.kind === 'unverifiable')).toBe(true);
  });

  describe('getattr and its siblings', () => {
    it.each([
      ['getattr(obj, name)'],
      ['getattr(obj, name, None)'],
      ["getattr(obj, 'a' + 'b')"],
      ["getattr(obj, 'ag' 'ent')"],
      ["getattr(obj, f'{n}')"],
      ["getattr(obj, b'name')"],
      ["getattr(obj, '\\x61gent')"],
      ["getattr(obj, 'agent')"],
      ["getattr(obj, '__import__')"],
      ["getattr(obj, '__class__')"],
      ["getattr(sys, 'modules')"],
      ["getattr(frame, 'f_globals')"],
      ['setattr(obj, name, 1)'],
      ["setattr(sys.modules, 'agent', f)"],
      ['delattr(obj, name)'],
      ['hasattr(obj, name)'],
      ["hasattr(obj, 'agent')"],
      ['getattr(*pair)'],
      ['getattr(obj)'],
      ['g = getattr\ng(obj, n)'],
      ["list(map(getattr, objs, names))"],
      ['operator.attrgetter(name)(obj)'],
      ["operator.attrgetter('agent')(obj)"],
      ["operator.attrgetter('a.__dict__')(obj)"],
      ["operator.methodcaller(name)(obj)"],
      ["from operator import attrgetter\nattrgetter(n)(o)"]
    ])('%j', (script) => {
      const sites = analyse(`${script}\n`);

      expect(sites.length).toBeGreaterThan(0);
      expect(sites.every((s) => s.kind === 'unverifiable')).toBe(true);
    });

    it('names the call and why, by position', () => {
      const s = analyse('x = 1\ny = getattr(obj, name)\n');

      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({ line: 2, col: 5, kind: 'unverifiable' });
      expect(s[0].reason).toContain('`getattr` is not analysable');
      expect(s[0].reason).toContain('the variable `name`');
    });

    it('a getattr whose dangerous name is hidden inside another call is still found', () => {
      expect(analyse("run(getattr(obj, 'agent'))\n")).toHaveLength(1);
    });
  });

  it('an f-string expression naming the new escapes is unverifiable too', () => {
    for (const body of ['{getattr(o, n)}', '{pickle.loads(b)}', '{sys.modules}', '{o.__dict__}']) {
      expect(analyse(`x = f"${body}"\n`).length).toBeGreaterThan(0);
    }
  });

  it('through a ScriptPath-style sibling: the evil.py is never loaded by any of them, the guard stops the script first', () => {
    const sites = analyse("import pydoc\nmod = pydoc.locate('evil')\nawait agent('p')\n");

    expect(sites.map((s) => s.kind)).toEqual(['unverifiable', 'unverifiable']);
  });
});

describe('common code stays clean', () => {
  it.each([
    ["getattr(obj, 'name')"],
    ["getattr(obj, 'name', None)"],
    ["getattr(cfg, 'timeout', 30)"],
    ["hasattr(obj, 'items')"],
    ["setattr(obj, 'name', 1)"],
    ["delattr(obj, 'name')"],
    ["getattr(re, 'compile')"],
    ["operator.attrgetter('name')(obj)"],
    ["operator.attrgetter('a.b', 'c')(obj)"],
    ["operator.methodcaller('strip')(s)"],
    ['import os\nprint(os.getcwd())'],
    ['import json\nx = json.loads("{}")'],
    ['from pathlib import Path\np = Path(".") / "x"'],
    ['import asyncio\nawait asyncio.gather(a(), b())'],
    ['from collections import defaultdict, Counter\nd = defaultdict(list)'],
    ['import re\nm = re.compile("x")'],
    ['import sys\nprint(sys.argv, sys.version)'],
    ['from sys import argv\n'],
    ['import sys as s\nprint(s.platform)'],
    ['modules = ["a", "b"]\nfor m in modules:\n    pass'],
    ['x = config_modules'],
    ["if __name__ == '__main__':\n    main()"],
    ['class C:\n    def __init__(self):\n        self.x = 1\n        self.__name__ = "c"']
  ])('%j', (script) => {
    expect(analyse(`${script}\n`)).toEqual([]);
  });

  it('a script that only calls agent(...) with a literal model and uses plain getattr is clean', () => {
    expect(analyse("name = getattr(item, 'title')\nawait agent('x', None, 'r', model='flash')\n")).toEqual([]);
  });
});
