const PERIOD_LENGTHS = { '1W': 7, '1M': 30, '3M': 90, '1Y': 252 };

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
  const safeValues = Array.isArray(values) ? values.filter((value) => Number.isFinite(value) && value > 0) : [];
  const returns = safeValues.slice(1).map((value, index) => value / safeValues[index] - 1);
  const mean = returns.reduce((total, value) => total + value, 0) / Math.max(returns.length, 1);
  const variance = returns.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  const standardDeviation = Math.sqrt(variance);
  let peak = safeValues[0] ?? 0;
  let maxDrawdown = 0;
  safeValues.forEach((value) => {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, (value / peak - 1) * 100);
  });
  return {
    totalReturn: safeValues.length > 1 ? (safeValues.at(-1) / safeValues[0] - 1) * 100 : 0,
    dailyReturn: returns.at(-1) ? returns.at(-1) * 100 : 0,
    annualizedVolatility: standardDeviation * Math.sqrt(252) * 100,
    sharpeRatio: standardDeviation ? mean / standardDeviation * Math.sqrt(252) : 0,
    maxDrawdown,
    winRate: returns.length ? returns.filter((value) => value > 0).length / returns.length * 100 : 0,
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

export function runMonteCarlo(scenarioCount, years, seed = 1) {
  if (!Number.isInteger(scenarioCount) || scenarioCount < 100 || scenarioCount > 10_000 || !Number.isInteger(years) || years < 1 || years > 5) {
    return { valid: false, error: 'Use 100-10,000 scenarios and a whole-year horizon from 1 to 5.' };
  }
  const random = createRandom(seed + scenarioCount * 11);
  const outcomes = [];
  const maximumDrawdowns = [];
  const sessions = years * 252;
  const drift = 0.0003;
  const dailyDeviation = 0.011;
  for (let scenario = 0; scenario < scenarioCount; scenario += 1) {
    let value = 1;
    let peak = value;
    let maximumDrawdown = 0;
    for (let session = 0; session < sessions; session += 1) {
      const first = Math.max(random(), Number.EPSILON);
      const second = random();
      const normal = Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
      value *= Math.exp(drift - dailyDeviation ** 2 / 2 + dailyDeviation * normal);
      peak = Math.max(peak, value);
      maximumDrawdown = Math.max(maximumDrawdown, ((peak - value) / peak) * 100);
    }
    outcomes.push((value - 1) * 100);
    maximumDrawdowns.push(maximumDrawdown);
  }
  outcomes.sort((first, second) => first - second);
  maximumDrawdowns.sort((first, second) => first - second);
  return {
    valid: true,
    scenarioCount: outcomes.length,
    years,
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