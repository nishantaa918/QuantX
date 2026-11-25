import { calculatePerformance } from './data.js';

export const DEFAULT_STRATEGY = {
  type: 'moving-average',
  shortWindow: 5,
  longWindow: 20,
  lookback: 30,
  volatilitySensitivity: 1.5,
};

export const DEFAULT_EXECUTION_COSTS = { commissionBps: 1, slippageBps: 5 };

export const DEFAULT_GUARDRAILS = {
  maxDrawdown: 12,
  maxVolatility: 30,
  maxExposure: 100,
  lossLimit: 3,
};

const STRATEGY_TYPES = new Set(['moving-average', 'mean-reversion', 'volatility-filter']);
function finiteSeries(values) {
  return Array.isArray(values) && values.length > 1 && values.every((value) => Number.isFinite(value) && value > 0);
}

export function validateStrategyParameters(parameters = {}) {
  const config = { ...DEFAULT_STRATEGY, ...parameters };
  const errors = [];
  if (!STRATEGY_TYPES.has(config.type)) errors.push('Select a supported strategy type.');
  for (const [name, value, minimum, maximum] of [
    ['Short moving average', config.shortWindow, 2, 30],
    ['Long moving average', config.longWindow, 5, 120],
    ['Lookback period', config.lookback, 5, 252],
  ]) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      errors.push(`${name} must be an integer from ${minimum} to ${maximum} sessions.`);
    }
  }
  if (!Number.isFinite(config.volatilitySensitivity) || config.volatilitySensitivity < 0.5 || config.volatilitySensitivity > 3) {
    errors.push('Volatility sensitivity must be between 0.5 and 3.0.');
  }
  if (Number.isInteger(config.shortWindow) && Number.isInteger(config.longWindow) && config.shortWindow >= config.longWindow) {
    errors.push('The short moving average must be shorter than the long moving average.');
  }
  if (Number.isInteger(config.lookback) && Number.isInteger(config.longWindow) && config.lookback < config.longWindow) {
    errors.push('The lookback period must be at least as long as the long moving average.');
  }
  return { valid: errors.length === 0, errors, config };
}

export function getReplayReadiness(series, parameters = DEFAULT_STRATEGY) {
  const validation = validateStrategyParameters(parameters);
  const values = series?.values;
  const observations = Array.isArray(values) ? values.length : 0;
  const requiredObservations = validation.config.type === 'volatility-filter'
    ? Math.max(validation.config.longWindow, validation.config.lookback)
    : validation.config.longWindow;
  const validSeries = finiteSeries(values);
  const available = validation.valid && validSeries && observations >= requiredObservations;
  let reason = '';
  if (!validation.valid) reason = validation.errors.join(' ');
  else if (!validSeries) reason = 'A valid price series is required for replay.';
  else if (observations < requiredObservations) reason = `Replay needs ${requiredObservations} observations for the selected policy; this series has ${observations}.`;
  return {
    available,
    reason,
    observations,
    requiredObservations,
    firstPlayableIndex: available ? requiredObservations - 1 : 0,
  };
}

function movingAverage(values, index, window) {
  if (index + 1 < window) return null;
  let total = 0;
  for (let cursor = index + 1 - window; cursor <= index; cursor += 1) total += values[cursor];
  return total / window;
}

