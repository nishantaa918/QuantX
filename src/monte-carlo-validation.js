import { adjustPValues } from './statistical-inference.js';

const METHODS = ['bh', 'by', 'bonferroni'];

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}

function standardNormal(random) {
  const u1 = Math.max(Number.MIN_VALUE, random());
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function twoSidedPValue(z) {
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))));
}

function validateOptions(options) {
  const {
    replications = 2000,
    hypotheses = 20,
    alternativeProportion = 0.2,
    effectSize = 2.5,
    alpha = 0.05,
    dependence = 'independent',
    rho = 0.5,
    seed = 20261123,
  } = options;
  if (!Number.isInteger(replications) || replications < 100 || replications > 100000) {
    return { valid: false, error: 'replications_must_be_integer_between_100_and_100000' };
  }
  if (!Number.isInteger(hypotheses) || hypotheses < 2 || hypotheses > 1000) {
    return { valid: false, error: 'hypotheses_must_be_integer_between_2_and_1000' };
  }
  if (!Number.isFinite(alternativeProportion) || alternativeProportion < 0 || alternativeProportion >= 1) {
    return { valid: false, error: 'alternative_proportion_must_be_in_zero_to_one' };
  }
  if (!Number.isFinite(effectSize) || effectSize < 0) {
    return { valid: false, error: 'effect_size_must_be_nonnegative' };
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    return { valid: false, error: 'alpha_must_be_between_zero_and_one' };
  }
  if (!['independent', 'positive_equicorrelation', 'negative_equicorrelation_boundary'].includes(dependence)) {
    return { valid: false, error: 'unsupported_dependence_scenario' };
  }
  if (dependence === 'positive_equicorrelation' && (!Number.isFinite(rho) || rho < 0 || rho >= 1)) {
    return { valid: false, error: 'rho_must_be_between_zero_inclusive_and_one_exclusive' };
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    return { valid: false, error: 'seed_must_be_an_unsigned_32_bit_integer' };
  }
  return {
    valid: true,
    config: { replications, hypotheses, alternativeProportion, effectSize, alpha, dependence, rho, seed },
  };
}

function generateZScores(config, random, alternativeCount) {
  const { hypotheses, dependence, rho, effectSize } = config;
  let independent;
  if (dependence === 'independent') {
    independent = Array.from({ length: hypotheses }, () => standardNormal(random));
  } else if (dependence === 'positive_equicorrelation') {
    const common = standardNormal(random);
    independent = Array.from({ length: hypotheses }, () =>
      Math.sqrt(rho) * common + Math.sqrt(1 - rho) * standardNormal(random));
  } else {
    // PSD boundary of the equicorrelation family: pairwise rho = -1/(m-1).
    const raw = Array.from({ length: hypotheses }, () => standardNormal(random));
    const mean = raw.reduce((sum, value) => sum + value, 0) / hypotheses;
    const scale = Math.sqrt(hypotheses / (hypotheses - 1));
    independent = raw.map((value) => scale * (value - mean));
  }
  return independent.map((value, index) => value + (index < alternativeCount ? effectSize : 0));
}

function summarize(values) {
  const count = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const sampleVariance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
  const standardError = Math.sqrt(sampleVariance / count);
  return {
    estimate: mean,
    monteCarloStandardError: standardError,
    approximate95PercentInterval: [
      Math.max(0, mean - 1.96 * standardError),
      Math.min(1, mean + 1.96 * standardError),
    ],
  };
}

function controlAssessment(summary, alpha) {
  const [lower, upper] = summary.approximate95PercentInterval;
  if (upper <= alpha) return 'estimate_consistent_with_target_within_mc_uncertainty';
  if (lower > alpha) return 'estimate_exceeds_target_beyond_mc_uncertainty';
  return 'inconclusive_at_this_replication_count';
}

/**
 * Monte Carlo operating-characteristic study for BH, BY and Bonferroni.
 * FDR is averaged over replication-level false discovery proportions (FDP);
 * FWER is the replication-level indicator of at least one false rejection.
 * Power is the average within-replication true-positive proportion.
 *
 * This is a simulation diagnostic, not a proof of theoretical guarantees.
 */
