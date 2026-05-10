// Extract the last assistant message from a Claude Code transcript JSONL file.

import { readFileSync } from 'node:fs';

export function extractLastAssistantText(filePath) {
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
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('');
          if (text.trim()) return text.trim();
        } else if (typeof msg.content === 'string' && msg.content.trim()) {
          return msg.content.trim();
        }
      }
    }
  } catch {} // transcript may not exist yet
  return '';
}
