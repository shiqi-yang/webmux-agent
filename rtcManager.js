'use strict';

const fs = require('fs');
const path = require('path');

let NodeDataChannel;
try {
  NodeDataChannel = require('node-datachannel');
} catch {
  console.error('\x1b[41m\x1b[1m\x1b[37m');
  console.error('  ✗  node-datachannel 未安装，WebRTC 功能不可用！                    ');
  console.error('     请运行: npm install                                              ');
  console.error('\x1b[0m');
}


const ptyManager = require('./ptyManager');

const FILE_CHUNK_SIZE = 65536; // 64 KB per DataChannel frame

// channelId → { pc, sessionName }
const peers = new Map();

// channelId → { ptyInstance, sessionName, timer }  (grace period after DC closes)
const gracePtys = new Map();

const GRACE_PERIOD = 30_000;

function convertIceServers(servers) {
  return servers.map(s => {
    if (typeof s === 'string') return s;
    const urls = Array.isArray(s.urls) ? s.urls[0] : s.urls;
    if (!s.username || !s.credential) return urls;
    // Embed credentials into URL: turn:host:port → turn:user:pass@host:port
    const m = urls.match(/^(turns?:\/\/|turns?:)(.*)/i);
    if (m) return `${m[1]}${encodeURIComponent(s.username)}:${encodeURIComponent(s.credential)}@${m[2]}`;
    return urls;
  });
}

function handleOffer(msg, turnServers, sendToHub) {
  if (!NodeDataChannel) {
    sendToHub({ type: 'rtc-failed', channelId: msg.channelId, reason: 'WebRTC not available on agent' });
    return;
  }

  const { channelId, sessionName, sdp } = msg;

  // If PC already exists (ICE restart offer), update remote description only.
  const existing = peers.get(channelId);
  if (existing?.pc) {
    try {
      existing.pc.setRemoteDescription(sdp, 'offer');
      return;
    } catch {
      cleanup(channelId);
    }
  }

  const iceServers = convertIceServers(turnServers || []);

  let pc;
  try {
    pc = new NodeDataChannel.PeerConnection(channelId, {
      iceServers: iceServers.length > 0 ? iceServers : undefined,
    });
  } catch (e) {
    sendToHub({ type: 'rtc-failed', channelId, reason: e.message });
    return;
  }

  peers.set(channelId, { pc, sessionName });

  pc.onLocalDescription((sdpStr, type) => {
    if (type === 'answer') {
      sendToHub({ type: 'rtc-answer', channelId, sdp: sdpStr });
    }
  });

  pc.onLocalCandidate((candidate, mid) => {
    sendToHub({ type: 'rtc-ice', channelId, candidate, mid });
  });

  pc.onDataChannel(dc => {
    if (dc.getLabel().startsWith('file-')) {
      bindDataChannelToFile(dc);
    } else {
      bindDataChannelToPty(dc, channelId, sessionName, sendToHub);
    }
  });

  pc.onStateChange(state => {
    if (state === 'failed' || state === 'closed') {
      cleanup(channelId);
    }
  });

  try {
    pc.setRemoteDescription(sdp, 'offer');
  } catch (e) {
    sendToHub({ type: 'rtc-failed', channelId, reason: e.message });
    cleanup(channelId);
  }
}

function handleIce(channelId, candidate, mid) {
  const entry = peers.get(channelId);
  if (!entry?.pc) return;
  try {
    entry.pc.addRemoteCandidate(candidate, mid);
  } catch {}
}

// ── File transfer DataChannel ─────────────────────────────────────────────────
// Protocol (browser → agent): JSON text { type:'file-req', requestId:'<16 hex>', path:'<abs>' }
// Protocol (agent → browser): binary frames [16B requestId][4B chunkIdx u32BE][4B total u32BE][data]
//                             or JSON text  { type:'file-err', requestId, error }

