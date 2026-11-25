# Execution cost assumptions

QuantX provides two illustrative slippage assumptions for educational historical backtests.

## Fixed basis-point model

The default model combines commission and a user-supplied fixed slippage rate:

`cost rate = (commissionBps + slippageBps) / 10,000`

Both are charged per unit of portfolio turnover. One basis point is 0.01%. Signals calculated from a session close become effective on the next observation. Turnover is the absolute change in effective exposure; entries and exits incur costs, while unchanged holdings do not.

## Volume-impact proxy

Historical OHLCV series can optionally use `slippageModel: "volume-impact"`. Commission remains fixed. The slippage estimate uses only the previous completed session, avoiding use of the execution session's not-yet-known daily volume or range.

- Prior-session dollar volume = raw close × share volume.
- Participation = traded notional / prior-session dollar volume.
- Range proxy = (prior-session high − low) / raw close.
- Estimated slippage (bps) = coefficient × range proxy × square root of participation × 10,000.

The coefficient defaults to 0.1 and is configurable from greater than 0 through 1. Estimates are capped at 500 bps. The model requires aligned historical OHLCV observations with positive volume and valid ranges; it does not silently fall back to fixed slippage when those inputs are missing. For adjusted-price histories, raw close is used with raw OHLC and volume so the range and dollar-volume inputs share a consistent price basis.

## Limitations

The volume-impact option is a transparent heuristic, not a calibrated market-impact model or broker quote. Daily bars cannot reveal the executable bid–ask spread, intraday volume curve, order-book depth, venue, queue position, or actual execution timing. The square-root relationship and coefficient are assumptions, not empirically fitted parameters. The estimate does not separately model spread, taxes, exchange fees, borrow or financing costs, dividends, or FX conversion.

Use multiple cost assumptions and treat all backtest outputs as educational estimates, not guarantees of achievable execution. The fixed-basis-point model remains the default; the volume-impact proxy must be selected explicitly.
