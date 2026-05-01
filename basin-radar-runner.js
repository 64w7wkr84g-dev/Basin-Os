#!/usr/bin/env node
'use strict';

/**
 * Basin OS Scheduled Radar Runner
 *
 * Runs inside GitHub Actions. It searches Brave for high-value Basin ICP signals,
 * scores and deduplicates results, optionally enhances the top 8 with Groq, and
 * writes radar-leads.json for index.html to import through loadScheduledRadarData().
 *
 * Required secret: BRAVE_API_KEY
 * Optional secret: GROQ_API_KEY
 * Optional env:
 *   GROQ_MODEL=llama-3.3-70b-versatile
 *   RADAR_GEO="nationwide USA"
 *   RADAR_MAX_RESULTS=5
 *   RADAR_MAX_QUERIES=18
 *   RADAR_YEAR_TAIL="2025 OR 2026"
 */

const fs = require('fs');
const path = require('path');

const BRAVE_API_KEY = (process.env.BRAVE_API_KEY || '').trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const GEO = (process.env.RADAR_GEO || 'nationwide USA').trim();
const MAX_RESULTS = clamp(Number(process.env.RADAR_MAX_RESULTS || 5), 1, 20);
const MAX_QUERIES = clamp(Number(process.env.RADAR_MAX_QUERIES || 18), 3, 60);
const YEAR_TAIL = (process.env.RADAR_YEAR_TAIL || '2025 OR 2026').trim();
const OUTPUT_FILE = path.join(process.cwd(), 'radar-leads.json');

let fetchImpl = null;

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

