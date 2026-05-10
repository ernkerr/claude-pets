#!/usr/bin/env node
// Stop hook: fires when an assistant turn ends. Reads the last assistant
// message from claude's transcript JSONL and posts it to the pet daemon so
// the speech bubble can show it. Also flips the pill back to idle.

import { dlog, done, readStdinJson, postEvent } from './lib.mjs';
import { extractLastAssistantText } from './transcript.mjs';

const TRANSCRIPT_POLL_ATTEMPTS = 8;
const TRANSCRIPT_POLL_INTERVAL_MS = 75;

const BASE = process.env.CLAUDE_PETS_BASE;
dlog('stop', `fired, BASE=${BASE || '(missing)'}`);
if (!BASE) done();

const event = readStdinJson();
const transcriptPath = event.transcript_path;
dlog('stop', `transcript_path=${transcriptPath || '(missing)'}`);

// Retry: claude sometimes flushes the assistant message to the transcript
// shortly after firing the Stop hook. Poll briefly.
let lastAssistantText = '';
if (transcriptPath) {
  for (let attempt = 0; attempt < TRANSCRIPT_POLL_ATTEMPTS; attempt++) {
    lastAssistantText = extractLastAssistantText(transcriptPath);
    if (lastAssistantText) break;
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_POLL_INTERVAL_MS));
  }
}

dlog('stop', `lastAssistantText length=${lastAssistantText.length}`);
if (lastAssistantText) {
  await postEvent(BASE, { type: 'message', text: lastAssistantText });
  dlog('stop', `posted message event`);
}
await postEvent(BASE, { type: 'status', state: 'idle' });
dlog('stop', `posted status:idle`);

done();
