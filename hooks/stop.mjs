#!/usr/bin/env node
// Stop hook: fires when an assistant turn ends. Reads the last assistant
// message from claude's transcript JSONL and posts it to the pet daemon so
// the speech bubble can show it. Also flips the pill back to idle.

import { stat } from 'node:fs/promises';
import { dlog, done, readStdinJson, postEvent } from './lib.mjs';
import { extractLastAssistantText } from './transcript.mjs';

const STABLE_POLL_INTERVAL_MS = 50;
const STABLE_REQUIRED_MS = 250;
const STABLE_MAX_WAIT_MS = 5000;

const BASE = process.env.CLAUDE_PETS_BASE;
dlog('stop', `fired, BASE=${BASE || '(missing)'}`);
if (!BASE) done();

const event = readStdinJson();
const transcriptPath = event.transcript_path;
dlog('stop', `transcript_path=${transcriptPath || '(missing)'}`);

// Claude flushes the final assistant message to the transcript shortly after
// firing the Stop hook. Wait for the file size to stop growing before reading,
// otherwise we race and post a stale earlier message.
async function waitForStableTranscript(filePath) {
  let lastSize = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + STABLE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    let size = -1;
    try { size = (await stat(filePath)).size; } catch {} // file may not exist yet
    if (size !== lastSize) {
      lastSize = size;
      stableSince = Date.now();
    } else if (size > 0 && Date.now() - stableSince >= STABLE_REQUIRED_MS) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, STABLE_POLL_INTERVAL_MS));
  }
}

let lastAssistantText = '';
if (transcriptPath) {
  await waitForStableTranscript(transcriptPath);
  lastAssistantText = extractLastAssistantText(transcriptPath);
}

dlog('stop', `lastAssistantText length=${lastAssistantText.length}`);
if (lastAssistantText) {
  await postEvent(BASE, { type: 'message', text: lastAssistantText });
  dlog('stop', `posted message event`);
}
await postEvent(BASE, { type: 'status', state: 'idle' });
dlog('stop', `posted status:idle`);

done();
