const pty = require('node-pty');
const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Managed-session registry (local file, no tmux options) ────────────────────

const MANAGED_FILE = path.join(__dirname, 'managed-sessions.json');

let managedSessions = new Set();

function loadManaged() {
  try {
    const data = JSON.parse(fs.readFileSync(MANAGED_FILE, 'utf8'));
    managedSessions = new Set(Array.isArray(data) ? data : []);
  } catch {
    managedSessions = new Set();
  }
}

function saveManaged() {
  fs.writeFileSync(MANAGED_FILE, JSON.stringify([...managedSessions], null, 2));
}

loadManaged();

// ── Tmux version detection ────────────────────────────────────────────────────

// Exact-match target prefix `=name` requires tmux >= 3.2
let exactTargetSupported = false;

(function detectTmuxVersion() {
  try {
    const out = execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim();
    const m = out.match(/tmux (\d+)\.(\d+)/);
    if (m) {
      const [, maj, min] = m.map(Number);
      exactTargetSupported = maj > 3 || (maj === 3 && min >= 2);
    }
    console.log(`Detected ${out} — exact target ${exactTargetSupported ? 'enabled' : 'disabled'}`);
  } catch {}
})();

function t(name) {
  return exactTargetSupported ? `=${name}` : name;
}

// ── State ─────────────────────────────────────────────────────────────────────

// sessionName → Set<pty instance>
const sessionPtys = new Map();

const changeCallbacks = new Set();

function onSessionChange(cb) {
  changeCallbacks.add(cb);
  return () => changeCallbacks.delete(cb);
}

function broadcastChange() {
  changeCallbacks.forEach(cb => cb());
}

function listSessions(managedOnly = false) {
  try {
    const out = execFileSync(
      'tmux',
      ['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_created_string}'],
      { encoding: 'utf8' }
    ).trimEnd();
    if (!out) return [];
    return out.split('\n')
      .map(line => {
        const [name, windows, created] = line.split('\t');
        return { name, windows: Number(windows), created, _managed: managedSessions.has(name) };
      })
      .filter(s => !managedOnly || s._managed)
      .map(({ name, windows, created }) => ({ name, windows, created }));
  } catch {
    return [];
  }
}

function isManaged(name) {
  return managedSessions.has(name);
}

function hasSession(name) {
  try {
    execFileSync('tmux', ['has-session', '-t', t(name)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function createSession(name) {
  if (hasSession(name)) throw new Error('Session already exists');
  execFileSync('tmux', ['new-session', '-d', '-s', name]); // -s takes plain name, not target
  managedSessions.add(name);
  try {
    saveManaged();
  } catch (e) {
    managedSessions.delete(name);
    try { execFileSync('tmux', ['kill-session', '-t', t(name)]); } catch {}
    throw e;
  }
  broadcastChange();
}

function renameSession(oldName, newName) {
  if (!hasSession(oldName)) throw new Error('Session not found');
  execFileSync('tmux', ['rename-session', '-t', t(oldName), newName]);
  if (managedSessions.has(oldName)) {
    managedSessions.delete(oldName);
    managedSessions.add(newName);
    saveManaged();
  }
  broadcastChange();
}

function killSession(name) {
  if (!hasSession(name)) throw new Error('Session not found');
  const ptys = sessionPtys.get(name);
  if (ptys) {
    ptys.forEach(p => { try { p.kill(); } catch {} });
    sessionPtys.delete(name);
  }
  execFileSync('tmux', ['kill-session', '-t', t(name)]);
  managedSessions.delete(name);
  saveManaged();
  broadcastChange();
}

function attachPty(sessionName, onData, onExit, cols = 220, rows = 50) {
  if (!hasSession(sessionName)) return null;

  const p = pty.spawn('tmux', ['attach-session', '-t', t(sessionName)], {
    name: 'xterm-256color',
    cols,
    rows,
    env: process.env,
  });

  if (!sessionPtys.has(sessionName)) sessionPtys.set(sessionName, new Set());
  sessionPtys.get(sessionName).add(p);

  p.onData(onData);
  p.onExit(() => {
    sessionPtys.get(sessionName)?.delete(p);
    onExit();
    // Session may have been killed externally; notify listeners if it's gone.
    if (!hasSession(sessionName)) broadcastChange();
  });

  return p;
}

function resizePty(p, sessionName, cols, rows) {
  try { p.resize(cols, rows); } catch {}
  // 注释掉：resize-window -x -y 会把 window-size 设为 manual，导致 status bar 覆盖内容末行
  // execFile('tmux', ['resize-window', '-t', t(sessionName), '-x', String(cols), '-y', String(rows)]);
}

function getSessionCwd(sessionName) {
  try {
    // list-panes works without an attached client; display-message may silently
    // return empty when no client is connected to the session.
    const out = execFileSync(
      'tmux',
      ['list-panes', '-t', t(sessionName), '-F', '#{pane_current_path}'],
      { encoding: 'utf8' }
    ).trim();
    return out.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

// Poll for externally-added or externally-removed tmux sessions.
// This catches changes that happen outside of webmux (e.g. `tmux kill-session`
// run directly in the terminal, or a shell exiting with no PTY attached).
let _pollSnapshot = null;

function startExternalChangePoller(intervalMs = 5000) {
  _pollSnapshot = JSON.stringify(listSessions());
  setInterval(() => {
    const current = JSON.stringify(listSessions());
    if (current !== _pollSnapshot) {
      _pollSnapshot = current;
      broadcastChange();
    }
  }, intervalMs);
}

module.exports = {
  listSessions, hasSession, isManaged,
  createSession, renameSession, killSession,
  attachPty, resizePty, getSessionCwd,
  onSessionChange, startExternalChangePoller,
};
