const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const ptyManager = require('./ptyManager');
const { runSetup } = require('./setup');

// ── Config ────────────────────────────────────────────────────────────────────

function resolveConfigPath() {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf('--config');
  if (flagIdx !== -1 && args[flagIdx + 1]) return args[flagIdx + 1];
  if (args[0] && !args[0].startsWith('--')) return args[0];
  return path.join(__dirname, 'config.json');
}

function applyEnvOverrides(cfg) {
  const managedOnlyEnv = process.env.MANAGED_ONLY;
  return {
    ...cfg,
    hubUrl:      (process.env.HUB_URL      || cfg.hubUrl   || '').replace(/\/$/, ''),
    username:    process.env.AGENT_USERNAME || cfg.username,
    password:    process.env.AGENT_PASSWORD || cfg.password,
    managedOnly: managedOnlyEnv !== undefined
      ? managedOnlyEnv === 'true' || managedOnlyEnv === '1'
      : (cfg.managedOnly ?? false),
  };
}

let config;

// ── Binary frame helpers (must match hub/router.js) ───────────────────────────

const CHANNEL_ID_BYTES = 16;

function encodeChannelId(id) {
  const buf = Buffer.alloc(CHANNEL_ID_BYTES, 0);
  buf.write(id, 0, 'ascii');
  return buf;
}

function decodeChannelId(buf) {
  return buf.slice(0, CHANNEL_ID_BYTES).toString('ascii').replace(/\0+$/, '');
}

// ── State ─────────────────────────────────────────────────────────────────────

// channelId → { pty, sessionName }
const channels = new Map();

let ws = null;
let reconnectDelay = 1000;

// ── Hub HTTP calls ─────────────────────────────────────────────────────────────

async function registerWithHub() {
  const res = await fetch(`${config.hubUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  if (res.ok) {
    console.log(`Registered account "${config.username}" on Hub.`);
  } else if (res.status === 409) {
    // Account already exists — normal on subsequent starts
  } else {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Register failed (${res.status}): ${body.error || res.statusText}`);
  }
}

async function loginToHub() {
  const res = await fetch(`${config.hubUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Login failed (${res.status}): ${body.error || res.statusText}`);
  }
  const { token } = await res.json();
  return token;
}

function buildWsUrl(token) {
  const u = new URL(config.hubUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/agent-ws';
  u.searchParams.set('token', token);
  return u.toString();
}

// ── Send helpers ───────────────────────────────────────────────────────────────

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendBinary(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
}

function reply(requestId, payload) {
  send({ type: 'result', requestId, ...payload });
}

function sendSessions() {
  send({ type: 'sessions', list: ptyManager.listSessions(config.managedOnly) });
}

// ── Message handlers ───────────────────────────────────────────────────────────

function handleAttach(msg) {
  const { requestId, channelId, sessionName, cols, rows } = msg;

  if (config.managedOnly && !ptyManager.isManaged(sessionName)) {
    reply(requestId, { ok: false, error: 'Session not managed by webmux' });
    return;
  }

  const p = ptyManager.attachPty(
    sessionName,
    data => {
      // PTY output → prepend channelId and send as binary
      const idBuf = encodeChannelId(channelId);
      const payload = Buffer.from(data);
      sendBinary(Buffer.concat([idBuf, payload]));
    },
    () => {
      // PTY exited
      channels.delete(channelId);
      send({ type: 'pty-exited', channelId });
    },
    cols,
    rows
  );

  if (!p) {
    reply(requestId, { ok: false, error: 'Session not found' });
    return;
  }

  channels.set(channelId, { pty: p, sessionName });
  reply(requestId, { ok: true });
}

function handleResize(msg) {
  const { channelId, cols, rows } = msg;
  const ch = channels.get(channelId);
  if (!ch) return;
  ptyManager.resizePty(ch.pty, ch.sessionName, cols, rows);
}

function handleDetach(msg) {
  const ch = channels.get(msg.channelId);
  if (!ch) return;
  try { ch.pty.kill(); } catch {}
  channels.delete(msg.channelId);
}

function handleCreateSession(msg) {
  try {
    ptyManager.createSession(msg.name);
    reply(msg.requestId, { ok: true });
  } catch (e) {
    reply(msg.requestId, { ok: false, error: e.message });
  }
}

function handleRenameSession(msg) {
  try {
    ptyManager.renameSession(msg.name, msg.newName);
    reply(msg.requestId, { ok: true });
  } catch (e) {
    reply(msg.requestId, { ok: false, error: e.message });
  }
}

function handleKillSession(msg) {
  try {
    ptyManager.killSession(msg.name);
    reply(msg.requestId, { ok: true });
  } catch (e) {
    reply(msg.requestId, { ok: false, error: e.message });
  }
}

function handleGetCwd(msg) {
  const cwd = ptyManager.getSessionCwd(msg.session);
  if (!cwd) {
    reply(msg.requestId, { ok: false, error: 'Cannot get cwd' });
    return;
  }
  reply(msg.requestId, { ok: true, cwd });
}

function handleLs(msg) {
  let targetPath = msg.path;

  if (!targetPath && msg.session) {
    targetPath = ptyManager.getSessionCwd(msg.session);
    if (!targetPath) {
      reply(msg.requestId, { ok: false, error: 'Cannot get session cwd' });
      return;
    }
  }

  if (!targetPath) {
    reply(msg.requestId, { ok: false, error: 'path or session required' });
    return;
  }

  const resolved = path.resolve(targetPath);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      reply(msg.requestId, { ok: false, error: 'Not a directory' });
      return;
    }
    const items = fs.readdirSync(resolved, { withFileTypes: true })
      .map(e => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    reply(msg.requestId, { ok: true, path: resolved, items });
  } catch (e) {
    reply(msg.requestId, { ok: false, error: 'Cannot read directory' });
  }
}

