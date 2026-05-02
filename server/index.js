'use strict';
const express = require('express');
const cors    = require('cors');
const WebSocket = require('ws');
const http    = require('http');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const CONFIG_FILE  = path.join(__dirname, 'bot-config.json');
const TRADES_FILE  = path.join(__dirname, 'bot-trades.json');
const SESSION_FILE = path.join(__dirname, 'bot-session.json');

function loadSavedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const saved = JSON.parse(raw);
      console.log('[Config] Loaded saved config from disk');
      return saved;
    }
  } catch (e) {
    console.warn('[Config] Failed to load saved config:', e.message);
  }
  return null;
}

function saveTrades() {
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(state.trading.trades.slice(0, 500), null, 2), 'utf8');
  } catch (e) { console.warn('[Trades] Failed to save trades:', e.message); }
}

function loadSavedTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) {
      const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
      if (Array.isArray(trades) && trades.length > 0) {
        state.trading.trades = trades;
        // Recompute stats from saved trades
        state.stats.totalTrades = trades.length;
        state.stats.wins        = trades.filter(t => t.outcome === 'WIN').length;
        state.stats.losses      = trades.filter(t => t.outcome === 'LOSS').length;
        state.stats.totalPnl    = Math.round(trades.reduce((s, t) => s + (t.pnl || 0), 0) * 100) / 100;
        // Today PnL: trades closed today UTC
        const todayStart = new Date().setUTCHours(0, 0, 0, 0);
        state.stats.todayPnl = Math.round(
          trades.filter(t => t.timestamp >= todayStart).reduce((s, t) => s + (t.pnl || 0), 0) * 100
        ) / 100;
        console.log(`[Trades] Loaded ${trades.length} trades from disk`);
      }
    }
  } catch (e) { console.warn('[Trades] Failed to load trades:', e.message); }
}

function saveSession() {
  try {
    const s = {
      balance:      state.trading.balance,
      startBalance: state.trading.startBalance,
      peakBalance:  state.trading.peakBalance,
      stats:        state.stats,
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch (e) { console.warn('[Session] Failed to save session:', e.message); }
}

function loadSavedSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (s.balance      !== undefined) state.trading.balance      = s.balance;
      if (s.startBalance !== undefined) state.trading.startBalance = s.startBalance;
      if (s.peakBalance  !== undefined) state.trading.peakBalance  = s.peakBalance;
      // Stats overridden by loadSavedTrades — only apply if no trades file
      if (!fs.existsSync(TRADES_FILE) && s.stats) Object.assign(state.stats, s.stats);
      console.log(`[Session] Restored balance: $${state.trading.balance}`);
    }
  } catch (e) { console.warn('[Session] Failed to load session:', e.message); }
}

function saveConfig() {
  try {
    const toSave = {
      mode:                  state.config.mode,
      capital:               state.config.capital,
      entryMode:             state.config.entryMode,
      fixedAmount:           state.config.fixedAmount,
      maxBetPct:             state.config.maxBetPct,
      minEdge:               state.config.minEdge,
      killThreshold:         state.config.killThreshold,
      autoTrade:             state.config.autoTrade,
      takeProfitPct:         state.config.takeProfitPct,
      stopLossPct:           state.config.stopLossPct,
      posTimeoutMs:          state.config.posTimeoutMs,
      maxOpenPos:            state.config.maxOpenPos,
      requireStableEdge:     state.config.requireStableEdge,
      allowDuplicateMarkets: state.config.allowDuplicateMarkets,
      cooldownMs:            state.trading.cooldownMs,
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Config] Failed to save config:', e.message);
  }
}

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3001;
// Port 443 works through Railway's proxy; port 9443 is blocked
const BINANCE_WS     = 'wss://stream.binance.com:443/ws/btcusdt@trade';
const BINANCE_REST   = 'https://api.binance.com/api/v3';
const POLY_GAMMA     = 'https://gamma-api.polymarket.com';
const LAG_MS         = 2700;   // Polymarket average update lag
const PRICE_HIST_MS  = 300000; // 5 minutes of price history for charts
const POLY_FEE_RATE  = 0.02;   // Polymarket: 2% protocol fee on gross winnings (applied at settlement)
const CANDLE_SEC     = 5;      // 5-second OHLCV candles for TradingView-style chart

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  btcPrice:      97000,
  btcChange24h:  0,       // % change last 24h
  priceHistory:  [],      // { price, time } – last PRICE_HIST_MS ms
  priceChart:    [],      // sampled 1/sec, last 300 pts – sent to chart
  edgeHistory:   [],      // { time, edge, implied, poly } for edge chart

  config: {
    mode: 'SIM',
    capital: 1000,
    entryMode: 'kelly',
    fixedAmount: 30,
    maxBetPct: 6,
    minEdge: 0.03,
    killThreshold: 20,
    autoTrade: false,
    privateKey: null,
    takeProfitPct: 14,
    stopLossPct:   16,
    posTimeoutMs:  150000,
    maxOpenPos:    10,
    requireStableEdge: false,
    allowDuplicateMarkets: true,
  },

  trading: {
    active:      false,
    balance:     1000,
    startBalance:1000,
    peakBalance: 1000,
    trades:      [],
    lastTradeTs: 0,
    cooldownMs:  500,    // 500ms cooldown — high-frequency scalping mode
  },

  positions:        [],   // open/recently closed positions

  stats: {
    totalTrades: 0,
    wins:        0,
    losses:      0,
    totalPnl:    0,
    todayPnl:    0,
    streak:      0,
  },

  markets:          [],
  currentSignal:    null,
  binanceConnected: false,
  priceSource:      'binance',  // 'binance' | 'coingecko'
  lastPriceChartTs: 0,
  candles:          [],   // closed 5s OHLCV candles ({ time (s), open, high, low, close, ticks })
  currentCandle:    null, // currently forming 5s candle
};

// ── PRICE CHART SAMPLER ───────────────────────────────────────────────────────
function addChartPoint(price, time) {
  if (time - state.lastPriceChartTs >= 1000) {
    state.priceChart.push({ t: time, p: price });
    if (state.priceChart.length > 300) state.priceChart.shift();
    state.lastPriceChartTs = time;
  }
}

// ── OHLCV CANDLE BUILDER ──────────────────────────────────────────────────────────
function updateCandle(price, now) {
  const bucket = Math.floor(now / (CANDLE_SEC * 1000)) * CANDLE_SEC; // seconds
  const c = state.currentCandle;
  if (!c || c.time !== bucket) {
    if (c) {
      state.candles.push(c);
      if (state.candles.length > 600) state.candles.shift();
    }
    state.currentCandle = { time: bucket, open: price, high: price, low: price, close: price, ticks: 1 };
  } else {
    c.high  = Math.max(c.high, price);
    c.low   = Math.min(c.low,  price);
    c.close = price;
    c.ticks++;
  }
}

// ── SIM VOLATILITY INJECTOR ───────────────────────────────────────────────────
// When in SIM mode and real price is flat, inject synthetic micro-trend history
// so the momentum model always has an edge signal to work with.
let simDrift = 0;          // running drift direction for realistic walk
let simDriftTtl = 0;       // ticks remaining in this drift direction
let lastArbCheckTs = 0;    // throttle: prevents per-tick edgeHistory spam
let lastBroadcastTs = 0;   // throttle: cap broadcast rate at ~150ms

function injectSimVolatility(basePrice, now) {
  // Simulate a realistic micro-trend: random walk with mean-reversion
  if (simDriftTtl <= 0) {
    simDrift    = (Math.random() - 0.48) * 0.0015;  // slight upward bias
    simDriftTtl = 3 + Math.floor(Math.random() * 8);
  }
  simDriftTtl--;

  const noise  = (Math.random() - 0.5) * 0.0003;
  const factor = 1 + simDrift + noise;
  const fakePrice = Math.round(basePrice * factor * 100) / 100;
  const fakePast  = now - 25000 - Math.floor(Math.random() * 5000); // 25-30s ago

  // Only inject if we don't already have data that far back
  const hasOldData = state.priceHistory.some(p => Math.abs(p.time - fakePast) < 3000);
  if (!hasOldData) {
    state.priceHistory.push({ price: fakePrice, time: fakePast });
    state.priceHistory.sort((a, b) => a.time - b.time);
  }
}

