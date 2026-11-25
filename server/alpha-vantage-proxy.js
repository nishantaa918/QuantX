import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { normalizeAlphaVantageDaily, SUPPORTED_HISTORICAL_SYMBOLS } from '../src/market-data.js';
import { createUpstashProviderBudgetStore } from './upstash-provider-budget.js';

const DAILY_ROUTE = '/api/market-data/daily';
const QUOTE_ROUTE = '/api/market-data/quote';
const QUOTE_CACHE_TTL_MS = 60 * 1000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const PROVIDER_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROVIDER_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const CLIENT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CLIENT_RATE_LIMIT_DEFAULT = 60;


async function fetchProviderOnce(inFlight, key, fetchImpl, providerUrl, budget, providerBudgetStore) {
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = (async () => {
    const currentTime = budget.now();
    if (providerBudgetStore) {
      const reservation = await providerBudgetStore.reserveRequest({ windowMs: budget.windowMs, requestLimit: budget.requestLimit, requestId: String(currentTime) + ':' + Math.random().toString(36).slice(2) });
      if (!reservation.allowed) return { budgetBlocked: true, retryAfterSeconds: reservation.retryAfterSeconds };
    } else {
      budget.requestTimestamps = budget.requestTimestamps.filter((timestamp) => timestamp > currentTime - budget.windowMs);
      if (budget.cooldownUntil > currentTime) return { budgetBlocked: true, retryAfterSeconds: Math.ceil((budget.cooldownUntil - currentTime) / 1000) };
      if (budget.requestTimestamps.length >= budget.requestLimit) {
        const retryAt = budget.requestTimestamps[0] + budget.windowMs;
        return { budgetBlocked: true, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - currentTime) / 1000)) };
      }
      budget.requestTimestamps.push(currentTime);
    }
    const upstream = await fetchImpl(providerUrl, { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) return { upstream, providerPayload: null };
    const providerPayload = await upstream.json();
    if (providerPayload?.Note) {
      if (providerBudgetStore) await providerBudgetStore.activateCooldown(budget.cooldownMs);
      else budget.cooldownUntil = Math.max(budget.cooldownUntil, budget.now() + budget.cooldownMs);
    }
    return { upstream, providerPayload };
  })();
  inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
}


function pruneExpiredCache(cache, currentTime) {
  for (const [key, entry] of cache) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= currentTime) {
      cache.delete(key);
    }
  }
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseQuoteNumber(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return Number.NaN;
  const normalized = typeof value === 'string' ? value.trim().replace(/%$/, '') : value;
  return Number(normalized);
}

function getClientIp(request) {
  const headers = request.headers;
  const value = typeof headers?.get === 'function'
    ? headers.get('x-forwarded-for')
    : headers?.['x-forwarded-for'] ?? headers?.['X-Forwarded-For'];
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.split(',')[0].trim();
  return isIP(candidate) ? candidate : '';
}

function attachRequestLogging(request, response, requestUrl, startedAt, now, logger) {
  if (!logger || typeof response.end !== 'function') return;
  const originalEnd = response.end.bind(response);
  let logged = false;
  response.end = (body) => {
    if (!logged) {
      logged = true;
      const status = Number(response.statusCode) || 200;
      const event = {
        event: 'quantx_market_data_request',
        route: requestUrl.pathname,
        method: request.method,
        status,
        durationMs: Math.max(0, now() - startedAt),
      };
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      try {
        if (typeof logger[level] === 'function') logger[level](JSON.stringify(event));
      } catch {
        // Logging must never prevent an API response from completing.
      }
    }
    return originalEnd(body);
  };
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(payload));
}

