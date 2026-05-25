const pty = require('node-pty');
const { execFileSync, execFile } = require('child_process');

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

function listSessions() {
  try {
    const out = execFileSync(
      'tmux',
      ['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_created_string}'],
      { encoding: 'utf8' }
    ).trim();
    if (!out) return [];
    return out.split('\n').map(line => {
      const [name, windows, created] = line.split('\t');
      return { name, windows: Number(windows), created };
    });
  } catch {
    return [];
  }
}

function hasSession(name) {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function createSession(name) {
  if (hasSession(name)) throw new Error('Session already exists');
  execFileSync('tmux', ['new-session', '-d', '-s', name]);
  broadcastChange();
}

function renameSession(oldName, newName) {
  if (!hasSession(oldName)) throw new Error('Session not found');
  execFileSync('tmux', ['rename-session', '-t', oldName, newName]);
  broadcastChange();
}

function killSession(name) {
  if (!hasSession(name)) throw new Error('Session not found');
  const ptys = sessionPtys.get(name);
  if (ptys) {
    ptys.forEach(p => { try { p.kill(); } catch {} });
    sessionPtys.delete(name);
  }
  execFileSync('tmux', ['kill-session', '-t', name]);
  broadcastChange();
}

function attachPty(sessionName, onData, onExit, cols = 220, rows = 50) {
  if (!hasSession(sessionName)) return null;

  const p = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
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
  });

  return p;
}

function resizePty(p, sessionName, cols, rows) {
  try { p.resize(cols, rows); } catch {}
  execFile('tmux', ['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)]);
}

function getSessionCwd(sessionName) {
  try {
    return execFileSync(
      'tmux',
      ['display-message', '-t', sessionName, '-p', '#{pane_current_path}'],
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
}

module.exports = {
  listSessions, hasSession,
  createSession, renameSession, killSession,
  attachPty, resizePty, getSessionCwd,
  onSessionChange,
};
