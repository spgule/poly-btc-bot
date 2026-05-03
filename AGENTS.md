# AGENTS.md

This repository contains a locked BTC price-feed and chart pipeline.

Agents working in this repo must treat the Binance/Railway price-feed stack as protected behavior unless the user explicitly asks to change it again.

Mandatory rule:
- Do not modify the BTC price source selection, WebSocket failover order, REST fallback chain, candle-building flow, chart hydration flow, or cache-control behavior without explicit user approval in the current conversation.

Protected files and areas:
- `server/index.js`
- `src/App.jsx`
- `src/services/api.js`
- `src/components/CandleChart.jsx`
- `PRICE_FEED_LOCK.md`

Before editing anything related to price, candles, chart, Binance, Railway, WebSocket, REST fallback, or TradeView behavior:
1. Read `PRICE_FEED_LOCK.md`.
2. Assume the current behavior is intentionally correct.
3. Stop and ask the user for explicit confirmation before changing it.

Allowed work without extra confirmation:
- UI layout changes unrelated to price/chart data flow
- documentation updates
- trading logic changes that do not touch the protected feed/chart pipeline
- unrelated backend/frontend fixes

If a new issue appears in the protected area:
- document the symptom first
- do not patch immediately
- ask the user whether they want to reopen the locked price-feed stack
