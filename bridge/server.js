#!/usr/bin/env node
/*
 * Local bridge between the Obsidian "Local REST API" community plugin and the
 * XENEON EDGE "Obsidian Action Items" widget.
 *
 * Why this exists: the widget runs inside iCUE's sandboxed webview with no filesystem
 * access, and the Obsidian REST API plugin doesn't send CORS headers, so the widget
 * can't safely call it directly. This script is a tiny same-machine relay: it holds the
 * Obsidian API key, exposes a CORS-friendly JSON API on 127.0.0.1, and does the
 * note-finding / section-parsing / checkbox-toggling.
 *
 * It targets the newest weekly "Action Items - YYYYMMDD" note in your inbox folder,
 * parses it into sections (## headings) of nested checkbox items, and lets you close
 * items out (checks them off in the note in place).
 *
 * Zero dependencies - Node's built-in modules only. Cross-platform (Windows/macOS/Linux).
 *
 * Usage:
 *   node server.js
 *   node server.js --config /path/to/config.json
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig() {
  const argIdx = process.argv.indexOf('--config');
  const configPath = argIdx !== -1 && process.argv[argIdx + 1]
    ? process.argv[argIdx + 1]
    : path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (cfg.obsidianApiKey === 'PUT-YOUR-API-KEY-HERE') {
    console.warn("WARNING: config.json still has the placeholder API key. Set obsidianApiKey from Obsidian -> Settings -> Local REST API.");
  }
  // Tolerate a pasted "Bearer <key>" - we add the Bearer prefix ourselves.
  if (typeof cfg.obsidianApiKey === 'string') {
    cfg.obsidianApiKey = cfg.obsidianApiKey.replace(/^Bearer\s+/i, '').trim();
  }
  return cfg;
}

const config = loadConfig();
let taskCache = {};

// Obsidian Tasks-plugin metadata markers (due date, priorities, recurrence, etc).
// We strip these from an item's displayed text and pull the due date out separately.
const DUE_EMOJI = '📅';
const TASK_EMOJI = ['📅', '⏫', '🔺', '🔼', '🔽', '⏬', '🛫', '➕', '✅', '🔁', '⏳', '❌', '🚫', '🆔'];
const TASK_EMOJI_RE = new RegExp('\\s*(' + TASK_EMOJI.map(escapeRegex).join('|') + ').*$');
const DUE_RE = new RegExp(escapeRegex(DUE_EMOJI) + '\\s*(\\d{4}-\\d{2}-\\d{2})');

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// Obsidian REST API client
// ---------------------------------------------------------------------------
function obsidianRequest(method, apiPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const base = new URL(config.obsidianBaseUrl);
    const isHttps = base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: '/' + apiPath.replace(/^\//, ''),
      method,
      headers: Object.assign({ Authorization: `Bearer ${config.obsidianApiKey}` }, headers),
    };
    if (isHttps && config.insecureTls) options.rejectUnauthorized = false;

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, text });
        } else {
          reject(new Error(`Obsidian ${method} ${apiPath} -> HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`Cannot reach Obsidian REST API at ${config.obsidianBaseUrl} (${e.message})`)));
    if (body != null) req.write(body);
    req.end();
  });
}

function encodeVaultPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function stableId(file, lineIndex, line) {
  // Line index is part of the key so two byte-identical task lines get distinct ids.
  return crypto.createHash('sha256').update(`${file}|${lineIndex}|${line}`, 'utf8')
    .digest('hex').slice(0, 16);
}

function obsidianUri(file) {
  const fileNoExt = file.replace(/\.md$/, '');
  return `obsidian://open?vault=${encodeURIComponent(config.vaultName)}&file=${encodeURIComponent(fileNoExt)}`;
}

async function getVaultFileContent(file) {
  const res = await obsidianRequest('GET', `vault/${encodeVaultPath(file)}`, { headers: { Accept: 'text/markdown' } });
  return res.text;
}

async function setVaultFileContent(file, content) {
  await obsidianRequest('PUT', `vault/${encodeVaultPath(file)}`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    body: Buffer.from(content, 'utf8'),
  });
}

async function findActiveNote() {
  const folder = config.actionItemsFolder.replace(/^\/+|\/+$/g, '');
  const res = await obsidianRequest('GET', `vault/${encodeVaultPath(folder)}/`);
  const listing = JSON.parse(res.text);
  const files = (listing.files || []).filter(
    (f) => f.startsWith(config.actionItemsPrefix) && f.endsWith('.md')
  );
  if (files.length === 0) {
    throw new Error(`No notes starting with '${config.actionItemsPrefix}' found in '${folder}'.`);
  }
  files.sort().reverse();
  return `${folder}/${files[0]}`;
}

// ---------------------------------------------------------------------------
// Note parsing
// ---------------------------------------------------------------------------
async function parseNote(file) {
  const content = await getVaultFileContent(file);
  const lines = content.split(/\r?\n/);

  let title = file.split('/').pop().replace(/\.md$/, '');
  let inFrontmatter = false;
  const sections = [];
  let current = null;
  const cache = {};
  let openCount = 0;

  const newSection = (name) => ({ name, items: [] });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i === 0 && line === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false;
      else {
        const m = line.match(/^title:\s*(.+)$/);
        if (m) title = m[1].trim().replace(/^['"]|['"]$/g, '');
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (heading[1].length === 1) continue; // keep the H1 as the note title only
      const name = heading[2].replace(/\s*[—-]+\s*DELETE\s*$/, '').trim();
      current = newSection(name);
      sections.push(current);
      continue;
    }

    const cb = line.match(/^([\t ]*)- \[([ xX])\]\s+(.*)$/);
    if (cb) {
      if (!current) { current = newSection('General'); sections.push(current); }
      const done = cb[2] !== ' ';
      if (done) continue; // only surface open items; closing one drops it from the list

      const ws = cb[1];
      const tabs = (ws.match(/\t/g) || []).length;
      const spaces = ws.replace(/\t/g, '').length;
      let level = tabs + Math.floor(spaces / 2);
      if (level > 4) level = 4;

      const raw = cb[3];
      let due = null;
      const dm = raw.match(DUE_RE);
      if (dm) due = dm[1];

      const PRIORITY_EMOJI_MAP = { '🔺': 'highest', '⏫': 'high', '🔼': 'medium', '🔽': 'low', '⏬': 'lowest' };
      let priority = null;
      for (const [emoji, level_] of Object.entries(PRIORITY_EMOJI_MAP)) {
        if (raw.includes(emoji)) { priority = level_; break; }
      }

      let display = raw.replace(TASK_EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
      if (!display) display = raw.trim();

      const id = stableId(file, i, line);
      cache[id] = { file, lineIndex: i, lineText: line };
      openCount++;

      current.items.push({ id, text: display, level, due, priority });
    }
  }

  taskCache = cache;
  // Include all sections (even empty ones) so the widget can add tasks to them.
  return { note: file, title, obsidianUri: obsidianUri(file), openCount, sections };
}

async function addTaskToNote(section, text, due, priority) {
  const file = await findActiveNote();
  const content = await getVaultFileContent(file);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  let sectionLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      const name = m[2].replace(/\s*[—-]+\s*DELETE\s*$/, '').trim();
      if (name === section) { sectionLine = i; break; }
    }
  }
  if (sectionLine === -1) throw new Error(`Section "${section}" not found in the note.`);

  let nextSection = lines.length;
  for (let i = sectionLine + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { nextSection = i; break; }
  }

  // Insert after the last non-blank line inside the section (or right after the heading).
  let insertAfter = sectionLine;
  for (let i = sectionLine + 1; i < nextSection; i++) {
    if (lines[i].trim() !== '') insertAfter = i;
  }

  const PRIORITY_EMOJI = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' };
  let taskLine = `- [ ] ${text}`;
  if (priority && PRIORITY_EMOJI[priority]) taskLine += ` ${PRIORITY_EMOJI[priority]}`;
  if (due) taskLine += ` 📅 ${due}`;

  lines.splice(insertAfter + 1, 0, taskLine);
  await setVaultFileContent(file, lines.join(eol));
  taskCache = {};
}

async function addSectionToNote(name) {
  const file = await findActiveNote();
  const content = await getVaultFileContent(file);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  await setVaultFileContent(file, content.trimEnd() + eol + eol + `## ${name}` + eol);
  taskCache = {};
}

async function updateTask(id, text, due, priority) {
  const entry = taskCache[id];
  if (!entry) throw new Error('Unknown task id (list may be stale) — refresh and try again.');

  const content = await getVaultFileContent(entry.file);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  if (entry.lineIndex >= lines.length || lines[entry.lineIndex] !== entry.lineText) {
    throw new Error('Note changed since last refresh — refresh and try again.');
  }
  // Preserve the original indent + checkbox state ("- [ ] " or "- [x] ")
  const prefix = lines[entry.lineIndex].match(/^([\t ]*- \[[ xX]\] )/);
  if (!prefix) throw new Error('Could not parse task line.');

  const PRIORITY_EMOJI = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' };
  let newLine = prefix[1] + text;
  if (priority && PRIORITY_EMOJI[priority]) newLine += ` ${PRIORITY_EMOJI[priority]}`;
  if (due) newLine += ` 📅 ${due}`;

  lines[entry.lineIndex] = newLine;
  await setVaultFileContent(entry.file, lines.join(eol));
  taskCache[id] = { file: entry.file, lineIndex: entry.lineIndex, lineText: newLine };
}

async function setTaskDone(id, done) {
  const entry = taskCache[id];
  if (!entry) throw new Error('Unknown task id (list may be stale) - refresh and try again.');

  const content = await getVaultFileContent(entry.file);
  // Toggle the specific line by index (never a global text replace - identical task
  // lines elsewhere in the note must not be flipped together). Preserve newline style.
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  if (entry.lineIndex >= lines.length || lines[entry.lineIndex] !== entry.lineText) {
    throw new Error('That note changed since the last refresh - refresh and try again.');
  }
  const m = lines[entry.lineIndex].match(/^([\t ]*- \[)[ xX](\]\s+.*)$/);
  if (!m) throw new Error('Could not parse checkbox line.');

  const rebuilt = m[1] + (done ? 'x' : ' ') + m[2];
  lines[entry.lineIndex] = rebuilt;

  await setVaultFileContent(entry.file, lines.join(eol));
  taskCache[id] = { file: entry.file, lineIndex: entry.lineIndex, lineText: rebuilt };
}

// ---------------------------------------------------------------------------
// HTTP server (widget-facing)
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (route === 'GET /api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'GET /api/tasks') {
      try {
        const note = await findActiveNote();
        const result = await parseNote(note);
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 502, { error: `Could not load action items: ${e.message}` });
      }
    }

    if (route === 'POST /api/tasks/toggle') {
      try {
        const body = JSON.parse(await readBody(req));
        const done = body.done === undefined ? true : Boolean(body.done);
        await setTaskDone(body.id, done);
        return sendJson(res, 200, { ok: true, id: body.id });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (route === 'POST /api/tasks/add') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.section || !body.text) throw new Error('section and text are required.');
        await addTaskToNote(body.section.trim(), body.text.trim(), body.due || null, body.priority || null);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (route === 'POST /api/tasks/update') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.id || !body.text) throw new Error('id and text are required.');
        await updateTask(body.id, body.text.trim(), body.due || null, body.priority || null);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (route === 'POST /api/sections/add') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.name || !body.name.trim()) throw new Error('name is required.');
        await addSectionToNote(body.name.trim());
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    try { sendJson(res, 500, { error: e.message }); } catch (_) { /* ignore */ }
  }
});

server.listen(config.listenPort, '127.0.0.1', () => {
  console.log(`Obsidian Action Items bridge listening on http://127.0.0.1:${config.listenPort}/ (Ctrl+C to stop)`);
});
