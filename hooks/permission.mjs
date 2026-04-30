#!/usr/bin/env node
// PreToolUse hook for Claude Code.
// Reads JSON from stdin, asks the claude-pets pet for permission, prints
// JSON on stdout indicating allow / block.

import { readFileSync, appendFileSync } from 'node:fs';

const LOG = '/tmp/claude-pets-hooks.log';
const dlog = (msg) => {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] [perm] ${msg}\n`); } catch {}
};

const BASE = process.env.CLAUDE_PETS_BASE;
dlog(`fired, BASE=${BASE || '(missing)'}`);
if (!BASE) {
  // No daemon configured — fail open so claude isn't bricked.
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

let event = {};
try { event = raw ? JSON.parse(raw) : {}; } catch {}

const toolName = event.tool_name || event.toolName || 'tool';
const toolInput = event.tool_input || event.toolInput || {};

function summarize() {
  switch (toolName) {
    case 'Read':  return { title: `Read file`,    content: toolInput.file_path || '' };
    case 'Write': return { title: `Write file`,   content: toolInput.file_path || '' };
    case 'Edit':  return { title: `Edit file`,    content: toolInput.file_path || '' };
    case 'Bash':  return { title: `Bash command`, content: String(toolInput.command ?? '') };
    case 'Glob':  return { title: `Glob pattern`, content: String(toolInput.pattern ?? '') };
    case 'Grep':  return { title: `Grep pattern`, content: String(toolInput.pattern ?? '') };
    default:      return { title: `Use tool ${toolName}`, content: '' };
  }
}

const { title, content } = summarize();
const options = [
  { id: 'allow', label: '1. Yes' },
  { id: 'deny',  label: '2. No, and tell Claude what to do differently' },
];

let result;
try {
  const r = await fetch(`${BASE}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: title, content, options }),
  });
  if (!r.ok) {
    // Daemon error — fail open.
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
  result = await r.json();
} catch {
  // Network error — fail open.
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

if (result.choice === 'allow') {
  // Hook output: {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  }));
} else {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: result.feedback || 'User declined via claude-pets',
    },
  }));
}
