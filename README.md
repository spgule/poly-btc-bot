<div align="center">

<img src="https://img.shields.io/badge/STATUS-LIVE%20SIM-00ff88?style=for-the-badge&labelColor=0d0d0d" />

# ⚡ POLY-BTC-BOT

### Autonomous Multi-Asset Binary Options Arbitrage Engine

<p>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white"/></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black"/></a>
  <a href="https://vitejs.dev"><img src="https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white"/></a>
  <a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind-3-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white"/></a>
  <a href="https://railway.app"><img src="https://img.shields.io/badge/Deploy-Railway-0B0D0E?style=flat-square&logo=railway&logoColor=white"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square"/></a>
</p>

<br/>

> **Exploits the pricing lag between real-time Binance ticks and Polymarket binary options.**  
> When BTC/SOL/ETH moves, Polymarket reprices ~90 seconds later. This engine detects that window,  
> sizes positions via blended Kelly criterion, and executes through a high-fidelity CLOB simulator.

<br/>

</div>

---

## 🧠 Core Insight

Polymarket updates binary option prices by polling the Gamma API — roughly every **90 seconds**. In that window, a significant crypto move creates a mispricing between the market's stale quote and the true fair value. This bot computes fair value in real time and enters before the reprice closes the gap.

```
BTC: $96,400 → $97,100  (+$700 in 45s)
         │
         ▼
┌─────────────────────────┐       ┌─────────────────────────┐
│   computeBinaryMid()    │       │  Polymarket Gamma API   │
│                         │       │                         │
│  Black-Scholes logistic │       │  Price last updated 45s │
│  P(BTC_T > K | S=97100) │       │  ago — still at old BTC │
│                         │       │                         │
│     implied  =  0.68    │       │     poly     =  0.50    │
└──────────┬──────────────┘       └──────────┬──────────────┘
           │                                 │
           └──────── edge = +0.18 ───────────┘
                            │
                            ▼
             ✅  BUY_YES · Kelly-sized · CLOB fill simulated
             🛡️  Risk Manager checks 4 protection layers
             🧬  Signal Fusion confirms with Coinbase + F&G
             📈  Mark EMA-smoothed · Liquidity-penalized exit
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Railway Cloud                             │
│                                                                     │
│  ┌──────────────────┐  WebSocket   ┌───────────────────────────┐   │
│  │  Express Server  │◄────────────►│     React Dashboard       │   │
│  │  REST API :3001  │  broadcast() │  Vite · Tailwind · Charts │   │
│  └────────┬─────────┘              └───────────────────────────┘   │
│           │                                                         │
│  ┌────────▼──────────────────────────────────────────────────────┐  │
│  │                    Bot Engine  (server/index.js)              │  │
│  │                                                               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │  │
│  │  │  Binance WS  │  │  Coinbase    │  │  Fear & Greed      │  │  │
│  │  │  BTC/SOL/ETH │  │  REST (10s)  │  │  API (5min)        │  │  │
│  │  │  7-host fail │  │  divergence  │  │  alternative.me    │  │  │
│  │  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘  │  │
│  │         └─────────────────┴──────────────────┘               │  │
│  │                           │                                   │  │
│  │              ┌────────────▼─────────────┐                    │  │
│  │              │   SignalFusion Engine    │                    │  │
│  │              │  Weighted vote system:   │                    │  │
│  │              │  Binance 40% + CB 25%   │                    │  │
│  │              │  F&G 20% + Spike 15%    │                    │  │
│  │              └────────────┬─────────────┘                    │  │
│  │                           │                                   │  │
│  │              ┌────────────▼─────────────┐                    │  │
│  │              │    Signal Pipeline       │                    │  │
│  │              │  VPIN · Bollinger · EMA  │                    │  │
│  │              │  Fibonacci · 2-of-3 gate │                    │  │
│  │              └────────────┬─────────────┘                    │  │
│  │                           │                                   │  │
│  │              ┌────────────▼─────────────┐                    │  │
│  │              │    RiskManager (4-Layer) │                    │  │
│  │              │  Daily · Monthly ·       │                    │  │
│  │              │  Drawdown · Total Halt   │                    │  │
│  │              └────────────┬─────────────┘                    │  │
│  │                           │                                   │  │
│  │              ┌────────────▼─────────────┐                    │  │
│  │              │   CLOB Execution Engine  │                    │  │
│  │              │  spread · impact · fill  │                    │  │
│  │              │  EMA mark · time cap     │                    │  │
│  │              └──────────────────────────┘                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 📐 Pricing Model

Fair value of any Polymarket binary is computed via a **Black-Scholes logistic approximation**:

$$P(\text{BTC}_T > K) \approx \frac{1}{1 + e^{-d_1}}, \quad d_1 = \frac{\ln(S/K)}{\sigma\sqrt{T}}$$

- **S** = real-time asset price (Binance aggTrade WS)
- **K** = strike parsed from question, or `_strikeSnapshot` for "Up or Down" markets
- **σ** = realized 1-min volatility → scaled to per-hour
- **T** = hours until market expiry

```javascript
const realizedVol = Math.max(0.001, recentVolatility(60000) * Math.sqrt(3600));
const sigmaT      = realizedVol * Math.sqrt(hoursLeft);
const d1          = Math.log(btc / strike) / Math.max(0.001, sigmaT);
return clampProb(1 / (1 + Math.exp(-d1)));
```

**Edge** = `implied(real-time) − poly(stale Gamma API)`. Signal fires when `|edge| ≥ dynMinEdge` and passes ≥2-of-3 independent confirmation filters.

---

## 🧬 Signal Fusion Engine

Multi-source fusion layer combines independent signals into a single composite direction score.

```
Source          Weight    What it detects
─────────────────────────────────────────────────────────────────────
Binance WS       40%     Primary price direction (100ms VWAP)
Coinbase REST    25%     Price divergence between exchanges (>0.3%)
Fear & Greed     20%     Market sentiment (bullish >60 / bearish <40)
Spike Detector   15%     Counter-trend signal on BTC moves >15% in 3s
```

Each source votes `+1 (BUY_YES)`, `-1 (BUY_NO)`, or `0 (neutral)`. Votes are weighted and time-decayed (sources >30s old lose influence). The composite score applies a `±10` confidence bonus/penalty to the main signal engine.

```javascript
// Coinbase divergence — fires when Binance vs Coinbase spread > 0.3%
if (Math.abs(div) >= 0.003) src.direction = div < 0 ? 1 : -1;

