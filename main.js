const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 47777;
const SWEEP_INTERVAL_MS = 1500;
const WIN_W = 240;
const WIN_H = 480;
const MIN_W = 220;
const MIN_H = 320;

// sessionId -> { id, cwd, name, color, pid, win, queue, current, ... }
const sessions = new Map();

// Persistent config:
// {
//   schemaVersion: 2,
//   pets: { [petId]: { name, builtin, states: { idle, thinking, responseNeeded } } },
//   selections: { [cwd]: petId },
//   windowSizes: { [cwd]: { width, height } }
// }
//
// Each state entry is null OR:
//   { kind: 'static' | 'gif' | 'sprite-sheet',
//     file: 'idle.png',         (filename inside <userData>/pets/<petId>/)
//     width, height,
//     frames, fps, loopStart, loopEnd, version }
let petConfig = { schemaVersion: 2, pets: {}, selections: {}, windowSizes: {} };
let configPath = '';

const STATE_KEYS = ['idle', 'thinking', 'responseNeeded'];

const BUILTIN_PETS = {
  'sausage-dog': {
    name: 'Sausage Dog',
    builtin: true,
    states: {
      idle: {
        kind: 'static',
        builtinSrc: 'assets/sausage-dog/idle.png',
        frames: 1, fps: 12, loopStart: 0, loopEnd: 0,
      },
      thinking: null,
      responseNeeded: null,
    },
  },
};
const DEFAULT_PET_ID = 'sausage-dog';

function petsDir() {
  return path.join(app.getPath('userData'), 'pets');
}

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'pets-config.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    raw = null;
  }
  petConfig = migrateConfig(raw);
  saveConfig();
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(petConfig, null, 2));
  } catch (e) {
    console.error('claude-pets: failed to save config:', e.message);
  }
}

function migrateConfig(raw) {
  if (raw && raw.schemaVersion === 2) {
    raw.pets = raw.pets || {};
    raw.selections = raw.selections || {};
    raw.windowSizes = raw.windowSizes || {};
    return raw;
  }
  const next = { schemaVersion: 2, pets: {}, selections: {}, windowSizes: {} };
  if (!raw || typeof raw !== 'object') return next;
  // Legacy shape: { [cwd]: { icon?: dataUrl, size?: { width, height } } }
  for (const [cwd, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object') continue;
    if (val.size && typeof val.size === 'object') {
      next.windowSizes[cwd] = { width: val.size.width, height: val.size.height };
    }
    if (!val.icon) continue;
    const m = /^data:([^;]+);base64,(.+)$/.exec(val.icon);
    if (!m) continue;
    const mime = m[1];
    const ext =
      mime === 'image/png' ? 'png'
      : mime === 'image/jpeg' ? 'jpg'
      : mime === 'image/gif' ? 'gif'
      : mime === 'image/webp' ? 'webp'
      : mime === 'image/svg+xml' ? 'svg'
      : 'png';
    const data = Buffer.from(m[2], 'base64');
    const id = `legacy-${slug(path.basename(cwd) || 'pet')}-${crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 6)}`;
    const dir = path.join(petsDir(), id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `idle.${ext}`), data);
    } catch (e) {
      console.error('claude-pets: legacy migration failed:', e.message);
      continue;
    }
    const dim = detectDimensions(data, ext) || { width: 0, height: 0 };
    next.pets[id] = {
      name: path.basename(cwd) || 'Pet',
      builtin: false,
      states: {
        idle: {
          kind: ext === 'gif' ? 'gif' : 'static',
          file: `idle.${ext}`,
          width: dim.width, height: dim.height,
          frames: 1, fps: 12, loopStart: 0, loopEnd: 0,
          version: 1,
        },
        thinking: null,
        responseNeeded: null,
      },
    };
    next.selections[cwd] = id;
  }
  return next;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'pet';
}

function colorFromName(name) {
  const hash = crypto.createHash('sha1').update(name).digest();
  const hue = Math.round((hash[0] / 255) * 360);
  return `hsl(${hue}, 60%, 65%)`;
}

function nextWindowPosition() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const STEP_Y = 80;
  const COL_WIDTH = 260;
  const TOP = 80;
  const RIGHT = width - WIN_W - 20;
  const rowsPerCol = Math.max(1, Math.floor((height - TOP - WIN_H) / STEP_Y) + 1);
  const slot = sessions.size;
  const col = Math.floor(slot / rowsPerCol);
  const row = slot % rowsPerCol;
  return {
    x: RIGHT - col * COL_WIDTH,
    y: TOP + row * STEP_Y,
  };
}

