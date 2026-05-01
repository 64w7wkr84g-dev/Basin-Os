#!/usr/bin/env node
'use strict';

/**
 * Basin OS Scheduled Radar Runner — Tavily + Groq Contact-Enriched Build
 * Writes only actionable leads to radar-leads.json:
 * clear identity + USA-based + likely investor/referral ICP + at least one usable contact route.
 * Non-actionable signals are written to radar-rejected.json for audit, not loaded into the pipeline.
 */

const fs = require('fs');
const path = require('path');

const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const GEO = (process.env.RADAR_GEO || 'nationwide USA').trim();
const MAX_QUERIES = clamp(Number(process.env.RADAR_MAX_QUERIES || 18), 3, 60);
const MAX_RESULTS = clamp(Number(process.env.RADAR_MAX_RESULTS || 5), 1, 10);
const MAX_ENRICH = clamp(Number(process.env.RADAR_MAX_ENRICH || 40), 5, 100);
const MAX_GROQ = clamp(Number(process.env.RADAR_MAX_GROQ || 8), 0, 25);
const YEAR_TAIL = (process.env.RADAR_YEAR_TAIL || '2025 OR 2026').trim();

const OUT = path.join(process.cwd(), 'radar-leads.json');
const REJECT_OUT = path.join(process.cwd(), 'radar-rejected.json');

function clamp(n,min,max){ if(!Number.isFinite(n)) return min; return Math.max(min, Math.min(max,n)); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function clean(v,n=500){ return String(v||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim().slice(0,n); }
function grade(s){ s=Number(s||0); return s>=82?'A':s>=68?'B':s>=52?'C':'D'; }
function safeId(){ return 'rad-gh-'+Date.now()+'-'+Math.random().toString(16).slice(2); }
function host(url){ try{return new URL(url).hostname.replace(/^www\./,'')}catch(e){return ''} }

async function tavilySearch(query, max=5, topic='general'){
  if(!TAVILY_API_KEY) return [];
  const res = await fetch('https://api.tavily.com/search', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+TAVILY_API_KEY},
    body:JSON.stringify({query, search_depth:'advanced', topic, max_results:clamp(max,1,10), include_answer:false, include_raw_content:false, include_images:false})
  });
  if(!res.ok){ const body = await res.text().catch(()=>res.statusText); throw new Error('Tavily HTTP '+res.status+' '+body.slice(0,220)); }
  const data = await res.json();
  return (data.results||[]).map(r=>({title:clean(r.title||''), link:r.url||r.link||'', desc:clean(r.content||r.description||r.snippet||'',900), pub:r.published_date||r.age||'', score:r.score||0, query})).filter(r=>r.title||r.link);
}

function radarQueries(){
  const tail = ` ${GEO} ${YEAR_TAIL}`;
  const q=[];
  function add(source, query, type){ q.push({source, q:query, type}); }
  add('physician', `site:linkedin.com/in physician surgeon orthopedic gastroenterology practice owner United States`, 'Physician');
  add('physician', `"opened" OR "launched" "medical practice" physician surgeon orthopedic ${tail}`, 'Physician');
  add('physician', `"physician" "practice owner" "email" OR "contact" ${GEO}`, 'Physician');
  add('business-owner', `site:linkedin.com/in founder CEO owner entrepreneur acquired sold company United States`, 'Business Owner');
  add('business-owner', `"acquired" OR "sold" OR "expands" founder CEO owner business ${tail}`, 'Business Owner');
  add('law', `site:linkedin.com/in attorney partner law firm estate planning United States`, 'Law Partner');
  add('law', `"named partner" OR "promoted to partner" "law firm" ${tail}`, 'Law Partner');
  add('cpa-referral', `site:linkedin.com/in CPA tax advisor high income business owners physicians United States`, 'CPA / Referral Partner');
  add('cpa-referral', `"oil and gas" CPA tax planning IDC depletion ${GEO}`, 'CPA / Referral Partner');
  add('energy', `site:linkedin.com/in oil gas energy executive mineral owner royalty owner United States`, 'Energy Executive');
  add('energy', `"oil and gas" executive founder president mineral royalty ${tail}`, 'Energy Executive');
  add('real-estate', `site:linkedin.com/in real estate developer founder owner accredited investor United States`, 'Real Estate Developer');
  add('events', `conference speaker physician founder attorney CPA investor ${GEO}`, 'Speaker Signal');
  add('podcasts', `podcast interview founder physician attorney business owner energy executive ${GEO}`, 'Media Signal');
  return q.slice(0, MAX_QUERIES);
}

