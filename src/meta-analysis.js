const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);
const NORMAL_975 = 1.959963984540054;

function validateInputs(effects, variances) {
  if (!Array.isArray(effects) || !Array.isArray(variances)
    || effects.length !== variances.length || effects.length < 2
    || !effects.every(Number.isFinite)
    || !variances.every((value) => Number.isFinite(value) && value > 0)) {
    return { valid: false, error: 'effects_and_positive_variances_required' };
  }
  return { valid: true, studies: effects.length };
}

function logGamma(z) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.9999999999998099;
  const shifted = z - 1;
  coefficients.forEach((coefficient, index) => { x += coefficient / (shifted + index + 1); });
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a, b, x) {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log1p(-x));
  if (x < (a + 1) / (a + b + 2)) {
    return front * betaContinuedFraction(a, b, x) / a;
  }
  return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

function studentTCdf(value, degreesOfFreedom) {
  const x = degreesOfFreedom / (degreesOfFreedom + value * value);
  const tail = 0.5 * regularizedBeta(x, degreesOfFreedom / 2, 0.5);
  return value >= 0 ? 1 - tail : tail;
}

function studentTQuantile(probability, degreesOfFreedom) {
  if (!(probability > 0 && probability < 1) || !(degreesOfFreedom > 0)) return NaN;
  if (probability === 0.5) return 0;
  let lower = -1;
  let upper = 1;
  while (studentTCdf(lower, degreesOfFreedom) > probability) lower *= 2;
  while (studentTCdf(upper, degreesOfFreedom) < probability) upper *= 2;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (studentTCdf(midpoint, degreesOfFreedom) < probability) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

function weightedSummary(effects, variances, tauSquared) {
  const weights = variances.map((variance) => 1 / (variance + tauSquared));
  const sumWeights = weights.reduce((sum, weight) => sum + weight, 0);
  const estimate = weights.reduce((sum, weight, index) => sum + weight * effects[index], 0) / sumWeights;
  const q = weights.reduce((sum, weight, index) =>
    sum + weight * (effects[index] - estimate) ** 2, 0);
  return { weights, sumWeights, estimate, q, standardError: Math.sqrt(1 / sumWeights) };
}

function estimateTauDL(effects, variances) {
  const fixed = weightedSummary(effects, variances, 0);
  const sumWeightSquares = fixed.weights.reduce((sum, weight) => sum + weight * weight, 0);
  const c = fixed.sumWeights - sumWeightSquares / fixed.sumWeights;
  return c > 0 ? Math.max(0, (fixed.q - (effects.length - 1)) / c) : 0;
}

function remlScore(tauSquared, effects, variances) {
  const weights = variances.map((variance) => 1 / (variance + tauSquared));
  const sumWeights = weights.reduce((sum, weight) => sum + weight, 0);
  const estimate = weights.reduce((sum, weight, index) => sum + weight * effects[index], 0) / sumWeights;
  const residualTerm = weights.reduce((sum, weight, index) =>
    sum + weight * weight * (effects[index] - estimate) ** 2, 0);
  const traceTerm = weights.reduce((sum, weight) => sum + weight * weight, 0) / sumWeights;
  return residualTerm - (sumWeights - traceTerm);
}

function estimateTauREML(effects, variances) {
  if (remlScore(0, effects, variances) <= 0) return 0;
  let lower = 0;
  let upper = Math.max(1, ...variances);
  let attempts = 0;
  while (remlScore(upper, effects, variances) > 0 && attempts < 100) {
    upper *= 2;
    attempts += 1;
  }
  if (!Number.isFinite(upper) || remlScore(upper, effects, variances) > 0) {
    return { valid: false, error: 'reml_tau_squared_not_bracketed' };
  }
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (remlScore(midpoint, effects, variances) > 0) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

/**
 * Performs inverse-variance fixed-effect or random-effects meta-analysis.
 * Inputs are study-level effect estimates and their sampling variances.
 * Random-effects tau-squared can be estimated by DerSimonian-Laird (DL)
 * or restricted maximum likelihood (REML).
 */
export function metaAnalyze(effects, variances, options = {}) {
  const validation = validateInputs(effects, variances);
  if (!validation.valid) return validation;
  const {
    model = 'random',
    tauEstimator = 'REML',
    inference = 'hk',
    alpha = 0.05,
  } = options;
  if (!['fixed', 'random'].includes(model)) return { valid: false, error: 'unsupported_model' };
  if (!['DL', 'REML'].includes(tauEstimator)) return { valid: false, error: 'unsupported_tau_estimator' };
  if (!['normal', 'hk', 'mhk'].includes(inference)) return { valid: false, error: 'unsupported_inference_method' };
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    return { valid: false, error: 'alpha_must_be_between_zero_and_one' };
  }

  const studies = effects.length;
  const degreesOfFreedom = studies - 1;
  const fixed = weightedSummary(effects, variances, 0);
  const tauSquared = model === 'fixed' ? 0
    : tauEstimator === 'DL' ? estimateTauDL(effects, variances)
      : estimateTauREML(effects, variances);
  if (typeof tauSquared === 'object') return tauSquared;

  const pooled = weightedSummary(effects, variances, tauSquared);
  const q = fixed.q;
  const iSquared = q > 0 ? Math.max(0, (q - degreesOfFreedom) / q) * 100 : 0;
  const hkScale = pooled.q / degreesOfFreedom;
  const varianceScale = inference === 'hk' ? hkScale
    : inference === 'mhk' ? Math.max(1, hkScale) : 1;
  const standardError = pooled.standardError * Math.sqrt(varianceScale);
  const criticalValue = inference === 'normal'
    ? NORMAL_975 : studentTQuantile(1 - alpha / 2, degreesOfFreedom);
  const confidenceInterval = [
    pooled.estimate - criticalValue * standardError,
    pooled.estimate + criticalValue * standardError,
  ];
  const predictionDegreesOfFreedom = studies - 2;
  let predictionInterval = null;
  if (model === 'random' && studies >= 3) {
    const predictionCritical = studentTQuantile(1 - alpha / 2, predictionDegreesOfFreedom);
    const predictionSe = Math.sqrt(tauSquared + standardError * standardError);
    predictionInterval = [
      pooled.estimate - predictionCritical * predictionSe,
      pooled.estimate + predictionCritical * predictionSe,
    ];
  }

  return {
    valid: true,
    model,
    tauEstimator: model === 'random' ? tauEstimator : null,
    inference,
    studies,
    estimate: pooled.estimate,
    standardError,
    confidenceInterval,
    confidenceLevel: 1 - alpha,
    tauSquared,
    q,
    qDegreesOfFreedom: degreesOfFreedom,
    iSquared,
    weights: pooled.weights,
    hkScale,
    inferenceScale: varianceScale,
    predictionInterval,
    predictionIntervalDegreesOfFreedom: predictionInterval ? predictionDegreesOfFreedom : null,
    predictionIntervalNote: predictionInterval
      ? 'Approximate t-based prediction interval; interpret cautiously with few studies.'
      : 'At least three studies are required for the prediction interval.',
    warnings: studies < 5 ? ['few_studies_heterogeneity_estimates_are_uncertain'] : [],
  };
}