function createDogWindow(session) {
  const { x, y } = nextWindowPosition();
  const saved = petConfig.windowSizes[session.cwd] || {};
  const win = new BrowserWindow({
    width: Math.max(MIN_W, saved.width || WIN_W),
    height: Math.max(MIN_H, saved.height || WIN_H),
    minWidth: MIN_W,
    minHeight: MIN_H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      additionalArguments: [
        `--session-id=${encodeURIComponent(session.id)}`,
        `--project-name=${encodeURIComponent(session.name)}`,
        `--project-path=${encodeURIComponent(session.cwd)}`,
        `--dog-color=${encodeURIComponent(session.color)}`,
      ],
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');

  let resizeTimer = null;
  win.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const [w, h] = win.getSize();
      petConfig.windowSizes[session.cwd] = { width: w, height: h };
      saveConfig();
    }, 300);
  });
  return win;
}

function makeSession({ cwd, name, pid }) {
  const id = crypto.randomBytes(6).toString('hex');
  const finalName = (name && name.trim()) || path.basename(cwd) || 'untitled';
  const session = {
    id,
    cwd,
    name: finalName,
    color: colorFromName(finalName),
    pid: typeof pid === 'number' ? pid : null,
    queue: [],
    current: null,
    taskCount: 0,
    childAgent: null,
    inbox: [],
    inboxLastSeq: 0,
    inboxWaiters: [],
  };
  session.win = createDogWindow(session);
  sessions.set(id, session);
  return session;
}

function beginTask(session) {
  const shouldContinue = session.taskCount > 0;
  session.taskCount += 1;
  return shouldContinue;
}

