function isPriceSeries(series) {
  return Array.isArray(series?.values)
    && series.values.length >= 2
    && series.values.every((value) => Number.isFinite(value) && value > 0);
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function seededRandom(seed) {
  let state = (Math.trunc(seed) >>> 0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function dateAt(series, index) {
  return Array.isArray(series.labels) && series.labels[index] ? series.labels[index] : `Observation ${index + 1}`;
}

/**
 * Classifies each completed rolling window using trailing returns and realized volatility.
 * Thresholds are explicit heuristics, not fitted or predictive labels.
 */
export function detectMarketRegimes(series, {
  window = 20,
  trendThreshold = 0.04,
  lowVolatility = 0.15,
  highVolatility = 0.30,
} = {}) {
  if (!isPriceSeries(series)) return { valid: false, error: 'A positive price series with at least two observations is required.', regimes: [], latest: null };
  if (!Number.isInteger(window) || window < 5 || window > 252
    || !Number.isFinite(trendThreshold) || trendThreshold <= 0 || trendThreshold >= 1
    || !Number.isFinite(lowVolatility) || !Number.isFinite(highVolatility)
    || lowVolatility < 0 || highVolatility <= lowVolatility) {
    return { valid: false, error: 'Regime window and thresholds are outside supported ranges.', regimes: [], latest: null };
  }

  const regimes = series.values.map((price, index) => {
    if (index < window) return { index, date: dateAt(series, index), ready: false, direction: 'INSUFFICIENT DATA', volatility: null, volatilityLevel: null, label: 'Insufficient data' };
    const start = index - window;
    const windowReturn = price / series.values[start] - 1;
    const returns = [];
    for (let cursor = start + 1; cursor <= index; cursor += 1) returns.push(series.values[cursor] / series.values[cursor - 1] - 1);
    const volatility = sampleStandardDeviation(returns) * Math.sqrt(252);
    const direction = windowReturn >= trendThreshold ? 'UPTREND'
      : windowReturn <= -trendThreshold ? 'DOWNTREND' : 'SIDEWAYS';
    const volatilityLevel = volatility < lowVolatility ? 'LOW'
      : volatility >= highVolatility ? 'HIGH' : 'MODERATE';
    return {
      index,
      date: dateAt(series, index),
      ready: true,
      windowReturn: windowReturn * 100,
      volatility: volatility * 100,
      direction,
      volatilityLevel,
      label: `${direction === 'UPTREND' ? 'Uptrend' : direction === 'DOWNTREND' ? 'Downtrend' : 'Sideways'} / ${volatilityLevel.toLowerCase()} volatility`,
    };
  });
  return { valid: true, window, regimes, latest: [...regimes].reverse().find((item) => item.ready) ?? null };
}

/**
 * Explains a completed long/flat backtest. Effective exposure is lagged one
 * observation because the strategy engine executes close-derived signals next session.
 */
export function analyzeStrategyBacktest(series, backtest) {
  if (!isPriceSeries(series) || !backtest?.valid || !Array.isArray(backtest.equityCurve)
    || !Array.isArray(backtest.dailyReturns) || !Array.isArray(backtest.exposures)
    || !backtest.dailyReturns.every(Number.isFinite)
    || !backtest.equityCurve.every((value) => Number.isFinite(value) && value > 0)
    || backtest.equityCurve.length !== series.values.length
    || backtest.dailyReturns.length !== series.values.length
    || backtest.exposures.length !== series.values.length) {
    return { valid: false, error: 'A valid backtest aligned to the supplied price series is required.' };
  }

  const effectiveExposures = backtest.exposures.map((_, index) => index === 0 ? 0 : backtest.exposures[index - 1]);
  const entries = [];
  const exits = [];
  let previous = 0;
  const sessions = backtest.dailyReturns.map((dailyReturn, index) => {
    const exposure = effectiveExposures[index];
    if (previous === 0 && exposure > 0) entries.push({ index, date: dateAt(series, index), exposure });
    if (previous > 0 && exposure === 0) exits.push({ index, date: dateAt(series, index) });
    previous = exposure;
    return { index, date: dateAt(series, index), returnPct: dailyReturn * 100, exposure, contributionPct: dailyReturn * 100 };
  });
  const activeSessions = effectiveExposures.filter((exposure) => exposure > 0).length;
  const bestSession = sessions.reduce((best, item) => item.returnPct > best.returnPct ? item : best, sessions[0]);
  const worstSession = sessions.reduce((worst, item) => item.returnPct < worst.returnPct ? item : worst, sessions[0]);
  const strategyReturn = (backtest.equityCurve.at(-1) / backtest.equityCurve[0] - 1) * 100;
  const buyAndHoldReturn = (series.values.at(-1) / series.values[0] - 1) * 100;
  const strategyReturns = backtest.dailyReturns.slice(1);
  const benchmarkReturns = series.values.slice(1).map((price, index) => price / series.values[index] - 1);
  const activeReturns = strategyReturns.map((value, index) => value - benchmarkReturns[index]);
  const strategyMean = mean(strategyReturns);
  const benchmarkMean = mean(benchmarkReturns);
  const activeMean = mean(activeReturns);
  const benchmarkVariance = benchmarkReturns.reduce((sum, value) => sum + (value - benchmarkMean) ** 2, 0) / Math.max(1, benchmarkReturns.length - 1);
  const strategyVariance = strategyReturns.reduce((sum, value) => sum + (value - strategyMean) ** 2, 0) / Math.max(1, strategyReturns.length - 1);
  const activeVariance = activeReturns.reduce((sum, value) => sum + (value - activeMean) ** 2, 0) / Math.max(1, activeReturns.length - 1);
  const covariance = strategyReturns.reduce((sum, value, index) => sum + (value - strategyMean) * (benchmarkReturns[index] - benchmarkMean), 0) / Math.max(1, strategyReturns.length - 1);
  const benchmarkStandardDeviation = Math.sqrt(benchmarkVariance);
  const strategyStandardDeviation = Math.sqrt(strategyVariance);
  const trackingError = Math.sqrt(activeVariance) * Math.sqrt(252) * 100;
  const beta = benchmarkVariance > 1e-16 ? covariance / benchmarkVariance : null;
  const correlation = benchmarkStandardDeviation > 1e-12 && strategyStandardDeviation > 1e-12
    ? covariance / (benchmarkStandardDeviation * strategyStandardDeviation)
    : null;
  const alphaDaily = beta === null ? null : strategyMean - beta * benchmarkMean;
  const benchmarkDiagnostics = {
    valid: benchmarkVariance > 1e-16 && strategyReturns.length >= 2,
    benchmark: 'Buy and hold of the selected price series',
    observations: strategyReturns.length,
    riskFreeRateAnnualPct: 0,
    beta,
    correlation,
    annualizedAlphaPct: alphaDaily === null ? null : alphaDaily * 252 * 100,
    trackingErrorPct: trackingError,
    informationRatio: trackingError > 1e-12 ? activeMean * 252 / (trackingError / 100) : null,
    activeReturnPct: strategyReturn - buyAndHoldReturn,
    meanDailyActiveReturnPct: activeMean * 100,
  };
  const downsideSquares = strategyReturns.map((value) => Math.min(value, 0) ** 2);
  const downsideDeviationDaily = Math.sqrt(downsideSquares.reduce((sum, value) => sum + value, 0) / Math.max(1, downsideSquares.length));
  const downsideDeviationPct = downsideDeviationDaily * Math.sqrt(252) * 100;
  const annualizedReturnPct = strategyReturns.length
    ? ((backtest.equityCurve.at(-1) / backtest.equityCurve[0]) ** (252 / strategyReturns.length) - 1) * 100
    : null;
  const maximumDrawdownPct = Math.abs(backtest.metrics?.maxDrawdown ?? 0);
  const sortinoRatio = downsideDeviationDaily > 1e-12
    ? strategyMean / downsideDeviationDaily * Math.sqrt(252)
    : null;
  const calmarRatio = maximumDrawdownPct > 1e-12 && Number.isFinite(annualizedReturnPct)
    ? annualizedReturnPct / maximumDrawdownPct
    : null;
  let runningPeak = backtest.equityCurve[0];
  let currentDrawdownDuration = 0;
  let maxDrawdownDurationSessions = 0;
  for (const equity of backtest.equityCurve) {
    runningPeak = Math.max(runningPeak, equity);
    if (equity < runningPeak) {
      currentDrawdownDuration += 1;
      maxDrawdownDurationSessions = Math.max(maxDrawdownDurationSessions, currentDrawdownDuration);
    } else {
      currentDrawdownDuration = 0;
    }
  }
  const grossPositiveContribution = sessions.filter((item) => item.contributionPct > 0).reduce((sum, item) => sum + item.contributionPct, 0);
  const grossNegativeContribution = sessions.filter((item) => item.contributionPct < 0).reduce((sum, item) => sum + item.contributionPct, 0);

  return {
    valid: true,
    strategyReturn,
    buyAndHoldReturn,
    relativeReturn: strategyReturn - buyAndHoldReturn,
    benchmarkDiagnostics,
    downsideRisk: {
      targetDailyReturnPct: 0,
      downsideDeviationPct,
      sortinoRatio,
      annualizedReturnPct,
      calmarRatio,
      maxDrawdownDurationSessions,
    },
    activeSessions,
    totalSessions: sessions.length,
    timeInvestedPct: activeSessions / sessions.length * 100,
    entryCount: entries.length,
    exitCount: exits.length,
    entries,
    exits,
    bestSession,
    worstSession,
    grossPositiveContribution,
    grossNegativeContribution,
    effectiveExposures,
    caveats: [
      'Exposure is shifted one session to match next-session execution in the backtest engine.',
      'Return attribution is arithmetic daily contribution, not a compounded decomposition.',
      'Beta and alpha use daily arithmetic returns, a zero risk-free-rate assumption, and an in-sample linear regression; they are descriptive estimates, not forecasts.',
      'Sortino uses a 0% daily target; Calmar annualizes the sample return using 252 sessions and divides by absolute maximum drawdown. Both can be unstable on short samples.',
      'Fees, slippage, liquidity, dividends, and corporate actions are not included unless represented in the input data and engine.',
    ],
  };
}

/**
 * Exploratory one-sided-direction grouping with a two-sided permutation p-value.
 * Groups next-session returns by whether the preceding lookback return was positive.
 * This is a research diagnostic, not a causal test or a trading signal.
 */
export function testMomentumHypothesis(series, {
  lookback = 5,
  permutations = 999,
  seed = 2026,
  blockLength = 5,
} = {}) {
  if (!isPriceSeries(series)) return { valid: false, error: 'A positive price series with at least two observations is required.' };
  if (!Number.isInteger(lookback) || lookback < 2 || lookback > 60
    || !Number.isInteger(permutations) || permutations < 99 || permutations > 9999
    || !Number.isInteger(seed) || !Number.isInteger(blockLength) || blockLength < 2 || blockLength > 20) {
    return { valid: false, error: 'Use a 2-60 session lookback, 99-9,999 permutations, an integer seed, and a 2-20 session block length.' };
  }

  const observations = [];
  for (let index = lookback; index < series.values.length - 1; index += 1) {
    const priorReturn = series.values[index] / series.values[index - lookback] - 1;
    const nextReturn = series.values[index + 1] / series.values[index] - 1;
    observations.push({ nextReturn, positive: priorReturn > 0 });
  }
  const positiveMomentum = observations.filter((item) => item.positive).map((item) => item.nextReturn);
  const nonPositiveMomentum = observations.filter((item) => !item.positive).map((item) => item.nextReturn);
  if (positiveMomentum.length < 5 || nonPositiveMomentum.length < 5) {
    return { valid: false, error: 'At least five observations in each momentum group are required.', positiveCount: positiveMomentum.length, nonPositiveCount: nonPositiveMomentum.length };
  }
  if (blockLength >= observations.length) {
    return { valid: false, error: 'Block length must be shorter than the available observation count.' };
  }

  const orderedReturns = observations.map((item) => item.nextReturn);
  const positiveMask = observations.map((item) => item.positive);
  const observedDifference = mean(positiveMomentum) - mean(nonPositiveMomentum);
  const blocks = [];
  for (let index = 0; index < orderedReturns.length; index += blockLength) {
    blocks.push(orderedReturns.slice(index, index + blockLength));
  }
  const random = seededRandom(seed);
  let extreme = 0;
  for (let iteration = 0; iteration < permutations; iteration += 1) {
    const shuffledBlocks = [...blocks];
    for (let index = shuffledBlocks.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffledBlocks[index], shuffledBlocks[swapIndex]] = [shuffledBlocks[swapIndex], shuffledBlocks[index]];
    }
    const shuffledReturns = shuffledBlocks.flat();
    let positiveSum = 0;
    let nonPositiveSum = 0;
    for (let index = 0; index < positiveMask.length; index += 1) {
      if (positiveMask[index]) positiveSum += shuffledReturns[index];
      else nonPositiveSum += shuffledReturns[index];
    }
    const permutedDifference = positiveSum / positiveMomentum.length - nonPositiveSum / nonPositiveMomentum.length;
    if (Math.abs(permutedDifference) >= Math.abs(observedDifference)) extreme += 1;
  }
  return {
    valid: true,
    method: 'Contiguous block permutation test',
    lookback,
    blockLength,
    permutations,
    positiveCount: positiveMomentum.length,
    nonPositiveCount: nonPositiveMomentum.length,
    positiveGroupMeanPct: mean(positiveMomentum) * 100,
    nonPositiveGroupMeanPct: mean(nonPositiveMomentum) * 100,
    differencePct: observedDifference * 100,
    pValue: (extreme + 1) / (permutations + 1),
    seed,
    interpretation: 'Exploratory association only. Block shuffling retains some local return dependence, but does not establish causation, persistence, or future profitability.',
  };
}

export function buildResearchIntelligenceReport(series, backtest, options = {}) {
  const regimes = detectMarketRegimes(series, options.regime);
  const autopsy = analyzeStrategyBacktest(series, backtest);
  const hypothesis = testMomentumHypothesis(series, options.hypothesis);
  return { regimes, autopsy, hypothesis };
}
