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
  growthCap: 0.15,     // Rule One calculator: "never over 15%"
  peCap: 50,           // Town: "Don't exceed 50 in any case"
  tenCapMultiple: 10,  // Ten Cap: pay at most 10x owner/free cash flow
};

// XBRL concepts, in priority order per metric.
export const CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueGoodsNet',
    'RevenuesNetOfInterestExpense', 'RegulatedAndUnregulatedOperatingRevenue', 'RevenuesExcludingInterestAndDividends'],
  netIncome: ['NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic', 'ProfitLoss'],
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  opCash: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets',
    'PaymentsToAcquireOilAndGasPropertyAndEquipment', 'PaymentsToAcquireOtherPropertyPlantAndEquipment',
    'PaymentsForCapitalImprovements', 'PaymentsForProceedsFromProductiveAssets', 'PaymentsToAcquireOtherProductiveAssets'],
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
  for (const s of splits || []) if (s.date * 1000 > filed && isShareSplit(s.ratio)) f *= s.ratio;
  return f;
}

// Yahoo lists spin-offs as "splits" with odd ratios (1.272, 1.048...). Those adjust the price
// history but do not change the share count, so reported EPS must not be divided by them.
// A real split or stock dividend is a small-integer fraction (2, 3/2, 5/4, 11/10, 1/8...).
export function isShareSplit(ratio) {
  if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-6) return false;
  const r = ratio >= 1 ? ratio : 1 / ratio;
  for (let m = 1; m <= 10; m++) if (Math.abs(r * m - Math.round(r * m)) < 0.002 * m) return true;
  return false;
}

// Product of the spin-off ratios after a date: multiplying an adjusted historical close by it
// gives back the price that actually traded against that year's reported EPS.
export function spinFactorAfter(ms, splits) {
  let f = 1;
  for (const s of splits || []) if (s.date * 1000 > ms && !isShareSplit(s.ratio) && s.ratio > 0) f *= s.ratio;
  return f;
}

// Some filers tag a few stray rows in an odd unit (e.g. Coca-Cola EPS in "pure"),
// so pick the unit the metric should have, else the one with the most rows.
const UNIT_FOR = { eps: 'USD/shares', shares: 'shares' };
export function pickUnit(node, metric) {
  const units = node?.units || {};
  const want = UNIT_FOR[metric] || 'USD';
  if (units[want]) return want;
  return Object.keys(units).sort((a, b) => units[b].length - units[a].length)[0];
}

