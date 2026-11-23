import assert from 'node:assert/strict';
import test from 'node:test';
import { monteCarloMetaAnalysisValidation } from '../src/meta-analysis-validation.js';

test('meta-analysis Monte Carlo validation is reproducible for a fixed seed', () => {
  const options = { replications: 250, studies: 8, seed: 1234 };
  assert.deepEqual(
    monteCarloMetaAnalysisValidation(options),
    monteCarloMetaAnalysisValidation(options),
  );
});

test('simulation reports tau-squared bias, CI coverage, type-I error and prediction coverage', () => {
  const result = monteCarloMetaAnalysisValidation({
    replications: 500, studies: 10, tau: 0.2, meanEffect: 0,
  });
  assert.equal(result.valid, true);
  assert.equal(result.completedReplications, 500);
  assert.equal(result.metrics.typeIErrorRate.estimate, result.metrics.meanEffectConfidenceIntervalCoverage.estimate === 1 ? 0 : result.metrics.typeIErrorRate.estimate);
  for (const metric of [
    result.metrics.tauSquared,
    result.metrics.meanEffectConfidenceIntervalCoverage,
    result.metrics.typeIErrorRate,
    result.metrics.predictionIntervalCoverage,
  ]) {
    assert.ok(Number.isFinite(metric.estimate));
    assert.ok(Number.isFinite(metric.monteCarloStandardError));
  }
  assert.equal(result.targets.confidenceIntervalCoverage, 0.95);
  assert.equal(result.targets.predictionIntervalCoverage, 0.95);
});

test('unequal and equal sampling variance patterns both run', () => {
  const unequal = monteCarloMetaAnalysisValidation({
    replications: 200, studies: 6, variancePattern: 'unequal', tauEstimator: 'DL',
  });
  const equal = monteCarloMetaAnalysisValidation({
    replications: 200, studies: 6, variancePattern: 'equal', tauEstimator: 'REML',
  });
  assert.equal(unequal.valid, true);
  assert.equal(equal.valid, true);
  assert.ok(unequal.metrics.tauSquared.estimate >= 0);
  assert.ok(equal.metrics.tauSquared.estimate >= 0);
});

test('nonzero mean omits null type-I error metric', () => {
  const result = monteCarloMetaAnalysisValidation({
    replications: 200, studies: 8, meanEffect: 0.3,
  });
  assert.equal(result.valid, true);
  assert.equal(result.metrics.typeIErrorRate, null);
});

test('validation rejects invalid Monte Carlo settings', () => {
  assert.equal(monteCarloMetaAnalysisValidation({ replications: 10 }).error,
    'replications_must_be_integer_between_100_and_50000');
  assert.equal(monteCarloMetaAnalysisValidation({ studies: 2 }).error,
    'studies_must_be_integer_between_3_and_100');
  assert.equal(monteCarloMetaAnalysisValidation({ tau: -1 }).error, 'tau_must_be_nonnegative');
  assert.equal(monteCarloMetaAnalysisValidation({ variancePattern: 'wild' }).error,
    'unsupported_variance_pattern');
});
