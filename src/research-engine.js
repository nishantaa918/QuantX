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
  const grossPositiveContribution = sessions.filter((item) => item.contributionPct > 0).reduce((sum, item) => sum + item.contributionPct, 0);
  const grossNegativeContribution = sessions.filter((item) => item.contributionPct < 0).reduce((sum, item) => sum + item.contributionPct, 0);

  return {
    valid: true,
    strategyReturn,
    buyAndHoldReturn,
    relativeReturn: strategyReturn - buyAndHoldReturn,
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
} = {}) {
  if (!isPriceSeries(series)) return { valid: false, error: 'A positive price series with at least two observations is required.' };
  if (!Number.isInteger(lookback) || lookback < 2 || lookback > 60
    || !Number.isInteger(permutations) || permutations < 99 || permutations > 9999
    || !Number.isInteger(seed)) {
    return { valid: false, error: 'Use a 2-60 session lookback, 99-9,999 permutations, and an integer seed.' };
  }

  const positiveMomentum = [];
  const nonPositiveMomentum = [];
  for (let index = lookback; index < series.values.length - 0; index += 1) {
    if (index >= series.values.length - 1) break;
    const priorReturn = series.values[index] / series.values[index - lookback] - 1;
    const nextReturn = series.values[index + 1] / series.values[index] - 1;
    (priorReturn > 0 ? positiveMomentum : nonPositiveMomentum).push(nextReturn);
  }
  if (positiveMomentum.length < 5 || nonPositiveMomentum.length < 5) {
    return { valid: false, error: 'At least five observations in each momentum group are required.', positiveCount: positiveMomentum.length, nonPositiveCount: nonPositiveMomentum.length };
  }

  const allReturns = [...positiveMomentum, ...nonPositiveMomentum];
  const observedDifference = mean(positiveMomentum) - mean(nonPositiveMomentum);
  const random = seededRandom(seed);
  let extreme = 0;
  const positiveCount = positiveMomentum.length;
  for (let iteration = 0; iteration < permutations; iteration += 1) {
    const shuffled = [...allReturns];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    const permutedDifference = mean(shuffled.slice(0, positiveCount)) - mean(shuffled.slice(positiveCount));
    if (Math.abs(permutedDifference) >= Math.abs(observedDifference)) extreme += 1;
  }
  return {
    valid: true,
    method: 'Two-sided permutation test',
    lookback,
    permutations,
    positiveCount,
    nonPositiveCount: nonPositiveMomentum.length,
    positiveGroupMeanPct: mean(positiveMomentum) * 100,
    nonPositiveGroupMeanPct: mean(nonPositiveMomentum) * 100,
    differencePct: observedDifference * 100,
    pValue: (extreme + 1) / (permutations + 1),
    seed,
    interpretation: 'Exploratory association only. A small p-value does not establish causation, persistence, or future profitability.',
  };
}

export function buildResearchIntelligenceReport(series, backtest, options = {}) {
  const regimes = detectMarketRegimes(series, options.regime);
  const autopsy = analyzeStrategyBacktest(series, backtest);
  const hypothesis = testMomentumHypothesis(series, options.hypothesis);
  return { regimes, autopsy, hypothesis };
}