function extractEmail(txt){ const m=String(txt||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); return m?m[0]:''; }
function extractPhone(txt){ const m=String(txt||'').match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/); return m?m[0]:''; }
function extractLinkedIn(txt){ const m=String(txt||'').match(/https?:\/\/(www\.)?linkedin\.com\/(in|company)\/[^\s"')]+/i); return m?m[0]:''; }
function looksLinkedIn(url){ return /linkedin\.com\/(in|company)\//i.test(url||''); }
function looksContactPage(url,title=''){ return /\/contact|contact-us|contact\b|locations|team|people|directory|profile|about/i.test((url||'')+' '+title); }
function sourceIsNewsOnly(url){ return /finance\.yahoo|yahoo\.com|news\.google|apnews\.com|reuters\.com|bloomberg\.com|sec\.gov\/Archives/i.test(url||''); }

function pushMethod(list,type,value,confidence,source){
  value=clean(value,800); if(!value) return;
  const key=(type+'|'+value).toLowerCase();
  if(list.some(m=>(m.type+'|'+m.value).toLowerCase()===key)) return;
  list.push({type,value,confidence:confidence||'Medium',source:source||''});
}

function inferRole(text,type){
  const s=String(text+' '+type).toLowerCase();
  if(/surgeon|orthopedic|gastro|physician|doctor|md\b|medical|clinic|practice/.test(s)) return 'Physician / Medical Practice';
  if(/cpa|accounting|tax/.test(s)) return 'CPA / Tax Advisor';
  if(/attorney|law firm|partner|counsel|estate planning/.test(s)) return 'Attorney / Law Partner';
  if(/founder|ceo|owner|president|acquired|expands|business/.test(s)) return 'Business Owner / Executive';
  if(/real estate|developer/.test(s)) return 'Real Estate Developer';
  if(/oil|gas|energy|mineral|royalty|operator/.test(s)) return 'Energy Executive / Mineral Owner';
  return type || 'Prospect Signal';
}
function inferType(role){ return /cpa|tax advisor|accounting/i.test(role)?'cpa':'investor'; }
function inferSignal(text){
  const s=String(text||'').toLowerCase();
  if(/named partner|promoted|joins/.test(s)) return 'Recent promotion / partner signal';
  if(/open|launch|new practice|new clinic|new location/.test(s)) return 'New practice / business opening';
  if(/acquir|sold|merger|business sale/.test(s)) return 'Acquisition / sale signal';
  if(/speaker|conference|panel|webinar|podcast|interview/.test(s)) return 'Authority / public platform signal';
  if(/hiring|expands|growth|inc 5000/.test(s)) return 'Growth / hiring signal';
  if(/tax|cpa|deduction|year-end|depletion|idc/.test(s)) return 'Tax planning signal';
  if(/form d|regulation d|private placement|sec\.gov/.test(s)) return 'Form D / private placement signal';
  return 'Public web/search signal';
}
function extractCompany(title){
  const t=String(title||'');
  const pats=[/(?:at|with|joins|opens|launches|acquires|by)\s+([A-Z][A-Za-z0-9 &.,'’\-]{2,70})/,/([A-Z][A-Za-z0-9 &.,'’\-]{2,70})\s+(?:opens|launches|acquires|names|promotes)/];
  for(const p of pats){const m=t.match(p); if(m) return clean(m[1].replace(/\s+(in|as|for|after|with)\s+.*/i,''),90);}
  return '';
}
function personish(name){
  name=clean(name,160); if(!name||name.length>90) return false;
  if(/\b(Dr\.?|Doctor|MD|Esq\.?|CPA)\b/i.test(name)) return true;
  const parts=name.replace(/[,|:;].*$/,'').trim().split(/\s+/);
  return parts.length>=2 && parts.length<=5 && parts.every(p=>/^[A-Z][A-Za-z.'-]{1,}$/.test(p)||/^(Jr\.?|Sr\.?)$/i.test(p));
}
function clearIdentity(lead){ return !!(lead.company || lead.email || lead.phone || lead.linkedin || personish(lead.name)); }
function usaOk(lead){
  const b=[lead.name,lead.title,lead.company,lead.location,lead.summary,lead.url,lead.sourceQuery].join(' ');
  if(/\b(uk|london|canada|ontario|toronto|mexico|india|australia|europe|dubai|uae|china|singapore)\b/i.test(b) && !/\bUSA|United States|Texas|Dallas|Houston|Austin|Fort Worth|Oklahoma|Colorado|Louisiana|Pennsylvania|New Mexico|Wyoming|California|Florida|Arizona|New York\b/i.test(b)) return false;
  return true;
}
function investorRelevant(lead){ return /physician|surgeon|doctor|md\b|medical practice|orthopedic|gastro|clinic owner|dentist|attorney|law partner|partner|cpa|tax advisor|accounting|owner|founder|ceo|president|business owner|executive|real estate developer|oil|gas|energy|mineral|royalty|operator|entrepreneur/i.test([lead.name,lead.title,lead.summary,lead.signal,lead.sourceQuery].join(' ')); }

function scoreLead(lead){
  const b=[lead.name,lead.title,lead.company,lead.summary,lead.signal,lead.sourceQuery,lead.email,lead.phone,lead.linkedin,lead.url].join(' ').toLowerCase();
  let s=44; const sig=[]; function bump(c,p,l){ if(c){s+=p;sig.push(`${l} +${p}`);} }
  bump(/physician|surgeon|orthopedic|gastro|doctor|medical practice|clinic/.test(b),25,'Physician / medical ICP');
  bump(/owner|ceo|founder|president|business owner|entrepreneur/.test(b),22,'Business owner / founder ICP');
  bump(/partner|attorney|law firm|estate planning/.test(b),18,'Attorney / law partner ICP');
  bump(/cpa|tax advisor|accounting/.test(b),18,'CPA / tax advisor ICP');
  bump(/oil|gas|energy|mineral|royalty|idc|deduction|depletion/.test(b),14,'Oil/gas tax motivation adjacency');
  bump(/acquired|sold|opened|launch|named partner|promoted|speaker|conference|podcast|interview/.test(b),10,'Trigger event detected');
  bump(lead.contactMethods && lead.contactMethods.length,10,'Usable contact route');
  lead.scoreSignals=sig.slice(0,8);
  return Math.max(1,Math.min(98,s));
}

function buildLead(result, queryMeta){
  const blob=[result.title,result.desc,result.link].join(' ');
  const role=inferRole(blob,queryMeta.type);
  const linkedin=looksLinkedIn(result.link)?result.link:extractLinkedIn(blob);
  const email=extractEmail(blob);
  const phone=extractPhone(blob);
  const company=extractCompany(result.title);
  const lead={
    id:safeId(), name:clean(result.title.replace(/\s+-\s+[^-]+$/,'').replace(/\s+\|\s+.*$/,''),180),
    title:role, company, location:GEO, type:inferType(role),
    source:'GitHub Actions · Tavily', sourceFeed:queryMeta.source, sourceQuery:queryMeta.q,
    sourceUrl:result.link, url:result.link, sourceDate:result.pub||'', signal:inferSignal(blob),
    summary:clean(result.desc||result.title,900), email, phone, linkedin, status:'New', reviewed:false,
    foundAt:new Date().toISOString(), ts:new Date().toLocaleString('en-US',{timeZone:'America/Chicago'}),
    raw:{title:result.title,desc:result.desc,pub:result.pub,url:result.link,query:queryMeta.q,score:result.score},
    contactMethods:[]
  };
  if(email) pushMethod(lead.contactMethods,'Email',email,'High',result.link);
  if(phone) pushMethod(lead.contactMethods,'Phone',phone,'Medium',result.link);
  if(linkedin) pushMethod(lead.contactMethods,'LinkedIn',linkedin,'High',result.link);
  if(looksContactPage(result.link,result.title)) pushMethod(lead.contactMethods,'Website / Contact Page',result.link,'Medium','source');
  else if(result.link && !sourceIsNewsOnly(result.link) && !looksLinkedIn(result.link)) pushMethod(lead.contactMethods,'Company Website',result.link,'Low','source');
  return lead;
}

async function enrichLead(lead){
  const tokens=[lead.name,lead.company,lead.title].filter(Boolean).join(' ');
  if(!tokens || tokens.length<4) return lead;
  const queries=[`${tokens} email phone contact`, `${tokens} LinkedIn`, `${tokens} website contact`];
  lead.enrichmentResults=[];
  for(const q of queries){
    try{
      const results=await tavilySearch(q,3,'general');
      for(const r of results){
        const blob=[r.title,r.desc,r.link].join(' ');
        lead.enrichmentResults.push({title:r.title,link:r.link,desc:r.desc,query:q});
        const em=extractEmail(blob), ph=extractPhone(blob), li=looksLinkedIn(r.link)?r.link:extractLinkedIn(blob);
        if(em) pushMethod(lead.contactMethods,'Email',em,'Medium',r.link);
        if(ph) pushMethod(lead.contactMethods,'Phone',ph,'Medium',r.link);
        if(li) pushMethod(lead.contactMethods,'LinkedIn',li,'High',r.link);
        if(looksContactPage(r.link,r.title)) pushMethod(lead.contactMethods,'Website / Contact Page',r.link,'Medium',r.link);
        else if(!sourceIsNewsOnly(r.link)&&!looksLinkedIn(r.link)&&host(r.link)) pushMethod(lead.contactMethods,'Company Website',r.link,'Low',r.link);
      }
      await sleep(120);
    }catch(e){ lead.enrichmentError=String(e.message||e).slice(0,180); }
  }
  lead.contactMethods=lead.contactMethods.slice(0,8);
  lead.email=lead.email || ((lead.contactMethods.find(m=>m.type==='Email')||{}).value||'');
  lead.phone=lead.phone || ((lead.contactMethods.find(m=>m.type==='Phone')||{}).value||'');
  lead.linkedin=lead.linkedin || ((lead.contactMethods.find(m=>m.type==='LinkedIn')||{}).value||'');
  return lead;
}

function qualify(lead){
  const missing=[];
  if(!clearIdentity(lead)) missing.push('clear person/company identity');
  if(!usaOk(lead)) missing.push('USA-based confirmation');
  if(!investorRelevant(lead)) missing.push('qualified investor/referral-source signal');
  if(!lead.contactMethods || !lead.contactMethods.length) missing.push('usable contact route');
  lead.usaBased=missing.indexOf('USA-based confirmation')===-1;
  lead.contactable=!!(lead.contactMethods&&lead.contactMethods.length);
  lead.missingQualificationFields=missing;
  lead.qualifiedInvestorSignals=(lead.scoreSignals||[]).filter(s=>/ICP|owner|physician|attorney|CPA|Oil|tax/i.test(s));
  lead.qualificationStatus=missing.length ? 'Do Not Load' : (lead.score>=82?'Qualified':'Potential');
  lead.pipelineBlockReason=missing.join('; ');
  lead.contactSummary=lead.contactable?lead.contactMethods.map(m=>m.type).join(' + '):'No usable contact route';
  return missing.length===0;
}

async function groqRefine(lead){
  if(!GROQ_API_KEY) return lead;
  const sys='You are a strict Basin Ventures oil and gas investment lead qualification analyst. Return JSON only. Do not invent facts. A usable lead must be USA-based, have clear identity, likely qualified/accredited investor or referral source profile, and a contact route.';
  const user='Review this enriched lead. Return JSON {"qualificationStatus":"Qualified|Potential|Do Not Load","score":0,"grade":"A|B|C|D","bestAngle":"","riskFlags":[],"missingQualificationFields":[],"nextAction":""}. Lead: '+JSON.stringify(lead).slice(0,7000);
  try{
    const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_API_KEY},body:JSON.stringify({model:GROQ_MODEL,messages:[{role:'system',content:sys},{role:'user',content:user}],temperature:0.1,max_completion_tokens:900,response_format:{type:'json_object'}})});
    if(!res.ok) throw new Error('Groq HTTP '+res.status+' '+(await res.text()).slice(0,120));
    const data=await res.json();
    const j=JSON.parse(data.choices?.[0]?.message?.content||'{}');
    lead.ai=j;
    if(Number(j.score)){lead.score=Math.max(lead.score,Number(j.score));lead.grade=grade(lead.score);}
    if(j.qualificationStatus)lead.qualificationStatus=j.qualificationStatus;
    if(Array.isArray(j.missingQualificationFields)&&j.missingQualificationFields.length)lead.missingQualificationFields=j.missingQualificationFields;
    if(j.bestAngle)lead.aiAngle=j.bestAngle;
    if(j.nextAction)lead.nextAction=j.nextAction;
    if(j.riskFlags)lead.riskFlags=j.riskFlags;
  }catch(e){ lead.groqError=String(e.message||e).slice(0,180); }
  return lead;
}

function dedupeKey(l){ return clean((l.email||l.linkedin||l.phone||l.url||'')||((l.name||'')+'|'+(l.company||'')),500).toLowerCase(); }
function sortLeads(a,b){ const gv={A:4,B:3,C:2,D:1}; return (gv[b.grade]||0)-(gv[a.grade]||0)||Number(b.score||0)-Number(a.score||0)||(b.contactMethods||[]).length-(a.contactMethods||[]).length; }

async function main(){
  const diagnostics={startedAt:new Date().toISOString(),queries:0,rawResults:0,candidates:0,enriched:0,accepted:0,rejected:0,reasons:{}};
  if(!TAVILY_API_KEY){ fs.writeFileSync(OUT,'[]\n'); fs.writeFileSync(REJECT_OUT,JSON.stringify([{reason:'Missing TAVILY_API_KEY'}],null,2)); console.log('Missing TAVILY_API_KEY; wrote empty radar output.'); return; }
  const all=[];
  for(const qm of radarQueries()){
    diagnostics.queries++;
    try{
      const results=await tavilySearch(qm.q,MAX_RESULTS,/news|events|podcasts/i.test(qm.source)?'news':'general');
      diagnostics.rawResults+=results.length;
      for(const r of results) all.push(buildLead(r,qm));
    }catch(e){ console.error('Query failed:',qm.q,e.message||e); }
    await sleep(160);
  }
  const map=new Map();
  for(const l of all){ const k=dedupeKey(l); if(!k)continue; if(!map.has(k)||Number(l.score||0)>Number(map.get(k).score||0)) map.set(k,l); }
  let candidates=[...map.values()];
  diagnostics.candidates=candidates.length;
  candidates.forEach(l=>{l.score=scoreLead(l);l.grade=grade(l.score);});
  candidates.sort(sortLeads);
  for(const lead of candidates.slice(0,MAX_ENRICH)){
    if(!lead.contactMethods.length || !clearIdentity(lead)) await enrichLead(lead);
    lead.score=scoreLead(lead); lead.grade=grade(lead.score); diagnostics.enriched++;
  }
  candidates.sort(sortLeads);
  for(const lead of candidates.slice(0,MAX_GROQ)) await groqRefine(lead);
  const accepted=[], rejected=[];
  for(const lead of candidates){
    lead.score=scoreLead(lead); lead.grade=grade(lead.score);
    const ok=qualify(lead) && lead.qualificationStatus !== 'Do Not Load';
    if(ok){
      lead.nextAction=lead.nextAction || 'Day 1: use the verified contact route for a manual, signal-based email or LinkedIn touch. No auto-send.';
      lead.nurtureDraft={
        linkedin:`Hi ${lead.name.split(' ')[0]||''}, I came across ${lead.signal.toLowerCase()} and thought Basin Ventures may be relevant if direct energy ownership and potential IDC deductions are part of your planning. Worth a brief director conversation?`,
        emailSubject:'Reason for reaching out',
        emailBody:`Hi ${lead.name.split(' ')[0]||''},\n\nI came across ${lead.signal.toLowerCase()} and thought Basin Ventures may be relevant if direct energy ownership, diversification, and potential IDC deductions are part of your planning.\n\nNo guarantees, and anything tax-related should be reviewed with your CPA. Would a short director conversation be worth considering?`
      };
      accepted.push(lead);
    } else {
      const reason=lead.pipelineBlockReason||'Not actionable';
      diagnostics.reasons[reason]=(diagnostics.reasons[reason]||0)+1;
      rejected.push({name:lead.name,title:lead.title,company:lead.company,url:lead.url,score:lead.score,grade:lead.grade,reason,missingQualificationFields:lead.missingQualificationFields,contactSummary:lead.contactSummary,sourceQuery:lead.sourceQuery});
    }
  }
  accepted.sort(sortLeads);
  diagnostics.accepted=accepted.length;
  diagnostics.rejected=rejected.length;
  fs.writeFileSync(OUT, JSON.stringify(accepted,null,2)+'\n');
  fs.writeFileSync(REJECT_OUT, JSON.stringify({generatedAt:new Date().toISOString(),diagnostics,rejected},null,2)+'\n');
  console.log(`Basin Radar complete: ${diagnostics.rawResults} raw, ${diagnostics.candidates} candidates, ${accepted.length} accepted, ${rejected.length} rejected.`);
  console.log('Reject reasons:', diagnostics.reasons);
}

main().catch(err=>{ console.error(err); try{fs.writeFileSync(OUT,'[]\n');fs.writeFileSync(REJECT_OUT,JSON.stringify([{fatal:String(err.stack||err)}],null,2));}catch(e){} process.exit(1); });
