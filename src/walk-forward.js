import { calculatePerformance } from './data.js';
import {
  calculateStrategyBacktest,
  DEFAULT_EXECUTION_COSTS,
  DEFAULT_STRATEGY,
} from './strategy-analysis.js';

function validSeries(series) {
  if (!Array.isArray(series?.values)
    || series.values.length <= 1
    || !series.values.every((value) => Number.isFinite(value) && value > 0)) return false;
  if (series.labels === undefined) return true;
  if (!Array.isArray(series.labels)
    || series.labels.length !== series.values.length
    || !series.labels.every((label) => typeof label === 'string' && label.trim().length > 0)
    || new Set(series.labels).size !== series.labels.length) return false;

  const calendarLabels = series.labels.every((label) => /^\d{4}-\d{2}-\d{2}$/.test(label));
  if (!calendarLabels) return true;
  return series.labels.every((label, index) => {
    const [year, month, day] = label.split('-').map(Number);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    const isValidDate = date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
    return isValidDate && (index === 0 || label > series.labels[index - 1]);
  });
}

function sliceSeries(series, start, end) {
  return {
    ...series,
    labels: Array.isArray(series.labels) ? series.labels.slice(start, end) : [],
    values: series.values.slice(start, end),
  };
}

function compoundReturns(returns, startingCapital) {
  const equity = [startingCapital];
  for (const dailyReturn of returns) equity.push(equity.at(-1) * (1 + dailyReturn));
  return equity;
}

function candidateConfigurations(baseParameters, shortWindows, longWindows) {
  const candidates = [];
  for (const shortWindow of shortWindows) {
    for (const longWindow of longWindows) {
      if (!Number.isInteger(shortWindow) || !Number.isInteger(longWindow) || shortWindow >= longWindow) continue;
      const parameters = {
        ...baseParameters,
        shortWindow,
        longWindow,
        lookback: Math.max(baseParameters.lookback ?? longWindow, longWindow),
      };
      candidates.push(parameters);
    }
  }
  return candidates;
}

/**
 * Rolling-origin walk-forward validation. Each fold selects parameters only
 * on its training window, then evaluates the selected parameters on the
 * immediately following, non-overlapping test window.
 */
