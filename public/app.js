import { analyze, fmtUsd, DEFAULTS } from './rule1.js';

const $ = (s) => document.querySelector(s);
const out = $('#out');
const state = { company: null, prices: null, params: { analyst: '', growth: '', pe: '', marr: '15' } };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Escape, then isolate every number so signs and $ stay put inside Hebrew text.
const bidi = (s) => esc(s).replace(/-?\$?-?\d[\d,]*(?:\.\d+)?%?/g, (m) => `<bdi>${m}</bdi>`);
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
const big = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(1)}M`;
  return `${s}${a.toFixed(0)}`;
};
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const parseParam = (s) => (s === '' || s == null ? null : Number(s));

async function getJson(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `שגיאה ${r.status}`);
  return j;
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('#ticker').value.trim().toUpperCase().replace(/-/g, '.');
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) { showError('סימול לא תקין'); return; }
  history.replaceState(null, '', `#${t}`);
  await load(t);
});

// Local server = live /api; anywhere else (GitHub Pages) = nightly static files under data/.
const STATIC = !['127.0.0.1', 'localhost'].includes(location.hostname);
let universe = null;

async function loadUniverse() {
  if (!STATIC) return;
  try {
    universe = await getJson('data/index.json');
    const dl = document.getElementById('tlist');
    dl.innerHTML = universe.tickers.map((x) => `<option value="${esc(x.t)}">${esc(x.n)}</option>`).join('');
    const when = new Date(universe.builtAt * 1000).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
    const extra = universe.tickers.filter((x) => x.i.includes('extra')).length;
    $('#coverage').textContent = `${universe.tickers.length} מניות: S&P 500, Nasdaq-100${extra ? ` ועוד ${extra} שהוספת` : ''} · הנתונים עודכנו ב-${when}`;
  } catch { /* the search still works without suggestions */ }
}

async function fetchStock(t) {
  if (!STATIC) return Promise.all([getJson(`/api/company/${t}`), getJson(`/api/prices/${t}`)]);
  const r = await fetch(`data/${encodeURIComponent(t)}.json`);
  if (r.status === 404) throw new Error(`המניה ${t} עוד לא ברשימה. האתר מכסה את S&P 500, את Nasdaq-100 ומניות שביקשת להוסיף. בקש מקלוד להוסיף אותה, והיא תופיע אחרי הבנייה הבאה.`);
  if (!r.ok) throw new Error(`שגיאה ${r.status}`);
  const j = await r.json();
  return [j.company, j.prices];
}

