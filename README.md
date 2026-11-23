# QuantX

A browser-based quantitative research and simulation terminal.

## Historical market data

Historical data supports a small allowlisted US equity and ETF universe: AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, SPY, QQQ, DIA, and IWM. The same-origin route accepts `/api/market-data/daily?symbol=SYMBOL&adjustment=raw|adjusted`. Raw mode requests daily OHLCV; adjusted mode requests adjusted closes plus dividend and split metadata from Alpha Vantage. The Markets and Backtesting pages expose the price-basis selector, and saved historical experiments retain the basis used for the run. Adjusted endpoint access depends on the provider plan and may be unavailable on free plans. The provider key is read only on the server and is never sent to the browser. Cache entries are separated by symbol and adjustment mode.

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

QuantX is an educational research and simulation project. Raw observations remain unadjusted; adjusted observations carry provider-adjusted closes and explicit dividend/split metadata. Adjusted close is a historical price adjustment, not a guarantee of a fully reconstructed dividend-reinvestment total-return series. Strategy positions and portfolio returns are simulated. It does not execute trades or provide investment advice.

## Research intelligence

The Research Lab includes descriptive market-regime classification, next-session-aligned strategy autopsy, and an exploratory momentum permutation test. Strategy Autopsy reports beta, alpha, tracking error, and information ratio against the selected asset's buy-and-hold return by default. For a dated historical experiment, it can additionally load SPY, QQQ, DIA, or IWM and align the comparison on shared trading dates. External index comparison is unavailable for synthetic experiments. Alpha uses a disclosed 0% risk-free-rate assumption; all statistics are in-sample diagnostics, not forecasts.
