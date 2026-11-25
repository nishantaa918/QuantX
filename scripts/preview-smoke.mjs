import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const baseUrl = 'http://127.0.0.1:4173';
const server = spawn('npm', [
  'run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173', '--strictPort',
], { stdio: 'inherit', env: process.env });

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite preview exited early with code ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.status === 200) return;
      lastError = new Error(`Health endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not become healthy: ${lastError?.message || 'timeout'}`);
}

try {
  await waitForServer();

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200, 'GET /api/health should return HTTP 200');
  assert.match(health.headers.get('content-type') || '', /application\/json/i);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.service, 'quantx-api');
  assert.ok(Number.isFinite(Date.parse(healthBody.timestamp)));

  const healthMethod = await fetch(`${baseUrl}/api/health`, { method: 'POST' });
  assert.equal(healthMethod.status, 405, 'POST /api/health should be rejected');
  assert.equal(healthMethod.headers.get('allow'), 'GET');

  const marketMethod = await fetch(`${baseUrl}/api/market-data/quote?symbol=AAPL`, { method: 'POST' });
  assert.equal(marketMethod.status, 405, 'Market-data routes should reject unsupported methods');

  console.log('Preview smoke tests passed: health GET, health method guard, and market-data method guard.');
} finally {
  server.kill('SIGTERM');
}