// One concept -> Map(fiscalYear -> {value, end, filed}), latest filing wins per period end.
function conceptAnnual(facts, concept, metric, splits) {
  const node = facts?.[concept];
  if (!node) return new Map();
  const unitKey = pickUnit(node, metric);
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
    if (!prev || x.end > prev.end) byYear.set(fy, { value: v, start: x.start, end: x.end, filed: x.filed, concept });
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

// ---------- Trailing twelve months (TTM) ----------
// TTM = last annual + current fiscal-year-to-date (10-Q) - same period one year earlier.
const QUARTERLY_FORMS = new Set(['10-Q', '10-Q/A']);
const near = (a, b, days = 10) => Math.abs(a - b) <= days * DAY;

function durationRows(facts, concept, metric, splits) {
  const node = facts?.[concept];
  const unitKey = node && pickUnit(node, metric);
  if (!unitKey) return [];
  const byPeriod = new Map();
  for (const x of node.units[unitKey]) {
    if (!x.start || !(QUARTERLY_FORMS.has(x.form) || ANNUAL_FORMS.has(x.form))) continue;
    const key = `${x.start}|${x.end}`;
    const prev = byPeriod.get(key);
    if (!prev || x.filed > prev.filed) byPeriod.set(key, x);
  }
  return [...byPeriod.values()].map((x) => {
    const f = splitFactorAfter(x.filed, splits);
    const value = metric === 'eps' ? x.val / f : metric === 'shares' ? x.val * f : x.val;
    return { start: x.start, end: x.end, value, s: Date.parse(x.start), e: Date.parse(x.end) };
  });
}

// annual: the {value, start, end, concept} entry of the latest fiscal year.
export function ttmValue(facts, metric, splits, annual) {
  const base = { value: annual?.value ?? null, quarters: 0, asOf: annual?.end ?? null };
  if (!annual?.start || !annual.concept) return base;
  const rows = durationRows(facts, annual.concept, metric, splits);
  const fyEnd = Date.parse(annual.end), fyStart = Date.parse(annual.start);
  const ytd = rows.filter((r) => near(r.s, fyEnd + DAY) && r.e > fyEnd).sort((a, b) => b.e - a.e)[0];
  if (!ytd) return base;
  const len = ytd.e - ytd.s;
  const prior = rows.find((r) => near(r.s, fyStart) && near(r.e - r.s, len));
  if (!prior) return { ...base, note: 'חסר רבעון מקביל אשתקד — נלקח הדוח השנתי' };
  return {
    value: annual.value + ytd.value - prior.value,
    quarters: Math.round(len / (91.3 * DAY)),
    asOf: ytd.end,
    parts: { annual: annual.value, ytd: ytd.value, prior: prior.value },
  };
}

// Build the yearly table used by every rule.
export function buildYears(facts, splits) {
  const s = {};
  for (const k of Object.keys(CONCEPTS)) s[k] = annualSeries(facts, k, splits);
  const all = new Set([...s.revenue.keys(), ...s.netIncome.keys(), ...s.equity.keys()]);
  const years = [...all].sort((a, b) => a - b);
  const out = years.map((fy) => {
    const r = {
      fy, end: s.equity.get(fy)?.end || s.revenue.get(fy)?.end || s.netIncome.get(fy)?.end || null,
      revenue: val(s.revenue, fy), netIncome: val(s.netIncome, fy), eps: val(s.eps, fy),
      equity: val(s.equity, fy), opCash: val(s.opCash, fy), capex: val(s.capex, fy),
      opIncome: val(s.opIncome, fy), pretax: val(s.pretax, fy), tax: val(s.tax, fy),
      ltDebt: val(s.ltDebt, fy), shares: val(s.shares, fy),
    };
    // Some filers tag the share count in thousands or millions; EPS and net income give the true scale.
    if (r.shares && r.netIncome && r.eps && Math.abs(r.eps) >= 0.02) {
      const q = r.netIncome / r.eps / r.shares;
      for (const f of [1e3, 1e6, 1e-3, 1e-6]) if (q > f * 0.5 && q < f * 2) { r.shares *= f; r.sharesRescaled = true; }
    }
    if (r.eps == null && r.netIncome != null && r.shares) r.eps = r.netIncome / r.shares;
    r.fcf = r.opCash != null ? r.opCash - (r.capex || 0) : null;
    r.capexMissing = r.opCash != null && r.capex == null;
    r.bvps = r.equity != null && r.shares ? r.equity / r.shares : null;
    let t = r.pretax && r.tax != null && r.pretax > 0 ? r.tax / r.pretax : DEFAULTS.fallbackTaxRate;
    t = Math.min(Math.max(t, 0), 0.5);
    const nopat = r.opIncome != null ? r.opIncome * (1 - t) : r.netIncome;
    const ic = r.equity != null ? r.equity + (r.ltDebt || 0) : null;
    r.roic = nopat != null && ic != null && ic > 0 ? nopat / ic : null;
    return r;
  });
  // Years without EPS cannot be scale-checked above: compare them with the company's median count.
  const counts = out.map((r) => r.shares).filter((v) => v > 0).sort((x, y) => x - y);
  const med = counts[counts.length >> 1];
  for (const r of out) {
    if (!r.shares || !med) continue;
    const q = med / r.shares;
    for (const f of [1e3, 1e6, 1e-3, 1e-6]) {
      if (q > f * 0.3 && q < f * 3) {
        r.shares *= f; r.sharesRescaled = true;
        r.bvps = r.equity != null ? r.equity / r.shares : null;
      }
    }
  }
  return out;
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
    // The book's test is the long-term rate (10 years when available); the shorter windows
    // show whether it is holding up, so they set the trend, not the verdict.
    const main = known[0] || null;
    const status = !main ? 'unknown' : main.pass ? 'pass' : 'fail';
    const recent = known.slice(1);
    const trend = !main || !recent.length ? null
      : recent.every((w) => w.pass) ? 'steady'
        : recent[recent.length - 1].pass ? 'recovering' : 'weakening';
    return { ...m, windows, passed, known: known.length, status, main, trend, consistent: known.length > 0 && passed === known.length };
  });
}

