import { verifyUpstashConnectivity } from '../server/upstash-connectivity.js';

try {
  await verifyUpstashConnectivity({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('Upstash Redis connectivity verified: PING returned PONG.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