function spawnAgent(session, task) {
  const agentScript = path.join(__dirname, 'agent', 'index.mjs');
  const continueFlag = beginTask(session) ? '1' : '';
  const child = spawn(process.execPath, [agentScript, task], {
    cwd: session.cwd,
    env: {
      ...process.env,
      CLAUDE_PETS_BASE: `http://127.0.0.1:${PORT}/sessions/${session.id}`,
      CLAUDE_PETS_CONTINUE: continueFlag,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  session.childAgent = child;
  child.on('exit', () => {
    if (session.childAgent === child) session.childAgent = null;
  });
  return child;
}

function pushToInbox(session, text) {
  const seq = ++session.inboxLastSeq;
  session.inbox.push({ seq, text });
  while (session.inbox.length > 200) session.inbox.shift();
  const waiters = session.inboxWaiters;
  session.inboxWaiters = [];
  for (const w of waiters) deliverInbox(w, session);
}

function deliverInbox(waiter, session) {
  if (waiter.timer) clearTimeout(waiter.timer);
  const messages = session.inbox.filter((m) => m.seq > waiter.since);
  const cursor = session.inboxLastSeq;
  try {
    waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
    waiter.res.end(JSON.stringify({ messages, cursor }));
  } catch {}
}

function deliverNext(session) {
  if (session.current || session.queue.length === 0) return;
  const next = session.queue.shift();
  session.current = next;
  if (session.win && !session.win.isDestroyed()) {
    session.win.webContents.send('approval:request', {
      requestId: next.requestId,
      message: next.message,
      content: next.content,
      options: next.options,
      pendingCount: session.queue.length,
    });
  }
}

function endSession(session, reason) {
  const drain = (entry) => {
    try {
      entry.res.writeHead(503, { 'Content-Type': 'application/json' });
      entry.res.end(JSON.stringify({ choice: 'deny', error: reason || 'session ended' }));
    } catch {}
  };
  if (session.current) drain(session.current);
  session.queue.forEach(drain);
  session.queue = [];
  session.current = null;
  const waiters = session.inboxWaiters || [];
  session.inboxWaiters = [];
  for (const w of waiters) {
    if (w.timer) clearTimeout(w.timer);
    try {
      w.res.writeHead(410, { 'Content-Type': 'application/json' });
      w.res.end(JSON.stringify({ messages: [], cursor: session.inboxLastSeq, ended: true }));
    } catch {}
  }
  if (session.win && !session.win.isDestroyed()) session.win.close();
  sessions.delete(session.id);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ---------- pet helpers ----------

function getPet(petId) {
  return BUILTIN_PETS[petId] || petConfig.pets[petId] || null;
}

function activePetIdForCwd(cwd) {
  const sel = petConfig.selections[cwd];
  if (sel && getPet(sel)) return sel;
  return DEFAULT_PET_ID;
}

function stateView(petId, isBuiltin, state) {
  if (!state) return null;
  let url;
  if (isBuiltin) {
    url = state.builtinSrc;
  } else {
    const v = state.version || 1;
    url = `http://127.0.0.1:${PORT}/pet-files/${encodeURIComponent(petId)}/${encodeURIComponent(state.file)}?v=${v}`;
  }
  const frames = state.frames || 1;
  return {
    url,
    kind: state.kind,
    width: state.width || 0,
    height: state.height || 0,
    frames,
    fps: state.fps || 12,
    loopStart: state.loopStart || 0,
    loopEnd: typeof state.loopEnd === 'number' ? state.loopEnd : Math.max(0, frames - 1),
  };
}

function petView(petId) {
  const def = getPet(petId);
  if (!def) return null;
  const states = {};
  for (const k of STATE_KEYS) states[k] = stateView(petId, !!def.builtin, def.states && def.states[k]);
  return {
    id: petId,
    name: def.name,
    builtin: !!def.builtin,
    states,
  };
}

function libraryView(forCwd) {
  const out = {};
  for (const id of [...Object.keys(BUILTIN_PETS), ...Object.keys(petConfig.pets)]) {
    out[id] = petView(id);
  }
  return {
    activePetId: activePetIdForCwd(forCwd),
    pets: out,
  };
}

function broadcastLibrary() {
  for (const session of sessions.values()) {
    if (session.win && !session.win.isDestroyed()) {
      session.win.webContents.send('pets:changed', libraryView(session.cwd));
    }
  }
}

function ensureUserPet(petId, name) {
  if (BUILTIN_PETS[petId]) throw new Error('cannot modify built-in pet');
  if (!petConfig.pets[petId]) {
    petConfig.pets[petId] = {
      name: name || 'My Pet',
      builtin: false,
      states: { idle: null, thinking: null, responseNeeded: null },
    };
  }
  return petConfig.pets[petId];
}

function newPetId() {
  return `pet-${crypto.randomBytes(4).toString('hex')}`;
}

function detectDimensions(buf, ext) {
  try {
    if (ext === 'png') {
      const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (buf.length >= 24 && buf.slice(0, 8).equals(sig)) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
    } else if (ext === 'gif') {
      if (buf.length >= 10 && buf.slice(0, 3).toString() === 'GIF') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
    } else if (ext === 'webp') {
      if (buf.length >= 30 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
        const fmt = buf.slice(12, 16).toString();
        if (fmt === 'VP8 ') {
          return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        }
        if (fmt === 'VP8L') {
          const b = buf.readUInt32LE(21);
          return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
        }
        if (fmt === 'VP8X') {
          return {
            width: buf.readUIntLE(24, 3) + 1,
            height: buf.readUIntLE(27, 3) + 1,
          };
        }
      }
    }
  } catch {}
  return null;
}

function inferKind(ext, dim) {
  if (ext === 'gif') return 'gif';
  if (!dim || !dim.width || !dim.height) return 'static';
  return dim.width / dim.height > 1.2 ? 'sprite-sheet' : 'static';
}

function inferFrames(dim) {
  if (!dim || !dim.height || !dim.width) return 1;
  return Math.max(1, Math.round(dim.width / dim.height));
}

function startServer() {
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      try {
        // ----- pet file serving -----
        const petFileMatch = url.pathname.match(/^\/pet-files\/([^/]+)\/([^/]+)$/);
        if (req.method === 'GET' && petFileMatch) {
          const petId = decodeURIComponent(petFileMatch[1]);
          const fileName = decodeURIComponent(petFileMatch[2]);
          if (BUILTIN_PETS[petId] || !petConfig.pets[petId]) {
            res.writeHead(404); res.end(); return;
          }
          if (fileName.includes('..') || fileName.includes('/')) {
            res.writeHead(400); res.end(); return;
          }
          const filePath = path.join(petsDir(), petId, fileName);
          fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end(); return; }
            const ext = path.extname(fileName).slice(1).toLowerCase();
            const mime =
              ext === 'png' ? 'image/png'
              : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
              : ext === 'gif' ? 'image/gif'
              : ext === 'webp' ? 'image/webp'
              : ext === 'svg' ? 'image/svg+xml'
              : 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
            res.end(data);
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/sessions') {
          const { cwd, name, pid } = await readJson(req);
          if (!cwd || typeof cwd !== 'string') {
            res.writeHead(400); res.end('cwd required'); return;
          }
          const session = makeSession({ cwd, name, pid });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessionId: session.id, color: session.color, name: session.name }));
          return;
        }

        const m = url.pathname.match(/^\/sessions\/([^/]+)(\/.*)?$/);
        if (m) {
          const session = sessions.get(m[1]);
          const sub = m[2] || '';
          if (!session) { res.writeHead(404); res.end('no session'); return; }

          if (req.method === 'POST' && sub === '/approve') {
            const { message, content, options } = await readJson(req);
            const requestId = crypto.randomBytes(4).toString('hex');
            session.queue.push({
              requestId,
              message: message || 'needs approval',
              content: content || '',
              options: Array.isArray(options) && options.length
                ? options
                : [
                    { id: 'allow', label: '1. Yes' },
                    { id: 'deny', label: '2. No' },
                  ],
              res,
            });
            deliverNext(session);
            return;
          }

          if (req.method === 'POST' && sub === '/begin-task') {
            const shouldContinue = beginTask(session);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ shouldContinue }));
            return;
          }

          if (req.method === 'POST' && sub === '/inbox') {
            const { text } = await readJson(req);
            const trimmed = String(text || '').trim();
            if (!trimmed) { res.writeHead(400); res.end('text required'); return; }
            pushToInbox(session, trimmed);
            res.writeHead(204); res.end();
            return;
          }

          if (req.method === 'GET' && sub === '/inbox') {
            const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
            const timeoutSec = Math.min(60, Math.max(1, parseInt(url.searchParams.get('timeout') || '30', 10) || 30));
            const pending = session.inbox.filter((mm) => mm.seq > since);
            if (pending.length > 0) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ messages: pending, cursor: session.inboxLastSeq }));
              return;
            }
            const waiter = { since, res };
            waiter.timer = setTimeout(() => {
              const idx = session.inboxWaiters.indexOf(waiter);
              if (idx >= 0) session.inboxWaiters.splice(idx, 1);
              try {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ messages: [], cursor: session.inboxLastSeq }));
              } catch {}
            }, timeoutSec * 1000);
            req.on('close', () => {
              if (waiter.timer) clearTimeout(waiter.timer);
              const idx = session.inboxWaiters.indexOf(waiter);
              if (idx >= 0) session.inboxWaiters.splice(idx, 1);
            });
            session.inboxWaiters.push(waiter);
            return;
          }

          if (req.method === 'POST' && sub === '/event') {
            const event = await readJson(req);
            if (session.win && !session.win.isDestroyed()) {
              session.win.webContents.send('pet:event', event);
            }
            res.writeHead(204); res.end();
            return;
          }

          if (req.method === 'DELETE' && sub === '') {
            endSession(session, 'session ended');
            res.writeHead(204); res.end();
            return;
          }
        }

        res.writeHead(404);
        res.end();
      } catch (e) {
        res.writeHead(400);
        res.end(`bad request: ${e.message}`);
      }
    })
    .listen(PORT, '127.0.0.1', () => {
      console.log(`claude-pets daemon ready on http://127.0.0.1:${PORT}`);
      console.log(`run \`claude-pets "<task>"\` from any project folder to spawn a pet.`);
    });
}

