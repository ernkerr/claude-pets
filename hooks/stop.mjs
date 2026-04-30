#!/usr/bin/env node
// Stop hook: fires when an assistant turn ends. Reads the last assistant
// message from claude's transcript JSONL and posts it to the pet daemon so
// the speech bubble can show it. Also flips the pill back to idle.

import { readFileSync, appendFileSync } from 'node:fs';

const LOG = '/tmp/claude-pets-hooks.log';
const dlog = (msg) => {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] [stop] ${msg}\n`); } catch {}
};

function done() {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

const BASE = process.env.CLAUDE_PETS_BASE;
dlog(`fired, BASE=${BASE || '(missing)'}`);
if (!BASE) done();

let event = {};
try {
  const raw = readFileSync(0, 'utf8');
  event = raw ? JSON.parse(raw) : {};
} catch {}

const transcriptPath = event.transcript_path;
dlog(`transcript_path=${transcriptPath || '(missing)'}`);

function extractLastAssistantText(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj.message;
      if (msg && msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          const text = msg.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('');
          if (text.trim()) return text.trim();
        } else if (typeof msg.content === 'string' && msg.content.trim()) {
          return msg.content.trim();
        }
      }
    }
  } catch {}
  return '';
}

// Retry: claude sometimes flushes the assistant message to the transcript
// shortly after firing the Stop hook. Poll for up to ~500ms.
let lastAssistantText = '';
if (transcriptPath) {
  for (let attempt = 0; attempt < 8; attempt++) {
    lastAssistantText = extractLastAssistantText(transcriptPath);
    if (lastAssistantText) break;
    await new Promise((r) => setTimeout(r, 75));
  }
}

async function postEvent(body) {
  try {
    await fetch(`${BASE}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {}
}

dlog(`lastAssistantText length=${lastAssistantText.length}`);
if (lastAssistantText) {
  await postEvent({ type: 'message', text: lastAssistantText });
  dlog(`posted message event`);
}
await postEvent({ type: 'status', state: 'idle' });
dlog(`posted status:idle`);

done();