// Spike detector — counter-trend on large moves in 3s window
if (changePct >= 0.15) src.direction = -dir; // mean-revert bias
```

> **Live data endpoints**: `/api/fusion` — full fusion status JSON

---

## 🛡️ 4-Layer Risk Manager

Hierarchical risk system that blocks trading automatically before any loss threshold is breached.

| Layer | Trigger | Action | Duration |
|-------|---------|--------|----------|
| **1 — Daily Loss** | Day P&L drops ≥ 5% | Pause trading | 1 hour |
| **2 — Monthly Loss** | Month P&L drops ≥ 15% | Pause trading | 30 days |
| **3 — Max Drawdown** | Drawdown from peak ≥ 25% | Pause trading | 7 days |
| **4 — Total Halt** | Capital loss ≥ 40% | Permanent halt | Manual rearm |

### Dynamic Position Sizing

On top of Kelly criterion, the Risk Manager applies a streak multiplier:

```
After each consecutive loss  →  size × 0.80   (floor: 0.5×)
After each consecutive win   →  size × 1.10   (cap:   2.5×)
```

This means the bot automatically bets smaller during losing streaks and scales up during hot streaks — without manual intervention.

> **Endpoints**: `GET /api/risk/status` · `POST /api/risk/rearm-ext`

---

## 🎯 Signal Pipeline

Every 150ms the engine runs through a multi-layer quality filter:

```
 1.  Settlement Guard      — block entries in final 3 min of ≤30min markets
 2.  VPIN Toxicity         — computeVPIN() > 0.75 → pause (adverse flow)
 3.  Flow Imbalance        — 30s buy/sell pressure aligned with trade direction
 4.  Spike Detector        — |move| > 15% in 3s → counter-trend signal active
 5.  Bollinger Bands       — price vs upper/lower band → favorable/unfavorable bias
 6.  EMA Trend (9/21)      — short vs long EMA alignment check
 7.  Fibonacci Levels      — price proximity to key retracement levels
 8.  Signal Fusion Vote    — composite Binance + Coinbase + F&G + Spike
 9.  2-of-3 Confirmation   — edgeVelocity() + trend + |edge| ≥ dynMinEdge