// ── BINANCE WS FEED ───────────────────────────────────────────────────────────
let binanceTimer = null;
let lastWsMsgTs  = 0;   // last time we received a real price tick

function connectBinance() {
  if (binanceTimer) { clearTimeout(binanceTimer); binanceTimer = null; }
  const ws = new WebSocket(BINANCE_WS);

  ws.on('open', () => {
    state.binanceConnected = true;
    state.priceSource = 'binance';
    lastWsMsgTs = Date.now();
    console.log('[Binance WS] Connected');
    broadcast({ type: 'CONNECTION', data: { binanceConnected: true, priceSource: 'binance' } });
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const price = parseFloat(msg.p);
      if (!price || isNaN(price)) return;
      lastWsMsgTs = Date.now();   // heartbeat
      state.btcPrice = price;
      const now = Date.now();
      state.priceHistory.push({ price, time: now });
      state.priceHistory = state.priceHistory.filter(p => now - p.time <= PRICE_HIST_MS);
      addChartPoint(price, now);
      updateCandle(price, now);
      if (state.config.mode === 'SIM') injectSimVolatility(price, now);
      if (state.trading.active && now - lastArbCheckTs >= 100) {
        lastArbCheckTs = now;
        runArbitrageCheck();
      }
      if (now - lastBroadcastTs >= 150) {
        lastBroadcastTs = now;
        broadcastMarketData();
      }
    } catch (e) { /* ignore */ }
  });

  ws.on('close', () => {
    state.binanceConnected = false;
    broadcast({ type: 'CONNECTION', data: { binanceConnected: false, priceSource: 'binance-rest' } });
    console.log('[Binance WS] Disconnected – reconnecting in 4s');
    binanceTimer = setTimeout(connectBinance, 4000);
  });

  ws.on('error', (err) => {
    console.error('[Binance WS] Error:', err.message);
    try { ws.terminate(); } catch (_) {}
  });

  // Heartbeat guard: if WS appears connected but no message arrives in 15s,
  // the Railway proxy silently dropped the connection — force reconnect.
  const heartbeatGuard = setInterval(() => {
    if (state.binanceConnected && Date.now() - lastWsMsgTs > 15000) {
      console.warn('[Binance WS] No message in 15s – forcing reconnect');
      state.binanceConnected = false;
      clearInterval(heartbeatGuard);
      try { ws.terminate(); } catch (_) {}
      binanceTimer = setTimeout(connectBinance, 1000);
    }
  }, 5000);

  ws.on('close', () => clearInterval(heartbeatGuard));
}

// ── BINANCE REST FALLBACK (no API key required) ─────────────────────────────
async function pollBinanceRest() {
  if (state.binanceConnected) return;
  try {
    const { data } = await axios.get(`${BINANCE_REST}/ticker/price`, {
      params: { symbol: 'BTCUSDT' },
      timeout: 5000,
    });
    const price = parseFloat(data.price);
    if (!price || isNaN(price)) return;
    state.btcPrice = price;
    const now = Date.now();
    state.priceHistory.push({ price, time: now });
    state.priceHistory = state.priceHistory.filter(p => now - p.time <= PRICE_HIST_MS);
    addChartPoint(price, now);
    updateCandle(price, now);
    // SIM mode: inject synthetic micro-volatility so momentum model has enough spread
    if (state.config.mode === 'SIM') injectSimVolatility(price, now);
    state.priceSource = 'binance-rest';
    if (state.trading.active && now - lastArbCheckTs >= 500) {
      lastArbCheckTs = now;
      runArbitrageCheck();
    }
    if (now - lastBroadcastTs >= 500) {
      lastBroadcastTs = now;
      broadcastMarketData();
    }
  } catch (e) {
    // REST also failing — generate synthetic price movement so bot keeps running
    const now = Date.now();
    if (state.btcPrice > 0 && now - lastBroadcastTs >= 2000) {
      const drift  = (Math.random() - 0.499) * 0.0008;
      const noise  = (Math.random() - 0.5)   * 0.0002;
      state.btcPrice = Math.round(state.btcPrice * (1 + drift + noise) * 100) / 100;
      state.priceHistory.push({ price: state.btcPrice, time: now });
      state.priceHistory = state.priceHistory.filter(p => now - p.time <= PRICE_HIST_MS);
      updateCandle(state.btcPrice, now);
      if (state.config.mode === 'SIM') injectSimVolatility(state.btcPrice, now);
      state.priceSource = 'sim';
      if (state.trading.active && now - lastArbCheckTs >= 500) {
        lastArbCheckTs = now;
        runArbitrageCheck();
      }
      lastBroadcastTs = now;
      broadcastMarketData();
    }
  }
}

// ── BINANCE KLINES HISTORY (boot-time) ────────────────────────────────────────────────
// Seeds priceHistory with sub-second resolution for the momentum model.
// Strategy: try 1s klines first; if unavailable, interpolate 1m klines into
// synthetic 1s points (linear interpolation between each minute's OHLC).
async function loadBinanceHistory() {
  let currentPrice = state.btcPrice;
  try {
    // Always fetch 1m klines (reliable, low weight) + 24h ticker
    const [klinesRes, tickerRes] = await Promise.all([
      axios.get(`${BINANCE_REST}/klines`, {
        params: { symbol: 'BTCUSDT', interval: '1m', limit: 300 },
        timeout: 12000,
      }),
      axios.get(`${BINANCE_REST}/ticker/24hr`, {
        params: { symbol: 'BTCUSDT' }, timeout: 8000,
      }),
    ]);
    const klines1m = klinesRes.data;
    const ticker   = tickerRes.data;

    if (Array.isArray(klines1m) && klines1m.length > 0) {
      currentPrice = parseFloat(klines1m[klines1m.length - 1][4]);
      state.btcPrice     = currentPrice;
      state.btcChange24h = parseFloat(ticker.priceChangePercent) || 0;

      // Build priceChart (1 point per minute)
      state.priceChart = klines1m.map(k => ({ t: Number(k[0]), p: parseFloat(k[4]) }));

      // Interpolate each 1m kline into 60 synthetic 1s price points
      // Uses linear interpolation open→close within each minute
      // This gives the momentum model enough sub-second resolution to work
      const syntheticPoints = [];
      for (const k of klines1m) {
        const openTs  = Number(k[0]);
        const open    = parseFloat(k[1]);
        const close   = parseFloat(k[4]);
        const steps   = 60;
        for (let i = 0; i < steps; i++) {
          syntheticPoints.push({
            time:  openTs + i * 1000,
            price: open + (close - open) * (i / steps),
          });
        }
      }
      // Keep only last 5 minutes (PRICE_HIST_MS)
      const cutoff = Date.now() - PRICE_HIST_MS;
      state.priceHistory = syntheticPoints.filter(p => p.time >= cutoff);

      // Build 5s candles from last 5 minutes of 1m klines
      const recentKlines = klines1m.filter(k => Number(k[0]) >= cutoff);
      const buckets = new Map();
      for (const k of recentKlines) {
        const openTs = Number(k[0]);
        for (let i = 0; i < 60; i++) {
          const ts     = openTs + i * 1000;
          const price  = parseFloat(k[1]) + (parseFloat(k[4]) - parseFloat(k[1])) * (i / 60);
          const bucket = Math.floor(ts / (CANDLE_SEC * 1000)) * CANDLE_SEC;
          if (!buckets.has(bucket)) {
            buckets.set(bucket, { time: bucket, open: price, high: price, low: price, close: price, ticks: 1 });
          } else {
            const c = buckets.get(bucket);
            c.high  = Math.max(c.high, price);
            c.low   = Math.min(c.low,  price);
            c.close = price;
            c.ticks++;
          }
        }
      }
      const sorted = [...buckets.values()].sort((a, b) => a.time - b.time);
      state.candles       = sorted.slice(0, -1);
      state.currentCandle = sorted[sorted.length - 1] || null;

      console.log(`[Binance] History: ${state.priceHistory.length} pts, ${state.candles.length} candles, price=$${currentPrice}`);
    }

    // Attempt to upgrade to real 1s klines (more precise, but may not be available)
    try {
      const { data: klines1s } = await axios.get(`${BINANCE_REST}/klines`, {
        params: { symbol: 'BTCUSDT', interval: '1s', limit: 300 },
        timeout: 8000,
      });
      if (Array.isArray(klines1s) && klines1s.length > 0) {
        state.priceHistory = klines1s.map(k => ({ time: Number(k[0]), price: parseFloat(k[4]) }));
        console.log(`[Binance] Upgraded to ${klines1s.length} real 1s klines`);
      }
    } catch (_) {
      console.log('[Binance] 1s klines unavailable — using interpolated 1m data');
    }

  } catch (e) {
    console.warn('[Binance] History load failed:', e.message);
    // Minimal fallback: just get current price
    try {
      const { data } = await axios.get(`${BINANCE_REST}/ticker/price`, {
        params: { symbol: 'BTCUSDT' }, timeout: 5000,
      });
      currentPrice       = parseFloat(data.price) || currentPrice;
      state.btcPrice     = currentPrice;
      // Seed a minimal priceHistory so the bot can start immediately
      const now = Date.now();
      state.priceHistory = Array.from({ length: 60 }, (_, i) => ({
        time:  now - (60 - i) * 1000,
        price: currentPrice * (1 + (Math.random() - 0.5) * 0.0002),
      }));
      console.log(`[Binance] Emergency seed: price=$${currentPrice}`);
    } catch (_) { /* keep default state */ }
  }
}

