#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { spawn as childSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const DAEMON = process.env.CLAUDE_PETS_DAEMON || 'http://127.0.0.1:47777';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(path.dirname(__filename));
const hookScript = path.join(projectRoot, 'hooks', 'permission.mjs');
const stopHookScript = path.join(projectRoot, 'hooks', 'stop.mjs');
const submitHookScript = path.join(projectRoot, 'hooks', 'user-prompt-submit.mjs');

const cwd = process.cwd();
const name = path.basename(cwd) || 'untitled';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isConnRefused(err) {
  const cause = err.cause || err;
  const code = cause && cause.code;
  return code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(cause?.message || ''));
}

async function tryRegister() {
  const r = await fetch(`${DAEMON}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, name, pid: process.pid }),
  });
  if (!r.ok) throw new Error(`daemon responded ${r.status}`);
  return await r.json();
}

function launchDaemon() {
  let electronBin;
  try {
    electronBin = require('electron');
  } catch {
    throw new Error('Could not locate Electron. Run `npm install` inside claude-pets.');
  }
  childSpawn(electronBin, [projectRoot], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  }).unref();
}

async function ensureDaemon() {
  try { return await tryRegister(); } catch (err) { if (!isConnRefused(err)) throw err; }
  process.stderr.write('claude-pets: starting daemon…\n');
  launchDaemon();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { return await tryRegister(); } catch (err) { if (!isConnRefused(err)) throw err; }
  }
  throw new Error('daemon did not come up within 10 seconds');
}

let session;
try {
  session = await ensureDaemon();
} catch (err) {
  console.error('claude-pets: could not reach or start the daemon');
  console.error(err.message);
  process.exit(2);
}
const sessionId = session.sessionId;
const sessionBase = `${DAEMON}/sessions/${sessionId}`;

// ---------- find claude binary ----------
function findClaudeBinary() {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.CLAUDE_BIN,
    `${home}/.local/bin/claude`,
    `${home}/.claude/local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  // Fallback: rely on PATH
  return 'claude';
}
const claudeBin = findClaudeBinary();

// ---------- write project-local settings.local.json with our hook ----------
const settingsDir = path.join(cwd, '.claude');
const settingsPath = path.join(settingsDir, 'settings.local.json');

// Quote a string for safe inclusion in a /bin/sh command line.
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const NODE = process.execPath;
const cmd = (script) =>
  `CLAUDE_PETS_BASE=${sh(sessionBase)} ${sh(NODE)} ${sh(script)}`;

let originalSettings = null;
let settingsExisted = false;

function installHook() {
  fs.mkdirSync(settingsDir, { recursive: true });
  let cfg = {};
  if (fs.existsSync(settingsPath)) {
    settingsExisted = true;
    originalSettings = fs.readFileSync(settingsPath, 'utf8');
    try { cfg = JSON.parse(originalSettings); } catch { cfg = {}; }
  }
  cfg.hooks = cfg.hooks || {};
  cfg.hooks.PreToolUse = [{
    matcher: '*',
    hooks: [{ type: 'command', command: cmd(hookScript) }],
  }];
  cfg.hooks.Stop = [{
    hooks: [{ type: 'command', command: cmd(stopHookScript) }],
  }];
  cfg.hooks.UserPromptSubmit = [{
    hooks: [{ type: 'command', command: cmd(submitHookScript) }],
  }];
  fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
}

function uninstallHook() {
  try {
    if (settingsExisted && originalSettings !== null) {
      fs.writeFileSync(settingsPath, originalSettings);
    } else if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }
  } catch {}
}

installHook();

// ---------- cleanup ----------
let exiting = false;
const finish = async (code) => {
  if (exiting) return;
  exiting = true;
  uninstallHook();
  try { await fetch(`${sessionBase}`, { method: 'DELETE' }); } catch {}
  process.exit(code ?? 0);
};

process.on('SIGTERM', () => finish(0));
process.on('SIGHUP', () => finish(0));
// Ctrl-C: pass through to claude (PTY) — claude handles it. Don't intercept here.

// ---------- spawn claude in a PTY ----------
const env = {
  ...process.env,
  CLAUDE_PETS_BASE: sessionBase, // hook reads this
  TERM: process.env.TERM || 'xterm-256color',
};

let ptyProcess;
try {
  ptyProcess = pty.spawn(claudeBin, [], {
    name: 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 30,
    cwd,
    env,
  });
} catch (err) {
  uninstallHook();
  try { await fetch(`${sessionBase}`, { method: 'DELETE' }); } catch {}
  console.error(`claude-pets: failed to spawn claude (${claudeBin}): ${err.message}`);
  console.error('If this is the first run after npm install, try: chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
  console.error('Or set CLAUDE_BIN to the full path of your claude binary.');
  process.exit(3);
}

ptyProcess.onData((data) => process.stdout.write(data));
ptyProcess.onExit(({ exitCode }) => finish(exitCode ?? 0));

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => ptyProcess.write(data));

process.stdout.on('resize', () => {
  ptyProcess.resize(process.stdout.columns || 80, process.stdout.rows || 30);
});

// ---------- inbox poll: forward pet textarea into the PTY ----------
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

async function inboxLoop() {
  let since = 0;
  while (!exiting) {
    let body;
    try {
      const r = await fetch(`${sessionBase}/inbox?since=${since}&timeout=30`);
      if (!r.ok) {
        if (r.status === 410) return;
        await sleep(1500);
        continue;
      }
      body = await r.json();
      if (body.ended) return;
    } catch {
      if (exiting) return;
      await sleep(1500);
      continue;
    }
    for (const msg of body.messages || []) {
      const isMultiline = msg.text.includes('\n');
      if (isMultiline) {
        // multi-line: bracketed paste so claude treats it as one input,
        // then a separate Enter keypress after the paste settles.
        ptyProcess.write(PASTE_START + msg.text + PASTE_END);
        await sleep(120);
        ptyProcess.write('\r');
      } else {
        // single-line: just write text + Enter.
        ptyProcess.write(msg.text);
        await sleep(60);
        ptyProcess.write('\r');
      }
    }
    since = body.cursor || since;
  }
}
inboxLoop().catch(() => {});
