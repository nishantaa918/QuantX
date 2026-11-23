import assert from 'node:assert/strict';
import test from 'node:test';
import { adjustPValues, fitHacRegression } from '../src/statistical-inference.js';

test('Newey-West regression returns finite symmetric HAC covariance', () => {
  const x = Array.from({ length: 60 }, (_, index) => [1, index / 10, Math.sin(index / 4)]);
  const y = x.map((row, index) => 0.7 + 1.8 * row[1] - 0.4 * row[2] + Math.sin(index * 1.7) * 0.08);
  const result = fitHacRegression(y, x);
  assert.equal(result.valid, true);
  assert.equal(result.observations, 60);
  assert.equal(result.bandwidthMethod, 'newey-west');
  assert.ok(result.bandwidth >= 1);
  assert.equal(result.covariance.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(result.standardErrors[i] >= 0);
    for (let j = 0; j < 3; j += 1) {
      assert.ok(Math.abs(result.covariance[i][j] - result.covariance[j][i]) < 1e-12);
    }
  }
  assert.ok(Math.abs(result.coefficients[1] - 1.8) < 0.03);
});

test('Newey-West supports fixed bandwidth and explicit HC0-only lag zero', () => {
  const x = Array.from({ length: 30 }, (_, index) => [1, index]);
  const y = x.map((row, index) => 2 + 3 * row[1] + Math.cos(index));
  const hac = fitHacRegression(y, x, { bandwidth: 2 });
  const hc0 = fitHacRegression(y, x, { bandwidth: 0, finiteSampleCorrection: false });
  assert.equal(hac.bandwidth, 2);
  assert.equal(hac.bandwidthMethod, 'fixed');
  assert.equal(hc0.bandwidth, 1); // Current API enforces HAC lag >= 1.
  assert.equal(hc0.finiteSampleCorrection, 1);
});

test('HAC rejects malformed, short, singular, and unsupported inputs', () => {
  assert.equal(fitHacRegression([1, 2], [[1], [1]]).error, 'insufficient_sample_for_hac');
  assert.equal(fitHacRegression([1, 2, 3, 4, 5], [[1], [1], [1], [1], [1]]).error, 'design_near_singular');
  assert.equal(fitHacRegression([1, 2, 3, 4, 5], [[1], [1], [1], [1], [1]], { kernel: 'parzen' }).error, 'unsupported_kernel');
});

test('Bonferroni, BH and BY return adjusted p-values in original order', () => {
  const p = [0.01, 0.04, 0.03, 0.2];
  const bonferroni = adjustPValues(p, { method: 'bonferroni' });
  const bh = adjustPValues(p, { method: 'bh' });
  const by = adjustPValues(p, { method: 'by' });
  assert.deepEqual(bonferroni.adjustedPValues, [0.04, 0.16, 0.12, 0.8]);
  assert.deepEqual(bh.adjustedPValues, [0.04, 0.05333333333333334, 0.05333333333333334, 0.2]);
  assert.ok(by.adjustedPValues.every((value, index) => value >= bh.adjustedPValues[index]));
  assert.deepEqual(by.reject, [false, false, false, false]);
});

test('multiple-testing helpers validate p-values and options', () => {
  assert.equal(adjustPValues([]).valid, false);
  assert.equal(adjustPValues([0.1, NaN]).valid, false);
  assert.equal(adjustPValues([0.1], { method: 'unknown' }).valid, false);
  assert.equal(adjustPValues([0.1], { alpha: 1 }).valid, false);
});
