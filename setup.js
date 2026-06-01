'use strict';
const fs   = require('fs');
const path = require('path');

// ── Raw-mode single-key input ─────────────────────────────────────────────────

async function ask(label, defaultVal, hidden) {
  const hint = defaultVal != null && defaultVal !== '' ? ` [${hidden ? '*'.repeat(defaultVal.length) : defaultVal}]` : '';
  process.stdout.write(`  ${label}${hint}: `);

  if (!process.stdin.isTTY) {
    const { createInterface } = require('readline');
    return new Promise(resolve => {
      const rl = createInterface({ input: process.stdin, output: null, terminal: false });
      rl.once('line', line => { rl.close(); resolve(line.trim() || defaultVal || ''); });
    });
  }

  return new Promise(resolve => {
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function onData(ch) {
      if (ch === '\r' || ch === '\n' || ch === '\x04') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(buf || defaultVal || '');
      } else if (ch === '\x03') {
        process.stdout.write('\n');
        process.exit(0);
      } else if (ch === '\x7f' || ch === '\b') {
        if (buf.length) {
          buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (ch >= ' ') {
        buf += ch;
        process.stdout.write(hidden ? '*' : ch);
      }
    }

    process.stdin.on('data', onData);
  });
}

// ── Display helpers ───────────────────────────────────────────────────────────

function printBanner() {
  console.log();
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║      WebMux Agent  ·  Setup          ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log();
}

function printCfg(cfg) {
  console.log(`    Hub URL      ${cfg.hubUrl ?? ''}`);
  console.log(`    Username     ${cfg.username}`);
  console.log(`    Password     ${'*'.repeat(cfg.password?.length ?? 0)}`);
  console.log(`    Managed only ${cfg.managedOnly ?? false}`);
  const turn = cfg.turnServers?.[0];
  console.log(`    TURN server  ${turn ? turn.urls : '(none)'}`);
  if (turn?.username) console.log(`    TURN user    ${turn.username}`);
  console.log();
}

// ── Interactive prompts ───────────────────────────────────────────────────────

async function promptTurn(defaults) {
  const existing = defaults.turnServers?.[0];
  console.log('  TURN server (leave blank to disable WebRTC relay):');
  const turnUrl  = await ask('  URL          ', existing?.urls ?? '');
  if (!turnUrl.trim()) return [];
  const username   = await ask('  Username     ', existing?.username ?? '');
  const credential = await ask('  Credential   ', existing?.credential ?? '', true);
  return [{ urls: turnUrl.trim(), username: username.trim(), credential: credential.trim() }];
}

async function promptAll(defaults) {
  const existingUrl = defaults.hubUrl ?? '';
  const raw = await ask('Hub URL      ', existingUrl || 'https://');
  const hubUrl = raw.trim().replace(/\/$/, '');

  const username = await ask('Username     ', defaults.username ?? '');
  const password = await ask('Password     ', defaults.password ?? '', true);
  const moRaw    = await ask('Managed only (y/N)', defaults.managedOnly ? 'y' : 'N');
  const turnServers = await promptTurn(defaults);

  return {
    hubUrl,
    username,
    password,
    managedOnly: moRaw.trim().toLowerCase() === 'y',
    reconnect:   defaults.reconnect ?? { initialDelay: 1000, maxDelay: 30000 },
    ...(turnServers.length > 0 ? { turnServers } : {}),
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function runSetup(configPath) {
  printBanner();

  let existing = null;
  if (fs.existsSync(configPath)) {
    try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  }

  const complete = existing?.hubUrl && existing?.username && existing?.password;

  if (complete) {
    console.log('  Current configuration:\n');
    printCfg(existing);
    const ans = await ask('Use this configuration? (Y/n)', 'Y');
    console.log();
    if (ans.trim().toLowerCase() !== 'n') {
      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
      return existing;
    }
    console.log('  Enter new values (press Enter to keep current):\n');
  } else if (existing) {
    console.log('  Incomplete config — please fill in the missing fields:\n');
  } else {
    console.log('  First run — please enter the required fields:\n');
  }

  const cfg = await promptAll(existing ?? {});

  if (!cfg.hubUrl || !cfg.username || !cfg.password) {
    console.error('\n  Error: hubUrl, username, and password are required.\n');
    process.exit(1);
  }

  console.log('\n  Configuration to save:\n');
  printCfg(cfg);

  const confirm = await ask('Save and connect? (Y/n)', 'Y');
  if (confirm.trim().toLowerCase() === 'n') {
    console.log('\n  Aborted.\n');
    process.exit(0);
  }

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  console.log('\n  Config saved.\n');
  return cfg;
}

module.exports = { runSetup };
