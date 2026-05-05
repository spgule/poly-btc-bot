<div align="center">

<img src="https://img.shields.io/badge/STATUS-LIVE%20SIM-00ff88?style=for-the-badge&labelColor=0d0d0d" />

# ⚡ POLY-BTC-BOT

### Autonomous Bitcoin Binary Options Arbitrage Engine

<p>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white"/></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black"/></a>
  <a href="https://vitejs.dev"><img src="https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white"/></a>
  <a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind-3-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white"/></a>
  <a href="https://railway.app"><img src="https://img.shields.io/badge/Deploy-Railway-0B0D0E?style=flat-square&logo=railway&logoColor=white"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square"/></a>
</p>

<br/>

> **Exploits the pricing lag between real-time Binance BTC ticks and Polymarket binary options.**  
> When BTC moves, Polymarket reprices ~90 seconds later. This engine detects that window,  
> sizes positions via Kelly criterion, and executes through a high-fidelity CLOB simulator.

<br/>

</div>

---

## 🧠 Core Insight

Polymarket updates its binary option prices by polling the Gamma API — roughly every **90 seconds**. In that window, a significant BTC move creates a mispricing between the market's stale quote and the true fair value. This bot computes the fair value in real time and enters before the reprice closes the gap.

```
BTC: $96,400 → $97,100  (+$700 in 45s)
         │
         ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│   computeBinaryMid()     │       │  Polymarket Gamma API     │
│                          │       │                           │
│  Black-Scholes logistic  │       │  Price last updated 45s   │
│  P(BTC_T > K | S=97100)  │       │  ago — still pricing at   │
│                          │       │  the old BTC level        │
│     implied  =  0.68     │       │     poly     =  0.50      │
└──────────┬───────────────┘       └──────────┬────────────────┘
           │                                  │
           └──────── edge = +0.18 ────────────┘
                            │
                            ▼
             ✅  BUY_YES · Edge capped at 0.15 · Kelly bet
             ⏳  Fill latency 800–2500ms simulated
             📈  Mark EMA-smoothed · Liquidity-penalized exit
```

---

## 📐 Pricing Model

The fair value of any Polymarket binary is computed using a **Black-Scholes logistic approximation**:

$$P(\text{BTC}_T > K) \approx \frac{1}{1 + e^{-d_1}}, \quad d_1 = \frac{\ln(S/K)}{\sigma\sqrt{T}}$$

Where:
- $S$ = current BTC spot price (Binance aggTrade WebSocket, real-time)
- $K$ = strike price parsed from the market question, or `_strikeSnapshot` for "Up or Down" markets
- $\sigma$ = realized 1-minute BTC volatility scaled to per-hour
- $T$ = hours until market expiry

```javascript
// σ: realized vol (1-min window) → annualized per-hour
const realizedVol = Math.max(0.001, recentVolatility(60000) * Math.sqrt(3600));
const sigmaT      = realizedVol * Math.sqrt(hoursLeft);
const d1          = Math.log(btc / strike) / Math.max(0.001, sigmaT);

return clampProb(1 / (1 + Math.exp(-d1)));
```

The **edge** is `implied(real-time) − poly(stale Gamma API)`. The signal fires when `|edge| ≥ dynMinEdge`, confirmed by at least **2-of-3** independent filters.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              Railway Cloud                               │
│                                                                          │
│  ┌─────────────────────┐   WebSocket    ┌────────────────────────────┐  │
│  │    Express Server   │◄──────────────►│     React Dashboard        │  │
│  │    + REST API       │   broadcast()  │  Vite · Tailwind · Recharts│  │
│  └──────────┬──────────┘                └────────────────────────────┘  │
│             │                                                            │
│  ┌──────────▼──────────────────────────────────────────────────────┐    │
│  │                     Bot Engine  (server/index.js)               │    │
│  │                                                                 │    │
│  │  ┌──────────────────┐    ┌──────────────────────────────────┐   │    │
│  │  │  Binance WS      │    │  Polymarket Gamma API             │   │    │
│  │  │  aggTrade feed   │    │  90s poll · CLOB WS subscription  │   │    │
│  │  │  7-host failover │    │  real outcomePrices[]             │   │    │
│  │  └────────┬─────────┘    └──────────────┬───────────────────┘   │    │
│  │           │                             │                        │    │
│  │    priceHistory[]              market.outcomePrices[]            │    │
│  │    btcPriceCoalesced           (Gamma API or SIM model)          │    │
│  │    (100ms VWAP)                         │                        │    │
│  │           │                             │                        │    │
│  │           └──────── edge ───────────────┘                        │    │
│  │                       │                                          │    │
│  │            ┌──────────▼──────────────┐                           │    │
│  │            │    Signal Pipeline      │                           │    │
│  │            │  VPIN · Bollinger       │                           │    │
│  │            │  Trend · 2-of-3 confirm │                           │    │
│  │            └──────────┬──────────────┘                           │    │
│  │                       │                                          │    │
│  │            ┌──────────▼──────────────┐                           │    │
│  │            │   CLOB Simulation       │                           │    │
│  │            │  spread · impact · fill │                           │    │
│  │            │  EMA mark · time cap    │                           │    │
│  │            │  expiry penalty         │                           │    │
│  │            └─────────────────────────┘                           │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 🎯 Signal Pipeline

