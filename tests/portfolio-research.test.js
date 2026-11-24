import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeEqualWeightPortfolio } from '../src/portfolio-research.js';

function asset(symbol, values, labels = null, priceBasis = 'adjusted') {
  const dates = labels ?? Array.from({ length: values.length }, (_, index) => `2025-01-0${index + 1}`);
  return {
    symbol,
    series: {
      period: 'HISTORICAL',
      priceBasis,
      labels: dates,
      values,
    },
  };
}

test('equal-weight portfolio aligns dates and computes reproducible portfolio metrics', () => {
  const result = analyzeEqualWeightPortfolio([
    asset('AAPL', [100, 110, 121, 110]),
    asset('MSFT', [100, 100, 110, 121]),
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.symbols, ['AAPL', 'MSFT']);
  assert.equal(result.observations, 4);
  assert.equal(result.returnObservations, 3);
  assert.equal(result.priceBasis, 'adjusted');
  assert.equal(result.assetStats[0].weightPct, 50);
  assert.ok(Number.isFinite(result.metrics.totalReturnPct));
  assert.ok(Number.isFinite(result.metrics.annualizedVolatilityPct));
  assert.ok(Number.isFinite(result.metrics.maxDrawdownPct));
  assert.equal(result.correlationMatrix.length, 2);
  assert.equal(result.correlationMatrix[0].values[0], 1);
  assert.equal(result.correlationMatrix[1].values[1], 1);
  assert.equal(result.correlationMatrix[0].values[1], result.correlationMatrix[1].values[0]);
});

test('portfolio analysis inner-joins shared trading dates before calculating returns', () => {
  const first = asset('AAPL', [100, 110, 121], ['2025-01-01', '2025-01-02', '2025-01-04']);
  const second = asset('SPY', [200, 220, 242, 250], ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04']);
  const result = analyzeEqualWeightPortfolio([first, second]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.commonDates, ['2025-01-01', '2025-01-02', '2025-01-04']);
  assert.equal(result.returnObservations, 2);
});

test('portfolio analysis rejects duplicate tickers, mixed price bases and insufficient overlap', () => {
  assert.equal(analyzeEqualWeightPortfolio([asset('AAPL', [100, 101, 102]), asset('AAPL', [100, 102, 104])]).valid, false);
  assert.match(analyzeEqualWeightPortfolio([asset('AAPL', [100, 101, 102]), asset('SPY', [100, 101, 102], undefined, 'raw')]).error, /same price basis/);
  const first = asset('AAPL', [100, 101, 102], ['2025-01-01', '2025-01-02', '2025-01-04']);
  const second = asset('SPY', [200, 201, 202], ['2025-01-01', '2025-01-03', '2025-01-05']);
  assert.match(analyzeEqualWeightPortfolio([first, second]).error, /three shared trading dates/);
});

test('portfolio analysis validates sample size, dates, values, asset count and capital', () => {
  assert.equal(analyzeEqualWeightPortfolio([asset('AAPL', [100, 101, 102])]).valid, false);
  assert.equal(analyzeEqualWeightPortfolio(Array.from({ length: 11 }, (_, index) => asset(`A${index}`, [100, 101, 102]))).valid, false);
  assert.equal(analyzeEqualWeightPortfolio([asset('AAPL', [100, 101, 102]), asset('SPY', [100, 101, 102])], { startingCapital: 0 }).valid, false);
  assert.equal(analyzeEqualWeightPortfolio([asset('AAPL', [100, 101, 102], ['2025-01-01', '2025-01-01', '2025-01-03']), asset('SPY', [100, 101, 102])]).valid, false);
});

test('portfolio analysis rejects impossible calendar dates and accepts valid leap days', () => {
  const impossible = asset('AAPL', [100, 101, 102], ['2025-02-28', '2025-02-30', '2025-03-02']);
  const nonLeapDay = asset('MSFT', [100, 101, 102], ['2025-02-28', '2025-02-29', '2025-03-02']);
  const validLeapDay = asset('SPY', [100, 101, 102], ['2024-02-28', '2024-02-29', '2024-03-01']);

  assert.equal(analyzeEqualWeightPortfolio([impossible, asset('QQQ', [100, 101, 102], impossible.series.labels)]).valid, false);
  assert.equal(analyzeEqualWeightPortfolio([nonLeapDay, asset('QQQ', [100, 101, 102], nonLeapDay.series.labels)]).valid, false);
  assert.equal(analyzeEqualWeightPortfolio([validLeapDay, asset('QQQ', [100, 101, 102], validLeapDay.series.labels)]).valid, true);
});


test('portfolio annualization uses elapsed calendar time and observed interval frequency', () => {
  const dates = ['2024-01-01', '2024-07-01', '2025-01-01'];
  const result = analyzeEqualWeightPortfolio([
    asset('AAPL', [100, 110, 121], dates),
    asset('SPY', [100, 110, 121], dates),
  ]);

  assert.equal(result.valid, true);
  assert.ok(Math.abs(result.metrics.annualizedReturnPct - 20.94) < 0.02);
  assert.ok(Math.abs(result.metrics.annualizationPeriodsPerYear - (2 * 365.25 / 366)) < 1e-10);
  assert.ok(result.caveats.some((item) => item.includes('unequal lengths')));
  assert.ok(result.assetStats.every((item) => Math.abs(item.annualizedReturnPct - result.metrics.annualizedReturnPct) < 1e-10));
});


test('constant-return assets have undefined correlations rather than misleading perfect correlation', () => {
  const dates = ['2025-01-01', '2025-01-02', '2025-01-03'];
  const result = analyzeEqualWeightPortfolio([
    asset('FLAT', [100, 100, 100], dates),
    asset('ALSOFLAT', [50, 50, 50], dates),
  ]);

  assert.equal(result.valid, true);
  assert.equal(result.correlationMatrix[0].values[0], null);
  assert.equal(result.correlationMatrix[1].values[1], null);
  assert.equal(result.correlationMatrix[0].values[1], null);
  assert.equal(result.metrics.sharpeRatio, null);
  assert.equal(result.metrics.diversificationBenefitPct, null);
});

test('correlation is unavailable when one asset has zero return volatility', () => {
  const dates = ['2025-01-01', '2025-01-02', '2025-01-03'];
  const result = analyzeEqualWeightPortfolio([
    asset('FLAT', [100, 100, 100], dates),
    asset('MOVING', [100, 110, 105], dates),
  ]);

  assert.equal(result.valid, true);
  assert.equal(result.correlationMatrix[0].values[0], null);
  assert.equal(result.correlationMatrix[0].values[1], null);
  assert.equal(result.correlationMatrix[1].values[0], null);
  assert.ok(result.caveats.some((item) => item.includes('zero return volatility')));
});

test('portfolio analysis rejects price ratios and equity curves that overflow', () => {
  const dates = ['2025-01-01', '2025-01-02', '2025-01-03'];
  const overflowingPrices = analyzeEqualWeightPortfolio([
    asset('HUGE', [1e-308, 1e308, 1e308], dates),
    asset('STABLE', [100, 100, 100], dates),
  ]);
  assert.equal(overflowingPrices.valid, false);
  assert.match(overflowingPrices.error, /non-finite/);

  const overflowingCapital = analyzeEqualWeightPortfolio([
    asset('GROWTH', [100, 200, 300], dates),
    asset('STEADY', [100, 100, 100], dates),
  ], { startingCapital: Number.MAX_VALUE });
  assert.equal(overflowingCapital.valid, false);
  assert.match(overflowingCapital.error, /non-finite/);
});

test('portfolio drawdown caveat explains that only sampled closes are measured', () => {
  const result = analyzeEqualWeightPortfolio([
    asset('AAPL', [100, 110, 105]),
    asset('SPY', [100, 105, 102]),
  ]);
  assert.equal(result.valid, true);
  assert.ok(result.caveats.some((item) => item.includes('intraperiod drawdowns')));
});


test('portfolio risk metrics weight each interval by its actual elapsed calendar time', () => {
  const dates = ['2025-01-01', '2025-01-02', '2025-01-22'];
  const prices = [100, 101, 111.1];
  const result = analyzeEqualWeightPortfolio([
    asset('A', prices, dates),
    asset('B', prices, dates),
  ]);

  const intervalsInYears = [1 / 365.25, 20 / 365.25];
  const logReturns = [Math.log(1.01), Math.log(1.1)];
  const elapsedYears = intervalsInYears.reduce((sum, value) => sum + value, 0);
  const drift = logReturns.reduce((sum, value) => sum + value, 0) / elapsedYears;
  const residualSquares = logReturns.reduce((sum, value, index) => (
    sum + (value - drift * intervalsInYears[index]) ** 2
  ), 0);
  const expectedVolatilityPct = Math.sqrt(residualSquares / elapsedYears) * 100;

  assert.equal(result.valid, true);
  assert.ok(Math.abs(result.metrics.annualizedVolatilityPct - expectedVolatilityPct) < 1e-10);
  assert.ok(Math.abs(result.assetStats[0].annualizedVolatilityPct - expectedVolatilityPct) < 1e-10);
  assert.ok(Number.isFinite(result.metrics.sharpeRatio));
});

test('constant annualized log growth across unequal intervals has zero estimated volatility', () => {
  const dates = ['2025-01-01', '2025-01-02', '2025-01-22'];
  const annualDrift = 0.12;
  const firstIntervalYears = 1 / 365.25;
  const totalYears = 21 / 365.25;
  const prices = [
    100,
    100 * Math.exp(annualDrift * firstIntervalYears),
    100 * Math.exp(annualDrift * totalYears),
  ];
  const result = analyzeEqualWeightPortfolio([
    asset('A', prices, dates),
    asset('B', prices, dates),
  ]);

  assert.equal(result.valid, true);
  assert.equal(result.metrics.annualizedVolatilityPct, 0);
  assert.equal(result.metrics.sharpeRatio, null);
});