// Historical P/E: price at each fiscal-year end / that year's EPS, last up to 10 years.
// monthly: [{t: epochSeconds, close}] (split-adjusted closes)
export function historicalPE(rows, monthly, splits) {
  const pes = [];
  for (const r of rows.slice(-10)) {
    if (!r.end || !(r.eps > 0)) continue;
    const endMs = Date.parse(r.end);
    let best = null;
    for (const m of monthly || []) {
      const d = Math.abs(m.t * 1000 - endMs);
      if (m.close != null && d < 40 * DAY && (!best || d < best.d)) best = { d, close: m.close };
    }
    if (best) { const price = best.close * spinFactorAfter(endMs, splits); pes.push({ fy: r.fy, price, eps: r.eps, pe: price / r.eps }); }
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
  const low = candidates.reduce((a, b) => (b.value < a.value ? b : a));
  if (low.value > DEFAULTS.growthCap) return { source: `${low.source}: ${(low.value * 100).toFixed(1)}%, נחתך לתקרה של טאון`, value: DEFAULTS.growthCap, raw: low.value, capped: true };
  return { ...low, raw: low.value, capped: false };
}

export function stickerPrice({ eps, growth, historicalPe, peOverride, marr = DEFAULTS.marr, years = DEFAULTS.years, mosFraction = DEFAULTS.mosFraction }) {
  if (!(eps > 0)) return { ok: false, reason: 'הרווח למניה האחרון שלילי או חסר — אי אפשר לחשב מחיר לפי הספר' };
  if (growth == null || !(growth > 0)) return { ok: false, reason: 'שיעור הצמיחה לפי הספר אינו חיובי (ההון העצמי לא גדל, או שהאנליסטים צופים ירידה ברווח), ולכן אי אפשר לחשב מחיר' };
  const defaultPe = growth * 100 * 2;
  let futurePe, peSource;
  if (peOverride > 0) { futurePe = peOverride; peSource = 'הוזן ידנית'; }
  else {
    if (historicalPe > 0 && historicalPe < defaultPe) { futurePe = historicalPe; peSource = 'מכפיל היסטורי (חציון), נמוך מפי 2 מהצמיחה'; }
    else { futurePe = defaultPe; peSource = 'פי 2 משיעור הצמיחה'; }
    if (futurePe > DEFAULTS.peCap) { futurePe = DEFAULTS.peCap; peSource += `, נחתך לתקרה ${DEFAULTS.peCap}`; }
  }
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

// Payback Time price: what 8 years of free cash flow per share, growing at g, add up to.
// Paying this price means the business "pays you back" in exactly 8 years.
export function paybackPrice(fcfPerShare, growth, years = DEFAULTS.paybackMaxYears) {
  if (!(fcfPerShare > 0)) return null;
  const g = growth > 0 ? growth : 0;
  let sum = 0, cf = fcfPerShare;
  for (let y = 1; y <= years; y++) { cf *= 1 + g; sum += cf; }
  return sum;
}

// The growth rate the current price already assumes: the g at which the sticker price equals
// the price, using the same PE rule (2 x growth, capped by history and by 50).
export function impliedGrowth({ price, eps, historicalPe, marr = DEFAULTS.marr }) {
  if (!(price > 0) || !(eps > 0)) return null;
  const at = (g) => {
    const pe = Math.min(g * 200, historicalPe > 0 ? historicalPe : Infinity, DEFAULTS.peCap);
    return eps * Math.pow(1 + g, DEFAULTS.years) * pe / Math.pow(1 + marr, DEFAULTS.years);
  };
  let lo = 0.001, hi = 1;
  if (at(hi) < price) return null;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (at(mid) < price) lo = mid; else hi = mid; }
  return hi;
}

// ---------- Full analysis + verdict ----------
// asOf (optional ISO date): point-in-time mode for the backtest — the caller has already
// stripped facts/prices filed after that date; this only anchors the 12-year window.
export function analyze({ facts, splits, monthly, daily, price, analystGrowth = null, growthOverride = null, peOverride = null, marr = DEFAULTS.marr, asOf = null }) {
  const nowYear = (asOf ? new Date(asOf) : new Date()).getFullYear();
  const rows = buildYears(facts, splits).filter((r) => r.fy >= nowYear - 12);
  if (rows.length < 2) return { ok: false, reason: 'אין מספיק דוחות שנתיים (10-K) לחברה הזו ב-SEC' };
  const last = rows[rows.length - 1];
  const big5 = bigFive(rows);
  const hpe = historicalPE(rows, monthly, splits);
  const growth = growthOverride != null && Number.isFinite(growthOverride)
    ? { source: 'הוזן ידנית', value: growthOverride }
    : ruleGrowth(big5, analystGrowth);
  // Town values the business on trailing-twelve-month EPS, not just the last annual report.
  const epsAnnual = annualSeries(facts, 'eps', splits).get(last.fy);
  const ttm = epsAnnual ? ttmValue(facts, 'eps', splits, epsAnnual) : { value: last.eps, quarters: 0, asOf: last.end };
  const sticker = stickerPrice({ eps: ttm.value, growth: growth?.value, historicalPe: hpe.average, peOverride, marr });
  const fcfPs = last.fcf != null && last.shares ? last.fcf / last.shares : null;
  const payback = paybackYears(price, fcfPs, growth?.value);
  // The three valuations of "Invested": Margin of Safety (sticker / 2), Ten Cap, Payback Time.
  const tenCap = fcfPs > 0 ? fcfPs * DEFAULTS.tenCapMultiple : null;
  const pbPrice = paybackPrice(fcfPs, growth?.value);
  const implied = impliedGrowth({ price, eps: ttm.value, historicalPe: hpe.average, marr });
  const pes = hpe.points.map((x) => x.pe).sort((x, y) => x - y);
  const pe = { current: ttm.value > 0 ? price / ttm.value : null, median: hpe.average, low: pes[0] ?? null, high: pes[pes.length - 1] ?? null };
  const scenarios = ttm.value > 0 ? [0.05, 0.10, 0.15].map((g) => ({ ...stickerPrice({ eps: ttm.value, growth: g, historicalPe: hpe.average, marr }), growth: g })) : [];
  const debtYears = last.ltDebt != null && last.fcf > 0 ? last.ltDebt / last.fcf : null;
  const tech = townTools(daily);

  const b5pass = big5.filter((m) => m.status === 'pass').length;
  const b5fail = big5.filter((m) => m.status === 'fail').length;
  const wonderful = b5pass >= 4;
  const b5consistent = big5.filter((m) => m.consistent).length;

  const b5unknown = big5.filter((m) => m.status === 'unknown').length;

  let verdict;
  if (b5unknown >= 2) verdict = { code: 'no-price', title: 'אין מספיק נתונים לפסיקה', text: `${b5unknown} מתוך 5 המספרים הגדולים חסרים, כי החברה לא מדווחת אותם בפורמט הסטנדרטי של ה-SEC (למשל רווח למניה). אי אפשר לבדוק אותה לפי הספר בכלי הזה.` };
  else if (!wonderful) verdict = { code: 'not-wonderful', title: 'לא עומדת בכללי הספר', text: `רק ${b5pass} מתוך 5 המספרים הגדולים עוברים את רף ה-10% לשנה בטווח הארוך. לפי טאון, אם העסק לא נהדר, המחיר לא משנה.` };
  else if (!sticker.ok) verdict = { code: 'no-price', title: 'עסק טוב — אבל אי אפשר לתמחר', text: sticker.reason };
  else if (price <= sticker.mos) verdict = { code: 'buy', title: 'זולה — שווה קנייה לפי הספר', text: `המחיר ${fmtUsd(price)} נמוך ממחיר מרווח-הביטחון ${fmtUsd(sticker.mos)}.` };
  else if (price <= sticker.sticker) verdict = { code: 'fair', title: 'מחיר הוגן — אין מרווח ביטחון', text: `המחיר מתחת לשווי (${fmtUsd(sticker.sticker)}) אבל מעל מחיר הקנייה (${fmtUsd(sticker.mos)}). לפי הספר — מחכים.` };
  else verdict = { code: 'expensive', title: 'יקרה — לא שווה קנייה', text: `המחיר ${fmtUsd(price)} גבוה מהשווי לפי הספר (${fmtUsd(sticker.sticker)}).` };

  const warnings = [];
  if (growth?.capped) warnings.push(`צמיחת ההון ההיסטורית היא ${(growth.raw * 100).toFixed(1)}% בשנה, אבל החישוב משתמש ב-${(DEFAULTS.growthCap * 100).toFixed(0)}%: טאון לא מרשה להניח יותר מזה, כי כמעט אף חברה לא מחזיקה קצב גבוה יותר 10 שנים.`);
  if (sticker.ok && sticker.growth > DEFAULTS.growthCap + 1e-9) warnings.push(`הוזנה צמיחה של ${(sticker.growth * 100).toFixed(1)}%, מעל התקרה של טאון (${(DEFAULTS.growthCap * 100).toFixed(0)}%). המחיר רגיש מאוד להנחה הזו.`);
  if (analystGrowth != null && growthOverride == null && growth && !growth.capped && growth.source === 'הערכת אנליסטים') warnings.push(`הצמיחה בחישוב היא הערכת האנליסטים (${(analystGrowth * 100).toFixed(1)}%), כי היא נמוכה מהצמיחה ההיסטורית. ההערכה היא לשנתיים הקרובות ולא ל-5 שנים כמו בספר, כי אין מקור חופשי לתחזית של 5 שנים.`);
  if (sticker.ok && analystGrowth == null && growthOverride == null) warnings.push('החישוב נשען רק על הצמיחה ההיסטורית. לפי הספר לוקחים את הנמוך בין ההיסטוריה להערכת האנליסטים ל-5 שנים. למניה הזו אין הערכת אנליסטים זמינה; אם יש לך, הזן אותה למטה.');
  if (ttm.quarters > 0 && last.eps > 0 && (ttm.value / last.eps > 2 || ttm.value / last.eps < 0.5)) warnings.push(`הרווח למניה ב-12 החודשים האחרונים (${fmtUsd(ttm.value)}) רחוק מאוד מהדוח השנתי האחרון (${fmtUsd(last.eps)}). כנראה יש אירוע חד-פעמי, והמחיר שמחושב ממנו פחות אמין.`);
  if (last.capexMissing) warnings.push('החברה לא מדווחת השקעות הוניות בתג הסטנדרטי, ולכן התזרים החופשי כאן הוא התזרים התפעולי כולו, והוא מוטה כלפי מעלה.');
  if (rows.some((r) => r.sharesRescaled)) warnings.push('בחלק מהשנים מספר המניות דווח באלפים או במיליונים, ותוקן אוטומטית לפי הרווח הנקי והרווח למניה.');
  if ((splits || []).some((x) => !isShareSplit(x.ratio) && Math.abs(x.ratio - 1) > 0.01)) warnings.push('החברה פיצלה מתוכה חברה-בת (ספין-אוף). הרווח למניה בשנים שלפני הפיצול כולל את העסק שיצא, ולכן הצמיחה ההיסטורית פחות נקייה.');
  if (hpe.points.length < 5) warnings.push('יש פחות מ-5 שנים לחישוב המכפיל ההיסטורי.');
  if (rows.length < 11) warnings.push(`יש רק ${rows.length} דוחות שנתיים, כך שבדיקת 10 השנים לא שלמה.`);
  return { ok: true, rows, last, big5, b5pass, b5consistent, wonderful, hpe, growth, ttm, sticker, fcfPs, payback, tenCap, pbPrice, implied, pe, scenarios, debtYears, tech, verdict, price, warnings };
}

export function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
