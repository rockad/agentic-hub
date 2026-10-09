#!/usr/bin/env node
/**
 * Agentic-Hub: Windows Chrome Launcher & CDP MCP Bridge
 *
 * Ensures Windows Google Chrome is running with remote debugging enabled on
 * port 9222 before connecting chrome-devtools-mcp.
 *
 * A cold start is not just "is the port open". If Chrome is already running
 * against this dedicated debug profile, launching another chrome.exe only
 * hands the flags to the existing single-instance process: no second browser
 * starts, the debugging port never opens, and chrome-devtools-mcp would then
 * connect to nothing while the MCP server still reports "connected". So when
 * the port is closed we first stop any chrome.exe that holds the debug
 * profile, then start one, and fail loudly if the port still does not come up.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const DEBUG_PORT = process.env.CHROME_DEBUG_PORT || '9222';
const CHROME_EXE = process.env.CHROME_WINDOWS_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const POWERSHELL_PATH = process.env.POWERSHELL_PATH || '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const READY_TIMEOUT_MS = Number(process.env.CHROME_READY_TIMEOUT_MS || 25000);

function ps(command) {
  return spawnSync(POWERSHELL_PATH, ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
}

function resolveUserProfile() {
  if (process.env.USERPROFILE) return process.env.USERPROFILE;
  // In WSL, detect Windows user folder from /mnt/c/Users/<user>
  const wslUser = process.env.USER || process.env.LOGNAME;
  if (wslUser && fs.existsSync(`/mnt/c/Users/${wslUser}`)) {
    return `C:\\Users\\${wslUser}`;
  }
  // Try querying PowerShell directly
  try {
    const r = ps('Write-Output $env:USERPROFILE');
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      return r.stdout.trim();
    }
  } catch {}
  const fallbackUser = wslUser || 'User';
  return `C:\\Users\\${fallbackUser}`;
}

const USER_PROFILE = resolveUserProfile();
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || `${USER_PROFILE}\\.config\\chrome-devtools-mcp\\profile`;

function isChromeReady() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Only Chrome started against our dedicated profile directory.
// Normal user browsing Chrome uses the default profile and must never be killed.
function profileChromePids() {
  const escapedProfile = PROFILE_DIR.replace(/['"]/g, '');
  const script = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
    "Where-Object { ($_.CommandLine -like '*--user-data-dir=*' -and $_.CommandLine -like '*" + escapedProfile + "*') -or $_.CommandLine -like '*chrome-devtools-mcp*profile*' } | " +
    "Select-Object -ExpandProperty ProcessId";
  const r = ps(script);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split(/\s+/).map((s) => s.trim()).filter(Boolean)
    .map(Number).filter(Number.isFinite);
}

function stopPids(pids) {
  if (!pids.length) return;
  ps(`Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue`);
}

function startChrome() {
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    'about:blank'
  ];
  const argList = args.map(a => `'${a}'`).join(', ');
  const script = `Start-Process '${CHROME_EXE}' -ArgumentList ${argList}`;
  const r = ps(script);
  if (r.status !== 0) {
    console.error(`[launch-windows] PowerShell could not start Chrome: ${(r.stderr || '').trim()}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureBrowser() {
  if (await isChromeReady()) return true;

  const pids = profileChromePids();
  if (pids.length) {
    console.error(`[launch-windows] port ${DEBUG_PORT} is closed but ${pids.length} Chrome ` +
      `process(es) hold the debug profile; restarting them with debugging enabled`);
    stopPids(pids);
    await wait(1500);
  }

  startChrome();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isChromeReady()) return true;
    await wait(500);
  }
  return false;
}

async function main() {
  if (!(await ensureBrowser())) {
    console.error(`[launch-windows] Chrome never opened the CDP port on 127.0.0.1:${DEBUG_PORT} ` +
      `within ${READY_TIMEOUT_MS}ms.`);
    console.error('[launch-windows] chrome-devtools-mcp would connect to nothing, so exiting ' +
      'instead of reporting a hollow "connected".');
    console.error(`[launch-windows] Check that ${CHROME_EXE} exists, the debug profile is not ` +
      `locked, and WSL interop can run ${POWERSHELL_PATH}.`);
    process.exit(1);
  }

  const nodeDir = path.dirname(process.execPath);
  const npxCandidate = path.join(nodeDir, 'npx');
  const npxCmd = fs.existsSync(npxCandidate) ? npxCandidate : 'npx';
  const resolvedPath = [nodeDir, '/home/rockad/.local/bin', process.env.PATH || ''].filter(Boolean).join(':');

  const child = spawn(npxCmd, [
    '-y',
    'chrome-devtools-mcp@latest',
    `--browserUrl=http://127.0.0.1:${DEBUG_PORT}`,
    '--no-usage-statistics',
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: resolvedPath,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
  });

  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

main();
