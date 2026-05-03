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
      active:       state.trading.active,
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
      if (s.active       !== undefined) state.trading.active       = s.active;
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
let _idSeq = 0; // Monotonic counter — prevents Date.now() collisions at SIM 10 Hz
const nextId = (prefix) => `${prefix}-${Date.now()}-${++_idSeq}`;
const PRICE_HIST_MS  = 300000; // 5 minutes of price history for charts
const POLY_FEE_RATE  = 0.02;   // Polymarket: 2% protocol fee on gross winnings (applied at settlement)
const CANDLE_SEC     = 5;      // 5-second OHLCV candles for TradingView-style chart

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  btcPrice:      0,
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
    minEdge: 0.02,
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
    totalFees:   0,
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

// ── ARBITRAGE TICK TRACKING ───────────────────────────────────────────────────
let lastArbCheckTs  = 0;
let lastBroadcastTs = 0;

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
  let heartbeatGuardFired = false;
  const heartbeatGuard = setInterval(() => {
    if (state.binanceConnected && Date.now() - lastWsMsgTs > 15000) {
      console.warn('[Binance WS] No message in 15s – forcing reconnect');
      state.binanceConnected = false;
      clearInterval(heartbeatGuard);
      heartbeatGuardFired = true;
      binanceTimer = setTimeout(connectBinance, 1000);
      try { ws.terminate(); } catch (_) {}
    }
  }, 5000);

  ws.on('close', () => {
    clearInterval(heartbeatGuard);
    // heartbeatGuard already set binanceTimer + logged — skip double-reconnect
    if (!heartbeatGuardFired) {
      state.binanceConnected = false;
      broadcast({ type: 'CONNECTION', data: { binanceConnected: false, priceSource: 'binance-rest' } });
      console.log('[Binance WS] Disconnected – reconnecting in 4s');
      binanceTimer = setTimeout(connectBinance, 4000);
    }
  });
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
    // Binance REST failed — try fallback price sources (Railway IPs sometimes blocked by Binance)
    // Throttle: only call external fallbacks at most once every 10s to avoid rate limits
    const nowFb = Date.now();
    if (nowFb - (pollBinanceRest._lastFallback || 0) < 10000) return;
    pollBinanceRest._lastFallback = nowFb;

    // Fallback 1: CoinGecko (free, no auth, ~10 req/min safe)
    let fbPrice = null;
    let fbSource = 'unavailable';
    try {
      const { data: cgData } = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price',
        { params: { ids: 'bitcoin', vs_currencies: 'usd' }, timeout: 5000 }
      );
      const p = cgData?.bitcoin?.usd;
      if (p && !isNaN(p) && p > 1000) { fbPrice = p; fbSource = 'coingecko'; }
    } catch (_) { /* try next */ }

    // Fallback 2: Kraken public ticker (no auth, usually accessible from cloud)
    if (!fbPrice) {
      try {
        const { data: krData } = await axios.get(
          'https://api.kraken.com/0/public/Ticker',
          { params: { pair: 'XBTUSD' }, timeout: 5000 }
        );
        const p = parseFloat(krData?.result?.XXBTZUSD?.c?.[0]);
        if (p && !isNaN(p) && p > 1000) { fbPrice = p; fbSource = 'kraken'; }
      } catch (_) { /* try next */ }
    }

    // Fallback 3: Coinbase public price (no auth)
    if (!fbPrice) {
      try {
        const { data: cbData } = await axios.get(
          'https://api.coinbase.com/v2/prices/BTC-USD/spot',
          { timeout: 5000 }
        );
        const p = parseFloat(cbData?.data?.amount);
        if (p && !isNaN(p) && p > 1000) { fbPrice = p; fbSource = 'coinbase'; }
      } catch (_) { /* all fallbacks failed */ }
    }

    if (fbPrice) {
      state.btcPrice    = fbPrice;
      state.priceSource = fbSource;
      const now = Date.now();
      state.priceHistory.push({ price: fbPrice, time: now });
      state.priceHistory = state.priceHistory.filter(p => now - p.time <= PRICE_HIST_MS);
      addChartPoint(fbPrice, now);
      updateCandle(fbPrice, now);
      if (state.trading.active && now - lastArbCheckTs >= 2000) {
        lastArbCheckTs = now;
        runArbitrageCheck();
      }
      if (now - lastBroadcastTs >= 2000) {
        lastBroadcastTs = now;
        broadcastMarketData();
      }
    } else {
      state.priceSource = 'unavailable';
      console.warn('[Price] Binance WS + REST + CoinGecko + Kraken + Coinbase all unavailable');
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
      // Seed a single real price point — no synthetic noise
      // The bot will populate priceHistory organically from Binance WS/REST ticks
      const now = Date.now();
      state.priceHistory = [{ time: now, price: currentPrice }];
      console.log(`[Binance] Emergency seed: price=$${currentPrice} (waiting for real ticks)`);
    } catch (_) { /* keep default state */ }
  }
}

