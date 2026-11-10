// Data sanity audit over the published data set: flags values that look wrong
// (split mis-adjustment, stale filings, EPS that does not match net income / shares, ...).
// Usage: node scripts/audit_data.mjs [dataDir=.cache/site]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../public/rule1.js';

const dir = process.argv[2] || '.cache/site';
const flags = {}; const add = (k, s) => (flags[k] ||= []).push(s);
const verdicts = {}; let n = 0;
const now = Date.now(), DAY = 86400000;
for (const f of readdirSync(dir).filter((x) => /^[A-Z.]+\.json$/.test(x))) {
  const t = f.replace('.json', ''); const d = JSON.parse(readFileSync(join(dir, f), 'utf8')); const p = d.prices;
  n++;
  if (!(p.price > 0)) { add('no-price', t); continue; }
  if (now - p.asOf * 1000 > 5 * DAY) add('stale-price', `${t} ${new Date(p.asOf * 1000).toISOString().slice(0, 10)}`);
  const lastM = p.monthly.at(-1)?.close; if (lastM && Math.abs(p.price / lastM - 1) > 0.25) add('price-vs-monthly', `${t} ${p.price} vs ${lastM.toFixed(2)}`);
  if (p.currency && p.currency !== 'USD') add('currency', `${t} ${p.currency}`);
  const a = analyze({ facts: d.company.facts, splits: p.splits, monthly: p.monthly, daily: p.daily, price: p.price });
  if (!a.ok) { add('not-ok', t); continue; }
  verdicts[a.verdict.code] = (verdicts[a.verdict.code] || 0) + 1;
  const last = a.last;
  if (now - Date.parse(last.end) > 500 * DAY) add('stale-10K', `${t} ${last.end}`);
  if (a.rows.length < 8) add('short-history', `${t} ${a.rows.length}y`);
  for (const r of a.rows) {
    if (r.eps && r.netIncome && r.shares) { const q = (r.netIncome / r.shares) / r.eps; if (q > 0 && (q < 0.7 || q > 1.4)) add('eps-vs-ni/shares', `${t} ${r.fy} x${q.toFixed(2)}`); }
  }
  for (let i = 1; i < a.rows.length; i++) { const x = a.rows[i - 1].shares, y = a.rows[i].shares; if (x && y && (y / x > 1.8 || y / x < 0.55)) add('share-count-jump', `${t} ${a.rows[i].fy} x${(y / x).toFixed(2)}`); }
  for (const k of ['revenue', 'eps', 'equity', 'opCash', 'capex', 'shares', 'opIncome']) if (last[k] == null) add(`missing-${k}`, t);
  if (a.ttm.value && last.eps > 0 && (a.ttm.value / last.eps > 3 || a.ttm.value / last.eps < 0.33)) add('ttm-vs-annual', `${t} ttm ${a.ttm.value.toFixed(2)} fy ${last.eps.toFixed(2)}`);
  const pe = a.ttm.value > 0 ? p.price / a.ttm.value : null; if (pe && (pe > 300 || pe < 3)) add('odd-pe', `${t} ${pe.toFixed(1)}`);
  if (a.sticker.ok) { const q = a.sticker.sticker / p.price; if (q > 5) add('sticker>5x-price', `${t} x${q.toFixed(1)} g${(a.sticker.growth * 100).toFixed(0)}%`); if (a.sticker.growth > 0.25) add('growth>25%', `${t} ${(a.sticker.growth * 100).toFixed(0)}%`); }
  if (a.hpe.points.some((x) => x.pe > 200)) add('hpe-point>200', t);
}
console.log(n, 'files', verdicts);
for (const [k, v] of Object.entries(flags).sort((a, b) => b[1].length - a[1].length)) console.log(`\n[${k}] ${v.length}: ${v.slice(0, 40).join(', ')}${v.length > 40 ? ' …' : ''}`);
