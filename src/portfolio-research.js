function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isValidAssetSeries(asset) {
  const series = asset?.series;
  return typeof asset?.symbol === 'string'
    && asset.symbol.trim().length > 0
    && Array.isArray(series?.labels)
    && Array.isArray(series?.values)
    && series.labels.length === series.values.length
    && series.values.length >= 3
    && series.values.every((value) => Number.isFinite(value) && value > 0)
    && series.labels.every((date, index) => isValidCalendarDate(date)
      && (index === 0 || date > series.labels[index - 1]));
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function annualizedRiskStats(returns, dates) {
  const intervalYears = dates.slice(1).map((date, index) => (
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dates[index]}T00:00:00Z`)) / 86_400_000 / 365.25
  ));
  const logReturns = returns.map((value) => Math.log1p(value));
  const elapsedYears = intervalYears.reduce((sum, value) => sum + value, 0);
  const annualizedLogDrift = logReturns.reduce((sum, value) => sum + value, 0) / elapsedYears;
  const residuals = logReturns.map((value, index) => value - annualizedLogDrift * intervalYears[index]);
  const residualSquares = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const logReturnSquares = logReturns.reduce((sum, value) => sum + value ** 2, 0);
  const varianceRate = residualSquares <= Number.EPSILON * Math.max(logReturnSquares, Number.MIN_VALUE)
    ? 0
    : residualSquares / elapsedYears;
  const annualizedVolatility = Math.sqrt(varianceRate);
  return {
    annualizedVolatility,
    sharpeRatio: annualizedVolatility > 0 ? annualizedLogDrift / annualizedVolatility : null,
  };
}

function maximumDrawdown(equity) {
  let peak = equity[0];
  let maximum = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    maximum = Math.min(maximum, value / peak - 1);
  }
  return maximum * 100;
}

function correlation(first, second) {
  const firstMean = mean(first);
  const secondMean = mean(second);
  const firstStd = sampleStandardDeviation(first);
  const secondStd = sampleStandardDeviation(second);
  if (firstStd === 0 || secondStd === 0) return null;
  const covariance = first.reduce((sum, value, index) => sum + (value - firstMean) * (second[index] - secondMean), 0) / (first.length - 1);
  const estimate = covariance / (firstStd * secondStd);
  if (Math.abs(estimate) >= 1 - 1e-12) return Math.sign(estimate);
  return Math.max(-1, Math.min(1, estimate));
}

/**
 * Builds an educational, observation-rebalanced equal-weight portfolio from saved
 * historical price series. Dates are inner-joined before interval returns are computed.
 * This is a research baseline, not an order-level execution simulation.
 */
export function analyzeEqualWeightPortfolio(assets, { startingCapital = 100_000 } = {}) {
  if (!Array.isArray(assets) || assets.length < 2 || assets.length > 10) {
    return { valid: false, error: 'Select between 2 and 10 distinct historical assets.', assets: [] };
  }
  if (!Number.isFinite(startingCapital) || startingCapital <= 0) {
    return { valid: false, error: 'Starting capital must be a positive finite number.', assets: [] };
  }
  if (!assets.every(isValidAssetSeries)) {
    return { valid: false, error: 'Each asset needs at least three positive prices with unique ascending valid ISO calendar dates.', assets: [] };
  }

  const symbols = assets.map((asset) => asset.symbol.trim().toUpperCase());
  if (new Set(symbols).size !== symbols.length) {
    return { valid: false, error: 'Each ticker may appear only once in a portfolio analysis.', assets: [] };
  }
  const priceBases = new Set(assets.map((asset) => asset.series.priceBasis ?? asset.series.adjustment ?? 'raw'));
  if (priceBases.size !== 1) {
    return { valid: false, error: 'All assets must use the same price basis (raw or adjusted).', assets: [] };
  }

  const priceMaps = assets.map((asset) => new Map(asset.series.labels.map((date, index) => [date, asset.series.values[index]])));
  const commonDates = assets[0].series.labels.filter((date) => priceMaps.every((prices) => prices.has(date)));
  if (commonDates.length < 3) {
    return { valid: false, error: 'At least three shared trading dates are required across the selected assets.', assets: [] };
  }

  const assetReturns = assets.map((asset, assetIndex) => {
    const prices = priceMaps[assetIndex];
    return commonDates.slice(1).map((date, index) => prices.get(date) / prices.get(commonDates[index]) - 1);
  });
  const portfolioReturns = commonDates.slice(1).map((_, index) => mean(assetReturns.map((returns) => returns[index])));
  const equityCurve = [startingCapital];
  for (const intervalReturn of portfolioReturns) equityCurve.push(equityCurve.at(-1) * (1 + intervalReturn));

  if (!assetReturns.every((returns) => returns.every(Number.isFinite))
    || !portfolioReturns.every(Number.isFinite)
    || !equityCurve.every(Number.isFinite)) {
    return { valid: false, error: 'The selected price range produces non-finite returns or portfolio values; choose a less extreme data range.', assets: [] };
  }

  const elapsedCalendarDays = (Date.parse(`${commonDates.at(-1)}T00:00:00Z`) - Date.parse(`${commonDates[0]}T00:00:00Z`)) / 86_400_000;
  const elapsedYears = elapsedCalendarDays / 365.25;
  const annualizationPeriodsPerYear = portfolioReturns.length / elapsedYears;
  const portfolioRisk = annualizedRiskStats(portfolioReturns, commonDates);

  const assetStats = assets.map((asset, index) => {
    const returns = assetReturns[index];
    const averageReturn = mean(returns);
    const volatility = annualizedRiskStats(returns, commonDates).annualizedVolatility * 100;
    const totalReturnPct = (priceMaps[index].get(commonDates.at(-1)) / priceMaps[index].get(commonDates[0]) - 1) * 100;
    const annualizedReturnPct = ((priceMaps[index].get(commonDates.at(-1)) / priceMaps[index].get(commonDates[0])) ** (1 / elapsedYears) - 1) * 100;
    return {
      symbol: symbols[index],
      weightPct: 100 / assets.length,
      totalReturnPct,
      annualizedReturnPct,
      annualizedVolatilityPct: volatility,
      meanIntervalReturnPct: averageReturn * 100,
    };
  });
  const averageAssetVolatilityPct = mean(assetStats.map((asset) => asset.annualizedVolatilityPct));
  const portfolioMean = mean(portfolioReturns);
  const portfolioVolatilityPerInterval = sampleStandardDeviation(portfolioReturns);
  const annualizedVolatilityPct = portfolioRisk.annualizedVolatility * 100;
  const totalReturnPct = (equityCurve.at(-1) / startingCapital - 1) * 100;
  const annualizedReturnPct = ((equityCurve.at(-1) / startingCapital) ** (1 / elapsedYears) - 1) * 100;
  const sharpeRatio = portfolioRisk.sharpeRatio;
  const correlationMatrix = symbols.map((symbol, row) => ({
    symbol,
    values: symbols.map((_, column) => correlation(assetReturns[row], assetReturns[column])),
  }));

  const finiteMetrics = [
    totalReturnPct,
    annualizedReturnPct,
    annualizedVolatilityPct,
    annualizationPeriodsPerYear,
    maximumDrawdown(equityCurve),
    averageAssetVolatilityPct,
    ...assetStats.flatMap((asset) => [
      asset.totalReturnPct,
      asset.annualizedReturnPct,
      asset.annualizedVolatilityPct,
      asset.meanIntervalReturnPct,
    ]),
  ];
  if (!finiteMetrics.every(Number.isFinite)
    || !correlationMatrix.every((row) => row.values.every((value) => value === null || Number.isFinite(value)))) {
    return { valid: false, error: 'The selected price range produces non-finite portfolio statistics; choose a less extreme data range.', assets: [] };
  }

  return {
    valid: true,
    method: 'Observation-rebalanced equal-weight portfolio',
    symbols,
    priceBasis: [...priceBases][0],
    weights: Object.fromEntries(symbols.map((symbol) => [symbol, 1 / assets.length])),
    commonDates,
    observations: commonDates.length,
    returnObservations: portfolioReturns.length,
    startingCapital,
    equityCurve,
    intervalReturns: portfolioReturns,
    assetStats,
    correlationMatrix,
    metrics: {
      totalReturnPct,
      annualizedReturnPct,
      annualizedVolatilityPct,
      annualizationPeriodsPerYear,
      sharpeRatio,
      maxDrawdownPct: maximumDrawdown(equityCurve),
      averageAssetVolatilityPct,
      diversificationBenefitPct: averageAssetVolatilityPct > 0
        ? (averageAssetVolatilityPct - annualizedVolatilityPct) / averageAssetVolatilityPct * 100
        : null,
    },
    caveats: [
      'The portfolio is rebalanced to equal weights at every shared observation; returns therefore span consecutive shared dates and may cover more than one market session.',
      'Annualized return uses elapsed calendar time. Annualized volatility and zero-risk-free-rate Sharpe use a time-aware log-return diffusion estimator: each interval is weighted by its actual elapsed calendar duration.',
      'The time-aware risk estimator assumes log-return variance accumulates proportionally with calendar time; it is a descriptive model, not a forecast, and sparse or irregular observations can still produce unstable estimates.',
      'The analysis uses only dates shared by every selected asset and may exclude valid observations outside the common window.',
      'Commissions, slippage, taxes, market impact, liquidity, cash drag, and execution delays are not modeled.',
      'Historical adjusted closes account for provider adjustment methodology, but do not by themselves reconstruct an order-level dividend-reinvestment process.',
      'Maximum drawdown is measured only at the available shared closing-price observations and can miss larger intraperiod drawdowns.',
      'Correlation is undefined when either asset has zero return volatility and is displayed as unavailable.',
      'Annualized statistics are descriptive and can be unstable on short samples; correlation can change across market regimes.',
    ],
  };
}
