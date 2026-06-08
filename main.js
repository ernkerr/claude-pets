const { app, BrowserWindow, ipcMain, screen, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const PORT = 47777;
const SWEEP_INTERVAL_MS = 1500;
const WIN_W = 280;
const WIN_H = 540;
const MAX_ICON_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const WINDOW_SIZES_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.claude-pets',
  'window-sizes.json',
);
const TOKEN_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.claude-pets',
  'daemon-token',
);

function loadOrCreateDaemonToken() {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {} // file missing or unreadable — generate fresh
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

let DAEMON_TOKEN = null;

function checkAuth(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return false;
  const got = Buffer.from(auth.slice(7));
  const want = Buffer.from(DAEMON_TOKEN);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function loadWindowSizes() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_SIZES_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function loadWindowSize(key, defaults) {
  const sizes = loadWindowSizes();
  return sizes[key] || defaults;
}

function saveWindowSize(key, size) {
  try {
    const sizes = loadWindowSizes();
    sizes[key] = size;
    fs.mkdirSync(path.dirname(WINDOW_SIZES_FILE), { recursive: true });
    fs.writeFileSync(WINDOW_SIZES_FILE, JSON.stringify(sizes));
  } catch {}
}

const MIME_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

// sessionId -> { id, cwd, name, color, pid, win, queue, current }
const sessions = new Map();

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
  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
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
    inbox: [],
    inboxLastSeq: 0,
    inboxWaiters: [],
    sessionAllowed: new Set(),
  };
  session.win = createDogWindow(session);
  sessions.set(id, session);
  return session;
}

function pushToInbox(session, text) {
  const seq = ++session.inboxLastSeq;
  session.inbox.push({ seq, text });
  // Cap history so memory doesn't grow unbounded.
  while (session.inbox.length > 200) session.inbox.shift();
  // Wake any long-poll waiters.
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
  } catch {} // response may already be closed
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
      diffData: next.diffData || null,
      summary: next.summary || '',
    });
  }
}

