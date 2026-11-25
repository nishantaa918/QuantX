import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateStrategyBacktest } from '../src/strategy-analysis.js';

const strategy = { type: 'moving-average', shortWindow: 2, longWindow: 6, lookback: 10, volatilitySensitivity: 1.5 };

function historicalSeries(volume = 1_000_000) {
  const values = Array.from({ length: 100 }, (_, index) => 100 + Math.sin(index * 0.83) * 8 + Math.sin(index * 0.19) * 3);
  return {
    values,
    observations: values.map((close, index) => ({
      date: `2025-01-${String(index + 1).padStart(2, '0')}`,
      close, rawClose: close, high: close * 1.02, low: close * 0.98, volume,
    })),
  };
}

test('volume-impact slippage uses prior-session OHLCV and actual traded notional', () => {
  const series = historicalSeries();
  const result = calculateStrategyBacktest(series, strategy, 100_000, {
    commissionBps: 1, slippageBps: 5, slippageModel: 'volume-impact', impactCoefficient: 0.1,
  });
  assert.equal(result.valid, true);
  assert.ok(result.exposures.some((exposure, index) => index > 0 && exposure !== result.exposures[index - 1]));
  for (let index = 1; index < series.values.length; index += 1) {
    const exposure = result.exposures[index - 1] / 100;
    const priorExposure = index < 2 ? 0 : result.exposures[index - 2] / 100;
    const turnover = Math.abs(exposure - priorExposure);
    const priorEquity = result.equityCurve[index - 1];
    const observation = series.observations[index - 1];
    const participation = priorEquity * turnover / (observation.rawClose * observation.volume);
    const expected = turnover === 0 ? 0 : Math.min(0.1 * ((observation.high - observation.low) / observation.rawClose) * Math.sqrt(participation) * 10_000, 500);
    assert.ok(Math.abs(result.slippageEstimatesBps[index] - expected) < 1e-10);
    assert.ok(Math.abs(result.dailyReturns[index] - (result.grossDailyReturns[index] - turnover * (1 + expected) / 10_000)) < 1e-12);
  }
});

test('higher prior-session dollar volume reduces estimated market impact', () => {
  const low = calculateStrategyBacktest(historicalSeries(100_000), strategy, 100_000, { commissionBps: 0, slippageModel: 'volume-impact', impactCoefficient: 0.1 });
  const high = calculateStrategyBacktest(historicalSeries(10_000_000), strategy, 100_000, { commissionBps: 0, slippageModel: 'volume-impact', impactCoefficient: 0.1 });
  assert.equal(low.valid, true);
  assert.equal(high.valid, true);
  assert.ok(low.totalTransactionCostsUSD > high.totalTransactionCostsUSD);
});

test('volume-impact model rejects absent or invalid historical OHLCV', () => {
  const missing = calculateStrategyBacktest({ values: historicalSeries().values }, strategy, 100_000, { slippageModel: 'volume-impact' });
  const incomplete = historicalSeries();
  incomplete.observations[12].volume = 0;
  const invalid = calculateStrategyBacktest(incomplete, strategy, 100_000, { slippageModel: 'volume-impact' });
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join(' '), /aligned historical OHLCV/);
  assert.equal(invalid.valid, false);
});

test('volume-impact model validates model names and coefficient boundaries', () => {
  const series = historicalSeries();
  assert.equal(calculateStrategyBacktest(series, strategy, 100_000, { slippageModel: 'unknown' }).valid, false);
  assert.equal(calculateStrategyBacktest(series, strategy, 100_000, { slippageModel: 'volume-impact', impactCoefficient: 0 }).valid, false);
  assert.equal(calculateStrategyBacktest(series, strategy, 100_000, { slippageModel: 'volume-impact', impactCoefficient: 1.01 }).valid, false);
});
