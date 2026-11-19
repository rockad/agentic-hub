import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTracingConfig } from '../src/tracing.ts';

describe('tracing config path is resolved at call time (R5)', () => {
  it('reads JEV_CONFIG_FILE, not a config under the startup os.homedir()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-tracing-cfg-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ tracing: { serviceName: 'from-pinned-config' } }));
    const saved = { cfg: process.env.JEV_CONFIG_FILE, svc: process.env.OTEL_SERVICE_NAME };
    try {
      delete process.env.OTEL_SERVICE_NAME;
      process.env.JEV_CONFIG_FILE = file;
      expect(resolveTracingConfig().serviceName).toBe('from-pinned-config');
    } finally {
      if (saved.cfg === undefined) delete process.env.JEV_CONFIG_FILE;
      else process.env.JEV_CONFIG_FILE = saved.cfg;
      if (saved.svc !== undefined) process.env.OTEL_SERVICE_NAME = saved.svc;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to <HOME>/.config/jev/config.json at call time', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-tracing-home-'));
    fs.mkdirSync(path.join(home, '.config', 'jev'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'jev', 'config.json'), JSON.stringify({ tracing: { serviceName: 'from-home' } }));
    const saved = { cfg: process.env.JEV_CONFIG_FILE, home: process.env.HOME, svc: process.env.OTEL_SERVICE_NAME };
    try {
      delete process.env.OTEL_SERVICE_NAME;
      delete process.env.JEV_CONFIG_FILE;
      process.env.HOME = home;
      expect(resolveTracingConfig().serviceName).toBe('from-home');
    } finally {
      process.env.HOME = saved.home;
      if (saved.cfg !== undefined) process.env.JEV_CONFIG_FILE = saved.cfg;
      if (saved.svc !== undefined) process.env.OTEL_SERVICE_NAME = saved.svc;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
