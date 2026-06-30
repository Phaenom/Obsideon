#!/usr/bin/env node
/*
 * Minimal stand-in for the Obsidian "Local REST API" plugin, for testing the bridge
 * without Obsidian running. Serves a fixture vault directory over HTTP and supports the
 * handful of endpoints the bridge uses:
 *   GET  /vault/<folder>/        -> { files: [...] }   (directory listing)
 *   GET  /vault/<file>           -> raw markdown
 *   PUT  /vault/<file>           -> overwrite markdown
 *
 * Usage:
 *   node mock-obsidian-server.js --vault ./fixture-vault [--port 27199]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const VAULT = path.resolve(arg('--vault', path.join(__dirname, 'fixture-vault')));
const PORT = parseInt(arg('--port', '27199'), 10);
const API_KEY = 'test-key-123';

function send(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}
function sendJson(res, status, obj) { send(res, status, 'application/json', JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  // Mimic the plugin's auth gate.
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${API_KEY}`) return sendJson(res, 401, { error: 'unauthorized' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/vault/')) {
    const rel = pathname.slice('/vault/'.length);

    // Directory listing: trailing slash.
    if (rel.endsWith('/')) {
      const dir = path.join(VAULT, rel);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sendJson(res, 404, { error: 'not found' });
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? d.name + '/' : d.name));
      return sendJson(res, 200, { files });
    }

    const filePath = path.join(VAULT, rel);

    if (req.method === 'GET') {
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'not found' });
      return send(res, 200, 'text/markdown; charset=utf-8', fs.readFileSync(filePath, 'utf8'));
    }

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.writeFileSync(filePath, Buffer.concat(chunks));
        res.writeHead(204); res.end();
      });
      return;
    }
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Obsidian REST API on http://127.0.0.1:${PORT}/  (vault: ${VAULT})`);
});