10.  Adverse Selection     — ≥3 losses in last 5 trades → 60s cooldown
11.  Exposure Cap          — total open cost ≤ 40% effective balance
12.  Edge Cap 15¢          — cap before Kelly sizing (institutional arb ceiling)
13.  Kill Switch           — drawdown from peak ≥ killThreshold% → halt
14.  Risk Manager Check    — 4-layer block check before every entry
```

---

## 🔬 CLOB Execution — Full Realism

Every constraint applies **identically in SIM and LIVE**.

### Entry Fill

```javascript
// Bid-ask half-spread (tiered by market volume)
function clobSpread(vol) {
  if (vol >= 500_000) return 0.012;  // 1.2¢ — deep liquid
  if (vol >= 100_000) return 0.025;  // 2.5¢
  if (vol >=  50_000) return 0.040;  // 4.0¢
  if (vol >=  10_000) return 0.060;  // 6.0¢
  return 0.080;                      // 8.0¢ — thin book
}
// TAKER: fillOdds = min(0.98, mid + spread + priceImpact(size, vol))
// MAKER: fillOdds = mid  (GTC limit at mid — zero spread paid)
```

**Partial fill** triggers when `betSize > maxOrderSize(vol)` (1% of daily volume).  
**Fill latency**: 800–2500ms in SIM / 50–300ms in LIVE.

### Mark-to-Market

```javascript
// 1. EMA smoothing (τ ≈ 1.1s per tick) — resists BTC spike noise
pos._markEMA = pos._markEMA * 0.88 + rawYesOdds * 0.12;

// 2. Time-gated mark cap
const maxMark = msLeft > 5*60000 ? 0.88 : msLeft > 2*60000 ? 0.92 : 0.97;

// 3. Expiry liquidity penalty (final 2 min → +0–3¢)
const liquidityPenalty = msLeft < 120000
  ? Math.min(0.03, 0.03 * (1 - msLeft / 120000)) : 0;