Every 150ms the engine runs through a multi-layer quality filter before any trade fires:

```
1.  Settlement Guard     — block entries in final 3 min of any ≤30min market
2.  VPIN Toxicity        — computeVPIN() > 0.75 → pause (adverse flow regime)
3.  2-of-3 Confirmation  — trend (10s BTC), edgeVelocity(), |edge| ≥ dynMinEdge
4.  Adverse Selection    — ≥3 of last 5 trades lost → 60s cooldown
5.  Exposure Cap         — total open positions ≤ 40% of effective balance
6.  Edge Cap 15¢         — cap edge before Kelly sizing (institutional arb ceiling)
7.  Min Edge             — dynMinEdge scales up during high-volatility regimes
8.  hasSameSide Guard    — redirect to alternative market if same-side already open
9.  Volume Filter        — live markets require ≥ $50k volume
10. Kill Switch          — drawdown from peak ≥ killThreshold% → halt all trading
```

---

## 🔬 CLOB Execution — Full Realism

Order fills are modelled from observed Polymarket CLOB behaviour. **Every constraint applies identically in SIM and LIVE.**

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
// MAKER: fillOdds = mid  (GTC limit posted at mid — no spread paid)
```

**Partial fill** triggers when `betSize > maxOrderSize(vol)` (1% of daily volume). Fill latency: **800–2500ms** in SIM / 50–300ms in LIVE.

### Mark-to-Market — 3 Layers of Friction

```javascript
// 1. EMA smoothing — order books resist sudden BTC moves (τ ≈ 1.1s per tick)
pos._markEMA = pos._markEMA * 0.88 + rawYesOdds * 0.12;

// 2. Time-based mark cap — institutional MM ceiling by time-to-live
const maxMark = msLeft > 5 * 60000 ? 0.88   // T > 5 min:  arb ceiling
              : msLeft > 2 * 60000 ? 0.92   // T 2–5 min:  approaching expiry
              : 0.97;                        // T < 2 min:  near settlement

// 3. Expiry liquidity penalty — book thins near settlement
const liquidityPenalty = msLeft < 120000
  ? Math.min(0.03, 0.03 * (1 - msLeft / 120000))  // 0¢ → 3¢ ramp
  : 0;
