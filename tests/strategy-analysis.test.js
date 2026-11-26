import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePerformance } from '../src/data.js';
import {
  analyzeExecutionCostSensitivity,
  calculateStrategyBacktest,
  DEFAULT_EXECUTION_COSTS,
  DEFAULT_GUARDRAILS,
  DEFAULT_STRATEGY,
  evaluatePolicyState,
  evaluateRiskGuardrails,
  runParameterSweep,
  validateExecutionCosts,
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

test('parameter sweep metrics exclude flat warm-up sessions and retain cost-aware OOS returns', () => {
  const series = risingSeries();
  const parameters = { ...activeStrategy, lookback: 20 };
  const costs = { commissionBps: 2, slippageBps: 8 };
  const sweep = runParameterSweep(series, parameters, [2], [6], costs);
  const direct = calculateStrategyBacktest(series, { ...parameters, shortWindow: 2, longWindow: 6 }, 100_000, costs);

  assert.equal(sweep.length, 1);
  assert.deepEqual(sweep[0].metrics, calculatePerformance(direct.equityCurve.slice(5)));
  assert.notDeepEqual(sweep[0].metrics, direct.metrics);
  assert.deepEqual(sweep[0].executionCosts, costs);
  assert.equal(sweep[0].evaluationObservations, 74);
  assert.equal(sweep[0].maxDailyLoss, Math.max(0, ...direct.dailyReturns.slice(6).map((value) => -value * 100)));
  assert.equal(sweep[0].maxExposure, Math.max(0, ...direct.exposures.slice(5)));
});

test('parameter sweep uses the full volatility-filter warm-up when enforcing sample size', () => {
  const series = risingSeries(35);
  const parameters = { ...activeStrategy, type: 'volatility-filter', lookback: 30 };
  const insufficient = runParameterSweep(series, parameters, [2], [6]);
  const sufficient = runParameterSweep(risingSeries(60), parameters, [2], [6]);

  assert.equal(insufficient.length, 0);
  assert.equal(sufficient.length, 1);
  assert.equal(sufficient[0].evaluationObservations, 30);
});

test('heatmap suppresses combinations without enough post-warm-up observations', () => {
  const shortHistory = risingSeries(35);
  const noEligibleCells = runParameterSweep(shortHistory, activeStrategy, [2], [6]);
  const eligibleHistory = risingSeries(36);
  const eligibleCell = runParameterSweep(eligibleHistory, activeStrategy, [2], [6]);

  assert.equal(noEligibleCells.length, 0);
  assert.equal(eligibleCell.length, 1);
  assert.equal(eligibleCell[0].evaluationObservations, 30);
});

test('execution costs reduce net equity and are charged on next-session entries', () => {
  const series = risingSeries(80);
  const noCosts = calculateStrategyBacktest(series, activeStrategy, 100_000, { commissionBps: 0, slippageBps: 0 });
  const withCosts = calculateStrategyBacktest(series, activeStrategy, 100_000, { commissionBps: 1, slippageBps: 5 });

  assert.equal(noCosts.valid, true);
  assert.equal(withCosts.valid, true);
  assert.equal(withCosts.tradeCount, 1);
  assert.equal(withCosts.totalTurnover, 1);
  assert.ok(Math.abs(withCosts.totalTransactionCostsUSD - 60) < 1e-8);
  assert.ok(withCosts.equityCurve.at(-1) < noCosts.equityCurve.at(-1));
  assert.ok(Math.abs(withCosts.grossEquityCurve.at(-1) - noCosts.equityCurve.at(-1)) < 1e-8);
  assert.ok(withCosts.metrics.totalReturn < withCosts.grossMetrics.totalReturn);
});

test('execution-cost validation rejects negative and out-of-range assumptions', () => {
  assert.deepEqual(validateExecutionCosts(DEFAULT_EXECUTION_COSTS), {
    valid: true,
    errors: [],
    config: DEFAULT_EXECUTION_COSTS,
  });
  assert.equal(validateExecutionCosts({ commissionBps: -1, slippageBps: 5 }).valid, false);
  assert.equal(validateExecutionCosts({ commissionBps: 1, slippageBps: 101 }).valid, false);
});

test('policy state uses the supplied execution-cost assumptions consistently', () => {
  const series = risingSeries();
  const free = evaluatePolicyState({ series, parameters: activeStrategy, backtestSeries: series, executionCosts: { commissionBps: 0, slippageBps: 0 } });
  const costly = evaluatePolicyState({ series, parameters: activeStrategy, backtestSeries: series, executionCosts: { commissionBps: 1, slippageBps: 5 } });
  assert.ok(costly.latestBacktest.metrics.totalReturn < free.latestBacktest.metrics.totalReturn);
  assert.deepEqual(costly.latestBacktest.executionCosts, { commissionBps: 1, slippageBps: 5 });
});

test('parameter sweeps and shared policy state preserve volume-impact execution assumptions', () => {
  const values = Array.from({ length: 100 }, (_, index) => 100 + Math.sin(index * 0.83) * 8 + Math.sin(index * 0.19) * 3);
  const series = {
    period: 'HISTORICAL',
    labels: values.map((_, index) => `2025-Session-${index + 1}`),
    values,
    observations: values.map((close, index) => ({
      date: `2025-Session-${index + 1}`,
      close,
      rawClose: close,
      high: close * 1.02,
      low: close * 0.98,
      volume: 250_000 + (index % 7) * 100_000,
    })),
  };
  const executionCosts = { commissionBps: 2, slippageModel: 'volume-impact', impactCoefficient: 0.15 };
  const snapshot = JSON.stringify(series);
  const sweep = runParameterSweep(series, activeStrategy, [2], [6], executionCosts);
  const direct = calculateStrategyBacktest(series, { ...activeStrategy, shortWindow: 2, longWindow: 6 }, 100_000, executionCosts);
  const state = evaluatePolicyState({
    series,
    parameters: activeStrategy,
    backtestSeries: series,
    executionCosts,
  });

  assert.equal(direct.valid, true);
  assert.equal(sweep.length, 1);
  const normalizedCosts = { commissionBps: 2, slippageBps: 5, slippageModel: 'volume-impact', impactCoefficient: 0.15 };
  assert.deepEqual(sweep[0].executionCosts, normalizedCosts);
  assert.deepEqual(sweep[0].metrics, calculatePerformance(direct.equityCurve.slice(5)));
  assert.ok(direct.totalTransactionCostsUSD > 0);
  assert.deepEqual(state.currentBacktest.executionCosts, normalizedCosts);
  assert.deepEqual(state.latestBacktest.executionCosts, normalizedCosts);
  assert.ok(state.latestBacktest.totalTransactionCostsUSD > 0);
  assert.equal(JSON.stringify(series), snapshot);
});

test('single-asset cost sensitivity compares zero, configured, and stressed assumptions', () => {
  const series = risingSeries();
  const sensitivity = analyzeExecutionCostSensitivity(series, activeStrategy, 100_000, {
    commissionBps: 1,
    slippageBps: 5,
  });
  assert.equal(sensitivity.valid, true);
  assert.deepEqual(sensitivity.scenarios.map((scenario) => scenario.label), ['Zero costs', 'Configured', 'Stressed (2×)']);
  assert.ok(Math.abs(sensitivity.scenarios[0].netReturnPct - sensitivity.grossReturnPct) < 1e-10);
  assert.ok(sensitivity.scenarios[1].totalTransactionCostsUSD > 0);
  assert.ok(sensitivity.scenarios[2].totalTransactionCostsUSD > sensitivity.scenarios[1].totalTransactionCostsUSD);
  assert.ok(sensitivity.scenarios[0].netReturnPct > sensitivity.scenarios[1].netReturnPct);
  assert.ok(sensitivity.scenarios[1].netReturnPct > sensitivity.scenarios[2].netReturnPct);
});

test('single-asset volume-impact sensitivity doubles the coefficient without mutating OHLCV', () => {
  const values = Array.from({ length: 100 }, (_, index) => 100 + Math.sin(index * 0.83) * 8 + Math.sin(index * 0.19) * 3);
  const observations = values.map((close, index) => ({
    date: `2025-Session-${index + 1}`,
    close,
    rawClose: close,
    high: close * 1.02,
    low: close * 0.98,
    volume: 250_000 + (index % 7) * 100_000,
  }));
  const series = {
    values,
    labels: observations.map((observation) => observation.date),
    observations,
  };
  const snapshot = JSON.stringify(series);
  const sensitivity = analyzeExecutionCostSensitivity(series, activeStrategy, 100_000, {
    commissionBps: 1,
    slippageModel: 'volume-impact',
    impactCoefficient: 0.1,
  });
  assert.equal(sensitivity.valid, true);
  assert.equal(sensitivity.scenarios[2].executionCosts.impactCoefficient, 0.2);
  assert.ok(sensitivity.scenarios[2].totalTransactionCostsUSD > sensitivity.scenarios[1].totalTransactionCostsUSD);
  assert.equal(JSON.stringify(series), snapshot);
});
