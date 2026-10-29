// Trade-level backtest with Town's sell rules, on top of scripts/backtest.mjs output.
//
// Entry: December verdict "buy" (strict universe: S&P 500 member on that date).
// Then each month: sell when the close reaches the sticker price (fully valued).
// Each December the company is re-analysed with the new filings: a new sticker
// replaces the old one, and if it is no longer a "wonderful business" we sell at
// that December close. Otherwise hold to the last available price (Oct 2026).
// Also reports plain buy-and-hold to the end for the same entries.
//
// Usage: node scripts/backtest_sell.mjs [dataDir=.cache/site] [outDir=research/backtest] [variant=book]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.argv[2] || '.cache/site';
const outDir = process.argv[3] || 'research/backtest';
const v = process.argv[4] || 'book';
// hold=strict: sell when the verdict drops to not-wonderful (>=4 of Big Five pass, none fail).
// hold=tolerant: sell only when a majority of the Big Five fail (b5pass <= 2).
const hold = process.argv[5] || 'strict';

const load = (f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
const ym = (t) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const label = (k) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
const spy = load('_SPY.json').monthly;
const spyAt = (k) => spy.find((b) => ym(b.t) === k)?.close ?? null;

const rows = JSON.parse(readFileSync(join(outDir, 'rows.json'), 'utf8'));
const byT = new Map();
for (const r of rows) { if (!byT.has(r.t)) byT.set(r.t, new Map()); byT.get(r.t).set(r.y, r); }

const trades = [];
for (const [t, years] of byT) {
  const monthly = load(`${t}.json`).prices.monthly;
  const bars = new Map(monthly.map((b) => [ym(b.t), b.close]));
  const lastK = Math.max(...bars.keys());
  let holdUntil = -1;
  for (const y of [...years.keys()].sort()) {
    const r = years.get(y);
    const k0 = y * 12 + 11;
    if (k0 <= holdUntil || !r.member || r[v].code !== 'buy') continue;
    let sticker = r.price / r[v].ratio;
    let exit = null;
    for (let k = k0 + 1; k <= lastK; k++) {
      const c = bars.get(k);
      if (c == null) continue;
      if (c >= sticker) { exit = { k, price: c, reason: 'sticker' }; break; }
      if (k % 12 === 11) { // December: re-evaluate with the new filings
        const r2 = years.get(Math.floor(k / 12));
        if (r2) {
          const stillGood = hold === 'tolerant' ? (r2[v].b5 ?? r2.b5pass ?? 0) >= 3 : ['buy', 'fair', 'expensive'].includes(r2[v].code);
          if (!stillGood) { exit = { k, price: c, reason: 'not-wonderful' }; break; }
          if (r2[v].ratio) sticker = r2.price / r2[v].ratio;
        }
      }
    }
    if (!exit) exit = { k: lastK, price: bars.get(lastK), reason: 'open' };
    holdUntil = exit.k;
    const months = exit.k - k0;
    const ret = exit.price / r.price - 1, spyRet = spyAt(exit.k) / spyAt(k0) - 1;
    const bh = bars.get(lastK) / r.price - 1, spyHold = spyAt(lastK) / spyAt(k0) - 1;
    trades.push({ t, entry: label(k0), exit: label(exit.k), months, reason: exit.reason, ret, spyRet, ann: Math.pow(1 + ret, 12 / months) - 1, spyAnn: Math.pow(1 + spyRet, 12 / months) - 1, hold: bh, spyHold, holdMonths: lastK - k0 });
  }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return !s.length ? null : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (x, d = 0) => (x == null ? '—' : (x * 100).toFixed(d) + '%');
const REASON = { sticker: 'הגיעה לסטיקר', 'not-wonderful': 'הפסיקה להיות נהדרת', open: 'עדיין מוחזקת' };

let md = `# כללי המכירה של הספר — בדיקה ברמת העסקה (${v === 'capped' ? 'צמיחה עד 25%' : 'נוסחת הספר'}; ${hold === 'tolerant' ? 'מוכרים כשרוב חמשת המספרים נכשלים' : 'מוכרים כשהפסק יורד מ"עסק נהדר"'})\n\n`;
md += `כניסה: פסק "זולה" בדצמבר (רק חברות S&P 500 באותו תאריך). מכירה: המחיר הגיע למחיר הסטיקר (נבדק כל חודש; הסטיקר מתעדכן כל דצמבר עם הדוחות החדשים), או שבבדיקה השנתית העסק הפסיק להיות "נהדר". אחרת מחזיקים עד המחיר האחרון (10/2026). לכל עסקה מוצג גם "קנה והחזק עד היום" לאותה כניסה.\n\n`;

md += `## סיכום (${trades.length} עסקאות)\n\n| מדד | לפי כללי המכירה | SPY באותה תקופה | קנה-והחזק עד היום | SPY עד היום |\n|---|---|---|---|---|\n`;
md += `| חציון תשואה | ${pct(median(trades.map((x) => x.ret)))} | ${pct(median(trades.map((x) => x.spyRet)))} | ${pct(median(trades.map((x) => x.hold)))} | ${pct(median(trades.map((x) => x.spyHold)))} |\n`;
md += `| ממוצע תשואה | ${pct(mean(trades.map((x) => x.ret)))} | ${pct(mean(trades.map((x) => x.spyRet)))} | ${pct(mean(trades.map((x) => x.hold)))} | ${pct(mean(trades.map((x) => x.spyHold)))} |\n`;
md += `| חציון תשואה שנתית | ${pct(median(trades.map((x) => x.ann)), 1)} | ${pct(median(trades.map((x) => x.spyAnn)), 1)} | | |\n`;
md += `| היכו את SPY | ${pct(trades.filter((x) => x.ret > x.spyRet).length / trades.length)} | | ${pct(trades.filter((x) => x.hold > x.spyHold).length / trades.length)} | |\n`;
md += `| עסקאות חיוביות | ${pct(trades.filter((x) => x.ret > 0).length / trades.length)} | | ${pct(trades.filter((x) => x.hold > 0).length / trades.length)} | |\n`;
md += `| חציון חודשי החזקה | ${median(trades.map((x) => x.months))} | | ${median(trades.map((x) => x.holdMonths))} | |\n\n`;

md += `### לפי סיבת היציאה\n\n| סיבה | n | חציון תשואה | חציון SPY באותה תקופה | היכו את SPY | חציון חודשים |\n|---|---|---|---|---|---|\n`;
for (const k of ['sticker', 'not-wonderful', 'open']) {
  const s = trades.filter((x) => x.reason === k);
  if (!s.length) continue;
  md += `| ${REASON[k]} | ${s.length} | ${pct(median(s.map((x) => x.ret)))} | ${pct(median(s.map((x) => x.spyRet)))} | ${pct(s.filter((x) => x.ret > x.spyRet).length / s.length)} | ${median(s.map((x) => x.months))} |\n`;
}

// The longest holds: entries of 2016-2017 held to today (≈9-10 years).
const early = trades.filter((x) => x.entry.startsWith('2016') || x.entry.startsWith('2017'));
if (early.length) {
  md += `\n### כניסות 2016–2017, החזקה עד היום (~9–10 שנים)\n\n| מניה | כניסה | קנה-והחזק | SPY | לפי כללי המכירה | יצאה | סיבה |\n|---|---|---|---|---|---|---|\n`;
  for (const x of early) md += `| ${x.t} | ${x.entry} | ${pct(x.hold)} | ${pct(x.spyHold)} | ${pct(x.ret)} | ${x.exit} | ${REASON[x.reason]} |\n`;
}

md += `\n## כל העסקאות\n\n| מניה | כניסה | יציאה | חודשים | סיבה | תשואה | SPY | שנתי | SPY שנתי | קנה-והחזק | SPY עד היום |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const x of trades.sort((a, b) => a.entry.localeCompare(b.entry) || a.t.localeCompare(b.t))) {
  md += `| ${x.t} | ${x.entry} | ${x.exit} | ${x.months} | ${REASON[x.reason]} | ${pct(x.ret)} | ${pct(x.spyRet)} | ${pct(x.ann, 1)} | ${pct(x.spyAnn, 1)} | ${pct(x.hold)} | ${pct(x.spyHold)} |\n`;
}

writeFileSync(join(outDir, `SELL_RULES_${v}_${hold}_HE.md`), md);
console.log(md);
