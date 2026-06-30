#!/usr/bin/env node
/*
 * Tiny static file server, used only to preview widget/index.html in a regular browser
 * during development (the real XENEON EDGE/iCUE runtime loads these files directly; this
 * is just for local UI testing).
 *
 * Usage:
 *   node static-server.js [--port 4321] [--root ../widget]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = parseInt(arg('--port', '4321'), 10);
const ROOT = path.resolve(arg('--root', path.join(__dirname, '..', 'widget')));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  const full = path.join(ROOT, rel);
  // Stay within ROOT.
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    const type = MIME[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    return res.end(fs.readFileSync(full));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(`Not found: ${rel}`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Static preview server on http://127.0.0.1:${PORT}/  (root: ${ROOT})`);
});
