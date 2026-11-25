import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestVersion } from '../src/request-version.js';

test('only the newest request version may update shared UI state', () => {
  const requests = createRequestVersion();
  const first = requests.next();
  const second = requests.next();

  assert.equal(requests.isCurrent(first), false);
  assert.equal(requests.isCurrent(second), true);
});

test('selection changes invalidate requests that are still in flight', () => {
  const requests = createRequestVersion();
  const pending = requests.next();

  requests.invalidate();

  assert.equal(requests.isCurrent(pending), false);
});

test('a request remains current until another request starts or invalidates it', () => {
  const requests = createRequestVersion();
  const current = requests.next();

  assert.equal(requests.isCurrent(current), true);
  assert.equal(requests.isCurrent(current + 1), false);
});