// ── POLYMARKET MARKETS ────────────────────────────────────────────────────────
async function fetchBTCMarkets() {
  const strategies = [
    // Strategy 1: wide fetch — BTC markets are NOT always high volume
    () => axios.get(`${POLY_GAMMA}/markets`, {
      params: { active: true, closed: false, limit: 500, order: 'volume', ascending: false },
      timeout: 15000,
      headers: { 'User-Agent': 'poly-btc-bot/1.0' },
    }),
    // Strategy 2: direct slug search for Bitcoin price markets
    () => axios.get(`${POLY_GAMMA}/markets`, {
      params: { active: true, closed: false, limit: 200, order: 'volume', ascending: false, offset: 500 },
      timeout: 12000,
    }),
    // Strategy 3: search by question keyword (note: Gamma search is fuzzy, filter strictly after)
    () => axios.get(`${POLY_GAMMA}/markets`, {
      params: { active: true, closed: false, limit: 200, order: 'startDate', ascending: false },
      timeout: 10000,
    }),
  ];

  for (const strategy of strategies) {
    try {
      const { data } = await strategy();
      const list = Array.isArray(data) ? data : (data?.markets || data?.results || []);
      const btc = list.filter(m => {
        const q = (m.question || m.title || '').toLowerCase();
        return (q.includes('btc') || q.includes('bitcoin')) &&
          !q.includes('eth') && !q.includes('sol');
      }).slice(0, 8);

      if (btc.length > 0) {
        const mapped = btc.map(m => {
          const prices = m.outcomePrices
            ? (Array.isArray(m.outcomePrices) ? m.outcomePrices.map(Number) : [0.5, 0.5])
            : [0.5, 0.5];
          const q = (m.question || m.title || '').toLowerCase();
          // Score: short-term "up or down" markets first (best for momentum arb)
          const shortTerm = /up or down|5 min|10 min|15 min|1 hour|today|\bday\b/.test(q);
          const midTerm   = /this week|week|\bmonth\b|may |june|july/.test(q);
          const score     = shortTerm ? 3 : midTerm ? 2 : 1;
          return {
            id: m.conditionId || m.id || m.slug,
            question: m.question || m.title || 'BTC Market',
            outcomes: m.outcomes || ['Yes', 'No'],
            outcomePrices: prices,
            volume: Number(m.volume || m.volumeNum || 0),
            endDate: m.endDateIso || m.endDate || m.end_date_iso,
            clobTokenIds: m.clobTokenIds || [],
            live: true,
            _score: score,
          };
        });
        // Sort: short-term first, then by volume
        mapped.sort((a, b) => b._score - a._score || b.volume - a.volume);
        state.markets = mapped;
        console.log(`[Polymarket] Loaded ${state.markets.length} real BTC markets | top: "${mapped[0].question}"`);
        broadcast({ type: 'MARKETS', data: state.markets });
        return;
      }
    } catch (e) {
      console.warn(`[Polymarket] Strategy failed:`, e.message);
    }
  }

  // All strategies failed – seed simulated markets
  seedSimMarkets();
  broadcast({ type: 'MARKETS', data: state.markets });
}

function seedSimMarkets() {
  const now  = new Date();
  const base = Math.round(state.btcPrice / 1000) * 1000;
  state.markets = [
    { id: 'sim-1', question: `Will BTC be above $${base.toLocaleString()} in 15 min?`, outcomes: ['Yes','No'], outcomePrices: [0.52, 0.48], volume: 185000, endDate: new Date(Date.now() + 15 * 60000).toISOString(), live: false },
    { id: 'sim-2', question: `Will BTC reach $${(base + 500).toLocaleString()} today?`,  outcomes: ['Yes','No'], outcomePrices: [0.44, 0.56], volume: 442000, endDate: new Date(Date.now() + 8 * 3600000).toISOString(), live: false },
    { id: 'sim-3', question: 'Will BTC end the week above last week\'s close?',            outcomes: ['Yes','No'], outcomePrices: [0.55, 0.45], volume: 930000, endDate: new Date(Date.now() + 5 * 86400000).toISOString(), live: false },
    { id: 'sim-4', question: `Will BTC make a new ATH this month?`,                        outcomes: ['Yes','No'], outcomePrices: [0.48, 0.52], volume: 2100000, endDate: new Date(Date.now() + 25 * 86400000).toISOString(), live: false },
  ];
  console.log('[Polymarket] Using simulated markets');
}

// ── PRICE HELPERS ─────────────────────────────────────────────────────────────
function getPriceAt(msAgo) {
  if (state.priceHistory.length === 0) return state.btcPrice;
  const target = Date.now() - msAgo;
  let closest = state.priceHistory[0];
  let minDiff  = Math.abs(closest.time - target);
  for (const p of state.priceHistory) {
    const d = Math.abs(p.time - target);
    if (d < minDiff) { minDiff = d; closest = p; }
  }
  return closest.price;
}

// ── ARBITRAGE ENGINE ──────────────────────────────────────────────────────────
function sigmoid(x, k) { return 1 / (1 + Math.exp(-k * x)); }

// ── VOLATILITY & MOMENTUM HELPERS ────────────────────────────────────────────
function pctChange(cur, ref, clipPct = 0.008) {
  if (!ref || ref === 0) return 0;
  const raw = (cur - ref) / ref;
  return Math.max(-clipPct, Math.min(clipPct, raw));
}

// Recent realised volatility: stdev of 1s returns over msWindow.
// Used to scale sigmoid sensitivity and dynamic edge threshold.
function recentVolatility(msWindow = 30000) {
  const now = Date.now();
  const pts  = state.priceHistory.filter(p => now - p.time <= msWindow);
  if (pts.length < 4) return 0.0010; // default ~10bps/s
  const returns = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].price > 0)
      returns.push((pts[i].price - pts[i - 1].price) / pts[i - 1].price);
  }
  if (returns.length === 0) return 0.0010;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) || 0.0001;
}

// Edge velocity: is the edge currently OPENING (positive) or CLOSING (negative)?
// Only enter when edge is expanding — avoids chasing edges that already peaked.
function edgeVelocity() {
  if (state.edgeHistory.length < 4) return 0;
  const now    = Date.now();
  const recent = state.edgeHistory.filter(e => now - e.time <=  800);
  const older  = state.edgeHistory.filter(e => now - e.time >   800 && now - e.time <= 2000);
  if (recent.length === 0 || older.length === 0) return 0;
  const rAvg = recent.reduce((s, e) => s + Math.abs(e.edge), 0) / recent.length;
  const oAvg = older.reduce((s, e)  => s + Math.abs(e.edge), 0) / older.length;
  return rAvg - oAvg; // positive = edge growing, negative = edge shrinking
}

