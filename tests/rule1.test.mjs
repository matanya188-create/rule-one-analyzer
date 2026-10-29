// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { cagr, stickerPrice, paybackYears, splitFactorAfter, buildYears, bigFive, historicalPE, sma, ema } from '../public/rule1.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('cagr: doubling in 5 years = 14.87%', () => {
  close(cagr(100, 200, 5).value, Math.pow(2, 1 / 5) - 1);
});

test('cagr: negative start or end has no growth and is flagged negative', () => {
  assert.equal(cagr(-5, 10, 3).value, null);
  assert.equal(cagr(-5, 10, 3).negative, true);
  assert.equal(cagr(5, null, 3).negative, undefined);
});

test('sticker price follows the book (EPS 2, growth 10%, PE 20, MARR 15%)', () => {
  const s = stickerPrice({ eps: 2, growth: 0.10, historicalPe: null });
  close(s.futurePe, 20);                     // 2 x growth rate
  close(s.futureEps, 2 * Math.pow(1.1, 10));  // 5.1875
  close(s.futurePrice, s.futureEps * 20);     // 103.75
  close(s.sticker, s.futurePrice / Math.pow(1.15, 10), 1e-9); // ~25.65
  close(s.sticker, 25.645, 0.01);
  close(s.mos, s.sticker / 2);
});

test('sticker uses the lower of 2x growth and historical P/E', () => {
  assert.equal(stickerPrice({ eps: 1, growth: 0.15, historicalPe: 18 }).futurePe, 18);
  assert.equal(stickerPrice({ eps: 1, growth: 0.15, historicalPe: 40 }).futurePe, 30);
});

test('sticker refuses negative EPS or no growth', () => {
  assert.equal(stickerPrice({ eps: -1, growth: 0.1 }).ok, false);
  assert.equal(stickerPrice({ eps: 1, growth: -0.01 }).ok, false);
});

test('payback: price 100, FCF/share 10, growth 0 -> 10 years', () => {
  assert.equal(paybackYears(100, 10, 0), 10);
  assert.equal(paybackYears(100, 10, 0.2), 6); // 12+14.4+17.28+20.74+24.88 = 89.3 after y5, 119.2 after y6
});

test('split factor counts only splits after the filing date', () => {
  const splits = [{ date: Date.parse('2014-06-09') / 1000, ratio: 7 }, { date: Date.parse('2020-08-31') / 1000, ratio: 4 }];
  assert.equal(splitFactorAfter('2013-10-30', splits), 28);
  assert.equal(splitFactorAfter('2018-11-05', splits), 4);
  assert.equal(splitFactorAfter('2021-10-29', splits), 1);
});

function fact(start, end, val, filed, form = '10-K') {
  return { start, end, val, filed, form, fp: 'FY' };
}

test('buildYears: latest filing wins, quarterly rows ignored, EPS split-adjusted', () => {
  const facts = {
    Revenues: { units: { USD: [
      fact('2019-01-01', '2019-12-31', 100, '2020-02-01'),
      fact('2019-01-01', '2019-12-31', 105, '2021-02-01'), // restated later -> wins
      fact('2020-10-01', '2020-12-31', 30, '2021-02-01'),  // quarter -> ignored
      fact('2020-01-01', '2020-12-31', 120, '2021-02-01'),
    ] } },
    EarningsPerShareDiluted: { units: { 'USD/shares': [
      fact('2019-01-01', '2019-12-31', 8, '2020-02-01'),
      fact('2020-01-01', '2020-12-31', 10, '2021-02-01'),
    ] } },
    StockholdersEquity: { units: { USD: [
      { end: '2019-12-31', val: 50, filed: '2020-02-01', form: '10-K', fp: 'FY' },
      { end: '2020-12-31', val: 60, filed: '2021-02-01', form: '10-K', fp: 'FY' },
    ] } },
  };
  const splits = [{ date: Date.parse('2020-06-01') / 1000, ratio: 2 }];
  const rows = buildYears(facts, splits);
  assert.deepEqual(rows.map((r) => r.fy), [2019, 2020]);
  assert.equal(rows[0].revenue, 105);
  assert.equal(rows[1].revenue, 120);
  assert.equal(rows[0].eps, 4);  // filed before the 2:1 split
  assert.equal(rows[1].eps, 10); // filed after
});

test('bigFive: negative EPS counts as a fail, not unknown', () => {
  const rows = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].map((fy, i) => ({
    fy, roic: 0.2, revenue: 100 * 1.12 ** i, eps: i === 10 ? -1 : 1 + i * 0.2, bvps: 10 * 1.11 ** i, fcf: 50 * 1.15 ** i,
  }));
  const b = bigFive(rows);
  assert.equal(b.find((m) => m.key === 'eps').status, 'fail');
  assert.equal(b.find((m) => m.key === 'revenue').status, 'pass');
  assert.equal(b.find((m) => m.key === 'roic').status, 'pass');
});

test('historical P/E uses the median (robust to one-off years)', () => {
  const rows = [10, 11, 100, 12, 13].map((pe, i) => ({ fy: 2020 + i, end: `${2020 + i}-12-31`, eps: 1 }));
  const monthly = [10, 11, 100, 12, 13].map((p, i) => ({ t: Date.parse(`${2020 + i}-12-31`) / 1000, close: p }));
  assert.equal(historicalPE(rows, monthly).average, 12);
});

test('sma / ema basics', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[2], 2);   // seed = SMA of first 3
  assert.equal(e[3], 3);   // 4*0.5 + 2*0.5
  assert.equal(e[4], 4);
});
