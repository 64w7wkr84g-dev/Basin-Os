// Basin OS Scheduled Radar Runner
// Runs inside GitHub Actions. No paid APIs. No scraping logins. Pulls public Google News RSS searches,
// scores leads/signals, and writes data/radar-leads.json for the static OS to import on page load.

const fs = require("fs");
const path = require("path");

const GEO = process.env.BASIN_RADAR_GEO || "nationwide USA";
const MAX_PER_QUERY = Number(process.env.BASIN_RADAR_MAX_PER_QUERY || 8);

function googleNewsRSS(q) {
  return "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
}

const queries = [
  ['Physician New Practice', '"opened" "medical practice" OR "new clinic" physician ' + GEO],
  ['Physician Promotion', '"physician" "named partner" OR "chief" ' + GEO],
  ['Specialist Signal', '"orthopedic surgeon" OR gastroenterologist "Dallas" OR "Houston"'],
  ['Business Sale', '"acquired" OR "sold" "business owner" ' + GEO],
  ['Business Growth', '"CEO" "founded" OR "expands" private company ' + GEO],
  ['Law Partner', '"named partner" "law firm" ' + GEO],
  ['Law Firm Expansion', '"law firm" "opens" "office" ' + GEO],
  ['CPA Tax Planning', '"year-end tax planning" CPA "high income" ' + GEO],
  ['CPA Medical Clients', '"CPA firm" physicians OR "medical practice" ' + GEO],
  ['Energy Executive', '"oil and gas" executive promoted ' + GEO],
  ['Energy Form D', '"Form D" "oil and gas" private placement ' + GEO],
  ['Business Liquidity', 'site:bizbuysell.com Texas "business for sale" "$1" OR "revenue"'],
  ['BusinessBroker Liquidity', 'site:businessbroker.net Texas "business for sale" "cash flow"'],
  ['LinkedIn Public Tax Post', 'site:linkedin.com/posts "year-end tax" "business owner" OR founder'],
  ['LinkedIn Physician Tax Post', 'site:linkedin.com/posts "tax planning" physician OR surgeon']
];

function stripXml(s = "") {
  return s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function between(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? stripXml(m[1]) : "";
}
function hostName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function classify(text) {
  text = String(text || "").toLowerCase();
  if (/physician|surgeon|doctor|md|medical|orthopedic|gastro|clinic|practice/.test(text)) return "Physician";
  if (/owner|ceo|founder|president|business/.test(text)) return "Business Owner";
  if (/attorney|law|partner|counsel|esq/.test(text)) return "Law Partner";
  if (/cpa|accounting|tax advisor/.test(text)) return "CPA";
  if (/energy|oil|gas|mineral|royalty|form d|regulation d/.test(text)) return "Energy";
  return "Other";
}
function signal(text) {
  text = String(text || "").toLowerCase();
  if (/form d|regulation d/.test(text)) return "Form D / private placement signal";
  if (/named partner|promoted/.test(text)) return "Promotion / named partner";
  if (/opened|new clinic|new practice|launch/.test(text)) return "New practice / business";
  if (/acquired|sold|business for sale|exit/.test(text)) return "Liquidity / sale signal";
  if (/tax|idc|deduction|year-end/.test(text)) return "Tax-planning signal";
  return "Public news signal";
}
function scoreLead(l) {
  const blob = [l.name, l.title, l.company, l.summary, l.signal, l.source, l.sourceQuery, l.url].join(" ").toLowerCase();
  let s = 44, signals = [];
  function bump(cond, pts, label) { if (cond) { s += pts; signals.push(label + " +" + pts); } }
  bump(/physician|surgeon|orthopedic|gastro|doctor|medical practice/.test(blob), 25, "Physician / medical ICP");
  bump(/owner|ceo|founder|president|business owner/.test(blob), 22, "Business owner / founder ICP");
  bump(/partner|attorney|law firm/.test(blob), 18, "Attorney / law partner ICP");
  bump(/cpa|tax advisor|accounting/.test(blob), 18, "CPA / tax advisor ICP");
  bump(/acquired|sold|opened|launch|named partner|promoted|speaker|conference/.test(blob), 10, "Trigger event detected");
  bump(/tax|deduction|year-end|idc|depletion|high income/.test(blob), 10, "Tax motivation signal");
  bump(/form d|regulation d|private placement|sec\.gov/.test(blob), 12, "Accredited / Form D signal");
  bump(/bizbuysell|businessbroker|business for sale|exit/.test(blob), 10, "Liquidity / business-sale signal");
  bump(/linkedin\.com\/posts|site:linkedin\.com/.test(blob), 6, "Public LinkedIn intent signal");
  l.scoreSignals = signals;
  return Math.min(98, s);
}
function grade(score) {
  if (score >= 82) return "A";
  if (score >= 68) return "B";
  if (score >= 55) return "C";
  return "D";
}
async function fetchRSS(q) {
  const url = googleNewsRSS(q);
  const res = await fetch(url, { headers: { "User-Agent": "BasinOSRadar/1.0" } });
  if (!res.ok) throw new Error("RSS failed " + res.status);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, MAX_PER_QUERY).map(m => m[0]);
  return items.map(block => {
    const title = between(block, "title");
    const link = between(block, "link");
    const pub = between(block, "pubDate");
    const desc = between(block, "description");
    return { title, link, pub, desc };
  }).filter(x => x.title);
}

(async () => {
  const leads = [];
  for (const [type, q] of queries) {
    try {
      const items = await fetchRSS(q);
      for (const it of items) {
        const text = [it.title, it.desc].join(" ");
        const lead = {
          id: "gh-radar-" + Buffer.from((it.link || it.title)).toString("base64url").slice(0, 22),
          name: it.title.replace(/\s+-\s+[^-]+$/, "").slice(0, 120),
          title: classify(text),
          company: hostName(it.link) || "Public source",
          location: GEO,
          type: classify(text) === "CPA" ? "cpa" : "investor",
          signal: signal(text),
          source: "GitHub Actions Radar",
          sourceFeed: type,
          sourceDate: it.pub || "",
          sourceQuery: q,
          url: it.link,
          summary: stripXml(it.desc || it.title).slice(0, 380),
          email: "",
          linkedin: /linkedin\.com/.test(it.link) ? it.link : "",
          status: "New",
          foundAt: new Date().toISOString()
        };
        lead.score = scoreLead(lead);
        lead.grade = grade(lead.score);
        leads.push(lead);
      }
    } catch (err) {
      console.warn("Query failed:", type, err.message);
    }
  }
  const seen = new Set();
  const unique = leads.filter(l => {
    const key = (l.url || l.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a,b) => b.score - a.score).slice(0, 80);

  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "data", "radar-leads.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    geo: GEO,
    queryCount: queries.length,
    leads: unique
  }, null, 2));
  console.log("Wrote", unique.length, "scheduled radar leads");
})();