// ── POLYMARKET MARKETS ────────────────────────────────────────────────────────
async function fetchBTCMarkets() {
  // Run ALL three fetches in parallel and MERGE results.
  // Previously we stopped at the first successful fetch — this caused the bot to miss
  // the short-term "Bitcoin Up or Down" 5/15-min markets (only in the recent-startDate slice)
  // because the high-volume slice (S1) found other BTC markets first but they were all
  // deeply skewed (prices near 0.999 or 0.018) and got rejected by getBestMarket().
  const fetches = [
    // S1: top 500 by volume — catches high-volume long-dated BTC markets
    axios.get(`${POLY_GAMMA}/markets`, {
      params: { active: true, closed: false, limit: 500, order: 'volume', ascending: false },
      timeout: 15000,
      headers: { 'User-Agent': 'poly-btc-bot/1.0' },
    }).catch(() => null),
    // S2: next 200 by volume (offset)
    axios.get(`${POLY_GAMMA}/markets`, {
      params: { active: true, closed: false, limit: 200, order: 'volume', ascending: false, offset: 500 },
      timeout: 12000,
    }).catch(() => null),
    // S3: most recently created — catches short-term "Bitcoin Up or Down" 5/15-min markets
    axios.get(`${POLY_GAMMA}/markets`, {
      params: { active: true, closed: false, limit: 200, order: 'startDate', ascending: false },
      timeout: 10000,
    }).catch(() => null),
  ];

  const responses = await Promise.all(fetches);

  // Collect all raw BTC markets from all slices, deduplicate by id
  const seen = new Set();
  const allBtc = [];
  for (const res of responses) {
    if (!res) continue;
    const list = Array.isArray(res.data) ? res.data : (res.data?.markets || res.data?.results || []);
    for (const m of list) {
      const q = (m.question || m.title || '').toLowerCase();
      if (!(q.includes('btc') || q.includes('bitcoin'))) continue;
      if (q.includes('eth') || q.includes('sol')) continue;
      const id = m.conditionId || m.id || m.slug;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      allBtc.push(m);
    }
  }

  if (allBtc.length > 0) {
    function mapMarket(m) {
      let prices;
      let priceIsEstimated = false;
      try {
        if (Array.isArray(m.outcomePrices)) {
          prices = m.outcomePrices.map(Number);
        } else if (typeof m.outcomePrices === 'string') {
          prices = JSON.parse(m.outcomePrices).map(Number);
        } else {
          // outcomePrices missing — derive from CLOB order book (bestBid/bestAsk)
          // or lastTradePrice. Gamma API omits outcomePrices for low-activity markets.
          const last = parseFloat(m.lastTradePrice ?? NaN);
          const bid  = parseFloat(m.bestBid  ?? 0);
          const ask  = parseFloat(m.bestAsk  ?? 1);
          if (isFinite(last) && last > 0 && last < 1) {
            prices = [last, 1 - last];
          } else if (bid > 0 && ask < 1 && bid < ask) {
            const mid = (bid + ask) / 2;
            prices = [mid, 1 - mid];
          } else {
            prices = [0.5, 0.5];
            priceIsEstimated = true; // no price data — flag to block trading
          }
        }
        if (!Array.isArray(prices) || prices.length < 2 || !prices.every(p => isFinite(p) && p >= 0 && p <= 1)) {
          prices = [0.5, 0.5];
          priceIsEstimated = true;
        }
      } catch { prices = [0.5, 0.5]; priceIsEstimated = true; }

      const q = (m.question || m.title || '').toLowerCase();
      // Scoring: short-term "up or down" 5/15-min markets are highest priority
      const upOrDown = /up or down/.test(q);
      const shortTerm = /5 min|10 min|15 min|1 hour|today|\bday\b/.test(q);
      const midTerm   = /this week|week|\bmonth\b|may |june|july/.test(q);
      const score     = upOrDown ? 5 : shortTerm ? 3 : midTerm ? 2 : 1;

      const rawVol    = m.volume ?? m.volumeNum ?? m.volumeClob ?? m.usdcSize ?? m.liquidity ?? 0;
      const parsedVol = typeof rawVol === 'string' ? parseFloat(rawVol) : Number(rawVol);
      return {
        id: m.conditionId || m.id || m.slug,
        question: m.question || m.title || 'BTC Market',
        outcomes: m.outcomes || ['Yes', 'No'],
        outcomePrices: prices,
        volume: (isFinite(parsedVol) && parsedVol > 0) ? Math.round(parsedVol) : 0,
        startDate: m.startDate || m.startDateIso || null,
        endDate: m.endDateIso || m.endDate || m.end_date_iso,
        clobTokenIds: m.clobTokenIds || [],
        live: true,
        _score: score,
        priceIsEstimated,
        // Snapshot BTC price at market window open (used as strike for Up/Down markets).
        // Capture while priceHistory is still fresh — getPriceAt() only has 5 min depth.
        _strikeSnapshot: (() => {
          if (!upOrDown) return null;
          const windowOpenMs = (m.startDate || m.startDateIso)
            ? new Date(m.startDate || m.startDateIso).getTime() : 0;
          if (windowOpenMs > 0 && windowOpenMs <= Date.now()) {
            return getPriceAt(Date.now() - windowOpenMs) || null;
          }
          return null;
        })(),
      };
    }

    const mapped = allBtc.map(mapMarket);
    // Sort: up-or-down first, then short-term, then by volume
    mapped.sort((a, b) => b._score - a._score || b.volume - a.volume);

    const existingSim = state.markets.filter(m => m.id && m.id.startsWith('sim-'));
    state.markets = [...mapped, ...existingSim];
    const top = mapped[0];
    console.log(`[Polymarket] Loaded ${mapped.length} real BTC markets | top: "${top.question}" price=${top.outcomePrices[0]} vol=$${top.volume.toLocaleString()}`);
    broadcast({ type: 'MARKETS', data: state.markets });
    return;
  }

  // All fetches failed or no BTC markets found — fall back to sim markets
  seedSimMarkets();
  broadcast({ type: 'MARKETS', data: state.markets });
}

