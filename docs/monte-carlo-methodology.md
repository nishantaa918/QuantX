# Monte Carlo methodology

QuantX's scenario-analysis Monte Carlo uses a **circular block bootstrap** of the selected workspace price history.

## Inputs

- The selected series must contain at least 61 finite, strictly positive prices (60 observed returns).
- Daily simple returns are calculated from consecutive prices.
- The default block length is the integer square root of the return count, bounded to 2–20 sessions. A caller may supply an explicit positive integer block length, which is bounded by the observed sample length.
- Scenario count is limited to 100–10,000 and the horizon to 1–5 years (252 sessions per year).

## Resampling

For each path, the engine repeatedly chooses a random starting point in the observed return history and appends a contiguous block. Blocks wrap circularly at the sample boundary. Returns are compounded into an equity path; terminal return and pathwise peak-to-trough maximum drawdown are recorded.

The seed makes a run reproducible for the same source series, settings, and implementation.

## Interpretation and limitations

- This is a historical resampling model, not a parametric forecast.
- It reuses observed returns; it cannot generate market regimes or shocks absent from the selected sample.
- Block resampling preserves the order of observations within each block, but dependence across block boundaries is not preserved.
- The block length is a modeling choice. Results should be sensitivity-checked with alternative lengths before drawing conclusions.
- The minimum sample rule is a guard against presenting very short histories as meaningful scenario distributions; it does not guarantee statistical adequacy.
- The model currently simulates the selected single price series. It does not model cross-asset correlations or portfolio rebalancing.

QuantX is an educational research and simulation terminal. Scenario outputs are not investment advice or forecasts.
