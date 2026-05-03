# External Integrations

**Analysis Date:** 2026-05-03

## APIs & External Services

**Market Data:**
- Binance WebSocket - Primary live BTC price feed
  - Client: `ws` in `server/index.js`
  - Auth: None
  - Endpoints used: `wss://stream.binance.us:9443/ws/btcusdt@trade`, `wss://stream.binance.com:9443/ws/btcusdt@trade`, and related failover URLs
- Binance REST - Price/history fallback when WebSocket data is stale
  - Client: `axios` in `server/index.js`
  - Auth: None
  - Endpoints used: `/api/v3/ticker/price`, historical klines helpers inside `loadBinanceHistory()`
- Polymarket Gamma API - BTC market catalog and quoted outcome prices
  - Client: `axios` in `server/index.js`
  - Auth: None
  - Endpoint base: `https://gamma-api.polymarket.com`

**Fallback Pricing:**
- Kraken - First public fallback price source in `pollBinanceRest()`
- CoinGecko - Second public fallback price source in `pollBinanceRest()`
- Coinbase - Third public fallback price source in `pollBinanceRest()`

## Data Storage

**Databases:**
- None found - there is no SQL, document, or hosted database integration

**File Storage:**
- Local JSON files in `server/`
  - `server/bot-config.json` - Saved bot configuration
  - `server/bot-trades.json` - Trade history snapshot
  - `server/bot-session.json` - Session/balance snapshot
  - These files are gitignored by `.gitignore`

**Caching:**
- None explicit - runtime state is held in memory in the process-global `state` object

## Authentication & Identity

**App/Auth Provider:**
- None - the dashboard and API do not implement user authentication or sessions

**Trading Identity:**
- Optional Polygon private key can be posted to `/api/config` when LIVE mode is selected
  - Implementation: stored in process memory on `state.config.privateKey`
  - Persistence: intentionally not written by `saveConfig()`
  - UI path: `src/components/ConfigModal.jsx`

## Monitoring & Observability

**Error Tracking:**
- None found - no Sentry, Datadog, or similar service is configured

**Analytics:**
- None found

**Logs:**
- Console/stdout logging only from `server/index.js` and the React error boundary in `src/main.jsx`
- Railway health probe uses `/health` as configured in `railway.json`

## CI/CD & Deployment

**Hosting:**
- Railway
  - Build: Nixpacks phases in `nixpacks.toml`
  - Deploy: `railway.json` start command `NODE_ENV=production node server/index.js`
  - Health check: `/health`

**CI Pipeline:**
- No GitHub Actions, CI scripts, or other automated pipeline config were found in the tracked files

## Environment Configuration

**Development:**
- Required env vars observed in code: `PORT` and optional `VITE_API_URL`
- Secrets location: no documented local env template; LIVE private key is entered through the UI and sent to the backend
- Mock/stub services: market fallbacks are public APIs rather than local mocks

**Staging:**
- No separate staging configuration was found

**Production:**
- Railway dashboard likely provides environment values, but no checked-in env contract exists
- The app depends on outbound internet access to market data providers

## Webhooks & Callbacks

**Incoming:**
- None found

**Outgoing:**
- None found beyond polling public APIs and pushing WebSocket updates to connected browser clients

---

*Integration audit: 2026-05-03*
*Update when adding/removing external services*
