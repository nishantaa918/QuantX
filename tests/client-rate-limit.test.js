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

function validQuote(symbol) {
  return { 'Global Quote': {
    '01. symbol': symbol,
    '05. price': '101',
    '06. volume': '10',
    '07. latest trading day': '2026-11-24',
    '08. previous close': '100',
    '09. change': '1',
    '10. change percent': '1%',
  } };
}

test('shared client rate limits apply across handler instances and hash client IPs', async () => {
  const seenKeys = [];
  let clientCount = 0;
  let providerCalls = 0;
  const providerBudgetStore = {
    async reserveClientRequest({ clientKey, requestLimit }) {
      seenKeys.push(clientKey);
      clientCount += 1;
      return { allowed: clientCount <= requestLimit, retryAfterSeconds: 30 };
    },
    async reserveRequest() { return { allowed: true, retryAfterSeconds: 0 }; },
    async activateCooldown() {},
  };
  const options = {
    apiKey: 'test-key',
    clientRequestLimit: 1,
    providerBudgetStore,
    fetchImpl: async (url) => {
      providerCalls += 1;
      const symbol = new URL(url).searchParams.get('symbol');
      return { ok: true, json: async () => validQuote(symbol) };
    },
  };
  const firstHandler = createMarketDataApiHandler(options);
  const secondHandler = createMarketDataApiHandler(options);
  const first = responseRecorder();
  await firstHandler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL', headers: { 'x-forwarded-for': '203.0.113.10' } }, first);
  assert.equal(first.result().status, 200);

  const second = responseRecorder();
  await secondHandler({ method: 'GET', url: '/api/market-data/quote?symbol=MSFT', headers: { 'x-forwarded-for': '203.0.113.10' } }, second);
  assert.equal(second.result().status, 429);
  assert.equal(second.result().headers['Retry-After'], '30');
  assert.equal(providerCalls, 1);
  assert.equal(seenKeys.length, 2);
  assert.notEqual(seenKeys[0], '203.0.113.10');
  assert.equal(seenKeys[0], seenKeys[1]);
});

test('local client limiter separates IPs and limits repeated uncached requests', async () => {
  let providerCalls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'test-key',
    clientRequestLimit: 1,
    now: () => Date.parse('2026-11-25T12:00:00.000Z'),
    fetchImpl: async (url) => {
      providerCalls += 1;
      const symbol = new URL(url).searchParams.get('symbol');
      return { ok: true, json: async () => validQuote(symbol) };
    },
  });
  const request = async (symbol, ip) => {
    const response = responseRecorder();
    await handler({
      method: 'GET',
      url: '/api/market-data/quote?symbol=' + symbol,
      headers: { 'x-forwarded-for': ip },
    }, response);
    return response.result();
  };

  assert.equal((await request('AAPL', '203.0.113.11')).status, 200);
  assert.equal((await request('MSFT', '203.0.113.11')).status, 429);
  assert.equal((await request('MSFT', '203.0.113.12')).status, 200);
  assert.equal(providerCalls, 2);
});

test('malformed forwarded client address is rejected without contacting the provider', async () => {
  let providerCalls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'test-key',
    fetchImpl: async () => {
      providerCalls += 1;
      return { ok: true, json: async () => validQuote('AAPL') };
    },
  });
  const response = responseRecorder();
  await handler({
    method: 'GET',
    url: '/api/market-data/quote?symbol=AAPL',
    headers: { 'x-forwarded-for': 'not-an-ip' },
  }, response);
  assert.equal(response.result().status, 400);
  assert.equal(providerCalls, 0);
});

test('shared client limiter fails closed when persistent storage is unavailable', async () => {
  let providerCalls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'test-key',
    providerBudgetStore: {
      async reserveClientRequest() { throw new Error('private storage detail'); },
      async reserveRequest() { return { allowed: true, retryAfterSeconds: 0 }; },
    },
    fetchImpl: async () => {
      providerCalls += 1;
      return { ok: true, json: async () => validQuote('AAPL') };
    },
  });
  const response = responseRecorder();
  await handler({
    method: 'GET',
    url: '/api/market-data/quote?symbol=AAPL',
    headers: { 'x-forwarded-for': '203.0.113.20' },
  }, response);
  assert.equal(response.result().status, 503);
  assert.equal(JSON.stringify(response.result().body).includes('private storage detail'), false);
  assert.equal(providerCalls, 0);
});
