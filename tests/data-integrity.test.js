import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePerformance } from '../src/data.js';

test('performance metrics calculate from a complete valid price sequence', () => {
  const result = calculatePerformance([100, 110, 99, 108.9]);
  assert.equal(result.valid, true);
  assert.equal(result.totalReturn, 8.9);
  assert.ok(Math.abs(result.dailyReturn - 10) < 1e-10);
  assert.ok(Number.isFinite(result.annualizedVolatility));
  assert.equal(result.maxDrawdown, -10);
  assert.equal(result.winRate, 2 / 3 * 100);
});

test('performance metrics fail closed instead of bridging invalid observations', () => {
  for (const values of [
    [100, Number.NaN, 120],
    [100, 0, 120],
    [100, -5, 120],
    [100, Number.POSITIVE_INFINITY, 120],
    [100, null, 120],
    [100],
    [],
    null,
  ]) {
    const result = calculatePerformance(values);
    assert.equal(result.valid, false);
    assert.equal(result.totalReturn, null);
    assert.equal(result.dailyReturn, null);
    assert.equal(result.annualizedVolatility, null);
    assert.equal(result.sharpeRatio, null);
    assert.equal(result.maxDrawdown, null);
    assert.equal(result.winRate, null);
    assert.match(result.error, /at least two consecutive/);
  }
});

test('a valid flat price sequence reports zero volatility and zero return', () => {
  const result = calculatePerformance([100, 100, 100]);
  assert.equal(result.valid, true);
  assert.equal(result.totalReturn, 0);
  assert.equal(result.dailyReturn, 0);
  assert.equal(result.annualizedVolatility, 0);
  assert.equal(result.sharpeRatio, 0);
  assert.equal(result.maxDrawdown, 0);
  assert.equal(result.winRate, 0);
});