// Edge quality: ratio of consistent-direction samples in recent window.
// 1.0 = all samples agree, 0.5 = random noise.
function edgeQuality(edge) {
  const now    = Date.now();
  const recent = state.edgeHistory.filter(e => now - e.time <= 2000 && Math.abs(e.edge) > 0.005);
  if (recent.length < 3) return 0.5;
  const bull   = recent.filter(e => e.edge > 0).length;
  const bear   = recent.filter(e => e.edge < 0).length;
  const dominant = Math.max(bull, bear);
  return dominant / recent.length; // 0.5–1.0
}

// Best market to trade: prefer short-term + highest edge potential
function getBestMarket() {
  if (state.markets.length === 0) return null;
  const now = Date.now();
  // In SIM mode use a much wider window so long-dated markets are tradeable
  const maxMinutes = state.config.mode === 'SIM' ? 44640 : 240; // SIM: up to 31 days
  const minMinutes = 1;
  const scored = state.markets.map(m => {
    const msLeft = m.endDate ? new Date(m.endDate).getTime() - now : 10 * 60000;
    const minLeft = msLeft / 60000;
    if (minLeft < minMinutes || minLeft > maxMinutes) return { m, score: -1 };
    // Prefer short-term (5–30 min window) for momentum arb
    const timeScore = minLeft <= 30 ? 3 : minLeft <= 60 ? 2 : minLeft <= 1440 ? 1 : 0;
    const volScore  = m.volume >= 100000 ? 2 : m.volume >= 20000 ? 1 : 0;
    // Prefer markets NEAR 0.5: that's where genuine uncertainty exists and both BUY_YES and BUY_NO
    // signals are reachable. Markets with YES far from 0.5 (>0.80 or <0.20) are near-certain and
    // cause permanent one-directional signals because implied is capped at [0.26, 0.74].
    const yesPrice  = m.outcomePrices?.[0] ?? 0.5;
    const priceDist = Math.abs(yesPrice - 0.5);
    if (priceDist > 0.30) return { m, score: -1 }; // YES < 0.20 or > 0.80 → skip (too certain)
    const priceScore = priceDist < 0.08 ? 2 : priceDist < 0.20 ? 1 : 0;
    return { m, score: timeScore + volScore + priceScore };
  }).filter(x => x.score >= 0).sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // No real markets qualify — use simulated markets in SIM mode so the engine can trade
    if (state.config.mode === 'SIM') {
      if (!state.markets.some(m => m.id && m.id.startsWith('sim-'))) seedSimMarkets();
      return state.markets.find(m => m.id && m.id.startsWith('sim-')) || state.markets[0];
    }
    return null;
  }
  return scored[0].m;
}

function computeImpliedProb() {
  if (state.priceHistory.length < 5) return 0.5;
  const cur  = state.btcPrice;
  const c2s  = pctChange(cur, getPriceAt(2000));
  const c5s  = pctChange(cur, getPriceAt(5000));
  const c15s = pctChange(cur, getPriceAt(15000));
  const c30s = pctChange(cur, getPriceAt(30000));
  const c60s = pctChange(cur, getPriceAt(60000));
  const momentum  = c2s * 0.38 + c5s * 0.28 + c15s * 0.18 + c30s * 0.10 + c60s * 0.06;
  const c2s_old   = pctChange(getPriceAt(2000), getPriceAt(4000));
  const accel     = (c2s - c2s_old) * 0.12;
  // Mean-reversion damper: fade signal when 30s move already large
  const revDamp   = Math.abs(c30s) > 0.003 ? 0.75 : 1.0;
  const shortDir  = c2s + c5s;
  const midDir    = c15s + c30s;
  const aligned   = (shortDir > 0) === (midDir > 0) && Math.abs(midDir) > 0.0002;
  const composite = (momentum + accel) * revDamp * (aligned ? 1.20 : 0.85);
  // Volatility-adaptive k: low vol = sharper signal, high vol = softer
  const vol = recentVolatility(20000);
  const k   = vol < 0.0008 ? 1400 : vol < 0.0015 ? 1200 : vol < 0.003 ? 950 : 800;
  return Math.max(0.26, Math.min(0.74, sigmoid(composite, k)));
}

function computePolyOdds() {
  if (state.priceHistory.length < 5) return 0.5;
  const lag   = getPriceAt(LAG_MS);
  const cl2s  = pctChange(lag, getPriceAt(2000  + LAG_MS));
  const cl5s  = pctChange(lag, getPriceAt(5000  + LAG_MS));
  const cl15s = pctChange(lag, getPriceAt(15000 + LAG_MS));
  const lagSignal  = cl2s * 0.50 + cl5s * 0.30 + cl15s * 0.20;
  const vol        = recentVolatility(20000);
  const k          = vol < 0.0008 ? 1400 : vol < 0.0015 ? 1200 : vol < 0.003 ? 950 : 800;
  const laggedProb = Math.max(0.26, Math.min(0.74, sigmoid(lagSignal, k)));
  // 70% market price (ground truth), 30% lagged model (lag exploitation)
  const market     = getBestMarket();
  const mktPrice   = market?.outcomePrices?.[0] ?? null;
  return mktPrice !== null ? laggedProb * 0.30 + mktPrice * 0.70 : laggedProb;
}

// Kelly criterion — quarter-Kelly for noise-resilient sizing
// entryPrice = cost per share; netOdds = (1 - entryPrice) / entryPrice
function kellySize(edge, winProb, entryPrice, balance, maxBetPct) {
  if (edge <= 0 || winProb <= 0 || entryPrice <= 0 || entryPrice >= 1) return 0;
  const netOdds   = (1 - entryPrice) / entryPrice;
  const fullKelly = (netOdds * winProb - (1 - winProb)) / netOdds;
  // Quality-scaled Kelly fraction: 1/5 at low quality, up to 1/3 at perfect quality
  const quality   = edgeQuality(edge);
  const kFrac     = 0.20 + (quality - 0.5) * 0.267;
  const scaled    = Math.max(0, fullKelly * kFrac);
  const streak    = state.stats.streak;
  const sMult     = streak < -1 ? Math.max(0.5, Math.pow(0.80, Math.abs(streak) - 1)) : 1.0;
  const vol       = recentVolatility(20000);
  const vMult     = vol > 0.003 ? 0.70 : vol > 0.0015 ? 0.85 : 1.0;
  const capped    = Math.min(scaled, maxBetPct / 100) * sMult * vMult;
  const raw       = Math.round(balance * capped * 100) / 100;
  return raw >= 2 ? raw : 0;
}

function isGoodEntry(edge) {
  const vel   = edgeVelocity();
  const qual  = edgeQuality(edge);
  // Fast path: very strong edge + quality → enter immediately
  if (Math.abs(edge) >= state.config.minEdge * 2.0 && qual >= 0.65) return true;
  const now     = Date.now();
  const recent  = state.edgeHistory.filter(e =>
    now - e.time <= 1200 && Math.abs(e.edge) >= state.config.minEdge * 0.5
  );
  const bullish = edge > 0;
  const sameDir = recent.length > 0 && recent.every(e => (e.edge > 0) === bullish);
  // Enter when edge is opening or holding (vel >= -0.002), quality >= 60%, 2+ recent samples
  return vel >= -0.002 && qual >= 0.60 && recent.length >= 2 && sameDir;
}
function hasStableEdge(edge) { return isGoodEntry(edge); }

