#!/usr/bin/env node
// PreToolUse hook for Claude Code.
// Reads JSON from stdin, asks the claude-pets pet for permission, prints
// JSON on stdout indicating allow / block.

import { readFileSync } from 'node:fs';
import { dlog, done, postEvent, formatToolActivity } from './lib.mjs';
import { extractLastAssistantText } from './transcript.mjs';

const BASE = process.env.CLAUDE_PETS_BASE;
dlog('perm', `fired, BASE=${BASE || '(missing)'}`);
if (!BASE) {
  // No daemon configured — fail open so claude isn't bricked.
  done();
}

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  // Could not read hook input — fail open.
  done();
}

let event = {};
try { event = raw ? JSON.parse(raw) : {}; } catch {}

const toolName = event.tool_name || event.toolName || 'tool';
const toolInput = event.tool_input || event.toolInput || {};

// Read-only tools that don't need permission — auto-allow them.
const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'Skill', 'TodoWrite', 'Agent',
  'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
]);
if (SAFE_TOOLS.has(toolName)) {
  dlog('perm', `auto-allowing safe tool: ${toolName}`);
  await postEvent(BASE, { type: 'tool-activity', text: formatToolActivity(toolName, toolInput) });
  done({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  });
}

const activityText = formatToolActivity(toolName, toolInput);
await postEvent(BASE, { type: 'tool-activity', text: activityText });

function detailContent() {
  switch (toolName) {
    case 'Write':
    case 'Edit':  return toolInput.file_path || '';
    case 'Bash':  return String(toolInput.command ?? '');
    default:      return '';
  }
}

function buildDiffData() {
  switch (toolName) {
    case 'Edit':
      return {
        type: 'edit',
        oldString: toolInput.old_string ?? null,
        newString: toolInput.new_string ?? null,
      };
    case 'Write':
      return { type: 'write', writeContent: toolInput.content ?? null };
    default:
      return null;
  }
}

// Read Claude's last assistant message from the transcript as a summary.
const transcriptPath = event.transcript_path || event.transcriptPath || '';
let summary = '';
if (transcriptPath) {
  try {
    const full = extractLastAssistantText(transcriptPath);
    if (full) summary = full.length > 120 ? full.slice(0, 117) + '...' : full;
  } catch {}
}

const title = activityText;
const content = detailContent();
const diffData = buildDiffData();
dlog('perm', `summary=${summary ? summary.slice(0, 60) : '(empty)'}`);
dlog('perm', `diffData=${diffData ? diffData.type : '(none)'}`);
const options = [
  { id: 'allow',         label: '1. Yes' },
  { id: 'allow_session', label: '2. Yes, for this session' },
  { id: 'deny',          label: '3. No, and tell Claude what to do differently' },
];

let result;
try {
  const response = await fetch(`${BASE}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: title, content, options, toolName, diffData, summary }),
  });
  if (!response.ok) {
    // Daemon error — fail open.
    done();
  }
  result = await response.json();
} catch {
  // Network error — fail open.
  done();
}

if (result.choice === 'allow') {
  done({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  });
} else {
  done({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: result.feedback || 'User declined via claude-pets',
    },
  });
}
