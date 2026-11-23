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
  assert.equal(detectMarketRegimes({ values: [100, 101] }).valid, false);
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

test('strategy autopsy refuses misaligned or invalid backtests', () => {
  const series = trendingSeries(30);
  assert.equal(analyzeStrategyBacktest(series, null).valid, false);
  const backtest = calculateStrategyBacktest(series, strategy);
  assert.equal(analyzeStrategyBacktest(datedSeries([100, 101]), backtest).valid, false);
});

test('momentum hypothesis permutation test is reproducible and reports sample counts', () => {
  const values = Array.from({ length: 140 }, (_, index) => 100 * (1.0015 ** index) * (1 + Math.sin(index / 3) * 0.025));
  const series = datedSeries(values);
  const first = testMomentumHypothesis(series, { lookback: 5, permutations: 199, seed: 42 });
  const second = testMomentumHypothesis(series, { lookback: 5, permutations: 199, seed: 42 });
  assert.equal(first.valid, true);
  assert.deepEqual(first, second);
  assert.equal(first.positiveCount + first.nonPositiveCount, values.length - 6);
  assert.ok(first.pValue > 0 && first.pValue <= 1);
  assert.ok(Number.isFinite(first.differencePct));
});

test('momentum hypothesis rejects insufficient samples and unsupported settings', () => {
  assert.equal(testMomentumHypothesis(datedSeries([100, 101, 99, 102])).valid, false);
  assert.equal(testMomentumHypothesis(trendingSeries(), { permutations: 10 }).valid, false);
});

test('combined research report keeps each analysis independently available', () => {
  const series = trendingSeries(90);
  const backtest = calculateStrategyBacktest(series, strategy);
  const report = buildResearchIntelligenceReport(series, backtest, { hypothesis: { permutations: 199 } });
  assert.equal(report.regimes.valid, true);
  assert.equal(report.autopsy.valid, true);
  assert.equal(report.hypothesis.valid, true);
});
