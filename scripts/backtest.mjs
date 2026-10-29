// Point-in-time backtest of the Rule #1 verdict on the published data set.
//
// For every December from 2016 on, each company is analysed with only the SEC rows
// filed by Dec 31 of that year and only the prices known by then; the verdict is then
// compared with the forward 1/3/5-year price return (no dividends) and with SPY.
//
// Two universes: "all" = every company in today's data set (survivorship-biased), and
// "strict" = only companies that were already S&P 500 members on the as-of date
// (Wikipedia "Date added"), which removes the "grew into the index later" bias.
// Two variants of the sticker: "book" (growth = BVPS growth, uncapped) and
// "capped" (growth capped at CAP), because uncapped BVPS growth from a tiny base
// produces absurd stickers (ANET, IDXX, COIN, UPS...).
//
// Usage: node scripts/backtest.mjs [dataDir=.cache/site] [outDir=research/backtest]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../public/rule1.js';

const dataDir = process.argv[2] || '.cache/site';
const outDir = process.argv[3] || 'research/backtest';
const YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
const HORIZONS = [1, 3, 5];
const CAP = 0.25;
const DRAWS = 10000;

const load = (f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
const ym = (t) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
// Yahoo monthly bars are stamped on the 1st and carry that month's final close.
const closeAt = (monthly, y, m) => monthly.find((b) => ym(b.t) === y * 12 + m)?.close ?? null;

// Keep only SEC rows filed on or before the cutoff (string compare works on ISO dates).
function pointInTime(facts, cutoff) {
  const out = {};
  for (const [concept, node] of Object.entries(facts)) {
    const units = {};
    for (const [u, rows] of Object.entries(node.units)) {
      const keep = rows.filter((r) => r.filed && r.filed <= cutoff);
      if (keep.length) units[u] = keep;
    }
    if (Object.keys(units).length) out[concept] = { units };
  }
  return out;
}

const spy = load('_SPY.json').monthly;
const added = load('_added.json'); // S&P 500 ticker -> date added (ISO)
const files = readdirSync(dataDir).filter((f) => /^[A-Z.]+\.json$/.test(f));
const rows = [];
for (const f of files) {
  const t = f.replace('.json', '');
  let doc;
  try { doc = load(f); } catch { continue; }
  const { facts } = doc.company;
  const { splits, monthly } = doc.prices;
  for (const y of YEARS) {
    const cutoff = `${y}-12-31`;
    const price = closeAt(monthly, y, 11);
    if (price == null) continue;
    const pit = pointInTime(facts, cutoff);
    const mon = monthly.filter((b) => ym(b.t) <= y * 12 + 11);
    const base = { facts: pit, splits, monthly: mon, daily: [], price, asOf: cutoff };
    const book = analyze(base);
    const capped = book.ok && book.sticker.ok && book.sticker.growth > CAP ? analyze({ ...base, growthOverride: CAP }) : book;
    const row = { t, y, price, member: !!added[t] && added[t] <= cutoff, years: book.ok ? book.rows.length : 0, b5pass: book.ok ? book.b5pass : null };
    for (const [v, r] of [['book', book], ['capped', capped]]) {
      row[v] = { code: r.ok ? r.verdict.code : 'no-data', growth: r.ok && r.sticker.ok ? r.sticker.growth : null, ratio: r.ok && r.sticker.ok ? price / r.sticker.sticker : null };
    }
    // "soft" Big Five, closer to the book's wording: each number is judged on its longest
    // available window (10 years when there are 10); the 5/3/1-year windows are trend context.
    // Wonderful = at least 4 of 5 at >= 10%.
    const softPass = book.ok ? book.big5.filter((m) => { const w = m.windows.find((x) => x.value != null); return w && w.value >= 0.1; }).length : 0;
    const softCode = (r) => {
      if (!r.ok) return 'no-data';
      if (book.big5.filter((m) => m.status === 'unknown').length >= 2) return 'no-price';
      if (softPass < 4) return 'not-wonderful';
      if (!r.sticker.ok) return 'no-price';
      return price <= r.sticker.mos ? 'buy' : price <= r.sticker.sticker ? 'fair' : 'expensive';
    };
    for (const [v, r] of [['soft', book], ['softCapped', capped]]) {
      row[v] = { code: softCode(r), growth: r.ok && r.sticker.ok ? r.sticker.growth : null, ratio: r.ok && r.sticker.ok ? price / r.sticker.sticker : null, b5: softPass };
    }
    for (const h of HORIZONS) {
      const p1 = closeAt(monthly, y + h, 11), s0 = closeAt(spy, y, 11), s1 = closeAt(spy, y + h, 11);
      row[`r${h}`] = p1 != null ? p1 / price - 1 : null;
      row[`spy${h}`] = s0 != null && s1 != null ? s1 / s0 - 1 : null;
    }
    rows.push(row);
  }
}

// ---------- aggregation ----------
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return !s.length ? null : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (v, d = 1) => (v == null ? '—' : (v * 100).toFixed(d) + '%');

function stats(sel, h) {
  const xs = sel.filter((r) => r[`r${h}`] != null);
  const rets = xs.map((r) => r[`r${h}`]), exc = xs.map((r) => r[`r${h}`] - r[`spy${h}`]);
  return { n: xs.length, med: median(rets), avg: mean(rets), medExc: median(exc), beat: xs.length ? exc.filter((e) => e > 0).length / xs.length : null, pos: xs.length ? rets.filter((e) => e > 0).length / xs.length : null };
}

const GROUPS = [
  ['buy', 'זולה (קנייה)', (x) => x.code === 'buy'],
  ['fair', 'מחיר הוגן', (x) => x.code === 'fair'],
  ['expensive', 'יקרה', (x) => x.code === 'expensive'],
  ['wonderful', 'כל "העסקים הנהדרים" (זולה+הוגן+יקרה)', (x) => ['buy', 'fair', 'expensive'].includes(x.code)],
  ['not-wonderful', 'לא עסק נהדר', (x) => x.code === 'not-wonderful'],
  ['no-price', 'אין נתונים/תמחור', (x) => x.code === 'no-price' || x.code === 'no-data'],
  ['all', 'כל היקום (שווה-משקל)', () => true],
];

// Deterministic PRNG so the permutation test is reproducible.
let seed = 20261029;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function portfolioSection(uni, v, label, isPick) {
  let md = `### תיק "${label}" שווה-משקל, קנייה בדצמבר, החזקה לשנה\n\n| שנת קנייה | n בתיק | תשואת התיק | SPY | כל היקום | עודף מול היקום |\n|---|---|---|---|---|---|\n`;
  let port = 1, bench = 1, uniC = 1;
  const perYear = [];
  for (const y of YEARS) {
    const yr = uni.filter((r) => r.y === y && r.r1 != null);
    if (!yr.length) continue;
    const buys = yr.filter((r) => isPick(r[v]));
    const pr = buys.length ? mean(buys.map((r) => r.r1)) : 0, sr = yr[0].spy1, ur = mean(yr.map((r) => r.r1));
    port *= 1 + pr; bench *= 1 + sr; uniC *= 1 + ur;
    perYear.push({ yr, n: buys.length });
    md += `| ${y} | ${buys.length} | ${pct(pr)} | ${pct(sr)} | ${pct(ur)} | ${pct(pr - ur)} |\n`;
  }
  md += `| **מצטבר** | | **${pct(port - 1)}** | **${pct(bench - 1)}** | **${pct(uniC - 1)}** | |\n\n(שנה בלי אף מניה בתיק = מזומן, 0%.)\n\n`;
  // Permutation test: same number of random picks from the same universe each year.
  let ge = 0;
  for (let d = 0; d < DRAWS; d++) {
    let p = 1;
    for (const { yr, n } of perYear) {
      if (!n) continue;
      const pick = new Set();
      while (pick.size < n) pick.add(Math.floor(rand() * yr.length));
      p *= 1 + mean([...pick].map((i) => yr[i].r1));
    }
    if (p >= port) ge++;
  }
  const pv = ge / DRAWS;
  md += `**מבחן תמורות:** ${DRAWS.toLocaleString('en-US')} תיקים אקראיים עם אותו מספר מניות בכל שנה מאותו יקום. ${pct(pv, 1)} מהם הגיעו לתשואה מצטברת ≥ ${pct(port - 1)} (p = ${pv.toFixed(3)}; ${pv < 0.05 ? 'מובהק ברמת 5%' : 'לא מובהק ברמת 5%'}).\n\n`;
  return md;
}

function section(title, uni, v, intro) {
  let md = `## ${title}\n\n${intro}\n\n`;
  for (const h of HORIZONS) {
    md += `### אופק ${h} שנים\n\n| קבוצה | n | חציון תשואה | ממוצע | חציון עודף מול SPY | היכו את SPY | חיוביות |\n|---|---|---|---|---|---|---|\n`;
    for (const [, label, fn] of GROUPS) {
      const s = stats(uni.filter((r) => fn(r[v])), h);
      if (!s.n) continue;
      md += `| ${label} | ${s.n} | ${pct(s.med)} | ${pct(s.avg)} | ${pct(s.medExc)} | ${pct(s.beat, 0)} | ${pct(s.pos, 0)} |\n`;
    }
    md += '\n';
  }
  md += portfolioSection(uni, v, 'זולות', (x) => x.code === 'buy');
  md += portfolioSection(uni, v, 'עסקים נהדרים בכל מחיר', (x) => ['buy', 'fair', 'expensive'].includes(x.code));
  // Does the discount to sticker rank returns?
  for (const [label, fn] of [['כל חברה עם סטיקר', () => true], ['רק עסקים נהדרים', (x) => ['buy', 'fair', 'expensive'].includes(x.code)]]) {
    const won = uni.filter((r) => r[v].ratio != null && r.r3 != null && fn(r[v])).sort((a, b) => a[v].ratio - b[v].ratio);
    if (won.length < 25) continue;
    md += `### חמישוני מחיר/סטיקר — ${label}, אופק 3 שנים\n\n| חמישון | טווח מחיר/סטיקר | n | חציון תשואה 3ש | חציון עודף מול SPY |\n|---|---|---|---|---|\n`;
    for (let q = 0; q < 5; q++) {
      const part = won.slice(Math.floor(q * won.length / 5), Math.floor((q + 1) * won.length / 5));
      if (!part.length) continue;
      const s = stats(part, 3);
      md += `| ${q + 1}${q === 0 ? ' (הכי זול)' : q === 4 ? ' (הכי יקר)' : ''} | ${part[0][v].ratio.toFixed(2)}–${part.at(-1)[v].ratio.toFixed(2)} | ${s.n} | ${pct(s.med)} | ${pct(s.medExc)} |\n`;
    }
    md += '\n';
  }
  md += `### מי היו ה"זולות"\n\n`;
  for (const y of YEARS) {
    const b = uni.filter((r) => r.y === y && r[v].code === 'buy');
    md += `- **${y}:** ${b.length ? b.map((r) => `${r.t} (צמיחה ${pct(r[v].growth, 0)}, מחיר/סטיקר ${r[v].ratio.toFixed(2)}, שנה קדימה ${pct(r.r1, 0)})`).join('; ') : 'אף אחת'}\n`;
  }
  return md + '\n';
}

const strict = rows.filter((r) => r.member);
let md = `# בק-טסט של פסק הדין לפי Rule #1\n\nנוצר ${new Date().toISOString().slice(0, 10)} מ-${files.length} חברות (S&P 500 + Nasdaq-100 + נוספות, הרכב **נוכחי**).\n`;
md += `בכל 31 בדצמבר ${YEARS[0]}–${YEARS.at(-1)} כל חברה נותחה רק עם הדוחות שהוגשו עד אז ועם המחירים שהיו ידועים אז, ונמדדה התשואה קדימה (מחיר בלבד, בלי דיבידנדים) מול SPY.\n\n`;
md += `**מגבלות שחייבים לזכור:** (1) הטיית-שורדים — היקום הוא ההרכב של היום; חברות שנמחקו/נרכשו/קרסו חסרות, ולכן כל הקבוצות נראות טובות מדי, וההשוואה ההוגנת היא **בין הקבוצות** ומול "כל היקום", לא מול SPY. היקום ה"קפדני" (חברות שכבר היו ב-S&P 500 בתאריך הבדיקה) מסיר את ההטיה של "צמחה לתוך המדד אחר כך" אבל לא את הנשירה. (2) נתוני SEC מתחילים ב-2012, כך שבשנים הראשונות יש 4–6 שנות היסטוריה ומבחן 10 השנים לא קיים. (3) ללא דיבידנדים. (4) בלי הערכות אנליסטים — הצמיחה היא צמיחת ההון העצמי ההיסטורית בלבד. (5) מדגמי ה"זולות" קטנים (3–15 בשנה) — מספרים בודדים מזיזים הכל.\n\n`;
md += `| יקום | שורות חברה-שנה | חברות |\n|---|---|---|\n| כל 519 | ${rows.length} | ${new Set(rows.map((r) => r.t)).size} |\n| קפדני (S&P 500 בתאריך) | ${strict.length} | ${new Set(strict.map((r) => r.t)).size} |\n\n`;

md += section('א. היקום הקפדני, נוסחת הספר כמו שהיא', strict, 'book', 'רק חברות שכבר היו ב-S&P 500 בתאריך הבדיקה. צמיחה = צמיחת ההון העצמי ההיסטורית בלי תקרה (כמו באתר היום).');
md += section(`ב. היקום הקפדני, צמיחה מוגבלת ל-${CAP * 100}%`, strict, 'capped', `כמו א, אבל שיעור הצמיחה בנוסחת הסטיקר נחתך ב-${CAP * 100}% (ולכן גם המכפיל העתידי ≤ ${CAP * 200}). בודק אם האזהרה על "צמיחה גבוהה מאוד" צריכה להפוך לכלל.`);
md += section('ג. היקום הקפדני, חמשת המספרים לפי החלון הארוך ביותר ("לפי הספר"), נוסחת הספר', strict, 'soft', 'כל מספר נבדק על החלון הארוך ביותר הזמין (10 שנים כשיש); חלונות 5/3/1 הם מגמה בלבד. "עסק נהדר" = לפחות 4 מתוך 5 מעל 10%. הסטיקר כמו בסעיף א.');
md += section(`ד. היקום הקפדני, חמשת המספרים לפי החלון הארוך ביותר, צמיחה מוגבלת ל-${CAP * 100}%`, strict, 'softCapped', 'כמו ג, עם הסטיקר של סעיף ב.');
md += section('ה. כל 519 החברות, נוסחת הספר (הטיית-שורדים מלאה — להשוואה בלבד)', rows, 'book', 'כולל חברות שנכנסו למדדים אחרי תאריך הבדיקה, ולכן מנופח.');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'rows.json'), JSON.stringify(rows));
writeFileSync(join(outDir, 'REPORT_HE.md'), md);
console.log(md);
