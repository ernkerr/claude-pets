import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { extractLastAssistantText } from '../hooks/transcript.mjs';

function makeTmpTranscript(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pets-test-'));
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, lines.join('\n'));
  return { file, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe('extractLastAssistantText', () => {
  it('extracts text from a content array', () => {
    const { file, cleanup } = makeTmpTranscript([
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      }),
    ]);
    try {
      assert.equal(extractLastAssistantText(file), 'Hello world');
    } finally {
      cleanup();
    }
  });

  it('extracts text from a string content', () => {
    const { file, cleanup } = makeTmpTranscript([
      JSON.stringify({
        message: { role: 'assistant', content: 'Simple string response' },
      }),
    ]);
    try {
      assert.equal(extractLastAssistantText(file), 'Simple string response');
    } finally {
      cleanup();
    }
  });

  it('returns the last assistant message, not the first', () => {
    const { file, cleanup } = makeTmpTranscript([
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'First response' }],
        },
      }),
      JSON.stringify({
        message: { role: 'user', content: 'Follow-up question' },
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Second response' }],
        },
      }),
    ]);
    try {
      assert.equal(extractLastAssistantText(file), 'Second response');
    } finally {
      cleanup();
    }
  });

  it('joins multiple text blocks', () => {
    const { file, cleanup } = makeTmpTranscript([
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Part one ' },
            { type: 'tool_use', id: 'x', name: 'Read', input: {} },
            { type: 'text', text: 'part two' },
          ],
        },
      }),
    ]);
    try {
      assert.equal(extractLastAssistantText(file), 'Part one part two');
    } finally {
      cleanup();
    }
  });

  it('skips assistant messages with only tool_use blocks (no text)', () => {
    const { file, cleanup } = makeTmpTranscript([
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Earlier message' }],
        },
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
        },
      }),
    ]);
    try {
      assert.equal(extractLastAssistantText(file), 'Earlier message');
    } finally {
      cleanup();
    }
  });

  it('returns empty string for an empty file', () => {
    const { file, cleanup } = makeTmpTranscript(['']);
    try {
      assert.equal(extractLastAssistantText(file), '');
    } finally {
      cleanup();
    }
  });

  it('returns empty string for a non-existent file', () => {
    assert.equal(extractLastAssistantText('/no/such/file.jsonl'), '');
  });

  it('skips malformed JSON lines', () => {
    const { file, cleanup } = makeTmpTranscript([
      'not valid json',
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Valid line' }],
        },
      }),
    ]);
    try {
      assert.equal(extractLastAssistantText(file), 'Valid line');
    } finally {
      cleanup();
    }
  });

  it('trims whitespace from extracted text', () => {
    const { file, cleanup } = makeTmpTranscript([
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '  padded text  ' }],
        },
      }),
    ]);
    try {
      assert.equal(extractLastAssistantText(file), 'padded text');
    } finally {
      cleanup();
    }
  });
});
