const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const nodeDataChannel = require('node-datachannel');
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
    iceServers:     cfg.iceServers     ?? ['stun:stun.l.google.com:19302'],
    portRangeBegin: cfg.portRangeBegin ?? undefined,
    portRangeEnd:   cfg.portRangeEnd   ?? undefined,
  };
}

let config;

// ── State ─────────────────────────────────────────────────────────────────────

let ws = null;
let reconnectDelay = 1000;

// channelId → { pc, dc, ptyInstance, sessionName, channelId }
// channelId field mirrors the key so callbacks can read the current id after ICE restart remap
const peerConnections = new Map();

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
    console.log(`Account "${config.username}" already exists on Hub, proceeding to login.`);
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

// ── Send helper ────────────────────────────────────────────────────────────────

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function reply(requestId, payload) {
  send({ type: 'result', requestId, ...payload });
}

function sendSessions() {
  send({ type: 'sessions', list: ptyManager.listSessions(config.managedOnly) });
}

// ── WebRTC ────────────────────────────────────────────────────────────────────

function createPeerConnection(channelId, sessionName) {
  const pcConfig = { iceServers: config.iceServers };
  if (config.portRangeBegin) pcConfig.portRangeBegin = config.portRangeBegin;
  if (config.portRangeEnd)   pcConfig.portRangeEnd   = config.portRangeEnd;

  const pc = new nodeDataChannel.PeerConnection('webmux-agent', pcConfig);

  const entry = { pc, dc: null, ptyInstance: null, sessionName, channelId };
  peerConnections.set(channelId, entry);

  pc.onLocalDescription((sdp, type) => {
    // Don't send yet — wait for gathering complete so srflx candidates are bundled in the SDP
    console.log(`[rtc:agent] localDescription type=${type} ch=${entry.channelId} (waiting for gathering)`);
  });

  pc.onLocalCandidate((candidate, mid) => {
    console.log(`[rtc:agent] localCandidate ch=${entry.channelId} mid=${mid} ${candidate.slice(0, 60)}`);
  });

  pc.onGatheringStateChange(state => {
    console.log(`[rtc:agent] gatheringState=${state} ch=${channelId}`);
    if (state === 'complete') {
      // localDescription() returns { type, sdp } — extract the SDP string
      const desc = pc.localDescription();
      const sdp = typeof desc === 'string' ? desc : desc?.sdp;
      if (sdp) {
        console.log(`[rtc:agent] sending complete answer ch=${entry.channelId}`);
        send({ type: 'rtc-answer', channelId: entry.channelId, sdp });
      }
    }
  });

  pc.onDataChannel(dc => {
    console.log(`[rtc:agent] dataChannel received ch=${channelId}`);
    entry.dc = dc;
    dc.onOpen(() => console.log(`[rtc:agent] DC open ch=${channelId}`));
    dc.onMessage(data => handleDcMessage(channelId, data));
    dc.onClosed(() => { console.log(`[rtc:agent] DC closed ch=${channelId}`); handleDcClose(channelId); });
    dc.onError(e => console.error(`[rtc:agent] DC error ch=${channelId}:`, e));
  });

  pc.onStateChange(state => {
    console.log(`[rtc:agent] stateChange=${state} ch=${channelId}`);
    if (state === 'failed' || state === 'closed') handlePcFailed(channelId);
  });

  return entry;
}

function handleRtcOffer(msg) {
  const { channelId, sessionName, sdp, iceRestart, oldChannelId } = msg;
  console.log(`[rtc:agent] offer received ch=${channelId} session=${sessionName} iceRestart=${!!iceRestart}`);

  // ICE restart: reuse existing PC under the new channelId
  if (iceRestart && oldChannelId) {
    const existing = peerConnections.get(oldChannelId);
    if (existing) {
      console.log(`[rtc:agent] ICE restart: remapping ${oldChannelId} → ${channelId}`);
      peerConnections.delete(oldChannelId);
      existing.channelId = channelId;
      peerConnections.set(channelId, existing);
      existing.pc.setRemoteDescription(sdp, 'offer');
      return;
    }
  }

  const entry = createPeerConnection(channelId, sessionName);
  entry.pc.setRemoteDescription(sdp, 'offer');
}

