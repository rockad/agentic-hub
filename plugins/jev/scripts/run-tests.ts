/**
 * `bun run test`: run `bun test` with a fresh, empty HOME that exists before bun starts.
 * bun caches os.homedir() at startup (checked on 1.3.12), so assigning process.env.HOME later, as the
 * tests/setup-home.ts preload does, does not move it. Modules that build paths from os.homedir() at import
 * (src/core/client.ts reads ~/.config/zsh/secrets.env, ~/.config/jev/env and the Antigravity .env) would still
 * see the real home. Extra arguments go to `bun test` unchanged.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-test-home-'));
let code = 1;
try {
  const proc = Bun.spawnSync([process.execPath, 'test', ...process.argv.slice(2)], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['inherit', 'inherit', 'inherit']
  });
  code = proc.exitCode ?? 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(code);