function bindDataChannelToFile(dc) {
  dc.onMessage(data => {
    if (typeof data !== 'string') return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type !== 'file-req') return;

    const { requestId, path: filePath } = msg;
    if (typeof requestId !== 'string' || requestId.length !== 16 || !filePath) return;

    const resolved = path.resolve(filePath);
    let fileData;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        dc.sendMessage(JSON.stringify({ type: 'file-err', requestId, error: 'Not a file' }));
        return;
      }
      fileData = fs.readFileSync(resolved);
    } catch {
      dc.sendMessage(JSON.stringify({ type: 'file-err', requestId, error: 'File not found' }));
      return;
    }

    const totalChunks = Math.max(1, Math.ceil(fileData.length / FILE_CHUNK_SIZE));
    const idBuf = Buffer.from(requestId, 'ascii'); // 16 bytes

    for (let i = 0; i < totalChunks; i++) {
      if (!dc.isOpen()) break;
      const chunk = fileData.slice(i * FILE_CHUNK_SIZE, (i + 1) * FILE_CHUNK_SIZE);
      const header = Buffer.allocUnsafe(24);
      idBuf.copy(header, 0);
      header.writeUInt32BE(i, 16);
      header.writeUInt32BE(totalChunks, 20);
      try { dc.sendMessageBinary(Buffer.concat([header, chunk])); } catch { break; }
    }
  });
}

function bindDataChannelToPty(dc, channelId, initialSessionName, sendToHub) {
  let ptyInstance = null;
  let currentSessionName = initialSessionName;

  function attachSession(name, cols, rows) {
    // Reuse grace PTY if available for this session.
    const grace = gracePtys.get(channelId);
    if (grace && grace.sessionName === name) {
      clearTimeout(grace.timer);
      gracePtys.delete(channelId);
      ptyInstance = grace.ptyInstance;
      currentSessionName = name;
      return true;
    }

    if (ptyInstance) {
      try { ptyInstance.kill(); } catch {}
      ptyInstance = null;
    }

    const p = ptyManager.attachPty(
      name,
      data => { if (dc.isOpen()) dc.sendMessageBinary(Buffer.from(data)); },
      () => {
        ptyInstance = null;
        if (dc.isOpen()) dc.sendMessage(JSON.stringify({ type: 'detached' }));
      },
      cols ?? 220,
      rows ?? 50,
    );

    if (!p) return false;
    ptyInstance = p;
    currentSessionName = name;
    return true;
  }

  dc.onMessage(data => {
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      switch (msg.type) {
        case 'attach': {
          const ok = attachSession(msg.sessionName, msg.cols, msg.rows);
          dc.sendMessage(JSON.stringify(
            ok
              ? { type: 'attached', sessionName: msg.sessionName }
              : { type: 'attach-error', message: 'Session not found' }
          ));
          break;
        }
        case 'resize':
          if (ptyInstance) {
            ptyManager.resizePty(ptyInstance, currentSessionName, msg.cols, msg.rows);
          }
          break;
        case 'detach':
          if (ptyInstance) { try { ptyInstance.kill(); } catch {} ptyInstance = null; }
          break;
      }
    } else {
      // Binary: keyboard input forwarded directly to PTY.
      if (ptyInstance) ptyInstance.write(Buffer.from(data).toString());
    }
  });

  dc.onClosed(() => {
    if (!ptyInstance) return;
    // Keep PTY alive briefly in case the browser reconnects via DataChannel.
    gracePtys.set(channelId, {
      ptyInstance,
      sessionName: currentSessionName,
      timer: setTimeout(() => {
        const g = gracePtys.get(channelId);
        if (g) {
          try { g.ptyInstance.kill(); } catch {}
          gracePtys.delete(channelId);
        }
      }, GRACE_PERIOD),
    });
    ptyInstance = null;
  });
}

function cleanup(channelId) {
  const entry = peers.get(channelId);
  if (entry) {
    try { entry.pc?.close(); } catch {}
    peers.delete(channelId);
  }

  const grace = gracePtys.get(channelId);
  if (grace) {
    clearTimeout(grace.timer);
    try { grace.ptyInstance?.kill(); } catch {}
    gracePtys.delete(channelId);
  }
}

module.exports = { handleOffer, handleIce, cleanup, isWebRtcAvailable: () => !!NodeDataChannel };
