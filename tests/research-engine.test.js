import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateStrategyBacktest } from '../src/strategy-analysis.js';
import {
  analyzeStrategyBacktest,
  buildResearchIntelligenceReport,
  detectMarketRegimes,
  testMomentumHypothesis,
} from '../src/research-engine.js';

const strategy = { type: 'moving-average', shortWindow: 2, longWindow: 6, lookback: 10, volatilitySensitivity: 1.5 };

function datedSeries(values) {
  return {
    period: 'HISTORICAL',
    labels: values.map((_, index) => `2025-01-${String(index + 1).padStart(2, '0')}`),
    values,
  };
}

function trendingSeries(length = 90) {
  return datedSeries(Array.from({ length }, (_, index) => 100 * (1.002 ** index)));
}

function mixedSeries(length = 90) {
  return datedSeries(Array.from({ length }, (_, index) => 100 * (1.001 ** index) * (1 + Math.sin(index / 3) * 0.025)));
}

test('regime detector identifies a sustained uptrend and preserves rolling readiness', () => {
  const result = detectMarketRegimes(trendingSeries(), { window: 20 });
  assert.equal(result.valid, true);
  assert.equal(result.regimes[19].ready, false);
  assert.equal(result.latest.direction, 'UPTREND');
  assert.equal(result.latest.volatilityLevel, 'LOW');
  assert.match(result.latest.label, /Uptrend/);
});

test('regime detector identifies sideways and downtrend windows', () => {
  const sideways = detectMarketRegimes(datedSeries(Array.from({ length: 50 }, (_, index) => 100 + Math.sin(index) * 0.1)), { window: 20 });
  const falling = detectMarketRegimes(datedSeries(Array.from({ length: 50 }, (_, index) => 150 * (0.997 ** index))), { window: 20 });
  assert.equal(sideways.latest.direction, 'SIDEWAYS');
  assert.equal(falling.latest.direction, 'DOWNTREND');
});

test('regime detector rejects malformed data and invalid thresholds', () => {
  assert.equal(detectMarketRegimes({ values: [100] }).valid, false);
  assert.equal(detectMarketRegimes(trendingSeries(), { window: 2 }).valid, false);
  assert.equal(detectMarketRegimes(trendingSeries(), { lowVolatility: 0.4, highVolatility: 0.3 }).valid, false);
});

test('strategy autopsy reconciles returns and applies next-session exposure alignment', () => {
  const series = trendingSeries(80);
  const backtest = calculateStrategyBacktest(series, strategy);
  const report = analyzeStrategyBacktest(series, backtest);
  assert.equal(report.valid, true);
  assert.ok(Math.abs(report.strategyReturn - backtest.metrics.totalReturn) < 1e-9);
  assert.ok(report.activeSessions > 0);
  assert.equal(report.totalSessions, series.values.length);
  assert.ok(report.entryCount >= 1);
  assert.equal(report.effectiveExposures[0], 0);
  assert.equal(report.effectiveExposures[1], backtest.exposures[0]);
  assert.ok(Number.isFinite(report.relativeReturn));
});


test('benchmark diagnostics estimate beta, alpha, tracking error and information ratio from aligned daily returns', () => {
  const benchmarkDailyReturns = Array.from({ length: 50 }, (_, index) => 0.002 * Math.sin(index * 0.71) + 0.0004 * Math.cos(index * 0.19));
  const prices = [100];
  for (const dailyReturn of benchmarkDailyReturns) prices.push(prices.at(-1) * (1 + dailyReturn));
  const strategyDailyReturns = [0, ...benchmarkDailyReturns.map((value) => 0.001 + 1.5 * value)];
  const equityCurve = [100_000];
  for (const dailyReturn of strategyDailyReturns.slice(1)) equityCurve.push(equityCurve.at(-1) * (1 + dailyReturn));
  const series = datedSeries(prices);
  const backtest = {
    valid: true,
    equityCurve,
    dailyReturns: strategyDailyReturns,
    exposures: prices.map((_, index) => index === 0 ? 0 : 1),
  };
  const report = analyzeStrategyBacktest(series, backtest);
  assert.equal(report.valid, true);
  assert.equal(report.benchmarkDiagnostics.valid, true);
  assert.ok(Math.abs(report.benchmarkDiagnostics.beta - 1.5) < 1e-9);
  assert.ok(Math.abs(report.benchmarkDiagnostics.annualizedAlphaPct - 25.2) < 1e-8);
  assert.ok(report.benchmarkDiagnostics.trackingErrorPct > 0);
  assert.ok(Number.isFinite(report.benchmarkDiagnostics.informationRatio));
  assert.equal(report.benchmarkDiagnostics.riskFreeRateAnnualPct, 0);
  assert.equal(report.benchmarkDiagnostics.observations, 50);
});