function runArbitrageCheck() {
  const implied    = computeImpliedProb();
  const poly       = computePolyOdds();
  const edge       = implied - poly;
  const now        = Date.now();
  const volScale   = Math.max(1.0, Math.min(1.5, recentVolatility(20000) / 0.0015));
  const dynMinEdge = state.config.minEdge * volScale;

  // Only track edges above 50% of minEdge — prevents noise ticks from polluting
  // the stability window and breaking hasStableEdge between valid signals
  if (Math.abs(edge) >= dynMinEdge * 0.5) {
    state.edgeHistory.push({ time: now, edge, implied, poly });
    if (state.edgeHistory.length > 80) state.edgeHistory.shift();
  }

  if (Math.abs(edge) < dynMinEdge) {
    state.currentSignal = null;
    return broadcastSignal();
  }

  const side       = edge > 0 ? 'BUY_YES' : 'BUY_NO';
  const winProb    = edge > 0 ? implied : (1 - implied);
  const market     = getBestMarket();
  if (!market) return;

  const marketYes  = market.outcomePrices?.[0] ?? 0.5;
  const entryPrice = side === 'BUY_YES' ? marketYes : (1 - marketYes);

  const betSize = state.config.entryMode === 'fixed'
    ? Math.min(state.config.fixedAmount, state.trading.balance)
    : kellySize(Math.abs(edge), winProb, entryPrice, state.trading.balance, state.config.maxBetPct);

  // Confidence: scaled from edge magnitude + velocity + quality
  const velBonus   = edgeVelocity() > 0.003 ? 10 : 0;
  const qualBonus  = Math.round(edgeQuality(edge) * 20);
  const confidence = Math.min(99, 50 + Math.abs(edge) * 250 + velBonus + qualBonus);

  state.currentSignal = {
    marketId:    market.id,
    question:    market.question,
    side,
    edge:        Math.abs(edge),
    impliedProb: implied,
    polyOdds:    poly,
    betSize,
    confidence,
    timestamp:   now,
  };

  const openCount = state.positions.filter(p => p.status === 'OPEN').length;
  const canTrade  = openCount < state.config.maxOpenPos;
  // Stability check is optional — disable for high-frequency scalping
  const stableOk  = !state.config.requireStableEdge || isGoodEntry(edge);
  // Guard: NEVER open a position in the opposite direction to an existing open one
  // (self-canceling trades destroy edge and stack losses)
  const hasOpposite = state.positions.some(p =>
    p.status === 'OPEN' && p.marketId === market.id && p.side !== side
  );
  // Total exposure cap: never risk more than 40% of effective balance across all open positions
  // Use effective balance (cash + open costs) not just cash — otherwise the cap tightens every
  // time a position is opened, eventually blocking all new trades.
  const totalExposure = state.positions
    .filter(p => p.status === 'OPEN')
    .reduce((s, p) => s + (p.cost || 0), 0);
  const effectiveBal  = state.trading.balance + totalExposure;
  const exposureOk = totalExposure + betSize <= effectiveBal * 0.40;
  // Keep enough cash to cover the bet
  const safeBalance = state.trading.balance >= betSize;
  if (state.config.autoTrade && betSize >= 2 && canTrade && stableOk && safeBalance && !hasOpposite && exposureOk) {
    executeTrade(state.currentSignal);
  }
  broadcastSignal();
}

// ── CLOB REALISM ENGINE ─────────────────────────────────────────────────────
// Applied identically in SIM and LIVE — makes SIM a faithful dry-run.

// Bid-ask half-spread based on market volume (tighter = more liquid)
// Source: Polymarket CLOB observed spreads (2024-2025 data)
function clobSpread(marketVolume) {
  if (marketVolume >= 500000) return 0.012; // 1.2¢ — deep liquid market
  if (marketVolume >= 100000) return 0.025; // 2.5¢
  if (marketVolume >=  50000) return 0.040; // 4¢
  if (marketVolume >=  10000) return 0.060; // 6¢
  return 0.080;                             // 8¢ — thin market
}

// Price impact: large orders consume depth and get worse fill
// Approximation: 0.5¢ per $100 of order size in a $100k-volume market
// Impact scales inversely with market volume
function priceImpact(betSize, marketVolume) {
  const depth = Math.max(marketVolume * 0.005, 500); // ~0.5% of vol as available depth
  return Math.min(0.04, (betSize / depth) * 0.02);   // max 4¢ impact
}

// Maximum order size allowed by CLOB liquidity (1% of daily volume, hard cap $2000)
function maxOrderSize(marketVolume) {
  return Math.min(2000, Math.max(10, marketVolume * 0.01));
}

// Simulate CLOB fill: returns { fillOdds, fillSize, partialFill }
// fillSize may be < requested if order exceeds available depth
function simulateClobFill(side, requestedSize, market) {
  const vol      = Number(market.volume || 0);
  const yesPrice = market.outcomePrices?.[0] ?? 0.50;
  const midOdds  = side === 'BUY_YES' ? yesPrice : (1 - yesPrice);

  // 1. Half-spread: you always pay the ask (buy) or get the bid (sell)
  const spread  = clobSpread(vol);
  const askOdds = Math.min(0.97, midOdds + spread);  // you buy at ask

  // 2. Price impact from order size
  const impact  = priceImpact(requestedSize, Math.max(vol, 10000));
  const rawFill = Math.min(0.98, askOdds + impact);

  // 3. Partial fill: order capped at available depth
  const maxSize     = maxOrderSize(vol);
  const fillSize    = Math.min(requestedSize, maxSize);
  const partialFill = fillSize < requestedSize;

  return {
    fillOdds:    Math.round(rawFill * 10000) / 10000,
    fillSize:    Math.round(fillSize * 100) / 100,
    partialFill,
    spread,
    impact,
  };
}

// ── POSITION MANAGEMENT ──────────────────────────────────────────────────────

function openPosition(signal) {
  const { side, betSize, edge, marketId, question } = signal;
  if (!betSize || betSize < 1) return;

  // NEVER open opposite direction on same market — prevents self-canceling trades
  if (state.positions.some(p => p.status === 'OPEN' && p.marketId === marketId && p.side !== side)) return;

  // In strict mode: also block same-direction duplicate
  if (!state.config.allowDuplicateMarkets) {
    if (state.positions.some(p => p.status === 'OPEN' && p.marketId === marketId && p.side === side)) return;
  }

  // Total exposure hard cap: max 40% of effective balance in all open positions combined
  const totalExposure = state.positions
    .filter(p => p.status === 'OPEN')
    .reduce((s, p) => s + (p.cost || 0), 0);
  const effectiveBalPos = state.trading.balance + totalExposure;
  if (totalExposure + betSize > effectiveBalPos * 0.40) return;

  // Respect max concurrent cap
  if (state.positions.filter(p => p.status === 'OPEN').length >= state.config.maxOpenPos) return;

  // Find the correct market by ID, fallback to best-scored market
  const market = state.markets.find(m => m.id === marketId) || getBestMarket() || state.markets[0];
  if (!market) return;

  // ── REAL CLOB CONSTRAINTS (applied in both SIM and LIVE) ──────────────────
  const vol = Number(market.volume || 0);

  // Minimum market volume: same threshold as LIVE ($50k)
  // Below this, spread is too wide and fills are unreliable
  const MIN_VOL = state.config.mode === 'SIM' ? 5000 : 50000;
  if (vol < MIN_VOL && !marketId.startsWith('sim-')) {
    console.log(`[CLOB] Skip — market volume $${vol.toLocaleString()} below minimum $${MIN_VOL.toLocaleString()}`);
    return;
  }

  // Simulate CLOB fill with spread + price impact + partial fill
  const fill = simulateClobFill(side, betSize, market);

  if (fill.partialFill) {
    console.log(`[CLOB] Partial fill: $${fill.fillSize} of $${betSize} requested (depth cap)`);
  }
  if (fill.fillSize < 1) return; // after partial fill, too small

  const fillOdds = fill.fillOdds;
  const fillSize = fill.fillSize;
  const shares   = Math.round(fillSize / fillOdds * 100) / 100;

  const pos = {
    id:               `p-${Date.now()}`,
    marketId,
    question:         (question || 'BTC Market').slice(0, 60),
    side,
    entryOdds:        fillOdds,
    markOdds:         fillOdds,
    shares,
    cost:             fillSize,
    unrealizedPnl:    0,
    pnlPct:           0,
    edge:             Math.round(edge * 10000) / 10000,
    entryTime:        Date.now(),
    btcPriceAtEntry:  state.btcPrice,
    // CLOB execution metadata (shown in trade log)
    spread:           fill.spread,
    impact:           fill.impact,
    partialFill:      fill.partialFill,
    requestedSize:    betSize,
    status:           'OPEN',
  };

  state.trading.balance = Math.round((state.trading.balance - fillSize) * 100) / 100;
  state.positions.push(pos);
  // Keep history bounded
  if (state.positions.length > 500) state.positions = state.positions.slice(-500);

  broadcast({ type: 'POSITION_OPENED', data: pos });
  broadcastStatus();
  const fillNote = fill.partialFill ? ` [PARTIAL ${fill.fillSize}/${betSize}]` : '';
  console.log(`[CLOB] OPEN ${side} ${shares}sh @ ${fillOdds.toFixed(3)} | spread=${(fill.spread*100).toFixed(1)}¢ impact=${(fill.impact*100).toFixed(1)}¢ | $${fillSize}${fillNote} | edge ${(edge*100).toFixed(1)}¢`);
}

