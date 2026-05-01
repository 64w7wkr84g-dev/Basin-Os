#!/usr/bin/env node
'use strict';

/**
 * Basin OS Scheduled Radar Runner — Free Feed + Groq Managed Build
 *
 * Purpose:
 * - Eliminates Tavily as a required dependency.
 * - Pulls free/public signals from:
 *   - Google News RSS search feeds
 *   - User-supplied Google Alerts RSS feeds
 *   - GDELT DOC 2.0 JSON feeds
 *   - SEC EDGAR RSS/Atom feeds
 *   - Any custom RSS/Atom feeds in radar-sources.json
 * - Uses local filtering/scoring first.
 * - Uses Groq only on likely viable lead signals, capped by env settings.
 * - Writes radar-leads.json and radar-rejected.json for the existing index.html importer.
 *
 * Required:
 *   GROQ_API_KEY is optional but recommended.
 *
 * Optional env:
 *   GROQ_API_KEY
 *   GROQ_MODEL=llama-3.3-70b-versatile
 *   RADAR_DISCOVERY_PROVIDER=feeds
 *   RADAR_USE_FREE_FEEDS=true
 *   RADAR_MAX_FEED_ITEMS=250
 *   RADAR_MAX_LEADS=120
 *   RADAR_MAX_GROQ_ANALYZE=12
 *   RADAR_MIN_GROQ_SCORE=55
 *   RADAR_REQUIRE_NAMED_CONTACT=true
 *   RADAR_REQUIRE_CONTACT_ROUTE=true
 *   RADAR_RECHECK_REJECTED_DAYS=7
 *   RADAR_GEO_MODE=texas_first_nationwide
 */

const fs = require('fs');
const path = require('path');

const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();

const MAX_FEED_ITEMS = clamp(Number(process.env.RADAR_MAX_FEED_ITEMS || 250), 25, 2000);
const MAX_LEADS = clamp(Number(process.env.RADAR_MAX_LEADS || 120), 10, 500);
const MAX_GROQ_ANALYZE = clamp(Number(process.env.RADAR_MAX_GROQ_ANALYZE || 12), 0, 100);
const MIN_GROQ_SCORE = clamp(Number(process.env.RADAR_MIN_GROQ_SCORE || 55), 0, 100);
const REQUIRE_NAMED_CONTACT = String(process.env.RADAR_REQUIRE_NAMED_CONTACT || 'true').toLowerCase() !== 'false';
const REQUIRE_CONTACT_ROUTE = String(process.env.RADAR_REQUIRE_CONTACT_ROUTE || 'true').toLowerCase() !== 'false';
const RECHECK_REJECTED_DAYS = clamp(Number(process.env.RADAR_RECHECK_REJECTED_DAYS || 7), 1, 90);
const GEO_MODE = (process.env.RADAR_GEO_MODE || 'texas_first_nationwide').trim();

