import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpstashProviderBudgetStore } from '../server/upstash-provider-budget.js';
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

test('Upstash adapter sends an authenticated atomic EVAL request and parses its reservation', async () => {
  let request;
  const store = createUpstashProviderBudgetStore({
    url: 'https://example.upstash.io/',
    token: 'server-secret',
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, options) => {
      request = { url, options, command: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ result: [1, 0] }) };
    },
  });
  const result = await store.reserveRequest({ windowMs: 86_400_000, requestLimit: 25, requestId: 'test-request' });
  assert.equal(request.url, 'https://example.upstash.io');
  assert.equal(request.options.headers.Authorization, 'Bearer server-secret');
  assert.equal(request.command[0], 'EVAL');
  assert.equal(request.command[2], '2');
  assert.equal(request.command[3], 'quantx:provider-budget:v1:requests');
  assert.equal(request.command[4], 'quantx:provider-budget:v1:cooldown');
  assert.equal(result.allowed, true);
  assert.equal(result.retryAfterSeconds, 0);
});

test('Upstash adapter reports quota exhaustion using milliseconds converted to Retry-After seconds', async () => {
  const store = createUpstashProviderBudgetStore({
    url: 'https://example.upstash.io',
    token: 'server-secret',
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [0, 2501] }) }),
  });
  const result = await store.reserveRequest({ windowMs: 10000, requestLimit: 1, requestId: 'blocked' });
  assert.deepEqual(result, { allowed: false, retryAfterSeconds: 3 });
});

test('Upstash adapter fails closed when credentials are partial or storage fails', async () => {
  assert.throws(
    () => createUpstashProviderBudgetStore({ url: 'https://example.upstash.io', token: '' }),
    { name: 'ProviderBudgetStorageError' },
  );
  const store = createUpstashProviderBudgetStore({
    url: 'https://example.upstash.io',
    token: 'server-secret',
    fetchImpl: async () => { throw new Error('private transport detail'); },
  });
  await assert.rejects(
    store.reserveRequest({ windowMs: 10000, requestLimit: 1, requestId: 'failure' }),
    { name: 'ProviderBudgetStorageError' },
  );
});

test('separate API handler instances share the provider request budget through one store', async () => {
  const shared = { requests: [], cooldownUntil: 0 };
  const providerBudgetStore = {
    async reserveRequest({ windowMs, requestLimit, requestId }) {
      const now = 1_800_000_000_000;
      shared.requests = shared.requests.filter((entry) => entry.time > now - windowMs);
      if (shared.cooldownUntil > now) return { allowed: false, retryAfterSeconds: 5 };
      if (shared.requests.length >= requestLimit) {
        return { allowed: false, retryAfterSeconds: 86400 };
      }
      shared.requests.push({ time: now, requestId });
      return { allowed: true, retryAfterSeconds: 0 };
    },
    async activateCooldown(duration) { shared.cooldownUntil = 1_800_000_000_000 + duration; },
  };
  let providerCalls = 0;
  const options = {
    apiKey: 'test-key',
    providerRequestLimit: 1,
    providerBudgetStore,
    fetchImpl: async () => {
      providerCalls += 1;
      return {
        ok: true,
        json: async () => ({ 'Global Quote': {
          '01. symbol': 'AAPL',
          '05. price': '101',
          '06. volume': '10',
          '07. latest trading day': '2026-11-23',
          '08. previous close': '100',
          '09. change': '1',
          '10. change percent': '1%',
        } }),
      };
    },
  };
  const firstHandler = createMarketDataApiHandler(options);
  const secondHandler = createMarketDataApiHandler(options);
  const firstResponse = responseRecorder();
  await firstHandler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, firstResponse);
  assert.equal(firstResponse.result().status, 200);

  const secondResponse = responseRecorder();
  await secondHandler({ method: 'GET', url: '/api/market-data/quote?symbol=MSFT' }, secondResponse);
  assert.equal(secondResponse.result().status, 429);
  assert.equal(secondResponse.result().body.status, 'rate_limited');
  assert.equal(providerCalls, 1);
});

