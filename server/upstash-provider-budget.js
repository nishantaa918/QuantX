const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local cooldownTtl = redis.call('PTTL', KEYS[2])
if cooldownTtl > 0 then
  return {0, cooldownTtl}
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retryMs = windowMs
  if oldest[2] then retryMs = tonumber(oldest[2]) + windowMs - now end
  if retryMs < 1 then retryMs = 1 end
  return {0, retryMs}
end
redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], windowMs + 1000)
return {1, 0}
`;

const CLIENT_RATE_LIMIT_SCRIPT = `
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= limit then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 1 then ttl = windowMs end
  return {0, ttl}
end
count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], windowMs) end
local ttl = redis.call('PTTL', KEYS[1])
return {1, ttl}
`;

const COOLDOWN_SCRIPT = `
local ttl = tonumber(ARGV[1])
redis.call('SET', KEYS[1], '1', 'PX', ttl)
return ttl
`;

function parseReservationResult(result) {
  if (!Array.isArray(result) || result.length < 2) throw new ProviderBudgetStorageError();
  const decision = Number(result[0]);
  const retryMs = Number(result[1]);
  if (![0, 1].includes(decision) || !Number.isFinite(retryMs) || retryMs < 0) {
    throw new ProviderBudgetStorageError();
  }
  return decision === 1;
}

export class ProviderBudgetStorageError extends Error {
  constructor(message = 'Persistent provider budget storage is unavailable.') {
    super(message);
    this.name = 'ProviderBudgetStorageError';
  }
}

export function createUpstashProviderBudgetStore({
  url = process.env.UPSTASH_REDIS_REST_URL,
  token = process.env.UPSTASH_REDIS_REST_TOKEN,
  fetchImpl = globalThis.fetch,
  keyPrefix = 'quantx:provider-budget:v1',
  now = () => Date.now(),
} = {}) {
  if (!url && !token) return null;
  if (!url || !token || typeof fetchImpl !== 'function') {
    throw new ProviderBudgetStorageError('Persistent provider budget storage is not fully configured.');
  }

  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(url);
  } catch {
    throw new ProviderBudgetStorageError('Persistent provider budget endpoint must be a valid HTTPS URL.');
  }
  if (
    parsedEndpoint.protocol !== 'https:'
    || !parsedEndpoint.hostname
    || parsedEndpoint.username
    || parsedEndpoint.password
    || parsedEndpoint.pathname !== '/'
    || parsedEndpoint.search
    || parsedEndpoint.hash
  ) {
    throw new ProviderBudgetStorageError('Persistent provider budget endpoint must be a valid HTTPS URL.');
  }
  const endpoint = parsedEndpoint.origin;
  const budgetKey = `${keyPrefix}:requests`;
  const cooldownKey = `${keyPrefix}:cooldown`;
  const clientRateLimitPrefix = 'quantx:client-rate-limit:v1';

  async function execute(command) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ProviderBudgetStorageError();
    }
    if (!response.ok) throw new ProviderBudgetStorageError();
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderBudgetStorageError();
    }
    if (payload?.error || !Object.hasOwn(payload ?? {}, 'result')) {
      throw new ProviderBudgetStorageError();
    }
    return payload.result;
  }

  return {
    async reserveRequest({ windowMs, requestLimit, requestId }) {
      const timestamp = now();
      const result = await execute([
        'EVAL',
        RESERVE_SCRIPT,
        '2',
        budgetKey,
        cooldownKey,
        String(timestamp),
        String(windowMs),
        String(requestLimit),
        String(requestId ?? `${timestamp}:${Math.random().toString(36).slice(2)}`),
      ]);
      const allowed = parseReservationResult(result);
      return {
        allowed,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(Number(result[1]) / 1000)),
      };
    },

    async reserveClientRequest({ clientKey, windowMs, requestLimit }) {
      const result = await execute([
        'EVAL',
        CLIENT_RATE_LIMIT_SCRIPT,
        '1',
        `${clientRateLimitPrefix}:${clientKey}`,
        String(requestLimit),
        String(windowMs),
      ]);
      const allowed = parseReservationResult(result);
      return {
        allowed,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(Number(result[1]) / 1000)),
      };
    },

    async activateCooldown(cooldownMs) {
      const result = await execute([
        'EVAL',
        COOLDOWN_SCRIPT,
        '1',
        cooldownKey,
        String(Math.max(1, Math.ceil(cooldownMs))),
      ]);
      if (!Number.isFinite(Number(result))) throw new ProviderBudgetStorageError();
    },
  };
}
