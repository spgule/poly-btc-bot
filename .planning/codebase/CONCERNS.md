# Codebase Concerns

**Analysis Date:** 2026-05-03

## Tech Debt

**Monolithic backend module:**
- Issue: `server/index.js` contains feed ingestion, pricing logic, persistence, REST routes, WebSocket handling, and startup orchestration in one ~1762-line file
- Why: The project appears to have grown through fast iteration in a single runtime module
- Impact: Changes in one concern can easily break another, and isolated testing/refactoring is expensive
- Fix approach: Extract market adapters, persistence helpers, route registration, and trading engine logic into focused `server/` submodules

**Monolithic frontend dashboard:**
- Issue: `src/App.jsx` is a ~1378-line component that combines transport setup, layout persistence, most panel rendering, and significant view logic
- Why: The dashboard evolved around one central screen and accumulated behavior in place
- Impact: UI changes are high-risk, harder to review, and difficult to test or reuse
- Fix approach: Split panel bodies, transport hooks, and layout management into smaller component/hook modules

## Known Bugs

**LIVE mode is documented more strongly than it is implemented:**
- Symptoms: The README and settings UI imply real Polymarket execution, but `executeTrade()` in `server/index.js` only logs `[LIVE] Order stub - CLOB API not yet implemented`
- Trigger: Switch to LIVE mode and allow a trade signal to execute
- Workaround: Treat the app as SIM-only until an actual order placement path exists
- Root cause: Trade execution plumbing for Polymarket CLOB has not been built yet

**Persistence may not survive real production lifecycle events:**
- Symptoms: Config, session, or trade history can disappear or diverge across deploys/restarts if the runtime filesystem is ephemeral or if multiple instances are introduced
- Trigger: Railway redeploys, container replacement, or horizontal scaling
- Workaround: None in code beyond local JSON snapshots
- Root cause: `server/bot-config.json`, `server/bot-trades.json`, and `server/bot-session.json` are local disk files rather than durable shared storage

## Security Considerations

**Unauthenticated control plane:**
- Risk: Any caller that can reach the backend can start/stop the bot, change config, close positions, or reset SIM state through `/api/bot/start`, `/api/bot/stop`, `/api/config`, `/api/trade`, `/api/positions/:id/close`, and `/api/sim/reset`
- Current mitigation: None beyond network placement; `server/index.js` also enables `cors({ origin: '*' })`
- Recommendations: Add authentication and authorization before exposing this service beyond a trusted private environment

**Private key handling over a public app API:**
- Risk: LIVE mode accepts a private key through the browser-facing config flow in `src/components/ConfigModal.jsx` and stores it on the backend process
- Current mitigation: `saveConfig()` avoids writing the key to disk
- Recommendations: Move signing to a dedicated secure backend path or wallet service, require auth, and never rely on an unauthenticated dashboard for secret submission

## Performance Bottlenecks

**High-frequency broadcast loop:**
- Problem: `server/index.js` recomputes edge data and broadcasts market payloads every ~150-300ms while additional 150ms and 400ms timers also run
- Measurement: Timers are coded at 150ms (`monitorPositions`), 300ms (`broadcastMarketData`), and 400ms (fallback arbitrage loop); no formal profiling data was found
- Cause: All real-time work runs in a single Node process with shared mutable state
- Improvement path: Separate compute cadence from UI cadence, batch broadcasts, and profile hot paths before adding more dashboard features

**Chart synchronization complexity:**
- Problem: `src/components/CandleChart.jsx` contains special-case reload logic for out-of-order candle updates
- Measurement: No formal metrics, but the component includes explicit recovery comments and full reload fallbacks
- Cause: HTTP-polled candle history and WebSocket current-candle updates can arrive out of order
- Improvement path: Normalize server payload ordering or centralize client-side candle reconciliation before updating the chart

## Fragile Areas

**Backend runtime state machine:**
- Why fragile: Trading behavior depends on the interaction of many timers, mutable state branches, and external feeds inside `server/index.js`
- Common failures: Duplicate trade conditions, stale connection state, persistence drift, and hard-to-reproduce timing bugs
- Safe modification: Change one subsystem at a time and verify start/stop, config save, market fetch, signal generation, and position lifecycle together
- Test coverage: None automated

**Dashboard transport + layout shell:**
- Why fragile: `src/App.jsx` mixes WebSocket handling, HTTP polling, localStorage layout persistence, and rendering for many panels
- Common failures: UI regressions can masquerade as transport bugs, and state changes in one panel can affect others unexpectedly
- Safe modification: Prefer extracting logic into hooks/components before major changes, and test both desktop and mobile layouts after edits
- Test coverage: None automated

## Scaling Limits

**Single-process architecture:**
- Current capacity: One Node process manages feed ingestion, bot logic, API requests, persistence, and all client broadcasts
- Limit: Horizontal scaling would split in-memory state and local JSON files immediately
- Symptoms at limit: Inconsistent balances, duplicate bot control, divergent trade history, and client views depending on which instance they hit
- Scaling path: Externalize state/persistence and separate the compute engine from the web-serving layer

## Dependencies at Risk

**Node runtime mismatch:**
- Risk: The root manifest requires Node `>=20.19.0` while Railway build config selects `nodejs_22`
- Impact: Behavior can differ between local development and production, especially around dependency/runtime edge cases
- Migration plan: Pin one supported Node major across `package.json`, local docs, and deployment config

## Missing Critical Features

**Automated verification suite:**
- Problem: There are no automated unit, integration, or end-to-end tests
- Current workaround: Manual runtime checks and visual inspection
- Blocks: Safe refactoring of `server/index.js`, `src/App.jsx`, and live-trading logic
- Implementation complexity: Medium; start with pure helper coverage and endpoint tests

**Real authenticated operator boundary:**
- Problem: The app has no notion of operator identity or permissions
- Current workaround: Run it only in trusted/private environments
- Blocks: Safe deployment of any control-capable version to the public internet
- Implementation complexity: Medium to high depending on auth strategy

## Test Coverage Gaps

**Trading math and execution helpers:**
- What's not tested: `computeBinaryMid()`, `computeEdge()`, `kellySize()`, `simulateClobFill()`, `closePosition()`
- Risk: Small formula or rounding changes can silently alter trading behavior
- Priority: High
- Difficulty to test: Moderate once deterministic market fixtures are introduced

**API and realtime control flows:**
- What's not tested: bot start/stop/config/update flows, WebSocket status broadcasts, and SIM reset behavior
- Risk: Core operator workflows can regress without immediate visibility
- Priority: High
- Difficulty to test: Moderate; needs server extraction or harness setup around the Express/WebSocket runtime

---

*Concerns audit: 2026-05-03*
*Update as issues are fixed or new ones discovered*
