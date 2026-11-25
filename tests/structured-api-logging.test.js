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

test('structured request logs record route, status and duration without sensitive request data', async () => {
  const records = [];
  const logger = {
    info: (value) => records.push({ level: 'info', value }),
    warn: (value) => records.push({ level: 'warn', value }),
    error: (value) => records.push({ level: 'error', value }),
  };
  let clock = 1000;
  const handler = createMarketDataApiHandler({
    apiKey: 'private-api-key',
    now: () => clock,
    logger,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ 'Global Quote': {
        '01. symbol': 'AAPL',
        '05. price': '101',
        '06. volume': '10',
        '07. latest trading day': '2026-11-24',
        '08. previous close': '100',
        '09. change': '1',
        '10. change percent': '1%',
      } }),
    }),
  });
  const response = responseRecorder();
  const pending = handler({
    method: 'GET',
    url: '/api/market-data/quote?symbol=AAPL&secret=query-secret',
    headers: { 'x-forwarded-for': '203.0.113.99' },
  }, response);
  clock = 1025;
  await pending;
  assert.equal(response.result().status, 200);
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'info');
  const event = JSON.parse(records[0].value);
  assert.deepEqual(event, {
    event: 'quantx_market_data_request',
    route: '/api/market-data/quote',
    method: 'GET',
    status: 200,
    durationMs: 25,
  });
  assert.equal(records[0].value.includes('private-api-key'), false);
  assert.equal(records[0].value.includes('203.0.113.99'), false);
  assert.equal(records[0].value.includes('query-secret'), false);
});

test('structured request logs classify client and server errors by severity', async () => {
  const records = [];
  const logger = {
    info: (value) => records.push({ level: 'info', value }),
    warn: (value) => records.push({ level: 'warn', value }),
    error: (value) => records.push({ level: 'error', value }),
  };
  const handler = createMarketDataApiHandler({ apiKey: '', logger });
  const badMethod = responseRecorder();
  await handler({ method: 'POST', url: '/api/market-data/quote?symbol=AAPL' }, badMethod);
  assert.equal(badMethod.result().status, 405);
  assert.equal(records[0].level, 'warn');
  assert.equal(JSON.parse(records[0].value).status, 405);

  const missingKey = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, missingKey);
  assert.equal(missingKey.result().status, 503);
  assert.equal(records[1].level, 'error');
  assert.equal(JSON.parse(records[1].value).status, 503);
});

test('logging failures never prevent API responses from completing', async () => {
  const logger = { info() { throw new Error('logging backend failure'); } };
  const handler = createMarketDataApiHandler({ apiKey: '', logger });
  const response = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
  assert.equal(response.result().status, 503);
});
