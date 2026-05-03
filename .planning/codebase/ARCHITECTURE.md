# Architecture

**Analysis Date:** 2026-05-03

## Pattern Overview

**Overall:** Full-stack single-process trading dashboard monolith

**Key Characteristics:**
- One repo contains both the browser dashboard and backend trading engine
- Backend runtime is centered on a single large module: `server/index.js`
- Real-time behavior is driven by WebSocket ticks, interval timers, and in-memory state mutation
- Production hosting serves the built SPA from the same Express process that exposes the API

## Layers

**Presentation Layer:**
- Purpose: Render the operator dashboard and settings UI
- Contains: `src/App.jsx`, `src/components/CandleChart.jsx`, `src/components/ConfigModal.jsx`, CSS in `src/index.css`
- Depends on: client transport helpers in `src/services/api.js`, chart libraries, React state/hooks
- Used by: browser entry point `src/main.jsx`

**Client Transport Layer:**
- Purpose: Translate UI actions into HTTP/WebSocket communication
- Contains: `src/services/api.js` and the `useBot()` hook inside `src/App.jsx`
- Depends on: browser `fetch`, browser `WebSocket`, same-origin or `VITE_API_URL`
- Used by: dashboard panels and modal actions

**API / Broadcast Layer:**
- Purpose: Accept bot commands, expose read endpoints, and stream updates to clients
- Contains: Express routes, `/health`, REST endpoints, and `wss.on('connection')` in `server/index.js`
- Depends on: in-memory `state`, persistence helpers, and market/trading functions
- Used by: browser dashboard and any direct HTTP caller

**Trading Engine Layer:**
- Purpose: Compute edges, size trades, simulate fills, track positions, and update performance metrics
- Contains: functions such as `computeBinaryMid()`, `computeEdge()`, `runArbitrageCheck()`, `simulateClobFill()`, `openPosition()`, `closePosition()`, and `monitorPositions()` in `server/index.js`
- Depends on: market data, config values, and process-global state
- Used by: timer loops, REST trade actions, and broadcast payload builders

**Persistence / Integration Layer:**
- Purpose: Pull external market data and persist local snapshots
- Contains: `connectBinance()`, `pollBinanceRest()`, `fetchBTCMarkets()`, plus `loadSavedConfig()`, `saveTrades()`, and related file helpers in `server/index.js`
- Depends on: `axios`, `ws`, `fs`, `path`
- Used by: server startup and runtime recovery logic

## Data Flow

**Live market update flow:**
1. Binance WebSocket or fallback REST source updates BTC price in `server/index.js`
2. The server appends to `state.priceHistory`, `state.priceChart`, `state.edgeHistory`, and candle buffers
3. `runArbitrageCheck()` evaluates the best market and may call `executeTrade()`
4. `monitorPositions()` and other timers update open positions and balances
5. `broadcastMarketData()` and `broadcastStatus()` push snapshots to connected WebSocket clients
6. `useBot()` in `src/App.jsx` merges incoming messages into React state and re-renders panels

**User action flow:**
1. A button or modal in `src/App.jsx` / `src/components/ConfigModal.jsx` calls a helper from `src/services/api.js`
2. Express route handlers such as `/api/bot/start`, `/api/config`, or `/api/positions/:id/close` mutate `state`
3. Optional persistence helpers write JSON snapshots to `server/`
4. The backend broadcasts fresh status/trade/position payloads
5. The dashboard updates without a full page reload

**State Management:**
- Backend: single mutable `state` object in `server/index.js`
- Persistence: partial snapshots on local disk (`bot-config.json`, `bot-trades.json`, `bot-session.json`)
- Frontend: local React state, with WebSocket as the source of truth and HTTP polling as fallback

## Key Abstractions

**Global State Object:**
- Purpose: Central runtime source of truth for price data, config, trading stats, positions, and market cache
- Examples: `state.config`, `state.trading`, `state.positions`, `state.markets`
- Pattern: process-global mutable singleton

**Signal / Position / Trade Records:**
- Purpose: Represent detected opportunities, open positions, and realized outcomes
- Examples: `state.currentSignal`, entries in `state.positions`, entries in `state.trading.trades`
- Pattern: plain JavaScript objects passed through compute, mutate, broadcast, and persistence steps

**Imperative Chart Adapter:**
- Purpose: Bridge React props to `lightweight-charts`
- Example: `src/components/CandleChart.jsx`
- Pattern: React wrapper around an imperative third-party chart instance with refs and manual update logic

## Entry Points

**Frontend Entry:**
- Location: `src/main.jsx`
- Triggers: Browser loading `index.html`
- Responsibilities: mount React, apply global CSS, provide the top-level error boundary

**Backend Entry:**
- Location: `server/index.js`
- Triggers: `npm run server`, Railway start command, or `start.ps1`
- Responsibilities: restore state, connect external feeds, register routes, start timers, create the WebSocket server

**Local Launcher:**
- Location: `start.ps1`
- Triggers: manual developer execution on Windows
- Responsibilities: keep frontend and backend processes alive and restart them if they crash

## Error Handling

**Strategy:** Local try/catch and defensive guards rather than centralized middleware

**Patterns:**
- File I/O and remote API helpers log warnings and continue when possible
- Route handlers return `400` / `404` JSON for expected invalid states
- Many network/message parsing failures are swallowed or logged to avoid crashing the main process
- UI failures are caught by the React error boundary in `src/main.jsx`

## Cross-Cutting Concerns

**Logging:**
- `console.log`, `console.warn`, and `console.error` with subsystem prefixes such as `[Config]`, `[Trades]`, and `[Binance WS]`

**Validation:**
- Manual numeric clamping and enum checks inside route handlers and trading functions
- No schema validation library is used at API boundaries

**Authentication:**
- None at the app level; API endpoints are effectively control endpoints on an open backend

**Deployment:**
- Static frontend serving is embedded into the same Express server when `dist/` exists

---

*Architecture analysis: 2026-05-03*
*Update when major patterns change*
