import { calculatePerformance } from './data.js';

function pearsonCorrelation(first, second) {
  const length = Math.min(first.length, second.length);
  if (length < 2) return null;
  const firstMean = first.reduce((sum, value) => sum + value, 0) / length;
  const secondMean = second.reduce((sum, value) => sum + value, 0) / length;
  let covariance = 0;
  let firstVariance = 0;
  let secondVariance = 0;
  for (let index = 0; index < length; index += 1) {
    const a = first[index] - firstMean;
    const b = second[index] - secondMean;
    covariance += a * b;
    firstVariance += a * a;
    secondVariance += b * b;
  }
  const denominator = Math.sqrt(firstVariance * secondVariance);
  return denominator > 0 ? covariance / denominator : null;
}

/**
 * Builds an equal-weight, buy-and-hold portfolio from aligned historical
 * price series. Initial weights are fixed; constituent weights drift naturally
 * as prices move. This avoids silently assuming daily rebalancing.
 */
export function analyzeEqualWeightPortfolio(seriesList, {
  startingCapital = 100_000,
  minimumObservations = 20,
  maximumAssets = 5,
} = {}) {
  if (!Array.isArray(seriesList) || seriesList.length < 2 || seriesList.length > maximumAssets) {
    return { valid: false, error: `Select between 2 and ${maximumAssets} assets for portfolio analysis.` };
  }
  if (!Number.isFinite(startingCapital) || startingCapital <= 0
    || !Number.isInteger(minimumObservations) || minimumObservations < 2) {
    return { valid: false, error: 'Starting capital and minimum observation settings are invalid.' };
  }
  const symbols = seriesList.map((series) => String(series?.symbol ?? '').trim().toUpperCase());
  if (symbols.some((symbol) => !symbol) || new Set(symbols).size !== symbols.length) {
    return { valid: false, error: 'Each portfolio asset must have a unique ticker symbol.' };
  }
  for (const series of seriesList) {
    if (!Array.isArray(series?.labels) || !Array.isArray(series?.values)
      || series.labels.length !== series.values.length || series.values.length < minimumObservations
      || series.values.some((value) => !Number.isFinite(value) || value <= 0)
      || series.labels.some((label, index) => typeof label !== 'string' || (index > 0 && label <= series.labels[index - 1]))) {
      return { valid: false, error: `The historical series for ${series?.symbol ?? 'an asset'} is invalid or too short.` };
    }
  }

  const maps = seriesList.map((series) => new Map(series.labels.map((date, index) => [date, series.values[index]])));
  const dates = seriesList[0].labels.filter((date) => maps.every((map) => map.has(date)));
  if (dates.length < minimumObservations) {
    return { valid: false, error: `Only ${dates.length} common dates are available; at least ${minimumObservations} are required.` };
  }

  const alignedPrices = maps.map((map) => dates.map((date) => map.get(date)));
  const assetReturns = alignedPrices.map((prices) => prices.slice(1).map((price, index) => price / prices[index] - 1));
  const weight = 1 / seriesList.length;
  const equityCurve = dates.map((dateIndex, index) => startingCapital * alignedPrices.reduce(
    (sum, prices) => sum + weight * (prices[index] / prices[0]),
    0,
  ));
  const metrics = calculatePerformance(equityCurve);
  const assetMetrics = seriesList.map((series, index) => ({
    symbol: symbols[index],
    weight: weight * 100,
    metrics: calculatePerformance(alignedPrices[index].map((price) => startingCapital * price / alignedPrices[index][0])),
  }));
  const correlationMatrix = symbols.map((symbol, row) => ({
    symbol,
    correlations: symbols.map((other, column) => ({
      symbol: other,
      value: row === column ? 1 : pearsonCorrelation(assetReturns[row], assetReturns[column]),
    })),
  }));
  const pairwiseCorrelations = [];
  for (let row = 0; row < symbols.length; row += 1) {
    for (let column = row + 1; column < symbols.length; column += 1) {
      const value = correlationMatrix[row].correlations[column].value;
      if (Number.isFinite(value)) pairwiseCorrelations.push(value);
    }
  }
  const averagePairwiseCorrelation = pairwiseCorrelations.length
    ? pairwiseCorrelations.reduce((sum, value) => sum + value, 0) / pairwiseCorrelations.length
    : null;

  return {
    valid: true,
    method: 'Equal-weight buy-and-hold',
    weighting: 'Equal initial weights; constituent weights drift with relative performance.',
    symbols,
    weights: Object.fromEntries(symbols.map((symbol) => [symbol, weight])),
    observations: dates.length,
    startDate: dates[0],
    endDate: dates.at(-1),
    dates,
    startingCapital,
    equityCurve,
    metrics,
    assetMetrics,
    correlationMatrix,
    averagePairwiseCorrelation,
    outperformanceVsEqualWeightVolatility: null,
    executionCostsApplied: false,
    caveats: [
      'This is an equal-weight buy-and-hold portfolio: weights are set at inception and drift; there is no periodic rebalancing.',
      'Correlation is calculated from aligned daily close-to-close returns over the common date range.',
      'Transaction costs, taxes, bid-ask spread, liquidity, and market impact are not included.',
      'Historical adjusted-close inputs are only as complete as the provider data and are not a guaranteed dividend-reinvestment total-return series.',
    ],
  };
}
