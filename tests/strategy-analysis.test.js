import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePerformance } from '../src/data.js';
import {
  calculateStrategyBacktest,
  DEFAULT_GUARDRAILS,
  DEFAULT_STRATEGY,
  evaluatePolicyState,
  evaluateRiskGuardrails,
  runParameterSweep,
} from '../src/strategy-analysis.js';

const activeStrategy = {
  type: 'moving-average',
  shortWindow: 2,
  longWindow: 6,
  lookback: 10,
  volatilitySensitivity: 1.5,
};

function risingSeries(length = 80) {
  return {
    period: '1Y',
    labels: Array.from({ length }, (_, index) => `Session ${index + 1}`),
    values: Array.from({ length }, (_, index) => 100 + index),
  };
}

function exposureCheck(guardrails) {
  return guardrails.checks.find((check) => check.key === 'exposure');
}

test('equity drawdown is measured from the prior peak', () => {
  const metrics = calculatePerformance([100, 120, 90, 110]);
  assert.ok(Math.abs(metrics.totalReturn - 10) < 1e-10);
  assert.equal(metrics.maxDrawdown, -25);
});

test('threshold edits recalculate measured values and flag a breach', () => {
  const backtest = calculateStrategyBacktest(risingSeries(), activeStrategy);
  const withinLimits = evaluateRiskGuardrails(backtest, {
    maxDrawdown: 100,
    maxVolatility: 300,
    maxExposure: 100,
    lossLimit: 100,
  });
  const breached = evaluateRiskGuardrails(backtest, {
    maxDrawdown: 100,
    maxVolatility: 300,
    maxExposure: 80,
    lossLimit: 100,
  });

  assert.equal(backtest.valid, true);
  assert.ok(backtest.exposures.some((exposure) => exposure > 0));
  assert.equal(withinLimits.available, true);
  assert.notEqual(withinLimits.status, 'FAIL');
  assert.equal(exposureCheck(withinLimits).actual, '100.00%');
  assert.equal(exposureCheck(breached).status, 'FAIL');
  assert.equal(exposureCheck(breached).limit, '80%');
});

test('guardrail boundaries fail only when the measured value exceeds each limit', () => {
  const backtest = {
    valid: true,
    metrics: { maxDrawdown: -10, annualizedVolatility: 20 },
    exposures: [80],
    maxExposure: 80,
    maxDailyLoss: 5,
  };
  const actuals = [
    ['maxDrawdown', 'drawdown', 10],
    ['maxVolatility', 'volatility', 20],
    ['maxExposure', 'exposure', 80],
    ['lossLimit', 'loss', 5],
  ];

  for (const [thresholdKey, checkKey, actual] of actuals) {
    const evaluateAt = (threshold) => evaluateRiskGuardrails(backtest, {
      maxDrawdown: 100,
      maxVolatility: 300,
      maxExposure: 100,
      lossLimit: 100,
      [thresholdKey]: threshold,
    }).checks.find((check) => check.key === checkKey);

    assert.equal(evaluateAt(actual - 0.01).status, 'FAIL', `${thresholdKey} below actual`);
    assert.notEqual(evaluateAt(actual).status, 'FAIL', `${thresholdKey} at actual`);
    assert.notEqual(evaluateAt(actual + 0.01).status, 'FAIL', `${thresholdKey} above actual`);
  }
});

test('shared policy state recalculates diagnostics after numeric strategy input changes', () => {
  const series = risingSeries();
  const shortWindowState = evaluatePolicyState({
    series,
    parameters: activeStrategy,
    thresholds: DEFAULT_GUARDRAILS,
    backtestSeries: series,
  });
  const longWindowState = evaluatePolicyState({
    series,
    parameters: { ...activeStrategy, shortWindow: 5, longWindow: 20, lookback: 30 },
    thresholds: DEFAULT_GUARDRAILS,
    backtestSeries: series,
  });
  const meanReversionState = evaluatePolicyState({
    series,
    parameters: { ...activeStrategy, type: 'mean-reversion' },
    thresholds: DEFAULT_GUARDRAILS,
    backtestSeries: series,
  });

  assert.ok(shortWindowState.latestBacktest.exposures.some((exposure) => exposure > 0));
  assert.notEqual(shortWindowState.latestBacktest.metrics.totalReturn, longWindowState.latestBacktest.metrics.totalReturn);
  assert.equal(longWindowState.diagnostics.validation.config.longWindow, 20);
  assert.equal(meanReversionState.latestBacktest.exposures.some((exposure) => exposure > 0), false);
  assert.equal(meanReversionState.guardrails.status, 'PENDING');
  assert.equal(meanReversionState.diagnostics.checks.find((check) => check.name === 'Performance anomalies').status, 'WARNING');
});