function seedSimMarkets() {
  const base = Math.round(state.btcPrice / 1000) * 1000;
  // Keep real (live) markets intact — only replace/refresh sim markets
  const liveMarkets = state.markets.filter(m => m.live);
  state.markets = [
    ...liveMarkets,
    { id: 'sim-1', question: `Will BTC be above $${base.toLocaleString()} in 15 min?`, outcomes: ['Yes','No'], outcomePrices: [0.52, 0.48], volume: 185000, endDate: new Date(Date.now() + 15 * 60000).toISOString(), live: false },
    { id: 'sim-2', question: `Will BTC reach $${(base + 500).toLocaleString()} today?`,  outcomes: ['Yes','No'], outcomePrices: [0.44, 0.56], volume: 442000, endDate: new Date(Date.now() + 8 * 3600000).toISOString(), live: false },
    { id: 'sim-3', question: 'Will BTC end the week above last week\'s close?',            outcomes: ['Yes','No'], outcomePrices: [0.55, 0.45], volume: 930000, endDate: new Date(Date.now() + 5 * 86400000).toISOString(), live: false },
    { id: 'sim-4', question: `Will BTC make a new ATH this month?`,                        outcomes: ['Yes','No'], outcomePrices: [0.48, 0.52], volume: 2100000, endDate: new Date(Date.now() + 25 * 86400000).toISOString(), live: false },
  ];
  console.log('[Polymarket] Sim markets seeded (fallback)');
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
// Uses relative window (last half vs first half of recent history) so it works
// correctly at both 10 Hz (WS) and 0.5 Hz (REST fallback) tick rates.
function edgeVelocity() {
  const h = state.edgeHistory;
  if (h.length < 4) return 0;
  const mid = Math.ceil(h.length / 2);
  const recent = h.slice(mid);
  const older  = h.slice(0, mid);
  const rAvg = recent.reduce((s, e) => s + Math.abs(e.edge), 0) / recent.length;
  const oAvg = older.reduce((s, e)  => s + Math.abs(e.edge), 0) / older.length;
  return rAvg - oAvg; // positive = edge growing, negative = edge shrinking
}

// Edge quality: ratio of consistent-direction samples in recent 1/3 of history.
// 1.0 = all samples agree, 0.5 = random noise.
function edgeQuality(edge) {
  const h = state.edgeHistory;
  if (h.length < 3) return 0.5;
  const recentSlice = h.slice(-Math.max(3, Math.ceil(h.length / 3)));
  const significant = recentSlice.filter(e => Math.abs(e.edge) > 0.005);
  if (significant.length < 2) return 0.5;
  const bull     = significant.filter(e => e.edge > 0).length;
  const bear     = significant.filter(e => e.edge < 0).length;
  const dominant = Math.max(bull, bear);
  return dominant / significant.length; // 0.5–1.0
}

// Best market to trade: prefer short-term + highest edge potential
function getBestMarket() {
  if (state.markets.length === 0) return null;
  const now = Date.now();
  // "Up or Down" short-term binaries are created ~24h in advance — allow up to 24h window.
  // Other live markets: up to 4h in LIVE (don't trade long-dated with binary model).
  // SIM: up to 31 days (educational range).
  const maxMinutes = state.config.mode === 'SIM' ? 44640 : 1440; // LIVE: 24h (was 4h)
  const minMinutes = 1;
  const scored = state.markets.map(m => {
    const msLeft = m.endDate ? new Date(m.endDate).getTime() - now : 10 * 60000;
    const minLeft = msLeft / 60000;
    if (minLeft < minMinutes || minLeft > maxMinutes) return { m, score: -1 };
    // Block markets with no real price data — would generate false signals against 0.5
    if (m.priceIsEstimated) return { m, score: -1 };
    // Prefer short-term (5–30 min window) for momentum arb
    const timeScore = minLeft <= 30 ? 3 : minLeft <= 60 ? 2 : minLeft <= 1440 ? 1 : 0;
    const volScore  = m.volume >= 100000 ? 2 : m.volume >= 20000 ? 1 : 0;
    // Filter out near-certain markets (YES > 0.92 or YES < 0.08).
    const yesPrice  = m.outcomePrices?.[0] ?? 0.5;
    const priceDist = Math.abs(yesPrice - 0.5);
    if (priceDist > 0.42) return { m, score: -1 }; // YES > 0.92 or < 0.08 — exclude
    // Volume threshold: "Up or Down" short-term binaries have low volume at creation
    // ($1k–$15k) — they accumulate volume near expiry. Accept them with $1k minimum.
    // Other live markets keep the $50k threshold (CLOB fills are infeasible below that).
    const q = (m.question || '').toLowerCase();
    const isUpOrDown = /up or down/.test(q);
    const minVol = isUpOrDown ? 1000 : 50000;
    if (m.live && Number(m.volume || 0) < minVol) return { m, score: -1 };
    // Prefer markets nearer to 0.5 (more uncertainty = larger edge swings possible)
    const priceScore = priceDist < 0.10 ? 3 : priceDist < 0.25 ? 2 : priceDist < 0.40 ? 1 : 0;
    // Bonus score for Up or Down markets (these are the ideal arb target)
    const upOrDownBonus = isUpOrDown ? 2 : 0;
    return { m, score: timeScore + volScore + priceScore + upOrDownBonus };
  }).filter(x => x.score >= 0).sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // No real markets qualify — use simulated markets in SIM mode so the engine can trade
    if (state.config.mode === 'SIM') {
      // Find a usable sim market (price not too skewed — otherwise edge ≈ 0 at extremes)
      const usableSim = state.markets.find(m =>
        m.id && m.id.startsWith('sim-') &&
        Math.abs((m.outcomePrices?.[0] ?? 0.5) - 0.5) <= 0.42
      );
      if (!usableSim) {
        // All sim markets are deeply skewed or missing — re-seed with fresh ATM markets
        seedSimMarkets();
      }
      return state.markets.find(m => m.id && m.id.startsWith('sim-')) || state.markets[0];
    }
    return null;
  }
  return scored[0].m;
}

