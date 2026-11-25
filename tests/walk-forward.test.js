import assert from 'node:assert/strict';
import test from 'node:test';
import { runWalkForwardValidation } from '../src/walk-forward.js';
import { calculateExecutionCostRate, calculateStrategyBacktest } from '../src/strategy-analysis.js';

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


test('walk-forward transaction costs are scaled to stitched out-of-sample capital', () => {
  const series = makeSeries(140);
  const executionCosts = { commissionBps: 2, slippageBps: 8 };
  const result = runWalkForwardValidation(series, {
    trainWindow: 60,
    testWindow: 20,
    step: 20,
    shortWindows: [3, 5],
    longWindows: [15, 20],
    executionCosts,
  });
  assert.equal(result.valid, true);

  let stitchedCapital = 100_000;
  let expectedTotalCosts = 0;
  let previousOutOfSampleExposure = 0;
  let observedBoundaryRebalanceDifference = false;
  for (const fold of result.folds) {
    const testStart = series.labels.indexOf(fold.testStart);
    const testEnd = series.labels.indexOf(fold.testEnd) + 1;
    const prefix = {
      labels: series.labels.slice(0, testEnd),
      values: series.values.slice(0, testEnd),
    };
    const backtest = calculateStrategyBacktest(prefix, fold.selectedParameters, 100_000, executionCosts);
    const firstTestExposure = backtest.exposures[testStart - 1] / 100;
    const firstTestTurnover = Math.abs(firstTestExposure - previousOutOfSampleExposure);
    const sameStrategyTurnover = Math.abs(firstTestExposure - backtest.exposures[testStart - 2] / 100);
    if (Math.abs(firstTestTurnover - sameStrategyTurnover) > 1e-12) observedBoundaryRebalanceDifference = true;
    const firstTestCostRate = firstTestTurnover * (executionCosts.commissionBps + executionCosts.slippageBps) / 10_000;
    let expectedFoldCosts = 0;

    for (let index = testStart; index < testEnd; index += 1) {
      const prefixEquity = backtest.equityCurve[index - 1];
      const costFraction = index === testStart
        ? firstTestCostRate
        : backtest.transactionCostsUSD[index] / prefixEquity;
      const cost = stitchedCapital * costFraction;
      expectedFoldCosts += cost;
      expectedTotalCosts += cost;
      const dailyReturn = index === testStart
        ? backtest.grossDailyReturns[index] - firstTestCostRate
        : backtest.dailyReturns[index];
      stitchedCapital *= 1 + dailyReturn;
    }

    previousOutOfSampleExposure = backtest.exposures[testEnd - 2] / 100;
    assert.ok(Math.abs(fold.transactionCostsUSD - expectedFoldCosts) < 1e-8);
  }

  assert.equal(observedBoundaryRebalanceDifference, true);
  assert.ok(Math.abs(result.totalTransactionCostsUSD - expectedTotalCosts) < 1e-8);
});

test('walk-forward validation rejects misaligned, duplicate, and out-of-order calendar labels', () => {
  const base = makeSeries();
  const series = {
    ...base,
    labels: base.values.map((_, index) => new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10)),
  };
  assert.equal(runWalkForwardValidation({ ...series, labels: series.labels.slice(1) }).valid, false);

  const duplicate = [...series.labels];
  duplicate[70] = duplicate[69];
  assert.equal(runWalkForwardValidation({ ...series, labels: duplicate }).valid, false);

  const outOfOrder = [...series.labels];
  [outOfOrder[70], outOfOrder[71]] = [outOfOrder[71], outOfOrder[70]];
  assert.equal(runWalkForwardValidation({ ...series, labels: outOfOrder }).valid, false);

  const invalidDate = [...series.labels];
  invalidDate[70] = '2025-02-30';
  assert.equal(runWalkForwardValidation({ ...series, labels: invalidDate }).valid, false);
});

test('walk-forward validation retains support for unique non-calendar observation labels', () => {
  const series = makeSeries();
  const labels = series.values.map((_, index) => `Session ${index + 1}`);
  assert.equal(runWalkForwardValidation({ ...series, labels }, {
    trainWindow: 60,
    testWindow: 20,
    shortWindows: [3],
    longWindows: [15],
  }).valid, true);
});

test('walk-forward volume-impact costs use aligned prior OHLCV and stitched OOS capital', () => {
  const base = makeSeries(140);
  const series = {
    ...base,
    observations: base.values.map((close, index) => ({
      date: base.labels[index],
      close,
      rawClose: close,
      high: close * (1.01 + (index % 5) * 0.001),
      low: close * (0.99 - (index % 3) * 0.001),
      volume: 150_000 + (index % 11) * 75_000,
    })),
  };
  const executionCosts = { commissionBps: 2, slippageModel: 'volume-impact', impactCoefficient: 0.1 };
  const result = runWalkForwardValidation(series, {
    trainWindow: 60,
    testWindow: 20,
    step: 20,
    shortWindows: [3, 5],
    longWindows: [15, 20],
    executionCosts,
  });
  assert.equal(result.valid, true);

  let stitchedCapital = 100_000;
  let previousOutOfSampleExposure = 0;
  let expectedTotalCosts = 0;
  for (const fold of result.folds) {
    const testStart = series.labels.indexOf(fold.testStart);
    const testEnd = series.labels.indexOf(fold.testEnd) + 1;
    const prefix = {
      labels: series.labels.slice(0, testEnd),
      values: series.values.slice(0, testEnd),
      observations: series.observations.slice(0, testEnd),
    };
    const forward = calculateStrategyBacktest(prefix, fold.selectedParameters, 100_000, executionCosts);
    assert.equal(forward.valid, true);
    let expectedFoldCosts = 0;
    for (let index = testStart; index < testEnd; index += 1) {
      const exposure = forward.exposures[index - 1] / 100;
      const priorExposure = index === testStart
        ? previousOutOfSampleExposure
        : forward.exposures[index - 2] / 100;
      const turnover = Math.abs(exposure - priorExposure);
      const cost = calculateExecutionCostRate(series, index, turnover, stitchedCapital, executionCosts);
      assert.equal(cost.valid, true);
      const amount = stitchedCapital * cost.costRate;
      expectedFoldCosts += amount;
      expectedTotalCosts += amount;
      stitchedCapital *= 1 + forward.grossDailyReturns[index] - cost.costRate;
    }
    previousOutOfSampleExposure = forward.exposures[testEnd - 2] / 100;
    assert.ok(Math.abs(fold.transactionCostsUSD - expectedFoldCosts) < 1e-7);
  }
  assert.ok(Math.abs(result.totalTransactionCostsUSD - expectedTotalCosts) < 1e-7);
});
