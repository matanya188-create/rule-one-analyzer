// Rule #1 (Phil Town) — pure calculation engine. No DOM, no network.
// Works in the browser (ES module) and in Node (tests).

export const DEFAULTS = {
  marr: 0.15,          // minimum acceptable rate of return
  years: 10,           // projection horizon
  mosFraction: 0.5,    // buy at 50% of sticker price
  bigFiveMin: 0.10,    // every Big Five number should be >= 10%
  paybackMaxYears: 8,  // Payback Time rule
  debtMaxYearsFcf: 3,  // long-term debt payable from ~3 years of FCF
  fallbackTaxRate: 0.21,
};

// XBRL concepts, in priority order per metric.
export const CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueGoodsNet'],
  netIncome: ['NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic', 'ProfitLoss'],
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  opCash: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  opIncome: ['OperatingIncomeLoss'],
  pretax: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
  tax: ['IncomeTaxExpenseBenefit'],
  ltDebt: ['LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations'],
  shares: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted',
    'WeightedAverageNumberOfSharesOutstandingBasic'],
};

const FLOW = new Set(['revenue', 'netIncome', 'eps', 'opCash', 'capex', 'opIncome', 'pretax', 'tax', 'shares']);
const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '10-KT']);
const DAY = 86400000;

// Split factor for a value filed on `filedIso`: product of all splits dated after the filing.
// splits: [{date: epochSeconds, ratio: numerator/denominator}]
export function splitFactorAfter(filedIso, splits) {
  const filed = Date.parse(filedIso);
  let f = 1;
  for (const s of splits || []) if (s.date * 1000 > filed) f *= s.ratio;
  return f;
}

// One concept -> Map(fiscalYear -> {value, end, filed}), latest filing wins per period end.
function conceptAnnual(facts, concept, metric, splits) {
  const node = facts?.[concept];
  if (!node) return new Map();
  const unitKey = Object.keys(node.units || {})[0];
  if (!unitKey) return new Map();
  const byEnd = new Map();
  for (const x of node.units[unitKey]) {
    if (!ANNUAL_FORMS.has(x.form) || x.fp !== 'FY') continue;
    if (FLOW.has(metric)) {
      if (!x.start) continue;
      const days = (Date.parse(x.end) - Date.parse(x.start)) / DAY;
      if (days < 340 || days > 380) continue;
    } else if (x.start) continue;
    const prev = byEnd.get(x.end);
    if (!prev || x.filed > prev.filed) byEnd.set(x.end, x);
  }
  const byYear = new Map();
  for (const x of byEnd.values()) {
    let v = x.val;
    const f = splitFactorAfter(x.filed, splits);
    if (metric === 'eps') v = v / f;
    if (metric === 'shares') v = v * f;
    const fy = Number(x.end.slice(0, 4));
    const prev = byYear.get(fy);
    if (!prev || x.end > prev.end) byYear.set(fy, { value: v, end: x.end, filed: x.filed, concept });
  }
  return byYear;
}

// Metric -> Map(fy -> entry), merging concepts by priority per year.
export function annualSeries(facts, metric, splits) {
  const out = new Map();
  for (const c of CONCEPTS[metric]) {
    for (const [fy, e] of conceptAnnual(facts, c, metric, splits)) if (!out.has(fy)) out.set(fy, e);
  }
  return out;
}

const val = (m, fy) => (m.has(fy) ? m.get(fy).value : null);

// Build the yearly table used by every rule.
export function buildYears(facts, splits) {
  const s = {};
  for (const k of Object.keys(CONCEPTS)) s[k] = annualSeries(facts, k, splits);
  const all = new Set([...s.revenue.keys(), ...s.netIncome.keys(), ...s.equity.keys()]);
  const years = [...all].sort((a, b) => a - b);
  return years.map((fy) => {
    const r = {
      fy, end: s.equity.get(fy)?.end || s.revenue.get(fy)?.end || s.netIncome.get(fy)?.end || null,
      revenue: val(s.revenue, fy), netIncome: val(s.netIncome, fy), eps: val(s.eps, fy),
      equity: val(s.equity, fy), opCash: val(s.opCash, fy), capex: val(s.capex, fy),
      opIncome: val(s.opIncome, fy), pretax: val(s.pretax, fy), tax: val(s.tax, fy),
      ltDebt: val(s.ltDebt, fy), shares: val(s.shares, fy),
    };
    if (r.eps == null && r.netIncome != null && r.shares) r.eps = r.netIncome / r.shares;
    r.fcf = r.opCash != null ? r.opCash - (r.capex || 0) : null;
    r.bvps = r.equity != null && r.shares ? r.equity / r.shares : null;
    let t = r.pretax && r.tax != null && r.pretax > 0 ? r.tax / r.pretax : DEFAULTS.fallbackTaxRate;
    t = Math.min(Math.max(t, 0), 0.5);
    const nopat = r.opIncome != null ? r.opIncome * (1 - t) : r.netIncome;
    const ic = r.equity != null ? r.equity + (r.ltDebt || 0) : null;
    r.roic = nopat != null && ic != null && ic > 0 ? nopat / ic : null;
    return r;
  });
}

