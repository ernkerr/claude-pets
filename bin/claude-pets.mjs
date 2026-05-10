#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { ensureDaemon } from '../lib/daemon.mjs';
import { createHookManager } from '../lib/hook-settings.mjs';
import { findClaudeBinary } from '../lib/claude-binary.mjs';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const DAEMON = process.env.CLAUDE_PETS_DAEMON || 'http://127.0.0.1:47777';
const INBOX_BACKOFF_MS = 1500;

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(path.dirname(__filename));
const cwd = process.cwd();
const name = path.basename(cwd) || 'untitled';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- connect to daemon ----------
let session;
try {
  session = await ensureDaemon(DAEMON, projectRoot, { cwd, name, pid: process.pid });
} catch (err) {
  console.error('claude-pets: could not reach or start the daemon');
  console.error(err.message);
  process.exit(2);
}
const sessionBase = `${DAEMON}/sessions/${session.sessionId}`;

// ---------- install hooks ----------
const hooks = createHookManager({
  cwd,
  sessionBase,
  hookScripts: {
    preToolUse: path.join(projectRoot, 'hooks', 'permission.mjs'),
    stop: path.join(projectRoot, 'hooks', 'stop.mjs'),
    userPromptSubmit: path.join(projectRoot, 'hooks', 'user-prompt-submit.mjs'),
  },
});
hooks.install();

// ---------- cleanup ----------
let exiting = false;
const finish = async (code) => {
  if (exiting) return;
  exiting = true;
  hooks.uninstall();
  try { await fetch(`${sessionBase}`, { method: 'DELETE' }); } catch {} // best-effort session teardown
  process.exit(code ?? 0);
};

process.on('SIGTERM', () => finish(0));
process.on('SIGHUP', () => finish(0));
// Ctrl-C: pass through to claude (PTY) — claude handles it. Don't intercept here.

// ---------- spawn claude in a PTY ----------
const claudeBin = findClaudeBinary();
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
  hooks.uninstall();
  try { await fetch(`${sessionBase}`, { method: 'DELETE' }); } catch {} // best-effort session teardown
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
      const response = await fetch(`${sessionBase}/inbox?since=${since}&timeout=30`);
      if (!response.ok) {
        if (response.status === 410) return;
        await sleep(INBOX_BACKOFF_MS);
        continue;
      }
      body = await response.json();
      if (body.ended) return;
    } catch {
      if (exiting) return;
      await sleep(INBOX_BACKOFF_MS);
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
