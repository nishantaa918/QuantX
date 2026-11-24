import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeEqualWeightPortfolio } from '../src/portfolio-research.js';

function asset(symbol, values) {
  return {
    symbol,
    series: {
      priceBasis: 'adjusted',
      labels: ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04'],
      values,
    },
  };
}

test('small but nonzero returns retain correlation, Sharpe and diversification metrics', () => {
  const result = analyzeEqualWeightPortfolio([
    asset('A', [1, 1 + 1e-13, 1 + 3e-13, 1 + 4e-13]),
    asset('B', [2, 2 + 2e-13, 2 + 6e-13, 2 + 8e-13]),
  ]);

  assert.equal(result.valid, true);
  assert.ok(Number.isFinite(result.correlationMatrix[0].values[1]));
  assert.ok(result.correlationMatrix[0].values[1] > 0.99);
  assert.ok(Number.isFinite(result.metrics.sharpeRatio));
  assert.notEqual(result.metrics.sharpeRatio, null);
  assert.ok(Number.isFinite(result.metrics.diversificationBenefitPct));
  assert.notEqual(result.metrics.diversificationBenefitPct, null);
});
