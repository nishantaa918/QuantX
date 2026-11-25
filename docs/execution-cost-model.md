# Execution cost assumptions

QuantX uses fixed basis-point assumptions for educational backtests. Commission and slippage are each applied per unit of portfolio turnover. One basis point is 0.01%, and the combined rate is (commissionBps + slippageBps) / 10,000.

Signals calculated from a session close become effective on the next observation. Turnover is the absolute change in effective exposure. Costs are charged on both entries and exits, using prior net portfolio equity as the notional base; unchanged holdings incur no turnover cost.

This is not a market-impact model. Slippage does not dynamically depend on volume, spread, volatility, order size, venue, or liquidity. The model also does not separately estimate exchange fees, taxes, borrow or financing costs, dividends, or FX conversion. Backtest results are educational estimates, not a promise of achievable execution. Test a range of assumptions.