// Compound annual growth from `start` to `end` over n years.
export function cagr(start, end, n) {
  if (start == null || end == null || n <= 0) return { value: null, reason: 'חסר נתון' };
  if (start <= 0 || end <= 0) return { value: null, negative: true, reason: 'ערך שלילי או אפס — אין צמיחה' };
  return { value: Math.pow(end / start, 1 / n) - 1 };
}

export const WINDOWS = [10, 5, 3, 1];

function growthWindows(rows, key) {
  const last = rows[rows.length - 1];
  const byFy = new Map(rows.map((r) => [r.fy, r]));
  return WINDOWS.map((n) => {
    const base = byFy.get(last.fy - n);
    if (!base) return { n, value: null, reason: 'אין מספיק היסטוריה' };
    return { n, ...cagr(base[key], last[key], n) };
  });
}

function averageWindows(rows, key) {
  return WINDOWS.map((n) => {
    const slice = rows.slice(-n).map((r) => r[key]).filter((v) => v != null);
    if (rows.length < n || slice.length < Math.ceil(n * 0.8)) return { n, value: null, reason: 'אין מספיק היסטוריה' };
    return { n, value: slice.reduce((a, b) => a + b, 0) / slice.length };
  });
}

export const BIG_FIVE = [
  { key: 'roic', label: 'תשואה על ההון המושקע (ROIC)', mode: 'average' },
  { key: 'revenue', label: 'צמיחה במכירות', mode: 'growth' },
  { key: 'eps', label: 'צמיחה ברווח למניה (EPS)', mode: 'growth' },
  { key: 'bvps', label: 'צמיחה בהון העצמי למניה (BVPS)', mode: 'growth' },
  { key: 'fcf', label: 'צמיחה בתזרים המזומנים החופשי (FCF)', mode: 'growth' },
];

export function bigFive(rows, min = DEFAULTS.bigFiveMin) {
  return BIG_FIVE.map((m) => {
    const windows = (m.mode === 'average' ? averageWindows(rows, m.key) : growthWindows(rows, m.key))
      .map((w) => ({ ...w, pass: w.value != null && w.value >= min }));
    const known = windows.filter((w) => w.value != null || w.negative);
    const passed = known.filter((w) => w.pass).length;
    const status = known.length === 0 ? 'unknown' : passed === known.length ? 'pass' : passed === 0 ? 'fail' : 'mixed';
    return { ...m, windows, passed, known: known.length, status };
  });
}

// Historical P/E: price at each fiscal-year end / that year's EPS, last up to 10 years.
// monthly: [{t: epochSeconds, close}] (split-adjusted closes)
export function historicalPE(rows, monthly) {
  const pes = [];
  for (const r of rows.slice(-10)) {
    if (!r.end || !(r.eps > 0)) continue;
    const endMs = Date.parse(r.end);
    let best = null;
    for (const m of monthly || []) {
      const d = Math.abs(m.t * 1000 - endMs);
      if (m.close != null && d < 40 * DAY && (!best || d < best.d)) best = { d, close: m.close };
    }
    if (best) pes.push({ fy: r.fy, price: best.close, eps: r.eps, pe: best.close / r.eps });
  }
  // Median, not mean: one-off charges (e.g. 2017 tax reform) create absurd single-year P/Es.
  const sorted = pes.map((x) => x.pe).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = !sorted.length ? null : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { average: median, points: pes };
}

// Rule #1 growth rate: lower of historical equity (BVPS) growth and analyst estimate (if given).
export function ruleGrowth(big5, analystGrowth) {
  const eq = big5.find((m) => m.key === 'bvps').windows;
  const hist = eq.find((w) => w.value != null) || null; // longest available window first (10,5,3,1)
  const candidates = [];
  if (hist) candidates.push({ source: `צמיחת ההון העצמי ההיסטורית (${hist.n} שנים)`, value: hist.value });
  if (analystGrowth != null && Number.isFinite(analystGrowth)) candidates.push({ source: 'הערכת אנליסטים', value: analystGrowth });
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.value < a.value ? b : a));
}