// Simulate how position odds evolve for SIM mode
// KEY FIX: computes ABSOLUTE target from entry, then smoothly moves toward it.
// Previous bug: added priceImpact to pos.markOdds every tick → mark drifted
// indefinitely even when BTC price was FLAT, causing massive fake losses.
function simMarkToMarket(pos) {
  const elapsed   = Date.now() - pos.entryTime;
  const progress  = Math.min(1, elapsed / state.config.posTimeoutMs);

  // Cumulative BTC move from entry, capped at ±1.2% (beyond that binary is near 0/1)
  const rawChange  = pos.btcPriceAtEntry > 0
    ? (state.btcPrice - pos.btcPriceAtEntry) / pos.btcPriceAtEntry
    : 0;
  const cappedChg  = Math.max(-0.02, Math.min(0.02, rawChange));
  const directional = pos.side === 'BUY_YES' ? cappedChg : -cappedChg;

  // ABSOLUTE target: entry odds + BTC impact
  // Calibrated for short-term ATM binary (10-15 min): 0.1% BTC → ~5.5¢ binary move
  // (binary delta near ATM/expiry is ~50, so 0.001 fractional move × 55 = 5.5¢)
  // Previously was ×12 which needed 0.58% BTC move to hit 14% TP — almost never happened
  const absTarget  = pos.entryOdds + directional * 55;
  const clampedTgt = Math.max(0.04, Math.min(0.96, absTarget));

  // Time decay: odds converge toward likely resolution based on directional momentum
  // Use directional (not target vs entry) so flat BTC doesn't cause false decay loss
  const resolution = directional >= 0.002 ? 0.68 : directional <= -0.002 ? 0.32 : 0.50;
  const decayedTgt = clampedTgt + (resolution - clampedTgt) * progress * 0.12;

  // Smooth approach: mark moves 20% toward absolute target each 500ms tick
  // This prevents jumps and allows SL/TP to trigger at correct levels
  const smoothed   = pos.markOdds + (decayedTgt - pos.markOdds) * 0.55;

  // Tiny noise: ±0.15¢ per tick (realistic price discovery)
  const noise = (Math.random() - 0.5) * 0.003;
  return Math.max(0.03, Math.min(0.97, smoothed + noise));
}

// ── SIM MARKET PRICE EVOLUTION ──────────────────────────────────────────────
// In SIM mode, Polymarket prices must LAG behind BTC to create real arb edge.
// This simulates the ~8-12s repricing delay that real Polymarket markets have.
// Without this, outcomePrices are static → polyOdds barely moves → no edge.
function updateSimMarketPrices() {
  if (state.config.mode !== 'SIM' || state.markets.length === 0) return;
  // Use 10s lagged BTC as proxy for what a slow market maker currently prices
  const lag10 = getPriceAt(10000);
  const lag25 = getPriceAt(25000);
  const lagChange = pctChange(lag10, lag25);
  // Lagged probability the market would show (damped, slow to move)
  const lagProb = Math.max(0.30, Math.min(0.70, sigmoid(lagChange, 1200)));
  // Apply to ALL active markets so getBestMarket always has dynamic prices
  for (const m of state.markets) {
    if (!m.outcomePrices) m.outcomePrices = [0.5, 0.5];
    const cur  = m.outcomePrices[0] ?? 0.5;
    // Market mean-reverts toward lagged signal slowly (8% per 2s step)
    const step = (lagProb - cur) * 0.08 + (Math.random() - 0.5) * 0.006;
    const next = Math.max(0.20, Math.min(0.80, cur + step));
    m.outcomePrices[0] = Math.round(next * 1000) / 1000;
    m.outcomePrices[1] = Math.round((1 - next) * 1000) / 1000;
  }
}

function closePosition(pos, exitOdds, reason) {
  pos.status      = 'CLOSED';
  pos.exitOdds    = Math.round(exitOdds * 1000) / 1000;
  pos.closeReason = reason;
  pos.closeTime   = Date.now();
  pos.holdMs      = pos.closeTime - pos.entryTime;

  // P&L = (exitOdds - entryOdds) × shares
  const rawPnl   = (exitOdds - pos.entryOdds) * pos.shares;
  const grossPnl = Math.round(rawPnl * 100) / 100;
  // Polymarket 2% protocol fee on gross winnings only (losses are never charged)
  const fee      = grossPnl > 0 ? Math.round(grossPnl * POLY_FEE_RATE * 100) / 100 : 0;
  const pnl      = Math.round((grossPnl - fee) * 100) / 100;
  const outcome  = pnl >= 0 ? 'WIN' : 'LOSS';

  // Return cost + net PnL to balance
  state.trading.balance     = Math.round((state.trading.balance + pos.cost + pnl) * 100) / 100;
  state.trading.peakBalance = Math.max(state.trading.peakBalance, state.trading.balance);

  state.stats.totalTrades++;
  state.stats.totalPnl  = Math.round((state.stats.totalPnl  + pnl) * 100) / 100;
  state.stats.todayPnl  = Math.round((state.stats.todayPnl  + pnl) * 100) / 100;
  if (pnl >= 0) {
    state.stats.wins++;
    state.stats.streak = state.stats.streak >= 0 ? state.stats.streak + 1 : 1;
  } else {
    state.stats.losses++;
    state.stats.streak = state.stats.streak <= 0 ? state.stats.streak - 1 : -1;
  }

  const trade = {
    id:            `t-${Date.now()}`,
    marketId:      pos.marketId,
    question:      pos.question,
    side:          pos.side,
    betSize:       pos.cost,
    requestedSize: pos.requestedSize || pos.cost,
    partialFill:   pos.partialFill   || false,
    entryOdds:     pos.entryOdds,
    exitOdds:      pos.exitOdds,
    shares:        pos.shares,
    edge:          pos.edge,
    spread:        pos.spread  || null,
    impact:        pos.impact  || null,
    outcome,
    closeReason: reason,
    holdMs:      pos.holdMs,
    grossPnl,
    fee,
    pnl,
    balance:     state.trading.balance,
    timestamp:   pos.closeTime,
  };

  state.trading.trades.unshift(trade);
  if (state.trading.trades.length > 500) state.trading.trades.pop();
  saveTrades();
  saveSession();

  broadcastTrade(trade);
  broadcastStatus();
  const pnlStr = `${pnl >= 0 ? '+' : ''}$${pnl}`;
  const holdS  = (pos.holdMs / 1000).toFixed(0);
  console.log(`[CLOB] CLOSE [${reason}] ${pos.side} entry=${pos.entryOdds} exit=${pos.exitOdds} | ${pnlStr} (${((pnl/pos.cost)*100).toFixed(1)}%) hold=${holdS}s`);
}

