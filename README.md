# QuantX

A browser-based quantitative research and simulation terminal.

## Historical market data

Historical data supports a small allowlisted US equity and ETF universe: AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, SPY, QQQ, DIA, and IWM. The same-origin route accepts `/api/market-data/daily?symbol=SYMBOL&adjustment=raw|adjusted`. Raw mode requests daily OHLCV; adjusted mode requests adjusted closes plus dividend and split metadata from Alpha Vantage. The Markets and Backtesting pages expose the price-basis selector, and saved historical experiments retain the basis used for the run. Adjusted endpoint access depends on the provider plan and may be unavailable on free plans. The provider key is read only on the server and is never sent to the browser. Cache entries are separated by symbol and adjustment mode.

The Markets page also exposes a latest-quote snapshot at `/api/market-data/quote?symbol=SYMBOL`. It uses Alpha Vantage `GLOBAL_QUOTE`, keeps the API key server-side, and caches each symbol briefly. This is a provider snapshot, not a websocket/tick stream; quote freshness, delay, and availability depend on the Alpha Vantage plan and market-data entitlements. The interface displays the provider's latest trading day and retrieval time separately.

## Local development

1. Install dependencies with `npm ci`.
2. Set the `ALPHA_VANTAGE_API_KEY` environment variable in the shell used to start Vite.
3. Start the app with `npm run dev`.

The Vite development and preview middleware serves both `/api/market-data/daily` and `/api/market-data/quote` locally. The quote route returns a provider snapshot, not a streaming feed. Alpha Vantage free-tier request limits and market-data entitlements may restrict quote frequency or availability.

### Vercel deployment

Add `ALPHA_VANTAGE_API_KEY` under the project's server-side environment variables for the environments where market data should be available, then redeploy. Both production endpoints are implemented as Vercel serverless functions: `api/market-data/daily.js` and `api/market-data/quote.js`. Never add the key to a `VITE_*` variable or commit it to the repository. For shared quota enforcement across serverless instances, also configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` as server-only environment variables. The standard Upstash REST token has write access and must never be exposed to browser code.

If the key is absent, both provider endpoints return a clear `503 unavailable` response. Synthetic backtesting and research continue to work without a provider key.

### Provider request budgeting

The proxy applies a conservative default of 25 upstream requests per rolling 24-hour window. When both Upstash variables are configured, a short atomic Redis Lua operation reserves requests and stores the provider cooldown across separate Vercel serverless instances. A successful cache hit and a coalesced in-flight request do not spend another provider request. When Alpha Vantage returns its rate-limit `Note`, the proxy stores a shared cooldown and returns HTTP 429 with a `Retry-After` header. The pause is a short backoff, not a claim that the provider's daily quota resets after 60 seconds. If shared storage is configured but unavailable, provider requests fail closed with HTTP 503 rather than silently falling back to per-instance counters.

If Alpha Vantage has explicitly confirmed a different allowance for this educational/open-source project, set the server-side `ALPHA_VANTAGE_DAILY_REQUEST_LIMIT` variable accordingly. Do not increase it based only on assumptions.

**Deployment limitation:** without both Upstash environment variables, the proxy falls back to the existing in-memory best-effort budget, which is scoped to one warm middleware instance and is not a global quota guarantee. With shared storage configured, the counter is global to the configured Redis database and key prefix, subject to the provider key being used only by this QuantX deployment. Keep the Redis database private and do not reuse its token in client-side code.

### Provider setup checklist

1. Obtain an Alpha Vantage API key and confirm the account plan supports the endpoints you intend to use.
2. Set `ALPHA_VANTAGE_API_KEY` in the server environment (locally in an ignored `.env` file; in production in the host's encrypted environment-variable settings).
3. Create/configure a private Upstash Redis database on its free tier if its current limits fit the project's needs, then set both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` server-side. Do not commit either value.
4. Restart the local dev server after changing `.env`.
5. Check `/api/market-data/daily?symbol=AAPL&adjustment=raw` and `/api/market-data/quote?symbol=AAPL`.
6. Confirm the response status, provider trading date, and retrieval timestamp before relying on displayed data.
7. Respect provider rate limits; repeated refreshes can be throttled. Do not interpret a quote snapshot as a live tick stream.

## API health check

The deployment exposes a lightweight liveness endpoint at `/api/health`. It supports GET, returns a minimal service status and timestamp, and does not disclose API-key or storage configuration. It is a liveness check only; it does not make upstream provider calls or guarantee that external market-data services are available.

## Validation

- `npm test` runs the unit and API-handler tests.
- `npm run build` creates the production frontend bundle.

QuantX is an educational research and simulation project. Raw observations remain unadjusted; adjusted observations carry provider-adjusted closes and explicit dividend/split metadata. Adjusted close is a historical price adjustment, not a guarantee of a fully reconstructed dividend-reinvestment total-return series. Strategy positions and portfolio returns are simulated. It does not execute trades or provide investment advice.

## Research intelligence

For dated historical experiments, the Research Lab can compare strategy returns against SPY, QQQ, DIA, or IWM using exact shared trading dates. Synthetic experiments retain the selected asset's own buy-and-hold reference because they have no real trading dates. Beta, alpha, correlation, tracking error, and information ratio are in-sample diagnostics; alpha assumes a 0% risk-free rate. Short samples, raw/unadjusted prices, and the provider's compact history window can limit reliability.