function annualizedVolatility(values, endIndex, lookback) {
  const returns = [];
  const firstIndex = Math.max(1, endIndex - lookback + 1);
  for (let index = firstIndex; index <= endIndex; index += 1) returns.push(values[index] / values[index - 1] - 1);
  if (returns.length < 2) return 0;
  const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance = returns.reduce((total, value) => total + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

export function calculateStrategySignal(values, index, parameters = DEFAULT_STRATEGY) {
  const validation = validateStrategyParameters(parameters);
  if (!validation.valid || !Array.isArray(values) || !Number.isInteger(index) || index < 0 || index >= values.length) {
    return { valid: false, ready: false, signal: 'UNAVAILABLE', targetExposure: 0, shortAverage: null, longAverage: null, volatility: null };
  }
  const { config } = validation;
  const requiredLookback = config.type === 'volatility-filter' ? Math.max(config.longWindow, config.lookback) : config.longWindow;
  const shortValue = movingAverage(values, index, config.shortWindow);
  const longValue = movingAverage(values, index, config.longWindow);
  if (index + 1 < requiredLookback || shortValue === null || longValue === null) {
    return { valid: true, ready: false, signal: 'FLAT', targetExposure: 0, shortAverage: shortValue, longAverage: longValue, volatility: null };
  }
  const volatility = config.type === 'volatility-filter' ? annualizedVolatility(values, index, config.lookback) : null;
  let targetExposure = 0;
  if (config.type === 'moving-average') targetExposure = shortValue > longValue ? 1 : 0;
  if (config.type === 'mean-reversion') targetExposure = values[index] < longValue ? 1 : 0;
  if (config.type === 'volatility-filter') targetExposure = shortValue > longValue && volatility <= 20 * config.volatilitySensitivity ? 1 : 0;
  return {
    valid: true,
    ready: true,
    signal: targetExposure ? 'LONG' : 'FLAT',
    targetExposure,
    shortAverage: shortValue,
    longAverage: longValue,
    volatility,
  };
}

export function validateExecutionCosts(costs = DEFAULT_EXECUTION_COSTS) {
  const config = { ...DEFAULT_EXECUTION_COSTS, ...costs };
  const errors = [];
  if (!Number.isFinite(config.commissionBps) || config.commissionBps < 0 || config.commissionBps > 100) {
    errors.push('Commission must be between 0 and 100 basis points per unit turnover.');
  }
  const slippageModel = config.slippageModel ?? 'fixed';
  if (!['fixed', 'volume-impact'].includes(slippageModel)) {
    errors.push('Select a supported slippage model.');
  }
  if (slippageModel === 'fixed' && (!Number.isFinite(config.slippageBps) || config.slippageBps < 0 || config.slippageBps > 100)) {
    errors.push('Fixed slippage must be between 0 and 100 basis points per unit turnover.');
  }
  if (slippageModel === 'volume-impact' && (!Number.isFinite(config.impactCoefficient ?? 0.1) || (config.impactCoefficient ?? 0.1) <= 0 || (config.impactCoefficient ?? 0.1) > 1)) {
    errors.push('The volume-impact coefficient must be greater than 0 and no more than 1.');
  }
  return { valid: errors.length === 0, errors, config };
}

function estimateVolumeImpactBps(series, executionIndex, tradedNotional, coefficient) {
  // Use only the previous completed session's OHLCV: the current session's
  // volume/range is not known when the next-session order is submitted.
  const observation = series?.observations?.[executionIndex - 1];
  const close = observation?.rawClose ?? observation?.close;
  const { high, low, volume } = observation ?? {};
  if (![close, high, low, volume].every(Number.isFinite) || close <= 0 || high < low || volume <= 0) {
    return { valid: false, error: 'Volume-impact slippage requires aligned historical OHLCV observations with positive volume and a valid prior-session range.' };
  }
  const dollarVolume = close * volume;
  if (!Number.isFinite(dollarVolume) || dollarVolume <= 0) {
    return { valid: false, error: 'Volume-impact slippage could not calculate prior-session dollar volume.' };
  }
  const participation = tradedNotional / dollarVolume;
  if (!Number.isFinite(participation) || participation < 0) {
    return { valid: false, error: 'Volume-impact slippage could not calculate order participation.' };
  }
  const rangeFraction = (high - low) / close;
  const estimatedBps = coefficient * rangeFraction * Math.sqrt(participation) * 10_000;
  if (!Number.isFinite(estimatedBps)) {
    return { valid: false, error: 'Volume-impact slippage estimate is not finite.' };
  }
  return { valid: true, slippageBps: Math.min(estimatedBps, 500), participation, rangeFraction };
}

export function calculateExecutionCostRate(series, executionIndex, turnover, priorNetEquity, executionCosts = DEFAULT_EXECUTION_COSTS) {
  const validation = validateExecutionCosts(executionCosts);
  if (!validation.valid) return { valid: false, errors: validation.errors };
  if (executionIndex === 0 && turnover === 0 && Number.isFinite(priorNetEquity) && priorNetEquity > 0) {
    return { valid: true, slippageBps: 0, costRate: 0 };
  }
  if (!Number.isInteger(executionIndex) || executionIndex < 1 || !Number.isFinite(turnover) || turnover < 0
    || !Number.isFinite(priorNetEquity) || priorNetEquity <= 0) {
    return { valid: false, errors: ['Execution cost calculation requires a valid session, non-negative turnover, and positive finite prior equity.'] };
  }
  const config = validation.config;
  const model = config.slippageModel ?? 'fixed';
  let slippageBps = config.slippageBps;
  if (model === 'volume-impact') {
    if (turnover === 0) slippageBps = 0;
    else {
      const estimate = estimateVolumeImpactBps(
        series,
        executionIndex,
        priorNetEquity * turnover,
        config.impactCoefficient ?? 0.1,
      );
      if (!estimate.valid) return { valid: false, errors: [estimate.error] };
      slippageBps = estimate.slippageBps;
    }
  }
  return {
    valid: true,
    slippageBps,
    costRate: turnover * (config.commissionBps + slippageBps) / 10_000,
  };
}

export function calculateStrategyBacktest(series, parameters = DEFAULT_STRATEGY, startingCapital = 100_000, executionCosts = DEFAULT_EXECUTION_COSTS) {
  const validation = validateStrategyParameters(parameters);
  const costValidation = validateExecutionCosts(executionCosts);
  const values = series?.values;
  const volumeImpactSeriesValid = costValidation.config.slippageModel !== 'volume-impact'
    || (Array.isArray(series?.observations) && series.observations.length === values?.length
      && series.observations.every((observation) => {
        const close = observation?.rawClose ?? observation?.close;
        return [close, observation?.high, observation?.low, observation?.volume].every(Number.isFinite)
          && close > 0 && observation.high >= observation.low && observation.volume > 0;
      }));
  if (!validation.valid || !costValidation.valid || !finiteSeries(values) || !Number.isFinite(startingCapital) || startingCapital <= 0 || !volumeImpactSeriesValid) {
    return {
      valid: false,
      errors: [...validation.errors, ...costValidation.errors, ...(!finiteSeries(values) ? ['Price history must contain at least two finite positive observations.'] : []), ...(!Number.isFinite(startingCapital) || startingCapital <= 0 ? ['Starting capital must be greater than zero.'] : []), ...(!volumeImpactSeriesValid ? ['Volume-impact slippage requires aligned historical OHLCV observations with positive volume and valid prior-session ranges.'] : [])],
      metrics: null,
      grossMetrics: null,
      equityCurve: [],
      grossEquityCurve: [],
      exposures: [],
      signals: [],
      shortAverage: [],
      longAverage: [],
      dailyReturns: [],
      grossDailyReturns: [],
      transactionCostsUSD: [],
      slippageEstimatesBps: [],
      totalTransactionCostsUSD: null,
      totalTurnover: null,
      tradeCount: null,
      maxDailyLoss: null,
      config: validation.config,
      executionCosts: costValidation.config,
    };
  }

  const { config } = validation;
  const shortAverage = [];
  const longAverage = [];
  const signals = [];
  const exposures = [];
  const targetExposures = [];
  const dailyReturns = [];
  const grossDailyReturns = [];
  const equityCurve = [];
  const grossEquityCurve = [];
  const transactionCostsUSD = [];
  let totalTurnover = 0;
  let tradeCount = 0;
  const fixedCostRatePerUnitTurnover = (costValidation.config.commissionBps + (costValidation.config.slippageModel === 'volume-impact' ? 0 : costValidation.config.slippageBps)) / 10_000;
  const slippageEstimatesBps = [];

  values.forEach((price, index) => {
    const policy = calculateStrategySignal(values, index, config);
    shortAverage.push(policy.shortAverage);
    longAverage.push(policy.longAverage);
    signals.push(policy.signal);
    exposures.push(policy.targetExposure * 100);
    targetExposures.push(policy.targetExposure);

    // Close-derived signals become active on the next observation.
    const effectiveExposure = index === 0 ? 0 : targetExposures[index - 1];
    const priorEffectiveExposure = index < 2 ? 0 : targetExposures[index - 2];
    const turnover = Math.abs(effectiveExposure - priorEffectiveExposure);
    const grossSessionReturn = index === 0 ? 0 : (price / values[index - 1] - 1) * effectiveExposure;
    const priorNetEquity = equityCurve.at(-1) ?? startingCapital;
    const priorGrossEquity = grossEquityCurve.at(-1) ?? startingCapital;
    const executionCost = calculateExecutionCostRate(series, index, turnover, priorNetEquity, costValidation.config);
    slippageEstimatesBps.push(executionCost.slippageBps);
    const costRate = executionCost.costRate;
    const netSessionReturn = grossSessionReturn - costRate;
    const costAmount = priorNetEquity * costRate;

    grossDailyReturns.push(grossSessionReturn);
    dailyReturns.push(netSessionReturn);
    grossEquityCurve.push(index === 0 ? startingCapital : priorGrossEquity * (1 + grossSessionReturn));
    equityCurve.push(index === 0 ? startingCapital : priorNetEquity * (1 + netSessionReturn));
    transactionCostsUSD.push(costAmount);
    totalTurnover += turnover;
    if (turnover > 0) tradeCount += 1;
  });

  const metrics = calculatePerformance(equityCurve);
  const grossMetrics = calculatePerformance(grossEquityCurve);
  const maxDailyLoss = Math.max(0, ...dailyReturns.map((value) => -value * 100));
  return {
    valid: true,
    errors: [],
    metrics,
    grossMetrics,
    equityCurve,
    grossEquityCurve,
    exposures,
    signals,
    shortAverage,
    longAverage,
    dailyReturns,
    grossDailyReturns,
    transactionCostsUSD,
    slippageEstimatesBps,
    totalTransactionCostsUSD: transactionCostsUSD.reduce((sum, value) => sum + value, 0),
    totalTurnover,
    tradeCount,
    maxDailyLoss,
    maxExposure: Math.max(0, ...exposures),
    config,
    executionCosts: costValidation.config,
  };
}

function overallStatus(checks) {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'WARNING')) return 'WARNING';
  return 'PASS';
}