async function getFetch() {
  if (fetchImpl) return fetchImpl;
  if (typeof globalThis.fetch === 'function') {
    fetchImpl = globalThis.fetch.bind(globalThis);
    return fetchImpl;
  }
  try {
    const mod = await import('node-fetch');
    fetchImpl = mod.default;
    return fetchImpl;
  } catch (err) {
    throw new Error('No fetch implementation available. Use Node 20+ or install node-fetch.');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeId(prefix = 'rad-gh') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function grade(score) {
  score = Number(score || 0);
  if (score >= 82) return 'A';
  if (score >= 68) return 'B';
  if (score >= 52) return 'C';
  return 'D';
}

function radarQueries() {
  const tail = ` ${GEO} ${YEAR_TAIL}`;
  const q = [];
  function add(source, query, type) {
    q.push({ source, q: query, type, link: `https://www.google.com/search?q=${encodeURIComponent(query)}` });
  }

  // Physicians / medical practice owners
  add('news', `"opened" OR "launches" "medical practice" OR "orthopedic" OR "gastroenterology"${tail}`, 'Physician');
  add('news', `"named partner" OR "joins" physician practice surgeon specialist${tail}`, 'Physician');
  add('directories', `"physician CPA" OR "medical practice CPA" ${GEO}`, 'CPA');

  // Business owners / liquidity / growth signals
  add('news', `"acquired" OR "sold" OR "expands" "business owner" OR founder${tail}`, 'Business Owner');
  add('jobs', `"hiring" "CEO" OR owner "new location" ${GEO}`, 'Business Owner');
  add('directories', `"Inc 5000" founder owner ${GEO}`, 'Business Owner');

  // Attorneys / law partners
  add('news', `"named partner" OR "promoted to partner" "law firm"${tail}`, 'Law Partner');
  add('events', `"estate planning" attorney speaker conference ${GEO}`, 'Law Partner');

  // CPAs / tax advisors
  add('cpa', `"year-end tax planning" CPA "high income" OR "business owners" ${GEO}`, 'CPA');
  add('cpa', `"oil and gas" CPA tax planning IDC depletion ${GEO}`, 'CPA');
  add('directories', `"CPA firm" "physicians" OR "medical practice" ${GEO}`, 'CPA');

  // Energy / Form D / mineral owner adjacency
  add('news', `"oil and gas" executive promoted president VP${tail}`, 'Energy Executive');
  add('formd', `site:sec.gov/Archives/edgar/data "oil and gas" "Form D" ${GEO}`, 'Energy / Form D');
  add('podcasts', `"oil and gas" podcast founder executive ${GEO}`, 'Energy Executive');

  // Cross-channel public signals
  add('linkedin', `site:linkedin.com/in owner CEO founder physician surgeon attorney partner CPA ${GEO}`, 'LinkedIn Search');
  add('events', `conference speaker physician founder attorney CPA ${GEO}`, 'Speaker Signal');
  add('podcasts', `podcast interview founder physician attorney business owner ${GEO}`, 'Media Signal');

  return q.slice(0, MAX_QUERIES);
}

function braveKindForRadar(query) {
  return /news|events|jobs|podcasts|formd/i.test(query.source || '') ? 'news' : 'web';
}

async function braveSearch(query, count, kind = 'web') {
  if (!BRAVE_API_KEY) return [];
  const fetch = await getFetch();
  const base = kind === 'news'
    ? 'https://api.search.brave.com/res/v1/news/search'
    : 'https://api.search.brave.com/res/v1/web/search';
  const url = new URL(base);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(clamp(count || MAX_RESULTS, 1, 20)));
  url.searchParams.set('country', 'US');
  url.searchParams.set('search_lang', 'en');
  url.searchParams.set('safesearch', 'moderate');

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': BRAVE_API_KEY
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Brave ${kind} search failed ${res.status}: ${body.slice(0, 220)}`);
  }

  const data = await res.json();
  const arr = kind === 'news'
    ? (data.results || [])
    : ((data.web && data.web.results) || data.results || []);

  return arr.map(r => ({
    title: cleanText(r.title || r.name || ''),
    link: r.url || r.link || '',
    desc: cleanText(r.description || r.snippet || r.extra_snippets?.join(' ') || '', 700),
    pub: r.age || r.page_age || r.published_time || ''
  })).filter(r => r.title || r.link);
}

function stripSourceTitle(title) {
  return cleanText(title, 240)
    .replace(/\s+-\s+[^-]+$/, '')
    .replace(/\s+\|\s+.*$/, '')
    .trim();
}

function inferRadarRole(text, type) {
  const s = String(`${text || ''} ${type || ''}`).toLowerCase();
  if (/surgeon|orthopedic|gastro|physician|doctor|md\b|medical|clinic|practice/.test(s)) return 'Physician / Medical Practice';
  if (/cpa|accounting|tax/.test(s)) return 'CPA / Tax Advisor';
  if (/attorney|law firm|partner|counsel|estate planning/.test(s)) return 'Attorney / Law Partner';
  if (/founder|ceo|owner|president|acquired|expands|business/.test(s)) return 'Business Owner / Executive';
  if (/real estate|developer/.test(s)) return 'Real Estate Developer';
  if (/oil|gas|energy|mineral|royalty|form d|regulation d/.test(s)) return 'Energy Executive / Mineral Owner';
  return type || 'Prospect Signal';
}

function inferRadarType(role) {
  return /cpa|tax advisor|accounting/i.test(role || '') ? 'cpa' : 'investor';
}

function inferSignal(text) {
  const s = String(text || '').toLowerCase();
  if (/named partner|promoted|joins/.test(s)) return 'Recent promotion / partner signal';
  if (/open|launch|new practice|new clinic|new location/.test(s)) return 'New practice / business opening';
  if (/acquir|sold|merger|business sale/.test(s)) return 'Acquisition / sale signal';
  if (/speaker|conference|panel|webinar|podcast|interview/.test(s)) return 'Authority / public platform signal';
  if (/hiring|expands|growth|inc 5000/.test(s)) return 'Growth / hiring signal';
  if (/tax|cpa|deduction|year-end|depletion|idc/.test(s)) return 'Tax planning signal';
  if (/form d|regulation d|private placement|sec\.gov/.test(s)) return 'Form D / private placement signal';
  return 'Public web/news signal';
}

function extractCompanySignal(title) {
  const t = String(title || '');
  const patterns = [
    /(?:at|with|joins|opens|launches|acquires|by)\s+([A-Z][A-Za-z0-9 &.,'’\-]{2,70})/,
    /([A-Z][A-Za-z0-9 &.,'’\-]{2,70})\s+(?:opens|launches|acquires|names|promotes)/
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return cleanText(m[1].replace(/\s+(in|as|for|after|with)\s+.*/i, ''), 90);
  }
  return '';
}

function extractEmail(text) {
  const m = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : '';
}

function extractLinkedIn(text) {
  const m = String(text || '').match(/https?:\/\/(www\.)?linkedin\.com\/[^\s"')]+/i);
  return m ? m[0] : '';
}

function scoreRadarLead(lead) {
  const blob = [
    lead.name, lead.title, lead.company, lead.summary, lead.signal,
    lead.source, lead.email, lead.linkedin, lead.sourceQuery, lead.url
  ].join(' ').toLowerCase();

  let s = 44;
  const signals = [];
  function bump(condition, points, label) {
    if (condition) {
      s += points;
      signals.push(`${label} +${points}`);
    }
  }

  bump(/physician|surgeon|orthopedic|gastro|doctor|medical practice|clinic/.test(blob), 25, 'Physician / medical ICP');
  bump(/owner|ceo|founder|president|business owner|entrepreneur/.test(blob), 22, 'Business owner / founder ICP');
  bump(/partner|attorney|law firm|estate planning/.test(blob), 18, 'Attorney / law partner ICP');
  bump(/cpa|tax advisor|accounting/.test(blob), 18, 'CPA / tax advisor ICP');
  bump(/acquired|sold|opened|launch|named partner|promoted|speaker|conference|podcast|interview/.test(blob), 10, 'Trigger event detected');
  bump(/tax|deduction|year-end|idc|depletion|high income/.test(blob), 10, 'Tax motivation signal');
  bump(/form d|regulation d|private placement|sec\.gov/.test(blob), 12, 'Accredited investor / Form D signal');
  bump(/bizbuysell|businessbroker|business for sale|exit/.test(blob), 10, 'Liquidity / business-sale signal');
  bump(/linkedin\.com\/posts|site:linkedin\.com|linkedin\.com\/in/.test(blob), 6, 'Public LinkedIn intent signal');
  bump(/@|linkedin\.com/.test(blob), 5, 'Contact channel present');

  lead.scoreSignals = signals.slice(0, 7);
  return Math.max(1, Math.min(98, s));
}

function generateNurtureDraft(lead) {
  const name = lead.name || 'there';
  const signal = lead.signal || 'public signal';
  const source = lead.sourceFeed || lead.source || 'public source';
  return {
    emailSubject: `Quick Basin Ventures intro`,
    email: `Hi ${name},\n\nI saw the ${signal.toLowerCase()} tied to ${source}. I’m with Basin Ventures in Southlake, and we help accredited investors evaluate direct, tax-advantaged oil and gas ownership.\n\nThis may or may not be relevant, but if you ever look at alternatives that can pair with CPA-led tax planning, it may be worth a short intro. We always recommend reviewing any tax angle with your CPA.\n\nWorth a brief 15-20 minute conversation next week?`,
    linkedin: `Hi ${name} — saw the ${signal.toLowerCase()} and wanted to connect. I’m with Basin Ventures in Southlake; we help accredited investors evaluate direct oil & gas opportunities.`
  };
}

function leadFromBraveItem(item, query) {
  const title = stripSourceTitle(item.title);
  const summary = cleanText(item.desc || title, 500);
  const role = inferRadarRole(`${title} ${summary}`, query.type);
  const lead = {
    id: safeId(),
    name: title || query.type,
    company: extractCompanySignal(title),
    title: role,
    location: GEO,
    type: inferRadarType(role),
    signal: inferSignal(`${title} ${summary}`),
    source: query.source || 'brave',
    sourceFeed: query.type || query.source || 'Brave Search',
    sourceDate: item.pub || '',
    sourceQuery: query.q,
    url: item.link || query.link || '',
    summary,
    email: extractEmail(summary),
    linkedin: extractLinkedIn(`${summary} ${item.link || ''}`),
    status: 'New',
    foundAt: new Date().toISOString(),
    runner: 'github-actions'
  };
  lead.score = scoreRadarLead(lead);
  lead.grade = grade(lead.score);
  lead.nurture = generateNurtureDraft(lead);
  return lead;
}

function leadKey(lead) {
  const url = String(lead.url || '').trim().toLowerCase();
  if (url) return url.replace(/[#?].*$/, '');
  return [lead.name, lead.company, lead.sourceFeed].join('|').toLowerCase().replace(/[^a-z0-9|]+/g, '');
}

function dedupeLeads(leads) {
  const seen = new Set();
  const out = [];
  for (const lead of leads) {
    const key = leadKey(lead);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(lead);
  }
  return out;
}

function safeJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

async function groqAnalyzeLead(lead) {
  if (!GROQ_API_KEY) return lead;
  const fetch = await getFetch();
  const payload = {
    model: GROQ_MODEL,
    temperature: 0.15,
    max_completion_tokens: 900,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You are a Basin Ventures accredited-investor lead analyst. JSON only. Score the lead 0-100. Never invent facts. Do not guarantee returns. Do not call anything SEC registered.'
      },
      {
        role: 'user',
        content: 'Analyze this lead and return JSON {"score":0,"grade":"A/B/C/D","confidence":"High/Medium/Low","bestAngle":"","riskFlags":[],"nextAction":""}. Lead: ' + JSON.stringify(lead).slice(0, 3500)
      }
    ]
  };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Groq analysis failed ${res.status}: ${body.slice(0, 220)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = safeJSON(content);
  if (!parsed) return lead;

  lead.ai = parsed;
  lead.groqAnalyzedAt = new Date().toISOString();
  if (Number(parsed.score)) {
    lead.score = Math.max(Number(lead.score || 0), Number(parsed.score));
    lead.grade = grade(lead.score);
  }
  if (parsed.confidence) lead.confidence = parsed.confidence;
  if (parsed.bestAngle) lead.aiAngle = parsed.bestAngle;
  if (parsed.nextAction) lead.nextAction = parsed.nextAction;
  return lead;
}

async function run() {
  const startedAt = new Date().toISOString();
  const queries = radarQueries();
  const all = [];

  console.log(`Basin Radar Runner started ${startedAt}`);
  console.log(`Geo: ${GEO}`);
  console.log(`Queries: ${queries.length}`);
  console.log(`Brave enabled: ${BRAVE_API_KEY ? 'yes' : 'no'}`);
  console.log(`Groq enabled: ${GROQ_API_KEY ? 'yes' : 'no'}`);

  if (!BRAVE_API_KEY) {
    console.warn('BRAVE_API_KEY is missing. Writing empty radar-leads.json so the workflow does not fail.');
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2));
    return;
  }

  for (const query of queries) {
    const kind = braveKindForRadar(query);
    try {
      const results = await braveSearch(query.q, MAX_RESULTS, kind);
      const leads = results.map(item => leadFromBraveItem(item, query));
      all.push(...leads);
      console.log(`${query.type} / ${query.source}: ${leads.length} results`);
    } catch (err) {
      console.warn(`${query.type} / ${query.source} failed: ${err.message}`);
    }
    await sleep(350);
  }

  let leads = dedupeLeads(all)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 100);

  if (GROQ_API_KEY && leads.length) {
    const top = leads.slice(0, 8);
    for (let i = 0; i < top.length; i++) {
      try {
        await groqAnalyzeLead(top[i]);
        console.log(`Groq analyzed ${i + 1}/${top.length}: ${top[i].name}`);
      } catch (err) {
        console.warn(`Groq skipped ${top[i].name}: ${err.message}`);
      }
      await sleep(250);
    }
    leads = leads.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  const generatedAt = new Date().toISOString();
  leads = leads.map((lead, index) => ({
    ...lead,
    rank: index + 1,
    generatedAt,
    source: lead.source || 'GitHub Actions Radar',
    foundAt: lead.foundAt || generatedAt
  }));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(leads, null, 2));
  console.log(`Wrote ${leads.length} leads to ${OUTPUT_FILE}`);
}

run().catch(err => {
  console.error(err);
  try {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2));
  } catch (_) {}
  process.exitCode = 1;
});
