#!/usr/bin/env node
'use strict';

/**
 * Basin OS Scheduled Radar Runner — Tavily + Groq
 *
 * Runs inside GitHub Actions. It searches Tavily for high-value Basin ICP signals,
 * scores and deduplicates results, optionally enhances the top 8 with Groq, and
 * writes radar-leads.json plus data/radar-leads.json for index.html to import.
 *
 * Required GitHub secret: TAVILY_API_KEY
 * Optional GitHub secret: GROQ_API_KEY
 * Optional env:
 *   GROQ_MODEL=llama-3.3-70b-versatile
 *   RADAR_GEO="nationwide USA"
 *   RADAR_MAX_RESULTS=5
 *   RADAR_MAX_QUERIES=18
 *   RADAR_YEAR_TAIL="2025 OR 2026"
 */

const fs = require('fs');
const path = require('path');

const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const GEO = (process.env.RADAR_GEO || 'nationwide USA').trim();
const MAX_RESULTS = clamp(Number(process.env.RADAR_MAX_RESULTS || 5), 1, 20);
const MAX_QUERIES = clamp(Number(process.env.RADAR_MAX_QUERIES || 18), 3, 60);
const YEAR_TAIL = (process.env.RADAR_YEAR_TAIL || '2025 OR 2026').trim();
const OUTPUT_FILE = path.join(process.cwd(), 'radar-leads.json');
const DATA_OUTPUT_FILE = path.join(process.cwd(), 'data', 'radar-leads.json');

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function cleanText(value, max = 700) {
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

  add('news', `"opened" OR "launches" "medical practice" OR "orthopedic" OR "gastroenterology"${tail}`, 'Physician');
  add('news', `"named partner" OR "joins" physician practice surgeon specialist${tail}`, 'Physician');
  add('directories', `"physician CPA" OR "medical practice CPA" ${GEO}`, 'CPA');
  add('news', `"acquired" OR "sold" OR "expands" "business owner" OR founder${tail}`, 'Business Owner');
  add('jobs', `"hiring" "CEO" OR owner "new location" ${GEO}`, 'Business Owner');
  add('directories', `"Inc 5000" founder owner ${GEO}`, 'Business Owner');
  add('news', `"named partner" OR "promoted to partner" "law firm"${tail}`, 'Law Partner');
  add('events', `"estate planning" attorney speaker conference ${GEO}`, 'Law Partner');
  add('cpa', `"year-end tax planning" CPA "high income" OR "business owners" ${GEO}`, 'CPA');
  add('cpa', `"oil and gas" CPA tax planning IDC depletion ${GEO}`, 'CPA');
  add('directories', `"CPA firm" "physicians" OR "medical practice" ${GEO}`, 'CPA');
  add('news', `"oil and gas" executive promoted president VP${tail}`, 'Energy Executive');
  add('formd', `site:sec.gov/Archives/edgar/data "oil and gas" "Form D" ${GEO}`, 'Energy / Form D');
  add('podcasts', `"oil and gas" podcast founder executive ${GEO}`, 'Energy Executive');
  add('linkedin', `site:linkedin.com/in owner CEO founder physician surgeon attorney partner CPA ${GEO}`, 'LinkedIn Search');
  add('events', `conference speaker physician founder attorney CPA ${GEO}`, 'Speaker Signal');
  add('podcasts', `podcast interview founder physician attorney business owner ${GEO}`, 'Media Signal');
  add('owners', `"business sale" OR "exit" founder owner "cash flow" ${GEO}`, 'Business Owner');

  return q.slice(0, MAX_QUERIES);
}
function topicForRadar(query) { return /news|events|jobs|podcasts|formd/i.test(query.source || '') ? 'news' : 'general'; }

