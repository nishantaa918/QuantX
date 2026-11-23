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
  const hc0 = fitHacRegression(y, x, { bandwidth: 0, hc0Only: true, finiteSampleCorrection: false });
  assert.equal(hac.bandwidth, 2);
  assert.equal(hac.bandwidthMethod, 'fixed');
  assert.equal(hc0.bandwidth, 0);
  assert.equal(hc0.finiteSampleCorrection, 1);
});

test('HAC rejects malformed, short, singular, and unsupported inputs', () => {
  assert.equal(fitHacRegression([1, 2], [[1], [1]]).error, 'insufficient_sample_for_hac');
  assert.equal(fitHacRegression([1, 2, 3, 4, 5], [[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]).error, 'design_near_singular');
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


test('AR(1) fixture distinguishes classical, finite-bandwidth HAC, and long-run standard errors', () => {
  // Deterministic pseudo-normal innovations keep this empirical fixture reproducible.
  let state = 20261123;
  const uniform = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const observations = 500;
  const phi = 0.8;
  const y = Array(observations).fill(0);
  for (let time = 1; time < observations; time += 1) {
    let innovation = 0;
    for (let draw = 0; draw < 12; draw += 1) innovation += uniform();
    y[time] = phi * y[time - 1] + innovation - 6;
  }

  const result = fitHacRegression(y, Array.from({ length: observations }, () => [1]));
  assert.equal(result.valid, true);
  assert.equal(result.bandwidth, 5);

  const mean = y.reduce((sum, value) => sum + value, 0) / observations;
  const residuals = y.map((value) => value - mean);
  const classicalSe = Math.sqrt(
    residuals.reduce((sum, value) => sum + value * value, 0)
      / (observations - 1) / observations,
  );

  // For unit innovation variance and phi=.8:
  // stationary variance = 1/(1-phi^2) = 2.7778;
  // classical SE target = sqrt(2.7778/500) = .07454;
  // long-run variance = (1+phi)/(1-phi) * stationary variance = 25;
  // infinite-bandwidth long-run SE target = sqrt(25/500) = .22361.
  // The default Bartlett bandwidth is only five, so its population target is
  // the truncated, down-weighted covariance sum (~.1509), not .22361.
  const stationaryVariance = 1 / (1 - phi * phi);
  const bartlettLongRunVariance = stationaryVariance * (
    1 + 2 * Array.from({ length: result.bandwidth }, (_, index) => {
      const lag = index + 1;
      return (1 - lag / (result.bandwidth + 1)) * phi ** lag;
    }).reduce((sum, value) => sum + value, 0)
  );
  const finiteBandwidthTarget = Math.sqrt(bartlettLongRunVariance / observations);
  const infiniteBandwidthTarget = Math.sqrt(25 / observations);

  assert.ok(Math.abs(classicalSe - Math.sqrt(stationaryVariance / observations))
    / Math.sqrt(stationaryVariance / observations) < 0.2);
  assert.ok(Math.abs(result.standardErrors[0] - finiteBandwidthTarget)
    / finiteBandwidthTarget < 0.2);
  assert.ok(result.standardErrors[0] > classicalSe * 1.7);
  assert.ok(result.standardErrors[0] < infiniteBandwidthTarget);
});
