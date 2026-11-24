import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlphaVantageMiddleware } from '../server/alpha-vantage-proxy.js';
import { normalizeAlphaVantageDaily, normalizeAlphaVantageRows, SUPPORTED_HISTORICAL_SYMBOLS, toPriceSeries } from '../src/market-data.js';
import { calculateStrategyBacktest } from '../src/strategy-analysis.js';

const rows = [
  { date: '2025-01-03', open: '103', high: '105', low: '102', close: '104', volume: '300' },
  { date: '2025-01-01', open: '100', high: '102', low: '99', close: '101', volume: '100' },
  { date: '2025-01-02', open: '101', high: '104', low: '100', close: '103', volume: '200' },
  { date: '2025-01-02', open: '101', high: '104', low: '100', close: '103', volume: '200' },
];

function dailyPayload() {
  return {
    'Meta Data': { '2. Symbol': 'AAPL', '3. Last Refreshed': '2025-01-03', '5. Time Zone': 'US/Eastern' },
    'Time Series (Daily)': Object.fromEntries(rows.map((row) => [row.date, {
      '1. open': row.open,
      '2. high': row.high,
      '3. low': row.low,
      '4. close': row.close,
      '5. volume': row.volume,
    }])),
  };
}

async function callMiddleware(middleware, { method = 'GET', url = '/api/market-data/daily?symbol=AAPL' } = {}) {
  let result;
  let nextCalled = false;
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { result = { status: this.statusCode, headers: this.headers, body: JSON.parse(body) }; },
  };
  await middleware({ method, url }, response, () => { nextCalled = true; });
  return { ...result, nextCalled };
}

test('Alpha Vantage normalization sorts dates, removes duplicates, and preserves raw OHLCV fields', () => {
  const normalized = normalizeAlphaVantageRows(rows);
  assert.deepEqual(normalized.map((row) => row.date), ['2025-01-01', '2025-01-02', '2025-01-03']);
  assert.deepEqual(normalized[0], {
    symbol: 'AAPL', date: '2025-01-01', open: 100, high: 102, low: 99, close: 101,
    volume: 100, adjustedClose: null, dividendAmount: 0, splitCoefficient: null,
    source: 'alpha_vantage', frequency: '1d', adjustment: 'raw',
  });
  const payload = normalizeAlphaVantageDaily(dailyPayload());
  assert.equal(payload.adjustment, 'raw');
  assert.ok(SUPPORTED_HISTORICAL_SYMBOLS.includes('SPY'));
  assert.ok(SUPPORTED_HISTORICAL_SYMBOLS.includes('NVDA'));
  assert.equal(payload.observations.length, 3);
  assert.equal(payload.timeZone, 'US/Eastern');
});

test('normalizer rejects invalid dates, prices, OHLC relationships, volume and empty series', () => {
  assert.throws(() => normalizeAlphaVantageRows([{ ...rows[0], date: '2025-02-30' }]), /date/);
  assert.throws(() => normalizeAlphaVantageRows([{ ...rows[0], open: '0' }]), /open/);
  assert.throws(() => normalizeAlphaVantageRows([{ ...rows[0], high: '101' }]), /Inconsistent OHLC/);
  assert.throws(() => normalizeAlphaVantageRows([{ ...rows[0], volume: '-2' }]), /volume/);
  assert.throws(() => normalizeAlphaVantageRows([]), /no daily observations/);
  assert.throws(() => normalizeAlphaVantageDaily({ Note: 'rate limit' }), /rate limit/);
});

test('provider middleware requires a server key and never echoes it to the client', async () => {
  let fetchCount = 0;
  const missingKey = createAlphaVantageMiddleware({ apiKey: '', fetchImpl: async () => { fetchCount += 1; } });
  const unavailable = await callMiddleware(missingKey);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.status, 'unavailable');
  assert.equal(fetchCount, 0);

  const key = 'server-only-test-key';
  const configured = createAlphaVantageMiddleware({ apiKey: key, fetchImpl: async (url) => {
    fetchCount += 1;
    assert.equal(new URL(url).searchParams.get('apikey'), key);
    return { ok: true, json: async () => dailyPayload() };
  } });
  const response = await callMiddleware(configured);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.symbol, 'AAPL');
  assert.equal(response.body.data.observations.length, 3);
  assert.equal(JSON.stringify(response.body).includes(key), false);
});

test('middleware caches successful provider results and refreshes after TTL', async () => {
  let now = 1_000;
  let fetchCount = 0;
  const middleware = createAlphaVantageMiddleware({
    apiKey: 'secret',
    now: () => now,
    cacheTtlMs: 500,
    fetchImpl: async () => { fetchCount += 1; return { ok: true, json: async () => dailyPayload() }; },
  });
  await callMiddleware(middleware);
  await callMiddleware(middleware);
  assert.equal(fetchCount, 1);
  now += 501;
  await callMiddleware(middleware);
  assert.equal(fetchCount, 2);
});

