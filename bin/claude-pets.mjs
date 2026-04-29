#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DAEMON = process.env.CLAUDE_PETS_DAEMON || 'http://127.0.0.1:47777';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(path.dirname(__filename));
const agentScript = path.join(projectRoot, 'agent', 'index.mjs');

const cwd = process.cwd();
const name = path.basename(cwd) || 'untitled';
const initialTask = process.argv.slice(2).join(' ').trim();

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
  spawn(electronBin, [projectRoot], {
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

let exiting = false;

const cleanup = async () => {
  try { await fetch(`${DAEMON}/sessions/${sessionId}`, { method: 'DELETE' }); } catch {}
};

const finish = async (code) => {
  if (exiting) return;
  exiting = true;
  try { detachInput(); } catch {}
  if (process.stdout.isTTY) process.stdout.write('\x1b[?2004l');
  await cleanup();
  process.exit(code ?? 0);
};

process.on('SIGINT', () => finish(0));
process.on('SIGTERM', () => finish(0));
process.on('SIGHUP', () => finish(0));

// ---------- task queue (serializes terminal + inbox tasks) ----------
let runQueue = Promise.resolve();
function enqueueTask(task) {
  runQueue = runQueue.then(() => runTask(task));
  return runQueue;
}

async function runTask(task) {
  if (exiting) return 0;
  let shouldContinue = false;
  try {
    const r = await fetch(`${DAEMON}/sessions/${sessionId}/begin-task`, { method: 'POST' });
    if (r.ok) {
      const body = await r.json();
      shouldContinue = !!body.shouldContinue;
    }
  } catch {}

  // While the agent runs, hand the terminal back to cooked mode so the user
  // sees clean output. Re-attach our raw input afterwards.
  const wasAttached = inputAttached;
  if (wasAttached) detachInput();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [agentScript, task], {
      cwd,
      env: {
        ...process.env,
        CLAUDE_PETS_BASE: `${DAEMON}/sessions/${sessionId}`,
        CLAUDE_PETS_CONTINUE: shouldContinue ? '1' : '',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const onSig = (sig) => () => { if (!child.killed) child.kill(sig); };
    const sigInt = onSig('SIGINT');
    const sigTerm = onSig('SIGTERM');
    process.on('SIGINT', sigInt);
    process.on('SIGTERM', sigTerm);
    child.on('exit', (code) => {
      process.off('SIGINT', sigInt);
      process.off('SIGTERM', sigTerm);
      if (wasAttached && !exiting) {
        attachInput();
        writePrompt();
      }
      resolve(code ?? 0);
    });
    child.on('error', (err) => {
      console.error('claude-pets: failed to spawn agent:', err.message);
      if (wasAttached && !exiting) {
        attachInput();
        writePrompt();
      }
      resolve(1);
    });
  });
}

// ---------- raw mode REPL with bracketed paste ----------
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

let buffer = '';
let inputAttached = false;
let escapeState = 'none'; // 'none' | 'esc' | 'csi' | 'paste'
let escapeBuffer = '';

function writePrompt() {
  process.stdout.write(`\x1b[36m${name}>\x1b[0m `);
}

function attachInput() {
  if (inputAttached) return;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', processInput);
  inputAttached = true;
}

function detachInput() {
  if (!inputAttached) return;
  process.stdin.removeListener('data', processInput);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  inputAttached = false;
}

function submitBuffer() {
  const text = buffer;
  buffer = '';
  process.stdout.write('\n');
  const t = text.trim();
  if (!t) {
    writePrompt();
    return;
  }
  if (t === 'exit' || t === 'quit') {
    finish(0);
    return;
  }
  enqueueTask(t);
}

function processChar(ch) {
  if (escapeState === 'paste') {
    escapeBuffer += ch;
    if (escapeBuffer.endsWith(PASTE_END)) {
      const content = escapeBuffer.slice(0, -PASTE_END.length).replace(/\r/g, '\n');
      buffer += content;
      process.stdout.write(content);
      escapeBuffer = '';
      escapeState = 'none';
    } else if (escapeBuffer.length > 200000) {
      // Safety: paste end never arrived. Treat as content.
      buffer += escapeBuffer.replace(/\r/g, '\n');
      process.stdout.write(escapeBuffer);
      escapeBuffer = '';
      escapeState = 'none';
    }
    return;
  }
  if (escapeState === 'esc') {
    if (ch === '[') {
      escapeState = 'csi';
      escapeBuffer = '\x1b[';
    } else {
      // Lone ESC or non-CSI escape — discard.
      escapeState = 'none';
      escapeBuffer = '';
    }
    return;
  }
  if (escapeState === 'csi') {
    escapeBuffer += ch;
    const code = ch.charCodeAt(0);
    if (code >= 0x40 && code <= 0x7e) {
      // CSI terminator reached.
      if (escapeBuffer === PASTE_START) {
        escapeState = 'paste';
        escapeBuffer = '';
      } else {
        // Other CSI (arrows, etc.) — discard for now (no line editing).
        escapeState = 'none';
        escapeBuffer = '';
      }
    } else if (escapeBuffer.length > 32) {
      // Sanity: invalid CSI, drop it.
      escapeState = 'none';
      escapeBuffer = '';
    }
    return;
  }

  // Normal state.
  if (ch === '\x1b') {
    escapeState = 'esc';
    return;
  }
  if (ch === '\r' || ch === '\n') {
    submitBuffer();
    return;
  }
  if (ch === '\x7f' || ch === '\b') {
    if (buffer.length > 0) {
      buffer = buffer.slice(0, -1);
      process.stdout.write('\b \b');
    }
    return;
  }
  if (ch === '\x03') {
    // Ctrl-C: clear current line if there's something typed,
    // otherwise exit cleanly (matches `claude` CLI).
    if (buffer.length === 0) {
      process.stdout.write('\n');
      finish(0);
      return;
    }
    buffer = '';
    process.stdout.write('^C\n');
    writePrompt();
    return;
  }
  if (ch === '\x04') {
    // Ctrl-D
    if (buffer.length === 0) {
      process.stdout.write('\n');
      finish(0);
    }
    return;
  }
  if (ch >= ' ') {
    buffer += ch;
    process.stdout.write(ch);
  }
}

function processInput(chunk) {
  for (const ch of chunk) processChar(ch);
}

// ---------- inbox long-poll loop ----------
async function inboxLoop() {
  let since = 0;
  while (!exiting) {
    let body;
    try {
      const r = await fetch(`${DAEMON}/sessions/${sessionId}/inbox?since=${since}&timeout=30`);
      if (!r.ok) {
        if (r.status === 410) return; // session ended
        await sleep(1500);
        continue;
      }
      body = await r.json();
      if (body.ended) return;
    } catch (err) {
      if (exiting) return;
      await sleep(1500);
      continue;
    }
    for (const msg of body.messages || []) {
      // Erase the user's current prompt line, print the [from pet] echo,
      // then the prompt will be redrawn after the task completes.
      if (inputAttached) {
        process.stdout.write('\r\x1b[2K');
      }
      const firstLine = msg.text.split('\n')[0];
      const more = msg.text.includes('\n') ? ' …' : '';
      process.stdout.write(`\x1b[35m[from pet]\x1b[0m ${firstLine}${more}\n`);
      await enqueueTask(msg.text);
    }
    since = body.cursor || since;
  }
}

// ---------- main flow ----------
if (initialTask) {
  // One-shot: run task to completion, then exit. No raw mode.
  inboxLoop().catch(() => {});
  const code = await enqueueTask(initialTask);
  await finish(code);
} else {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?2004h');
  console.log('type a task and hit enter');
  attachInput();
  writePrompt();
  inboxLoop().catch(() => {});
}
