// Basin OS local Brave Search proxy
// Purpose: lets your GitHub Pages index.html call Brave Search from your own computer without browser CORS blocking.
// Run locally with: npm install && npm start

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8787;
const BRAVE_BASE = 'https://api.search.brave.com/res/v1';

app.use(cors({
  origin: true,
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'X-Subscription-Token']
}));

app.use(express.static(__dirname));

function getBraveKey(req) {
  return process.env.BRAVE_API_KEY || req.get('X-Subscription-Token') || '';
}

async function proxyBrave(req, res, bravePath) {
  try {
    const key = getBraveKey(req);
    if (!key) {
      return res.status(400).json({ error: 'Missing Brave API key. Add BRAVE_API_KEY to .env or connect Brave inside Basin OS.' });
    }

    const params = new URLSearchParams(req.query);
    const url = `${BRAVE_BASE}/${bravePath}?${params.toString()}`;
    const upstream = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': key
      }
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}

app.get('/api/brave/web/search', (req, res) => proxyBrave(req, res, 'web/search'));
app.get('/api/brave/news/search', (req, res) => proxyBrave(req, res, 'news/search'));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Basin OS Brave proxy', port: PORT });
});

app.listen(PORT, () => {
  console.log(`Basin OS local proxy running at http://localhost:${PORT}`);
  console.log(`Open the app locally at http://localhost:${PORT}/index.html`);
});
