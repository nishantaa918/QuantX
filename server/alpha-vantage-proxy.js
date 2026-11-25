import { normalizeAlphaVantageDaily, SUPPORTED_HISTORICAL_SYMBOLS } from '../src/market-data.js';

const DAILY_ROUTE = '/api/market-data/daily';
const QUOTE_ROUTE = '/api/market-data/quote';
const QUOTE_CACHE_TTL_MS = 60 * 1000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const PROVIDER_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROVIDER_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;


async function fetchProviderOnce(inFlight, key, fetchImpl, providerUrl, budget) {
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = (async () => {
    const currentTime = budget.now();
    budget.requestTimestamps = budget.requestTimestamps.filter((timestamp) => timestamp > currentTime - budget.windowMs);
    if (budget.cooldownUntil > currentTime) {
      return { budgetBlocked: true, retryAfterSeconds: Math.ceil((budget.cooldownUntil - currentTime) / 1000) };
    }
    if (budget.requestTimestamps.length >= budget.requestLimit) {
      const retryAt = budget.requestTimestamps[0] + budget.windowMs;
      return { budgetBlocked: true, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - currentTime) / 1000)) };
    }
    budget.requestTimestamps.push(currentTime);
    const upstream = await fetchImpl(providerUrl, { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) return { upstream, providerPayload: null };
    const providerPayload = await upstream.json();
    if (providerPayload?.Note) budget.cooldownUntil = Math.max(budget.cooldownUntil, budget.now() + budget.cooldownMs);
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
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
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
    if (request.method !== 'GET') return sendJson(response, 405, { status: 'error', message: 'Use GET for market data.' });
    const symbol = (requestUrl.searchParams.get('symbol') ?? 'AAPL').trim().toUpperCase();
    const adjustment = (requestUrl.searchParams.get('adjustment') ?? 'raw').trim().toLowerCase();
    if (!SUPPORTED_HISTORICAL_SYMBOLS.includes(symbol)) {
      return sendJson(response, 400, { status: 'error', message: `Unsupported symbol. Supported symbols: ${SUPPORTED_HISTORICAL_SYMBOLS.join(', ')}.` });
    }
    if (isDaily && !['raw', 'adjusted'].includes(adjustment)) {
      return sendJson(response, 400, { status: 'error', message: 'Adjustment must be raw or adjusted.' });
    }
    pruneExpiredCache(cache, now());

    if (!apiKey) {
      return sendJson(response, 503, { status: 'unavailable', message: 'Historical data is unavailable: the server-side Alpha Vantage key is not configured.' });
    }

    if (isQuote) {
      const cacheKey = `quote:${symbol}`;
      const cached = cache.get(cacheKey);
      if (requestUrl.searchParams.get('refresh') !== '1' && cached && cached.expiresAt > now()) return sendJson(response, 200, cached.payload);
      try {
        const providerUrl = new URL('https://www.alphavantage.co/query');
        providerUrl.search = new URLSearchParams({ function: 'GLOBAL_QUOTE', symbol, apikey: apiKey }).toString();
        const { upstream, providerPayload, budgetBlocked, retryAfterSeconds } = await fetchProviderOnce(inFlight, cacheKey, fetchImpl, providerUrl, providerBudget);
        if (!upstream.ok) return sendJson(response, 502, { status: 'error', message: `Alpha Vantage returned HTTP ${upstream.status}.` });
        if (budgetBlocked) {
          response.setHeader('Retry-After', String(retryAfterSeconds));
          return sendJson(response, 429, { status: 'rate_limited', message: 'Market-data provider request budget is temporarily exhausted. Please retry after the indicated delay.' });
        }
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
      const { upstream, providerPayload, budgetBlocked, retryAfterSeconds } = await fetchProviderOnce(inFlight, `daily:${cacheKey}`, fetchImpl, providerUrl, providerBudget);
      if (!upstream.ok) return sendJson(response, 502, { status: 'error', message: `Alpha Vantage returned HTTP ${upstream.status}.` });
      if (budgetBlocked) {
        response.setHeader('Retry-After', String(retryAfterSeconds));
        return sendJson(response, 429, { status: 'rate_limited', message: 'Market-data provider request budget is temporarily exhausted. Please retry after the indicated delay.' });
      }
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