// ── BINARY OPTION PRICING ───────────────────────────────────────────────────
// Computes P(BTC_T > strike) using current real-time BTC price, realized vol, and time-to-expiry.
// This is the correct real-time fair value for a Polymarket binary question.
// Used by: computeImpliedProb() (signal), monitorPositions() (mark-to-market),
//          updateSimMarketPrices() (display prices for sim markets).
// All three use the SAME formula — ensuring signal, mark and display are consistent.
function computeBinaryMid(market, btcOverride) {
  const btc = btcOverride ?? state.btcPrice;
  if (!btc || btc <= 0 || !market) return 0.5;

  // Parse strike from question: "Will BTC be above $97,000 in 15 min?"
  const strikeMatch = market.question?.match(/\$([0-9,]+)/);
  let strike;
  if (strikeMatch) {
    // Explicit strike in question (e.g. "above $97,000")
    strike = parseFloat(strikeMatch[1].replace(/,/g, ''));
  } else {
    // "Bitcoin Up or Down" markets: strike = BTC price at window start.
    // The window opens at market.startDate. If startDate is in the past (window is
    // currently active), fetch BTC from priceHistory at that timestamp.
    // If startDate is in the future (pre-window), use oldest available price in
    // priceHistory (best momentum proxy). Falls back to current BTC.
    const windowOpenMs = market.startDate ? new Date(market.startDate).getTime() : 0;
    const nowMs = Date.now();
    if (windowOpenMs > 0 && windowOpenMs <= nowMs) {
      // Window is open — use snapshotted strike if available (more accurate than
      // getPriceAt which is limited to 5-min history depth)
      strike = market._strikeSnapshot
        || getPriceAt(nowMs - windowOpenMs)
        || state.priceHistory[0]?.price
        || btc;
    } else {
      // Window hasn't started yet — oldest price in priceHistory is best proxy
      strike = (state.priceHistory.length > 0 ? state.priceHistory[0].price : null) || btc;
    }
  }

  const now       = Date.now();
  const msLeft    = market.endDate ? new Date(market.endDate).getTime() - now : 15 * 60000;
  const hoursLeft = Math.max(1 / 3600, msLeft / 3600000); // min 1 second

  // Realized vol (1-min window) scaled to per-hour
  const realizedVol = recentVolatility(60000);
  const volPerHour  = Math.max(0.001, realizedVol * Math.sqrt(3600));

  // Black-Scholes d2: ln(S/K) / (σ√T)
  // Positive when BTC is above strike, negative when below.
  const sigmaT = volPerHour * Math.sqrt(hoursLeft);
  const d2     = Math.log(btc / strike) / Math.max(0.001, sigmaT);

  // Logistic CDF ≈ normal CDF Φ(d2)
  return Math.max(0.03, Math.min(0.97, 1 / (1 + Math.exp(-1.7 * d2))));
}

