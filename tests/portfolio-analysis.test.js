import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDiversificationPortfolio } from '../src/portfolio-analysis.js';

function makeSeries(symbol, values, dates = ['2025-01-02', '2025-01-03', '2025-01-06', '2025-01-07', '2025-01-08']) {
  return { symbol, period: 'HISTORICAL', labels: dates, values };
}

const opposingAssets = {
  AAA: makeSeries('AAA', [100, 110, 99, 108.9, 98.01]),
  BBB: makeSeries('BBB', [100, 90, 99, 89.1, 98.01]),
};

test('portfolio analysis aligns dates and identifies perfectly opposing return streams', () => {
  const result = calculateDiversificationPortfolio(opposingAssets, {
    executionCosts: { commissionBps: 0, slippageBps: 0 },
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  console.log('PORTFOLIO DEBUG', JSON.stringify({ correlations: result.correlations, returns: result.assetReturns }));
  assert.deepEqual(result.symbols, ['AAA', 'BBB']);
  assert.equal(result.observations, 4);
  assert.ok(Math.abs(result.correlations[0].values[1] + 1) < 1e-8);
  assert.ok(Math.abs(result.correlations[1].values[0] + 1) < 1e-8);
  assert.ok(Number.isFinite(result.metrics.totalReturn));
});

test('equal-weight daily rebalancing and buy-and-hold benchmark are distinct', () => {
  const result = calculateDiversificationPortfolio(opposingAssets, {
    executionCosts: { commissionBps: 0, slippageBps: 0 },
  });
  assert.equal(result.valid, true);
  assert.notDeepEqual(result.equityCurve, result.benchmarkEquityCurve);
  assert.equal(result.assetPerformance.length, 2);
  assert.equal(result.turnover.length, result.observations);
  assert.equal(result.turnover[0], 1);
});

test('transaction costs reduce net portfolio performance', () => {
  const noCost = calculateDiversificationPortfolio(opposingAssets, {
    executionCosts: { commissionBps: 0, slippageBps: 0 },
  });
  const withCost = calculateDiversificationPortfolio(opposingAssets, {
    executionCosts: { commissionBps: 2, slippageBps: 8 },
  });
  assert.ok(withCost.metrics.totalReturn < noCost.metrics.totalReturn);
  assert.ok(withCost.totalTransactionCostsUSD > 0);
  assert.ok(withCost.totalTurnover >= 1);
});

test('date alignment uses only shared return dates', () => {
  const result = calculateDiversificationPortfolio({
    AAA: makeSeries('AAA', [100, 101, 102, 103, 104]),
    BBB: makeSeries('BBB', [100, 99, 98, 97], ['2025-01-02', '2025-01-03', '2025-01-07', '2025-01-08']),
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.dates, ['2025-01-03', '2025-01-07', '2025-01-08']);
  assert.equal(result.observations, 3);
});

test('invalid assets, dates, prices, costs and capital are rejected', () => {
  assert.equal(calculateDiversificationPortfolio({ AAA: opposingAssets.AAA }).valid, false);
  assert.equal(calculateDiversificationPortfolio({
    AAA: makeSeries('AAA', [100, 101, 102, 103, 104]),
    BBB: makeSeries('BBB', [100, 101, 102, 103, 104], ['2025-01-02', '2025-01-03', '2025-01-04', '2025-01-03', '2025-01-08']),
  }).valid, false);
  assert.equal(calculateDiversificationPortfolio({
    AAA: makeSeries('AAA', [100, 101, 102, 103, 104]),
    BBB: makeSeries('BBB', [100, 101, 0, 103, 104]),
  }).valid, false);
  assert.equal(calculateDiversificationPortfolio(opposingAssets, { startingCapital: 0 }).valid, false);
  assert.equal(calculateDiversificationPortfolio(opposingAssets, { executionCosts: { commissionBps: -1, slippageBps: 0 } }).valid, false);
});

test('constant-return series reports undefined correlation rather than a false zero', () => {
  const result = calculateDiversificationPortfolio({
    AAA: makeSeries('AAA', [100, 101, 102.01, 103.0301, 104.060401]),
    BBB: makeSeries('BBB', [100, 100, 100, 100, 100]),
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  console.log('CONSTANT DEBUG', JSON.stringify({ correlations: result.correlations, returns: result.assetReturns }));
  assert.equal(result.correlations[0].values[1], null);
});
