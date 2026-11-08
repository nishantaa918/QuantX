import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlphaVantageMiddleware } from '../server/alpha-vantage-proxy.js';
import { normalizeAlphaVantageDaily, normalizeAlphaVantageRows } from '../src/market-data.js';

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
    volume: 100, source: 'alpha_vantage', frequency: '1d', adjustment: 'raw',
  });
  const payload = normalizeAlphaVantageDaily(dailyPayload());
  assert.equal(payload.adjustment, 'raw');
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
  const invalid = createAlphaVantageMiddleware({ apiKey: 'secret', fetchImpl: async () => ({ ok: true, json: async () => ({ 'Error Message': 'provider detail' }) }) });
  const failure = await callMiddleware(invalid);
  assert.equal(failure.status, 502);
  assert.equal(JSON.stringify(failure.body).includes('secret'), false);
  assert.equal((await callMiddleware(invalid, { url: '/api/market-data/daily?symbol=MSFT' })).status, 400);
  assert.equal((await callMiddleware(invalid, { method: 'POST' })).status, 405);
});