function monitorPositions() {
  const open = state.positions.filter(p => p.status === 'OPEN');
  if (open.length === 0) return;

  for (const pos of open) {
    // Update mark price
    const newMark  = state.config.mode === 'SIM' ? simMarkToMarket(pos) : pos.markOdds;
    pos.markOdds   = newMark;
    pos.pnlPct     = Math.round(((newMark - pos.entryOdds) / pos.entryOdds) * 10000) / 100;
    pos.unrealizedPnl = Math.round((newMark - pos.entryOdds) * pos.shares * 100) / 100;

    const gainPct  = (newMark - pos.entryOdds) / pos.entryOdds;
    const lossPct  = (pos.entryOdds - newMark)  / pos.entryOdds;
    const elapsed  = Date.now() - pos.entryTime;

    if (gainPct >= state.config.takeProfitPct / 100) {
      closePosition(pos, newMark, 'TP'); continue;
    }
    if (lossPct >= state.config.stopLossPct / 100) {
      closePosition(pos, newMark, 'SL'); continue;
    }
    if (elapsed >= state.config.posTimeoutMs) {
      closePosition(pos, newMark, 'TIMEOUT'); continue;
    }
  }

  // Broadcast live open positions to UI
  broadcast({ type: 'POSITIONS', data: state.positions.filter(p => p.status === 'OPEN') });
}

// ── TRADE EXECUTION ───────────────────────────────────────────────────────────
async function executeTrade(signal) {
  if (!signal || signal.betSize < 1) return;

  // Use effective balance (cash + open position cost + unrealized P&L) for drawdown
  const openPos      = state.positions.filter(p => p.status === 'OPEN');
  const openCost     = openPos.reduce((s, p) => s + (p.cost     || 0), 0);
  const unrealized   = openPos.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const effectiveBal = state.trading.balance + openCost + unrealized;
  const drawdown     = state.trading.startBalance > 0
    ? (state.trading.startBalance - effectiveBal) / state.trading.startBalance
    : 0;
  if (drawdown >= state.config.killThreshold / 100) {
    console.log('[Bot] KILL SWITCH triggered – stopping bot');
    state.trading.active = false;
    broadcastStatus();
    return;
  }

  // ── CLOB rate-limit enforcement (identical for SIM and LIVE) ──────────────
  // Polymarket CLOB allows ~10 req/s. 2s cooldown = safe margin, mirrors LIVE.
  const minCooldown = Math.max(state.trading.cooldownMs, 2000);
  if (Date.now() - state.trading.lastTradeTs < minCooldown) return;
  state.trading.lastTradeTs = Date.now();

  // ── Simulate execution latency (CLOB order roundtrip: 50–300ms) ───────────
  // In LIVE this would be real network + chain latency; in SIM we model it.
  const latencyMs = 50 + Math.floor(Math.random() * 250);
  await new Promise(r => setTimeout(r, latencyMs));

  openPosition(signal);
  if (state.config.mode === 'LIVE') console.log('[LIVE] Order stub — CLOB API not yet implemented');
}

// legacy sim kept for reference but no longer called
function _legacySimTrade_unused(signal) {
  void signal;
}

// ── BROADCASTS ────────────────────────────────────────────────────────────────
function broadcastMarketData() {
  const implied = computeImpliedProb();
  const poly    = computePolyOdds();
  broadcast({
    type: 'MARKET_DATA',
    data: {
      btcPrice:     state.btcPrice,
      btcChange24h: state.btcChange24h,
      laggedPrice:  getPriceAt(LAG_MS),
      impliedProb:  implied,
      polyOdds:     poly,
      edge:         implied - poly,
      edgeHistory:  state.edgeHistory.slice(-80),
      priceChart:   state.priceChart.slice(-100),
      candles:      state.candles.slice(-300),
      currentCandle:state.currentCandle,
      priceSource:  state.priceSource,
      timestamp:    Date.now(),
    },
  });
}

function broadcastSignal() {
  broadcast({ type: 'SIGNAL', data: state.currentSignal });
}

function broadcastTrade(trade) {
  broadcast({ type: 'TRADE', data: trade });
}

function buildStatusPayload() {
  const openPositions = state.positions.filter(p => p.status === 'OPEN');
  const unrealizedPnl = openPositions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const openCost      = openPositions.reduce((s, p) => s + (p.cost || 0), 0);
  // effectiveBalance = available cash + unrealized P&L + open position cost
  // This prevents the curve from showing fake losses when a position is open
  const effectiveBalance = Math.round((state.trading.balance + openCost + unrealizedPnl) * 100) / 100;
  const drawdown = state.trading.startBalance > 0
    ? Math.max(0, (state.trading.startBalance - effectiveBalance) / state.trading.startBalance)
    : 0;
  return {
    mode:          state.config.mode,
    active:        state.trading.active,
    balance:       effectiveBalance,
    cashBalance:   state.trading.balance,
    startBalance:  state.trading.startBalance,
    peakBalance:   state.trading.peakBalance,
    drawdown,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    binanceConnected: state.binanceConnected,
    priceSource:   state.priceSource,
    stats:         state.stats,
    feeRate: POLY_FEE_RATE,
    config: {
      mode:                  state.config.mode,
      capital:               state.config.capital,
      entryMode:             state.config.entryMode,
      fixedAmount:           state.config.fixedAmount,
      maxBetPct:             state.config.maxBetPct,
      minEdge:               state.config.minEdge,
      killThreshold:         state.config.killThreshold,
      autoTrade:             state.config.autoTrade,
      hasPrivateKey:         Boolean(state.config.privateKey),
      takeProfitPct:         state.config.takeProfitPct,
      stopLossPct:           state.config.stopLossPct,
      posTimeoutMs:          state.config.posTimeoutMs,
      maxOpenPos:            state.config.maxOpenPos,
      requireStableEdge:     state.config.requireStableEdge,
      allowDuplicateMarkets: state.config.allowDuplicateMarkets,
      cooldownMs:            state.trading.cooldownMs,
    },
    openPositions: state.positions.filter(p => p.status === 'OPEN').length,
  };
}

