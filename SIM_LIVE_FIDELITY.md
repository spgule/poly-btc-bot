# SIM/LIVE Fidelity Rules

Status: ACTIVE
Updated: 2026-05-03

This project treats SIM as a dry-run of LIVE. The rules below are mandatory.

## Core rules

- BTC price must come from real Binance data. Do not inject synthetic/fake points into `priceHistory`.
- Real Polymarket markets use Gamma for discovery/metadata refresh and CLOB market data for live pricing.
- Real Polymarket odds must never be computed from BTC momentum.
- Sim/fallback market odds are recalculated every 2 seconds by `updateSimMarketPrices()` using `computeBinaryMid()`.
- `computePolyOdds()` must return `market.outcomePrices[0]` directly in both SIM and LIVE.
- `computeEdge()` must use:
  - `implied = computeBinaryMid(market, BTC_now)`
  - `poly = market.outcomePrices[0]`
- Entry spread must be `mid + clobSpread(vol) + priceImpact()`.
- Exit spread must be `exitOdds - clobSpread(vol)`.
- Minimum market volume is `$50k` for both SIM and LIVE.
- Polymarket 2% fee applies only at settlement (`TIMEOUT` with odds >= `0.95` or <= `0.05`).
- Cooldown must be `Math.max(cooldownMs, 2000)` for both SIM and LIVE.

## Live pricing model

- Gamma API is used to discover active BTC markets and refresh metadata every 90 seconds.
- The selected live markets are subscribed through the Polymarket CLOB market WebSocket.
- Live `outcomePrices` are updated from real CLOB market data using `best_bid_ask`, `book`, and `last_trade_price`.
- When spread is wider than `0.10`, the last trade price is preferred over midpoint.

## Simulation model

- Sim markets reprice every 2 seconds from the same binary model used by the live implied calculation.
- Open positions are marked from `market.outcomePrices`, so SIM and LIVE share the same mark-to-market path shape:
  - LIVE market odds from CLOB/Gamma-backed market state
  - SIM market odds from `updateSimMarketPrices()`

## Editing rule

Do not change these rules casually. Any future change must explain:
1. why SIM/LIVE fidelity improves
2. which rule is being changed
3. how the behavior was verified
