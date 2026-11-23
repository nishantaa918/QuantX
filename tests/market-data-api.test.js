import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketDataApiHandler } from '../api/market-data/daily.js';

function responseRecorder() {
  let body = '';
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { body = value; },
    result() { return { status: this.statusCode, headers: this.headers, body: JSON.parse(body) }; },
  };
}

test('Vercel API handler exposes the production route and reports missing server credentials safely', async () => {
  const handler = createMarketDataApiHandler({ apiKey: '' });
  const response = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/daily?symbol=AAPL' }, response);
  const result = response.result();
  assert.equal(result.status, 503);
  assert.equal(result.body.status, 'unavailable');
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
});

test('Vercel API handler serves normalized historical data without exposing the provider key', async () => {
  const key = 'private-test-key';
  const handler = createMarketDataApiHandler({
    apiKey: key,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get('apikey'), key);
      return {
        ok: true,
        json: async () => ({
          'Meta Data': { '2. Symbol': 'AAPL' },
          'Time Series (Daily)': {
            '2025-01-02': { '1. open': '101', '2. high': '103', '3. low': '100', '4. close': '102', '5. volume': '200' },
            '2025-01-01': { '1. open': '100', '2. high': '102', '3. low': '99', '4. close': '101', '5. volume': '100' },
          },
        }),
      };
    },
  });
  const response = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/daily?symbol=AAPL' }, response);
  const result = response.result();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'historical');
  assert.deepEqual(result.body.data.observations.map((item) => item.date), ['2025-01-01', '2025-01-02']);
  assert.equal(JSON.stringify(result.body).includes(key), false);
});

test('Vercel API handler returns safe method and route errors', async () => {
  const handler = createMarketDataApiHandler({ apiKey: '' });
  const methodResponse = responseRecorder();
  await handler({ method: 'POST', url: '/api/market-data/daily?symbol=AAPL' }, methodResponse);
  assert.equal(methodResponse.result().status, 405);

  const routeResponse = responseRecorder();
  await handler({ method: 'GET', url: '/api/unknown' }, routeResponse);
  assert.equal(routeResponse.result().status, 404);
});

test('Vercel API handler serves multiple allowlisted US equities and ETFs', async () => {
  const handler = createMarketDataApiHandler({
    apiKey: 'multi-asset-key',
    fetchImpl: async (url) => {
      const symbol = new URL(url).searchParams.get('symbol');
      return {
        ok: true,
        json: async () => ({
          'Meta Data': { '2. Symbol': symbol },
          'Time Series (Daily)': {
            '2025-01-02': { '1. open': '101', '2. high': '103', '3. low': '100', '4. close': '102', '5. volume': '200' },
            '2025-01-01': { '1. open': '100', '2. high': '102', '3. low': '99', '4. close': '101', '5. volume': '100' },
          },
        }),
      };
    },
  });
  for (const symbol of ['MSFT', 'SPY', 'QQQ']) {
    const response = responseRecorder();
    await handler({ method: 'GET', url: `/api/market-data/daily?symbol=${symbol}` }, response);
    const result = response.result();
    assert.equal(result.status, 200);
    assert.equal(result.body.data.symbol, symbol);
    assert.ok(result.body.data.observations.every((item) => item.symbol === symbol));
  }
  const unsupported = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/daily?symbol=NOTREAL' }, unsupported);
  assert.equal(unsupported.result().status, 400);
});