```

### Position Lifecycle

| Phase | SIM | LIVE |
|-------|-----|------|
| Fill latency | 800–2500ms | 50–300ms |
| Min hold before TP/SL | 2 seconds | ~1–3s |
| TP trigger | `pnlPct ≥ takeProfitPct` | Identical |
| SL trigger | `pnlPct ≤ −stopLossPct` | Identical |
| Force-close deadline | 5s before expiry | Identical |
| Protocol fee | 2% on gross at TIMEOUT | Settlement only |

---

## 📊 Dashboard Panels

The React dashboard is a fully draggable, resizable grid (react-grid-layout). All panels can be shown/hidden and repositioned.

| Panel | Description |
|-------|-------------|
| **Signal** | Live direction (BUY YES / BUY NO), edge meter, confidence score, per-asset mini signals (BTC / SOL / ETH) |
| **Risk Monitor** | **NEW** — Tabbed Risk/Fusion panel. Risk tab: 4-layer protection bars + streak sizing multiplier. Fusion tab: Fear & Greed live value, Coinbase divergence %, Spike Detector status |
| **BTC/USDT Chart** | 5s OHLCV candlestick with Bollinger Bands, VWAP, EMA 9/21 toggles |
| **SOL/USDT Chart** | Live SOL candlestick via Binance WS aggTrade |
| **ETH/USDT Chart** | Live ETH candlestick via Binance WS aggTrade |
| **Live Edge** | Binance implied vs Polymarket odds time series |
| **Balance Curve** | Equity curve over all closed trades |
| **Performance** | Win rate, total P&L, today P&L, peak, drawdown, streak |
| **Mercados** | All active markets (BTC/SOL/ETH) with YES/NO prices and volume |
| **Posições Abertas** | Open positions with live unrealized P&L, entry/mark odds, manual close |
| **Trade Log** | Full trade journal: time, direction, edge, size, spread, P&L, close reason |
| **Histórico** | Daily P&L bar chart + per-day breakdown table + TP/SL/TIMEOUT stats |

---

## 🌐 Multi-Asset Support

The bot trades **BTC, SOL, and ETH** simultaneously through separate Binance WebSocket streams and independent Polymarket market pools.

```
Asset    Binance Stream               Poly Market Filter
───────────────────────────────────────────────────────
BTC      btcusdt@aggTrade             /btc|bitcoin/i
SOL      solusdt@aggTrade             /\bsol\b|solana/i
ETH      ethusdt@aggTrade             /\beth\b|ethereum/i
```

Each asset maintains isolated: price history, VWAP coalesce window, OHLCV candles, vol history (for VPIN), SIM markets, and per-asset cooldown timer. Signals are ranked by confidence and the best across all assets becomes `currentSignal`.

---

## 🧾 Market Sources

### Real Polymarket Markets
Polled from `gamma-api.polymarket.com` every 90s + CLOB WebSocket subscription for live book updates. Must pass:
- **Duration**: 4.5–30.5 minutes
- **Volume**: ≥ $50,000
- **Format**: `"Bitcoin Up or Down - May 4, 7:30PM–7:45PM ET"`

### SIM Markets (Auto-Fallback)
Six synthetic markets auto-generated per asset at startup in identical format:

```
"Bitcoin Up or Down - May 4, 7:30PM-7:35PM ET"   ←  5 min
"Bitcoin Up or Down - May 4, 7:30PM-7:45PM ET"   ← 15 min
"Bitcoin Up or Down - May 4, 7:30PM-8:00PM ET"   ← 30 min
```

- Strike = asset spot at window open (`_strikeSnapshot`)
- Synthetic volumes $52k–$80k → triggers real CLOB tier pricing
- Fair value via `computeBinaryMid()` — same function as live markets

---

## ✅ SIM/LIVE Fidelity Checklist

| Component | Implementation | ✓ |
|-----------|----------------|---|
| Asset price feed | Real Binance aggTrade WS — zero synthetic injection | ✅ |
| Polymarket odds | Real Gamma API + CLOB WebSocket | ✅ |
| SIM market pricing | Binary option model + real price + realized σ | ✅ |
| Mark update frequency | `computeBinaryMid()` every 150ms | ✅ |
| Mark resistance | EMA smoothing τ ≈ 1.1s | ✅ |
| Mark ceiling | Time-gated cap: 0.88 → 0.92 → 0.97 by TTL | ✅ |
| Entry spread | `clobSpread(vol)` + `priceImpact(size, vol)` | ✅ |
| Exit spread | Half-spread deducted on sell side | ✅ |
| Expiry liquidity penalty | +0–3¢ ramp in final 2 minutes | ✅ |
| Partial fill | Capped at `maxOrderSize(vol)` | ✅ |
| Fill latency | 800–2500ms SIM (more conservative than LIVE) | ✅ |
| Minimum hold | 2s before any TP/SL fires | ✅ |
| Edge ceiling | `min(0.15, |edge|)` — eliminates model artefacts | ✅ |
| MIN_VOL $50k | Same threshold for SIM and LIVE | ✅ |
| Protocol fee | 2% on gross at TIMEOUT settlement only | ✅ |
| CLOB cooldown | `max(cooldownMs, 2000)` between trades | ✅ |
| Exposure cap | Total open cost ≤ 40% effective balance | ✅ |
| TP/SL alignment | Both trigger on `pnlPct` — same value as UI | ✅ |

---

## ⚙️ Configuration

All settings persist to `server/bot-config.json` and survive server restarts.

| Setting | Default | Description |
|---------|---------|-------------|
| `mode` | `SIM` | `SIM` (paper) or `LIVE` |
| `capital` | `1000` | Starting capital ($) |
| `entryMode` | `kelly` | `kelly` (dynamic) or `fixed` |
| `maxBetPct` | `6` | Kelly cap — max % of balance per trade |
| `fixedAmount` | `30` | Bet size when `entryMode = fixed` |
| `minEdge` | `0.02` | Minimum edge (2¢) to consider a signal |
| `takeProfitPct` | `14` | Close at +14% unrealized P&L |
| `stopLossPct` | `16` | Close at −16% unrealized P&L |
| `maxOpenPos` | `10` | Maximum concurrent open positions |
| `cooldownMs` | `2000` | Minimum ms between trades |
| `killThreshold` | `20` | Halt if drawdown from peak ≥ 20% |
| `requireStableEdge` | `false` | Gate entries on `isGoodEntry()` quality score |
| `allowDuplicateMarkets` | `true` | Allow multiple positions across markets |
| `orderType` | `TAKER` | `TAKER` (market) or `MAKER` (GTC limit) |
| `liveRiskEnabled` | `true` | Enable 4-layer Risk Manager |
| `liveDailyPauseDrawdownPct` | `5` | Daily loss % that triggers Layer 1 pause |
| `liveMonthlyPauseDrawdownPct` | `15` | Monthly loss % that triggers Layer 2 pause |

---

## 🚀 Getting Started

### Prerequisites

- Node.js ≥ 20 (v22 recommended)
- `npm` ≥ 9

### Local Development

```bash
# Clone
git clone https://github.com/spgule/poly-btc-bot.git
cd poly-btc-bot

