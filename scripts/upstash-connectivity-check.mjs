import { pathToFileURL } from 'node:url';

export async function checkUpstashConnectivity({
  url = process.env.UPSTASH_REDIS_REST_URL,
  token = process.env.UPSTASH_REDIS_REST_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (!url || !token) {
    throw new Error('Upstash connectivity check requires both configured credentials.');
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

  let response;
  try {
    response = await fetchImpl(`${endpoint.origin}/ping`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('Unable to reach Upstash Redis.');
  }

  if (!response.ok) {
    throw new Error(`Upstash connectivity check failed with HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Upstash connectivity check returned invalid JSON.');
  }

  if (payload?.error || payload?.result !== 'PONG') {
    throw new Error('Upstash responded, but PING did not return the expected PONG.');
  }

  return { status: 'ok', result: 'PONG' };
}

async function runCli() {
  try {
    await checkUpstashConnectivity();
    console.log('Upstash Redis connectivity verified: PING returned PONG.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