// computeEdge: computes implied, poly and edge for a GIVEN market.
//   implied = computeBinaryMid(market, BTC_now) — our binary option model fair value
//   poly    = market.outcomePrices[0]           — ACTUAL Polymarket price
//               • live markets: from Gamma API (polled every 90s)
//               • sim markets:  from updateSimMarketPrices() using lagged BTC
//   edge    = implied - poly  — our model's mispricing vs what Polymarket offers
//
// implied > poly → market underprices YES → BUY_YES
// implied < poly → market overprices  YES → BUY_NO
function computeEdge(market) {
  if (!market) return { implied: 0.5, poly: 0.5, edge: 0 };
  const implied = computeBinaryMid(market);          // our model: fair value at BTC_now
  const poly    = market.outcomePrices?.[0] ?? 0.5; // real market price (Gamma API or sim)
  return { implied, poly, edge: implied - poly };
}

// Legacy wrappers used by broadcastMarketData — always consistent because
// they call computeEdge with the same single getBestMarket() result.
function computeImpliedProb() {
  const market = getBestMarket();
  return computeEdge(market).implied;
}
function computePolyOdds() {
  const market = getBestMarket();
  return computeEdge(market).poly;
}

// ── EMPIRICAL KELLY CALIBRATION ─────────────────────────────────────────
// Computes win rate and win/loss ratio from the last N closed trades.
// When enough data exists (≥20 trades), blends with the theoretical Kelly
// computed from the edge. This grounds position sizing in actual results
// rather than theoretical edge estimates alone.
// Returns { winRate, avgWin, avgLoss, kellyFraction } or null if < 20 trades.
function empiricalKellyParams(minTrades = 20, window = 100) {
  const closed = state.trading.trades.slice(0, window);
  if (closed.length < minTrades) return null;

  const wins   = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  if (wins.length === 0 || losses.length === 0) return null;

  const p      = wins.length / closed.length;  // empirical win rate
  const avgWin  = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;    // average $ won
  const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length); // average $ lost
  const b       = avgWin / avgLoss;            // win/loss ratio (b in Kelly formula)

  // f* = (p*b - q) / b  where q = 1 - p
  const kellyFraction = Math.max(0, Math.min(1, (p * b - (1 - p)) / b));
  return { winRate: p, avgWin, avgLoss, b, kellyFraction };
}

