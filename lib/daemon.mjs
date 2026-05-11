// Daemon lifecycle: launch the Electron daemon and register a session.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const DAEMON_STARTUP_ATTEMPTS = 40;
const DAEMON_STARTUP_INTERVAL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isConnRefused(err) {
  const cause = err.cause || err;
  const code = cause && cause.code;
  return code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(cause?.message || ''));
}

async function tryRegister(daemonUrl, { cwd, name, pid }) {
  const response = await fetch(`${daemonUrl}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, name, pid }),
  });
  if (!response.ok) throw new Error(`daemon responded ${response.status}`);
  return await response.json();
}

function launchDaemon(projectRoot) {
  const require = createRequire(import.meta.url);
  let electronBin;
  try {
    electronBin = require('electron');
  } catch {
    throw new Error('Could not locate Electron. Run `npm install` inside claude-pets.');
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(electronBin, [projectRoot], {
    detached: true,
    stdio: 'ignore',
    env,
  }).unref();
}

export async function ensureDaemon(daemonUrl, projectRoot, registration) {
  try {
    return await tryRegister(daemonUrl, registration);
  } catch (err) {
    if (!isConnRefused(err)) throw err;
  }
  process.stderr.write('claude-pets: starting daemon\u2026\n');
  launchDaemon(projectRoot);
  for (let i = 0; i < DAEMON_STARTUP_ATTEMPTS; i++) {
    await sleep(DAEMON_STARTUP_INTERVAL_MS);
    try {
      return await tryRegister(daemonUrl, registration);
    } catch (err) {
      if (!isConnRefused(err)) throw err;
    }
  }
  throw new Error('daemon did not come up within 10 seconds');
}
