const PERIOD_LENGTHS = { '1W': 7, '1M': 30, '3M': 90, '1Y': 252 };
const MONTE_CARLO_MIN_RETURNS = 60;
const MONTE_CARLO_TRADING_DAYS = 252;

function createRandom(seed) {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function generateSeries(period = '1M', seed = 126) {
  const length = PERIOD_LENGTHS[period] ?? PERIOD_LENGTHS['1M'];
  const random = createRandom(seed + length * 37);
  const values = [5128.4];
  for (let index = 1; index < length; index += 1) {
    const cycle = Math.sin(index * 0.53) * 0.0032;
    const dailyReturn = 0.00028 + cycle + (random() - 0.5) * 0.025;
    values.push(Math.max(100, values.at(-1) * (1 + dailyReturn)));
  }

  const anchor = Date.UTC(2025, 0, 1);
  const sessionSpacing = period === '1Y' ? 365 / 252 : 1;
  const labels = values.map((_, index) => {
    const daysAgo = (length - index - 1) * sessionSpacing;
    const date = new Date(anchor - daysAgo * 86_400_000);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  return { period, labels, values };
}

export function calculatePerformance(values) {
  if (!Array.isArray(values) || values.length < 2 || !values.every((value) => Number.isFinite(value) && value > 0)) {
    return {
      valid: false,
      error: 'Performance metrics require at least two consecutive, finite, positive price observations.',
      totalReturn: null,
      dailyReturn: null,
      annualizedVolatility: null,
      sharpeRatio: null,
      maxDrawdown: null,
      winRate: null,
    };
  }
  const returns = values.slice(1).map((value, index) => value / values[index] - 1);
  const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance = returns.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  const standardDeviation = Math.sqrt(variance);
  let peak = values[0];
  let maxDrawdown = 0;
  values.forEach((value) => {
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, (value / peak - 1) * 100);
  });
  return {
    valid: true,
    totalReturn: (values.at(-1) / values[0] - 1) * 100,
    dailyReturn: returns.at(-1) * 100,
    annualizedVolatility: standardDeviation * Math.sqrt(252) * 100,
    sharpeRatio: standardDeviation ? mean / standardDeviation * Math.sqrt(252) : 0,
    maxDrawdown,
    winRate: returns.filter((value) => value > 0).length / returns.length * 100,
  };
}

export function calculateMaximumDrawdown(equityPath) {
  if (!Array.isArray(equityPath) || equityPath.length === 0) return null;
  let peak = equityPath[0];
  if (!Number.isFinite(peak) || peak <= 0) return null;
  let maximumDrawdown = 0;
  for (const equity of equityPath) {
    if (!Number.isFinite(equity) || equity < 0) return null;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, ((peak - equity) / peak) * 100);
  }
  return maximumDrawdown;
}

function empiricalPercentile(sortedValues, probability) {
  return sortedValues[Math.floor((sortedValues.length - 1) * probability)];
}

/**
 * Historical circular block-bootstrap Monte Carlo.
 * Returns are sampled in contiguous blocks from the supplied price history,
 * preserving within-block serial dependence. It does not extrapolate beyond
 * the empirical return distribution and is not a forecast.
 */
export function runMonteCarlo(scenarioCount, years, series, seed = 1, options = {}) {
  if (!Number.isInteger(scenarioCount) || scenarioCount < 100 || scenarioCount > 10_000 || !Number.isInteger(years) || years < 1 || years > 5) {
    return { valid: false, error: 'Use 100-10,000 scenarios and a whole-year horizon from 1 to 5.' };
  }
  if (options.blockLength !== undefined && (!Number.isInteger(options.blockLength) || options.blockLength <= 0)) {
    return { valid: false, error: 'Block length must be a positive integer.' };
  }
  const values = series?.values;
  if (!Array.isArray(values) || values.length < MONTE_CARLO_MIN_RETURNS + 1 || !values.every((value) => Number.isFinite(value) && value > 0)) {
    return { valid: false, error: `Monte Carlo needs at least ${MONTE_CARLO_MIN_RETURNS + 1} valid price observations (60 returns). Select a longer series or load historical data.` };
  }
  const returns = values.slice(1).map((value, index) => value / values[index] - 1);
  if (!returns.every((value) => Number.isFinite(value) && value > -1)) {
    return { valid: false, error: 'Monte Carlo requires finite simple returns greater than -100%; inspect the source price history for numerical underflow or overflow.' };
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const dailyVolatility = Math.sqrt(variance);
  if (!Number.isFinite(dailyVolatility) || dailyVolatility <= Number.EPSILON) {
    return { valid: false, error: 'Monte Carlo requires a non-constant return history with measurable volatility.' };
  }
  const requestedBlockLength = options.blockLength;
  const blockLength = Number.isInteger(requestedBlockLength)
    ? Math.max(1, Math.min(requestedBlockLength, returns.length))
    : Math.max(2, Math.min(20, Math.floor(Math.sqrt(returns.length))));
  const random = createRandom(seed);
  const outcomes = [];
  const maximumDrawdowns = [];
  const sessions = years * MONTE_CARLO_TRADING_DAYS;
  for (let scenario = 0; scenario < scenarioCount; scenario += 1) {
    let value = 1;
    let peak = 1;
    let maximumDrawdown = 0;
    let session = 0;
    while (session < sessions) {
      const start = Math.floor(random() * returns.length);
      for (let offset = 0; offset < blockLength && session < sessions; offset += 1) {
        const sampledReturn = returns[(start + offset) % returns.length];
        value *= 1 + sampledReturn;
        if (!Number.isFinite(value) || value <= 0) {
          return { valid: false, error: 'The sampled return path produced a non-positive portfolio value; inspect the source series.' };
        }
        peak = Math.max(peak, value);
        maximumDrawdown = Math.max(maximumDrawdown, ((peak - value) / peak) * 100);
        session += 1;
      }
    }
    outcomes.push((value - 1) * 100);
    maximumDrawdowns.push(maximumDrawdown);
  }
  outcomes.sort((first, second) => first - second);
  maximumDrawdowns.sort((first, second) => first - second);
  return {
    valid: true,
    method: 'circular-block-bootstrap',
    scenarioCount: outcomes.length,
    years,
    observations: returns.length,
    blockLength,
    annualizedHistoricalReturn: ((1 + mean) ** MONTE_CARLO_TRADING_DAYS - 1) * 100,
    annualizedHistoricalVolatility: dailyVolatility * Math.sqrt(MONTE_CARLO_TRADING_DAYS) * 100,
    lower: empiricalPercentile(outcomes, 0.05),
    median: empiricalPercentile(outcomes, 0.5),
    upper: empiricalPercentile(outcomes, 0.95),
    positiveRate: outcomes.filter((value) => value > 0).length / outcomes.length * 100,
    maximumDrawdown: {
      fifthPercentile: empiricalPercentile(maximumDrawdowns, 0.05),
      median: empiricalPercentile(maximumDrawdowns, 0.5),
      ninetyFifthPercentile: empiricalPercentile(maximumDrawdowns, 0.95),
      worst: maximumDrawdowns.at(-1),
      best: maximumDrawdowns[0],
    },
  };
}