function endSession(session, reason) {
  const drain = (entry) => {
    try {
      entry.res.writeHead(503, { 'Content-Type': 'application/json' });
      entry.res.end(JSON.stringify({ choice: 'deny', error: reason || 'session ended' }));
    } catch {} // response may already be closed
  };
  if (session.current) drain(session.current);
  session.queue.forEach(drain);
  session.queue = [];
  session.current = null;
  // End any inbox long-polls so the CLI side unblocks.
  const waiters = session.inboxWaiters || [];
  session.inboxWaiters = [];
  for (const w of waiters) {
    if (w.timer) clearTimeout(w.timer);
    try {
      w.res.writeHead(410, { 'Content-Type': 'application/json' });
      w.res.end(JSON.stringify({ messages: [], cursor: session.inboxLastSeq, ended: true }));
    } catch {} // response may already be closed
  }
  if (session.expandWin && !session.expandWin.isDestroyed()) session.expandWin.close();
  if (session.win && !session.win.isDestroyed()) session.win.close();
  sessions.delete(session.id);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
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

function startServer() {
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      try {
        if (!checkAuth(req)) {
          res.writeHead(401);
          res.end();
          return;
        }

        if (req.method === 'POST' && url.pathname === '/sessions') {
          const { cwd, name, pid } = await readJson(req);
          if (!cwd || typeof cwd !== 'string') {
            res.writeHead(400);
            res.end('cwd required');
            return;
          }
          const session = makeSession({ cwd, name, pid });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              sessionId: session.id,
              color: session.color,
              name: session.name,
            })
          );
          return;
        }

        if (req.method === 'GET' && url.pathname === '/sessions/count') {
          const cwd = url.searchParams.get('cwd');
          let count = 0;
          for (const s of sessions.values()) {
            if (s.cwd === cwd) count++;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ count }));
          return;
        }

        const pathMatch = url.pathname.match(/^\/sessions\/([^/]+)(\/.*)?$/);
        if (pathMatch) {
          const session = sessions.get(pathMatch[1]);
          const subpath = pathMatch[2] || '';
          if (!session) {
            res.writeHead(404);
            res.end('no session');
            return;
          }

          if (req.method === 'POST' && subpath === '/approve') {
            const { message, content, options, toolName, diffData, summary } = await readJson(req);
            if (toolName && session.sessionAllowed.has(toolName)) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ choice: 'allow' }));
              return;
            }
            const requestId = crypto.randomBytes(4).toString('hex');
            session.queue.push({
              requestId,
              toolName: toolName || '',
              message: message || 'needs approval',
              content: content || '',
              options: Array.isArray(options) && options.length
                ? options
                : [
                    { id: 'allow', label: '1. Yes' },
                    { id: 'deny', label: '2. No' },
                  ],
              diffData: diffData || null,
              summary: summary || '',
              res,
            });
            deliverNext(session);
            return;
          }

          if (req.method === 'POST' && subpath === '/inbox') {
            const { text } = await readJson(req);
            const trimmed = String(text || '').trim();
            if (!trimmed) {
              res.writeHead(400);
              res.end('text required');
              return;
            }
            pushToInbox(session, trimmed);
            res.writeHead(204);
            res.end();
            return;
          }

          if (req.method === 'GET' && subpath === '/inbox') {
            const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
            const timeoutSec = Math.min(60, Math.max(1, parseInt(url.searchParams.get('timeout') || '30', 10) || 30));
            const pending = session.inbox.filter((m) => m.seq > since);
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
              } catch {} // response may already be closed
            }, timeoutSec * 1000);
            req.on('close', () => {
              if (waiter.timer) clearTimeout(waiter.timer);
              const idx = session.inboxWaiters.indexOf(waiter);
              if (idx >= 0) session.inboxWaiters.splice(idx, 1);
            });
            session.inboxWaiters.push(waiter);
            return;
          }

          if (req.method === 'POST' && subpath === '/event') {
            const event = await readJson(req);
            if (session.win && !session.win.isDestroyed()) {
              session.win.webContents.send('pet:event', event);
            }
            res.writeHead(204);
            res.end();
            return;
          }

          if (req.method === 'DELETE' && subpath === '') {
            endSession(session, 'session ended');
            res.writeHead(204);
            res.end();
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
  const { res, toolName } = session.current;
  if (choice === 'allow_session' && toolName) {
    session.sessionAllowed.add(toolName);
  }
  const effectiveChoice = choice === 'allow_session' ? 'allow' : choice;
  session.current = null;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choice: effectiveChoice, feedback: feedback || '' }));
  deliverNext(session);
});

ipcMain.handle('icon:get', () => null);
ipcMain.handle('icon:upload', () => null);

ipcMain.on('pet:reply', (_evt, { sessionId, text }) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  pushToInbox(session, trimmed);
});

ipcMain.handle('icon:reset', () => true);

ipcMain.on('session:exit', (_evt, { sessionId }) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  endSession(session, 'exited from pet settings');
});

ipcMain.on('window:resize', (_evt, { sessionId, width, height }) => {
  const session = sessions.get(sessionId);
  if (!session || !session.win || session.win.isDestroyed()) return;
  session.win.setSize(width, height, true);
});

ipcMain.on('window:set-position', (_evt, { sessionId, x, y }) => {
  const session = sessions.get(sessionId);
  if (!session || !session.win || session.win.isDestroyed()) return;
  session.win.setPosition(Math.round(x), Math.round(y));
});

ipcMain.on('window:set-always-on-top', (_evt, { sessionId, onTop }) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.alwaysOnTop = onTop;
  if (session.win && !session.win.isDestroyed()) {
    if (onTop) {
      session.win.setAlwaysOnTop(true, 'floating');
      session.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
      session.win.setAlwaysOnTop(false);
      // Without this, the window keeps floating over other Spaces and fullscreen apps
      // even after the user toggles "Stay on top" off.
      session.win.setVisibleOnAllWorkspaces(false);
    }
  }
  if (session.expandWin && !session.expandWin.isDestroyed()) {
    if (onTop) session.expandWin.setAlwaysOnTop(true, 'floating', 1);
    else session.expandWin.setAlwaysOnTop(false);
  }
});