ipcMain.on('approval:response', (_evt, { sessionId, requestId, choice, feedback }) => {
  const session = sessions.get(sessionId);
  if (!session || !session.current || session.current.requestId !== requestId) return;
  const { res } = session.current;
  session.current = null;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choice, feedback: feedback || '' }));
  deliverNext(session);
});

ipcMain.on('pet:reply', (_evt, { sessionId, text }) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  pushToInbox(session, trimmed);
});

// ---------- pets:* IPC ----------

ipcMain.handle('pets:list', (_evt, { sessionId }) => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return libraryView(session.cwd);
});

ipcMain.handle('pets:select', (_evt, { sessionId, petId }) => {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (!getPet(petId)) return false;
  petConfig.selections[session.cwd] = petId;
  saveConfig();
  broadcastLibrary();
  return true;
});

ipcMain.handle('pets:create', (_evt, { sessionId, name }) => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const id = newPetId();
  ensureUserPet(id, (name && name.trim()) || 'My Pet');
  petConfig.selections[session.cwd] = id;
  saveConfig();
  broadcastLibrary();
  return id;
});

ipcMain.handle('pets:rename', (_evt, { petId, name }) => {
  if (BUILTIN_PETS[petId]) return false;
  const pet = petConfig.pets[petId];
  if (!pet) return false;
  pet.name = String(name || '').trim() || pet.name;
  saveConfig();
  broadcastLibrary();
  return true;
});

