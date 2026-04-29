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

// sessionId -> { id, cwd, name, color, pid, win, queue, current }
const sessions = new Map();

// Persistent per-project config: { [projectCwd]: { icon: dataUrl } }
let petConfig = {};
let configPath = '';

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'pets-config.json');
  try {
    petConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    petConfig = {};
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(petConfig, null, 2));
  } catch (e) {
    console.error('claude-pets: failed to save config:', e.message);
  }
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
  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
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
  // End any inbox long-polls so the CLI side unblocks.
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

function startServer() {
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      try {
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

        const m = url.pathname.match(/^\/sessions\/([^/]+)(\/.*)?$/);
        if (m) {
          const session = sessions.get(m[1]);
          const sub = m[2] || '';
          if (!session) {
            res.writeHead(404);
            res.end('no session');
            return;
          }

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

          if (req.method === 'GET' && sub === '/inbox') {
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
            res.writeHead(204);
            res.end();
            return;
          }

          if (req.method === 'DELETE' && sub === '') {
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
  const { res } = session.current;
  session.current = null;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choice, feedback: feedback || '' }));
  deliverNext(session);
});

ipcMain.handle('icon:get', (_evt, { sessionId }) => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return petConfig[session.cwd]?.icon || null;
});

ipcMain.handle('icon:upload', async (_evt, { sessionId }) => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const result = await dialog.showOpenDialog(session.win, {
    title: `Pick an icon for ${session.name}`,
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return { error: `could not read file: ${e.message}` };
  }
  if (buf.length > 5 * 1024 * 1024) {
    return { error: 'image is over 5 MB — pick something smaller' };
  }
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime =
    ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'png' ? 'image/png'
    : ext === 'gif' ? 'image/gif'
    : ext === 'webp' ? 'image/webp'
    : ext === 'svg' ? 'image/svg+xml'
    : 'application/octet-stream';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  petConfig[session.cwd] = { ...(petConfig[session.cwd] || {}), icon: dataUrl };
  saveConfig();
  return { icon: dataUrl };
});

ipcMain.on('pet:reply', (_evt, { sessionId, text }) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  pushToInbox(session, trimmed);
});

ipcMain.handle('icon:reset', (_evt, { sessionId }) => {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (petConfig[session.cwd]) {
    delete petConfig[session.cwd].icon;
    if (Object.keys(petConfig[session.cwd]).length === 0) {
      delete petConfig[session.cwd];
    }
    saveConfig();
  }
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
      // EPERM = process exists but signaling not allowed — treat as alive
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