ipcMain.on('diff:show', (_evt, { sessionId, diffData, title }) => {
  const session = sessions.get(sessionId);
  if (!session || !session.win || session.win.isDestroyed()) return;
  const parentBounds = session.win.getBounds();
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let body = '';
  if (diffData.type === 'edit') {
    if (diffData.oldString) {
      body += `<div class="label">REMOVING</div><pre class="block remove">${esc(diffData.oldString)}</pre>`;
    }
    if (diffData.newString) {
      const word = diffData.oldString ? 'REPLACING WITH' : 'INSERTING';
      body += `<div class="label">${word}</div><pre class="block add">${esc(diffData.newString)}</pre>`;
    }
  } else if (diffData.type === 'write') {
    body += `<div class="label">CONTENT</div><pre class="block write">${esc(diffData.writeContent)}</pre>`;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; padding:16px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; background:#faf9f6; color:#2c2a26; }
    .title { font-family:-apple-system,system-ui,sans-serif; font-size:13px; font-weight:600; margin-bottom:12px; color:#2c2a26; }
    .label { font-size:10px; font-weight:600; color:#7a766b; text-transform:uppercase; letter-spacing:0.5px; margin:12px 0 4px; }
    .label:first-child { margin-top:0; }
    .block { margin:0 0 8px; padding:10px 12px; border-radius:6px; font-size:13px; line-height:1.5; white-space:pre-wrap; word-break:break-all; border:1px solid #e8e5dd; }
    .remove { background:#fdecea; color:#922c20; border-color:#f5c6c2; }
    .add { background:#e6f4ea; color:#1e7e34; border-color:#b7e1c4; }
    .write { background:#f3f1ec; color:#2c2a26; }
  </style></head><body><div class="title">${esc(title)}</div>${body}</body></html>`;
  const diffWin = new BrowserWindow({
    width: 480,
    height: 400,
    x: parentBounds.x - 240,
    y: parentBounds.y + 40,
    frame: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true },
  });
  diffWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});

// --- Expand window IPC ---

ipcMain.on('expand:open', (_evt, { sessionId, text }) => {
  const session = sessions.get(sessionId);
  if (!session || !session.win || session.win.isDestroyed()) return;

  if (session.expandWin && !session.expandWin.isDestroyed()) {
    session.expandWin.webContents.send('expand:update', { text });
    session.expandWin.focus();
    return;
  }

  const parentBounds = session.win.getBounds();
  const { width, height } = loadWindowSize('expand', { width: 520, height: 460 });

  const onTop = session.alwaysOnTop !== false;
  const expandWin = new BrowserWindow({
    width,
    height,
    x: parentBounds.x - Math.round(width / 2),
    y: parentBounds.y + 40,
    frame: true,
    transparent: false,
    resizable: true,
    alwaysOnTop: onTop,
    title: `${session.name} — message`,
    webPreferences: {
      preload: path.join(__dirname, 'expand-preload.js'),
      contextIsolation: true,
    },
  });

  if (onTop) expandWin.setAlwaysOnTop(true, 'floating', 1);
  session.expandWin = expandWin;
  expandWin.loadFile('expand.html');

  expandWin.webContents.once('did-finish-load', () => {
    expandWin.webContents.send('expand:update', { text });
  });

  expandWin.on('close', () => {
    const bounds = expandWin.getBounds();
    saveWindowSize('expand', { width: bounds.width, height: bounds.height });
  });

  expandWin.on('closed', () => {
    if (session.expandWin === expandWin) session.expandWin = null;
    if (session.win && !session.win.isDestroyed()) {
      session.win.webContents.send('expand:closed');
    }
  });
});

ipcMain.on('expand:update', (_evt, { sessionId, text }) => {
  const session = sessions.get(sessionId);
  if (!session || !session.expandWin || session.expandWin.isDestroyed()) return;
  session.expandWin.webContents.send('expand:update', { text });
});

ipcMain.on('expand:close', (_evt, { sessionId }) => {
  const session = sessions.get(sessionId);
  if (!session || !session.expandWin || session.expandWin.isDestroyed()) return;
  session.expandWin.close();
});

// --- Pet store IPC ---
let petStore = null;
async function getPetStore() {
  if (!petStore) petStore = await import('./lib/pet-store.mjs');
  return petStore;
}

ipcMain.handle('pets:list', async () => {
  const ps = await getPetStore();
  return ps.listPetsResolved();
});

ipcMain.handle('pets:getActive', async () => {
  const ps = await getPetStore();
  return ps.getActivePetResolved();
});

ipcMain.on('pets:setActive', async (_evt, { petId }) => {
  const ps = await getPetStore();
  ps.setActivePetId(petId);
});

ipcMain.handle('pets:addEmpty', async (_evt, { name: petName }) => {
  const ps = await getPetStore();
  const pet = ps.addPet(petName || 'New Pet', null);
  return ps.resolvePet(pet);
});

ipcMain.handle('pets:rename', async (_evt, { petId, name }) => {
  const ps = await getPetStore();
  return ps.renamePet(petId, name);
});

ipcMain.handle('pets:uploadState', async (_evt, { sessionId, petId, stateName }) => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const result = await dialog.showOpenDialog(session.win, {
    title: `Choose image for ${stateName} state`,
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  try {
    if (fs.statSync(filePath).size > MAX_ICON_SIZE_BYTES) {
      return { error: 'image is over 5 MB — pick something smaller' };
    }
  } catch (e) {
    return { error: `could not read file: ${e.message}` };
  }
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const ps = await getPetStore();
  const savedPath = ps.savePetImage(buf, ext);
  const pet = ps.updatePetState(petId, stateName, savedPath);
  if (!pet) return null;
  return ps.resolvePet(pet);
});

ipcMain.handle('pets:dropState', async (_evt, { petId, stateName, filePath }) => {
  if (!filePath) return null;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const allowed = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  if (!allowed.includes(ext)) return { error: 'unsupported image format' };
  try {
    if (fs.statSync(filePath).size > MAX_ICON_SIZE_BYTES) {
      return { error: 'image is over 5 MB' };
    }
  } catch (e) {
    return { error: `could not read file: ${e.message}` };
  }
  const buf = fs.readFileSync(filePath);
  const ps = await getPetStore();
  const savedPath = ps.savePetImage(buf, ext);
  const pet = ps.updatePetState(petId, stateName, savedPath);
  if (!pet) return null;
  return ps.resolvePet(pet);
});

ipcMain.handle('pets:swapStates', async (_evt, { petId, fromState, toState }) => {
  const ps = await getPetStore();
  return ps.swapStates(petId, fromState, toState);
});

ipcMain.handle('pets:removeState', async (_evt, { petId, stateName }) => {
  const ps = await getPetStore();
  const pet = ps.removeStateImage(petId, stateName);
  if (!pet) return null;
  return ps.resolvePet(pet);
});

ipcMain.handle('pets:reorder', async (_evt, { fromId, toId }) => {
  const ps = await getPetStore();
  return ps.reorderPet(fromId, toId);
});

ipcMain.handle('pets:delete', async (_evt, { petId }) => {
  const ps = await getPetStore();
  return ps.deletePet(petId);
});

ipcMain.handle('shell:openExternal', (_evt, { url }) => {
  if (
    url.startsWith('https://github.com/') ||
    url.startsWith('https://buymeacoffee.com/') ||
    url.startsWith('https://erinkerr.me/')
  ) {
    shell.openExternal(url);
  }
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
      // EPERM = process exists but signaling not allowed — treat as alive
    }
  }
}

app.whenReady().then(() => {
  DAEMON_TOKEN = loadOrCreateDaemonToken();
  startServer();
  setInterval(sweepOrphans, SWEEP_INTERVAL_MS);
});

app.on('window-all-closed', () => {
  // Stay alive as a daemon. Quit only on explicit Cmd-Q.
});