test('middleware maps provider and request errors to safe statuses', async () => {
  const limited = createAlphaVantageMiddleware({ apiKey: 'secret', fetchImpl: async () => ({ ok: true, json: async () => ({ Note: 'provider detail' }) }) });
  assert.equal((await callMiddleware(limited)).status, 429);

  const planRestricted = createAlphaVantageMiddleware({
    apiKey: 'secret',
    fetchImpl: async () => ({ ok: true, json: async () => ({ Information: 'premium endpoint access required' }) }),
  });
  const restrictedResponse = await callMiddleware(planRestricted);
  assert.equal(restrictedResponse.status, 503);
  assert.equal(restrictedResponse.body.status, 'unavailable');
  assert.equal(restrictedResponse.body.message.includes('premium endpoint access required'), false);
  const invalid = createAlphaVantageMiddleware({ apiKey: 'secret', fetchImpl: async () => ({ ok: true, json: async () => ({ 'Error Message': 'provider detail' }) }) });
  const failure = await callMiddleware(invalid);
  assert.equal(failure.status, 502);
  assert.equal(JSON.stringify(failure.body).includes('secret'), false);
  assert.equal((await callMiddleware(invalid, { url: '/api/market-data/daily?symbol=NOTREAL' })).status, 400);
  assert.equal((await callMiddleware(invalid, { method: 'POST' })).status, 405);
});


test('historical observations become a dated close-price series without synthetic relabelling', () => {
  const observations = normalizeAlphaVantageRows(rows);
  const series = toPriceSeries(observations, { symbol: 'aapl' });
  assert.equal(series.period, 'HISTORICAL');
  assert.equal(series.symbol, 'AAPL');
  assert.deepEqual(series.labels, ['2025-01-01', '2025-01-02', '2025-01-03']);
  assert.deepEqual(series.values, [101, 103, 104]);
  assert.equal(series.observations[0].source, 'alpha_vantage');
  assert.throws(() => toPriceSeries(observations.slice(0, 1)), /at least two/);
  assert.throws(() => toPriceSeries([...observations].reverse()), /ascending/);
});


test('historical dated close series runs through the existing strategy backtest engine', () => {
  const observations = Array.from({ length: 40 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
    const close = 100 + index * 0.4;
    return { date, open: close, high: close + 1, low: close - 1, close, volume: 1_000_000, source: 'alpha_vantage' };
  });
  const series = toPriceSeries(observations, { symbol: 'AAPL' });
  const backtest = calculateStrategyBacktest(series, {
    type: 'moving-average',
    shortWindow: 2,
    longWindow: 6,
    lookback: 10,
    volatilitySensitivity: 1.5,
  });

  assert.equal(backtest.valid, true);
  assert.equal(backtest.equityCurve.length, observations.length);
  assert.equal(series.labels[0], observations[0].date);
  assert.equal(series.labels.at(-1), observations.at(-1).date);
  assert.ok(backtest.exposures.some((exposure) => exposure > 0));
  assert.ok(Number.isFinite(backtest.metrics.totalReturn));
});


test('adjusted daily normalization preserves adjusted close, dividends, and split coefficients', () => {
  const payload = {
    'Meta Data': { '2. Symbol': 'AAPL', '3. Last Refreshed': '2025-01-03', '5. Time Zone': 'US/Eastern' },
    'Time Series (Daily Adjusted)': {
      '2025-01-03': {
        '1. open': '103', '2. high': '105', '3. low': '102', '4. close': '104',
        '5. adjusted close': '102.5', '6. volume': '300',
        '7. dividend amount': '0.25', '8. split coefficient': '1.0',
      },
      '2025-01-02': {
        '1. open': '101', '2. high': '104', '3. low': '100', '4. close': '103',
        '5. adjusted close': '101.4', '6. volume': '200',
        '7. dividend amount': '0', '8. split coefficient': '1.0',
      },
    },
  };
  const normalized = normalizeAlphaVantageDaily(payload);
  assert.equal(normalized.adjustment, 'raw_with_adjusted_close');
  assert.equal(normalized.observations[1].adjustedClose, 102.5);
  assert.equal(normalized.observations[1].dividendAmount, 0.25);
  assert.equal(normalized.observations[1].splitCoefficient, 1);
  const adjusted = toPriceSeries(normalized.observations, { symbol: 'AAPL', priceBasis: 'adjusted' });
  assert.equal(adjusted.adjustment, 'adjusted');
  assert.deepEqual(adjusted.values, [101.4, 102.5]);
  assert.equal(adjusted.observations[0].rawClose, 103);
  assert.equal(adjusted.observations[0].close, 101.4);
  assert.equal(adjusted.observations[0].adjustment, 'adjusted');
  const raw = toPriceSeries(normalized.observations, { symbol: 'AAPL', priceBasis: 'raw' });
  assert.deepEqual(raw.values, [103, 104]);
});

