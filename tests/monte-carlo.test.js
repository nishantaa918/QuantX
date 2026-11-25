import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMaximumDrawdown, generateSeries, runMonteCarlo } from '../src/data.js';

function closeTo(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

const history = generateSeries('1Y', 987);

test('historical block-bootstrap paths are reproducible and expose their data assumptions', () => {
  const first = runMonteCarlo(100, 1, history, 7);
  const second = runMonteCarlo(100, 1, history, 7);

  assert.deepEqual(first, second);
  assert.equal(first.valid, true);
  assert.equal(first.method, 'circular-block-bootstrap');
  assert.equal(first.scenarioCount, 100);
  assert.equal(first.years, 1);
  assert.equal(first.observations, 251);
  assert.ok(first.blockLength >= 2);
  assert.ok(first.blockLength <= 20);
  assert.ok(Number.isFinite(first.annualizedHistoricalReturn));
  assert.ok(first.annualizedHistoricalVolatility > 0);
  assert.ok(first.lower <= first.median && first.median <= first.upper);
  assert.equal(first.maximumDrawdown.best <= first.maximumDrawdown.median, true);
  assert.equal(first.maximumDrawdown.median <= first.maximumDrawdown.worst, true);
});

test('simulation changes when the selected historical return series changes', () => {
  const alternate = { ...history, values: history.values.map((value, index) => value * (1 + index * 0.0005)) };
  const first = runMonteCarlo(100, 1, history, 19);
  const second = runMonteCarlo(100, 1, alternate, 19);
  assert.notDeepEqual(first, second);
  assert.notEqual(first.annualizedHistoricalReturn, second.annualizedHistoricalReturn);
});

test('scenario count and horizon boundaries are validated', () => {
  assert.equal(runMonteCarlo(100, 1, history, 3).valid, true);
  assert.equal(runMonteCarlo(10_000, 1, history, 3).valid, true);
  assert.equal(runMonteCarlo(0, 1, history, 3).valid, false);
  assert.equal(runMonteCarlo(99, 1, history, 3).valid, false);
  assert.equal(runMonteCarlo(10_001, 1, history, 3).valid, false);
  assert.equal(runMonteCarlo(100, 0, history, 3).valid, false);
  assert.equal(runMonteCarlo(100, 1.5, history, 3).valid, false);
});

test('Monte Carlo rejects insufficient, invalid and constant source histories', () => {
  assert.match(runMonteCarlo(100, 1, generateSeries('1M'), 3).error, /at least 61 valid price observations/);
  assert.equal(runMonteCarlo(100, 1, { values: Array(80).fill(100) }, 3).valid, false);
  assert.equal(runMonteCarlo(100, 1, { values: [100, 101, Number.NaN] }, 3).valid, false);
  assert.equal(runMonteCarlo(100, 1, null, 3).valid, false);
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

test('Monte Carlo validates explicit block lengths and caps them to the observed return sample', () => {
  for (const blockLength of [0, -1, 1.5, Number.NaN]) {
    const result = runMonteCarlo(100, 1, history, 3, { blockLength });
    assert.equal(result.valid, false);
    assert.equal(result.error, 'Block length must be a positive integer.');
  }

  const capped = runMonteCarlo(100, 1, history, 3, { blockLength: 10_000 });
  assert.equal(capped.valid, true);
  assert.equal(capped.blockLength, history.values.length - 1);

  const explicit = runMonteCarlo(100, 1, history, 3, { blockLength: 7 });
  assert.equal(explicit.valid, true);
  assert.equal(explicit.blockLength, 7);
});

test('Monte Carlo rejects numerically invalid returns before resampling', () => {
  const underflowHistory = { values: [Number.MAX_VALUE, ...Array(60).fill(Number.MIN_VALUE)] };
  const overflowHistory = { values: [Number.MIN_VALUE, Number.MAX_VALUE, ...Array(59).fill(Number.MAX_VALUE)] };

  for (const invalidHistory of [underflowHistory, overflowHistory]) {
    const result = runMonteCarlo(100, 1, invalidHistory, 3, { blockLength: 60 });
    assert.equal(result.valid, false);
    assert.match(result.error, /finite simple returns greater than -100%/);
  }
});

