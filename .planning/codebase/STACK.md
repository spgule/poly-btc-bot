# Technology Stack

**Analysis Date:** 2026-05-03

## Languages

**Primary:**
- JavaScript - All runtime application code in `src/` and `server/`
- CSS - UI styling in `src/index.css` and `src/App.css`

**Secondary:**
- JSON - Project manifests and deployment/config files such as `package.json`, `server/package.json`, and `railway.json`
- TOML - Nixpacks build configuration in `nixpacks.toml`
- PowerShell - Local launcher workflow in `start.ps1`

## Runtime

**Environment:**
- Node.js `>=20.19.0` declared in `package.json`
- Node.js 22 is selected for Railway builds in `nixpacks.toml`
- Browser runtime for the React dashboard served from `dist/` in production

**Package Manager:**
- npm - root app and nested `server/` app both use npm
- Lockfiles: `package-lock.json` and `server/package-lock.json` are both present

## Frameworks

**Core:**
- React 19 - Dashboard UI in `src/App.jsx`
- Vite 8 - Frontend dev server and production build via `vite.config.js`
- Express 5 - HTTP API and static asset serving in `server/index.js`
- `ws` 8 - Server-side WebSocket broadcasting in `server/index.js`

**Testing:**
- No automated test framework is configured or checked into the repo

**Build/Dev:**
- ESLint 10 - Frontend linting via `npm run lint`
- Tailwind CSS 4 + PostCSS - Utility pipeline and theme tokens configured in `tailwind.config.js` and `postcss.config.js`
- Nixpacks / Railway - Production build and deploy configuration in `nixpacks.toml` and `railway.json`

## Key Dependencies

**Critical:**
- `react` / `react-dom` - Dashboard rendering and client state
- `express` - REST API, health endpoint, and production static hosting
- `ws` - Real-time streaming from server to dashboard clients
- `axios` - External REST calls to Binance, Polymarket, Kraken, CoinGecko, and Coinbase
- `lightweight-charts` - Candlestick chart rendering in `src/components/CandleChart.jsx`
- `recharts` - Secondary charts and metrics panels in `src/App.jsx`
- `react-grid-layout` - Resizable desktop dashboard layout in `src/App.jsx`
- `lucide-react` - Icon set used across the UI

**Infrastructure:**
- `cors` - Open CORS policy for the API in `server/index.js`
- `@vitejs/plugin-react` - Vite React integration in `vite.config.js`
- `autoprefixer` and `@tailwindcss/postcss` - CSS build pipeline

## Configuration

**Environment:**
- `PORT` controls the backend listen port in `server/index.js`
- `VITE_API_URL` is compiled into the frontend through `vite.config.js`
- No checked-in `.env.example` or other environment template was found

**Build:**
- `vite.config.js` - Frontend bundler config
- `tailwind.config.js` - Design token and content scan config
- `postcss.config.js` - Tailwind/PostCSS plugin chain
- `eslint.config.js` - Frontend lint rules
- `nixpacks.toml` - Railway build phases
- `railway.json` - Railway deploy, health check, and restart behavior

## Platform Requirements

**Development:**
- Windows, macOS, or Linux with Node.js 20+ and npm
- Two dependency installs are required: repo root and `server/`
- Local development typically runs `npm run dev` plus `npm run server`, or `start.ps1`

**Production:**
- Railway/Nixpacks deploy target
- Production backend serves the built frontend from `dist/` when present
- The application currently assumes a single Node process with local writable disk

---

*Stack analysis: 2026-05-03*
*Update after major dependency changes*
