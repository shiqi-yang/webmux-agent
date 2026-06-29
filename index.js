if (!globalThis.fetch) globalThis.fetch = require('node-fetch');

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const ptyManager = require('./ptyManager');
const rtcManager = require('./rtcManager');
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
    hubUrl:      (process.env.HUB_URL || cfg.hubUrl || '').replace(/\/$/, ''),
    username:    process.env.AGENT_USERNAME  || cfg.username,
    password:    process.env.AGENT_PASSWORD  || cfg.password,
    managedOnly: managedOnlyEnv !== undefined
      ? managedOnlyEnv === 'true' || managedOnlyEnv === '1'
      : (cfg.managedOnly ?? false),
    reconnect: cfg.reconnect ?? { initialDelay: 1000, maxDelay: 30000 },
  };
}

let config;
let TURN_SERVERS = [];

// ── State ─────────────────────────────────────────────────────────────────────

let ws = null;
let reconnectDelay = 1000;

// channelId → { ptyInstance, sessionName }
const channels = new Map();

const CHANNEL_ID_LEN = 16;

// ── Hub HTTP calls ─────────────────────────────────────────────────────────────

async function registerWithHub(hubUrl) {
  const res = await fetch(`${hubUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  if (res.ok) {
    console.log(`Registered account "${config.username}" on Hub.`);
  } else if (res.status === 409) {
    console.log(`Account "${config.username}" already exists on Hub, proceeding to login.`);
  } else {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Register failed (${res.status}): ${body.error || res.statusText}`);
  }
}

async function loginToHub(hubUrl) {
  const res = await fetch(`${hubUrl}/auth/login`, {
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

function buildWsUrl(hubUrl, token) {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/agent-ws';
  u.searchParams.set('token', token);
  return u.toString();
}

// ── Send helpers ───────────────────────────────────────────────────────────────

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function reply(requestId, payload) {
  send({ type: 'result', requestId, ...payload });
}

function sendSessions() {
  send({ type: 'sessions', list: ptyManager.listSessions(config.managedOnly) });
}

function sendPtyData(channelId, data) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const idBuf = Buffer.alloc(CHANNEL_ID_LEN);
  idBuf.write(channelId, 'ascii');
  ws.send(Buffer.concat([idBuf, Buffer.from(data)]), { binary: true });
}

// ── PTY channel management ─────────────────────────────────────────────────────

function handleAttach(msg) {
  const { channelId, sessionName, cols, rows } = msg;

  if (config.managedOnly && !ptyManager.isManaged(sessionName)) {
    send({ type: 'attach-error', channelId, message: 'Session not managed by webmux' });
    return;
  }

  const p = ptyManager.attachPty(
    sessionName,
    data => sendPtyData(channelId, data),
    () => {
      channels.delete(channelId);
      send({ type: 'detached', channelId });
    },
    cols, rows
  );

  if (!p) {
    send({ type: 'attach-error', channelId, message: 'Session not found' });
    return;
  }

  channels.set(channelId, { ptyInstance: p, sessionName });
  send({ type: 'attached', channelId });
}

function handleResize(msg) {
  const ch = channels.get(msg.channelId);
  if (!ch?.ptyInstance) return;
  ptyManager.resizePty(ch.ptyInstance, ch.sessionName, msg.cols, msg.rows);
}

function handleDetach(msg) {
  const ch = channels.get(msg.channelId);
  if (!ch) return;
  channels.delete(msg.channelId);
  try { ch.ptyInstance?.kill(); } catch {}
}

// ── Session management ─────────────────────────────────────────────────────────

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
  if (!cwd) { reply(msg.requestId, { ok: false, error: 'Cannot get cwd' }); return; }
  reply(msg.requestId, { ok: true, cwd });
}

async function handleLs(msg) {
  let targetPath = msg.path;

  if (!targetPath && msg.session) {
    targetPath = ptyManager.getSessionCwd(msg.session);
    if (!targetPath) { reply(msg.requestId, { ok: false, error: 'Cannot get session cwd' }); return; }
  }

  if (!targetPath) { reply(msg.requestId, { ok: false, error: 'path or session required' }); return; }

  const resolved = path.resolve(targetPath);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) { reply(msg.requestId, { ok: false, error: 'Not a directory' }); return; }
    const dirents = fs.readdirSync(resolved, { withFileTypes: true });
    const items = await Promise.all(dirents.map(async e => {
      const isDir = e.isDirectory();
      let size;
      if (!isDir) {
        try { size = (await fs.promises.stat(path.join(resolved, e.name))).size; } catch {}
      }
      return { name: e.name, isDir, size };
    }));
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    reply(msg.requestId, { ok: true, path: resolved, items });
  } catch {
    reply(msg.requestId, { ok: false, error: 'Cannot read directory' });
  }
}

