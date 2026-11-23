import assert from 'node:assert/strict';
import test from 'node:test';
import { runWalkForwardValidation } from '../src/walk-forward.js';

function makeSeries(length = 140) {
  const points = Array.from({ length }, (_, index) => {
    const drift = index < 70 ? 0.0012 : index < 105 ? -0.0008 : 0.001;
    return 100 * Math.exp(drift * index + Math.sin(index * 0.47) * 0.02);
  });
  return { period: 'HISTORICAL', labels: points.map((_, index) => `2025-${String(index + 1).padStart(3, '0')}`), values: points };
}

test('walk-forward validation selects on training data and reports non-overlapping test folds', () => {
  const result = runWalkForwardValidation(makeSeries(), {
    trainWindow: 60,
    testWindow: 20,
    step: 20,
    shortWindows: [3, 5],
    longWindows: [15, 20],
    executionCosts: { commissionBps: 1, slippageBps: 5 },
  });
  assert.equal(result.valid, true);
  assert.equal(result.folds.length, 4);
  assert.equal(result.outOfSampleObservations, 80);
  assert.equal(result.candidateCount, 4);
  assert.ok(Number.isFinite(result.metrics.totalReturn));
  assert.ok(Number.isFinite(result.benchmarkMetrics.totalReturn));
  assert.ok(result.totalTransactionCostsUSD >= 0);
  assert.equal(result.folds[0].testEnd, result.folds[1].trainEnd);
  assert.ok(result.folds.every((fold) => fold.selectedParameters.shortWindow < fold.selectedParameters.longWindow));
});

test('walk-forward output is deterministic for fixed data and settings', () => {
  const options = { trainWindow: 60, testWindow: 20, step: 20, shortWindows: [3, 5], longWindows: [15, 20] };
  const first = runWalkForwardValidation(makeSeries(), options);
  const second = runWalkForwardValidation(makeSeries(), options);
  assert.deepEqual(first, second);
});

test('walk-forward validation rejects insufficient history and invalid windows', () => {
  assert.equal(runWalkForwardValidation(makeSeries(50)).valid, false);
  assert.equal(runWalkForwardValidation(makeSeries(), { trainWindow: 20 }).valid, false);
  assert.equal(runWalkForwardValidation(makeSeries(), { trainWindow: 60, testWindow: 20, step: 10 }).valid, false);
});

test('walk-forward validation rejects invalid candidate grids and reports skipped folds', () => {
  assert.equal(runWalkForwardValidation(makeSeries(), { shortWindows: [10], longWindows: [5] }).valid, false);
  const monotonic = { period: 'HISTORICAL', labels: Array.from({ length: 140 }, (_, index) => `Session ${index + 1}`), values: Array.from({ length: 140 }, (_, index) => 100 + index) };
  const noTrades = runWalkForwardValidation(monotonic, {
    trainWindow: 60,
    testWindow: 20,
    shortWindows: [2],
    longWindows: [6],
    baseParameters: { type: 'mean-reversion', shortWindow: 2, longWindow: 6, lookback: 10, volatilitySensitivity: 1.5 },
  });
  assert.equal(noTrades.valid, false);
  assert.equal(noTrades.skippedFolds, 4);
});
