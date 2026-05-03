# Codebase Structure

**Analysis Date:** 2026-05-03

## Directory Layout

```text
poly-btc-bot/
|-- public/                  # Static SVG assets served by Vite
|-- server/                  # Backend runtime, market integrations, local JSON persistence
|   |-- index.js             # Main Express/WebSocket/trading engine entry point
|   |-- package.json         # Backend-only manifest
|   `-- package-lock.json    # Backend dependency lockfile
|-- src/                     # Frontend application source
|   |-- components/          # Reusable UI pieces
|   |-- lib/                 # Small shared helpers
|   |-- services/            # Browser API/WebSocket helpers
|   |-- App.jsx              # Main dashboard and local client state
|   `-- main.jsx             # React bootstrap entry
|-- dist/                    # Built frontend output (generated, gitignored)
|-- node_modules/            # Root dependencies (generated, gitignored)
|-- .planning/               # Generated planning and codebase-map docs
|-- package.json             # Frontend/root manifest and scripts
|-- README.md                # Project and trading-model documentation
|-- start.ps1                # Local watchdog launcher for frontend + backend
|-- tailwind.config.js       # Tailwind theme/content config
|-- vite.config.js           # Vite build config
`-- railway.json            # Railway deploy config
```

## Directory Purposes

**`src/`:**
- Purpose: Browser dashboard implementation
- Contains: React components, client hooks/state, CSS, assets, and transport helpers
- Key files: `src/App.jsx`, `src/main.jsx`, `src/components/CandleChart.jsx`, `src/components/ConfigModal.jsx`
- Subdirectories: `components/`, `services/`, `lib/`, `assets/`

**`server/`:**
- Purpose: Backend runtime, trading logic, and local persistence
- Contains: one large executable module plus a separate package manifest
- Key files: `server/index.js`, `server/package.json`
- Subdirectories: no tracked source subdirectories yet

**`public/`:**
- Purpose: Static icons and favicon files served by Vite
- Contains: `favicon.svg`, `icons.svg`
- Key files: `public/favicon.svg`, `public/icons.svg`
- Subdirectories: none

## Key File Locations

**Entry Points:**
- `src/main.jsx` - Browser app bootstrap
- `src/App.jsx` - Main dashboard composition and client-side state orchestration
- `server/index.js` - Backend startup, routes, timers, trading engine, and WebSocket server
- `start.ps1` - Local process supervisor for Windows development

**Configuration:**
- `package.json` - Root scripts and frontend dependency manifest
- `server/package.json` - Backend dependency manifest
- `vite.config.js` - Build-time frontend configuration
- `tailwind.config.js` - Theme token mapping and content scan paths
- `postcss.config.js` - CSS build pipeline
- `eslint.config.js` - Frontend linting rules
- `nixpacks.toml` - Railway build phases
- `railway.json` - Railway deploy settings
- `.gitignore` - Generated and sensitive file exclusions

**Core Logic:**
- `server/index.js` - All market ingestion, edge calculation, trade simulation, and API behavior
- `src/services/api.js` - Browser transport helpers
- `src/components/CandleChart.jsx` - Imperative chart adapter
- `src/components/ConfigModal.jsx` - Bot settings UI and config submit flow
- `src/lib/utils.js` - Shared UI helpers such as `cn()` and formatting helpers

**Testing:**
- No `tests/`, `__tests__/`, or collocated `*.test.*` files were found

**Documentation:**
- `README.md` - Product overview, deployment notes, and architecture narrative
- `.planning/codebase/*.md` - Generated repo intelligence documents

## Naming Conventions

**Files:**
- `PascalCase.jsx` for React components: `CandleChart.jsx`, `ConfigModal.jsx`
- lowercase root config names: `vite.config.js`, `railway.json`, `nixpacks.toml`
- lowercase utility/service modules: `api.js`, `utils.js`

**Directories:**
- lowercase singular/plural folders by concern: `src/components`, `src/services`, `server`
- no feature-folder convention yet; most backend code remains flat

**Special Patterns:**
- `index.js` / `main.jsx` act as execution entry points
- Gitignored runtime JSON files live in `server/` next to the executable backend file

## Where to Add New Code

**New UI feature:**
- Primary code: `src/components/` plus panel wiring in `src/App.jsx`
- Shared client helpers: `src/lib/` or `src/services/`
- Styles: `src/index.css` for global/system styles, inline styles only when following existing component patterns

**New backend capability:**
- Current implementation path: add adjacent logic in `server/index.js` near the related function block
- Preferred medium-term direction: extract new subsystems into `server/` submodules before `server/index.js` grows further
- Persistence/config changes: keep related JSON snapshot logic in `server/`

**New documentation or planning artifact:**
- Repo docs: root `README.md`
- Generated codebase/planning docs: `.planning/`

## Special Directories

**`dist/`:**
- Purpose: frontend build output served by Express in production
- Source: generated by `npm run build`
- Committed: No, ignored by `.gitignore`

**`node_modules/`:**
- Purpose: installed dependencies for the root app and nested backend app
- Source: generated by npm install
- Committed: No, ignored by `.gitignore`

**`.planning/`:**
- Purpose: project planning and codebase intelligence artifacts
- Source: generated by GSD workflows
- Committed: Yes, unless a team chooses to ignore it later

---

*Structure analysis: 2026-05-03*
*Update when directory structure changes*