export function createAlphaVantageMiddleware({
  apiKey = process.env.ALPHA_VANTAGE_API_KEY,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheTtlMs = CACHE_TTL_MS,
  quoteCacheTtlMs = QUOTE_CACHE_TTL_MS,
  providerRequestLimit = Number(process.env.ALPHA_VANTAGE_DAILY_REQUEST_LIMIT) || 25,
  providerWindowMs = PROVIDER_REQUEST_WINDOW_MS,
  providerRateLimitCooldownMs = PROVIDER_RATE_LIMIT_COOLDOWN_MS,
  providerBudgetStore,
  clientRequestLimit = Number(process.env.QUANTX_CLIENT_REQUEST_LIMIT) || CLIENT_RATE_LIMIT_DEFAULT,
  clientRateLimitWindowMs = CLIENT_RATE_LIMIT_WINDOW_MS,
  logger = process.env.VERCEL === '1' ? console : null,
} = {}) {
  let effectiveProviderBudgetStore = providerBudgetStore;
  let providerBudgetStoreInitializationFailed = false;
  if (effectiveProviderBudgetStore === undefined) {
    try {
      effectiveProviderBudgetStore = createUpstashProviderBudgetStore();
    } catch {
      providerBudgetStoreInitializationFailed = true;
    }
  }
  const cache = new Map();
  const inFlight = new Map();
  const clientRequests = new Map();
  const effectiveClientRequestLimit = Number.isInteger(clientRequestLimit) && clientRequestLimit > 0 ? clientRequestLimit : CLIENT_RATE_LIMIT_DEFAULT;
  const effectiveClientWindowMs = Number.isFinite(clientRateLimitWindowMs) && clientRateLimitWindowMs > 0 ? clientRateLimitWindowMs : CLIENT_RATE_LIMIT_WINDOW_MS;
  const providerBudget = {
    now,
    requestLimit: Number.isInteger(providerRequestLimit) && providerRequestLimit > 0 ? providerRequestLimit : 25,
    windowMs: Number.isFinite(providerWindowMs) && providerWindowMs > 0 ? providerWindowMs : PROVIDER_REQUEST_WINDOW_MS,
    cooldownMs: Number.isFinite(providerRateLimitCooldownMs) && providerRateLimitCooldownMs > 0 ? providerRateLimitCooldownMs : PROVIDER_RATE_LIMIT_COOLDOWN_MS,
    requestTimestamps: [],
    cooldownUntil: 0,
  };
  return async function alphaVantageMiddleware(request, response, next) {
    const requestUrl = new URL(request.url, 'http://localhost');
    const isDaily = requestUrl.pathname === DAILY_ROUTE;
    const isQuote = requestUrl.pathname === QUOTE_ROUTE;
    if (!isDaily && !isQuote) return next();
    attachRequestLogging(request, response, requestUrl, now(), now, logger);
    if (request.method !== 'GET') return sendJson(response, 405, { status: 'error', message: 'Use GET for market data.' });
    if (providerBudgetStoreInitializationFailed) {
      return sendJson(response, 503, { status: 'unavailable', message: 'Request protection is temporarily unavailable. Please retry shortly.' });
    }
    const symbol = (requestUrl.searchParams.get('symbol') ?? 'AAPL').trim().toUpperCase();
    const adjustment = (requestUrl.searchParams.get('adjustment') ?? 'raw').trim().toLowerCase();
    if (!SUPPORTED_HISTORICAL_SYMBOLS.includes(symbol)) {
      return sendJson(response, 400, { status: 'error', message: `Unsupported symbol. Supported symbols: ${SUPPORTED_HISTORICAL_SYMBOLS.join(', ')}.` });
    }
    if (isDaily && !['raw', 'adjusted'].includes(adjustment)) {
      return sendJson(response, 400, { status: 'error', message: 'Adjustment must be raw or adjusted.' });
    }
    const clientIp = getClientIp(request);
    if (clientIp === '') return sendJson(response, 400, { status: 'error', message: 'The client address could not be validated.' });
    if (clientIp) {
      const clientKey = createHash('sha256').update(clientIp).digest('hex');
      let reservation;
      try {
        if (effectiveProviderBudgetStore) {
          reservation = await effectiveProviderBudgetStore.reserveClientRequest({ clientKey, windowMs: effectiveClientWindowMs, requestLimit: effectiveClientRequestLimit });
        } else {
          const currentTime = now();
          for (const [key, entry] of clientRequests) if (entry.resetAt <= currentTime) clientRequests.delete(key);
          let entry = clientRequests.get(clientKey);
          if (!entry || entry.resetAt <= currentTime) {
            entry = { count: 0, resetAt: currentTime + effectiveClientWindowMs };
            clientRequests.set(clientKey, entry);
          }
          if (entry.count >= effectiveClientRequestLimit) {
            reservation = { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000)) };
          } else {
            entry.count += 1;
            reservation = { allowed: true, retryAfterSeconds: 0 };
          }
          if (clientRequests.size > 5000) clientRequests.delete(clientRequests.keys().next().value);
        }
      } catch {
        return sendJson(response, 503, { status: 'unavailable', message: 'Request protection is temporarily unavailable. Please retry shortly.' });
      }
      if (!reservation.allowed) {
        response.setHeader('Retry-After', String(reservation.retryAfterSeconds));
        return sendJson(response, 429, { status: 'rate_limited', message: 'Too many market-data requests. Please wait before trying again.' });
      }
    }
    pruneExpiredCache(cache, now());

    if (!apiKey) {
      return sendJson(response, 503, { status: 'unavailable', message: isQuote ? 'Quote data is unavailable: the server-side Alpha Vantage key is not configured.' : 'Historical data is unavailable: the server-side Alpha Vantage key is not configured.' });
    }

    if (isQuote) {
      const cacheKey = `quote:${symbol}`;
      const cached = cache.get(cacheKey);
      if (requestUrl.searchParams.get('refresh') !== '1' && cached && cached.expiresAt > now()) return sendJson(response, 200, cached.payload);
      try {
        const providerUrl = new URL('https://www.alphavantage.co/query');
        providerUrl.search = new URLSearchParams({ function: 'GLOBAL_QUOTE', symbol, apikey: apiKey }).toString();
        const { upstream, providerPayload, budgetBlocked, retryAfterSeconds } = await fetchProviderOnce(inFlight, cacheKey, fetchImpl, providerUrl, providerBudget, effectiveProviderBudgetStore);
        if (budgetBlocked) {
          response.setHeader('Retry-After', String(retryAfterSeconds));
          return sendJson(response, 429, { status: 'rate_limited', message: 'Market-data provider request budget is temporarily exhausted. Please retry after the indicated delay.' });
        }
        if (!upstream.ok) return sendJson(response, 502, { status: 'error', message: `Alpha Vantage returned HTTP ${upstream.status}.` });
        if (providerPayload?.Note) {
          response.setHeader('Retry-After', String(Math.ceil(providerBudget.cooldownMs / 1000)));
          return sendJson(response, 429, { status: 'rate_limited', message: 'The quote provider rate limit was reached. Requests are temporarily paused.' });
        }
        if (providerPayload?.Information) {
          return sendJson(response, 503, { status: 'unavailable', message: 'The quote endpoint is unavailable for the current provider plan or configuration.' });
        }
        if (providerPayload?.['Error Message']) return sendJson(response, 502, { status: 'error', message: 'Alpha Vantage rejected the quote request.' });
        const quote = providerPayload?.['Global Quote'];
        const providerSymbol = quote?.['01. symbol']?.toUpperCase();
        const price = parseQuoteNumber(quote?.['05. price']);
        const previousClose = parseQuoteNumber(quote?.['08. previous close']);
        const change = parseQuoteNumber(quote?.['09. change']);
        const changePercent = parseQuoteNumber(quote?.['10. change percent']);
        const volume = parseQuoteNumber(quote?.['06. volume']);
        const latestTradingDay = quote?.['07. latest trading day'];
        const expectedChange = price - previousClose;
        const expectedChangePercent = (change / previousClose) * 100;
        const quoteFieldsValid = providerSymbol === symbol
          && Number.isFinite(price) && price > 0
          && Number.isFinite(previousClose) && previousClose > 0
          && Number.isFinite(change)
          && Number.isFinite(changePercent)
          && Number.isSafeInteger(volume) && volume >= 0
          && isValidIsoDate(latestTradingDay);
        const quoteMathValid = quoteFieldsValid
          && Math.abs(change - expectedChange) <= 0.011
          && Math.abs(changePercent - expectedChangePercent) <= 0.02;
        if (!quoteMathValid) {
          return sendJson(response, 502, { status: 'unavailable', message: 'The provider returned no complete quote snapshot for this symbol.' });
        }
        const payload = {
          status: 'quote',
          data: { symbol, price, previousClose, change, changePercent, volume, latestTradingDay, provider: 'Alpha Vantage', quoteType: 'provider_snapshot' },
          lastUpdated: new Date(now()).toISOString(),
        };
        cache.set(cacheKey, { payload, expiresAt: now() + quoteCacheTtlMs });
        return sendJson(response, 200, payload);
      } catch (error) {
        if (error?.name === 'ProviderBudgetStorageError') return sendJson(response, 503, { status: 'unavailable', message: 'Market-data requests are paused because shared quota protection is temporarily unavailable.' });
        const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? 'The quote provider did not respond before the request timeout.'
          : error instanceof SyntaxError
            ? 'The quote provider returned an unreadable response.'
            : 'Could not retrieve a quote snapshot.';
        return sendJson(response, 502, { status: 'error', message });
      }
    }

    const cacheKey = `${symbol}:${adjustment}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return sendJson(response, 200, cached.payload);

    try {
      const providerUrl = new URL('https://www.alphavantage.co/query');
      providerUrl.search = new URLSearchParams({
        function: adjustment === 'adjusted' ? 'TIME_SERIES_DAILY_ADJUSTED' : 'TIME_SERIES_DAILY',
        symbol,
        outputsize: 'compact',
        apikey: apiKey,
      }).toString();
      const { upstream, providerPayload, budgetBlocked, retryAfterSeconds } = await fetchProviderOnce(inFlight, 'daily:' + cacheKey, fetchImpl, providerUrl, providerBudget, effectiveProviderBudgetStore);
      if (budgetBlocked) {
        response.setHeader('Retry-After', String(retryAfterSeconds));
        return sendJson(response, 429, { status: 'rate_limited', message: 'Market-data provider request budget is temporarily exhausted. Please retry after the indicated delay.' });
      }
      if (!upstream.ok) return sendJson(response, 502, { status: 'error', message: `Alpha Vantage returned HTTP ${upstream.status}.` });
      if (providerPayload?.Note) {
        response.setHeader('Retry-After', String(Math.ceil(providerBudget.cooldownMs / 1000)));
        return sendJson(response, 429, { status: 'rate_limited', message: 'Alpha Vantage rate limit reached. Requests are temporarily paused.' });
      }
      if (providerPayload?.Information) {
        return sendJson(response, 503, { status: 'unavailable', message: 'This Alpha Vantage endpoint is unavailable for the current provider plan or configuration.' });
      }
      if (providerPayload?.['Error Message']) {
        return sendJson(response, 502, { status: 'error', message: 'Alpha Vantage rejected the daily-data request.' });
      }

      const normalized = normalizeAlphaVantageDaily(providerPayload, { symbol, limit: 100 });
      if (adjustment === 'adjusted' && normalized.adjustment !== 'raw_with_adjusted_close') {
        return sendJson(response, 502, { status: 'error', message: 'The provider response did not include adjusted closes and corporate-action fields.' });
      }
      const payload = {
        status: 'historical',
        data: { ...normalized, requestedAdjustment: adjustment },
        lastUpdated: new Date(now()).toISOString(),
      };
      cache.set(cacheKey, { payload, expiresAt: now() + cacheTtlMs });
      return sendJson(response, 200, payload);
    } catch (error) {
      if (error?.name === 'ProviderBudgetStorageError') return sendJson(response, 503, { status: 'unavailable', message: 'Market-data requests are paused because shared quota protection is temporarily unavailable.' });
      const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'Alpha Vantage did not respond before the request timeout.'
        : error instanceof SyntaxError
          ? 'Alpha Vantage returned an unreadable response.'
          : error?.message?.startsWith('Invalid') || error?.message?.startsWith('Inconsistent')
            ? error.message
            : `Could not retrieve ${symbol} daily historical data.`;
      return sendJson(response, 502, { status: 'error', message });
    }
  };
}
