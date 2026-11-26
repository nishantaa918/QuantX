const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error('Upstash connectivity check requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
  process.exit(1);
}

let endpoint;
try {
  endpoint = new URL(url);
} catch {
  console.error('Upstash REST URL is invalid.');
  process.exit(1);
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
  console.error('Upstash REST URL must be an HTTPS origin without credentials, path, query, or fragment.');
  process.exit(1);
}

try {
  const response = await fetch(`${endpoint.origin}/ping`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    console.error(`Upstash connectivity check failed with HTTP ${response.status}.`);
    process.exit(1);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error('Upstash connectivity check returned invalid JSON.');
    process.exit(1);
  }

  if (payload?.error || payload?.result !== 'PONG') {
    console.error('Upstash responded, but the PING result was not the expected PONG.');
    process.exit(1);
  }

  console.log('Upstash Redis connectivity verified: PING returned PONG.');
} catch {
  console.error('Unable to reach Upstash Redis. Check the deployment secrets and network connectivity.');
  process.exit(1);
}
