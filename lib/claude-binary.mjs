// Locate the claude CLI binary on the user's system.

import fs from 'node:fs';

export function findClaudeBinary() {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.CLAUDE_BIN,
    `${home}/.local/bin/claude`,
    `${home}/.claude/local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {} // not executable or missing; try next
  }
  // Fallback: rely on PATH
  return 'claude';
}