export function stickerPrice({ eps, growth, historicalPe, peOverride, marr = DEFAULTS.marr, years = DEFAULTS.years, mosFraction = DEFAULTS.mosFraction }) {
  if (!(eps > 0)) return { ok: false, reason: 'הרווח למניה האחרון שלילי או חסר — אי אפשר לחשב מחיר לפי הספר' };
  if (growth == null || !(growth > 0)) return { ok: false, reason: 'אין צמיחה חיובית בהון העצמי — אי אפשר לחשב מחיר לפי הספר' };
  const defaultPe = growth * 100 * 2;
  let futurePe, peSource;
  if (peOverride > 0) { futurePe = peOverride; peSource = 'הוזן ידנית'; }
  else if (historicalPe > 0 && historicalPe < defaultPe) { futurePe = historicalPe; peSource = 'מכפיל היסטורי (חציון), נמוך מפי 2 מהצמיחה'; }
  else { futurePe = defaultPe; peSource = 'פי 2 משיעור הצמיחה'; }
  const futureEps = eps * Math.pow(1 + growth, years);
  const futurePrice = futureEps * futurePe;
  const discount = Math.pow(1 + marr, years);
  const sticker = futurePrice / discount;
  return { ok: true, eps, growth, futurePe, peSource, defaultPe, futureEps, futurePrice, discount, sticker, mos: sticker * mosFraction, marr, years, mosFraction };
}

// Payback Time: years until cumulative FCF per share (growing at g) repays the price.
export function paybackYears(price, fcfPerShare, growth, maxYears = 30) {
  if (!(price > 0) || !(fcfPerShare > 0)) return null;
  const g = growth > 0 ? growth : 0;
  let sum = 0, cf = fcfPerShare;
  for (let y = 1; y <= maxYears; y++) {
    cf *= 1 + g;
    sum += cf;
    if (sum >= price) return y;
  }
  return Infinity;
}

