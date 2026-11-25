import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthApiHandler } from '../api/health.js';

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

test('health endpoint returns a minimal liveness response without exposing configuration', async () => {
  const handler = createHealthApiHandler({ now: () => Date.parse('2026-11-25T12:00:00.000Z') });
  const response = responseRecorder();
  await handler({ method: 'GET' }, response);
  const result = response.result();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    status: 'ok',
    service: 'quantx-api',
    timestamp: '2026-11-25T12:00:00.000Z',
  });
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(JSON.stringify(result.body).includes('ALPHA_VANTAGE'), false);
  assert.equal(JSON.stringify(result.body).includes('UPSTASH'), false);
});

test('health endpoint rejects unsupported methods', async () => {
  const handler = createHealthApiHandler();
  const response = responseRecorder();
  await handler({ method: 'POST' }, response);
  const result = response.result();
  assert.equal(result.status, 405);
  assert.equal(result.headers.Allow, 'GET');
  assert.equal(result.body.status, 'error');
});
