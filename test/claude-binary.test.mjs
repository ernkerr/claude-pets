import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findClaudeBinary } from '../lib/claude-binary.mjs';

describe('findClaudeBinary', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { HOME: process.env.HOME, CLAUDE_BIN: process.env.CLAUDE_BIN };
  });

  afterEach(() => {
    process.env.HOME = savedEnv.HOME;
    if (savedEnv.CLAUDE_BIN !== undefined) {
      process.env.CLAUDE_BIN = savedEnv.CLAUDE_BIN;
    } else {
      delete process.env.CLAUDE_BIN;
    }
  });

  it('returns CLAUDE_BIN when set and executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-pets-test-'));
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    try {
      process.env.CLAUDE_BIN = bin;
      assert.equal(findClaudeBinary(), bin);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('skips non-executable candidates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-pets-test-'));
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o644); // not executable
    try {
      process.env.CLAUDE_BIN = bin;
      // Should skip the non-executable CLAUDE_BIN and fall through
      const result = findClaudeBinary();
      assert.notEqual(result, bin);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
