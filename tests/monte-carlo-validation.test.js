import assert from 'node:assert/strict';
import test from 'node:test';
import { monteCarloFdrValidation } from '../src/monte-carlo-validation.js';

test('Monte Carlo FDR validation is deterministic for a fixed seed', () => {
  const options = { replications: 300, hypotheses: 20, seed: 12345 };
  assert.deepEqual(monteCarloFdrValidation(options), monteCarloFdrValidation(options));
});

test('simulation reports replication-level FDR, FWER, power and Monte Carlo uncertainty', () => {
  const result = monteCarloFdrValidation({
    replications: 500, hypotheses: 20, alternativeProportion: 0.2, effectSize: 2.5,
  });
  assert.equal(result.valid, true);
  assert.equal(result.configuration.nullHypotheses, 16);
  assert.equal(result.configuration.alternativeHypotheses, 4);
  for (const method of ['bh', 'by', 'bonferroni']) {
    const row = result.results[method];
    for (const metric of [row.fdr, row.fwer, row.power]) {
      assert.ok(metric);
      assert.ok(metric.estimate >= 0 && metric.estimate <= 1);
      assert.ok(metric.monteCarloStandardError >= 0);
      assert.equal(metric.approximate95PercentInterval.length, 2);
    }
  }
});

test('all-null simulation reports FDR and FWER while power is unavailable', () => {
  const result = monteCarloFdrValidation({
    replications: 400, hypotheses: 12, alternativeProportion: 0, seed: 9,
  });
  assert.equal(result.valid, true);
  for (const method of ['bh', 'by', 'bonferroni']) {
    assert.equal(result.results[method].power, null);
    assert.equal(result.results[method].fdr.estimate, result.results[method].fwer.estimate);
  }
});

test('positive and negative equicorrelation stress scenarios run reproducibly', () => {
  const positive = monteCarloFdrValidation({
    replications: 300, hypotheses: 10, dependence: 'positive_equicorrelation', rho: 0.6,
  });
  const negative = monteCarloFdrValidation({
    replications: 300, hypotheses: 10, dependence: 'negative_equicorrelation_boundary',
  });
  assert.equal(positive.valid, true);
  assert.equal(negative.valid, true);
  assert.ok(Number.isFinite(positive.results.by.fdr.estimate));
  assert.ok(Number.isFinite(negative.results.bh.fdr.estimate));
});

test('simulation validates replication, hypothesis, dependence and alpha settings', () => {
  assert.equal(monteCarloFdrValidation({ replications: 10 }).error,
    'replications_must_be_integer_between_100_and_100000');
  assert.equal(monteCarloFdrValidation({ hypotheses: 1 }).error,
    'hypotheses_must_be_integer_between_2_and_1000');
  assert.equal(monteCarloFdrValidation({ alternativeProportion: 1 }).error,
    'alternative_proportion_must_be_in_zero_to_one');
  assert.equal(monteCarloFdrValidation({ dependence: 'arbitrary' }).error,
    'unsupported_dependence_scenario');
  assert.equal(monteCarloFdrValidation({ dependence: 'positive_equicorrelation', rho: 1 }).error,
    'rho_must_be_between_zero_inclusive_and_one_exclusive');
  assert.equal(monteCarloFdrValidation({ alpha: 0 }).error,
    'alpha_must_be_between_zero_and_one');
});