test('adjusted price series rejects missing or invalid adjustment data', () => {
  const observations = normalizeAlphaVantageRows(rows);
  assert.throws(() => toPriceSeries(observations, { priceBasis: 'adjusted' }), /adjusted close/);
  assert.throws(() => toPriceSeries(observations, { priceBasis: 'total-return' }), /Price basis/);
  assert.throws(() => normalizeAlphaVantageRows([{ ...rows[0], dividendAmount: '-0.1' }]), /dividend amount/);
  assert.throws(() => normalizeAlphaVantageRows([{ ...rows[0], splitCoefficient: '0' }]), /split coefficient/);
});

test('middleware requests adjusted provider data and caches raw and adjusted requests separately', async () => {
  const requests = [];
  const adjustedPayload = {
    'Meta Data': { '2. Symbol': 'AAPL' },
    'Time Series (Daily Adjusted)': {
      '2025-01-02': {
        '1. open': '101', '2. high': '104', '3. low': '100', '4. close': '103',
        '5. adjusted close': '101.4', '6. volume': '200',
        '7. dividend amount': '0', '8. split coefficient': '1.0',
      },
      '2025-01-01': {
        '1. open': '100', '2. high': '102', '3. low': '99', '4. close': '101',
        '5. adjusted close': '99.5', '6. volume': '100',
        '7. dividend amount': '0.2', '8. split coefficient': '1.0',
      },
    },
  };
  const middleware = createAlphaVantageMiddleware({
    apiKey: 'secret',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed.searchParams.get('function'));
      return { ok: true, json: async () => parsed.searchParams.get('function') === 'TIME_SERIES_DAILY_ADJUSTED' ? adjustedPayload : dailyPayload() };
    },
  });
  const adjusted = await callMiddleware(middleware, { url: '/api/market-data/daily?symbol=AAPL&adjustment=adjusted' });
  const raw = await callMiddleware(middleware, { url: '/api/market-data/daily?symbol=AAPL&adjustment=raw' });
  await callMiddleware(middleware, { url: '/api/market-data/daily?symbol=AAPL&adjustment=adjusted' });
  assert.equal(adjusted.status, 200);
  assert.equal(adjusted.body.data.requestedAdjustment, 'adjusted');
  assert.equal(adjusted.body.data.observations[0].adjustedClose, 99.5);
  assert.equal(raw.status, 200);
  assert.equal(raw.body.data.requestedAdjustment, 'raw');
  assert.deepEqual(requests, ['TIME_SERIES_DAILY_ADJUSTED', 'TIME_SERIES_DAILY']);
});


test('normalizer rejects conflicting duplicate dates but still collapses identical duplicates', () => {
  const identical = normalizeAlphaVantageRows(rows);
  assert.equal(identical.length, 3);
  const conflicting = [...rows, { ...rows[2], close: '103.5', high: '104' }];
  assert.throws(() => normalizeAlphaVantageRows(conflicting), /Conflicting duplicate/);
});

test('normalizer rejects missing, blank, fractional and unsafe share volume values', () => {
  for (const volume of [undefined, null, '', '   ', '1.5', '9007199254740992', '-1']) {
    assert.throws(
      () => normalizeAlphaVantageRows([{ ...rows[0], volume }]),
      /volume/,
      `volume value ${String(volume)} should be rejected`,
    );
  }
  assert.equal(normalizeAlphaVantageRows([{ ...rows[0], volume: '0' }])[0].volume, 0);
});

test('adjusted daily data requires complete adjusted-close and corporate-action fields', () => {
  const complete = {
    'Meta Data': { '2. Symbol': 'AAPL' },
    'Time Series (Daily Adjusted)': {
      '2025-01-02': {
        '1. open': '101', '2. high': '104', '3. low': '100', '4. close': '103',
        '5. adjusted close': '101.4', '6. volume': '200',
        '7. dividend amount': '0', '8. split coefficient': '1.0',
      },
      '2025-01-01': {
        '1. open': '100', '2. high': '102', '3. low': '99', '4. close': '101',
        '5. adjusted close': '99.5', '6. volume': '100',
        '7. dividend amount': '0.2', '8. split coefficient': '1.0',
      },
    },
  };
  const incomplete = structuredClone(complete);
  delete incomplete['Time Series (Daily Adjusted)']['2025-01-02']['8. split coefficient'];
  assert.throws(() => normalizeAlphaVantageDaily(incomplete), /Incomplete adjusted/);
});