test('threshold changes recalculate evaluation without mutating historical inputs', () => {
  const series = risingSeries();
  const historicalSnapshot = JSON.stringify(series);
  const withinLimit = evaluatePolicyState({
    series,
    parameters: activeStrategy,
    thresholds: { ...DEFAULT_GUARDRAILS, maxExposure: 100 },
    backtestSeries: series,
  });
  const breached = evaluatePolicyState({
    series,
    parameters: activeStrategy,
    thresholds: { ...DEFAULT_GUARDRAILS, maxExposure: 80 },
    backtestSeries: series,
  });

  assert.equal(withinLimit.guardrails.status, 'WARNING');
  assert.equal(breached.guardrails.status, 'FAIL');
  assert.equal(JSON.stringify(series), historicalSnapshot);
  assert.deepEqual(breached.latestBacktest.equityCurve, withinLimit.latestBacktest.equityCurve);
});

test('missing backtest data is pending and contains no measured percentages', () => {
  const state = evaluatePolicyState({ series: risingSeries(), parameters: activeStrategy });

  assert.equal(state.latestBacktest, null);
  assert.equal(state.guardrails.status, 'PENDING');
  assert.equal(state.guardrails.available, false);
  assert.match(state.guardrails.message, /Run a backtest/);
  assert.equal(state.guardrails.checks.some((check) => check.key), false);
});

test('zero-trade backtests report unavailable risk and warning diagnostics', () => {
  const flatSeries = { period: '1M', labels: Array(40).fill('Session'), values: Array(40).fill(100) };
  const state = evaluatePolicyState({
    series: flatSeries,
    parameters: DEFAULT_STRATEGY,
    thresholds: DEFAULT_GUARDRAILS,
    backtestSeries: flatSeries,
  });

  assert.equal(state.latestBacktest.valid, true);
  assert.equal(state.latestBacktest.exposures.some((exposure) => exposure > 0), false);
  assert.equal(state.guardrails.status, 'PENDING');
  assert.match(state.guardrails.message, /No positions/);
  assert.equal(state.diagnostics.checks.find((check) => check.name === 'Performance anomalies').status, 'WARNING');
});

test('empty or invalid inputs do not produce numeric risk results', () => {
  const emptySeries = { period: '1M', labels: [], values: [] };
  const state = evaluatePolicyState({ series: emptySeries, parameters: activeStrategy });
  const invalidThresholds = evaluateRiskGuardrails(calculateStrategyBacktest(risingSeries(), activeStrategy), {
    ...DEFAULT_GUARDRAILS,
    maxExposure: Number.NaN,
  });

  assert.equal(state.currentBacktest.valid, false);
  assert.equal(state.currentBacktest.metrics, null);
  assert.equal(state.guardrails.status, 'PENDING');
  assert.equal(state.diagnostics.status, 'FAIL');
  assert.equal(invalidThresholds.status, 'FAIL');
  assert.equal(invalidThresholds.available, false);
  assert.equal(invalidThresholds.checks.some((check) => check.key), false);
});

test('heatmap parameter results equal the underlying parameter-sweep backtests', () => {
  const series = risingSeries();
  const parameters = { ...activeStrategy, lookback: 20 };
  const sweep = runParameterSweep(series, parameters, [2], [6]);
  const direct = calculateStrategyBacktest(series, { ...parameters, shortWindow: 2, longWindow: 6 });

  assert.equal(sweep.length, 1);
  assert.deepEqual(sweep[0].metrics, direct.metrics);
});
