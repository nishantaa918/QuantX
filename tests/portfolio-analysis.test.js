import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeEqualWeightPortfolio } from '../src/portfolio-analysis.js';

function makeSeries(symbol, values, start = '2025-01-01') {
  const labels = values.map((_, index) => new Date(Date.parse(start + 'T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10));
  return { symbol, labels, values };
}

test('equal-weight portfolio aligns common dates and computes buy-and-hold equity', () => {
  const a = makeSeries('AAA', [100, 110, 121, 121]);
  const b = makeSeries('BBB', [50, 55, 55, 60]);
  const result = analyzeEqualWeightPortfolio([a, b], { startingCapital: 10_000, minimumObservations: 4 });
  assert.equal(result.valid, true);
  assert.equal(result.method, 'Equal-weight buy-and-hold');
  assert.equal(result.observations, 4);
  assert.equal(result.weights.AAA, 0.5);
  assert.equal(result.weights.BBB, 0.5);
  assert.deepEqual(result.equityCurve, [10_000, 11_000, 11_550, 12_100]);
  assert.equal(result.metrics.totalReturn, 21);
  assert.equal(result.correlationMatrix[0].correlations[0].value, 1);
});

test('portfolio correlation uses only aligned daily returns', () => {
  const a = makeSeries('AAA', [100, 110, 99, 108.9]);
  const b = makeSeries('BBB', [50, 55, 49.5, 54.45]);
  const result = analyzeEqualWeightPortfolio([a, b], { minimumObservations: 4 });
  assert.equal(result.valid, true);
  assert.ok(Math.abs(result.correlationMatrix[0].correlations[1].value - 1) < 1e-10);
  assert.ok(Math.abs(result.averagePairwiseCorrelation - 1) < 1e-10);
});

test('portfolio rejects duplicate symbols, invalid prices, and insufficient common history', () => {
  const a = makeSeries('AAA', [100, 101, 102]);
  const b = makeSeries('AAA', [50, 51, 52]);
  assert.equal(analyzeEqualWeightPortfolio([a, b], { minimumObservations: 3 }).valid, false);
  assert.equal(analyzeEqualWeightPortfolio([a, { ...b, symbol: 'BBB', values: [50, 0, 52] }], { minimumObservations: 3 }).valid, false);
  const offset = makeSeries('BBB', [50, 51, 52], '2026-01-01');
  assert.equal(analyzeEqualWeightPortfolio([a, offset], { minimumObservations: 3 }).valid, false);
});

test('portfolio requires two to five assets and valid capital', () => {
  const a = makeSeries('AAA', [100, 101]);
  assert.equal(analyzeEqualWeightPortfolio([a]).valid, false);
  assert.equal(analyzeEqualWeightPortfolio([a, makeSeries('BBB', [50, 51])], { startingCapital: 0 }).valid, false);
  const six = Array.from({ length: 6 }, (_, index) => makeSeries(`A${index}`, [100, 101]));
  assert.equal(analyzeEqualWeightPortfolio(six).valid, false);
});