test('normalizer prefers adjusted endpoint data when both daily series are present', () => {
  const adjusted = {
    'Meta Data': { '2. Symbol': 'AAPL' },
    'Time Series (Daily Adjusted)': {
      '2025-01-02': {
        '1. open': '101', '2. high': '104', '3. low': '100', '4. close': '103',
        '5. adjusted close': '101.4', '6. volume': '200',
        '7. dividend amount': '0', '8. split coefficient': '1.0',
      },
      '2025-01-01': {
        '1. open': '100', '2. high': '102', '3. low': '99', '4. close': '101',
        '5. adjusted close': '99.5', '6. volume': '100',
        '7. dividend amount': '0', '8. split coefficient': '1.0',
      },
    },
    'Time Series (Daily)': {
      '2025-01-02': { '1. open': '101', '2. high': '104', '3. low': '100', '4. close': '103', '5. volume': '200' },
      '2025-01-01': { '1. open': '100', '2. high': '102', '3. low': '99', '4. close': '101', '5. volume': '100' },
    },
  };
  const normalized = normalizeAlphaVantageDaily(adjusted);
  assert.equal(normalized.adjustment, 'raw_with_adjusted_close');
  assert.equal(normalized.observations[0].adjustedClose, 99.5);
  assert.equal(normalized.observations[0].splitCoefficient, 1);
});


test('adjusted endpoint schema is detected even under the standard daily container label', () => {
  const adjustedDaily = {
    'Meta Data': { '2. Symbol': 'AAPL' },
    'Time Series (Daily)': {
      '2025-01-02': {
        '1. open': '50', '2. high': '52', '3. low': '49', '4. close': '51',
        '5. adjusted close': '50.5', '6. volume': '200',
        '7. dividend amount': '0.25', '8. split coefficient': '1.0',
      },
      '2025-01-01': {
        '1. open': '100', '2. high': '102', '3. low': '99', '4. close': '101',
        '5. adjusted close': '99.5', '6. volume': '100',
        '7. dividend amount': '0', '8. split coefficient': '2.0',
      },
    },
  };

  const normalized = normalizeAlphaVantageDaily(adjustedDaily);
  assert.equal(normalized.adjustment, 'raw_with_adjusted_close');
  assert.equal(normalized.observations[0].adjustedClose, 99.5);
  assert.equal(normalized.observations[0].splitCoefficient, 2);
  assert.equal(normalized.observations[1].dividendAmount, 0.25);

  const incomplete = structuredClone(adjustedDaily);
  delete incomplete['Time Series (Daily)']['2025-01-02']['8. split coefficient'];
  assert.throws(() => normalizeAlphaVantageDaily(incomplete), /Incomplete adjusted/);
});


test('NVDA split and dividend reference fixture preserves raw bars in adjusted-close mode', () => {
  // Event dates and terms are grounded in NVIDIA's 2024 issuer disclosures:
  // 10-for-1 split (split-adjusted trading from 2024-06-10) and a
  // $0.01 post-split quarterly dividend with 2024-06-11 ex-dividend date.
  // OHLC and adjusted-close values below are deliberately synthetic test values.
  const observations = normalizeAlphaVantageRows([
    {
      date: '2024-06-10',
      open: '120', high: '124', low: '118', close: '122', volume: '1000000',
      adjustedClose: '121.5', dividendAmount: '0', splitCoefficient: '10',
    },
    {
      date: '2024-06-11',
      open: '122', high: '125', low: '121', close: '124', volume: '1100000',
      adjustedClose: '123.4', dividendAmount: '0.01', splitCoefficient: '1',
    },
  ], { symbol: 'NVDA' });

  const adjusted = toPriceSeries(observations, { symbol: 'NVDA', priceBasis: 'adjusted' });
  assert.deepEqual(adjusted.values, [121.5, 123.4]);
  assert.equal(adjusted.observations[0].splitCoefficient, 10);
  assert.equal(adjusted.observations[1].dividendAmount, 0.01);

  // Alpha Vantage documents OHLCV as raw/as-traded even on its adjusted
  // endpoint; only adjustedClose is used for the adjusted close-price series.
  assert.deepEqual(
    adjusted.observations.map(({ open, high, low, volume }) => ({ open, high, low, volume })),
    [
      { open: 120, high: 124, low: 118, volume: 1000000 },
      { open: 122, high: 125, low: 121, volume: 1100000 },
    ],
  );
  assert.deepEqual(adjusted.observations.map(({ close }) => close), [121.5, 123.4]);
  assert.deepEqual(adjusted.observations.map(({ rawClose }) => rawClose), [122, 124]);
});