test('provider cooldown is shared across separate API handler instances', async () => {
  const shared = { cooldownUntil: 0 };
  const providerBudgetStore = {
    async reserveRequest() {
      if (shared.cooldownUntil > 1_800_000_000_000) return { allowed: false, retryAfterSeconds: 5 };
      return { allowed: true, retryAfterSeconds: 0 };
    },
    async activateCooldown(duration) { shared.cooldownUntil = 1_800_000_000_000 + duration; },
  };
  let providerCalls = 0;
  const firstHandler = createMarketDataApiHandler({
    apiKey: 'test-key',
    providerBudgetStore,
    providerRateLimitCooldownMs: 5000,
    fetchImpl: async () => {
      providerCalls += 1;
      return { ok: true, json: async () => ({ Note: 'provider rate limit' }) };
    },
  });
  const secondHandler = createMarketDataApiHandler({
    apiKey: 'test-key',
    providerBudgetStore,
    providerRateLimitCooldownMs: 5000,
    fetchImpl: async () => {
      providerCalls += 1;
      return { ok: true, json: async () => ({}) };
    },
  });
  const firstResponse = responseRecorder();
  await firstHandler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, firstResponse);
  assert.equal(firstResponse.result().status, 429);

  const secondResponse = responseRecorder();
  await secondHandler({ method: 'GET', url: '/api/market-data/daily?symbol=MSFT' }, secondResponse);
  assert.equal(secondResponse.result().status, 429);
  assert.equal(secondResponse.result().headers['Retry-After'], '5');
  assert.equal(providerCalls, 1);
});

test('Upstash adapter uses an atomic fixed-window command for hashed client identifiers', async () => {
  let command;
  const store = createUpstashProviderBudgetStore({
    url: 'https://example.upstash.io',
    token: 'server-secret',
    fetchImpl: async (_url, options) => {
      command = JSON.parse(options.body);
      return { ok: true, json: async () => ({ result: [0, 1500] }) };
    },
  });
  const result = await store.reserveClientRequest({
    clientKey: 'sha256-digest',
    windowMs: 60000,
    requestLimit: 60,
  });
  assert.equal(command[0], 'EVAL');
  assert.equal(command[2], '1');
  assert.equal(command[3], 'quantx:client-rate-limit:v1:sha256-digest');
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterSeconds, 2);
});

test('partial Upstash environment configuration returns a safe 503 instead of crashing handler initialisation', async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  let providerCalls = 0;

  try {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const handler = createMarketDataApiHandler({
      apiKey: 'test-key',
      fetchImpl: async () => {
        providerCalls += 1;
        return { ok: true, json: async () => ({}) };
      },
    });
    const response = responseRecorder();
    await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);

    assert.equal(response.result().status, 503);
    assert.equal(response.result().body.status, 'unavailable');
    assert.equal(JSON.stringify(response.result().body).includes('example.upstash.io'), false);
    assert.equal(providerCalls, 0);
  } finally {
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});


test('Upstash adapter rejects malformed provider-budget reservation decisions', async () => {
  const malformedResults = [null, [], [2, 0], [0, 'not-a-number'], [0, -1]];
  for (const result of malformedResults) {
    const store = createUpstashProviderBudgetStore({
      url: 'https://example.upstash.io',
      token: 'server-secret',
      fetchImpl: async () => ({ ok: true, json: async () => ({ result }) }),
    });
    await assert.rejects(
      store.reserveRequest({ windowMs: 10000, requestLimit: 1, requestId: 'malformed' }),
      { name: 'ProviderBudgetStorageError' },
      `malformed provider reservation should fail closed: ${JSON.stringify(result)}`,
    );
    await assert.rejects(
      store.reserveClientRequest({ clientKey: 'sha256-digest', windowMs: 60000, requestLimit: 60 }),
      { name: 'ProviderBudgetStorageError' },
    );
  }
});

test('Upstash adapter rejects unreadable and unsuccessful REST responses', async () => {
  const storeWith = (fetchImpl) => createUpstashProviderBudgetStore({
    url: 'https://example.upstash.io',
    token: 'server-secret',
    fetchImpl,
  });
  const cases = [
    async () => ({ ok: false, json: async () => ({ result: [1, 0] }) }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('private response detail'); } }),
    async () => ({ ok: true, json: async () => ({ error: 'private server detail' }) }),
    async () => ({ ok: true, json: async () => ({}) }),
  ];
  for (const fetchImpl of cases) {
    await assert.rejects(
      storeWith(fetchImpl).reserveRequest({ windowMs: 10000, requestLimit: 1, requestId: 'invalid-response' }),
      { name: 'ProviderBudgetStorageError' },
    );
  }
});


test('Upstash adapter refuses insecure or ambiguous endpoints before sending credentials', async () => {
  const invalidUrls = [
    'http://example.upstash.io',
    'not-a-url',
    'https://user:password@example.upstash.io',
    'https://example.upstash.io/path',
    'https://example.upstash.io/?redirect=elsewhere',
    'https://example.upstash.io/#fragment',
  ];
  for (const url of invalidUrls) {
    let calls = 0;
    assert.throws(
      () => createUpstashProviderBudgetStore({
        url,
        token: 'server-secret',
        fetchImpl: async () => { calls += 1; },
      }),
      { name: 'ProviderBudgetStorageError' },
      `endpoint should be rejected: ${url}`,
    );
    assert.equal(calls, 0, 'invalid endpoints must be rejected before any request is sent');
  }
});
