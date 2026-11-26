export async function verifyUpstashConnectivity({
  url,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  if (typeof url !== 'string' || !url.trim() || typeof token !== 'string' || !token.trim()) {
    throw new Error('Upstash connectivity check requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
  }

  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error('Upstash REST URL is invalid.');
  }

  if (
    endpoint.protocol !== 'https:'
    || !endpoint.hostname
    || endpoint.username
    || endpoint.password
    || endpoint.pathname !== '/'
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error('Upstash REST URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('Upstash connectivity check requires a fetch implementation.');
  }

  let response;
  try {
    response = await fetchImpl(`${endpoint.origin}/ping`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Unable to reach Upstash Redis. Check the deployment secrets and network connectivity.');
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 'unknown';
    throw new Error(`Upstash connectivity check failed with HTTP ${status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Upstash connectivity check returned invalid JSON.');
  }

  if (!payload || typeof payload !== 'object' || payload.error || payload.result !== 'PONG') {
    throw new Error('Upstash responded, but the PING result was not the expected PONG.');
  }

  return true;
}
