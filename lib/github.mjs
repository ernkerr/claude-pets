// GitHub Device Flow OAuth + API helpers for contributing pets.

import fs from 'fs';
import path from 'path';
import https from 'https';

const PLACEHOLDER_CLIENT_ID = 'Ov23liYourClientIdHere';
const CLIENT_ID = process.env.CLAUDE_PETS_GITHUB_CLIENT_ID || PLACEHOLDER_CLIENT_ID;
const UPSTREAM_REPO = 'ernkerr/claude-pets';
const TOKEN_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.claude-pets',
  'github-token',
);

// --- HTTP helpers ---

function request(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'User-Agent': 'claude-pets',
        Accept: 'application/json',
        ...headers,
      },
    };
    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        if (res.statusCode >= 400) {
          const msg = json?.message || text.slice(0, 200);
          reject(new Error(`GitHub API ${res.statusCode}: ${msg}`));
        } else {
          resolve(json || text);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function apiGet(path, token) {
  return request('GET', `https://api.github.com${path}`, null, {
    Authorization: `Bearer ${token}`,
  });
}

function apiPost(path, body, token) {
  return request('POST', `https://api.github.com${path}`, body, {
    Authorization: `Bearer ${token}`,
  });
}

function apiPut(path, body, token) {
  return request('PUT', `https://api.github.com${path}`, body, {
    Authorization: `Bearer ${token}`,
  });
}

// --- Token storage ---

let encrypt = null;
let decrypt = null;

export function setEncryption(encryptFn, decryptFn) {
  encrypt = encryptFn;
  decrypt = decryptFn;
}

export function loadToken() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE);
    if (decrypt) {
      try {
        return decrypt(raw).trim() || null;
      } catch {
        // Fallback: file may be plaintext from before encryption was enabled
        return raw.toString('utf-8').trim() || null;
      }
    }
    return raw.toString('utf-8').trim() || null;
  } catch {
    return null;
  }
}

export function saveToken(token) {
  const dir = path.dirname(TOKEN_FILE);
  fs.mkdirSync(dir, { recursive: true });
  if (encrypt) {
    fs.writeFileSync(TOKEN_FILE, encrypt(token), { mode: 0o600 });
  } else {
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  }
}

export function clearToken() {
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
}

export function isOAuthConfigured() {
  return CLIENT_ID !== PLACEHOLDER_CLIENT_ID;
}

// --- Device Flow OAuth ---

export async function startDeviceFlow() {
  const res = await request(
    'POST',
    'https://github.com/login/device/code',
    `client_id=${CLIENT_ID}&scope=public_repo`,
    { 'Content-Type': 'application/x-www-form-urlencoded' },
  );
  return {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUri: res.verification_uri,
    expiresIn: res.expires_in,
    interval: res.interval || 5,
  };
}

export function pollForToken(deviceCode, interval) {
  let cancelled = false;
  const cancel = () => { cancelled = true; };

  const promise = new Promise((resolve, reject) => {
    const poll = async () => {
      if (cancelled) return reject(new Error('cancelled'));
      try {
        const res = await request(
          'POST',
          'https://github.com/login/oauth/access_token',
          `client_id=${CLIENT_ID}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
          { 'Content-Type': 'application/x-www-form-urlencoded' },
        );
        if (res.access_token) {
          saveToken(res.access_token);
          resolve(res.access_token);
        } else if (res.error === 'authorization_pending' || res.error === 'slow_down') {
          const wait = res.error === 'slow_down' ? (interval + 5) * 1000 : interval * 1000;
          setTimeout(poll, wait);
        } else {
          reject(new Error(res.error_description || res.error || 'Auth failed'));
        }
      } catch (err) {
        reject(err);
      }
    };
    setTimeout(poll, interval * 1000);
  });

  return { promise, cancel };
}

// --- GitHub API operations ---

export async function getUser(token) {
  return apiGet('/user', token);
}

export async function validateToken(token) {
  try {
    const user = await getUser(token);
    return { valid: true, username: user.login };
  } catch {
    return { valid: false, username: null };
  }
}

export async function forkRepo(token) {
  try {
    const fork = await apiPost(`/repos/${UPSTREAM_REPO}/forks`, {}, token);
    return fork.full_name;
  } catch (err) {
    // 202 Accepted or already exists — either way, get the fork name
    if (err.message.includes('202')) {
      const user = await getUser(token);
      return `${user.login}/claude-pets`;
    }
    throw err;
  }
}

export async function getDefaultBranchSha(forkFullName, token) {
  const ref = await apiGet(`/repos/${forkFullName}/git/ref/heads/main`, token);
  return ref.object.sha;
}

export async function createBranch(forkFullName, branchName, sha, token) {
  return apiPost(`/repos/${forkFullName}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha,
  }, token);
}

export async function uploadFile(forkFullName, branchName, filePath, contentBase64, commitMsg, token) {
  return apiPut(`/repos/${forkFullName}/contents/${filePath}`, {
    message: commitMsg,
    content: contentBase64,
    branch: branchName,
  }, token);
}

export async function createPR(head, title, body, token) {
  return apiPost(`/repos/${UPSTREAM_REPO}/pulls`, {
    title,
    body,
    head,
    base: 'main',
  }, token);
}
