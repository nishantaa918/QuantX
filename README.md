# QuantX

A browser-based quantitative research and simulation terminal.

## Historical market data

Historical backtesting supports a small allowlisted US equity and ETF universe using daily raw OHLCV observations from Alpha Vantage: AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, SPY, QQQ, DIA, and IWM. The browser requests the same-origin route `/api/market-data/daily?symbol=SYMBOL`; the provider key is read only on the server and is never sent to the browser. Each symbol has an independent server-side cache.

### Local development

1. Install dependencies with `npm ci`.
2. Set the `ALPHA_VANTAGE_API_KEY` environment variable in the shell used to start Vite.
3. Start the app with `npm run dev`.

The Vite development and preview middleware serves the historical-data route locally.

### Vercel deployment

Add `ALPHA_VANTAGE_API_KEY` under the project's Vercel Environment Variables for the environments where historical data should be available, then redeploy. The production route is implemented as a Vercel serverless function at `api/market-data/daily.js`.

If the key is absent, the endpoint returns a clear `503 unavailable` response. Synthetic backtesting continues to work without a provider key.

## Validation

- `npm test` runs the unit and API-handler tests.
- `npm run build` creates the production frontend bundle.

QuantX is an educational research and simulation project. Historical observations are raw, unadjusted market data; splits and dividends are not reflected in the daily close series. Strategy positions and portfolio returns are simulated. It does not execute trades or provide investment advice.
