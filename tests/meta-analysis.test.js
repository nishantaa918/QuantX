import assert from 'node:assert/strict';
import test from 'node:test';
import { metaAnalyze } from '../src/meta-analysis.js';

test('fixed-effect model reproduces inverse-variance weighted estimate', () => {
  const result = metaAnalyze([1, 2, 3], [1, 1, 1], {
    model: 'fixed', inference: 'normal',
  });
  assert.equal(result.valid, true);
  assert.equal(result.estimate, 2);
  assert.equal(result.tauSquared, 0);
  assert.equal(result.standardError, Math.sqrt(1 / 3));
  assert.equal(result.predictionInterval, null);
});

test('DerSimonian-Laird random-effects model reports heterogeneity and HK inference', () => {
  const result = metaAnalyze([0.2, 0.5, 0.9, 1.1], [0.04, 0.05, 0.06, 0.05], {
    model: 'random', tauEstimator: 'DL', inference: 'hk',
  });
  assert.equal(result.valid, true);
  assert.ok(result.tauSquared > 0);
  assert.ok(result.q > result.qDegreesOfFreedom);
  assert.ok(result.iSquared > 0 && result.iSquared <= 100);
  assert.ok(result.standardError > 0);
  assert.ok(result.confidenceInterval[0] < result.estimate);
  assert.ok(result.confidenceInterval[1] > result.estimate);
  assert.equal(result.predictionIntervalDegreesOfFreedom, 2);
});

test('REML estimator returns a nonnegative variance component', () => {
  const result = metaAnalyze([0.2, 0.5, 0.9, 1.1], [0.04, 0.05, 0.06, 0.05], {
    tauEstimator: 'REML', inference: 'mhk',
  });
  assert.equal(result.valid, true);
  assert.ok(Number.isFinite(result.tauSquared));
  assert.ok(result.tauSquared >= 0);
  assert.ok(result.hkScale > 1);
});

test('modified Hartung-Knapp does not shrink the conventional standard error', () => {
  const effects = [0.1, 0.11, 0.09, 0.1];
  const variances = [0.04, 0.04, 0.04, 0.04];
  const conventional = metaAnalyze(effects, variances, { inference: 'normal' });
  const modified = metaAnalyze(effects, variances, { inference: 'mhk' });
  assert.equal(modified.valid, true);
  assert.ok(modified.standardError >= conventional.standardError);
});

test('meta-analysis rejects invalid inputs and unsupported options', () => {
  assert.equal(metaAnalyze([1], [1]).valid, false);
  assert.equal(metaAnalyze([1, 2], [1, 0]).error, 'effects_and_positive_variances_required');
  assert.equal(metaAnalyze([1, 2], [1, 1], { model: 'unknown' }).error, 'unsupported_model');
  assert.equal(metaAnalyze([1, 2], [1, 1], { tauEstimator: 'other' }).error, 'unsupported_tau_estimator');
  assert.equal(metaAnalyze([1, 2], [1, 1], { inference: 'other' }).error, 'unsupported_inference_method');
});

test('two-study analysis omits prediction interval', () => {
  const result = metaAnalyze([0.2, 0.4], [0.1, 0.1]);
  assert.equal(result.valid, true);
  assert.equal(result.predictionInterval, null);
  assert.equal(result.predictionIntervalDegreesOfFreedom, null);
});
