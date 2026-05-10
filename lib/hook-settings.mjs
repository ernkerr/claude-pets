// Install and uninstall Claude Code hook settings for a session.

import fs from 'node:fs';
import path from 'node:path';

// Quote a string for safe inclusion in a /bin/sh command line.
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function createHookManager({ cwd, sessionBase, hookScripts }) {
  const settingsDir = path.join(cwd, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.local.json');

  const NODE = process.execPath;
  const cmd = (script) =>
    `CLAUDE_PETS_BASE=${sh(sessionBase)} ${sh(NODE)} ${sh(script)}`;

  let originalSettings = null;
  let settingsExisted = false;

  function install() {
    fs.mkdirSync(settingsDir, { recursive: true });
    let cfg = {};
    if (fs.existsSync(settingsPath)) {
      settingsExisted = true;
      originalSettings = fs.readFileSync(settingsPath, 'utf8');
      try { cfg = JSON.parse(originalSettings); } catch { cfg = {}; }
    }
    cfg.hooks = cfg.hooks || {};
    cfg.hooks.PreToolUse = [{
      matcher: '*',
      hooks: [{ type: 'command', command: cmd(hookScripts.preToolUse) }],
    }];
    cfg.hooks.Stop = [{
      hooks: [{ type: 'command', command: cmd(hookScripts.stop) }],
    }];
    cfg.hooks.UserPromptSubmit = [{
      hooks: [{ type: 'command', command: cmd(hookScripts.userPromptSubmit) }],
    }];
    fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
  }

  function uninstall() {
    try {
      if (settingsExisted && originalSettings !== null) {
        fs.writeFileSync(settingsPath, originalSettings);
      } else if (fs.existsSync(settingsPath)) {
        fs.unlinkSync(settingsPath);
      }
    } catch {} // best-effort cleanup on exit
  }

  return { install, uninstall };
}
