import { calculatePerformance } from './data.js';
import { DEFAULT_EXECUTION_COSTS, validateExecutionCosts } from './strategy-analysis.js';

function validateAssetSeries(symbol, series) {
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return `Invalid ticker symbol: ${symbol}.`;
  if (!Array.isArray(series?.labels) || !Array.isArray(series?.values)
    || series.labels.length !== series.values.length || series.values.length < 3) {
    return `${symbol} requires at least three dated price observations.`;
  }
  let previousDate = '';
  for (let index = 0; index < series.values.length; index += 1) {
    const date = series.labels[index];
    const value = series.values[index];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= previousDate) {
      return `${symbol} dates must be unique, ascending YYYY-MM-DD labels.`;
    }
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      return `${symbol} contains an invalid calendar date.`;
    }
    if (!Number.isFinite(value) || value <= 0) return `${symbol} prices must be finite and positive.`;
    previousDate = date;
  }
  return null;
}

function buildPriceMap(series) {
  return new Map(series.labels.map((date, index) => [date, { value: series.values[index], index }]));
}

function correlation(left, right) {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index] - leftMean;
    const y = right[index] - rightMean;
    covariance += x * y;
    leftVariance += x * x;
    rightVariance += y * y;
  }
  if (leftVariance < 1e-20 || rightVariance < 1e-20) return null;
  return Math.max(-1, Math.min(1, covariance / Math.sqrt(leftVariance * rightVariance)));
}

/**
 * Builds a date-aligned, equal-weight, daily-rebalanced portfolio from
 * historical price series. The buy-and-hold comparator starts with the same
 * equal allocations but allows weights to drift. No future observations are
 * used to form returns or weights.
 */
