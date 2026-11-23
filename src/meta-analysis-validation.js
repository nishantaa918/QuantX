import { metaAnalyze } from './meta-analysis.js';

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}

function standardNormal(random) {
  const u1 = Math.max(Number.MIN_VALUE, random());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * random());
}

function summarize(values) {
  const count = values.length;
  const estimate = values.reduce((sum, value) => sum + value, 0) / count;
  const variance = values.reduce((sum, value) => sum + (value - estimate) ** 2, 0) / (count - 1);
  const standardError = Math.sqrt(variance / count);
  return {
    estimate,
    monteCarloStandardError: standardError,
    approximate95PercentInterval: [
      estimate - 1.96 * standardError,
      estimate + 1.96 * standardError,
    ],
  };
}

function validate(config) {
  if (!Number.isInteger(config.replications) || config.replications < 100 || config.replications > 50000) {
    return 'replications_must_be_integer_between_100_and_50000';
  }
  if (!Number.isInteger(config.studies) || config.studies < 3 || config.studies > 100) {
    return 'studies_must_be_integer_between_3_and_100';
  }
  if (!Number.isFinite(config.tau) || config.tau < 0) return 'tau_must_be_nonnegative';
  if (!Number.isFinite(config.meanEffect)) return 'mean_effect_must_be_finite';
  if (!Number.isFinite(config.alpha) || config.alpha <= 0 || config.alpha >= 1) {
    return 'alpha_must_be_between_zero_and_one';
  }
  if (!['equal', 'unequal'].includes(config.variancePattern)) return 'unsupported_variance_pattern';
  if (!['DL', 'REML'].includes(config.tauEstimator)) return 'unsupported_tau_estimator';
  if (!['hk', 'mhk'].includes(config.inference)) return 'unsupported_inference_method';
  if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) {
    return 'seed_must_be_an_unsigned_32_bit_integer';
  }
  return null;
}

/**
 * Simulates independent normal study effects:
 * y_i = meanEffect + u_i + e_i, u_i~N(0,tau^2), e_i~N(0,v_i).
 * Evaluates tau-squared bias, HK/mHK CI coverage and null type-I error,
 * plus prediction-interval coverage for a new study's true effect.
 * Estimates and uncertainty are calculated across replications.
 */
export function monteCarloMetaAnalysisValidation(options = {}) {
  const config = {
    replications: 2000,
    studies: 10,
    tau: 0.2,
    meanEffect: 0,
    alpha: 0.05,
    variancePattern: 'unequal',
    tauEstimator: 'REML',
    inference: 'hk',
    seed: 20261123,
    ...options,
  };
  const error = validate(config);
  if (error) return { valid: false, error };

  const random = createRandom(config.seed);
  const tauSquaredTruth = config.tau ** 2;
  const tauSquaredEstimates = [];
  const coveredMean = [];
  const rejectedNull = [];
  const coveredPrediction = [];
  const intervalWidths = [];
  const estimates = [];
  let failedReplications = 0;

  const variances = Array.from({ length: config.studies }, (_, index) => {
    if (config.variancePattern === 'equal') return 0.04;
    return 0.01 * (1 + (index % 5) * 1.5);
  });

  for (let replication = 0; replication < config.replications; replication += 1) {
    const randomEffects = Array.from({ length: config.studies }, () =>
      config.tau * standardNormal(random));
    const samplingErrors = variances.map((variance) =>
      Math.sqrt(variance) * standardNormal(random));
    const effects = randomEffects.map((effect, index) =>
      config.meanEffect + effect + samplingErrors[index]);
    const result = metaAnalyze(effects, variances, {
      model: 'random',
      tauEstimator: config.tauEstimator,
      inference: config.inference,
      alpha: config.alpha,
    });
    if (!result.valid || !Number.isFinite(result.tauSquared)
      || !result.confidenceInterval.every(Number.isFinite)) {
      failedReplications += 1;
      continue;
    }

    tauSquaredEstimates.push(result.tauSquared);
    estimates.push(result.estimate);
    const [lower, upper] = result.confidenceInterval;
    coveredMean.push(lower <= config.meanEffect && config.meanEffect <= upper ? 1 : 0);
    rejectedNull.push(config.meanEffect === 0 && !(lower <= 0 && 0 <= upper) ? 1 : 0);
    intervalWidths.push(upper - lower);

    if (result.predictionInterval) {
      const futureTrueEffect = config.meanEffect + config.tau * standardNormal(random);
      coveredPrediction.push(
        result.predictionInterval[0] <= futureTrueEffect
          && futureTrueEffect <= result.predictionInterval[1] ? 1 : 0,
      );
    }
  }

  const completed = tauSquaredEstimates.length;
  if (completed < Math.max(50, Math.floor(config.replications * 0.9))) {
    return {
      valid: false,
      error: 'too_many_failed_replications',
      requestedReplications: config.replications,
      completedReplications: completed,
      failedReplications,
    };
  }

  const tauSquared = summarize(tauSquaredEstimates);
  const coverage = summarize(coveredMean);
  const typeIError = config.meanEffect === 0 ? summarize(rejectedNull) : null;
  const predictionCoverage = summarize(coveredPrediction);
  return {
    valid: true,
    method: 'seeded_monte_carlo_random_effects_meta_analysis_validation',
    configuration: {
      ...config,
      trueTauSquared: tauSquaredTruth,
      samplingVarianceRange: [Math.min(...variances), Math.max(...variances)],
      samplingVariances: variances,
    },
    requestedReplications: config.replications,
    completedReplications: completed,
    failedReplications,
    metrics: {
      tauSquared: {
        ...tauSquared,
        bias: tauSquared.estimate - tauSquaredTruth,
        relativeBias: tauSquaredTruth > 0
          ? (tauSquared.estimate - tauSquaredTruth) / tauSquaredTruth : null,
      },
      meanEffectConfidenceIntervalCoverage: coverage,
      typeIErrorRate: typeIError,
      predictionIntervalCoverage: predictionCoverage,
      meanConfidenceIntervalWidth: summarize(intervalWidths),
      meanPooledEstimate: summarize(estimates),
    },
    targets: {
      confidenceIntervalCoverage: 1 - config.alpha,
      typeIErrorRate: config.meanEffect === 0 ? config.alpha : null,
      predictionIntervalCoverage: 1 - config.alpha,
    },
    definitions: {
      tauSquaredBias: 'Mean estimated between-study variance minus the generating tau squared.',
      confidenceIntervalCoverage: 'Replication fraction whose pooled-mean interval contains the generating mean effect.',
      typeIErrorRate: 'Under meanEffect=0, replication fraction whose two-sided pooled-mean interval excludes zero.',
      predictionIntervalCoverage: 'Replication fraction whose prediction interval contains an independently generated new study true effect.',
      uncertainty: 'Monte Carlo standard errors are computed across completed replication-level estimates or indicators.',
    },
    caveats: [
      'The data-generating process assumes independent normal random effects and independent normal sampling errors with known study variances.',
      'Prediction coverage targets a new study true effect, not its noisy observed estimate.',
      'Coverage estimates are simulation diagnostics, not universal guarantees; results depend on study count, heterogeneity and variance pattern.',
      'A zero heterogeneity boundary can make relative bias undefined; absolute bias remains reported.',
    ],
  };
}