export function evaluateRiskGuardrails(backtest, thresholds = DEFAULT_GUARDRAILS) {
  const config = { ...DEFAULT_GUARDRAILS, ...thresholds };
  const checks = [];
  const thresholdEntries = [
    ['maxDrawdown', 'Maximum drawdown', 0.1, 100],
    ['maxVolatility', 'Volatility', 0.1, 300],
    ['maxExposure', 'Position exposure', 0.1, 100],
    ['lossLimit', 'Single-session loss', 0.1, 100],
  ];
  const invalidThresholds = thresholdEntries.filter(([key, , minimum, maximum]) => !Number.isFinite(config[key]) || config[key] < minimum || config[key] > maximum);
  if (invalidThresholds.length) {
    checks.push({ name: 'Threshold configuration', status: 'FAIL', actual: 'Invalid', limit: 'Valid finite thresholds', explanation: `Review ${invalidThresholds.map((entry) => entry[1]).join(', ')} limits.` });
  } else {
    checks.push({ name: 'Threshold configuration', status: 'PASS', actual: 'Valid', limit: 'All thresholds in range', explanation: 'Risk limits are finite and within supported ranges.' });
  }

  if (invalidThresholds.length) {
    return {
      status: 'FAIL',
      available: false,
      message: 'Correct the invalid risk thresholds before evaluating guardrails.',
      checks,
      thresholds: config,
      breachCount: checks.filter((check) => check.status === 'FAIL').length,
    };
  }

  if (!backtest) {
    return { status: 'PENDING', available: false, message: 'Run a backtest to evaluate guardrails.', checks: [], thresholds: config, breachCount: 0 };
  }

  if (!backtest.valid || !backtest.metrics || !Array.isArray(backtest.exposures)) {
    checks.push({ name: 'Risk evaluation', status: 'FAIL', actual: 'Unavailable', limit: 'Valid backtest required', explanation: 'The latest backtest is invalid. Correct its inputs and run it again.' });
    return { status: 'FAIL', available: false, message: 'A valid backtest is required to evaluate guardrails.', checks, thresholds: config, breachCount: checks.filter((check) => check.status === 'FAIL').length };
  }

  if (!backtest.exposures.some((exposure) => Number.isFinite(exposure) && exposure > 0)) {
    return {
      status: 'PENDING',
      available: false,
      message: 'No positions were generated. Run a backtest with active positions to evaluate guardrails.',
      checks: [],
      thresholds: config,
      breachCount: 0,
    };
  }

  const metrics = backtest.metrics;
  const measured = [
    ['drawdown', 'Maximum drawdown', Math.abs(metrics.maxDrawdown), config.maxDrawdown, '%'],
    ['volatility', 'Annualized volatility', metrics.annualizedVolatility, config.maxVolatility, '%'],
    ['exposure', 'Maximum position exposure', backtest.maxExposure, config.maxExposure, '%'],
    ['loss', 'Single-session loss limit', backtest.maxDailyLoss, config.lossLimit, '%'],
  ];
  if (measured.some(([, , actual]) => !Number.isFinite(actual))) {
    checks.push({ name: 'Risk evaluation', status: 'FAIL', actual: 'Unavailable', limit: 'Finite backtest metrics required', explanation: 'The latest backtest contains incomplete risk metrics. Run it again with valid data.' });
    return { status: 'FAIL', available: false, message: 'Backtest risk metrics are unavailable.', checks, thresholds: config, breachCount: checks.filter((check) => check.status === 'FAIL').length };
  }
  measured.forEach(([key, name, actual, limit, unit]) => {
    const invalid = invalidThresholds.some((entry) => entry[0] === ({ drawdown: 'maxDrawdown', volatility: 'maxVolatility', exposure: 'maxExposure', loss: 'lossLimit' })[key]);
    const breached = actual > limit;
    const status = invalid ? 'FAIL' : breached ? 'FAIL' : actual >= limit * 0.85 ? 'WARNING' : 'PASS';
    checks.push({
      key,
      name,
      status,
      actual: `${actual.toFixed(2)}${unit}`,
      limit: `${limit}${unit}`,
      explanation: invalid ? 'The configured threshold is invalid.' : breached ? `${name} exceeded its configured limit.` : status === 'WARNING' ? `${name} is approaching its configured limit.` : `${name} remains within its configured limit.`,
    });
  });
  return { status: overallStatus(checks), available: true, message: '', checks, thresholds: config, breachCount: checks.filter((check) => check.status === 'FAIL').length };
}