ipcMain.handle('pets:remove', (_evt, { petId }) => {
  if (BUILTIN_PETS[petId]) return false;
  const pet = petConfig.pets[petId];
  if (!pet) return false;
  try { fs.rmSync(path.join(petsDir(), petId), { recursive: true, force: true }); } catch {}
  delete petConfig.pets[petId];
  for (const [cwd, id] of Object.entries(petConfig.selections)) {
    if (id === petId) delete petConfig.selections[cwd];
  }
  saveConfig();
  broadcastLibrary();
  return true;
});

ipcMain.handle('pets:upload-state', async (_evt, { sessionId, petId, stateKey }) => {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'no session' };
  if (!STATE_KEYS.includes(stateKey)) return { error: 'bad state' };

  const result = await dialog.showOpenDialog(session.win, {
    title: `Pick a sprite for ${stateKey}`,
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const sourcePath = result.filePaths[0];
  let buf;
  try {
    buf = fs.readFileSync(sourcePath);
  } catch (e) {
    return { error: `could not read file: ${e.message}` };
  }
  if (buf.length > 20 * 1024 * 1024) {
    return { error: 'image is over 20 MB — pick something smaller' };
  }
  const ext = path.extname(sourcePath).slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return { error: 'unsupported file type' };
  }

  // If targeting a built-in or no pet, fork a fresh user pet.
  let resolvedId = petId;
  if (!resolvedId || BUILTIN_PETS[resolvedId]) {
    resolvedId = newPetId();
  }
  ensureUserPet(resolvedId, petConfig.pets[resolvedId]?.name || 'My Pet');

  const dir = path.join(petsDir(), resolvedId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const pet = petConfig.pets[resolvedId];
  const old = pet.states[stateKey];
  if (old && old.file && old.file !== `${stateKey}.${ext}`) {
    try { fs.unlinkSync(path.join(dir, old.file)); } catch {}
  }

  const fileName = `${stateKey}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buf);

  const dim = detectDimensions(buf, ext) || { width: 0, height: 0 };
  const kind = inferKind(ext, dim);
  const frames = kind === 'sprite-sheet' ? inferFrames(dim) : 1;
  const fps = 12;

  pet.states[stateKey] = {
    kind,
    file: fileName,
    width: dim.width, height: dim.height,
    frames, fps,
    loopStart: 0,
    loopEnd: Math.max(0, frames - 1),
    version: ((old && old.version) || 0) + 1,
  };

  petConfig.selections[session.cwd] = resolvedId;

  saveConfig();
  broadcastLibrary();
  return { petId: resolvedId, stateKey };
});

ipcMain.handle('pets:remove-state', (_evt, { petId, stateKey }) => {
  if (BUILTIN_PETS[petId]) return false;
  const pet = petConfig.pets[petId];
  if (!pet || !STATE_KEYS.includes(stateKey)) return false;
  const cur = pet.states[stateKey];
  if (cur && cur.file) {
    try { fs.unlinkSync(path.join(petsDir(), petId, cur.file)); } catch {}
  }
  pet.states[stateKey] = null;
  saveConfig();
  broadcastLibrary();
  return true;
});

ipcMain.handle('pets:set-anim', (_evt, { petId, stateKey, frames, fps, loopStart, loopEnd }) => {
  if (BUILTIN_PETS[petId]) return false;
  const pet = petConfig.pets[petId];
  if (!pet || !STATE_KEYS.includes(stateKey)) return false;
  const cur = pet.states[stateKey];
  if (!cur) return false;
  if (typeof frames === 'number' && frames > 0) cur.frames = Math.floor(frames);
  if (typeof fps === 'number' && fps > 0) cur.fps = fps;
  if (typeof loopStart === 'number') cur.loopStart = Math.max(0, Math.floor(loopStart));
  if (typeof loopEnd === 'number') cur.loopEnd = Math.max(cur.loopStart, Math.floor(loopEnd));
  if (cur.loopEnd >= cur.frames) cur.loopEnd = Math.max(0, cur.frames - 1);
  saveConfig();
  broadcastLibrary();
  return true;
});

function sweepOrphans() {
  for (const session of [...sessions.values()]) {
    if (!session.pid) continue;
    try {
      process.kill(session.pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') {
        endSession(session, 'owner process exited');
      }
    }
  }
}

app.whenReady().then(() => {
  loadConfig();
  startServer();
  setInterval(sweepOrphans, SWEEP_INTERVAL_MS);
});

app.on('window-all-closed', () => {
  // Stay alive as a daemon. Quit only on explicit Cmd-Q.
});
