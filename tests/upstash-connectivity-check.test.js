import assert from 'node:assert/strict';
import test from 'node:test';
import { checkUpstashConnectivity } from '../scripts/upstash-connectivity-check.mjs';

const validConfig = {
  url: 'https://example.upstash.io/',
  token: 'test-token',
};

test('connectivity check sends an authenticated HTTPS PING and accepts PONG', async () => {
  let request;
  const result = await checkUpstashConnectivity({
    ...validConfig,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ result: 'PONG' }) };
    },
  });

  assert.equal(request.url, 'https://example.upstash.io/ping');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(result, { status: 'ok', result: 'PONG' });
});

test('connectivity check rejects missing URL or token without making a request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  await assert.rejects(checkUpstashConnectivity({ url: '', token: 'token', fetchImpl }), /both configured credentials/);
  await assert.rejects(checkUpstashConnectivity({ url: validConfig.url, token: '', fetchImpl }), /both configured credentials/);
  assert.equal(calls, 0);
});

test('connectivity check rejects malformed and unsafe endpoints before sending credentials', async () => {
  const invalidUrls = [
    'not-a-url',
    'http://example.upstash.io',
    'https://user:password@example.upstash.io',
    'https://example.upstash.io/path',
    'https://example.upstash.io/?redirect=elsewhere',
    'https://example.upstash.io/#fragment',
  ];
  for (const url of invalidUrls) {
    let calls = 0;
    await assert.rejects(
      checkUpstashConnectivity({ url, token: validConfig.token, fetchImpl: async () => { calls += 1; } }),
      /invalid|HTTPS origin/,
      `unsafe endpoint should be rejected: ${url}`,
    );
    assert.equal(calls, 0);
  }
});

test('connectivity check rejects unsuccessful HTTP responses', async () => {
  await assert.rejects(
    checkUpstashConnectivity({
      ...validConfig,
      fetchImpl: async () => ({ ok: false, status: 401 }),
    }),
    /HTTP 401/,
  );
});

test('connectivity check rejects unreadable JSON responses', async () => {
  await assert.rejects(
    checkUpstashConnectivity({
      ...validConfig,
      fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('private body'); } }),
    }),
    /invalid JSON/,
  );
});

test('connectivity check rejects errors and unexpected PING results', async () => {
  const payloads = [
    { error: 'private provider detail' },
    { result: 'PONG ' },
    { result: 'OK' },
    {},
    null,
  ];
  for (const payload of payloads) {
    await assert.rejects(
      checkUpstashConnectivity({
        ...validConfig,
        fetchImpl: async () => ({ ok: true, json: async () => payload }),
      }),
      /expected PONG/,
    );
  }
});

test('connectivity check hides network error details', async () => {
  await assert.rejects(
    checkUpstashConnectivity({
      ...validConfig,
      fetchImpl: async () => { throw new Error('private token or endpoint detail'); },
    }),
    (error) => {
      assert.equal(error.message, 'Unable to reach Upstash Redis.');
      assert.equal(error.message.includes('private token'), false);
      return true;
    },
  );
});