```

### Position Lifecycle

| Phase | SIM | LIVE |
|---|---|---|
| Fill latency | **800–2500ms** | 50–300ms (real network) |
| Minimum hold before TP/SL | **2 seconds** | ~1–3s CLOB confirmation |
| TP trigger | `pnlPct ≥ takeProfitPct` | Identical |
| SL trigger | `pnlPct ≤ −stopLossPct` | Identical |
| Force-close deadline | 5s before market expiry | Identical |
| Expiry penalty | +0–3¢ in final 2 min | Order book naturally thins |

> TP/SL uses `pnlPct` — the exact number shown in the UI. No hidden divergence between display and trigger.

---

## 🧾 Market Sources

### Real Polymarket Markets
The bot polls `gamma-api.polymarket.com` every 90s and subscribes to the CLOB WebSocket for live book updates. Markets must pass:
- **Duration**: 4.5–30.5 minutes (window extracted from question text, not `endDate − startDate` which would be ~1440 min for daily markets)
- **Volume**: ≥ $50,000
- **Format**: `"Bitcoin Up or Down - May 4, 7:30PM–7:45PM ET"`

> **Current status**: Real Polymarket "Up or Down" BTC markets have $0–$99 volume — below the $50k floor. The bot falls back to SIM markets and will automatically switch to LIVE when liquidity exists.

### SIM Markets (Fallback)
Six synthetic markets are auto-generated at startup in **identical format to real Polymarket**:

```
"Bitcoin Up or Down - May 4, 7:30PM-7:35PM ET"   ←  5 min
"Bitcoin Up or Down - May 4, 7:30PM-7:40PM ET"   ← 10 min
"Bitcoin Up or Down - May 4, 7:30PM-7:45PM ET"   ← 15 min
"Bitcoin Up or Down - May 4, 7:30PM-7:50PM ET"   ← 20 min
"Bitcoin Up or Down - May 4, 7:30PM-7:55PM ET"   ← 25 min
"Bitcoin Up or Down - May 4, 7:30PM-8:00PM ET"   ← 30 min
```

- Strike = BTC spot at window open (`_strikeSnapshot`) — no dollar amount in question
- Volumes: $52k–$80k → triggers real CLOB tier pricing
- Fair value computed via `computeBinaryMid()` — same function as live markets

---

## ✅ SIM Fidelity Checklist

18 constraints locked identically across SIM and LIVE:

| Component | Implementation | ✓ |
|---|---|---|
| BTC price feed | Real Binance aggTrade WS — zero synthetic injection | ✅ |
| Polymarket odds | Real Gamma API (live markets) | ✅ |
| SIM market pricing | Binary option model + real BTC + realized σ | ✅ |
| Mark update frequency | `computeBinaryMid()` every 150ms tick | ✅ |
| Mark resistance | EMA smoothing τ ≈ 1.1s (resists BTC spikes) | ✅ |
| Mark ceiling | Time-gated cap: 0.88 → 0.92 → 0.97 by TTL | ✅ |
| Entry spread | `clobSpread(vol)` + `priceImpact(size, vol)` | ✅ |
| Exit spread | Half-spread deducted on sell side | ✅ |
| Expiry liquidity penalty | +0–3¢ ramp in final 2 minutes | ✅ |
| Partial fill | Capped at `maxOrderSize(vol)` | ✅ |
| Fill latency | 800–2500ms (SIM is more conservative than LIVE) | ✅ |
| Minimum hold | 2s before any TP/SL fires | ✅ |
| Edge ceiling | `cappedEdge = min(0.15, \|edge\|)` — eliminates model artefacts | ✅ |
| MIN_VOL $50k | Same threshold for SIM and LIVE | ✅ |
| Protocol fee | 2% on gross at TIMEOUT settlement only | ✅ |
| CLOB cooldown | min(cooldownMs, 2000) between trades | ✅ |
| Exposure cap | Total open cost ≤ 40% effective balance | ✅ |
| TP/SL alignment | Both trigger on `pnlPct` — same value as UI display | ✅ |

---

## 📊 Dashboard

<table>
<tr>
<td width="50%">

**Live Metrics**
- Real-time BTC price + 24h change
- Edge meter: `implied vs poly` every 150ms
- Open positions with live `unrealizedPnl`
- Equity curve — balance over time

</td>
<td width="50%">

**Charts**
- 5s OHLCV candlestick (TradingView-style)
- Edge history overlay
- Mark vs entry odds per open position

</td>
</tr>
<tr>
<td>

**Trade Journal**
- Entry/exit odds, spread paid, fee breakdown
- Hold time, close reason (TP / SL / TIMEOUT / MERGE)
- Win rate, streak, today's P&L

</td>
<td>

**Config Panel**
- All parameters tunable live (no restart)
- Persisted to `bot-config.json`
- LIVE risk controls: daily/monthly drawdown pause, loss-streak pause, manual rearm

</td>
</tr>
</table>

---

## ⚙️ Configuration

All settings persist to `server/bot-config.json` and survive server restarts.

| Setting | Default | Description |
|---|---|---|
| `mode` | `SIM` | `SIM` (paper) or `LIVE` |
| `capital` | `1000` | Starting capital ($) |
| `entryMode` | `kelly` | `kelly` (dynamic sizing) or `fixed` |
| `maxBetPct` | `6` | Kelly cap — max % of balance per trade |
| `fixedAmount` | `1` | Bet size when `entryMode = fixed` |
| `minEdge` | `0.02` | Minimum edge (2¢) to consider a signal |
| `takeProfitPct` | `5` | Close at +5% unrealized P&L |
| `stopLossPct` | `8` | Close at −8% unrealized P&L |
| `maxOpenPos` | `10` | Maximum concurrent open positions |
| `cooldownMs` | `2000` | Minimum ms between trades |
| `killThreshold` | `20` | Halt if drawdown from peak ≥ 20% |
| `requireStableEdge` | `false` | Gate entries on `isGoodEntry()` quality score |
| `allowDuplicateMarkets` | `true` | Allow positions across different markets |
| `orderType` | `MAKER` | `MAKER` (GTC limit, no spread) or `TAKER` |

---

## 🚀 Getting Started

### Prerequisites

- Node.js ≥ 20 (v22 recommended — same as Railway deployment)
- `npm` ≥ 9

### Local Development

```bash
# Clone
git clone https://github.com/spgule/poly-btc-bot.git
cd poly-btc-bot