const SOURCES_FILE = path.join(process.cwd(), 'radar-sources.json');
const OUTPUT_FILE = path.join(process.cwd(), 'radar-leads.json');
const REJECTED_FILE = path.join(process.cwd(), 'radar-rejected.json');
const RUN_LOG_FILE = path.join(process.cwd(), 'radar-run-log.json');

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clean(value, max = 700) {
  return String(value == null ? '' : value)
    .replace(/<!\[CDATA\[(.*?)\]\]>/gis, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeId(prefix = 'rad-feed') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function grade(score) {
  score = Number(score || 0);
  if (score >= 82) return 'A';
  if (score >= 68) return 'B';
  if (score >= 52) return 'C';
  return 'D';
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function getDefaultSources() {
  return {
    version: 'free-feed-radar-v1',
    priorityOrder: ['texas', 'energy_states', 'nationwide'],
    geoRules: {
      texasFirst: true,
      allowNationwide: true,
      requireUSA: true
    },
    googleAlerts: [],
    googleNewsQueries: [
      { name: 'Texas physician practice owners', query: '("physician founder" OR "practice owner" OR "medical practice owner" OR "surgeon founder") Texas', type: 'physician', priority: 'texas' },
      { name: 'Texas law firm partners', query: '("named partner" OR "managing partner" OR "promoted to partner") "law firm" Texas', type: 'attorney', priority: 'texas' },
      { name: 'Texas CPA tax advisors', query: '("CPA" OR "tax advisor" OR "tax partner") ("oil and gas" OR "IDC deduction" OR "depletion allowance" OR "high net worth") Texas', type: 'cpa', priority: 'texas' },
      { name: 'Texas business owners liquidity events', query: '("acquired" OR "sold his company" OR "sold her company" OR "founder exits" OR "liquidity event") Texas founder owner CEO', type: 'liquidity_event', priority: 'texas' },
      { name: 'Energy-state oil and gas executives', query: '("oil and gas" OR "mineral rights" OR "royalty owner" OR "energy operator") (Texas OR Oklahoma OR Louisiana OR New Mexico OR Colorado OR Wyoming OR North Dakota) founder CEO owner president', type: 'energy', priority: 'energy_states' },
      { name: 'Nationwide physician practice owners', query: '("physician founder" OR "practice owner" OR "medical practice owner" OR "surgeon founder") "United States"', type: 'physician', priority: 'nationwide' },
      { name: 'Nationwide law firm managing partners', query: '("managing partner" OR "named partner" OR "promoted to partner") "law firm" "United States"', type: 'attorney', priority: 'nationwide' },
      { name: 'Nationwide CPA tax advisors', query: '("CPA" OR "tax advisor" OR "tax partner") ("high net worth" OR "business owner" OR "oil and gas" OR "IDC deduction") "United States"', type: 'cpa', priority: 'nationwide' },
      { name: 'Nationwide business founder exits', query: '("acquired" OR "sold his company" OR "sold her company" OR "founder exits" OR "liquidity event") "United States" founder CEO owner', type: 'liquidity_event', priority: 'nationwide' },
      { name: 'Nationwide franchise and multi-unit owners', query: '("multi-unit franchisee" OR "franchise owner" OR "multi unit operator") founder CEO owner "United States"', type: 'business_owner', priority: 'nationwide' }
    ],
    gdeltQueries: [
      { name: 'Texas physician founders', query: '("physician founder" OR "practice owner") Texas', type: 'physician', priority: 'texas' },
      { name: 'Texas law firm partners', query: '("named partner" OR "managing partner") "law firm" Texas', type: 'attorney', priority: 'texas' },
      { name: 'Energy executives', query: '("oil and gas" OR "mineral rights" OR "royalty owner") (Texas OR Oklahoma OR Louisiana OR New Mexico OR Colorado OR Wyoming OR North Dakota)', type: 'energy', priority: 'energy_states' },
      { name: 'Nationwide founder liquidity events', query: '("acquired" OR "sold his company" OR "sold her company" OR "founder exits") "United States"', type: 'liquidity_event', priority: 'nationwide' }
    ],
    secFeeds: [
      {
        name: 'SEC recent Form D filings',
        url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&company=&dateb=&owner=include&start=0&count=100&output=atom',
        type: 'sec_form_d',
        priority: 'nationwide'
      }
    ],
    industryFeeds: [],
    customFeeds: []
  };
}

function loadSources() {
  const defaults = getDefaultSources();
  const user = safeReadJson(SOURCES_FILE, {});
  const merged = {
    ...defaults,
    ...user,
    geoRules: { ...(defaults.geoRules || {}), ...(user.geoRules || {}) },
    googleAlerts: [...(defaults.googleAlerts || []), ...(user.googleAlerts || [])],
    googleNewsQueries: [...(defaults.googleNewsQueries || []), ...(user.googleNewsQueries || [])],
    gdeltQueries: [...(defaults.gdeltQueries || []), ...(user.gdeltQueries || [])],
    secFeeds: [...(defaults.secFeeds || []), ...(user.secFeeds || [])],
    industryFeeds: [...(defaults.industryFeeds || []), ...(user.industryFeeds || [])],
    customFeeds: [...(defaults.customFeeds || []), ...(user.customFeeds || [])]
  };
  return merged;
}

function googleNewsRssUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function gdeltUrl(query, max = 50) {
  return `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=${max}&sort=datedesc`;
}

async function fetchText(url, options = {}) {
  const headers = {
    'User-Agent': 'BasinOSRadar/1.0 contact:github-actions',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/plain, */*',
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return await res.text();
}

async function fetchJson(url, options = {}) {
  const txt = await fetchText(url, { ...options, headers: { ...(options.headers || {}), Accept: 'application/json, text/plain, */*' } });
  return JSON.parse(txt);
}

function getTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = String(xml || '').match(re);
  return m ? clean(m[1], 2000) : '';
}

function getAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\s+[^>]*${attr}=["']([^"']+)["'][^>]*\\/?>`, 'i');
  const m = String(xml || '').match(re);
  return m ? clean(m[1], 1000) : '';
}

function parseRssItems(xml, meta) {
  const out = [];
  const itemMatches = String(xml || '').match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const item of itemMatches) {
    let link = getTag(item, 'link');
    if (!link) link = getAttr(item, 'link', 'href');
    out.push({
      sourceKind: 'rss',
      sourceFeed: meta.name || meta.url || 'RSS Feed',
      sourceQuery: meta.query || '',
      sourceType: meta.type || 'rss_signal',
      priority: meta.priority || 'nationwide',
      title: getTag(item, 'title'),
      url: link,
      summary: getTag(item, 'description') || getTag(item, 'content:encoded'),
      sourceDate: getTag(item, 'pubDate') || getTag(item, 'dc:date') || '',
      raw: { meta }
    });
  }

  const entryMatches = String(xml || '').match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const entry of entryMatches) {
    let link = getAttr(entry, 'link', 'href') || getTag(entry, 'link');
    out.push({
      sourceKind: 'atom',
      sourceFeed: meta.name || meta.url || 'Atom Feed',
      sourceQuery: meta.query || '',
      sourceType: meta.type || 'atom_signal',
      priority: meta.priority || 'nationwide',
      title: getTag(entry, 'title'),
      url: link,
      summary: getTag(entry, 'summary') || getTag(entry, 'content'),
      sourceDate: getTag(entry, 'updated') || getTag(entry, 'published') || '',
      raw: { meta }
    });
  }

  return out.filter(x => x.title || x.url);
}

async function fetchFeedSource(meta) {
  if (!meta || !meta.url) return [];
  const xml = await fetchText(meta.url);
  return parseRssItems(xml, meta);
}

async function fetchGoogleNewsQuery(meta) {
  const url = googleNewsRssUrl(meta.query);
  const xml = await fetchText(url);
  return parseRssItems(xml, { ...meta, url, sourceKind: 'google_news_rss' });
}

async function fetchGdeltQuery(meta) {
  const url = gdeltUrl(meta.query, clamp(Number(meta.maxRecords || 50), 5, 250));
  const data = await fetchJson(url);
  const articles = Array.isArray(data.articles) ? data.articles : [];
  return articles.map(a => ({
    sourceKind: 'gdelt',
    sourceFeed: meta.name || 'GDELT',
    sourceQuery: meta.query || '',
    sourceType: meta.type || 'gdelt_signal',
    priority: meta.priority || 'nationwide',
    title: clean(a.title || a.seendate || 'GDELT Signal', 240),
    url: a.url || '',
    summary: clean([a.title, a.domain, a.sourcecountry, a.language].filter(Boolean).join(' · '), 800),
    sourceDate: a.seendate || '',
    raw: { meta, gdelt: a }
  }));
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isLikelyUS(text) {
  const s = clean(text, 2000);
  const foreign = /\b(UK|London|Canada|Ontario|Toronto|Mexico|India|Australia|Europe|Dubai|UAE|China|Singapore|Germany|France|Brazil|Argentina|South Africa)\b/i.test(s);
  const usa = /\b(USA|United States|U\.S\.|US\b|Texas|Dallas|Fort Worth|Houston|Austin|San Antonio|Midland|Odessa|Oklahoma|Louisiana|New Mexico|Colorado|Wyoming|North Dakota|Pennsylvania|Ohio|Alaska|California|Florida|Arizona|New York)\b/i.test(s);
  if (foreign && !usa) return false;
  return true;
}

function priorityScore(priority, blob) {
  const text = `${priority || ''} ${blob || ''}`;
  if (/\btexas|dfw|dallas|fort worth|houston|austin|san antonio|midland|odessa|plano|frisco|keller|southlake|grapevine|the woodlands\b/i.test(text)) return 10;
  if (/\boklahoma|louisiana|new mexico|colorado|wyoming|north dakota|pennsylvania|ohio|alaska\b/i.test(text)) return 7;
  if (/\bunited states|usa|nationwide\b/i.test(text)) return 4;
  return 0;
}

function leadTypeFromText(text, fallback = 'prospect_signal') {
  const s = text.toLowerCase();
  if (/physician|surgeon|doctor|medical|clinic|orthopedic|dental|dentist|gastro/.test(s)) return 'physician';
  if (/attorney|law firm|lawyer|managing partner|named partner|estate/.test(s)) return 'attorney';
  if (/cpa|tax advisor|accounting|tax partner/.test(s)) return 'cpa';
  if (/oil|gas|energy|mineral|royalty|operator|idc|depletion/.test(s)) return 'energy';
  if (/acquired|sold|founder exits|liquidity|merger|m&a/.test(s)) return 'liquidity_event';
  if (/franchise|multi-unit|developer|real estate|founder|owner|ceo|president/.test(s)) return 'business_owner';
  return fallback;
}

const BAD_NAME_RE = /^(our team|team|leadership|people|staff|directory|contact us|about us|home|news|press release|article|profile|company|unknown|shared radar lead|radar lead|city|county|state|market|region)$/i;
const CITY_RE = /\b(Dallas|Fort Worth|Houston|Austin|San Antonio|Midland|Odessa|Plano|Frisco|Keller|Southlake|Grapevine|Arlington|Irving|McKinney|Denton|Waco|Tyler|El Paso|Corpus Christi|Lubbock|Amarillo|Oklahoma City|Tulsa|Denver|Phoenix|Texas|Oklahoma|Colorado|Louisiana|Wyoming|New Mexico|California|Florida|New York)\b/i;

function isCityOnly(name) {
  const n = clean(name, 120);
  return !!n && CITY_RE.test(n) && n.split(/\s+/).length <= 3;
}

function personish(name) {
  const n = clean(name, 140).replace(/\s+\|\s+.*$/, '').replace(/\s+-\s+.*$/, '');
  if (!n || n.length > 90) return false;
  if (BAD_NAME_RE.test(n) || isCityOnly(n)) return false;
  if (/\b(Dr\.?|Doctor|MD|CPA|Esq\.?)\b/i.test(n)) return true;
  const parts = n.replace(/[,;:|].*$/, '').trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 5) return false;
  return parts.every(p => /^[A-Z][A-Za-z.'-]{1,}$/.test(p) || /^(Jr\.?|Sr\.?|III|IV)$/i.test(p));
}

function extractPerson(text) {
  const s = clean(text, 500);

  const patterns = [
    /\bDr\.?\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\b/,
    /\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}),?\s+(?:MD|M\.D\.|CPA|Esq\.?)\b/,
    /\b(?:founder|owner|CEO|president|partner|managing partner|physician|surgeon|attorney|CPA)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\b/i,
    /\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\s+(?:joins|named|promoted|launches|opens|founds|acquires|sells|leads)\b/i
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const candidate = clean(m[1] || m[0], 100).replace(/^(Dr\.?\s+)/i, '');
      if (personish(candidate)) return candidate;
    }
  }

  return '';
}

function extractCompany(text) {
  const s = clean(text, 500);
  const patterns = [
    /\bat\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,5}(?:\s+(?:LLC|Inc\.?|PC|PLLC|Group|Partners|Clinic|Center|Firm|Energy|Resources|Capital|Holdings|Orthopedics|Dental|Law|CPA|Advisors)))\b/,
    /\b([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,5}(?:\s+(?:LLC|Inc\.?|PC|PLLC|Group|Partners|Clinic|Center|Firm|Energy|Resources|Capital|Holdings|Orthopedics|Dental|Law|CPA|Advisors)))\b/
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return clean(m[1], 160);
  }
  return '';
}

function localScore(candidate) {
  const blob = [candidate.name, candidate.title, candidate.company, candidate.location, candidate.summary, candidate.signal, candidate.sourceQuery, candidate.url].join(' ').toLowerCase();
  let s = 38;

  if (candidate.name && personish(candidate.name)) s += 22;
  if (candidate.company) s += 8;
  if (/physician|surgeon|medical|clinic|doctor|orthopedic|gastro|dentist|dental/.test(blob)) s += 22;
  if (/owner|founder|ceo|president|executive|entrepreneur|partner|managing partner/.test(blob)) s += 18;
  if (/attorney|law firm|estate planning|partner/.test(blob)) s += 15;
  if (/cpa|tax|accounting|tax advisor/.test(blob)) s += 15;
  if (/oil|gas|energy|mineral|royalty|idc|deduction|depletion|operator/.test(blob)) s += 12;
  if (/acquired|sold|opened|launch|named partner|promoted|speaker|conference|podcast|interview|liquidity/.test(blob)) s += 10;
  if ((candidate.contactMethods || []).length) s += 8;
  if (isLikelyUS(blob)) s += 5;
  s += priorityScore(candidate.priority, blob);

  if (!candidate.name || !personish(candidate.name)) s -= 22;
  if (!isLikelyUS(blob)) s -= 50;
  if (BAD_NAME_RE.test(candidate.name || '') || isCityOnly(candidate.name || '')) s -= 40;

  return Math.max(1, Math.min(98, Math.round(s)));
}

function sourceResearchContactMethods(candidate) {
  const methods = [];
  const url = candidate.url || '';
  const domain = hostOf(url);
  const queryName = encodeURIComponent([candidate.name, candidate.company].filter(Boolean).join(' '));

  if (/linkedin\.com\/in\//i.test(url)) methods.push({ type: 'LinkedIn', value: url, confidence: 'High', source: 'free feed' });
  else if (/linkedin\.com\/company\//i.test(url)) methods.push({ type: 'LinkedIn Company', value: url, confidence: 'Medium', source: 'free feed' });

  if (domain && !/news\.google\.com|google\.com|gdeltproject\.org|sec\.gov|yahoo\.com|finance\.yahoo\.com/i.test(domain)) {
    methods.push({ type: 'Company Website', value: `https://${domain}`, confidence: 'Medium', source: 'source domain' });
  }

  if (candidate.name && queryName) {
    methods.push({ type: 'LinkedIn Search', value: `https://www.linkedin.com/search/results/people/?keywords=${queryName}`, confidence: 'Medium', source: 'free search path' });
    methods.push({ type: 'Google Search', value: `https://www.google.com/search?q=${queryName}+contact+LinkedIn+email`, confidence: 'Medium', source: 'free search path' });
  } else if (candidate.company) {
    const q = encodeURIComponent(candidate.company);
    methods.push({ type: 'Google Search', value: `https://www.google.com/search?q=${q}+founder+owner+contact`, confidence: 'Low', source: 'free search path' });
  }

  return uniqueMethods(methods);
}

function uniqueMethods(methods) {
  const seen = new Set();
  const out = [];
  for (const m of methods || []) {
    if (!m || !m.value) continue;
    const key = `${m.type}|${m.value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

function normalizeSignal(raw, index) {
  const title = clean(raw.title || raw.name || `Signal ${index + 1}`, 240);
  const summary = clean(raw.summary || raw.description || '', 1000);
  const text = [title, summary, raw.sourceQuery, raw.sourceFeed].join(' ');
  const person = extractPerson(text);
  const company = raw.company || extractCompany(text) || '';
  const name = person || '';

  const candidate = {
    id: safeId('rad-free'),
    name,
    title: clean(raw.sourceType || leadTypeFromText(text, 'Free Feed Signal'), 160),
    company,
    location: geoLocationLabel(raw.priority, text),
    url: raw.url || '',
    sourceUrl: raw.url || '',
    source: 'Free Feed Radar',
    sourceFeed: raw.sourceFeed || raw.sourceKind || 'Free Feed',
    sourceQuery: raw.sourceQuery || '',
    sourceDate: raw.sourceDate || '',
    sourceType: raw.sourceType || raw.sourceKind || 'free_feed',
    priority: raw.priority || 'nationwide',
    summary,
    signal: title,
    raw,
    foundAt: new Date().toISOString(),
    status: 'New',
    leadType: 'basinos'
  };

  candidate.contactMethods = sourceResearchContactMethods(candidate);
  candidate.score = localScore(candidate);
  candidate.grade = grade(candidate.score);
  candidate.qualificationStatus = candidate.score >= 82 ? 'Qualified' : (candidate.score >= 55 ? 'Potential' : 'Needs Research');
  candidate.nextAction = buildNextAction(candidate);
  candidate.nurture = buildNurture(candidate);
  candidate.scoreSignals = buildScoreSignals(candidate);

  return candidate;
}

function geoLocationLabel(priority, text) {
  const s = `${priority || ''} ${text || ''}`;
  if (/texas|dfw|dallas|fort worth|houston|austin|san antonio|midland|odessa|plano|frisco|keller|southlake|grapevine|the woodlands/i.test(s)) return 'Texas-first';
  if (/oklahoma|louisiana|new mexico|colorado|wyoming|north dakota|pennsylvania|ohio|alaska/i.test(s)) return 'Energy-state priority';
  return 'Nationwide USA';
}

function buildNextAction(l) {
  return `Day 1: verify ${l.name || 'named contact'} and use the source signal for first email + LinkedIn/manual research touch. Do not call until contact route is confirmed.`;
}

function buildNurture(l) {
  const first = clean((l.name || '').split(/\s+/)[0] || '[Name]', 40);
  const angle = l.sourceType === 'cpa' ? 'tax planning' : /energy|oil|gas/i.test([l.title,l.summary,l.signal].join(' ')) ? 'direct energy ownership' : 'alternative investment planning';
  return {
    subject: `Reason for reaching out`,
    body: `Hi ${first}, I came across a public signal related to ${clean(l.signal || angle, 120)}. Basin Ventures may be relevant if ${angle} is on your radar. Worth a short director call to see if there is a fit?`
  };
}

function buildScoreSignals(l) {
  const out = [];
  const blob = [l.name, l.title, l.company, l.summary, l.signal, l.sourceQuery, l.location].join(' ').toLowerCase();
  if (l.name && personish(l.name)) out.push('named human contact found');
  if (l.contactMethods && l.contactMethods.length) out.push('manual contact path available');
  if (/texas|dfw|dallas|houston|austin|midland|odessa/.test(blob)) out.push('Texas-first priority');
  if (/physician|surgeon|attorney|cpa|owner|founder|ceo|partner|energy|oil|gas|mineral|royalty/.test(blob)) out.push('Basin ICP signal');
  if (/acquired|sold|opened|launch|named partner|promoted|speaker|podcast|conference/.test(blob)) out.push('timely public trigger');
  return out.slice(0, 7);
}

function qualification(candidate) {
  const missing = [];
  const blob = [candidate.name, candidate.title, candidate.company, candidate.location, candidate.summary, candidate.signal, candidate.sourceQuery, candidate.url].join(' ');

  const human = !!(candidate.name && personish(candidate.name));
  const usa = isLikelyUS(blob);
  const relevant = /physician|surgeon|doctor|medical|clinic|dentist|attorney|law firm|partner|cpa|tax|owner|founder|ceo|president|business owner|executive|real estate|oil|gas|energy|mineral|royalty|operator|liquidity|acquired|sold|franchise/i.test(blob);
  const contact = (candidate.contactMethods || []).length > 0;

  if (REQUIRE_NAMED_CONTACT && !human) missing.push('named human contact');
  if (!usa) missing.push('USA-based confirmation');
  if (!relevant) missing.push('qualified investor / referral-source signal');
  if (REQUIRE_CONTACT_ROUTE && !contact) missing.push('usable contact route or manual contact path');

  const ok = (!REQUIRE_NAMED_CONTACT || human) && usa && relevant && (!REQUIRE_CONTACT_ROUTE || contact);
  candidate.contactable = contact;
  candidate.usaBased = usa;
  candidate.workflowEligible = ok;
  candidate.missingQualificationFields = missing;
  candidate.pipelineBlockReason = ok ? '' : missing.join('; ');
  candidate.qualificationStatus = ok ? (candidate.score >= 82 ? 'Qualified' : 'Potential') : 'Do Not Load';
  candidate.contactSummary = contact ? candidate.contactMethods.map(m => m.type).join(' + ') : 'No contact route';
  return ok;
}

function dedupeKey(l) {
  return clean(l.url || l.sourceUrl || l.linkedin || l.email || l.phone || `${l.name}|${l.company}|${l.signal}`, 600).toLowerCase();
}

function sortLead(a, b) {
  const ga = { A: 4, B: 3, C: 2, D: 1 };
  const pa = priorityScore(a.priority, [a.location, a.signal, a.sourceQuery].join(' '));
  const pb = priorityScore(b.priority, [b.location, b.signal, b.sourceQuery].join(' '));
  return (ga[b.grade] || 0) - (ga[a.grade] || 0)
    || (Number(b.score || 0) - Number(a.score || 0))
    || pb - pa
    || String(a.name || '').localeCompare(String(b.name || ''));
}

function stripJsonFence(s) {
  return String(s || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

async function groqUpgrade(candidate) {
  if (!GROQ_API_KEY) return candidate;

  const prompt = `You are Basin OS lead qualification AI. Convert this public signal into a structured Basin Ventures prospect record only if it contains or implies a real human contact.

Rules:
- A city, company-only page, article headline, "our team", or generic source is not a lead.
- Prefer named humans: physicians, practice owners, attorneys/partners, CPAs/tax advisors, founders, business owners, executives, energy/mineral/royalty operators.
- USA only. Texas is priority but nationwide USA is eligible.
- Do not invent emails or phone numbers.
- Contact path can be LinkedIn search, company website, contact page, or manual research path if realistic.
- Output JSON only.

Signal:
${JSON.stringify({
  name: candidate.name,
  title: candidate.title,
  company: candidate.company,
  location: candidate.location,
  url: candidate.url,
  sourceFeed: candidate.sourceFeed,
  sourceQuery: candidate.sourceQuery,
  signal: candidate.signal,
  summary: candidate.summary,
  score: candidate.score,
  contactMethods: candidate.contactMethods
}, null, 2)}

Return JSON:
{
  "isHumanLead": true,
  "contactName": "",
  "company": "",
  "title": "",
  "leadType": "",
  "usaRelevance": true,
  "investorFit": "qualified|potential|weak|no",
  "contactPath": "linkedin|website|email|phone|manual_research|none",
  "contactPathValue": "",
  "scoreAdjustment": 0,
  "qualificationGaps": [],
  "bestAngle": "",
  "likelyObjection": "",
  "nextAction": "",
  "rejectReason": ""
}`;

  const body = {
    model: GROQ_MODEL,
    temperature: 0.1,
    max_tokens: 650,
    messages: [
      { role: 'system', content: 'Return strict JSON only. No markdown.' },
      { role: 'user', content: prompt }
    ]
  };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    candidate.aiError = `Groq HTTP ${res.status}`;
    return candidate;
  }

  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) return candidate;

  let parsed = null;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch {}
    }
  }

  if (!parsed) {
    candidate.aiError = 'Groq returned non-JSON';
    return candidate;
  }

  candidate.ai = parsed;
  candidate.groqAnalyzedAt = new Date().toISOString();

  if (parsed.contactName && personish(parsed.contactName)) candidate.name = clean(parsed.contactName, 140);
  if (parsed.company) candidate.company = clean(parsed.company, 160);
  if (parsed.title) candidate.title = clean(parsed.title, 160);
  if (parsed.leadType) candidate.sourceType = clean(parsed.leadType, 120);
  if (parsed.nextAction) candidate.nextAction = clean(parsed.nextAction, 280);
  if (parsed.bestAngle) candidate.bestAngle = clean(parsed.bestAngle, 280);
  if (parsed.likelyObjection) candidate.likelyObjection = clean(parsed.likelyObjection, 180);

  if (parsed.contactPath && parsed.contactPath !== 'none') {
    const label = parsed.contactPath === 'linkedin' ? 'LinkedIn Search'
      : parsed.contactPath === 'website' ? 'Company Website'
      : parsed.contactPath === 'email' ? 'Email'
      : parsed.contactPath === 'phone' ? 'Phone'
      : 'Manual Research Path';
    const value = parsed.contactPathValue || candidate.url || `https://www.google.com/search?q=${encodeURIComponent([candidate.name, candidate.company, label].filter(Boolean).join(' '))}`;
    candidate.contactMethods = uniqueMethods([...(candidate.contactMethods || []), { type: label, value, confidence: 'Medium', source: 'Groq path' }]);
  }

  const adj = clamp(Number(parsed.scoreAdjustment || 0), -25, 25);
  candidate.score = Math.max(candidate.score || 0, Math.max(1, Math.min(98, Math.round((candidate.score || 50) + adj))));
  if (parsed.investorFit === 'qualified') candidate.score = Math.max(candidate.score, 82);
  if (parsed.investorFit === 'potential') candidate.score = Math.max(candidate.score, 68);
  if (parsed.investorFit === 'weak') candidate.score = Math.min(candidate.score, 58);
  if (parsed.investorFit === 'no' || parsed.isHumanLead === false) candidate.score = Math.min(candidate.score, 45);

  candidate.grade = grade(candidate.score);
  candidate.scoreSignals = uniqueText([...(candidate.scoreSignals || []), parsed.investorFit ? `Groq fit: ${parsed.investorFit}` : '', parsed.bestAngle ? `Angle: ${parsed.bestAngle}` : '']).slice(0, 7);
  return candidate;
}

function uniqueText(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const s = clean(item, 180);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function collectSignals(sources) {
  const all = [];
  const errors = [];

  async function safeCollect(kind, list, fn) {
    for (const meta of list || []) {
      if (all.length >= MAX_FEED_ITEMS) break;
      if (!meta || meta.disabled === true) continue;
      try {
        const rows = await fn(meta);
        for (const row of rows) {
          all.push({ ...row, sourceCollection: kind });
          if (all.length >= MAX_FEED_ITEMS) break;
        }
        await sleep(150);
      } catch (err) {
        errors.push({ kind, name: meta.name || meta.url || meta.query, error: String(err.message || err) });
      }
    }
  }

  await safeCollect('googleAlerts', sources.googleAlerts || [], fetchFeedSource);
  await safeCollect('googleNewsQueries', sources.googleNewsQueries || [], fetchGoogleNewsQuery);
  await safeCollect('gdeltQueries', sources.gdeltQueries || [], fetchGdeltQuery);
  await safeCollect('secFeeds', sources.secFeeds || [], fetchFeedSource);
  await safeCollect('industryFeeds', sources.industryFeeds || [], fetchFeedSource);
  await safeCollect('customFeeds', sources.customFeeds || [], fetchFeedSource);

  return { signals: all.slice(0, MAX_FEED_ITEMS), errors };
}

function buildRejectedRecord(candidate, reason) {
  return {
    id: candidate.id || safeId('rej-feed'),
    name: candidate.name || '',
    title: candidate.title || candidate.signal || '',
    company: candidate.company || '',
    url: candidate.url || '',
    reason: reason || candidate.pipelineBlockReason || 'Not workflow eligible',
    missingQualificationFields: candidate.missingQualificationFields || [],
    score: candidate.score || 0,
    grade: candidate.grade || 'D',
    source: candidate.source || 'Free Feed Radar',
    sourceFeed: candidate.sourceFeed || '',
    sourceQuery: candidate.sourceQuery || '',
    sourceDate: candidate.sourceDate || '',
    contactSummary: candidate.contactSummary || '',
    ts: new Date().toISOString(),
    recheckAfter: new Date(Date.now() + RECHECK_REJECTED_DAYS * 24 * 60 * 60 * 1000).toISOString()
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const sources = loadSources();
  const previousRejected = safeReadJson(REJECTED_FILE, []);
  const { signals, errors } = await collectSignals(sources);

  const byKey = new Map();
  const candidates = [];

  for (let i = 0; i < signals.length; i++) {
    const c = normalizeSignal(signals[i], i);
    const k = dedupeKey(c);
    if (!k || byKey.has(k)) continue;
    byKey.set(k, true);
    candidates.push(c);
  }

  candidates.sort(sortLead);

  let groqUsed = 0;
  const groqEligible = candidates
    .filter(c => c.score >= MIN_GROQ_SCORE && isLikelyUS([c.name, c.title, c.summary, c.signal, c.sourceQuery].join(' ')))
    .slice(0, MAX_GROQ_ANALYZE);

  const groqIds = new Set(groqEligible.map(c => c.id));
  const upgraded = [];

  for (const c of candidates) {
    if (groqIds.has(c.id)) {
      try {
        const u = await groqUpgrade(c);
        groqUsed++;
        upgraded.push(u);
        await sleep(200);
      } catch (err) {
        c.aiError = String(err.message || err);
        upgraded.push(c);
      }
    } else {
      upgraded.push(c);
    }
  }

  const leads = [];
  const rejected = [];

  for (const c of upgraded) {
    c.score = localScore(c) > c.score ? localScore(c) : c.score;
    c.grade = grade(c.score);
    qualification(c);
    if (c.workflowEligible) {
      c.qualificationStatus = c.score >= 82 ? 'Qualified' : 'Potential';
      leads.push(c);
    } else {
      rejected.push(buildRejectedRecord(c, c.pipelineBlockReason));
    }
  }

  const finalLeads = leads.sort(sortLead).slice(0, MAX_LEADS);
  const rejectedMerged = [...(Array.isArray(previousRejected) ? previousRejected : []), ...rejected]
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, 2000);

  const payload = {
    generatedAt: new Date().toISOString(),
    engine: 'Free Feed Radar + Groq Managed',
    geoMode: GEO_MODE,
    tavilyUsed: false,
    sources: {
      googleAlerts: (sources.googleAlerts || []).length,
      googleNewsQueries: (sources.googleNewsQueries || []).length,
      gdeltQueries: (sources.gdeltQueries || []).length,
      secFeeds: (sources.secFeeds || []).length,
      industryFeeds: (sources.industryFeeds || []).length,
      customFeeds: (sources.customFeeds || []).length
    },
    stats: {
      rawSignals: signals.length,
      candidates: candidates.length,
      groqUsed,
      usableLeads: finalLeads.length,
      rejected: rejected.length,
      collectionErrors: errors.length
    },
    leads: finalLeads
  };

  writeJson(OUTPUT_FILE, payload);
  writeJson(REJECTED_FILE, rejectedMerged);
  writeJson(RUN_LOG_FILE, {
    generatedAt: payload.generatedAt,
    startedAt,
    engine: payload.engine,
    stats: payload.stats,
    errors: errors.slice(0, 25)
  });

  console.log(`[Basin Free Feed Radar] signals=${signals.length} candidates=${candidates.length} leads=${finalLeads.length} rejected=${rejected.length} groq=${groqUsed} errors=${errors.length}`);
  if (errors.length) console.log('[Basin Free Feed Radar] sample errors:', JSON.stringify(errors.slice(0, 5), null, 2));
}

main().catch(err => {
  console.error('[Basin Free Feed Radar] fatal:', err);
  process.exit(1);
});
