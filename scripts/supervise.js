#!/usr/bin/env node
/*
 * Keeps the bridge running: starts bridge/server.js and restarts it whenever it exits.
 * Used by the Windows startup entry (macOS/Linux restart via launchd/systemd instead).
 *
 * Restart delay backs off from 1s up to 30s when the bridge dies quickly (e.g. port busy),
 * and resets once it has stayed up for a minute. Exit events are logged with a timestamp.
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'bridge', 'server.js');
const STABLE_MS = 60 * 1000;
const MAX_DELAY_MS = 30 * 1000;

let delay = 1000;
let child = null;
let stopping = false;

function log(msg) { console.log(`[supervisor ${new Date().toISOString()}] ${msg}`); }

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [SERVER, ...process.argv.slice(2)], { stdio: 'inherit' });
  log(`bridge started (pid ${child.pid})`);

  child.on('error', (err) => log(`spawn error: ${err.message}`));
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    delay = Date.now() - startedAt >= STABLE_MS ? 1000 : Math.min(delay * 2, MAX_DELAY_MS);
    log(`bridge exited (code ${code}, signal ${signal}); restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
  });
}

function stop() {
  stopping = true;
  if (child) child.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

start();