# Install root + server dependencies
npm install
cd server && npm install && cd ..

# Terminal 1 — backend (port 3001)
npm run server

# Terminal 2 — frontend dev server (port 5173, proxies /api → :3001)
npm run dev
```

Open `http://localhost:5173` — the dashboard connects to the backend automatically.

### Production (Railway)

```bash
# Deploy with Railway CLI
railway up

# Or just push to main — Railway auto-deploys via nixpacks.toml
git push origin main
```

Production start command (in `nixpacks.toml`):
```bash
npm run build && node server/index.js
```
Express serves the built Vite bundle from `/dist` and the WebSocket + REST API — all on a single `$PORT`.

---

## 📁 Project Structure

```
poly-btc-bot/
├── server/
│   ├── index.js           # Engine: BTC feed, model, CLOB, signal, API (~3200 lines)
│   ├── package.json
│   ├── bot-config.json    # Persisted config  (gitignored)
│   ├── bot-trades.json    # Trade history     (gitignored)
│   └── bot-session.json   # Balance + stats   (gitignored)
├── src/
│   ├── App.jsx             # Full dashboard — metrics, equity, positions, journal
│   ├── components/
│   │   ├── CandleChart.jsx     # 5s OHLCV candlestick chart (Recharts)
│   │   └── ConfigModal.jsx     # Live settings panel
│   └── services/
│       └── api.js              # REST + WebSocket client
├── nixpacks.toml           # Railway: Node 22, build + start
├── vite.config.js          # Dev proxy: /api → :3001
└── tailwind.config.js
```

---

## 🔒 Risk Controls

### Automatic (all modes)
| Control | Trigger | Action |
|---|---|---|
| Kill Switch | Drawdown ≥ `killThreshold`% | Halts bot permanently until restart |
| Settlement Guard | < 3 min to market expiry | Blocks new entries |
| VPIN Circuit Breaker | `VPIN > 0.75` | Skips signal |
| Adverse Selection | ≥ 3 losses in last 5 trades | 60s entry pause |
| Exposure Cap | Open cost > 40% effective balance | Blocks new entry |
| Opposite Guard | Opposite side already open | Skips or redirects |

### LIVE-Mode Additional Controls
| Control | Description |
|---|---|
| Daily drawdown pause | Pause for N hours if daily P&L drops X% |
| Monthly drawdown pause | Pause for N days if monthly P&L drops X% |
| Loss-streak pause | Pause after N consecutive losses |
| Manual rearm | Operator must explicitly resume after any pause |

---

## ⚠️ Disclaimer

This software is for **educational and research purposes only**. Prediction market trading involves significant financial risk. Always validate thoroughly in **SIM mode** before enabling LIVE. Past simulation results — even with high-fidelity friction modelling — do not guarantee future LIVE performance. Use entirely at your own risk.

---

<div align="center">

Built by [@spgule](https://github.com/spgule)

**Price Feed** · Binance aggTrade WebSocket &nbsp;|&nbsp; **Markets** · Polymarket Gamma API &nbsp;|&nbsp; **Deploy** · Railway

</div>