export function evaluatePolicyDiagnostics(series, parameters, backtest, guardrails) {
  const validation = validateStrategyParameters(parameters);
  const checks = [];
  checks.push({
    name: 'Configuration validation',
    status: validation.valid ? 'PASS' : 'FAIL',
    explanation: validation.valid ? 'Required strategy parameters are present and in supported ranges.' : validation.errors.join(' '),
  });

  const consistent = validation.config.shortWindow < validation.config.longWindow && validation.config.lookback >= validation.config.longWindow;
  checks.push({
    name: 'Parameter consistency',
    status: consistent ? 'PASS' : 'FAIL',
    explanation: consistent ? 'Short, long, and lookback windows are internally consistent.' : 'The short window must be below the long window, and lookback must cover the long window.',
  });

  const sampleLength = Array.isArray(series?.values) ? series.values.length : 0;
  let anomalyStatus = 'PASS';
  let anomalyExplanation = 'No sample-size or return-distribution anomalies were detected.';
  if (!backtest?.valid || !backtest.metrics) {
    anomalyStatus = 'FAIL';
    anomalyExplanation = 'Performance could not be evaluated because the series or strategy parameters are invalid.';
  } else if (sampleLength <= validation.config.longWindow) {
    anomalyStatus = 'WARNING';
    anomalyExplanation = `Only ${sampleLength} observations are available for a ${validation.config.longWindow}-session long window.`;
  } else if (!backtest.exposures.some((exposure) => exposure > 0)) {
    anomalyStatus = 'WARNING';
    anomalyExplanation = 'No positions were generated in this sample; performance statistics reflect an uninvested portfolio.';
  } else if (backtest.metrics.sharpeRatio > 5 || backtest.metrics.sharpeRatio < -5 || Math.abs(backtest.metrics.totalReturn) > 100) {
    anomalyStatus = 'WARNING';
    anomalyExplanation = 'The simulated return or Sharpe ratio is unusually large; inspect the sample and parameters.';
  }
  checks.push({ name: 'Performance anomalies', status: anomalyStatus, explanation: anomalyExplanation });

  const riskStatus = guardrails?.status === 'PENDING' ? 'WARNING' : guardrails?.status ?? 'FAIL';
  checks.push({
    name: 'Risk-limit warnings',
    status: riskStatus,
    explanation: guardrails?.message || (guardrails ? `${guardrails.breachCount} risk limit breach${guardrails.breachCount === 1 ? '' : 'es'} detected across the evaluated thresholds.` : 'Risk thresholds have not been evaluated.'),
  });
  return { status: overallStatus(checks), checks, validation };
}

