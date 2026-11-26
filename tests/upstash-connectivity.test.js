import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyUpstashConnectivity } from '../server/upstash-connectivity.js';

test('Upstash verifier sends an authenticated read-only PING and accepts PONG', async () => {
  let request;
  const result = await verifyUpstashConnectivity({
    url: 'https://example.upstash.io/',
    token: 'private-token',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ result: 'PONG' }) };
    },
  });

  assert.equal(result, true);
  assert.equal(request.url, 'https://example.upstash.io/ping');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer private-token');
  assert.ok(request.options.signal);
});

test('Upstash verifier rejects missing credentials without making a request', async () => {
  let calls = 0;
  await assert.rejects(
    verifyUpstashConnectivity({
      url: 'https://example.upstash.io',
      token: '',
      fetchImpl: async () => { calls += 1; },
    }),
    /requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN/,
  );
  assert.equal(calls, 0);
});

test('Upstash verifier rejects insecure and ambiguous URLs before sending the token', async () => {
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
    await assert.rejects(
      verifyUpstashConnectivity({
        url,
        token: 'private-token',
        fetchImpl: async () => { calls += 1; },
      }),
      /Upstash REST URL/,
      `URL should be rejected: ${url}`,
    );
    assert.equal(calls, 0);
  }
});

test('Upstash verifier rejects unsuccessful HTTP responses without exposing response details', async () => {
  await assert.rejects(
    verifyUpstashConnectivity({
      url: 'https://example.upstash.io',
      token: 'private-token',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'private detail' }) }),
    }),
    /HTTP 401/,
  );
});

test('Upstash verifier rejects invalid JSON, Redis errors, and non-PONG responses', async () => {
  const invalidResponses = [
    { ok: true, json: async () => { throw new SyntaxError('private response detail'); } },
    { ok: true, json: async () => ({ error: 'private Redis detail', result: null }) },
    { ok: true, json: async () => ({ result: 'OK' }) },
    { ok: true, json: async () => null },
  ];

  for (const response of invalidResponses) {
    await assert.rejects(
      verifyUpstashConnectivity({
        url: 'https://example.upstash.io',
        token: 'private-token',
        fetchImpl: async () => response,
      }),
      /invalid JSON|not the expected PONG/i,
    );
  }
});

test('Upstash verifier sanitizes network errors', async () => {
  await assert.rejects(
    verifyUpstashConnectivity({
      url: 'https://example.upstash.io',
      token: 'private-token',
      fetchImpl: async () => { throw new Error('private transport detail'); },
    }),
    (error) => {
      assert.match(error.message, /Unable to reach Upstash Redis/);
      assert.equal(error.message.includes('private transport detail'), false);
      return true;
    },
  );
});