function handleRtcIce(msg) {
  const { channelId, candidate } = msg;
  const entry = peerConnections.get(channelId);
  if (!entry || !candidate?.candidate) return;
  try {
    entry.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid || '0');
  } catch (e) {
    console.error(`addRemoteCandidate [${channelId}]:`, e.message);
  }
}

function handleDcMessage(channelId, data) {
  const entry = peerConnections.get(channelId);
  if (!entry) return;

  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'attach' || msg.type === 'reattach') {
      attachPty(channelId, msg.sessionName, msg.cols ?? 220, msg.rows ?? 50);
    } else if (msg.type === 'resize' && entry.ptyInstance) {
      ptyManager.resizePty(entry.ptyInstance, entry.sessionName, msg.cols, msg.rows);
    } else if (msg.type === 'detach') {
      handleDcClose(channelId);
    }
  } else {
    // Binary: keyboard input from browser
    if (entry.ptyInstance) {
      const input = Buffer.isBuffer(data) ? data.toString() : String(data);
      entry.ptyInstance.write(input);
    }
  }
}

function attachPty(channelId, sessionName, cols, rows) {
  const entry = peerConnections.get(channelId);
  if (!entry) return;

  if (config.managedOnly && !ptyManager.isManaged(sessionName)) {
    entry.dc?.sendMessage(JSON.stringify({ type: 'error', message: 'Session not managed by webmux' }));
    return;
  }

  entry.sessionName = sessionName;

  const p = ptyManager.attachPty(
    sessionName,
    data => {
      try {
        if (entry.dc?.isOpen()) entry.dc.sendMessageBinary(Buffer.from(data));
      } catch {}
    },
    () => {
      // PTY exited (tmux session detached/ended)
      try {
        if (entry.dc?.isOpen()) entry.dc.sendMessage(JSON.stringify({ type: 'detached' }));
      } catch {}
      closePeerConnection(channelId);
    },
    cols, rows
  );

  if (!p) {
    entry.dc?.sendMessage(JSON.stringify({ type: 'error', message: 'Session not found' }));
    return;
  }

  entry.ptyInstance = p;
  entry.dc?.sendMessage(JSON.stringify({ type: 'attached' }));
}

function closePeerConnection(channelId) {
  const entry = peerConnections.get(channelId);
  if (!entry) return;
  peerConnections.delete(channelId);
  if (entry.ptyInstance) { try { entry.ptyInstance.kill(); } catch {} }
  try { entry.dc?.close(); } catch {}
  try { entry.pc?.close(); } catch {}
}

function handleDcClose(channelId) {
  closePeerConnection(channelId);
}

function handlePcFailed(channelId) {
  closePeerConnection(channelId);
}

// ── Session management (forwarded from Hub REST → agent via WS) ────────────────

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

function handleLs(msg) {
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
    const items = fs.readdirSync(resolved, { withFileTypes: true })
      .map(e => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => {
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
  const cwd = ptyManager.getSessionCwd(msg.session);
  if (!cwd) { reply(msg.requestId, { ok: false, error: 'Cannot get session cwd' }); return; }

  if (!msg.overwrite) {
    const conflicts = msg.files.map(f => f.filename).filter(name => fs.existsSync(path.join(cwd, name)));
    if (conflicts.length > 0) { reply(msg.requestId, { ok: false, error: 'conflict', conflicts }); return; }
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
  if (isBinary) return;

  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.type) {
    case 'rtc-offer':       handleRtcOffer(msg); break;
    case 'rtc-ice':         handleRtcIce(msg); break;
    case 'create-session':  handleCreateSession(msg); break;
    case 'rename-session':  handleRenameSession(msg); break;
    case 'kill-session':    handleKillSession(msg); break;
    case 'get-cwd':         handleGetCwd(msg); break;
    case 'ls':              handleLs(msg); break;
    case 'download':        handleDownload(msg); break;
    case 'upload':          handleUpload(msg); break;
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
        // Close all active peer connections — browsers will detect via WebRTC state
        for (const channelId of [...peerConnections.keys()]) closePeerConnection(channelId);
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