export function evaluatePolicyState({ series, parameters = DEFAULT_STRATEGY, thresholds = DEFAULT_GUARDRAILS, backtestSeries = null, executionCosts = DEFAULT_EXECUTION_COSTS } = {}) {
  const currentBacktest = calculateStrategyBacktest(series, parameters, 100_000, executionCosts);
  const latestBacktest = backtestSeries ? calculateStrategyBacktest(backtestSeries, parameters, 100_000, executionCosts) : null;
  const guardrails = evaluateRiskGuardrails(latestBacktest, thresholds);
  const diagnostics = evaluatePolicyDiagnostics(backtestSeries ?? series, parameters, latestBacktest ?? currentBacktest, guardrails);
  return { currentBacktest, latestBacktest, guardrails, diagnostics };
}

export function runParameterSweep(
  series,
  baseParameters = DEFAULT_STRATEGY,
  shortWindows = [3, 5, 8, 10],
  longWindows = [15, 20, 30, 50],
  executionCosts = DEFAULT_EXECUTION_COSTS,
  minimumEvaluationObservations = 30,
) {
  const combinations = [];
  const values = series?.values;
  if (!finiteSeries(values) || !Number.isInteger(minimumEvaluationObservations) || minimumEvaluationObservations < 1) return combinations;
  shortWindows.forEach((shortWindow) => longWindows.forEach((longWindow) => {
    if (shortWindow >= longWindow) return;
    const parameters = { ...baseParameters, shortWindow, longWindow, lookback: Math.max(baseParameters.lookback, longWindow) };
    const warmupObservations = parameters.type === 'volatility-filter'
      ? Math.max(parameters.longWindow, parameters.lookback)
      : parameters.longWindow;
    const evaluationObservations = values.length - warmupObservations;
    if (evaluationObservations < minimumEvaluationObservations) return;
    const backtest = calculateStrategyBacktest(series, parameters, 100_000, executionCosts);
    if (!backtest.valid) return;
    // A close-derived signal first earns a return on the observation after warm-up.
    // Start metrics at the preceding equity point so warm-up flat returns are excluded.
    const evaluationStartIndex = warmupObservations - 1;
    const evaluationEquity = backtest.equityCurve.slice(evaluationStartIndex);
    combinations.push({
      parameters,
      metrics: calculatePerformance(evaluationEquity),
      maxDailyLoss: Math.max(0, ...backtest.dailyReturns.slice(warmupObservations).map((value) => -value * 100)),
      maxExposure: Math.max(0, ...backtest.exposures.slice(evaluationStartIndex)),
      evaluationObservations,
      executionCosts: backtest.executionCosts,
    });
  }));
  return combinations;
}