async function tavilySearch(query, count, topic = 'general') {
  if (!TAVILY_API_KEY) return [];
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      query,
      topic,
      search_depth: topic === 'news' ? 'advanced' : 'basic',
      max_results: clamp(count || MAX_RESULTS, 1, 20),
      include_answer: false,
      include_raw_content: false,
      include_images: false
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Tavily search failed ${res.status}: ${body.slice(0, 220)}`);
  }
  const data = await res.json();
  return (data.results || []).map(r => ({
    title: cleanText(r.title || ''),
    link: r.url || '',
    desc: cleanText(r.content || r.description || '', 900),
    pub: r.published_date || '',
    tavilyScore: r.score || 0
  })).filter(r => r.title || r.link);
}

function stripSourceTitle(title) {
  return cleanText(title, 240).replace(/\s+-\s+[^-]+$/, '').replace(/\s+\|\s+.*$/, '').trim();
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
function inferRadarType(role) { return /cpa|tax advisor|accounting/i.test(role || '') ? 'cpa' : 'investor'; }
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
  const patterns = [/(?:at|with|joins|opens|launches|acquires|by)\s+([A-Z][A-Za-z0-9 &.,'’\-]{2,70})/, /([A-Z][A-Za-z0-9 &.,'’\-]{2,70})\s+(?:opens|launches|acquires|names|promotes)/];
  for (const p of patterns) { const m = t.match(p); if (m) return cleanText(m[1].replace(/\s+(in|as|for|after|with)\s+.*/i, ''), 90); }
  return '';
}
function extractEmail(text) { const m = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); return m ? m[0] : ''; }
function extractLinkedIn(text) { const m = String(text || '').match(/https?:\/\/(www\.)?linkedin\.com\/[^\s"')]+/i); return m ? m[0] : ''; }

function scoreRadarLead(lead) {
  const blob = [lead.name, lead.title, lead.company, lead.summary, lead.signal, lead.source, lead.email, lead.linkedin, lead.sourceQuery, lead.url].join(' ').toLowerCase();
  let s = 44;
  const signals = [];
  function bump(condition, points, label) { if (condition) { s += points; signals.push(`${label} +${points}`); } }
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
  bump(/tavily/.test(blob), 2, 'Tavily web signal');
  lead.scoreSignals = signals.slice(0, 7);
  return Math.max(1, Math.min(98, s));
}
function generateNurtureDraft(lead) {
  const first = (lead.name || 'there').split(/\s+/)[0];
  return `Hi ${first},\n\nI came across ${lead.signal || 'a public signal'} and thought Basin Ventures may be relevant if direct energy ownership, quarterly distributions, or potential IDC deductions are worth understanding. This is not tax advice; your CPA should review anything specific to your situation.\n\nWould a short director call be useful?`;
}
function leadFromResult(result, query) {
  const title = stripSourceTitle(result.title || '');
  const text = [result.title, result.desc, result.link, query.q, query.type].join(' ');
  const role = inferRadarRole(text, query.type);
  const lead = {
    id: safeId('rad-gh'),
    name: title || 'Tavily Signal',
    title: role,
    company: extractCompanySignal(title),
    location: GEO,
    type: inferRadarType(role),
    source: 'GitHub Actions · Tavily',
    sourceFeed: query.source,
    sourceQuery: query.q,
    sourceUrl: result.link || query.link,
    url: result.link || '',
    signal: inferSignal(text),
    summary: cleanText(result.desc || title, 900),
    email: extractEmail(text),
    linkedin: extractLinkedIn(text),
    status: 'New',
    reviewed: false,
    foundAt: new Date().toISOString(),
    ts: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
    confidence: result.tavilyScore ? 'Medium' : 'Low',
    evidenceTrail: [result.link || query.link].filter(Boolean),
    sourceConfidence: result.link ? 'Medium' : 'Low',
    raw: { title: result.title, desc: result.desc, pub: result.pub, tavilyScore: result.tavilyScore, query: query.q }
  };
  lead.score = scoreRadarLead(lead);
  lead.grade = grade(lead.score);
  lead.nurtureDraft = generateNurtureDraft(lead);
  lead.nextAction = lead.grade === 'A' ? 'Manual review, verify source, then call or sequence today.' : 'Review and place into nurture/manual queue.';
  return lead;
}
function dedupeLeads(leads) {
  const seen = new Map();
  for (const l of leads) {
    const key = (l.url || `${l.name}|${l.company}|${l.signal}`).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(key) || (seen.get(key).score || 0) < (l.score || 0)) seen.set(key, l);
  }
  return [...seen.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
}
async function groqAnalyzeLead(lead) {
  if (!GROQ_API_KEY) return lead;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.15,
      max_completion_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a Basin Ventures accredited investor lead analyst. Return JSON only. Never invent facts. Never guarantee returns. Mention consult-your-CPA when tax/IDC is relevant.' },
        { role: 'user', content: 'Analyze this lead and return JSON {"score":0,"grade":"A/B/C/D","confidence":"High/Medium/Low","bestAngle":"","riskFlags":[],"nextAction":""}: ' + JSON.stringify(lead).slice(0, 3500) }
      ]
    })
  });
  if (!res.ok) throw new Error(`Groq failed ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  let j = {};
  try { j = JSON.parse(content.replace(/```json|```/g, '').trim()); } catch (_) {}
  if (j && Object.keys(j).length) {
    lead.ai = j;
    if (Number(j.score)) lead.score = Math.max(lead.score || 0, Number(j.score));
    lead.grade = grade(lead.score);
    if (j.confidence) lead.confidence = j.confidence;
    if (j.bestAngle) lead.aiAngle = j.bestAngle;
    if (j.nextAction) lead.nextAction = j.nextAction;
  }
  return lead;
}
async function main() {
  console.log('Basin Radar Runner starting...');
  if (!TAVILY_API_KEY) {
    console.warn('No TAVILY_API_KEY secret found. Writing empty radar-leads.json safely.');
    fs.mkdirSync(path.dirname(DATA_OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2));
    fs.writeFileSync(DATA_OUTPUT_FILE, JSON.stringify([], null, 2));
    return;
  }
  const queries = radarQueries();
  const all = [];
  for (const query of queries) {
    try {
      console.log(`Searching: ${query.type} · ${query.q}`);
      const results = await tavilySearch(query.q, MAX_RESULTS, topicForRadar(query));
      results.forEach(r => all.push(leadFromResult(r, query)));
      await sleep(450);
    } catch (err) {
      console.error(`Query failed: ${query.q}`);
      console.error(err.message || err);
    }
  }
  let leads = dedupeLeads(all);
  console.log(`Found ${all.length} raw results, ${leads.length} unique leads.`);
  if (GROQ_API_KEY) {
    const top = leads.slice(0, 8);
    for (let i = 0; i < top.length; i++) {
      try {
        console.log(`Groq analyzing ${i + 1}/${top.length}: ${top[i].name}`);
        top[i] = await groqAnalyzeLead(top[i]);
        await sleep(400);
      } catch (err) {
        top[i].aiError = String(err.message || err).slice(0, 240);
      }
    }
    leads = dedupeLeads([...top, ...leads.slice(8)]);
  }
  const output = leads.slice(0, 250);
  fs.mkdirSync(path.dirname(DATA_OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  fs.writeFileSync(DATA_OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${output.length} leads to radar-leads.json and data/radar-leads.json.`);
}
main().catch(err => {
  console.error(err);
  try {
    fs.mkdirSync(path.dirname(DATA_OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2));
    fs.writeFileSync(DATA_OUTPUT_FILE, JSON.stringify([], null, 2));
  } catch (_) {}
  process.exit(1);
});
