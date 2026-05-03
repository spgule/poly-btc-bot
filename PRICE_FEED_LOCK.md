# Price Feed Lock

Status: LOCKED
Date locked: 2026-05-03
Scope: BTC live price, candle generation, TradeView/chart responsiveness, Railway behavior

This document records that the current BTC price and chart pipeline is now considered correct by the user and must not be changed unless the user explicitly reopens this area.

## Locked outcome

The following behavior is considered accepted and working:
- BTC price is now considered correct.
- TradeView/chart is now considered responsive to price changes.
- Railway behavior is accepted for this subsystem.

## Do not change

Do not change any of the following unless the user clearly asks for it again:
- Binance WebSocket endpoint priority
- Binance REST host priority
- fallback source ordering
- `binanceConnected` semantics
- `priceSource` semantics
- candle construction and bucket logic
- current candle update logic
- chart polling / hydration behavior
- API cache-control behavior related to prices/candles
- frontend consumption of `/api/prices` and `/api/candles`
- volume sourcing used by the candle chart

## Protected files

- `server/index.js`
- `src/App.jsx`
- `src/services/api.js`
- `src/components/CandleChart.jsx`

## Change policy

If someone wants to modify this area in the future, they must:
1. confirm with the user that the price-feed lock is being reopened
2. explain exactly what will change
3. verify the result in the target environment before declaring success

Without that explicit approval, leave this subsystem untouched.

## Reason for lock

This project went through several production fixes on Railway until the BTC price and chart responsiveness matched the user's expectation. Because this area is fragile and environment-dependent, accidental refactors or cleanup changes can easily reintroduce bad prices, frozen candles, stale charts, or wrong fallback behavior.

Treat this subsystem as stable, intentional, and protected.
