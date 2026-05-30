// Shared-secret token for the claude-pets daemon HTTP API.
// Daemon generates on first start; CLI + hooks read it to authenticate.
// Blocks browser tabs (DNS rebinding, fetch-to-localhost) from driving the
// daemon. Same-user processes that can read $HOME defeat this — that's the
// accepted boundary.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.claude-pets',
  'daemon-token',
);

export function tokenPath() {
  return TOKEN_PATH;
}

export function loadOrCreateToken() {
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch {} // file missing or unreadable — generate fresh
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

export function readTokenSync() {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
