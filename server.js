const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'Basin OS proxy' }));

app.post('/api/search', async (req, res) => {
  try {
    const { api_key, query, search_depth, max_results, include_answer, include_raw_content } = req.body || {};
    if (!api_key) return res.status(400).json({ error: 'Missing Tavily API key' });
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api_key}` },
      body: JSON.stringify({ api_key, query, search_depth: search_depth || 'advanced', max_results: max_results || 5, include_answer: !!include_answer, include_raw_content: !!include_raw_content })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error || data.detail || 'Tavily request failed', data });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Search proxy error' });
  }
});

app.post('/api/ai', async (req, res) => {
  try {
    const { provider, apiKey, model, system, messages } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: 'Missing AI API key' });
    const userMessages = Array.isArray(messages) ? messages : [];
    let r, data, text = '';

    if (['groq', 'openai', 'deepseek', 'mistral'].includes(provider)) {
      const endpoints = {
        groq: 'https://api.groq.com/openai/v1/chat/completions',
        openai: 'https://api.openai.com/v1/chat/completions',
        deepseek: 'https://api.deepseek.com/v1/chat/completions',
        mistral: 'https://api.mistral.ai/v1/chat/completions'
      };
      const bodyMessages = system ? [{ role: 'system', content: system }, ...userMessages] : userMessages;
      r = await fetch(endpoints[provider], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: bodyMessages, temperature: 0.4 })
      });
      data = await r.json();
      text = data.choices?.[0]?.message?.content || '';
    } else if (provider === 'anthropic') {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, system: system || undefined, messages: userMessages, max_tokens: 1200 })
      });
      data = await r.json();
      text = data.content?.map(p => p.text || '').join('') || '';
    } else if (provider === 'gemini') {
      const prompt = (system ? system + '\n\n' : '') + userMessages.map(m => m.content).join('\n');
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      data = await r.json();
      text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    } else {
      return res.status(400).json({ error: 'Unsupported AI provider' });
    }

    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || data.message || 'AI request failed', data });
    res.json({ text, raw: data });
  } catch (err) {
    res.status(500).json({ error: err.message || 'AI proxy error' });
  }
});

app.listen(PORT, () => console.log(`Basin OS running at http://localhost:${PORT}`));
