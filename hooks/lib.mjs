// Shared utilities for Claude Pets hooks.

import { readFileSync, appendFileSync } from 'node:fs';

const LOG = '/tmp/claude-pets-hooks.log';

export function dlog(tag, msg) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] [${tag}] ${msg}\n`);
  } catch {} // best-effort debug logging; no stderr in hook context
}

export function done(output = {}) {
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

export function readStdinJson() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function postEvent(base, body) {
  try {
    await fetch(`${base}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {} // best-effort; daemon may be gone
}
