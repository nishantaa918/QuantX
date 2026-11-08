import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMaximumDrawdown, runMonteCarlo } from '../src/data.js';

function closeTo(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test('seeded paths compound daily log returns into reproducible terminal returns', () => {
  const first = runMonteCarlo(100, 1, 7);
  const second = runMonteCarlo(100, 1, 7);

  assert.deepEqual(first, second);
  assert.equal(first.scenarioCount, 100);
  assert.equal(first.years, 1);
  closeTo(first.lower, -16.881767038498317);
  closeTo(first.median, 6.451692396598219);
  closeTo(first.upper, 34.65029563872382);
  assert.equal(first.positiveRate, 65);
  closeTo(first.maximumDrawdown.best, 5.9298219187658985);
  closeTo(first.maximumDrawdown.fifthPercentile, 8.396711767118115);
  closeTo(first.maximumDrawdown.median, 13.991284090077583);
  closeTo(first.maximumDrawdown.ninetyFifthPercentile, 23.5231047412777);
  closeTo(first.maximumDrawdown.worst, 36.611753731688026);
});

test('scenario count accepts minimum and maximum and rejects zero and out-of-range counts', () => {
  const minimum = runMonteCarlo(100, 1, 3);
  const maximum = runMonteCarlo(10_000, 1, 3);

  assert.equal(minimum.valid, true);
  assert.equal(minimum.scenarioCount, 100);
  assert.equal(maximum.valid, true);
  assert.equal(maximum.scenarioCount, 10_000);
  assert.equal(runMonteCarlo(0, 1, 3).valid, false);
  assert.equal(runMonteCarlo(99, 1, 3).valid, false);
  assert.equal(runMonteCarlo(10_001, 1, 3).valid, false);
  assert.equal(runMonteCarlo(100, 0, 3).valid, false);
  assert.equal(runMonteCarlo(100, 1.5, 3).valid, false);
});

test('drawdown uses each equity observation and retains its peak after recovery', () => {
  assert.equal(calculateMaximumDrawdown([100, 120, 130]), 0);
  assert.equal(calculateMaximumDrawdown([100, 120, 90]), 25);
  assert.equal(calculateMaximumDrawdown([100, 120, 90, 120]), 25);
  assert.equal(calculateMaximumDrawdown([100, 120, 90, 130, 65]), 50);
});

test('zero-equity and invalid path inputs are handled safely', () => {
  assert.equal(calculateMaximumDrawdown([100, 0, 50]), 100);
  assert.equal(calculateMaximumDrawdown([0, 100]), null);
  assert.equal(calculateMaximumDrawdown([]), null);
  assert.equal(calculateMaximumDrawdown([100, -1]), null);
  assert.equal(calculateMaximumDrawdown([100, Number.NaN]), null);
});

test('terminal-return and per-path drawdown percentiles have correct independent ordering', () => {
  const result = runMonteCarlo(100, 1, 7);
  assert.ok(result.lower <= result.median);
  assert.ok(result.median <= result.upper);
  const drawdown = result.maximumDrawdown;
  assert.ok(drawdown.best <= drawdown.fifthPercentile);
  assert.ok(drawdown.fifthPercentile <= drawdown.median);
  assert.ok(drawdown.median <= drawdown.ninetyFifthPercentile);
  assert.ok(drawdown.ninetyFifthPercentile <= drawdown.worst);
});