test('benchmark diagnostics handle a flat benchmark and reject non-finite backtest returns', () => {
  const flat = datedSeries(Array.from({ length: 20 }, () => 100));
  const backtest = {
    valid: true,
    equityCurve: Array.from({ length: 20 }, (_, index) => 100_000 * (1.001 ** index)),
    dailyReturns: Array.from({ length: 20 }, (_, index) => index === 0 ? 0 : 0.001),
    exposures: Array.from({ length: 20 }, () => 1),
  };
  const report = analyzeStrategyBacktest(flat, backtest);
  assert.equal(report.valid, true);
  assert.equal(report.benchmarkDiagnostics.beta, null);
  assert.equal(report.benchmarkDiagnostics.correlation, null);
  assert.equal(report.benchmarkDiagnostics.annualizedAlphaPct, null);
  assert.equal(report.benchmarkDiagnostics.informationRatio, null);
  assert.equal(analyzeStrategyBacktest(flat, { ...backtest, dailyReturns: [0, NaN, ...backtest.dailyReturns.slice(2)] }).valid, false);
});


test('strategy autopsy aligns an external benchmark by exact shared trading dates', () => {
  const asset = datedSeries(Array.from({ length: 8 }, (_, index) => 100 * (1.01 ** index)));
  const benchmark = {
    period: 'HISTORICAL',
    symbol: 'SPY',
    labels: ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05', '2025-01-06', '2025-01-07', '2025-01-08'],
    values: [100, 101, 99, 102, 103, 100, 104, 105],
  };
  const strategyReturns = [0, ...Array.from({ length: 7 }, (_, index) => {
    const benchmarkReturn = benchmark.values[index + 1] / benchmark.values[index] - 1;
    return 0.0005 + 1.2 * benchmarkReturn;
  })];
  const equityCurve = [100_000];
  for (const dailyReturn of strategyReturns.slice(1)) equityCurve.push(equityCurve.at(-1) * (1 + dailyReturn));
  const backtest = { valid: true, equityCurve, dailyReturns: strategyReturns, exposures: asset.values.map(() => 1) };
  const report = analyzeStrategyBacktest(asset, backtest, benchmark);
  assert.equal(report.valid, true);
  assert.equal(report.benchmarkDiagnostics.benchmark, 'SPY');
  assert.equal(report.benchmarkDiagnostics.observations, 7);
  assert.ok(Math.abs(report.benchmarkDiagnostics.beta - 1.2) < 1e-9);
  assert.ok(report.benchmarkDiagnostics.correlation <= 1 && report.benchmarkDiagnostics.correlation >= -1);
  assert.ok(Math.abs(report.benchmarkDiagnostics.annualizedAlphaPct - 12.6) < 1e-8);
});

test('external benchmark alignment skips sessions missing from either series and requires enough matched returns', () => {
  const asset = { period: 'HISTORICAL', labels: ['d1', 'd2', 'd3', 'd4', 'd5'], values: [100, 101, 102, 103, 104] };
  const benchmark = { period: 'HISTORICAL', symbol: 'SPY', labels: ['d1', 'd2', 'd4', 'd5'], values: [100, 100.5, 101, 101.5] };
  const backtest = { valid: true, equityCurve: [100, 101, 102, 103, 104], dailyReturns: [0, .01, .01, .01, .01], exposures: [0, 1, 1, 1, 1] };
  const report = analyzeStrategyBacktest(asset, backtest, benchmark);
  assert.equal(report.valid, true);
  assert.equal(report.benchmarkDiagnostics.observations, 2);
  assert.equal(report.benchmarkDiagnostics.valid, true);
  const oneMatch = { ...benchmark, labels: ['d1', 'd2'], values: [100, 101] };
  const shortReport = analyzeStrategyBacktest(asset, backtest, oneMatch);
  assert.equal(shortReport.benchmarkDiagnostics.valid, false);
});

test('strategy autopsy refuses misaligned or invalid backtests', () => {
  const series = trendingSeries(30);
  assert.equal(analyzeStrategyBacktest(series, null).valid, false);
  const backtest = calculateStrategyBacktest(series, strategy);
  assert.equal(analyzeStrategyBacktest(datedSeries([100, 101]), backtest).valid, false);
});

test('momentum hypothesis permutation test is reproducible and reports sample counts', () => {
  const series = mixedSeries(140);
  const first = testMomentumHypothesis(series, { lookback: 5, permutations: 199, seed: 42, blockLength: 5 });
  const second = testMomentumHypothesis(series, { lookback: 5, permutations: 199, seed: 42 });
  assert.equal(first.valid, true);
  assert.deepEqual(first, second);
  assert.equal(first.positiveCount + first.nonPositiveCount, series.values.length - 6);
  assert.ok(first.pValue > 0 && first.pValue <= 1);
  assert.equal(first.method, 'Contiguous block permutation test');
  assert.equal(first.blockLength, 5);
  assert.ok(Number.isFinite(first.differencePct));
});

test('momentum hypothesis rejects insufficient samples and unsupported settings', () => {
  assert.equal(testMomentumHypothesis(datedSeries([100, 101, 99, 102])).valid, false);
  assert.equal(testMomentumHypothesis(trendingSeries(), { permutations: 10 }).valid, false);
  assert.equal(testMomentumHypothesis(mixedSeries(), { blockLength: 1 }).valid, false);
});

test('combined research report keeps each analysis independently available', () => {
  const series = mixedSeries(90);
  const backtest = calculateStrategyBacktest(series, strategy);
  const report = buildResearchIntelligenceReport(series, backtest, { hypothesis: { permutations: 199 } });
  assert.equal(report.regimes.valid, true);
  assert.equal(report.autopsy.valid, true);
  assert.equal(report.hypothesis.valid, true);
});
