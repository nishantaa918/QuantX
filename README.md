# QuantX

A browser-based quantitative research and simulation terminal.

## Historical market data

Historical backtesting currently supports AAPL daily OHLCV observations from Alpha Vantage. The browser requests the same-origin route `/api/market-data/daily?symbol=AAPL`; the provider key is read only on the server and is never sent to the browser.

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

QuantX is an educational research and simulation project. Historical observations are market data; strategy positions and portfolio returns are simulated. It does not execute trades or provide investment advice.
