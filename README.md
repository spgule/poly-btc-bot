<div align="center">

# ⚡ Poly-BTC-Bot

### Autonomous Bitcoin Binary Options Arbitrage Engine

[![Node.js](https://img.shields.io/badge/Node.js-≥20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![Railway](https://img.shields.io/badge/Deploy-Railway-0B0D0E?style=for-the-badge&logo=railway&logoColor=white)](https://railway.app)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

> **Exploits the pricing lag between real-time BTC price movements and Polymarket binary options,**  
> **entering positions before the market maker can reprice.**

</div>

---

## 🧠 How It Works

The core insight: **Polymarket reprices binary options every ~90 seconds via API polling.** In that window, if BTC makes a significant move, the market is mispriced. This bot detects that gap — the **edge** — and executes before it closes.

```
BTC moves $500 in 60s
        │
        ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│   computeImpliedProb()  │     │    computePolyOdds()     │
│                         │     │                          │
│  Binary option model    │     │  Stale Polymarket price  │
│  P(BTC > strike | NOW)  │     │  from 90s ago (Gamma API)│
│                         │     │                          │
│     implied = 0.70      │     │     poly    = 0.50       │
└──────────┬──────────────┘     └──────────┬───────────────┘
           │                               │
           └─────────── edge = +0.20 ──────┘
                              │
                              ▼
                     ✅ BUY_YES signal
                   Enter before reprice
```

---

## 📐 Pricing Model

Both the **signal** and **mark-to-market P&L** use a binary option formula:

$$P(\text{BTC}_T > K) \approx \Phi(d_2), \quad d_2 = \frac{\ln(S/K)}{\sigma\sqrt{T}}$$

```javascript
// Real-time fair value for a Polymarket binary question
function computeBinaryMid(market) {
  const strikeMatch = market.question?.match(/\$([0-9,]+)/);
  const strike = strikeMatch ? parseFloat(strikeMatch[1].replace(/,/g, '')) : btc;

  const hoursLeft = Math.max(1 / 3600, msLeft / 3600000);
  const volPerHour = Math.max(0.001, recentVolatility(60000) * Math.sqrt(3600));

  // Black-Scholes d2
  const d2 = Math.log(btc / strike) / (volPerHour * Math.sqrt(hoursLeft));

  // Logistic CDF ≈ Φ(d2)
  return Math.max(0.03, Math.min(0.97, 1 / (1 + Math.exp(-1.7 * d2))));
}
```

The **edge** is simply `implied(realtime) − poly(stale)`. When BTC moves, `implied` updates instantly. `poly` stays at the 90s-old Gamma API value. The gap is the tradeable opportunity.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Railway Cloud                           │
│                                                                 │
│  ┌─────────────────┐          ┌──────────────────────────────┐  │
│  │   Express API   │◄────────►│      React Dashboard         │  │
│  │   + WebSocket   │  ws://   │  (Vite + Tailwind + Recharts)│  │
│  └────────┬────────┘          └──────────────────────────────┘  │
│           │                                                     │
│  ┌────────▼────────────────────────────────────────────────┐    │
│  │                    Bot Engine                           │    │
│  │                                                         │    │
│  │  Binance WS ──► priceHistory ──► computeBinaryMid()     │    │
│  │  (real-time)      (5 min)            │                  │    │
│  │                                      │ edge             │    │
│  │  Polymarket ──► outcomePrices ───────┘                  │    │
│  │  Gamma API        (90s stale)                           │    │
│  │  (90s poll)                                             │    │
│  │                                      │                  │    │
│  │                              CLOB Simulation            │    │
│  │                           spread + impact + fill        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✅ Simulation Fidelity

SIM mode is **identical to LIVE** in every constraint that matters:

| Component | Implementation |
|---|---|
| 📡 BTC Price | 100% real Binance WS — no synthetic data |
| 📊 Polymarket Odds | Real Gamma API, polled every 90s |
| 🔢 Sim Market Pricing | Binary option model `P(BTC > strike)` using real BTC + realized vol |
| 💸 Entry Cost | CLOB spread + price impact (volume-tiered) |
| 💸 Exit Cost | Half-spread deducted on sell (BID price) |
| 📉 Min Volume | $50k — same threshold for SIM and LIVE |
| 🏦 Protocol Fee | 2% on gross winnings — only at settlement, not CLOB early-sells |
| ⏱️ Cooldown | Minimum 2s between trades (mirrors CLOB rate limit) |

> Results in SIM are meaningful. What works in SIM will work in LIVE.

---

## 🎯 CLOB Execution Engine

Order fills are modelled after real Polymarket CLOB observed data:

```javascript
function clobSpread(marketVolume) {
  if (marketVolume >= 500_000) return 0.012; // 1.2¢ — deep liquid
  if (marketVolume >= 100_000) return 0.025; // 2.5¢
  if (marketVolume >=  50_000) return 0.040; // 4.0¢
  if (marketVolume >=  10_000) return 0.060; // 6.0¢
  return 0.080;                              // 8.0¢ — thin market
}

// You always buy at ASK = mid + spread + price_impact
// You always sell at BID = mid − spread
```

**Partial fills** are simulated when order size exceeds `1% of daily volume`. **Price impact** scales with order size relative to available depth.

---

## 📊 Dashboard

The real-time dashboard runs in your browser:

- **Live BTC price** with TradingView-style candlestick chart
- **Edge meter** — shows `implied vs poly` gap updating every tick  
- **Open positions** with live unrealized P&L (updates every 150ms)
- **Trade history** with entry/exit odds, spread, fee breakdown
- **Equity curve** tracking balance over time
- **Config panel** — tune `minEdge`, `TP%`, `SL%`, Kelly sizing, cooldown

---

## 🚀 Getting Started

### Prerequisites
- Node.js ≥ 20
- A Railway account (for cloud deployment) or run locally

### Local Development

```bash
# Clone
git clone https://github.com/spgule/poly-btc-bot.git
cd poly-btc-bot

# Install dependencies
npm install
cd server && npm install && cd ..

# Start both frontend (Vite) and backend concurrently
npm run dev          # frontend → http://localhost:5173
npm run server       # backend  → http://localhost:3001
```

### Production (Railway)

```bash
# Railway auto-detects nixpacks.toml and deploys the full stack
# The server serves the built frontend from /dist
railway up
```

The `start` script builds and serves everything from port `$PORT`:
```bash
npm run build && node server/index.js
```

---

## ⚙️ Configuration

All settings are persisted to `server/bot-config.json` and survive restarts.

| Setting | Default | Description |
|---|---|---|
| `mode` | `SIM` | `SIM` (paper trading) or `LIVE` |
| `minEdge` | `0.02` | Minimum edge (2¢) to consider a signal |
| `takeProfitPct` | `5` | Close position at +5% gain |
| `stopLossPct` | `8` | Close position at −8% loss |
| `posTimeoutMs` | `1800000` | Force-close after 30 min |
| `maxBetPct` | `6` | Max 6% of balance per trade (Kelly cap) |
| `cooldownMs` | `1000` | Minimum ms between trades |
| `capital` | `1000` | Starting capital |
| `entryMode` | `kelly` | `kelly` (dynamic sizing) or `fixed` |

---

## 🔬 Signal Logic

```
Edge = computeImpliedProb() − computePolyOdds()

Edge > +minEdge  →  BUY_YES  (market underprices the outcome)
Edge < −minEdge  →  BUY_NO   (market overprices the outcome)
```

**Dynamic threshold**: `minEdge` is scaled up in high-volatility environments to avoid noise trades:
```javascript
const dynMinEdge = config.minEdge * Math.max(1.0, Math.min(1.5, vol / 0.0015));
```

**Kill switch**: If drawdown from peak exceeds `killThreshold` (default 20%), the bot stops automatically.

---

## 📁 Project Structure

```
poly-btc-bot/
├── server/
│   ├── index.js          # Main engine: price feeds, arb logic, CLOB, API
│   ├── package.json
│   ├── bot-config.json   # Persisted settings (gitignored)
│   ├── bot-trades.json   # Trade history (gitignored)
│   └── bot-session.json  # Balance/stats (gitignored)
├── src/
│   ├── App.jsx           # Full dashboard UI
│   ├── components/
│   │   ├── CandleChart.jsx   # TradingView-style OHLCV chart
│   │   └── ConfigModal.jsx   # Settings panel
│   └── services/
│       └── api.js            # REST + WebSocket client
├── nixpacks.toml         # Railway deployment config
└── vite.config.js
```

---

## ⚠️ Disclaimer

This bot is for **educational and research purposes**. Trading prediction markets involves significant financial risk. Always test thoroughly in **SIM mode** before enabling LIVE trading. Past simulation performance does not guarantee future results.

---

<div align="center">

Built with ⚡ by [@spgule](https://github.com/spgule)

**BTC Price** · Binance WS &nbsp;|&nbsp; **Markets** · Polymarket Gamma API &nbsp;|&nbsp; **Deploy** · Railway

</div>