function handleDownload(msg) {
  const resolved = path.resolve(msg.path);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      reply(msg.requestId, { ok: false, error: 'Not a file' });
      return;
    }
    const data = fs.readFileSync(resolved).toString('base64');
    reply(msg.requestId, {
      ok: true,
      filename: path.basename(resolved),
      size: stat.size,
      data,
    });
  } catch {
    reply(msg.requestId, { ok: false, error: 'File not found' });
  }
}

function handleUpload(msg) {
  const cwd = ptyManager.getSessionCwd(msg.session);
  if (!cwd) {
    reply(msg.requestId, { ok: false, error: 'Cannot get session cwd' });
    return;
  }

  const conflicts = msg.files
    .map(f => f.filename)
    .filter(name => fs.existsSync(path.join(cwd, name)));

  if (conflicts.length > 0) {
    reply(msg.requestId, { ok: false, error: 'conflict', conflicts });
    return;
  }

  try {
    const saved = [];
    for (const file of msg.files) {
      const dest = path.join(cwd, file.filename);
      fs.writeFileSync(dest, Buffer.from(file.data, 'base64'));
      saved.push(dest);
    }
    reply(msg.requestId, { ok: true, saved });
  } catch (e) {
    reply(msg.requestId, { ok: false, error: `Write failed: ${e.message}` });
  }
}

// ── Dispatch ───────────────────────────────────────────────────────────────────

function handleMessage(data, isBinary) {
  if (isBinary) {
    // Keyboard input from Hub: [channelId 16B][payload]
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length <= CHANNEL_ID_BYTES) return;
    const channelId = decodeChannelId(buf);
    const payload = buf.slice(CHANNEL_ID_BYTES);
    const ch = channels.get(channelId);
    if (ch) ch.pty.write(payload.toString());
    return;
  }

  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.type) {
    case 'attach':         handleAttach(msg); break;
    case 'resize':         handleResize(msg); break;
    case 'detach':         handleDetach(msg); break;
    case 'create-session': handleCreateSession(msg); break;
    case 'rename-session': handleRenameSession(msg); break;
    case 'kill-session':   handleKillSession(msg); break;
    case 'get-cwd':        handleGetCwd(msg); break;
    case 'ls':             handleLs(msg); break;
    case 'download':       handleDownload(msg); break;
    case 'upload':         handleUpload(msg); break;
  }
}

// ── Connection ────────────────────────────────────────────────────────────────

function scheduleReconnect() {
  console.log(`Reconnecting in ${reconnectDelay / 1000}s…`);
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, config.reconnect.maxDelay);
}

function connect() {
  registerAndLogin()
    .then(token => {
      ws = new WebSocket(buildWsUrl(token));

      ws.on('open', () => {
        console.log('Connected to Hub.');
        reconnectDelay = config.reconnect.initialDelay;
        sendSessions();
      });

      ws.on('message', handleMessage);

      ws.on('close', (code, reason) => {
        console.log(`Disconnected from Hub (${code} ${reason}).`);
        // Clean up all active channels
        channels.forEach(ch => { try { ch.pty.kill(); } catch {} });
        channels.clear();
        scheduleReconnect();
      });

      ws.on('error', err => console.error('WebSocket error:', err.message));
    })
    .catch(err => {
      console.error('Startup error:', err.message);
      scheduleReconnect();
    });
}

async function registerAndLogin() {
  await registerWithHub();
  return loginToHub();
}

// ── Startup ───────────────────────────────────────────────────────────────────

(async () => {
  const allFromEnv = process.env.HUB_URL && process.env.AGENT_USERNAME && process.env.AGENT_PASSWORD;

  if (allFromEnv) {
    config = applyEnvOverrides({});
  } else {
    const fileCfg = await runSetup(resolveConfigPath());
    config = applyEnvOverrides(fileCfg);
  }

  if (!config.hubUrl || !config.username || !config.password) {
    console.error('Missing required config: hubUrl, username, password');
    process.exit(1);
  }

  reconnectDelay = config.reconnect.initialDelay;
  ptyManager.onSessionChange(sendSessions);
  console.log(`Starting agent as "${config.username}" → ${config.hubUrl}`);
  connect();
})();
