# Testing Patterns

**Analysis Date:** 2026-05-03

## Test Framework

**Runner:**
- None configured
- No `jest`, `vitest`, `playwright`, or similar config files were found

**Assertion Library:**
- None configured

**Run Commands:**
```bash
npm run lint      # Frontend static lint check
npm run build     # Production frontend build smoke check
npm run server    # Manual backend runtime verification
```

## Test File Organization

**Location:**
- No `tests/` directory exists
- No collocated `*.test.*` or `*.spec.*` files were found in tracked source

**Naming:**
- No established automated test naming convention yet

**Structure:**
```text
src/
  (no automated test files yet)
server/
  (no automated test files yet)
```

## Test Structure

**Current reality:**
- Verification is manual rather than automated
- The closest thing to a repeatable check today is starting the backend, loading the dashboard, and observing WebSocket-driven updates

**Manual validation pattern implied by the app:**
1. Start backend with `npm run server` or `start.ps1`
2. Start frontend with `npm run dev` if running locally
3. Confirm `/health` responds and dashboard connects
4. Exercise `/api/bot/start`, `/api/config`, and `/api/sim/reset` through the UI
5. Watch market, trade, and position panels for expected behavior

## Mocking

**Framework:**
- None in repo

**Patterns:**
- No shared test utilities, mocks, fixtures, or factories were found

**What is currently hard to test without adding tooling:**
- External market data providers in `server/index.js`
- Timer-driven behavior such as `setInterval(fetchBTCMarkets, 90 * 1000)` and `setInterval(monitorPositions, 150)`
- Browser WebSocket + chart synchronization in `src/App.jsx` and `src/components/CandleChart.jsx`

## Fixtures and Factories

**Test Data:**
- No automated fixture or factory pattern exists yet
- Runtime data currently comes from live public APIs and local JSON snapshots in `server/`

**Location:**
- None established

## Coverage

**Requirements:**
- No coverage target or enforcement is configured

**Configuration:**
- No coverage tooling found

**View Coverage:**
```bash
# Not available yet
```

## Test Types

**Unit Tests:**
- Not present

**Integration Tests:**
- Not present

**E2E Tests:**
- Not present

**Operational / Manual Checks:**
- Linting and build smoke checks cover only a small subset of regressions
- Real confidence currently depends on human-driven runtime testing against live market feeds

## Common Patterns

**Async / real-time risk areas that should receive the first tests:**
- `src/services/api.js` request error handling
- `src/components/CandleChart.jsx` candle reconciliation logic
- `server/index.js` helpers such as `computeBinaryMid()`, `computeEdge()`, `simulateClobFill()`, and `closePosition()`
- Express endpoint behavior around `/api/config`, `/api/trade`, and `/api/sim/reset`

**Suggested first testing standard (not yet implemented):**
- Add Vitest for frontend/shared utility coverage
- Add backend integration tests around the Express app and pure trading helpers
- Introduce deterministic fixtures for market payloads before testing timer-based flows

---

*Testing analysis: 2026-05-03*
*Update when test patterns change*
