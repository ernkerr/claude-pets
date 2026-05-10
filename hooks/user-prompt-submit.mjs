#!/usr/bin/env node
// UserPromptSubmit hook: fires whenever the user submits a prompt to claude
// (via the terminal OR via our pet textarea, since both end up as input to
// the same claude process). Tells the pet to clear the previous message and
// flip the pill to "thinking…".

import { dlog, done, readStdinJson, postEvent } from './lib.mjs';

const BASE = process.env.CLAUDE_PETS_BASE;
dlog('submit', `fired, BASE=${BASE || '(missing)'}`);
if (!BASE) done();

const event = readStdinJson();
const promptText = typeof event.prompt === 'string' ? event.prompt : '';

await postEvent(BASE, { type: 'user-task', text: promptText });
await postEvent(BASE, { type: 'status', state: 'working' });

done();
