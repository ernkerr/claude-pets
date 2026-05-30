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

export function formatToolActivity(toolName, toolInput) {
  const shortPath = (p) => {
    if (!p) return '';
    const parts = p.split('/').filter(Boolean);
    return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/');
  };
  const truncate = (s, n = 30) => s.length > n ? s.slice(0, n) + '\u2026' : s;

  switch (toolName) {
    case 'Read':  return `Reading ${shortPath(toolInput.file_path)}`;
    case 'Write': return `Writing ${shortPath(toolInput.file_path)}`;
    case 'Edit':  return `Editing ${shortPath(toolInput.file_path)}`;
    case 'Bash':  return `Running ${truncate(String(toolInput.command ?? ''))}`;
    case 'Grep':  return `Searching for '${truncate(String(toolInput.pattern ?? ''), 20)}'`;
    case 'Glob':  return `Finding ${truncate(String(toolInput.pattern ?? ''), 20)}`;
    case 'Agent': return 'Delegating to agent';
    default:      return `Using ${toolName}`;
  }
}

export async function postEvent(base, body) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    const token = process.env.CLAUDE_PETS_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    await fetch(`${base}/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch {} // best-effort; daemon may be gone
}