// Kelly criterion — blends empirical (data-driven) with theoretical when ≥20 trades exist
// entryPrice = cost per share; netOdds = (1 - entryPrice) / entryPrice
function kellySize(edge, winProb, entryPrice, balance, maxBetPct) {
  if (edge <= 0 || winProb <= 0 || entryPrice <= 0 || entryPrice >= 1) return 0;
  const netOdds   = (1 - entryPrice) / entryPrice;

  // Theoretical Kelly (from model edge)
  const fullKellyTheory = (netOdds * winProb - (1 - winProb)) / netOdds;

  // Empirical Kelly (from actual trade results) — blended when ≥20 trades available
  let fullKelly = fullKellyTheory;
  const emp = empiricalKellyParams();
  if (emp) {
    // Blend: 60% empirical + 40% theoretical
    // Empirical is grounded in reality; theoretical guides early-stage edge changes
    fullKelly = emp.kellyFraction * 0.60 + fullKellyTheory * 0.40;
  }

  // Quality-scaled Kelly fraction: 1/5 at low quality, up to 1/3 at perfect quality
  const quality   = edgeQuality(edge);
  const kFrac     = 0.20 + (quality - 0.5) * 0.267;
  const scaled    = Math.max(0, fullKelly * kFrac);
  const streak    = state.stats.streak;
  // Adaptive sizing from MrFadiAi: -20% per consecutive loss, +10% per consecutive win, cap 2.5×
  const sMult     = streak < -1
    ? Math.max(0.4, Math.pow(0.80, Math.abs(streak) - 1))   // shrink on losing streak
    : streak > 1
      ? Math.min(2.5, Math.pow(1.10, streak - 1))            // grow on winning streak
      : 1.0;
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
  // ── Single getBestMarket() call per tick ─────────────────────────────────
  // CRITICAL: getBestMarket() must be called ONCE here. Calling it separately
  // inside computeImpliedProb() and computePolyOdds() can return different
  // markets on consecutive calls (scoring is time-dependent), making the edge
  // meaningless (difference between two unrelated markets' model prices).
  const market = getBestMarket();
  if (!market) return;

  const { implied, poly, edge } = computeEdge(market);
  const now        = Date.now();
  const volScale   = Math.max(1.0, Math.min(1.5, recentVolatility(20000) / 0.0015));
  const dynMinEdge = state.config.minEdge * volScale;

  // Debug log every 10s
  if (now - (runArbitrageCheck._lastLog || 0) > 10000) {
    runArbitrageCheck._lastLog = now;
    console.log(`[ARB] implied=${implied.toFixed(4)} poly=${poly.toFixed(4)} edge=${(edge*100).toFixed(2)}¢ minEdge=${(dynMinEdge*100).toFixed(2)}¢ mkt="${market.question?.slice(0,28)}" active=${state.trading.active} autoTrade=${state.config.autoTrade}`);
  }

  // Always record edge history so the Binance-vs-Poly chart is always populated.
  // The stability window (hasStableEdge) filters by minEdge separately below.
  state.edgeHistory.push({ time: now, edge, implied, poly });
  if (state.edgeHistory.length > 80) state.edgeHistory.shift();

  if (Math.abs(edge) < dynMinEdge) {
    state.currentSignal = null;
    return broadcastSignal();
  }

  const side       = edge > 0 ? 'BUY_YES' : 'BUY_NO';
  const winProb    = edge > 0 ? implied : (1 - implied);

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

  // Guard: NEVER open opposite direction on the same market — self-canceling trades.
  // BUT: if the best market has a conflicting open position, try an alternative market
  // from the available list so YES and NO entries can both happen simultaneously.
  let tradeMarket = market;
  let hasOpposite = state.positions.some(p =>
    p.status === 'OPEN' && p.marketId === tradeMarket.id && p.side !== side
  );
  if (hasOpposite) {
    // Try to find an alternative market without a conflicting position for this side
    const alternatives = state.markets.filter(m => {
      if (m.id === tradeMarket.id) return false; // skip primary
      const priceDist = Math.abs((m.outcomePrices?.[0] ?? 0.5) - 0.5);
      if (priceDist > 0.42) return false; // skip skewed markets
      if (m.live && Number(m.volume || 0) < 50000) return false; // volume filter
      const msLeft = m.endDate ? new Date(m.endDate).getTime() - now : 10 * 60000;
      if (msLeft < 60000) return false; // must have at least 1 min left
      return !state.positions.some(p => p.status === 'OPEN' && p.marketId === m.id && p.side !== side);
    });
    if (alternatives.length > 0) {
      tradeMarket = alternatives[0];
      hasOpposite = false; // cleared — alternative has no conflicting position
      // Update signal to reflect the alternative market
      state.currentSignal.marketId = tradeMarket.id;
      state.currentSignal.question = tradeMarket.question;
    }
  }

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

  // ── ENTRY QUALITY GUARDS (applied before auto-trade and signal display) ───────
  // Based on research: homerun, aulekator, gamma-trade-lab, MrFadiAi

  // 1. SETTLEMENT TIMING GUARD
  // In the final 3 minutes of a short-term binary (≤30 min), 60-90% of informed
  // volume arrives. Entering here is strongly adversely selected.
  const mktMsLeft  = tradeMarket.endDate ? new Date(tradeMarket.endDate).getTime() - now : Infinity;
  const isShortMkt = mktMsLeft <= 30 * 60000;
  if (isShortMkt && mktMsLeft < 3 * 60000) {
    state.currentSignal = null;
    return broadcastSignal();
  }

  // 2. BTC DIRECTIONAL CONFIRMATION
  // BTC trend (last 10s) must not be strongly OPPOSING our bet direction.
  // Prevents buying YES while BTC is in a sharp downtrend, and vice versa.
  // Only blocked when counter-trend > 5bps in 10s AND edge < 3× minimum.
  const btc10sAgo   = getPriceAt(10000);
  const btcTrend10s = btc10sAgo > 0 ? (state.btcPrice - btc10sAgo) / btc10sAgo : 0;
  const counterFlow = side === 'BUY_YES' ? btcTrend10s < -0.0005 : btcTrend10s > 0.0005;
  if (counterFlow && Math.abs(edge) < dynMinEdge * 3) {
    state.currentSignal = null;
    return broadcastSignal();
  }

  // 3. ADVERSE SELECTION COOLDOWN
  // If ≥3 of the last 5 closed trades were losses, pause new auto-entries for 60s.
  // Signals the bot may be in a toxic-flow regime. (gamma-trade-lab pattern)
  const last5 = state.trading.trades.slice(0, 5);
  if (last5.length >= 5) {
    const lossCount = last5.filter(t => t.outcome === 'LOSS').length;
    if (lossCount >= 3) {
      const lastLossTs = (last5.find(t => t.outcome === 'LOSS') || {}).timestamp || 0;
      if (now - lastLossTs < 60000) {
        // Emit signal so UI shows it, but block auto-execution until cooldown expires
        broadcastSignal();
        return;
      }
    }
  }

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
  const market = state.markets.find(m => m.id === marketId);
  if (!market) {
    console.warn(`[CLOB] Stale marketId ${marketId} — market no longer in state, signal expired`);
    return;
  }

  // ── REAL CLOB CONSTRAINTS (applied in both SIM and LIVE) ──────────────────
  const vol = Number(market.volume || 0);

  // Minimum market volume: "Up or Down" short-term markets have low volume at creation
  // but are the primary arb target. Use $1k minimum for them, $50k for all others.
  const qLower = (market.question || '').toLowerCase();
  const MIN_VOL = /up or down/.test(qLower) ? 1000 : 50000;
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
    id:               nextId('p'),
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

// ── SIM MARKET PRICE MODEL ───────────────────────────────────────────────────────────────
// Updates prices for sim (non-live) markets every 2s using a proper binary option model.
// This mimics how a real Polymarket market maker reprices based on the underlying asset.
// Real markets (live:true) are updated via fetchBTCMarkets() every 90s — same as LIVE mode.
function updateSimMarketPrices() {
  if (!state.btcPrice || state.btcPrice <= 0) return;

  // Auto-refresh sim markets if none are valid (expired, never seeded, or deeply skewed).
  // A deeply skewed market (YES > 0.85 or < 0.15) has near-zero binary option sensitivity
  // to BTC moves — edge stays at ~0¢ and no trades are generated. Re-seed immediately.
  const nowMs = Date.now();
  const activeSims = state.markets.filter(m => !m.live && m.endDate && new Date(m.endDate).getTime() > nowMs + 60000);
  const usableSims = activeSims.filter(m => Math.abs((m.outcomePrices?.[0] ?? 0.5) - 0.5) <= 0.35);
  if (activeSims.length === 0 || usableSims.length === 0) seedSimMarkets();
  if (state.markets.length === 0) return;

  // Sim markets must mirror the same ~90s lag as the Gamma API has for live markets.
  // Use the real BTC price from 90s ago (from priceHistory) — not the current price.
  // This way: implied(BTC now) vs poly(BTC 90s ago) → edge is non-zero when BTC moved.
  const btcLagged = getPriceAt(90000); // real historical BTC price, 90s ago

  for (const m of state.markets) {
    if (m.live) continue; // real markets updated by fetchBTCMarkets every 90s
    if (!m.outcomePrices) m.outcomePrices = [0.5, 0.5];
    // Price with lagged BTC — mirrors Gamma API poll cadence
    const rawProb = computeBinaryMid(m, btcLagged);
    // Add tiny microstructure noise (\u00b10.3\u00a2)
    const noise = (Math.random() - 0.5) * 0.003;
    const newYes = Math.max(0.03, Math.min(0.97, rawProb + noise));
    m.outcomePrices[0] = Math.round(newYes * 1000) / 1000;
    m.outcomePrices[1] = Math.round((1 - m.outcomePrices[0]) * 1000) / 1000;
  }
}

// ── POSITION CLOSE ───────────────────────────────────────────────────────────────

function closePosition(pos, exitOdds, reason) {
  pos.status      = 'CLOSED';
  pos.exitOdds    = Math.round(exitOdds * 1000) / 1000;
  pos.closeReason = reason;
  pos.closeTime   = Date.now();
  pos.holdMs      = pos.closeTime - pos.entryTime;

  // Apply CLOB exit spread (selling at BID = mid − half-spread) — identical in SIM and LIVE.
  // clobSpread() returns the half-spread (distance from mid to ask/bid).
  const market = state.markets.find(m => m.id === pos.marketId);
  const exitSpread    = clobSpread(Number(market?.volume || 0));
  const effectiveExit = Math.max(0.01, exitOdds - exitSpread);

  // P&L = (effectiveExit − entryOdds) × shares
  const rawPnl   = (effectiveExit - pos.entryOdds) * pos.shares;
  const grossPnl = Math.round(rawPnl * 100) / 100;
  // Polymarket 2% protocol fee is ONLY deducted at settlement (market resolves to 0 or 1).
  // TP / SL / MANUAL are CLOB early-sells — no settlement fee applies.
  // A TIMEOUT is treated as a settlement only when odds confirm resolution (≥0.95 or ≤0.05).
  const isSettlement = reason === 'TIMEOUT' && (exitOdds >= 0.95 || exitOdds <= 0.05);
  const fee = (grossPnl > 0 && isSettlement) ? Math.round(grossPnl * POLY_FEE_RATE * 100) / 100 : 0;
  const pnl      = Math.round((grossPnl - fee) * 100) / 100;
  const outcome  = pnl >= 0 ? 'WIN' : 'LOSS';

  // Return cost + net PnL to balance
  state.trading.balance     = Math.round((state.trading.balance + pos.cost + pnl) * 100) / 100;
  state.trading.peakBalance = Math.max(state.trading.peakBalance, state.trading.balance);

  state.stats.totalTrades++;
  state.stats.totalPnl  = Math.round((state.stats.totalPnl  + pnl) * 100) / 100;
  state.stats.todayPnl  = Math.round((state.stats.todayPnl  + pnl) * 100) / 100;
  state.stats.totalFees = Math.round(((state.stats.totalFees || 0) + fee + (pos.spread || 0) * pos.shares + (pos.impact || 0) * pos.shares) * 100) / 100;
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
    // Update mark price from real Polymarket market odds (re-polled every 90s from Gamma API).
    // Identical for SIM and LIVE: mark = current YES or NO mid-price from the market.
    const mktForPos = state.markets.find(m => m.id === pos.marketId);
    // Mark = current CLOB mid price from the market object.
    // For sim markets: updated every 2s by updateSimMarketPrices() via binary option model.
    // For live markets: updated every 90s by fetchBTCMarkets() from Gamma API.
    // This is the price at which the CLOB currently quotes — the only price you can exit at.
    const yesOdds = mktForPos?.outcomePrices?.[0] ?? pos.markOdds;
    const midOdds = pos.side === 'BUY_YES' ? yesOdds : (1 - yesOdds);
    const newMark = Math.max(0.03, Math.min(0.97, midOdds));
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
  const mkt            = getBestMarket();
  const { implied, poly, edge } = computeEdge(mkt);
  // Send only live tick + current candle. Full candle history (300 candles ~39KB)
  // is fetched by the 3s HTTP pollCandles — do NOT resend every 150ms WS tick.
  broadcast({
    type: 'MARKET_DATA',
    data: {
      btcPrice:     state.btcPrice,
      btcChange24h: state.btcChange24h,
      laggedPrice:  getPriceAt(LAG_MS),
      impliedProb:  implied,
      polyOdds:     poly,
      edge,
      edgeHistory:  state.edgeHistory.slice(-80),
      priceChart:   state.priceChart.slice(-100),
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
    kelly:         empiricalKellyParams(),   // null until 20 trades; then { winRate, b, kellyFraction }
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
  saveSession();
  broadcastStatus();
  // Run an immediate check so UI sees signal right away
  if (state.priceHistory.length >= 3) runArbitrageCheck();
  res.json({ success: true, active: true });
});

app.post('/api/bot/stop', (req, res) => {
  if (!state.trading.active) return res.json({ success: true, active: false }); // idempotent
  state.trading.active  = false;
  state.currentSignal   = null;
  saveSession();
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

app.post('/api/sim/reset', (req, res) => {
  if (state.config.mode !== 'SIM') {
    return res.status(400).json({ error: 'Reset only available in SIM mode' });
  }
  // Force-close all open positions without P&L (clean wipe)
  state.positions.forEach(p => { if (p.status === 'OPEN') p.status = 'CLOSED'; });
  // Reset balance and stats to starting capital
  state.trading.balance      = state.config.capital;
  state.trading.startBalance = state.config.capital;
  state.trading.peakBalance  = state.config.capital;
  state.trading.trades       = [];
  state.trading.lastTradeTs  = 0;
  state.stats = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, todayPnl: 0, streak: 0, totalFees: 0 };
  state.currentSignal = null;
  // Clear persisted trade and session files
  try { fs.unlinkSync(TRADES_FILE); } catch (_) {}
  saveSession();
  broadcastStatus();
  broadcastSignal();
  broadcast({ type: 'TRADES_HISTORY', data: [] });
  broadcast({ type: 'POSITIONS', data: [] });
  console.log('[SIM] Reset — balance restored to $' + state.config.capital);
  res.json({ success: true, balance: state.trading.balance });
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
app.get('/api/candles', (req, res) => {
  const { implied, poly, edge } = computeEdge(getBestMarket());
  res.json({
    candles:       state.candles.slice(-300),
    currentCandle: state.currentCandle,
    edgeHistory:   state.edgeHistory.slice(-80),
    impliedProb:   implied,
    polyOdds:      poly,
    edge,
  });
});

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
  // Burst initial state — use single getBestMarket() call so implied/poly/edge are consistent
  const { implied: initImp, poly: initPly, edge: initEdg } = computeEdge(getBestMarket());
  ws.send(JSON.stringify({ type: 'STATUS',  data: buildStatusPayload() }));
  ws.send(JSON.stringify({ type: 'MARKETS', data: state.markets }));
  ws.send(JSON.stringify({ type: 'TRADES_HISTORY', data: state.trading.trades.slice(0, 200) }));
  ws.send(JSON.stringify({ type: 'POSITIONS', data: state.positions.filter(p => p.status === 'OPEN') }));
  ws.send(JSON.stringify({ type: 'MARKET_DATA', data: {
    btcPrice: state.btcPrice, btcChange24h: state.btcChange24h,
    laggedPrice: getPriceAt(LAG_MS), impliedProb: initImp,
    polyOdds: initPly, edge: initEdg,
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

  // Auto-resume: if autoTrade was enabled when the server last ran, restart trading automatically.
  // This ensures a Railway redeploy / crash-restart resumes without manual intervention.
  if (state.config.autoTrade) {
    state.trading.active      = true;
    state.trading.lastTradeTs = 0; // reset cooldown so first trade fires immediately
    console.log('[Bot] Auto-resumed: autoTrade=true in saved config');
  }

  await loadBinanceHistory();
  connectBinance();
  await fetchBTCMarkets();
  // Refresh markets every 90s — ensures fresh Polymarket prices and valid expiry windows.
  // This natural polling lag (90s) mirrors Polymarket's real update cycle for both SIM and LIVE.
  setInterval(fetchBTCMarkets, 90 * 1000);
  // Sim market price model: re-prices non-live markets every 2s using real BTC + binary option math
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
