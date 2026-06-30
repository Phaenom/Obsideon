#!/usr/bin/env node
/*
 * Cross-platform "start the bridge at login" installer.
 *
 * Registers bridge/server.js to launch automatically when you log in, so you never have
 * to start it by hand. Paths are resolved from this repo's own location and the Node
 * binary currently running, so it works wherever the repo lives and for anyone who clones
 * it - nothing is hard-coded.
 *
 *   node scripts/autostart.js install     # register + start it now
 *   node scripts/autostart.js uninstall   # remove it
 *   node scripts/autostart.js status      # is it registered / responding?
 *
 * Mechanism per OS:
 *   Windows  -> Scheduled Task (schtasks), trigger "at log on", runs hidden
 *   macOS    -> LaunchAgent plist in ~/Library/LaunchAgents (RunAtLoad + KeepAlive)
 *   Linux    -> systemd --user service (enable --now, Restart=on-failure)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'bridge', 'server.js');
const NODE = process.execPath;            // the node binary running this script
const LABEL = 'com.obsidian.actionitems.bridge';
const TASK_NAME = 'Obsidian Action Items Bridge';
const LISTEN_PORT = readListenPort();

function readListenPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'bridge', 'config.json'), 'utf8'));
    return cfg.listenPort || 8765;
  } catch { return 8765; }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------
// Windows (Startup folder batch file — visible terminal window, minimized on login)
// ---------------------------------------------------------------------------
function winStartupDir() {
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function winVbsPath() {
  return path.join(winStartupDir(), 'ObsidianActionItemsBridge.vbs');
}

function winVbsContent() {
  // WScript.Shell.Run with window style 0 = hidden; False = don't wait.
  // Double-quote escaping inside a VBScript string uses doubled double-quotes.
  const node = NODE.replace(/"/g, '""');
  const server = SERVER.replace(/"/g, '""');
  return `Set oShell = CreateObject("WScript.Shell")\r\noShell.Run """${node}"" ""${server}""", 0, False\r\n`;
}

function winInstall() {
  // Remove any leftover bat file or scheduled task from older versions.
  const oldBat = path.join(winStartupDir(), 'ObsidianActionItemsBridge.bat');
  fs.rmSync(oldBat, { force: true });
  run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);

  const vbsPath = winVbsPath();
  fs.writeFileSync(vbsPath, winVbsContent(), 'utf8');
  console.log(`Created startup entry: ${vbsPath}`);
  console.log('The bridge will start silently in the background at every login (no terminal window).');
  console.log('Starting it now...');

  // wscript.exe runs the VBS which launches node hidden and exits immediately.
  const child = spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

function winUninstall() {
  const vbsPath = winVbsPath();
  if (fs.existsSync(vbsPath)) {
    fs.rmSync(vbsPath);
    console.log(`Removed startup entry: ${vbsPath}`);
  } else {
    console.log('No startup entry found — nothing to remove.');
  }
  // Clean up legacy files from prior versions.
  fs.rmSync(path.join(winStartupDir(), 'ObsidianActionItemsBridge.bat'), { force: true });
  const r = run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  if (r.code === 0) console.log(`Also removed old scheduled task "${TASK_NAME}".`);
}

function winStatus() {
  const vbsPath = winVbsPath();
  if (fs.existsSync(vbsPath)) {
    console.log(`Registered — startup script exists:\n  ${vbsPath}`);
  } else {
    console.log('Not registered (no startup entry found).');
  }
}

// ---------------------------------------------------------------------------
// macOS (LaunchAgent)
// ---------------------------------------------------------------------------
function macPlistPath() { return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`); }

function macInstall() {
  const log = path.join(REPO, 'bridge', 'bridge.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>${SERVER}</string></array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>`;
  const p = macPlistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, plist);
  run('launchctl', ['unload', p]);          // ignore error if not loaded
  const r = run('launchctl', ['load', '-w', p]);
  if (r.code !== 0) { console.error('launchctl load failed:\n' + r.out); process.exit(1); }
  console.log(`Installed LaunchAgent ${p} (loads at login, restarts on crash).`);
}

function macUninstall() {
  const p = macPlistPath();
  run('launchctl', ['unload', '-w', p]);
  fs.rmSync(p, { force: true });
  console.log(`Removed LaunchAgent ${p}.`);
}

function macStatus() {
  const r = run('launchctl', ['list', LABEL]);
  console.log(r.code === 0 ? `Loaded:\n${r.out.trim()}` : 'Not loaded.');
}

// ---------------------------------------------------------------------------
// Linux (systemd --user)
// ---------------------------------------------------------------------------
function linUnitPath() { return path.join(os.homedir(), '.config', 'systemd', 'user', 'obsidian-action-items-bridge.service'); }

function linInstall() {
  const unit = `[Unit]
Description=Obsidian Action Items bridge (for the XENEON EDGE widget)
After=network.target

[Service]
ExecStart=${NODE} ${SERVER}
WorkingDirectory=${REPO}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  const p = linUnitPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, unit);
  run('systemctl', ['--user', 'daemon-reload']);
  const r = run('systemctl', ['--user', 'enable', '--now', 'obsidian-action-items-bridge.service']);
  if (r.code !== 0) { console.error('systemctl enable failed:\n' + r.out + '\n(You may need: loginctl enable-linger $USER)'); process.exit(1); }
  console.log(`Installed systemd user service ${p} (enabled + started).`);
  console.log('Tip: to keep it running while logged out, run:  loginctl enable-linger $USER');
}

function linUninstall() {
  run('systemctl', ['--user', 'disable', '--now', 'obsidian-action-items-bridge.service']);
  fs.rmSync(linUnitPath(), { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  console.log('Removed systemd user service.');
}

function linStatus() {
  const r = run('systemctl', ['--user', 'is-active', 'obsidian-action-items-bridge.service']);
  console.log(`Service: ${r.out.trim() || 'unknown'}`);
}

// ---------------------------------------------------------------------------
// Health check (all platforms)
// ---------------------------------------------------------------------------
function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: LISTEN_PORT, path: '/api/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
async function main() {
  const action = (process.argv[2] || '').toLowerCase();
  const platform = process.platform;

  if (!['install', 'uninstall', 'status'].includes(action)) {
    console.log('Usage: node scripts/autostart.js <install|uninstall|status>');
    process.exit(action ? 1 : 0);
  }
  if (!fs.existsSync(SERVER)) { console.error(`Cannot find ${SERVER}`); process.exit(1); }

  const table = {
    win32: { install: winInstall, uninstall: winUninstall, status: winStatus },
    darwin: { install: macInstall, uninstall: macUninstall, status: macStatus },
    linux: { install: linInstall, uninstall: linUninstall, status: linStatus },
  };
  const handlers = table[platform];
  if (!handlers) { console.error(`Unsupported platform: ${platform}. Start the bridge manually with: node bridge/server.js`); process.exit(1); }

  console.log(`Repo:   ${REPO}`);
  console.log(`Node:   ${NODE}`);
  console.log(`Server: ${SERVER}\n`);

  handlers[action]();

  if (action === 'install' || action === 'status') {
    // Give a just-started process a moment, then confirm it's actually listening.
    await new Promise((r) => setTimeout(r, 4000)); // give a new CMD window time to start node
    const ok = await healthCheck();
    console.log(ok
      ? `\nBridge is responding on http://127.0.0.1:${LISTEN_PORT}/ ✓`
      : `\nBridge is NOT responding on port ${LISTEN_PORT} yet. If you just installed, it should come up at next login; otherwise check that Node and the repo path above are correct.`);
  }
}

main();
