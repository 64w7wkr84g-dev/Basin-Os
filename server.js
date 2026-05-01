#!/usr/bin/env node
'use strict';

// Optional local proxy for testing Tavily from your browser.
// GitHub Pages will not run this file. GitHub Actions uses basin-radar-runner.js directly.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim();

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}
function serveStatic(req, res) {
  let file = req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].replace(/^\/+/, '');
  file = path.join(process.cwd(), file);
  if (!file.startsWith(process.cwd())) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.json' ? 'application/json' : 'text/plain';
    send(res, 200, data, type);
  });
}
async function handleTavily(req, res) {
  let raw = '';
  req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = raw ? JSON.parse(raw) : {};
      const key = body.apiKey || TAVILY_API_KEY;
      if (!key) return send(res, 400, JSON.stringify({ error: 'Missing TAVILY_API_KEY' }));
      delete body.apiKey;
      const upstream = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body)
      });
      const txt = await upstream.text();
      send(res, upstream.status, txt);
    } catch (err) {
      send(res, 500, JSON.stringify({ error: String(err.message || err) }));
    }
  });
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.url.startsWith('/api/tavily/search') && req.method === 'POST') return handleTavily(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => console.log(`Basin OS local server running at http://localhost:${PORT}`));
