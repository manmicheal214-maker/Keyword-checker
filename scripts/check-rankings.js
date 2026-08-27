'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = {
  k: path.join(ROOT, 'config/keywords.json'),
  s: path.join(ROOT, 'config/settings.json'),
  r: path.join(ROOT, 'data/rankings.json'),
  h: path.join(ROOT, 'data/history.json')
};

const KEY = process.env.ZENROWS_API_KEY;
const D = {
  country: 'India', country_code: 'in', language: 'en', search_engine: 'google',
  google_tld: '.co.in', max_keywords_per_domain: 50, max_domains: 5,
  max_position: 10, request_delay_ms: 2000, request_timeout_ms: 60000,
  max_retries: 2, history_days: 365
};

const read = (f, d) => {
  if (!fs.existsSync(f)) return d;
  const s = fs.readFileSync(f, 'utf8');
  return s.trim() ? JSON.parse(s) : d;
};
const write = (f, d) => {
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(d, null, 2) + '\n');
  fs.renameSync(t, f);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function dom(v) {
  try { return new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
  catch { return null; }
}
function match(link, target) {
  try {
    const h = new URL(link).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return h === target || h.endsWith('.' + target);
  } catch { return false; }
}

function firstUrl(k, s) {
  // Restore the previously working ZenRows Google Search API request shape.
  // Do not pass a full Google URL; this endpoint expects the search query
  // in the path and the optional locale parameters as query parameters.
  const u = new URL('https://serp.api.zenrows.com/v1/targets/google/search/' + encodeURIComponent(k));
  u.searchParams.set('apikey', KEY);
  if (s.country_code) u.searchParams.set('country', s.country_code);
  if (s.google_tld) u.searchParams.set('tld', s.google_tld);
  return u;
}

async function get(u, s, label) {
  let last;
  for (let a = 0; a <= Number(s.max_retries); a++) {
    const c = new AbortController();
    const tm = setTimeout(() => c.abort(), Number(s.request_timeout_ms));
    try {
      const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: c.signal });
      const txt = await r.text();
      let d = null;
      try { d = txt ? JSON.parse(txt) : null; } catch {}
      if (!r.ok) {
        const e = new Error('ZenRows HTTP ' + r.status + (d?.detail ? ': ' + d.detail : ''));
        e.httpStatus = r.status;
        throw e;
      }
      if (!d || typeof d !== 'object') throw new Error('ZenRows returned invalid JSON.');
      return d;
    } catch (e) {
      last = e;
      if (a < Number(s.max_retries)) {
        const ms = e.httpStatus >= 500 ? Math.min(30000, 5000 * 2 ** a) : Math.min(10000, 1000 * 2 ** a);
        console.warn('Request failed for "' + label + '". Retrying in ' + ms + 'ms...');
        await sleep(ms);
      }
    } finally { clearTimeout(tm); }
  }
  throw last;
}

async function serp(k, s) {
  const d = await get(firstUrl(k, s), s, k);
  const rows = Array.isArray(d.organic_results) ? d.organic_results : [];
  if (!rows.length) throw new Error('ZenRows returned zero organic results for "' + k + '". Refusing to treat this as not ranking.');
  return { rows: rows.slice(0, Number(s.max_position) || 10), pages: 1 };
}

function find(rows, d) {
  for (let i = 0; i < rows.length; i++) if (rows[i]?.link && match(rows[i].link, d)) return { position: i + 1, url: rows[i].link };
  return { position: null, url: null };
}
function prev(doc, d, k) {
  const a = doc?.domains?.[d]?.keywords;
  if (!Array.isArray(a)) return null;
  const x = a.find(v => String(v.keyword || '').trim().toLowerCase() === k.trim().toLowerCase());
  return Number.isFinite(x?.position) ? x.position : null;
}
function mainDoc(s) {
  const x = read(F.r, null) || { domains: {} };
  x.domains = x.domains && typeof x.domains === 'object' ? x.domains : {};
  x.last_updated = new Date().toISOString();
  x.country = s.country; x.country_code = s.country_code; x.language = s.language;
  x.search_engine = s.search_engine; x.max_position = Number(s.max_position) || 10;
  return x;
}

async function main() {
  console.log('==========================================\nIndia Google Rank Checker\n==========================================');
  const s = { ...D, ...read(F.s, {}) };
  s.country_code = s.country_code || (String(s.country).toLowerCase() === 'india' ? 'in' : '');
  s.google_tld = s.google_tld || (String(s.country).toLowerCase() === 'india' ? '.co.in' : '');
  s.max_position = Number(s.max_position) || 10;

  const cfg = read(F.k, null);
  if (!KEY) throw Error('ZENROWS_API_KEY environment variable is missing.');
  if (!Array.isArray(cfg?.domains) || !cfg.domains.length) throw Error('config/keywords.json must contain domains.');
  if (cfg.domains.length > Number(s.max_domains)) throw Error('Maximum allowed domains: ' + s.max_domains);

  const old = read(F.r, null), r = mainDoc(s);
  const h = read(F.h, null) || { history: {} };
  h.history = h.history && typeof h.history === 'object' ? h.history : {};
  const checked = r.last_updated;
  let failedKeywords = 0;

  for (const dc of cfg.domains) {
    const d = dom(dc.domain);
    if (!d) throw Error('Invalid domain: ' + dc.domain);
    r.domains[d] = { domain: d, keywords: [] };
    console.log('Domain: ' + d);

    for (let i = 0; i < dc.keywords.length; i++) {
      const k = dc.keywords[i].trim();
      console.log('[' + (i + 1) + '/' + dc.keywords.length + '] ' + k);
      const p = prev(old, d, k);
      try {
        const z = await serp(k, s), f = find(z.rows, d), status = f.position === null ? 'not_ranking' : 'ranking';
        const rec = { keyword: k, position: f.position, previous_position: p, change: Number.isFinite(p) && Number.isFinite(f.position) ? p - f.position : null, url: f.url, status, checked_at: checked };
        r.domains[d].keywords.push(rec);
        h.history[d] ??= {}; h.history[d][k] ??= [];
        h.history[d][k].push({ checked_at: checked, position: f.position, status });
        console.log(f.position === null ? '  NOT IN TOP ' + s.max_position : '  Position: ' + f.position);
      } catch (e) {
        failedKeywords++;
        const message = String(e?.message || e).slice(0, 500);
        r.domains[d].keywords.push({ keyword: k, position: null, previous_position: p, change: null, url: null, status: 'error', error: message, checked_at: checked });
        console.error('  ERROR: ' + message);
      }
      if (Number(s.request_delay_ms) > 0 && i < dc.keywords.length - 1) await sleep(Number(s.request_delay_ms));
    }
  }

  h.last_updated = checked;
  write(F.r, r); write(F.h, h);
  if (failedKeywords) console.warn('Ranking check completed with ' + failedKeywords + ' keyword error(s).');
  else console.log('==========================================\nRanking check completed — Top ' + s.max_position + '\n==========================================');
}
main().catch(e => { console.error('FATAL ERROR: ' + e.message); process.exit(1); });