async function load(t) {
  const btn = $('#form button');
  btn.disabled = true;
  out.innerHTML = `<div class="card loading">טוען דוחות ומחירים עבור <b class="ltr">${esc(t)}</b>…</div>`;
  try {
    const [company, prices] = await fetchStock(t);
    state.company = company; state.prices = prices;
    state.params = { analyst: '', growth: '', pe: '', marr: '15' };
    render();
    renderCharts(company.ticker, prices.exchange);
  } catch (err) {
    charts.innerHTML = '';
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
}

function showError(msg) {
  out.innerHTML = `<div class="card err">${esc(msg)}</div>`;
}

// ---------- Live TradingView charts (official embed widget) ----------
// Rendered once per ticker, outside #out, so editing an assumption does not reload them.
const charts = document.getElementById('charts');
const TV_SCRIPT = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

function tvSymbol(ticker, exchange) {
  const ex = String(exchange || '');
  const prefix = /nasdaq/i.test(ex) ? 'NASDAQ' : /american|arca/i.test(ex) ? 'AMEX' : /nyse/i.test(ex) ? 'NYSE' : '';
  return prefix ? `${prefix}:${ticker}` : ticker;
}

const CHARTS = [
  {
    title: 'גרף יומי עם שלושת הכלים של טאון',
    note: 'ממוצע נע 10 ימים על המחיר, MACD (8,17,9) וסטוכסטיק (14,5). כמו בכרטיס "שלושת הכלים" למעלה, רק על הגרף עצמו.',
    interval: 'D', range: '6M',
    studies: [
      { id: 'MASimple@tv-basicstudies', inputs: { length: 10 } },
      { id: 'MACD@tv-basicstudies', inputs: { fastLength: 8, slowLength: 17, signalLength: 9 } },
      { id: 'Stochastic@tv-basicstudies', inputs: { length: 14, smoothD: 5 } },
    ],
  },
  {
    title: 'גרף שבועי לטווח ארוך',
    note: 'חמש שנים של נרות שבועיים עם ממוצעים נעים 50 ו-200 ו-RSI (14), כדי לראות את המגמה הגדולה.',
    interval: 'W', range: '60M',
    studies: [
      { id: 'MASimple@tv-basicstudies', inputs: { length: 50 } },
      { id: 'MASimple@tv-basicstudies', inputs: { length: 200 } },
      { id: 'RSI@tv-basicstudies', inputs: { length: 14 } },
    ],
  },
];

function renderCharts(ticker, exchange) {
  const symbol = tvSymbol(ticker, exchange);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const height = innerWidth < 640 ? 520 : 640;
  charts.innerHTML = `<section class="card"><h2>גרפים חיים מ-TradingView</h2>
    <p class="muted" style="margin-top:-6px">הגרפים חיים: אפשר להזיז, להגדיל ולהוסיף כלים. הסימול: <bdi>${esc(symbol)}</bdi>.</p>
    ${CHARTS.map((c, i) => `<h3>${esc(c.title)}</h3><p class="note" style="margin:0 0 8px">${esc(c.note)}</p>
      <div class="tvbox"><div class="tradingview-widget-container" id="tv${i}"><div class="tradingview-widget-container__widget"></div></div></div>`).join('')}
  </section>`;
  CHARTS.forEach((c, i) => {
    const s = document.createElement('script');
    s.src = TV_SCRIPT;
    s.async = true;
    // The widget reads its JSON config from the script element's text.
    s.textContent = JSON.stringify({
      symbol, interval: c.interval, range: c.range, timezone: 'America/New_York',
      theme: dark ? 'dark' : 'light', style: '1', locale: 'he_IL',
      width: '100%', height, allow_symbol_change: false, calendar: false,
      hide_volume: false, support_host: 'https://www.tradingview.com', studies: c.studies,
    });
    document.getElementById(`tv${i}`).appendChild(s);
  });
}

function run() {
  const { company: c, prices: p, params: q } = state;
  const analyst = parseParam(q.analyst), growth = parseParam(q.growth), pe = parseParam(q.pe), marr = parseParam(q.marr);
  return analyze({
    facts: c.facts, splits: p.splits, monthly: p.monthly, daily: p.daily, price: p.price,
    analystGrowth: analyst != null ? analyst / 100 : null,
    growthOverride: growth != null ? growth / 100 : null,
    peOverride: pe,
    marr: marr > 0 ? marr / 100 : DEFAULTS.marr,
  });
}

function render() {
  const a = run();
  if (!a.ok) { showError(a.reason); return; }
  const c = state.company, p = state.prices;
  out.innerHTML = [verdictCard(a, c, p), bigFiveCard(a), `<div class="grid2">${stickerCard(a)}${extrasCard(a)}</div>`, toolsCard(a), dataCard(a)].join('');
  bindParams();
}

function verdictCard(a, c, p) {
  const s = a.sticker;
  const kpis = [
    ['מחיר נוכחי', fmtUsd(a.price)],
    ['מחיר סטיקר (שווי)', s.ok ? fmtUsd(s.sticker) : '—'],
    ['מחיר קנייה (מרווח ביטחון)', s.ok ? fmtUsd(s.mos) : '—'],
    ['חמשת המספרים', `${a.b5pass} / 5`],
  ];
  return `<section class="card verdict v-${a.verdict.code}">
    <div class="row"><div><div class="name">${esc(c.name)} <span class="tk ltr">${esc(c.ticker)}</span></div>
    <div class="muted">${esc(p.exchange || '')} · דוח שנתי אחרון: ${esc(a.last.end || a.last.fy)}${p.asOf ? ` · מחיר נכון ל-${esc(new Date(p.asOf * 1000).toLocaleDateString('he-IL'))}` : ''}</div></div></div>
    <div class="badge">${esc(a.verdict.title)}</div>
    <div>${bidi(a.verdict.text)}</div>
    ${s.ok ? priceBar(a.price, s.mos, s.sticker) : ''}
    ${a.warnings.length ? `<ul class="warns">${a.warnings.map((w) => `<li>${bidi(w)}</li>`).join('')}</ul>` : ''}
    <div class="kpis">${kpis.map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
  </section>`;
}

function priceBar(price, mos, sticker) {
  const max = Math.max(price, sticker) * 1.15;
  const pos = (v) => Math.min(Math.max((v / max) * 100, 0), 100);
  return `<div class="bar" role="img" aria-label="מיקום המחיר מול מחיר הקנייה והשווי">
    <div class="tick" style="right:${pos(mos)}%"><span>קנייה ${fmtUsd(mos)}</span></div>
    <div class="tick" style="right:${pos(sticker)}%"><span>שווי ${fmtUsd(sticker)}</span></div>
    <div class="tick now" style="right:${pos(price)}%"><span>עכשיו ${fmtUsd(price)}</span></div>
  </div>`;
}

function bigFiveCard(a) {
  const head = `<tr><th>מדד</th>${[10, 5, 3, 1].map((n) => `<th>${n === 1 ? 'שנה' : n + ' שנים'}</th>`).join('')}<th>מצב</th></tr>`;
  const st = { pass: ['ok', 'עובר'], fail: ['no', 'נכשל'], mixed: ['mix', 'חלקי'], unknown: ['na', 'אין נתון'] };
  const rows = a.big5.map((m) => `<tr><td>${esc(m.label)}${m.mode === 'average' ? '<small class="muted"> (ממוצע)</small>' : ''}</td>
    ${m.windows.map((w) => `<td><span class="cell num ${w.negative ? 'no' : w.value == null ? 'na' : w.pass ? 'ok' : 'no'}" title="${esc(w.reason || '')}">${w.negative ? 'שלילי' : pct(w.value)}</span></td>`).join('')}
    <td><span class="cell ${st[m.status][0]}">${st[m.status][1]}</span></td></tr>`).join('');
  return `<section class="card"><h2>חמשת המספרים הגדולים</h2>
    <p class="muted" style="margin-top:-6px">כל מספר צריך להיות לפחות 10%, ובעקביות לאורך כל התקופות. עקביות כזאת מעידה שיש לעסק חפיר.</p>
    <div class="scroll"><table class="bf">${head}${rows}</table></div>
    <p class="note">צמיחה = קצב שנתי ממוצע (CAGR) מהשנה הבסיסית עד הדוח האחרון. ROIC = רווח תפעולי אחרי מס חלקי (הון עצמי + חוב לטווח ארוך). כשיש ערך שלילי בתחילת התקופה או בסופה אין צמיחה, והתא מסומן "שלילי" באדום. תא אפור = אין מספיק היסטוריה.</p>
  </section>`;
}

function stickerCard(a) {
  const s = a.sticker, q = state.params;
  const params = `<div class="params">
    <div><label for="p-analyst">הערכת צמיחה של אנליסטים (%)</label><input id="p-analyst" inputmode="decimal" value="${esc(q.analyst)}" placeholder="לא חובה"></div>
    <div><label for="p-growth">דריסת צמיחה ידנית (%)</label><input id="p-growth" inputmode="decimal" value="${esc(q.growth)}" placeholder="אוטומטי"></div>
    <div><label for="p-pe">מכפיל עתידי ידני</label><input id="p-pe" inputmode="decimal" value="${esc(q.pe)}" placeholder="אוטומטי"></div>
    <div><label for="p-marr">תשואה מינימלית (%)</label><input id="p-marr" inputmode="decimal" value="${esc(q.marr)}"></div>
  </div>`;
  if (!s.ok) return `<section class="card"><h2>מחיר הסטיקר</h2><p>${esc(s.reason)}</p>
    <p class="note">אפשר להזין צמיחה ידנית כדי לראות מה היה המחיר בהנחה אחרת.</p>${params}</section>`;
  const steps = [
    a.ttm.quarters > 0
      ? ['רווח למניה ב-12 החודשים האחרונים (TTM)', `$${num(s.eps)}`,
        `דוח שנתי ${a.last.fy} ($${num(a.ttm.parts.annual)}) + ${a.ttm.quarters} רבעונים ($${num(a.ttm.parts.ytd)}) − אותם רבעונים אשתקד ($${num(a.ttm.parts.prior)}). נכון ל-${new Date(a.ttm.asOf).toLocaleDateString('he-IL')}`]
      : ['רווח למניה אחרון (EPS)', `$${num(s.eps)}`, a.ttm.note || `דוח שנתי ${a.last.fy}. עוד אין דוח רבעוני חדש יותר`],
    ['שיעור צמיחה לפי הספר', pct(s.growth), a.growth?.source],
    [`רווח למניה בעוד ${s.years} שנים`, `$${num(s.futureEps)}`, `EPS × (1 + צמיחה)^${s.years}`],
    ['מכפיל עתידי', num(s.futurePe, 1), `${s.peSource}. פי 2 מהצמיחה = ${num(s.defaultPe, 1)}, היסטורי = ${num(a.hpe.average, 1)}`],
    [`מחיר עתידי בעוד ${s.years} שנים`, fmtUsd(s.futurePrice), 'EPS עתידי × מכפיל'],
    ['מחיר סטיקר (שווי היום)', fmtUsd(s.sticker), `מהוון ב-${pct(s.marr, 0)} לשנה (חלקי ${num(s.discount, 2)})`],
    ['מחיר קנייה עם מרווח ביטחון', fmtUsd(s.mos), `${pct(s.mosFraction, 0)} מהסטיקר`],
  ];
  return `<section class="card"><h2>מחיר הסטיקר, צעד אחר צעד</h2>
    <ul class="steps">${steps.map(([l, v, n]) => `<li><span>${esc(l)}<small>${bidi(n || '')}</small></span><b>${bidi(v)}</b></li>`).join('')}</ul>
    ${params}</section>`;
}

function extrasCard(a) {
  const pb = a.payback;
  const pbText = pb == null ? '—' : pb === Infinity ? 'מעל 30' : `${pb} שנים`;
  const pbOk = pb != null && pb <= DEFAULTS.paybackMaxYears;
  const debtOk = a.debtYears != null && a.debtYears <= DEFAULTS.debtMaxYearsFcf;
  const line = (label, value, ok, note) => `<li><span>${esc(label)}<small>${esc(note)}</small></span>
    <b><span class="cell ${ok == null ? 'na' : ok ? 'ok' : 'no'}">${bidi(value)}</span></b></li>`;
  return `<section class="card"><h2>בדיקות נוספות</h2><ul class="steps">
    ${line('זמן החזר (Payback Time)', pbText, pb == null ? null : pbOk, `כמה שנים של תזרים חופשי (שגדל בקצב הצמיחה) צריך כדי להחזיר את המחיר. לפי טאון: עד ${DEFAULTS.paybackMaxYears} שנים.`)}
    ${line('חוב לטווח ארוך בשנות FCF', a.debtYears == null ? '—' : `${num(a.debtYears, 1)} שנים`, a.debtYears == null ? null : debtOk, `האם אפשר לסגור את החוב תוך ${DEFAULTS.debtMaxYearsFcf} שנים מהתזרים החופשי.`)}
    ${line('תזרים חופשי למניה', a.fcfPs == null ? '—' : `$${num(a.fcfPs)}`, null, 'תזרים מפעילות פחות השקעות ברכוש קבוע, חלקי מספר המניות.')}
    ${line('מכפיל רווח היסטורי (חציון)', num(a.hpe.average, 1), null, `חציון של ${a.hpe.points.length} השנים האחרונות, כדי ששנה חריגה לא תעוות. המחיר בסוף כל שנת כספים חלקי הרווח למניה באותה שנה.`)}
  </ul></section>`;
}

function toolsCard(a) {
  const t = a.tech;
  if (!t) return `<section class="card"><h2>שלושת הכלים לתזמון</h2><p class="muted">אין מספיק נתוני מחיר יומיים.</p></section>`;
  const sig = { buy: ['ok', 'כל שלושת הכלים ירוקים: זמן כניסה טכני'], sell: ['no', 'כל שלושת הכלים אדומים: לא נכנסים (ומי שבפנים שוקל יציאה)'], wait: ['mix', `${t.ups} מתוך 3 ירוקים: מחכים שכולם יתיישרו`] }[t.signal];
  return `<section class="card"><h2>שלושת הכלים לתזמון</h2>
    <div class="sig cell ${sig[0]}">${esc(sig[1])}</div>
    <div class="tools">${t.tools.map((x) => `<div class="tool ${x.up ? 'ok' : 'no'}"><div class="t">${esc(x.label)}</div>
      <div>${x.up ? 'ירוק (מעלה)' : 'אדום (מטה)'} כבר ${x.days} ימים</div><div class="s">${bidi(x.detail)}</div></div>`).join('')}</div>
    <p class="note">טאון משתמש בכלים רק כדי לתזמן כניסה ויציאה ממניה שכבר עברה את כל שאר הכללים, ולא כסיבה לקנות. נכון לסגירה של ${new Date(t.asOf * 1000).toLocaleDateString('he-IL')}.</p>
  </section>`;
}

function dataCard(a) {
  const cols = [['fy', 'שנה', (v) => v], ['revenue', 'מכירות', big], ['netIncome', 'רווח נקי', big], ['eps', 'EPS', (v) => num(v)],
    ['equity', 'הון עצמי', big], ['bvps', 'BVPS', (v) => num(v)], ['opCash', 'תזרים תפעולי', big], ['fcf', 'FCF', big],
    ['ltDebt', 'חוב ארוך', big], ['roic', 'ROIC', (v) => pct(v)], ['shares', 'מניות', big]];
  return `<section class="card"><details><summary>הנתונים הגולמיים מהדוחות</summary>
    <div class="scroll"><table class="data"><tr>${cols.map((c) => `<th>${c[1]}</th>`).join('')}</tr>
    ${a.rows.slice().reverse().map((r) => `<tr>${cols.map(([k, , f]) => `<td class="num">${esc(f(r[k]))}</td>`).join('')}</tr>`).join('')}</table></div>
    <p class="note">מקור: דוחות 10-K בממשק XBRL של ה-SEC. הרווח למניה ומספר המניות מתוקנים לספליטים. שנה = שנת סיום שנת הכספים.</p>
  </details></section>`;
}

function bindParams() {
  for (const k of ['analyst', 'growth', 'pe', 'marr']) {
    const el = document.getElementById(`p-${k}`);
    el.addEventListener('change', () => {
      const v = el.value.trim();
      if (v !== '' && !Number.isFinite(Number(v))) { el.value = state.params[k]; return; }
      state.params[k] = v;
      render();
    });
  }
}

loadUniverse();
const fromHash = decodeURIComponent(location.hash.slice(1)).toUpperCase().replace(/-/g, '.');
if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(fromHash)) { $('#ticker').value = fromHash; load(fromHash); }