export function monteCarloFdrValidation(options = {}) {
  const validation = validateOptions({
    replications: 2000,
    hypotheses: 20,
    alternativeProportion: 0.2,
    effectSize: 2.5,
    alpha: 0.05,
    dependence: 'independent',
    rho: 0.5,
    seed: 20261123,
    ...options,
  });
  if (!validation.valid) return validation;
  const config = validation.config;
  const alternativeCount = Math.floor(config.hypotheses * config.alternativeProportion);
  const nullCount = config.hypotheses - alternativeCount;
  const random = createRandom(config.seed);
  const outcomes = Object.fromEntries(METHODS.map((method) => [method, {
    falseDiscoveryProportions: [],
    anyFalseRejections: [],
    truePositiveProportions: [],
    discoveries: [],
  }]));

  for (let replication = 0; replication < config.replications; replication += 1) {
    const zScores = generateZScores(config, random, alternativeCount);
    const pValues = zScores.map(twoSidedPValue);
    for (const method of METHODS) {
      const adjusted = adjustPValues(pValues, { method, alpha: config.alpha });
      if (!adjusted.valid) return adjusted;
      let falseDiscoveries = 0;
      let trueDiscoveries = 0;
      adjusted.reject.forEach((rejected, index) => {
        if (!rejected) return;
        if (index < alternativeCount) trueDiscoveries += 1;
        else falseDiscoveries += 1;
      });
      const totalDiscoveries = falseDiscoveries + trueDiscoveries;
      const sample = outcomes[method];
      sample.falseDiscoveryProportions.push(totalDiscoveries ? falseDiscoveries / totalDiscoveries : 0);
      sample.anyFalseRejections.push(falseDiscoveries > 0 ? 1 : 0);
      sample.truePositiveProportions.push(alternativeCount ? trueDiscoveries / alternativeCount : 0);
      sample.discoveries.push(totalDiscoveries);
    }
  }

  const results = {};
  for (const method of METHODS) {
    const sample = outcomes[method];
    const fdr = summarize(sample.falseDiscoveryProportions);
    const fwer = summarize(sample.anyFalseRejections);
    const power = alternativeCount ? summarize(sample.truePositiveProportions) : null;
    results[method] = {
      fdr,
      fwer,
      power,
      meanDiscoveries: sample.discoveries.reduce((sum, value) => sum + value, 0) / config.replications,
      fdrControlAssessment: method === 'bh' && config.dependence === 'negative_equicorrelation_boundary'
        ? 'descriptive_only_bh_guarantee_not_established_for_this_dependence'
        : controlAssessment(fdr, config.alpha),
      fwerControlAssessment: method === 'bonferroni'
        ? controlAssessment(fwer, config.alpha)
        : 'descriptive_only_method_does_not_claim_fwer_control',
      theoreticalGuarantee: method === 'by'
        ? 'FDR control under arbitrary dependence'
        : method === 'bh'
          ? 'FDR control under independence or suitable positive regression dependence'
          : 'FWER control under arbitrary dependence; therefore FDR is also bounded by alpha',
    };
  }

  return {
    valid: true,
    method: 'seeded_monte_carlo_multiple_testing_validation',
    configuration: {
      ...config,
      nullHypotheses: nullCount,
      alternativeHypotheses: alternativeCount,
      alternativePlacement: 'first_indices_fixed_across_replications',
    },
    replications: config.replications,
    results,
    definitions: {
      fdr: 'Mean across replications of false discoveries divided by max(total discoveries, 1).',
      fwer: 'Probability across replications of at least one false rejection.',
      power: 'Mean across replications of true discoveries divided by the number of true alternatives.',
      monteCarloStandardError: 'Sample standard deviation of replication-level outcomes divided by sqrt(replications).',
    },
    caveats: [
      'Monte Carlo estimates assess finite-sample behaviour; they do not prove theoretical error-control guarantees.',
      'The negative-equicorrelation scenario uses the positive-semidefinite boundary rho = -1/(m-1); two-sided p-values induce their own dependence structure.',
      'BH theoretical FDR control requires independence or suitable positive regression dependence; BY is designed for arbitrary dependence.',
      'Normal-approximation p-values and Gaussian-copula dependence are simulation assumptions, not a model of every empirical research family.',
      'The approximate intervals quantify Monte Carlo uncertainty only, not uncertainty about whether the simulation assumptions are realistic.',
    ],
  };
}