export function runWalkForwardValidation(series, {
  trainWindow = 60,
  testWindow = 20,
  step = testWindow,
  shortWindows = [3, 5, 8],
  longWindows = [15, 20, 30],
  baseParameters = DEFAULT_STRATEGY,
  executionCosts = DEFAULT_EXECUTION_COSTS,
  startingCapital = 100_000,
  selectionMetric = 'sharpeRatio',
} = {}) {
  if (!validSeries(series)) {
    return { valid: false, error: 'A positive price series with at least two observations is required.', folds: [] };
  }
  if (!Number.isInteger(trainWindow) || trainWindow < 30
    || !Number.isInteger(testWindow) || testWindow < 5
    || !Number.isInteger(step) || step !== testWindow
    || !Number.isFinite(startingCapital) || startingCapital <= 0
    || !['sharpeRatio', 'totalReturn'].includes(selectionMetric)) {
    return { valid: false, error: 'Use a training window of at least 30, a test window of at least 5, a step equal to the test window, positive starting capital, and a supported selection metric.', folds: [] };
  }
  if (!Array.isArray(shortWindows) || !Array.isArray(longWindows) || !shortWindows.length || !longWindows.length) {
    return { valid: false, error: 'At least one short and one long moving-average candidate are required.', folds: [] };
  }
  const candidates = candidateConfigurations(baseParameters, shortWindows, longWindows);
  if (!candidates.length) return { valid: false, error: 'No valid short/long moving-average combinations were supplied.', folds: [] };

  const folds = [];
  const outOfSampleReturns = [];
  const benchmarkReturns = [];
  let strategyCapital = startingCapital;
  let previousOutOfSampleExposure = 0;
  let skippedFolds = 0;

  for (let trainStart = 0; trainStart + trainWindow + testWindow <= series.values.length; trainStart += step) {
    const trainEnd = trainStart + trainWindow;
    const testEnd = trainEnd + testWindow;
    const trainingSeries = sliceSeries(series, trainStart, trainEnd);
    let selected = null;

    for (const parameters of candidates) {
      const trainingBacktest = calculateStrategyBacktest(trainingSeries, parameters, startingCapital, executionCosts);
      if (!trainingBacktest.valid || !trainingBacktest.exposures.some((exposure) => exposure > 0)) continue;
      const score = trainingBacktest.metrics[selectionMetric];
      if (!Number.isFinite(score)) continue;
      if (!selected || score > selected.score) {
        selected = { parameters, score, trainingBacktest };
      }
    }

    if (!selected) {
      skippedFolds += 1;
      continue;
    }

    // Run the chosen policy over the available prefix so its indicators and
    // position at the train/test boundary are formed using only prior data.
    const availableSeries = sliceSeries(series, 0, testEnd);
    const forwardBacktest = calculateStrategyBacktest(availableSeries, selected.parameters, startingCapital, executionCosts);
    if (!forwardBacktest.valid) {
      skippedFolds += 1;
      continue;
    }

    const foldReturns = forwardBacktest.dailyReturns.slice(trainEnd, testEnd);
    const costRatePerUnitTurnover = (forwardBacktest.executionCosts.commissionBps + forwardBacktest.executionCosts.slippageBps) / 10_000;
    const firstTestExposure = (forwardBacktest.exposures[trainEnd - 1] ?? 0) / 100;
    const firstTestTurnover = Math.abs(firstTestExposure - previousOutOfSampleExposure);
    const firstTestCostRate = firstTestTurnover * costRatePerUnitTurnover;
    // A newly selected fold strategy must rebalance from the position actually
    // held at the end of the preceding OOS fold, not its own hypothetical history.
    foldReturns[0] = forwardBacktest.grossDailyReturns[trainEnd] - firstTestCostRate;
    const foldBenchmarkReturns = [];
    for (let index = trainEnd; index < testEnd; index += 1) {
      foldBenchmarkReturns.push(series.values[index] / series.values[index - 1] - 1);
    }
    const foldEquity = compoundReturns(foldReturns, startingCapital);
    const foldBenchmarkEquity = compoundReturns(foldBenchmarkReturns, startingCapital);
    // Scale test-window transaction costs to the actual stitched OOS
    // portfolio equity, not the separate full-prefix training backtest equity.
    let foldCosts = 0;
    let foldStrategyCapital = strategyCapital;
    for (let index = trainEnd; index < testEnd; index += 1) {
      const prefixEquity = forwardBacktest.equityCurve[index - 1] ?? startingCapital;
      const costFraction = index === trainEnd
        ? firstTestCostRate
        : prefixEquity > 0
          ? forwardBacktest.transactionCostsUSD[index] / prefixEquity
          : 0;
      foldCosts += foldStrategyCapital * costFraction;
      foldStrategyCapital *= 1 + foldReturns[index - trainEnd];
    }

    folds.push({
      number: folds.length + 1,
      trainStart: series.labels?.[trainStart] ?? `Observation ${trainStart + 1}`,
      trainEnd: series.labels?.[trainEnd - 1] ?? `Observation ${trainEnd}`,
      testStart: series.labels?.[trainEnd] ?? `Observation ${trainEnd + 1}`,
      testEnd: series.labels?.[testEnd - 1] ?? `Observation ${testEnd}`,
      trainObservations: trainWindow,
      testObservations: testWindow,
      selectedParameters: selected.parameters,
      trainingScore: selected.score,
      trainingReturn: selected.trainingBacktest.metrics.totalReturn,
      testMetrics: calculatePerformance(foldEquity),
      benchmarkMetrics: calculatePerformance(foldBenchmarkEquity),
      transactionCostsUSD: foldCosts,
    });

    for (const dailyReturn of foldReturns) {
      strategyCapital *= 1 + dailyReturn;
      outOfSampleReturns.push(dailyReturn);
    }
    for (const dailyReturn of foldBenchmarkReturns) {
      benchmarkReturns.push(dailyReturn);
    }
    previousOutOfSampleExposure = (forwardBacktest.exposures[testEnd - 2] ?? 0) / 100;
  }

  if (!folds.length) {
    return {
      valid: false,
      error: 'No walk-forward fold could be evaluated. Increase the available history or review the candidate windows.',
      folds: [],
      skippedFolds,
    };
  }

  const outOfSampleEquity = compoundReturns(outOfSampleReturns, startingCapital);
  const benchmarkEquity = compoundReturns(benchmarkReturns, startingCapital);
  return {
    valid: true,
    method: 'Rolling-origin walk-forward validation',
    selectionMetric,
    trainWindow,
    testWindow,
    step,
    candidateCount: candidates.length,
    folds,
    skippedFolds,
    outOfSampleObservations: outOfSampleReturns.length,
    outOfSampleReturns,
    outOfSampleEquity,
    benchmarkEquity,
    metrics: calculatePerformance(outOfSampleEquity),
    benchmarkMetrics: calculatePerformance(benchmarkEquity),
    totalTransactionCostsUSD: folds.reduce((sum, fold) => sum + fold.transactionCostsUSD, 0),
    executionCosts,
    caveats: [
      'Each fold selects parameters on its training window and evaluates only on the following test window.',
      'Walk-forward validation reduces look-ahead from full-sample parameter selection but does not eliminate overfitting or regime dependence.',
      'The first test-session position is determined by the selected policy signal from the prior training session.',
      'Results remain sensitive to the candidate grid, window sizes, execution-cost assumptions, and data quality.',
    ],
  };
}