function handleDownload(msg) {
  const resolved = path.resolve(msg.path);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) { reply(msg.requestId, { ok: false, error: 'Not a file' }); return; }
    const data = fs.readFileSync(resolved).toString('base64');
    reply(msg.requestId, { ok: true, filename: path.basename(resolved), size: stat.size, data });
  } catch {
    reply(msg.requestId, { ok: false, error: 'File not found' });
  }
}

function handleUpload(msg) {
  let destDir = msg.targetPath;
  if (!destDir) {
    destDir = ptyManager.getSessionCwd(msg.session);
    if (!destDir) { reply(msg.requestId, { ok: false, error: 'Cannot get session cwd' }); return; }
  }
  destDir = path.resolve(destDir);

  if (!msg.overwrite) {
    const conflicts = msg.files.map(f => f.filename).filter(name => fs.existsSync(path.join(destDir, name)));
    if (conflicts.length > 0) { reply(msg.requestId, { ok: false, error: 'conflict', conflicts }); return; }
  }

  try {
    const saved = [];
    for (const file of msg.files) {
      const dest = path.join(destDir, file.filename);
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
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < CHANNEL_ID_LEN) return;
    const channelId = buf.slice(0, CHANNEL_ID_LEN).toString('ascii');
    const payload = buf.slice(CHANNEL_ID_LEN);
    const ch = channels.get(channelId);
    if (ch?.ptyInstance) ch.ptyInstance.write(payload.toString());
    return;
  }

  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.type) {
    case 'attach':          handleAttach(msg); break;
    case 'resize':          handleResize(msg); break;
    case 'detach':          handleDetach(msg); break;
    case 'create-session':  handleCreateSession(msg); break;
    case 'rename-session':  handleRenameSession(msg); break;
    case 'kill-session':    handleKillSession(msg); break;
    case 'get-cwd':         handleGetCwd(msg); break;
    case 'ls':              handleLs(msg).catch(() => {}); break;
    case 'download':        handleDownload(msg); break;
    case 'upload':          handleUpload(msg); break;
    case 'rtc-offer':       rtcManager.handleOffer(msg, TURN_SERVERS, payload => send(payload)); break;
    case 'rtc-ice':         rtcManager.handleIce(msg.channelId, msg.candidate, msg.mid); break;
  }
}

// ── Connection ────────────────────────────────────────────────────────────────

function scheduleReconnect() {
  console.log(`Reconnecting in ${reconnectDelay / 1000}s…`);
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, config.reconnect.maxDelay);
}

const PING_INTERVAL = 25_000;

async function connect() {
  try {
    const { hubUrl } = config;
    await registerWithHub(hubUrl);
    const token = await loginToHub(hubUrl);

    ws = new WebSocket(buildWsUrl(hubUrl, token));
    let pingTimer = null;

    ws.on('open', () => {
      console.log(`Connected to ${hubUrl}`);
      reconnectDelay = config.reconnect.initialDelay;
      ws.isAlive = true;
      pingTimer = setInterval(() => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
      }, PING_INTERVAL);
      sendSessions();
    });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', handleMessage);

    ws.on('close', (code, reason) => {
      clearInterval(pingTimer);
      console.log(`Disconnected from Hub (${code} ${reason}).`);
      for (const [, ch] of channels) try { ch.ptyInstance?.kill(); } catch {}
      channels.clear();
      scheduleReconnect();
    });

    ws.on('error', err => console.error('WebSocket error:', err.message));
  } catch (err) {
    console.error('Startup error:', err.message);
    scheduleReconnect();
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

(async () => {
  const allFromEnv = process.env.HUB_URL && process.env.AGENT_USERNAME && process.env.AGENT_PASSWORD;
  const noSetup = process.argv.includes('--no-setup') || process.env.SKIP_SETUP === 'true';

  let fileCfg = {};
  if (!allFromEnv && !noSetup) {
    fileCfg = await runSetup(resolveConfigPath());
  } else {
    const cfgPath = resolveConfigPath();
    if (fs.existsSync(cfgPath)) {
      try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
    }
  }

  config = applyEnvOverrides(fileCfg);

  if (!config.username || !config.password || !config.hubUrl) {
    console.error('Missing required config: hubUrl, username, password');
    process.exit(1);
  }

  TURN_SERVERS = JSON.parse(process.env.TURN_SERVERS || JSON.stringify(fileCfg.turnServers || []));

  reconnectDelay = config.reconnect.initialDelay;
  ptyManager.onSessionChange(sendSessions);
  ptyManager.startExternalChangePoller(30_000);
  console.log(`Starting agent as "${config.username}" (hub: ${config.hubUrl})`);
  if (!rtcManager.isWebRtcAvailable()) {
    console.error('\x1b[41m\x1b[1m\x1b[37m  ✗  WebRTC 不可用：node-datachannel 未安装，运行 npm install 修复  \x1b[0m');
  }
  connect();
})();