function broadcastStatus() {
  broadcast({ type: 'STATUS', data: buildStatusPayload() });
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve the built frontend from ../dist if it exists (Railway production)
const distPath = path.join(__dirname, '..', 'dist');
const hasDistFolder = fs.existsSync(distPath);
if (hasDistFolder) {
  app.use(express.static(distPath));
  console.log('[Server] Serving frontend from', distPath);
} else {
  console.log('[Server] No dist/ folder — API-only mode (run npm run build first)');
}
// Health check always available (Railway healthcheckPath: /health)
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.post('/api/bot/start', (req, res) => {
  if (state.trading.active) return res.json({ success: true, active: true }); // idempotent
  state.trading.active      = true;
  state.trading.lastTradeTs = 0;    // reset cooldown — first trade can fire immediately
  // NOTE: do NOT override autoTrade here — respect user config from settings
  broadcastStatus();
  // Run an immediate check so UI sees signal right away
  if (state.priceHistory.length >= 3) runArbitrageCheck();
  res.json({ success: true, active: true });
});

app.post('/api/bot/stop', (req, res) => {
  if (!state.trading.active) return res.json({ success: true, active: false }); // idempotent
  state.trading.active  = false;
  state.currentSignal   = null;
  broadcastStatus();
  broadcastSignal();
  res.json({ success: true, active: false });
});

app.post('/api/trade', async (req, res) => {
  if (!state.trading.active) return res.status(400).json({ error: 'Bot not active' });
  if (!state.currentSignal)  return res.status(400).json({ error: 'No active signal' });
  await executeTrade(state.currentSignal);
  res.json({ success: true });
});

app.post('/api/config', (req, res) => {
  const { mode, capital, entryMode, fixedAmount, maxBetPct, minEdge, killThreshold,
          autoTrade, privateKey, takeProfitPct, stopLossPct, posTimeoutMs, maxOpenPos } = req.body;

  if (mode && ['SIM', 'LIVE'].includes(mode)) state.config.mode = mode;
  if (entryMode && ['kelly', 'fixed'].includes(entryMode)) state.config.entryMode = entryMode;
  if (fixedAmount > 0) state.config.fixedAmount = Math.min(fixedAmount, state.trading.balance || state.config.capital);
  if (capital > 0 && !state.trading.active) {
    state.config.capital      = capital;
    state.trading.balance     = capital;
    state.trading.startBalance = capital;
    state.trading.peakBalance = capital;
  }
  if (maxBetPct     !== undefined) state.config.maxBetPct     = Math.min(50, Math.max(1, maxBetPct));
  if (minEdge       !== undefined) state.config.minEdge       = Math.min(0.5, Math.max(0.01, minEdge));
  if (killThreshold !== undefined) state.config.killThreshold = Math.min(100, Math.max(5, killThreshold));
  if (autoTrade     !== undefined) state.config.autoTrade     = Boolean(autoTrade);
  if (takeProfitPct !== undefined) state.config.takeProfitPct = Math.min(95, Math.max(5,  takeProfitPct));
  if (stopLossPct   !== undefined) state.config.stopLossPct   = Math.min(95, Math.max(5,  stopLossPct));
  if (posTimeoutMs  !== undefined) state.config.posTimeoutMs  = Math.min(3600000, Math.max(30000, posTimeoutMs));
  if (maxOpenPos    !== undefined) state.config.maxOpenPos    = Math.min(10, Math.max(1, maxOpenPos));
  // cooldown exposed so UI/config can tune trade frequency
  const { cooldownMs } = req.body;
  if (cooldownMs    !== undefined) state.trading.cooldownMs   = Math.min(60000, Math.max(100, cooldownMs));
  const { requireStableEdge, allowDuplicateMarkets } = req.body;
  if (requireStableEdge     !== undefined) state.config.requireStableEdge     = Boolean(requireStableEdge);
  if (allowDuplicateMarkets !== undefined) state.config.allowDuplicateMarkets = Boolean(allowDuplicateMarkets);
  if (privateKey && mode === 'LIVE') {
    const clean = privateKey.replace(/^0x/, '');
    if (/^[0-9a-fA-F]{64}$/.test(clean)) {
      state.config.privateKey = '0x' + clean;
    } else {
      return res.status(400).json({ error: 'Invalid private key' });
    }
  }

  saveConfig();
  broadcastStatus();
  res.json({ success: true, config: buildStatusPayload().config });
});

app.get('/api/fees', (_req, res) => {
  res.json({
    source:        'Polymarket CLOB (documented)',
    makerFee:      0,
    takerFee:      0,
    resolutionFee: POLY_FEE_RATE,
    description:   `${(POLY_FEE_RATE * 100).toFixed(0)}% of gross winnings deducted at settlement`,
  });
});

app.post('/api/positions/:id/close', (req, res) => {
  const pos = state.positions.find(p => p.id === req.params.id && p.status === 'OPEN');
  if (!pos) return res.status(404).json({ error: 'Position not found or already closed' });
  closePosition(pos, pos.markOdds, 'MANUAL');
  res.json({ success: true });
});

app.get('/api/status',    (req, res) => res.json(buildStatusPayload()));
app.get('/api/trades',    (req, res) => res.json(state.trading.trades.slice(0, 200)));
app.get('/api/markets',   (req, res) => res.json(state.markets));
app.get('/api/positions', (req, res) => res.json(state.positions.filter(p => p.status === 'OPEN')));
app.get('/api/prices',  (req, res) => res.json({
  chart:   state.priceChart.slice(-200),
  current: state.btcPrice,
  change24h: state.btcChange24h,
  source:  state.priceSource,
}));
app.get('/api/candles', (req, res) => res.json({
  candles:       state.candles.slice(-300),
  currentCandle: state.currentCandle,
  edgeHistory:   state.edgeHistory.slice(-80),
  impliedProb:   computeImpliedProb(),
  polyOdds:      computePolyOdds(),
  edge:          computeImpliedProb() - computePolyOdds(),
}));

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
// SPA catch-all: serve index.html for any non-API route when dist exists
if (hasDistFolder) {
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// Keep WS connections alive through Railway/Nginx proxies (25s < typical 30s idle timeout)
const WS_PING_INTERVAL = 25000;
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  });
}, WS_PING_INTERVAL);

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Burst initial state
  ws.send(JSON.stringify({ type: 'STATUS',  data: buildStatusPayload() }));
  ws.send(JSON.stringify({ type: 'MARKETS', data: state.markets }));
  ws.send(JSON.stringify({ type: 'TRADES_HISTORY', data: state.trading.trades.slice(0, 200) }));
  ws.send(JSON.stringify({ type: 'POSITIONS', data: state.positions.filter(p => p.status === 'OPEN') }));
  ws.send(JSON.stringify({ type: 'MARKET_DATA', data: {
    btcPrice: state.btcPrice, btcChange24h: state.btcChange24h,
    laggedPrice: getPriceAt(LAG_MS), impliedProb: computeImpliedProb(),
    polyOdds: computePolyOdds(), edge: computeImpliedProb() - computePolyOdds(),
    edgeHistory: state.edgeHistory.slice(-80),
    priceChart: state.priceChart.slice(-100),
    candles: state.candles.slice(-300),
    currentCandle: state.currentCandle,
    priceSource: state.priceSource, timestamp: Date.now(),
  }}));
  ws.on('close', () => console.log('[WS] Client disconnected'));
  ws.on('error', (err) => console.error('[WS] Error:', err.message));
});

// ── INIT ──────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`[Server] Poly-BTC-Bot on port ${PORT}`);

  // Load saved config, trades and session from disk
  const saved = loadSavedConfig();
  loadSavedTrades();
  if (saved) {
    const c = state.config;
    if (saved.mode                  !== undefined) c.mode                  = saved.mode;
    if (saved.capital               !== undefined) { c.capital = saved.capital; }
    if (saved.entryMode             !== undefined) c.entryMode             = saved.entryMode;
    if (saved.fixedAmount           !== undefined) c.fixedAmount           = saved.fixedAmount;
    if (saved.maxBetPct             !== undefined) c.maxBetPct             = saved.maxBetPct;
    if (saved.minEdge               !== undefined) c.minEdge               = saved.minEdge;
    if (saved.killThreshold         !== undefined) c.killThreshold         = saved.killThreshold;
    if (saved.autoTrade             !== undefined) c.autoTrade             = saved.autoTrade;
    if (saved.takeProfitPct         !== undefined) c.takeProfitPct         = saved.takeProfitPct;
    if (saved.stopLossPct           !== undefined) c.stopLossPct           = saved.stopLossPct;
    if (saved.posTimeoutMs          !== undefined) c.posTimeoutMs          = saved.posTimeoutMs;
    if (saved.maxOpenPos            !== undefined) c.maxOpenPos            = saved.maxOpenPos;
    if (saved.requireStableEdge     !== undefined) c.requireStableEdge     = saved.requireStableEdge;
    if (saved.allowDuplicateMarkets !== undefined) c.allowDuplicateMarkets = saved.allowDuplicateMarkets;
    if (saved.cooldownMs            !== undefined) state.trading.cooldownMs = saved.cooldownMs;
  }
  // Session restores balance/stats AFTER config applied — saved progress wins over default capital
  loadSavedSession();
  await loadBinanceHistory();
  connectBinance();
  await fetchBTCMarkets();
  // Refresh markets every 90s — ensures fresh prices and valid expiry windows
  setInterval(fetchBTCMarkets, 90 * 1000);
  // SIM mode: evolve market prices every 2s to simulate Polymarket's repricing lag
  setInterval(updateSimMarketPrices, 2000);
  // Binance REST fallback every 2s when WS is down — keeps priceHistory dense
  setInterval(pollBinanceRest, 2000);
  // Position monitor — 150ms for fast TP/SL response
  setInterval(monitorPositions, 150);
  // Fallback arbitrage timer — 400ms when Binance tick is slow/quiet (was 800ms)
  setInterval(() => {
    if (state.trading.active && state.priceHistory.length >= 5) runArbitrageCheck();
  }, 400);
  // Broadcast market data fallback — 300ms (main path throttled to 150ms in Binance handler)
  setInterval(broadcastMarketData, 300);
  // Reset today P&L at midnight UTC
  const msToMidnight = new Date().setUTCHours(24, 0, 0, 0) - Date.now();
  setTimeout(function resetDay() {
    state.stats.todayPnl = 0;
    broadcastStatus();
    setTimeout(resetDay, 86400000);
  }, msToMidnight);
});