export function calculateDiversificationPortfolio(assetSeries, {
  startingCapital = 100_000,
  executionCosts = DEFAULT_EXECUTION_COSTS,
} = {}) {
  const symbols = Object.keys(assetSeries ?? {}).map((symbol) => symbol.trim().toUpperCase()).sort();
  const costValidation = validateExecutionCosts(executionCosts);
  const errors = [];
  if (symbols.length < 2) errors.push('Select at least two different assets for portfolio analysis.');
  if (symbols.length !== new Set(symbols).size) errors.push('Portfolio symbols must be unique.');
  if (!Number.isFinite(startingCapital) || startingCapital <= 0) errors.push('Starting capital must be greater than zero.');
  if (!costValidation.valid) errors.push(...costValidation.errors);
  for (const symbol of symbols) {
    const error = validateAssetSeries(symbol, assetSeries[symbol] ?? assetSeries[Object.keys(assetSeries).find((key) => key.toUpperCase() === symbol)]);
    if (error) errors.push(error);
  }
  if (errors.length) return { valid: false, errors, symbols, dates: [], correlations: [], metrics: null };

  const normalizedSeries = Object.fromEntries(symbols.map((symbol) => {
    const key = Object.keys(assetSeries).find((candidate) => candidate.toUpperCase() === symbol);
    return [symbol, assetSeries[key]];
  }));
  const priceMaps = Object.fromEntries(symbols.map((symbol) => [symbol, buildPriceMap(normalizedSeries[symbol])]));
  const commonPriceDates = [...priceMaps[symbols[0]].keys()]
    .filter((date) => symbols.every((symbol) => priceMaps[symbol].has(date)))
    .sort();
  const commonDates = [];
  const assetReturns = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  for (let index = 1; index < commonPriceDates.length; index += 1) {
    const previousDate = commonPriceDates[index - 1];
    const currentDate = commonPriceDates[index];
    const adjacentAcrossAllAssets = symbols.every((symbol) => (
      priceMaps[symbol].get(currentDate).index === priceMaps[symbol].get(previousDate).index + 1
    ));
    if (!adjacentAcrossAllAssets) continue;
    commonDates.push(currentDate);
    for (const symbol of symbols) {
      const previousPrice = priceMaps[symbol].get(previousDate).value;
      const currentPrice = priceMaps[symbol].get(currentDate).value;
      assetReturns[symbol].push(currentPrice / previousPrice - 1);
    }
  }
  if (commonDates.length < 2) {
    return { valid: false, errors: ['The selected assets need at least two consecutive, shared daily return observations.'], symbols, dates: commonDates, correlations: [], metrics: null };
  }
  const correlations = symbols.map((symbol) => ({
    symbol,
    values: symbols.map((other) => symbol === other ? 1 : correlation(assetReturns[symbol], assetReturns[other])),
  }));

  const targetWeight = 1 / symbols.length;
  let driftedWeights = symbols.map(() => targetWeight);
  let benchmarkWeights = symbols.map(() => targetWeight);
  let netEquity = startingCapital;
  let grossEquity = startingCapital;
  let benchmarkEquity = startingCapital;
  let totalTurnover = 0;
  let totalTransactionCostsUSD = 0;
  const turnover = [];
  const transactionCostsUSD = [];
  const dailyReturns = [];
  const grossDailyReturns = [];
  const benchmarkDailyReturns = [];
  const equityCurve = [startingCapital];
  const grossEquityCurve = [startingCapital];
  const benchmarkEquityCurve = [startingCapital];
  const costRate = (costValidation.config.commissionBps + costValidation.config.slippageBps) / 10_000;

  commonDates.forEach((date, dateIndex) => {
    const returns = symbols.map((symbol) => assetReturns[symbol][dateIndex]);
    const grossReturn = returns.reduce((sum, value) => sum + value * targetWeight, 0);
    const benchmarkReturn = returns.reduce((sum, value, index) => sum + value * benchmarkWeights[index], 0);
    const sessionTurnover = dateIndex === 0
      ? 1
      : 0.5 * driftedWeights.reduce((sum, weight) => sum + Math.abs(targetWeight - weight), 0);
    const sessionCostRate = sessionTurnover * costRate;
    const costAmount = netEquity * sessionCostRate;
    const netReturn = grossReturn - sessionCostRate;

    netEquity *= 1 + netReturn;
    grossEquity *= 1 + grossReturn;
    benchmarkEquity *= 1 + benchmarkReturn;
    totalTurnover += sessionTurnover;
    totalTransactionCostsUSD += costAmount;
    turnover.push(sessionTurnover);
    transactionCostsUSD.push(costAmount);
    dailyReturns.push(netReturn);
    grossDailyReturns.push(grossReturn);
    benchmarkDailyReturns.push(benchmarkReturn);
    equityCurve.push(netEquity);
    grossEquityCurve.push(grossEquity);
    benchmarkEquityCurve.push(benchmarkEquity);

    const grossGrowth = 1 + grossReturn;
    driftedWeights = returns.map((value) => targetWeight * (1 + value) / grossGrowth);
    const benchmarkGrowth = 1 + benchmarkReturn;
    benchmarkWeights = returns.map((value, index) => benchmarkWeights[index] * (1 + value) / benchmarkGrowth);
  });

  const assetPerformance = symbols.map((symbol) => {
    const equity = [startingCapital];
    for (const dailyReturn of assetReturns[symbol]) equity.push(equity.at(-1) * (1 + dailyReturn));
    return {
      symbol,
      metrics: calculatePerformance(equity),
      averageDailyContribution: assetReturns[symbol].reduce((sum, value) => sum + value * targetWeight, 0) / commonDates.length * 100,
    };
  });

  return {
    valid: true,
    errors: [],
    method: 'Equal-weight daily rebalancing',
    symbols,
    dates: commonDates,
    observations: commonDates.length,
    correlations,
    assetReturns,
    assetPerformance,
    dailyReturns,
    grossDailyReturns,
    benchmarkDailyReturns,
    equityCurve,
    grossEquityCurve,
    benchmarkEquityCurve,
    metrics: calculatePerformance(equityCurve),
    grossMetrics: calculatePerformance(grossEquityCurve),
    benchmarkMetrics: calculatePerformance(benchmarkEquityCurve),
    turnover,
    totalTurnover,
    transactionCostsUSD,
    totalTransactionCostsUSD,
    tradeCount: turnover.filter((value) => value > 0).length,
    executionCosts: costValidation.config,
    startingCapital,
    caveats: [
      'Only dates with a daily return for every selected asset are included.',
      'The equal-weight portfolio is rebalanced at the start of each observed session; turnover costs are illustrative basis-point estimates.',
      'The buy-and-hold comparator starts with equal allocations and lets weights drift; it excludes transaction costs.',
      'Historical prices use the selected raw or provider-adjusted basis. Results do not include taxes, market impact, or partial fills.',
      'Correlation is a historical sample statistic and may change materially across market regimes.',
    ],
  };
}