export function classifyMarketScenario(series) {
  if (!finiteSeries(series?.values)) return null;
  const returns = series.values.slice(1).map((value, index) => value / series.values[index] - 1);
  const totalReturn = (series.values.at(-1) / series.values[0] - 1) * 100;
  const volatility = calculatePerformance(series.values).annualizedVolatility;
  const direction = totalReturn > 5 ? 'Rising market' : totalReturn < -5 ? 'Falling market' : 'Range-bound market';
  const volatilityRegime = volatility < 15 ? 'Low volatility' : volatility < 30 ? 'Moderate volatility' : 'High volatility';
  return { direction, volatilityRegime, totalReturn, volatility, observationCount: returns.length };
}

export function buildCoverage(experiments = []) {
  const validExperiments = Array.isArray(experiments) ? experiments : [];
  const backtestExperiments = validExperiments.filter((experiment) => ['backtest', 'simulation'].includes(experiment?.kind) && experiment?.backtest?.metrics && experiment?.series?.values?.length > 1);
  const monteCarloExperiments = validExperiments.filter((experiment) => experiment?.kind === 'monte-carlo' && experiment?.monteCarlo?.valid);
  const labels = {
    market: ['Rising market', 'Range-bound market', 'Falling market'],
    volatility: ['Low volatility', 'Moderate volatility', 'High volatility'],
    strategy: ['Fast short window (2-4)', 'Medium short window (5-9)', 'Slow short window (10+)'],
    guardrail: ['Maximum drawdown', 'Volatility', 'Position exposure', 'Single-session loss'],
    period: ['1W', '1M', '3M', '1Y'],
    monteCarlo: ['100-999 scenarios', '1,000-4,999 scenarios', '5,000+ scenarios'],
  };
  const testsByGroup = {
    market: backtestExperiments.map((experiment) => classifyMarketScenario(experiment.series)?.direction).filter(Boolean),
    volatility: backtestExperiments.map((experiment) => classifyMarketScenario(experiment.series)?.volatilityRegime).filter(Boolean),
    strategy: backtestExperiments.map((experiment) => {
      const shortWindow = experiment.strategyConfig?.shortWindow;
      return shortWindow < 5 ? labels.strategy[0] : shortWindow < 10 ? labels.strategy[1] : labels.strategy[2];
    }),
    guardrail: backtestExperiments.flatMap((experiment) => experiment.guardrails?.checks?.filter((check) => check.key).map((check) => check.name) ?? []),
    period: backtestExperiments.map((experiment) => experiment.period).filter(Boolean),
    monteCarlo: monteCarloExperiments.map((experiment) => {
      const count = experiment.monteCarlo.scenarioCount;
      return count < 1000 ? labels.monteCarlo[0] : count < 5000 ? labels.monteCarlo[1] : labels.monteCarlo[2];
    }),
  };
  const names = { market: 'Market scenarios', volatility: 'Volatility regimes', strategy: 'Strategy configurations', guardrail: 'Risk guardrails', period: 'Backtest periods', monteCarlo: 'Monte Carlo scenarios' };
  const groups = Object.entries(labels).map(([key, items]) => ({
    name: names[key],
    items: items.map((name) => {
      const count = testsByGroup[key].filter((tested) => tested === name).length;
      return { name, tested: count > 0, count };
    }),
  }));
  const allItems = groups.flatMap((group) => group.items);
  return {
    groups,
    testedCount: allItems.filter((item) => item.tested).length,
    totalCount: allItems.length,
    gaps: allItems.filter((item) => !item.tested).map((item) => item.name),
    empty: backtestExperiments.length === 0 && monteCarloExperiments.length === 0,
  };
}