// ---------- Technicals: Town's three tools ----------
export function ema(values, n) {
  const k = 2 / (n + 1), out = [];
  let prev = null;
  values.forEach((v, i) => {
    if (i < n - 1) { out.push(null); return; }
    if (prev == null) prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
    else prev = v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

export function sma(values, n) {
  return values.map((_, i) => (i < n - 1 ? null : values.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n));
}

export function macd(closes, fast = 8, slow = 17, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = line.findIndex((v) => v != null);
  const sig = new Array(closes.length).fill(null);
  if (start >= 0) ema(line.slice(start), signal).forEach((v, i) => (sig[start + i] = v));
  return { line, signal: sig, hist: line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null)) };
}

export function stochastic(highs, lows, closes, kN = 14, dN = 5) {
  const k = closes.map((c, i) => {
    if (i < kN - 1) return null;
    const hh = Math.max(...highs.slice(i - kN + 1, i + 1)), ll = Math.min(...lows.slice(i - kN + 1, i + 1));
    return hh === ll ? 50 : ((c - ll) / (hh - ll)) * 100;
  });
  const start = k.findIndex((v) => v != null);
  const d = new Array(closes.length).fill(null);
  if (start >= 0) sma(k.slice(start), dN).forEach((v, i) => (d[start + i] = v));
  return { k, d };
}

// Days since the boolean condition last flipped to its current state.
function sinceFlip(flags) {
  const last = flags[flags.length - 1];
  let n = 0;
  for (let i = flags.length - 1; i >= 0 && flags[i] === last; i--) n++;
  return n;
}

export function townTools(daily) {
  const bars = (daily || []).filter((b) => b.c != null && b.h != null && b.l != null);
  if (bars.length < 40) return null;
  const c = bars.map((b) => b.c), h = bars.map((b) => b.h), l = bars.map((b) => b.l);
  const m = macd(c), st = stochastic(h, l, c), ma = sma(c, 10);
  const i = bars.length - 1;
  const macdUp = m.hist.map((v) => v != null && v > 0);
  const stochUp = st.k.map((v, j) => v != null && st.d[j] != null && v > st.d[j]);
  const maUp = c.map((v, j) => ma[j] != null && v > ma[j]);
  const tools = [
    { key: 'macd', label: 'MACD (8,17,9)', up: macdUp[i], detail: `היסטוגרמה ${m.hist[i].toFixed(3)}`, days: sinceFlip(macdUp) },
    { key: 'stoch', label: 'סטוכסטיק (14,5)', up: stochUp[i], detail: `%K ${st.k[i].toFixed(1)} מול %D ${st.d[i].toFixed(1)}`, days: sinceFlip(stochUp) },
    { key: 'ma', label: 'ממוצע נע 10 ימים', up: maUp[i], detail: `מחיר ${c[i].toFixed(2)} מול ממוצע ${ma[i].toFixed(2)}`, days: sinceFlip(maUp) },
  ];
  const ups = tools.filter((t) => t.up).length;
  const signal = ups === 3 ? 'buy' : ups === 0 ? 'sell' : 'wait';
  return { tools, ups, signal, asOf: bars[i].t };
}

// ---------- Full analysis + verdict ----------
export function analyze({ facts, splits, monthly, daily, price, analystGrowth = null, growthOverride = null, peOverride = null, marr = DEFAULTS.marr }) {
  const rows = buildYears(facts, splits).filter((r) => r.fy >= new Date().getFullYear() - 12);
  if (rows.length < 2) return { ok: false, reason: 'אין מספיק דוחות שנתיים (10-K) לחברה הזו ב-SEC' };
  const last = rows[rows.length - 1];
  const big5 = bigFive(rows);
  const hpe = historicalPE(rows, monthly);
  const growth = growthOverride != null && Number.isFinite(growthOverride)
    ? { source: 'הוזן ידנית', value: growthOverride }
    : ruleGrowth(big5, analystGrowth);
  const sticker = stickerPrice({ eps: last.eps, growth: growth?.value, historicalPe: hpe.average, peOverride, marr });
  const fcfPs = last.fcf != null && last.shares ? last.fcf / last.shares : null;
  const payback = paybackYears(price, fcfPs, growth?.value);
  const debtYears = last.ltDebt != null && last.fcf > 0 ? last.ltDebt / last.fcf : null;
  const tech = townTools(daily);

  const b5pass = big5.filter((m) => m.status === 'pass').length;
  const b5fail = big5.filter((m) => m.status === 'fail').length;
  const wonderful = b5pass >= 4 && b5fail === 0;

  let verdict;
  if (!wonderful) verdict = { code: 'not-wonderful', title: 'לא עומדת בכללי הספר', text: `רק ${b5pass} מתוך 5 המספרים הגדולים עוברים את רף ה-10% בעקביות. לפי טאון — אם העסק לא נהדר, המחיר לא משנה.` };
  else if (!sticker.ok) verdict = { code: 'no-price', title: 'עסק טוב — אבל אי אפשר לתמחר', text: sticker.reason };
  else if (price <= sticker.mos) verdict = { code: 'buy', title: 'זולה — שווה קנייה לפי הספר', text: `המחיר ${fmtUsd(price)} נמוך ממחיר מרווח-הביטחון ${fmtUsd(sticker.mos)}.` + (sticker.growth > 0.2 ? ' שים לב: התוצאה נשענת על צמיחה גבוהה מאוד (ראה אזהרות).' : '') };
  else if (price <= sticker.sticker) verdict = { code: 'fair', title: 'מחיר הוגן — אין מרווח ביטחון', text: `המחיר מתחת לשווי (${fmtUsd(sticker.sticker)}) אבל מעל מחיר הקנייה (${fmtUsd(sticker.mos)}). לפי הספר — מחכים.` };
  else verdict = { code: 'expensive', title: 'יקרה — לא שווה קנייה', text: `המחיר ${fmtUsd(price)} גבוה מהשווי לפי הספר (${fmtUsd(sticker.sticker)}).` };

  const warnings = [];
  if (sticker.ok && sticker.growth > 0.2) warnings.push(`שיעור הצמיחה ${(sticker.growth * 100).toFixed(1)}% בשנה הוא גבוה מאוד. מעט מאוד חברות מחזיקות קצב כזה 10 שנים, והמחיר רגיש מאוד להנחה הזו. כדאי להזין הערכת אנליסטים או צמיחה ידנית שמרנית.`);
  if (sticker.ok && sticker.futurePe > 50) warnings.push(`המכפיל העתידי ${sticker.futurePe.toFixed(1)} גבוה מאוד, ולכן המחיר העתידי אופטימי.`);
  if (hpe.points.length < 5) warnings.push('יש פחות מ-5 שנים לחישוב המכפיל ההיסטורי.');
  if (rows.length < 11) warnings.push(`יש רק ${rows.length} דוחות שנתיים, כך שבדיקת 10 השנים לא שלמה.`);
  return { ok: true, rows, last, big5, b5pass, hpe, growth, sticker, fcfPs, payback, debtYears, tech, verdict, price, warnings };
}

export function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