# Install all dependencies
npm install
cd server && npm install && cd ..

# Terminal 1 — backend (port 3001)
npm run server

# Terminal 2 — frontend (port 5173, proxies /api → :3001)
npm run dev
```

Open `http://localhost:5173` — dashboard connects automatically.

### Production (Railway)

```bash
# Auto-deploy via git push
git push origin main

# Or manually
railway up
```

Railway build command (`nixpacks.toml`):
```bash
npm run build && node server/index.js
```

Express serves the Vite bundle from `/dist` + WebSocket + REST API — all on a single `$PORT`.

---

## 📁 Project Structure

```
poly-btc-bot/
├── server/
│   ├── index.js              # Core engine: feeds, model, CLOB, signals (~4400 lines)
│   ├── risk-manager.js       # 4-layer risk protection + dynamic position sizing
│   ├── signal-fusion.js      # Multi-source fusion: Coinbase, Fear&Greed, Spike detector
│   ├── package.json
│   ├── bot-config.json       # Persisted config  (gitignored)
│   ├── bot-trades.json       # Trade history     (gitignored)
│   └── bot-session.json      # Balance + stats   (gitignored)
├── src/
│   ├── App.jsx               # Dashboard — all panels, grid layout, WS client
│   ├── components/
│   │   ├── CandleChart.jsx   # 5s OHLCV candlestick with technical indicators
│   │   ├── ConfigModal.jsx   # Live settings panel
│   │   └── FusionRisk.jsx    # Risk/Fusion tabbed panel (4-layer bars + F&G + spike)
│   └── services/
│       └── api.js            # REST + WebSocket client
├── nixpacks.toml             # Railway: Node 22, build + start command
├── vite.config.js            # Dev proxy: /api → :3001
├── AGENTS.md                 # AI agent contribution guidelines
├── PRICE_FEED_LOCK.md        # Locked price feed rules (do not modify)
└── SIM_LIVE_FIDELITY.md      # SIM/LIVE fidelity contract
```

