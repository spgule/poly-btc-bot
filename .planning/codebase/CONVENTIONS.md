# Coding Conventions

**Analysis Date:** 2026-05-03

## Naming Patterns

**Files:**
- `PascalCase.jsx` for React components in `src/components/`
- lowercase `.js` for utilities, services, and config files such as `src/services/api.js` and `vite.config.js`
- no established test-file naming convention yet because no automated tests are checked in

**Functions:**
- camelCase for nearly all functions: `computeEdge`, `loadSavedConfig`, `formatCurrency`
- async functions use the same naming style without a prefix: `pollBinanceRest`, `fetchBTCMarkets`, `handleSave`
- UI event handlers commonly use `handle*` names: `handleReset`, `handleSave`

**Variables:**
- camelCase for local variables and state slices
- `UPPER_SNAKE_CASE` for long-lived backend constants such as `PORT`, `LAG_MS`, `PRICE_HIST_MS`, `POLY_FEE_RATE`
- leading underscore is rare and only used for exceptional cases like `_idSeq` and `_legacySimTrade_unused`

**Types / Shapes:**
- No TypeScript source files are present; data shapes are implicit plain objects
- Domain objects like signal, position, market, and trade are represented by object literals rather than explicit interfaces

## Code Style

**Formatting:**
- Semicolons are used consistently
- Single quotes are the dominant string style in app/runtime code
- Frontend and config files generally use 2-space indentation
- `server/index.js` also uses 2-space blocks but includes aligned columns and long section banners for readability

**Linting:**
- ESLint is configured in `eslint.config.js`
- Current lint coverage is frontend-oriented: `**/*.{js,jsx}`
- React Hooks and React Refresh rules are enabled
- Run: `npm run lint`

## Import Organization

**Order:**
1. External packages first
2. Side-effect CSS imports near the top in React entry modules
3. Relative local imports after a blank line

**Grouping:**
- `src/App.jsx` groups package imports, then local helpers/components
- `server/index.js` groups `require()` calls near the top without deeper layering

**Path Aliases:**
- None found; all imports use relative paths

## Error Handling

**Patterns:**
- Backend favors defensive guards and local `try/catch` around file I/O and external network calls
- Route handlers validate inputs manually and return JSON error responses for expected failures
- UI actions catch async failures and surface them through local component state

**Error Types:**
- No custom error classes were found
- Failures are usually represented as `new Error(...)`, `console.warn(...)`, or an HTTP `400` / `404`
- Silent catch blocks are used in noisy real-time paths where uptime is favored over strict failure visibility

## Logging

**Framework:**
- Plain `console.log`, `console.warn`, and `console.error`

**Patterns:**
- Prefix log lines with subsystem labels such as `[Config]`, `[Trades]`, `[Session]`, `[Binance WS]`, and `[Server]`
- Log lifecycle events, reconnect behavior, and persistence failures
- No structured logger, log levels, or log transport abstraction is present

## Comments

**When to Comment:**
- The backend uses large invariant-preserving comments to explain why a behavior must not change, especially around SIM/LIVE fidelity in `server/index.js`
- UI files use section banners and brief clarifying comments for complex visual or sync logic
- Comments generally explain intent, timing, or domain constraints rather than trivial syntax

**JSDoc / TSDoc:**
- Not used as a consistent project pattern

**TODO Comments:**
- No meaningful TODO/FIXME/HACK comment convention was found in tracked source files

## Function Design

**Size:**
- Small helper functions exist, but the codebase also tolerates very large modules and components
- `server/index.js` and `src/App.jsx` are both monolithic by current standards

**Parameters:**
- Simple helpers use positional parameters
- UI and API configuration flows often pass object payloads when the shape is naturally grouped

**Return Values:**
- Guard clauses and early returns are common
- Backend functions frequently mutate shared state as a side effect instead of returning immutable results

## Module Design

**Exports:**
- Default exports are used for React components such as `src/components/CandleChart.jsx`
- Named exports are used for helper modules such as `src/services/api.js` and `src/lib/utils.js`

**Barrel Files:**
- None found
- Imports reference concrete files directly

**Inter-module style:**
- Frontend uses ES modules
- Backend uses CommonJS
- New code should match the module system already used in its folder unless a wider migration is planned

---

*Convention analysis: 2026-05-03*
*Update when patterns change*
