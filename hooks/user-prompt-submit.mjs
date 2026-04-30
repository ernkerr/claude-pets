#!/usr/bin/env node
// UserPromptSubmit hook: fires whenever the user submits a prompt to claude
// (via the terminal OR via our pet textarea, since both end up as input to
// the same claude process). Tells the pet to clear the previous message and
// flip the pill to "thinking…".

import { readFileSync, appendFileSync } from 'node:fs';

const LOG = '/tmp/claude-pets-hooks.log';
const dlog = (msg) => {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] [submit] ${msg}\n`); } catch {}
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

const promptText = typeof event.prompt === 'string' ? event.prompt : '';

async function postEvent(body) {
  try {
    await fetch(`${BASE}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {}
}

await postEvent({ type: 'user-task', text: promptText });
await postEvent({ type: 'status', state: 'working' });

done();
