// Basin Ventures OS API proxy
// Run locally: npm install express cors dotenv && node server.js
// Then set Server URL in the app to http://localhost:3000
//
// Why this exists:
// - Groq can be called directly from the browser by the HTML app.
// - Brave Search blocks browser CORS, so Brave profile research must go through this proxy.
// - Tavily and non-Groq AI providers also work best through this proxy.

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'basin-os-api-proxy',
    note: 'Groq can run direct from GitHub Pages. Brave requires this proxy because of browser CORS.'
  });
});

function getKey(body, envName) {
  return body.api_key || body.apiKey || body.key || process.env[envName] || '';
}

async function safeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_err) {
    return { raw: text };
  }
}

app.post('/api/search', async (req, res) => {
  try {
    const apiKey = getKey(req.body, 'TAVILY_API_KEY');
    if (!apiKey) return res.status(400).json({ error: 'Missing Tavily API key' });

    const payload = {
      api_key: apiKey,
      query: req.body.query || req.body.q || '',
      search_depth: req.body.search_depth || 'advanced',
      max_results: Number(req.body.max_results || req.body.count || 5),
      include_answer: Boolean(req.body.include_answer),
      include_raw_content: Boolean(req.body.include_raw_content)
    };

    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await safeJson(r);
    if (!r.ok) return res.status(r.status).json({ error: data.error || data.message || 'Tavily request failed', details: data });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Tavily proxy error' });
  }
});

async function braveHandler(req, res) {
  try {
    const apiKey = getKey(req.body, 'BRAVE_API_KEY');
    if (!apiKey) return res.status(400).json({ error: 'Missing Brave Search API key' });

    const q = req.body.query || req.body.q || '';
    if (!q) return res.status(400).json({ error: 'Missing Brave search query' });

    const count = Math.max(1, Math.min(Number(req.body.count || 5), 20));
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', q);
    url.searchParams.set('count', String(count));
    url.searchParams.set('safesearch', 'moderate');
    url.searchParams.set('text_decorations', 'false');

    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey
      }
    });

    const data = await safeJson(r);
    if (!r.ok) return res.status(r.status).json({ error: data.error || data.message || 'Brave request failed', details: data });

    const results = (data.web && data.web.results ? data.web.results : []).map(item => ({
      title: item.title || '',
      url: item.url || '',
      content: item.description || ''
    }));

    res.json({ results, web: data.web || {}, raw: data });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Brave proxy error' });
  }
}

app.post('/api/brave/search', braveHandler);
app.post('/api/brave', braveHandler);

app.post('/api/ai', async (req, res) => {
  try {
    const provider = req.body.provider || 'openai';
    const apiKey = getKey(req.body, 'AI_API_KEY');
    const model = req.body.model;
    const system = req.body.system || '';
    const messages = req.body.messages || [];

    if (!apiKey) return res.status(400).json({ error: 'Missing AI API key' });

    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model || 'claude-3-5-sonnet-latest',
          max_tokens: 900,
          temperature: 0.35,
          system,
          messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
        })
      });
      const data = await safeJson(r);
      if (!r.ok) return res.status(r.status).json({ error: data.error?.message || data.message || 'Anthropic request failed', details: data });
      return res.json({ text: (data.content || []).map(c => c.text || '').join('') });
    }

    if (provider === 'gemini') {
      const geminiModel = model || 'gemini-1.5-pro';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${system}\n\n${messages.map(m => m.content).join('\n\n')}` }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 900 }
        })
      });
      const data = await safeJson(r);
      if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Gemini request failed', details: data });
      return res.json({ text: data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '' });
    }

    const providerUrls = {
      openai: 'https://api.openai.com/v1/chat/completions',
      deepseek: 'https://api.deepseek.com/chat/completions',
      mistral: 'https://api.mistral.ai/v1/chat/completions',
      groq: 'https://api.groq.com/openai/v1/chat/completions'
    };

    const url = providerUrls[provider];
    if (!url) return res.status(400).json({ error: `Unsupported provider: ${provider}` });

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens: 900,
        messages: [
          { role: 'system', content: system },
          ...messages
        ]
      })
    });

    const data = await safeJson(r);
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || data.message || `${provider} request failed`, details: data });
    res.json({ text: data.choices?.[0]?.message?.content || '' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'AI proxy error' });
  }
});

app.listen(PORT, () => {
  console.log(`Basin OS API proxy running on http://localhost:${PORT}`);
});
