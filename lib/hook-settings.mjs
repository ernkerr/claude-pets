// Install and uninstall Claude Code hook settings for a session.

import fs from 'node:fs';
import path from 'node:path';

// Quote a string for safe inclusion in a /bin/sh command line.
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function createHookManager({ cwd, sessionBase, hookScripts }) {
  const settingsDir = path.join(cwd, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.local.json');

  const NODE = process.execPath;
  // Don't bake CLAUDE_PETS_BASE into the command — each Claude process
  // already inherits it via the PTY environment, so hooks naturally route
  // to the correct session without the settings file being session-specific.
  const cmd = (script) => `${sh(NODE)} ${sh(script)}`;

  const expectedCommands = {
    PreToolUse: cmd(hookScripts.preToolUse),
    Stop: cmd(hookScripts.stop),
    UserPromptSubmit: cmd(hookScripts.userPromptSubmit),
  };

  let originalSettings = null;
  let settingsExisted = false;

  function hooksAlreadyInstalled(cfg) {
    if (!cfg.hooks) return false;
    for (const [hookName, command] of Object.entries(expectedCommands)) {
      const entries = cfg.hooks[hookName];
      if (!Array.isArray(entries) || entries.length < 1) return false;
      const found = entries.some((e) =>
        Array.isArray(e.hooks) && e.hooks.some((h) => h.command === command),
      );
      if (!found) return false;
    }
    return true;
  }

  function install() {
    fs.mkdirSync(settingsDir, { recursive: true });
    let cfg = {};
    if (fs.existsSync(settingsPath)) {
      settingsExisted = true;
      originalSettings = fs.readFileSync(settingsPath, 'utf8');
      try { cfg = JSON.parse(originalSettings); } catch { cfg = {}; }
    }
    // If hooks are already pointing at the right scripts, skip the write
    // so concurrent sessions don't clobber each other's backup.
    if (hooksAlreadyInstalled(cfg)) return;
    cfg.hooks = cfg.hooks || {};
    cfg.hooks.PreToolUse = [{
      matcher: '*',
      hooks: [{ type: 'command', command: expectedCommands.PreToolUse }],
    }];
    cfg.hooks.Stop = [{
      hooks: [{ type: 'command', command: expectedCommands.Stop }],
    }];
    cfg.hooks.UserPromptSubmit = [{
      hooks: [{ type: 'command', command: expectedCommands.UserPromptSubmit }],
    }];
    fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
  }

  async function uninstall() {
    try {
      // Only restore original settings if no other sessions are using this project.
      const res = await fetch(`${sessionBase.replace(/\/sessions\/.*/, '/sessions/count')}?cwd=${encodeURIComponent(cwd)}`);
      if (res.ok) {
        const { count } = await res.json();
        if (count > 0) return; // other sessions still active — leave hooks
      }
      if (settingsExisted && originalSettings !== null) {
        fs.writeFileSync(settingsPath, originalSettings);
      } else if (fs.existsSync(settingsPath)) {
        fs.unlinkSync(settingsPath);
      }
    } catch {} // best-effort cleanup on exit
  }

  return { install, uninstall };
}