---

## 🔌 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Full bot state (balance, config, stats, signals) |
| `GET` | `/api/markets` | All active markets (BTC/SOL/ETH, live + SIM) |
| `GET` | `/api/candles` | BTC 5s OHLCV candles + edge history |
| `GET` | `/api/alt/candles?asset=SOL` | SOL or ETH candles |
| `GET` | `/api/trades` | Last 200 closed trades |
| `GET` | `/api/positions` | Open positions |
| `GET` | `/api/prices` | BTC price chart + 24h change |
| `GET` | `/api/fusion` | Signal Fusion status (F&G, divergence, spike) |
| `GET` | `/api/risk/status` | 4-layer Risk Manager state |
| `GET` | `/api/fees` | Fee breakdown (spread, gas, protocol) |
| `GET` | `/api/debug/feed` | Full diagnostic snapshot |
| `POST` | `/api/bot/start` | Start automated trading |
| `POST` | `/api/bot/stop` | Stop automated trading |
| `POST` | `/api/trade` | Execute manual trade on current signal |
| `POST` | `/api/config` | Patch config settings live |
| `POST` | `/api/risk/rearm` | Clear trading pause (manual rearm) |
| `POST` | `/api/risk/rearm-ext` | Rearm with new balance reference |
| `POST` | `/api/positions/:id/close` | Force-close an open position |
| `POST` | `/api/sim/reset` | Reset SIM balance + trade history |
| `WS` | `/ws` | Real-time broadcast (MARKET_DATA, SIGNAL, STATUS, TRADE, POSITIONS) |

---

## 🔒 Risk Controls

### Automatic (all modes)

| Control | Trigger | Action |
|---------|---------|--------|
| Kill Switch | Drawdown ≥ `killThreshold`% from peak | Halts bot permanently until restart |
| Settlement Guard | < 3 min to market expiry | Blocks new entries |
| VPIN Circuit Breaker | `VPIN > 0.75` | Skips signal (toxic flow regime) |
| Adverse Selection | ≥ 3 losses in last 5 trades | 60s entry pause |
| Exposure Cap | Open cost > 40% effective balance | Blocks new entry |
| Opposite Guard | Opposite side already open in market | Redirects to next best market |
| Spike Filter | BTC move > 15% in 3s | Activates counter-trend signal mode |

### 4-Layer Risk Manager (LIVE + SIM)

| Layer | Trigger | Pause Duration |
|-------|---------|----------------|
| Daily Loss | Day P&L drops ≥ 5% | 1 hour |
| Monthly Loss | Month P&L drops ≥ 15% | 30 days |
| Max Drawdown | Peak-to-trough ≥ 25% | 7 days |
| Total Halt | Capital loss ≥ 40% | Permanent (manual rearm) |

### Dynamic Sizing (Risk Manager)

- **Consecutive losses** → reduce bet by 20% per loss (floor: 0.5× base)
- **Consecutive wins** → increase bet by 10% per win (cap: 2.5× base)
- Current size multiplier always visible in the Risk Monitor dashboard panel

---

## ⚠️ Disclaimer

This software is for **educational and research purposes only**. Prediction market trading involves significant financial risk. Always validate thoroughly in **SIM mode** before enabling LIVE. Past simulation results — even with high-fidelity friction modelling — do not guarantee future LIVE performance. The Signal Fusion module uses publicly available data sources (Coinbase public API, alternative.me Fear & Greed Index) which may be unavailable or delayed without notice. Use entirely at your own risk.

---

<div align="center">

Built by [@spgule](https://github.com/spgule)

**Price Feeds** · Binance aggTrade WS + Coinbase REST &nbsp;|&nbsp; **Markets** · Polymarket Gamma API + CLOB WS &nbsp;|&nbsp; **Sentiment** · Fear & Greed Index &nbsp;|&nbsp; **Deploy** · Railway

</div>
