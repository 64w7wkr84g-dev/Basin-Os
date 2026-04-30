/*
  Basin Ventures Lead Generation System
  Local API proxy for Tavily + AI providers.
  Run:
    npm install
    node server.js
  Open:
    http://localhost:3000
*/

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

function safeError(err) {
  const msg = err && err.message ? err.message : String(err || 'Unknown error');
  return msg.slice(0, 500);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const providerMessage = data.error?.message || data.error || data.message || data.raw || `HTTP ${res.status}`;
    throw new Error(typeof providerMessage === 'string' ? providerMessage : JSON.stringify(providerMessage));
  }
  return data;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'basin-local-proxy', version: '2.0.0', time: new Date().toISOString() });
});

app.post('/api/search', async (req, res) => {
  try {
    const apiKey = req.body.api_key || req.body.apiKey;
    const query = req.body.query;
    if (!apiKey) return res.status(400).json({ error: 'Missing Tavily API key.' });
    if (!query) return res.status(400).json({ error: 'Missing search query.' });

    const payload = {
      api_key: apiKey,
      query,
      search_depth: req.body.search_depth || 'advanced',
      max_results: Number(req.body.max_results || 5),
      include_answer: Boolean(req.body.include_answer),
      include_raw_content: Boolean(req.body.include_raw_content),
      include_images: Boolean(req.body.include_images)
    };

    const data = await fetchJson('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

function openAICompatibleEndpoint(provider) {
  const endpoints = {
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
    mistral: 'https://api.mistral.ai/v1/chat/completions'
  };
  return endpoints[provider];
}

app.post('/api/ai', async (req, res) => {
  try {
    const provider = req.body.provider;
    const apiKey = req.body.apiKey || req.body.api_key;
    const model = req.body.model;
    const system = req.body.system || '';
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];

    if (!provider) return res.status(400).json({ error: 'Missing AI provider.' });
    if (!apiKey) return res.status(400).json({ error: 'Missing AI API key.' });
    if (!model) return res.status(400).json({ error: 'Missing AI model.' });
    if (!messages.length) return res.status(400).json({ error: 'Missing messages.' });

    if (['groq', 'openai', 'deepseek', 'mistral'].includes(provider)) {
      const endpoint = openAICompatibleEndpoint(provider);
      const payloadMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const data = await fetchJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: payloadMessages, temperature: 0.35 })
      });
      const text = data.choices?.[0]?.message?.content || '';
      return res.json({ text, raw: data });
    }

    if (provider === 'anthropic') {
      const data = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model, system, messages, max_tokens: 1800, temperature: 0.35 })
      });
      const text = Array.isArray(data.content) ? data.content.map(c => c.text || '').join('\n') : '';
      return res.json({ text, raw: data });
    }

    if (provider === 'gemini') {
      const prompt = [system, ...messages.map(m => `${m.role || 'user'}: ${m.content || ''}`)].filter(Boolean).join('\n\n');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.35 } })
      });
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n') || '';
      return res.json({ text, raw: data });
    }

    res.status(400).json({ error: `Unsupported provider: ${provider}` });
  } catch (err) {
    res.status(500).json({ error: safeError(err) });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Basin Ventures Lead System running at http://localhost:${PORT}`);
  console.log('If using your phone on the same Wi-Fi, open http://YOUR-COMPUTER-IP:3000');
});
