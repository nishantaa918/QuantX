import { normalizeAlphaVantageDaily } from '../src/market-data.js';

const ROUTE = '/api/market-data/daily';
const CACHE_TTL_MS = 15 * 60 * 1000;

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
} = {}) {
  const cache = new Map();
  return async function alphaVantageMiddleware(request, response, next) {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (requestUrl.pathname !== ROUTE) return next();
    if (request.method !== 'GET') return sendJson(response, 405, { status: 'error', message: 'Use GET for historical data.' });
    if ((requestUrl.searchParams.get('symbol') ?? '').toUpperCase() !== 'AAPL') {
      return sendJson(response, 400, { status: 'error', message: 'This endpoint currently supports AAPL only.' });
    }
    if (!apiKey) {
      return sendJson(response, 503, { status: 'unavailable', message: 'Historical data is unavailable: the server-side Alpha Vantage key is not configured.' });
    }

    const cached = cache.get('AAPL');
    if (cached && cached.expiresAt > now()) return sendJson(response, 200, cached.payload);

    try {
      const providerUrl = new URL('https://www.alphavantage.co/query');
      providerUrl.search = new URLSearchParams({ function: 'TIME_SERIES_DAILY', symbol: 'AAPL', outputsize: 'compact', apikey: apiKey }).toString();
      const upstream = await fetchImpl(providerUrl, { signal: AbortSignal.timeout(10_000) });
      if (!upstream.ok) return sendJson(response, 502, { status: 'error', message: `Alpha Vantage returned HTTP ${upstream.status}.` });
      const providerPayload = await upstream.json();
      if (providerPayload?.Note || providerPayload?.Information) {
        return sendJson(response, 429, { status: 'rate_limited', message: 'Alpha Vantage rate limit reached. Try again after the provider limit resets.' });
      }
      if (providerPayload?.['Error Message']) {
        return sendJson(response, 502, { status: 'error', message: 'Alpha Vantage rejected the daily-data request.' });
      }

      const normalized = normalizeAlphaVantageDaily(providerPayload, { symbol: 'AAPL', limit: 100 });
      const payload = {
        status: 'historical',
        data: normalized,
        lastUpdated: new Date(now()).toISOString(),
      };
      cache.set('AAPL', { payload, expiresAt: now() + cacheTtlMs });
      return sendJson(response, 200, payload);
    } catch (error) {
      const message = error?.name === 'TimeoutError'
        ? 'Alpha Vantage did not respond before the request timeout.'
        : error instanceof SyntaxError
          ? 'Alpha Vantage returned an unreadable response.'
          : error?.message?.startsWith('Invalid') || error?.message?.startsWith('Inconsistent')
            ? error.message
            : 'Could not retrieve AAPL daily historical data.';
      return sendJson(response, 502, { status: 'error', message });
    }
  };
}