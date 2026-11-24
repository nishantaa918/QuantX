import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateStrategyBacktest } from '../src/strategy-analysis.js';

const parameters = {
  type: 'moving-average',
  shortWindow: 2,
  longWindow: 6,
  lookback: 10,
  volatilitySensitivity: 1.5,
};

function makePrices(length, transform = (index) => 100 + index * 0.2 + Math.sin(index * 0.7) * 2) {
  return {
    period: 'HISTORICAL',
    labels: Array.from({ length }, (_, index) => `Session ${index + 1}`),
    values: Array.from({ length }, (_, index) => transform(index)),
  };
}

test('backtest prefix is invariant when observations after the evaluation cutoff change', () => {
  const cutoff = 35;
  const original = makePrices(70);
  const changedFuture = makePrices(70, (index) => index < cutoff
    ? original.values[index]
    : 250 + (index - cutoff) * 3 + Math.cos(index) * 5);

  const originalBacktest = calculateStrategyBacktest(original, parameters, 100_000, {
    commissionBps: 2,
    slippageBps: 8,
  });
  const changedBacktest = calculateStrategyBacktest(changedFuture, parameters, 100_000, {
    commissionBps: 2,
    slippageBps: 8,
  });

  assert.equal(originalBacktest.valid, true);
  assert.equal(changedBacktest.valid, true);
  for (const key of ['signals', 'exposures', 'dailyReturns', 'equityCurve', 'transactionCostsUSD']) {
    assert.deepEqual(
      changedBacktest[key].slice(0, cutoff),
      originalBacktest[key].slice(0, cutoff),
      `${key} before the cutoff must not depend on future prices`,
    );
  }
});

test('a backtest run on a historical prefix matches the same prefix of a longer run', () => {
  const cutoff = 42;
  const fullSeries = makePrices(90);
  const prefixSeries = {
    ...fullSeries,
    labels: fullSeries.labels.slice(0, cutoff),
    values: fullSeries.values.slice(0, cutoff),
  };
  const costs = { commissionBps: 1, slippageBps: 5 };
  const prefixBacktest = calculateStrategyBacktest(prefixSeries, parameters, 100_000, costs);
  const fullBacktest = calculateStrategyBacktest(fullSeries, parameters, 100_000, costs);

  assert.equal(prefixBacktest.valid, true);
  assert.equal(fullBacktest.valid, true);
  for (const key of ['signals', 'exposures', 'dailyReturns', 'equityCurve', 'transactionCostsUSD']) {
    assert.deepEqual(
      prefixBacktest[key],
      fullBacktest[key].slice(0, cutoff),
      `${key} must be identical whether evaluated alone or with later observations present`,
    );
  }
});
