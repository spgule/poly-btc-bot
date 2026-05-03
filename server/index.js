'use strict';
/*
================================================================================
REGRAS DE FIDELIDADE DE SIMULAÇÃO (NUNCA REVERTER)
Este projeto exige que o modo SIM seja 100% fiel ao LIVE.
Qualquer mudança neste arquivo deve preservar as seguintes regras:

1. Preço BTC: 100% real Binance WS. Nunca injetar pontos sintéticos em priceHistory.
2. Odds Polymarket (mercados reais): Polled do Gamma API a cada 90s. Nunca computar de momentum BTC.
3. Odds Polymarket (sim fallback): updateSimMarketPrices() a cada 2s — modelo de opção binária: P(BTC_T > strike) = logistic(d1).
4. Spread de entrada: simulateClobFill(): mid + clobSpread(vol) + priceImpact() — igual em SIM e LIVE.
5. Spread de saída: closePosition(): effectiveExit = exitOdds - clobSpread(vol) — igual em SIM e LIVE.
6. Volume mínimo: MIN_VOL = $50k para SIM e LIVE.
7. Taxa Polymarket 2%: Somente no settlement (TIMEOUT, odds >= 0.95 ou <= 0.05). Não em TP/SL/MANUAL.
8. Cooldown: Math.max(cooldownMs, 2000) — mínimo 2s entre trades.
9. computePolyOdds(): Retorna market.outcomePrices[0] direto para ambos os modos.
10. computeEdge(): poly = market.outcomePrices[0] — nunca computar poly a partir do histórico BTC.
================================================================================

PRICE FEED LOCK (2026-05-03)
Do not modify Binance/Railway price feed, fallback, candle, chart hydration, or
cache behavior without explicit user approval in the current conversation.
Read PRICE_FEED_LOCK.md before touching this area.
*/
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
      cooldownMs:            Math.max(2000, state.trading.cooldownMs),
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Config] Failed to save config:', e.message);
  }
}

function applyConfigPatch(patch = {}) {
  const c = state.config;
  if (patch.mode && ['SIM', 'LIVE'].includes(patch.mode)) c.mode = patch.mode;
  if (patch.entryMode && ['kelly', 'fixed'].includes(patch.entryMode)) c.entryMode = patch.entryMode;
  if (patch.capital > 0 && !state.trading.active) {
    c.capital = patch.capital;
    state.trading.balance = patch.capital;
    state.trading.startBalance = patch.capital;
    state.trading.peakBalance = patch.capital;
  }
  if (patch.fixedAmount > 0) {
    c.fixedAmount = Math.min(patch.fixedAmount, state.trading.balance || c.capital);
  }
  if (patch.maxBetPct !== undefined) c.maxBetPct = Math.min(50, Math.max(1, Number(patch.maxBetPct) || c.maxBetPct));
  if (patch.minEdge !== undefined) c.minEdge = Math.min(0.5, Math.max(0.01, Number(patch.minEdge) || c.minEdge));
  if (patch.killThreshold !== undefined) c.killThreshold = Math.min(100, Math.max(5, Number(patch.killThreshold) || c.killThreshold));
  if (patch.autoTrade !== undefined) c.autoTrade = Boolean(patch.autoTrade);
  if (patch.takeProfitPct !== undefined) c.takeProfitPct = Math.min(100, Math.max(1, Number(patch.takeProfitPct) || c.takeProfitPct));
  if (patch.stopLossPct !== undefined) c.stopLossPct = Math.min(100, Math.max(1, Number(patch.stopLossPct) || c.stopLossPct));
  if (patch.posTimeoutMs !== undefined) c.posTimeoutMs = Math.min(3600000, Math.max(30000, Number(patch.posTimeoutMs) || c.posTimeoutMs));
  if (patch.maxOpenPos !== undefined) c.maxOpenPos = Math.min(20, Math.max(1, Number(patch.maxOpenPos) || c.maxOpenPos));
  if (patch.requireStableEdge !== undefined) c.requireStableEdge = Boolean(patch.requireStableEdge);
  if (patch.allowDuplicateMarkets !== undefined) c.allowDuplicateMarkets = Boolean(patch.allowDuplicateMarkets);
  if (patch.cooldownMs !== undefined) state.trading.cooldownMs = Math.min(60000, Math.max(2000, Number(patch.cooldownMs) || state.trading.cooldownMs));
}

function buildTradeSignal(market, now = Date.now()) {
  if (!market) return null;
  const { implied, poly, edge } = computeEdge(market);
  const volScale   = Math.max(1.0, Math.min(1.5, recentVolatility(20000) / 0.0015));
  const dynMinEdge = state.config.minEdge * volScale;
  if (Math.abs(edge) < dynMinEdge) return null;

  const side       = edge > 0 ? 'BUY_YES' : 'BUY_NO';
  const winProb    = edge > 0 ? implied : (1 - implied);
  const marketYes  = market.outcomePrices?.[0] ?? 0.5;
  const entryPrice = side === 'BUY_YES' ? marketYes : (1 - marketYes);
  const betSize = state.config.entryMode === 'fixed'
    ? Math.min(state.config.fixedAmount, state.trading.balance)
    : kellySize(Math.abs(edge), winProb, entryPrice, state.trading.balance, state.config.maxBetPct);
  const velBonus   = edgeVelocity() > 0.003 ? 10 : 0;
  const qualBonus  = Math.round(edgeQuality(edge) * 20);
  const confidence = Math.min(99, 50 + Math.abs(edge) * 250 + velBonus + qualBonus);

  return {
    marketId: market.id,
    question: market.question,
    side,
    edge: Math.abs(edge),
    impliedProb: implied,
    polyOdds: poly,
    betSize,
    confidence,
    timestamp: now,
    _rawEdge: edge,
    _dynMinEdge: dynMinEdge,
  };
}

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3001;
// Ordered WS failover list. Some hosts/regions connect to one endpoint but
// receive no ticks. Rotate automatically until one delivers real messages.
const BINANCE_WS_URLS = [
  'wss://data-stream.binance.vision/ws/btcusdt@aggTrade',
  'wss://data-stream.binance.vision:443/ws/btcusdt@aggTrade',
  'wss://data-stream.binance.vision:9443/ws/btcusdt@aggTrade',
  'wss://stream.binance.com:9443/ws/btcusdt@aggTrade',
  'wss://stream.binance.com:443/ws/btcusdt@aggTrade',
  'wss://stream.binance.us:9443/ws/btcusdt@trade',
  'wss://stream.binance.us:443/ws/btcusdt@trade',
];
const BINANCE_REST_URLS = [
  'https://data-api.binance.vision/api/v3',
  'https://api.binance.com/api/v3',
  'https://api.binance.us/api/v3',
];
const POLY_GAMMA     = 'https://gamma-api.polymarket.com';
const POLY_CLOB_WSS  = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const LAG_MS         = 2700;   // Polymarket average update lag
const WS_STALE_MS    = 7000;   // If no WS tick in this window, treat feed as stale
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
  volHistory:    [],      // { qty, isSell, time } for VPIN toxicity

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
    balance:       1000,
    startBalance:  1000,
    peakBalance:   1000,
    peakBalanceDay: 0,
    peakBalanceMonth: 0,
    pausedUntil:   0,
    pauseReason:   null,
    active:        false,
    trades:        [],
    lastTradeTs:   0,
    cooldownMs:    2000,   // CLOB-safe minimum cooldown shared by SIM and LIVE
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
  signalDiagnostics: {
    ts: null,
    marketId: null,
    question: null,
    side: null,
    implied: null,
    poly: null,
    edge: null,
    dynMinEdge: null,
    blockReason: 'INIT',
    blockers: [],
    confirmedSignals: 0,
    trendMatches: false,
    velOk: false,
    edgeOk: false,
    stableOk: false,
    canTrade: false,
    safeBalance: false,
    exposureOk: false,
    hasOpposite: false,
    vpin: 0,
    btcSpike: 0,
    isSpike: false,
  },
  binanceConnected: false,
  priceSource:      'binance',  // 'binance' | 'binance-rest' | 'unavailable'
  lastPriceChartTs: 0,
  candles:          [],   // closed 5s OHLCV candles ({ time (s), open, high, low, close, ticks })
  currentCandle:    null, // currently forming 5s candle
  polyLive: {
    marketId:     null,
    marketIds:    [],
    assetIds:     [],
    connected:    false,
    lastEventTs:  0,
    assetBooks:   {},
  },
};

// ── PRICE CHART SAMPLER ───────────────────────────────────────────────────────
function addChartPoint(price, time) {
  if (time - state.lastPriceChartTs >= 1000) {
    state.priceChart.push({ t: time, p: price });
    if (state.priceChart.length > 300) state.priceChart.shift();
    state.lastPriceChartTs = time;
  }
}

function seedMinimalChartState(price, now = Date.now(), priceSource = state.priceSource) {
  if (!price || !isFinite(price) || price <= 0) return;
  state.btcPrice = price;
  state.priceSource = priceSource;
  state.priceHistory = [{ time: now, price }];
  state.priceChart = [{ t: now, p: price }];
  state.lastPriceChartTs = now;
  state.candles = [];
  state.currentCandle = {
    time: candleBucketSec(now),
    open: price,
    high: price,
    low: price,
    close: price,
    ticks: 1,
    volume: 0,
  };
}

function parseClobTokenIds(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch (_) {
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function clampProb(value) {
  return Math.max(0.03, Math.min(0.97, value));
}

function setSignalDiagnostics(patch = {}) {
  state.signalDiagnostics = {
    ...state.signalDiagnostics,
    ...patch,
    ts: patch.ts ?? Date.now(),
  };
}

function getPolyAssetBook(assetId) {
  return state.polyLive.assetBooks[String(assetId)] || null;
}

function getPolyDisplayPrice(assetId) {
  const book = getPolyAssetBook(assetId);
  if (!book) return null;
  const bid = Number(book.bestBid);
  const ask = Number(book.bestAsk);
  const last = Number(book.lastTrade);
  const hasBidAsk = Number.isFinite(bid) && Number.isFinite(ask) && bid >= 0 && ask > 0 && ask >= bid;
  if (hasBidAsk) {
    const midpoint = (bid + ask) / 2;
    if (ask - bid > 0.10 && Number.isFinite(last)) return clampProb(last);
    return clampProb(midpoint);
  }
  if (Number.isFinite(last)) return clampProb(last);
  if (Number.isFinite(bid) && bid > 0) return clampProb(bid);
  if (Number.isFinite(ask) && ask > 0) return clampProb(ask);
  return null;
}

function getBestBookBid(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return NaN;
  const prices = levels.map(level => parseFloat(level?.price)).filter(Number.isFinite);
  return prices.length ? Math.max(...prices) : NaN;
}

function getBestBookAsk(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return NaN;
  const prices = levels.map(level => parseFloat(level?.price)).filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : NaN;
}

function applyPolyLivePrices() {
  for (const market of state.markets) {
    if (!market.live) continue;
    const assetIds = parseClobTokenIds(market.clobTokenIds).slice(0, 2);
    if (assetIds.length < 2) continue;
    const yesPrice = getPolyDisplayPrice(assetIds[0]);
    const noPrice = getPolyDisplayPrice(assetIds[1]);
    const resolvedYes = Number.isFinite(yesPrice)
      ? yesPrice
      : Number.isFinite(noPrice)
        ? 1 - noPrice
        : null;
    if (!Number.isFinite(resolvedYes)) continue;
    const roundedYes = Math.round(clampProb(resolvedYes) * 1000) / 1000;
    market.outcomePrices = [roundedYes, Math.round((1 - roundedYes) * 1000) / 1000];
    market.priceIsEstimated = false;
  }
}

function candleBucketSec(timestampMs) {
  return Math.floor(timestampMs / (CANDLE_SEC * 1000)) * CANDLE_SEC;
}

function pushOrMergeCandle(bucketMap, bucketSec, partial) {
  if (!bucketMap.has(bucketSec)) {
    bucketMap.set(bucketSec, {
      time: bucketSec,
      open: partial.open,
      high: partial.high,
      low: partial.low,
      close: partial.close,
      ticks: partial.ticks ?? 1,
      volume: partial.volume ?? 0,
    });
    return;
  }

  const candle = bucketMap.get(bucketSec);
  candle.high = Math.max(candle.high, partial.high);
  candle.low = Math.min(candle.low, partial.low);
  candle.close = partial.close;
  candle.ticks += partial.ticks ?? 1;
  candle.volume += partial.volume ?? 0;
}

function setCandlesFromBuckets(bucketMap) {
  const sorted = [...bucketMap.values()].sort((a, b) => a.time - b.time);
  state.candles = sorted.slice(0, -1);
  state.currentCandle = sorted[sorted.length - 1] || null;
}

function buildApproxCandlesFrom1mKlines(klines1m, cutoffMs) {
  const buckets = new Map();
  const recentKlines = klines1m.filter(k => Number(k[0]) >= cutoffMs);

  for (const k of recentKlines) {
    const openTs = Number(k[0]);
    const open = parseFloat(k[1]);
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const totalVolume = parseFloat(k[5]) || 0;
    const stepVolume = totalVolume / 12;

    for (let step = 0; step < 12; step++) {
      const chunkOpen = openTs + step * CANDLE_SEC * 1000;
      const progressStart = step / 12;
      const progressEnd = (step + 1) / 12;
      const chunkStart = open + (close - open) * progressStart;
      const chunkEnd = open + (close - open) * progressEnd;
      const bucketSec = candleBucketSec(chunkOpen);

      const chunkHigh = Math.max(chunkStart, chunkEnd, high);
      const chunkLow = Math.min(chunkStart, chunkEnd, low);
      pushOrMergeCandle(buckets, bucketSec, {
        open: chunkStart,
        high: chunkHigh,
        low: chunkLow,
        close: chunkEnd,
        ticks: CANDLE_SEC,
        volume: stepVolume,
      });
    }
  }

  setCandlesFromBuckets(buckets);
}

function buildRealCandlesFrom1sKlines(klines1s, cutoffMs) {
  const buckets = new Map();
  const recent = klines1s.filter(k => Number(k[0]) >= cutoffMs);

  for (const k of recent) {
    const openTs = Number(k[0]);
    const bucketSec = candleBucketSec(openTs);
    pushOrMergeCandle(buckets, bucketSec, {
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      ticks: 1,
      volume: parseFloat(k[5]) || 0,
    });
  }

  setCandlesFromBuckets(buckets);
}

// ── OHLCV CANDLE BUILDER ──────────────────────────────────────────────────────────
function updateCandle(price, now, volume = 0) {
  const bucket = candleBucketSec(now); // seconds
  const c = state.currentCandle;
  if (!c || c.time !== bucket) {
    if (c) {
      state.candles.push(c);
      if (state.candles.length > 600) state.candles.shift();
    }
    state.currentCandle = { time: bucket, open: price, high: price, low: price, close: price, ticks: 1, volume };
  } else {
    c.high  = Math.max(c.high, price);
    c.low   = Math.min(c.low,  price);
    c.close = price;
    c.ticks++;
    c.volume += volume;
  }
}

// ── ARBITRAGE TICK TRACKING ───────────────────────────────────────────────────
let lastArbCheckTs  = 0;
let lastBroadcastTs = 0;

// ── BINANCE WS FEED ───────────────────────────────────────────────────────────
let binanceTimer = null;
let lastWsMsgTs  = 0;   // last time we received a real price tick
let wsUrlIndex   = 0;

function isWsFresh() {
  return state.binanceConnected && (Date.now() - lastWsMsgTs <= WS_STALE_MS);
}

async function binanceRestGet(path, params = {}, timeout = 5000, preferredBase = null) {
  const orderedBases = preferredBase
    ? [preferredBase, ...BINANCE_REST_URLS.filter(b => b !== preferredBase)]
    : BINANCE_REST_URLS;
  let lastErr = null;
  for (const base of orderedBases) {
    try {
      const { data } = await axios.get(`${base}${path}`, { params, timeout });
      return { data, base };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Binance REST failed for ${path}`);
}

async function fetchFreshBinancePrice(preferredBase = null) {
  const cacheBust = Date.now();
  const attempts = [
    async () => {
      const { data, base } = await binanceRestGet(
        '/ticker/price',
        { symbol: 'BTCUSDT', _t: cacheBust },
        5000,
        preferredBase
      );
      return {
        price: parseFloat(data?.price),
        qty: 0,
        source: 'ticker-price',
        base,
      };
    },
    async () => {
      const { data, base } = await binanceRestGet(
        '/ticker/bookTicker',
        { symbol: 'BTCUSDT', _t: cacheBust },
        5000,
        preferredBase
      );
      const bid = parseFloat(data?.bidPrice);
      const ask = parseFloat(data?.askPrice);
      const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : NaN;
      return {
        price,
        qty: 0,
        source: 'book-ticker',
        base,
      };
    },
    async () => {
      const { data, base } = await binanceRestGet(
        '/trades',
        { symbol: 'BTCUSDT', limit: 1, _t: cacheBust },
        5000,
        preferredBase
      );
      const trade = Array.isArray(data) ? data[0] : null;
      return {
        price: parseFloat(trade?.price),
        qty: parseFloat(trade?.qty || 0),
        source: 'trades',
        base,
      };
    },
    async () => {
      const { data, base } = await binanceRestGet(
        '/aggTrades',
        { symbol: 'BTCUSDT', limit: 1, _t: cacheBust },
        5000,
        preferredBase
      );
      const trade = Array.isArray(data) ? data[0] : null;
      return {
        price: parseFloat(trade?.p),
        qty: parseFloat(trade?.q || 0),
        source: 'agg-trades',
        base,
      };
    },
    async () => {
      const { data, base } = await binanceRestGet(
        '/klines',
        { symbol: 'BTCUSDT', interval: '1s', limit: 1, _t: cacheBust },
        6000,
        preferredBase
      );
      const kline = Array.isArray(data) ? data[0] : null;
      return {
        price: parseFloat(kline?.[4]),
        qty: parseFloat(kline?.[5] || 0),
        source: '1s-kline',
        base,
      };
    },
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result.price && isFinite(result.price) && result.price > 1000) return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Fresh Binance REST price unavailable');
}

function connectBinance() {
  if (binanceTimer) { clearTimeout(binanceTimer); binanceTimer = null; }
  const wsUrl = BINANCE_WS_URLS[wsUrlIndex % BINANCE_WS_URLS.length];
  const ws = new WebSocket(wsUrl);
  let socketOpenedAt = 0;
  let sawRealTick = false;

  ws.on('open', () => {
    socketOpenedAt = Date.now();
    state.binanceConnected = false;
    // Only mark Binance as connected after the first real trade tick.
    console.log(`[Binance WS] Connected: ${wsUrl}`);
    broadcast({ type: 'CONNECTION', data: { binanceConnected: false, priceSource: state.priceSource } });
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const price = parseFloat(msg.p);
      if (!price || isNaN(price)) return;
      sawRealTick = true;
      lastWsMsgTs = Date.now();   // heartbeat
      state.binanceConnected = true;
      state.btcPrice = price;
      state.priceSource = 'binance';
      const now = Date.now();
      const qty = parseFloat(msg.q || 0);
      const isSell = msg.m === true;
      state.volHistory.push({ qty, isSell, time: now });
      state.volHistory = state.volHistory.filter(v => now - v.time <= 60000); // 60s window
      state.priceHistory.push({ price, time: now });
      state.priceHistory = state.priceHistory.filter(p => now - p.time <= PRICE_HIST_MS);
      addChartPoint(price, now);
      updateCandle(price, now, qty);
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

  ws.on('error', (err) => {
    console.error('[Binance WS] Error:', err.message);
    try { ws.terminate(); } catch (_) {}
  });

  // Heartbeat guard: if WS appears connected but no message arrives in 15s,
  // the Railway proxy silently dropped the connection — force reconnect.
  let heartbeatGuardFired = false;
  const heartbeatGuard = setInterval(() => {
    const noFirstTick = socketOpenedAt > 0 && !sawRealTick && Date.now() - socketOpenedAt > 10000;
    const staleAfterTick = sawRealTick && Date.now() - lastWsMsgTs > 15000;
    if (noFirstTick || staleAfterTick) {
      console.warn('[Binance WS] No message in 15s – forcing reconnect');
      state.binanceConnected = false;
      wsUrlIndex = (wsUrlIndex + 1) % BINANCE_WS_URLS.length;
      clearInterval(heartbeatGuard);
      heartbeatGuardFired = true;
      binanceTimer = setTimeout(connectBinance, 1000);
      try { ws.terminate(); } catch (_) {}
    }
  }, 5000);

  // Single close handler — prevents double-reconnect from duplicate listeners
  ws.on('close', () => {
    clearInterval(heartbeatGuard);
    state.binanceConnected = false;
    if (!heartbeatGuardFired) {
      broadcast({ type: 'CONNECTION', data: { binanceConnected: false, priceSource: 'binance-rest' } });
      console.log('[Binance WS] Disconnected – reconnecting in 4s');
      wsUrlIndex = (wsUrlIndex + 1) % BINANCE_WS_URLS.length;
      binanceTimer = setTimeout(connectBinance, 4000);
    }
  });
}

let polyMarketWs = null;
let polyMarketPingTimer = null;
let polyMarketReconnectTimer = null;

function getDesiredPolyLiveMarket() {
  const marketIds = [];
  const assetIds = [];
  const pushMarket = (market) => {
    if (!market || !market.live || marketIds.includes(market.id)) return;
    const ids = parseClobTokenIds(market.clobTokenIds).slice(0, 2);
    if (ids.length < 2) return;
    marketIds.push(market.id);
    for (const id of ids) {
      if (!assetIds.includes(id)) assetIds.push(id);
    }
  };

  for (const pos of state.positions.filter(p => p.status === 'OPEN')) {
    pushMarket(state.markets.find(m => m.id === pos.marketId));
  }
  pushMarket(getBestObservationMarket(true));
  pushMarket(getBestMarket());

  if (assetIds.length === 0) return null;
  return { marketId: marketIds[0], marketIds, assetIds };
}

function updatePolyAssetBook(assetId, patch) {
  const key = String(assetId);
  const current = state.polyLive.assetBooks[key] || {};
  state.polyLive.assetBooks[key] = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  state.polyLive.lastEventTs = Date.now();
  state.polyLive.connected = true;
}

function refreshPolyLiveMarket() {
  applyPolyLivePrices();
  if (state.trading.active && state.priceHistory.length >= 3) runArbitrageCheck();
  if (Date.now() - lastBroadcastTs >= 200) {
    lastBroadcastTs = Date.now();
    broadcastMarketData();
  }
}

function subscribePolyMarket(assetIds, operation = null) {
  if (!polyMarketWs || polyMarketWs.readyState !== WebSocket.OPEN || assetIds.length === 0) return;
  const payload = operation
    ? { operation, assets_ids: assetIds, custom_feature_enabled: true }
    : { type: 'market', assets_ids: assetIds, custom_feature_enabled: true };
  polyMarketWs.send(JSON.stringify(payload));
}

function clearPolyMarketPing() {
  if (polyMarketPingTimer) {
    clearInterval(polyMarketPingTimer);
    polyMarketPingTimer = null;
  }
}

function connectPolyMarketWs() {
  if (polyMarketWs && [WebSocket.OPEN, WebSocket.CONNECTING].includes(polyMarketWs.readyState)) return;
  const desired = getDesiredPolyLiveMarket();
  if (!desired) return;

  polyMarketWs = new WebSocket(POLY_CLOB_WSS);

  polyMarketWs.on('open', () => {
    state.polyLive.connected = false;
    state.polyLive.lastEventTs = 0;
    state.polyLive.marketId = desired.marketId;
    state.polyLive.marketIds = desired.marketIds;
    state.polyLive.assetIds = desired.assetIds;
    state.polyLive.assetBooks = {};
    subscribePolyMarket(desired.assetIds);
    clearPolyMarketPing();
    polyMarketPingTimer = setInterval(() => {
      if (polyMarketWs?.readyState === WebSocket.OPEN) polyMarketWs.send('PING');
    }, 10000);
    console.log(`[Polymarket CLOB] Subscribed markets=${desired.marketIds.join(',')} assets=${desired.assetIds.join(',')}`);
  });

  polyMarketWs.on('message', (raw) => {
    const text = raw.toString();
    if (text === 'PONG') return;
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) { return; }
    const messages = Array.isArray(payload) ? payload : [payload];
    let didUpdate = false;

    for (const msg of messages) {
      if (!msg || !msg.event_type) continue;

      if (msg.event_type === 'book') {
        updatePolyAssetBook(msg.asset_id, {
          bestBid: getBestBookBid(msg.bids),
          bestAsk: getBestBookAsk(msg.asks),
          lastTrade: parseFloat(msg.last_trade_price ?? NaN),
        });
        didUpdate = true;
        continue;
      }

      if (msg.event_type === 'best_bid_ask') {
        updatePolyAssetBook(msg.asset_id, {
          bestBid: parseFloat(msg.best_bid ?? NaN),
          bestAsk: parseFloat(msg.best_ask ?? NaN),
        });
        didUpdate = true;
        continue;
      }

      if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
        for (const change of msg.price_changes) {
          updatePolyAssetBook(change.asset_id, {
            bestBid: parseFloat(change.best_bid ?? NaN),
            bestAsk: parseFloat(change.best_ask ?? NaN),
            lastTrade: parseFloat(change.price ?? NaN),
          });
        }
        didUpdate = true;
        continue;
      }

      if (msg.event_type === 'last_trade_price') {
        updatePolyAssetBook(msg.asset_id, {
          lastTrade: parseFloat(msg.price ?? NaN),
        });
        didUpdate = true;
      }
    }

    if (didUpdate) refreshPolyLiveMarket();
  });

  polyMarketWs.on('close', () => {
    clearPolyMarketPing();
    state.polyLive.connected = false;
    polyMarketWs = null;
    if (polyMarketReconnectTimer) clearTimeout(polyMarketReconnectTimer);
    polyMarketReconnectTimer = setTimeout(connectPolyMarketWs, 3000);
  });

  polyMarketWs.on('error', (err) => {
    console.warn('[Polymarket CLOB] WS error:', err.message);
  });
}

function syncPolyMarketSubscription() {
  const desired = getDesiredPolyLiveMarket();
  if (!desired) {
    state.polyLive.marketId = null;
    state.polyLive.marketIds = [];
    state.polyLive.assetIds = [];
    if (polyMarketWs?.readyState === WebSocket.OPEN) {
      try { polyMarketWs.close(); } catch (_) {}
    }
    return;
  }

  const sameMarket = desired.marketId === state.polyLive.marketId;
  const sameMarkets = desired.marketIds.join(',') === state.polyLive.marketIds.join(',');
  const sameAssets = desired.assetIds.join(',') === state.polyLive.assetIds.join(',');

  if (!polyMarketWs || polyMarketWs.readyState === WebSocket.CLOSED) {
    connectPolyMarketWs();
    return;
  }

  if (polyMarketWs.readyState !== WebSocket.OPEN) return;
  if (sameMarket && sameMarkets && sameAssets) return;

  if (state.polyLive.assetIds.length > 0) subscribePolyMarket(state.polyLive.assetIds, 'unsubscribe');
  state.polyLive.marketId = desired.marketId;
  state.polyLive.marketIds = desired.marketIds;
  state.polyLive.assetIds = desired.assetIds;
  state.polyLive.assetBooks = {};
  subscribePolyMarket(desired.assetIds, 'subscribe');
  console.log(`[Polymarket CLOB] Switched markets=${desired.marketIds.join(',')}`);
}

// ── BINANCE REST FALLBACK (no API key required) ─────────────────────────────
async function pollBinanceRest() {
  // If WS is stale (connected but no ticks), keep price alive via REST/fallbacks.
  if (isWsFresh()) return;
  try {
    const fresh = await fetchFreshBinancePrice();
    const price = parseFloat(fresh.price);
    if (!price || isNaN(price)) return;
    state.btcPrice = price;
    const now = Date.now();
    state.priceHistory.push({ price, time: now });
    state.priceHistory = state.priceHistory.filter(p => now - p.time <= PRICE_HIST_MS);
    addChartPoint(price, now);
    updateCandle(price, now, fresh.qty || 0);
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
    state.priceSource = 'unavailable';
    console.warn('[Price] Binance WS + REST unavailable; keeping last confirmed Binance price');
  }
}

// ── BINANCE KLINES HISTORY (boot-time) ────────────────────────────────────────────────
// Seeds priceHistory from real Binance data only.
// Strategy: prefer 1s klines; if unavailable, use real 1m close points and
// approximate candles only for chart continuity (never synthetic priceHistory).
async function loadBinanceHistory() {
  let currentPrice = state.btcPrice;
  try {
    // Always fetch 1m klines + 24h ticker from the same Binance REST host.
    let klines1m = null;
    let ticker = null;
    let historyBase = null;
    let lastHistoryErr = null;
    for (const base of BINANCE_REST_URLS) {
      try {
        const [klinesRes, tickerRes] = await Promise.all([
          axios.get(`${base}/klines`, {
            params: { symbol: 'BTCUSDT', interval: '1m', limit: 300 },
            timeout: 12000,
          }),
          axios.get(`${base}/ticker/24hr`, {
            params: { symbol: 'BTCUSDT' }, timeout: 8000,
          }),
        ]);
        klines1m = klinesRes.data;
        ticker = tickerRes.data;
        historyBase = base;
        break;
      } catch (e) {
        lastHistoryErr = e;
      }
    }
    if (!historyBase) throw (lastHistoryErr || new Error('Binance history unavailable'));

    if (Array.isArray(klines1m) && klines1m.length > 0) {
      currentPrice = parseFloat(ticker?.lastPrice) || parseFloat(klines1m[klines1m.length - 1][4]);
      state.btcPrice     = currentPrice;
      state.btcChange24h = parseFloat(ticker.priceChangePercent) || 0;

      // Build priceChart (1 point per minute)
      state.priceChart = klines1m.map(k => ({ t: Number(k[0]), p: parseFloat(k[4]) }));
      state.lastPriceChartTs = state.priceChart[state.priceChart.length - 1]?.t || 0;

      // Keep only last 5 minutes (PRICE_HIST_MS)
      const cutoff = Date.now() - PRICE_HIST_MS;
      state.priceHistory = klines1m
        .map(k => ({ time: Number(k[0]), price: parseFloat(k[4]) }))
        .filter(p => p.time >= cutoff);

      // Fallback seed until we can fetch real 1s klines.
      buildApproxCandlesFrom1mKlines(klines1m, cutoff);

      console.log(`[Binance] History (${historyBase}): ${state.priceHistory.length} pts, ${state.candles.length} candles, price=$${currentPrice}`);
    }

    // Attempt to upgrade to real 1s klines (more precise, but may not be available)
    try {
      const { data: klines1s } = await binanceRestGet(
        '/klines',
        { symbol: 'BTCUSDT', interval: '1s', limit: 300 },
        8000,
        historyBase
      );
      if (Array.isArray(klines1s) && klines1s.length > 0) {
        const cutoff = Date.now() - PRICE_HIST_MS;
        state.priceHistory = klines1s
          .map(k => ({ time: Number(k[0]), price: parseFloat(k[4]) }))
          .filter(p => p.time >= cutoff);
        state.priceChart = klines1s
          .map(k => ({ t: Number(k[0]), p: parseFloat(k[4]) }))
          .filter(p => p.t >= cutoff);
        state.lastPriceChartTs = state.priceChart[state.priceChart.length - 1]?.t || state.lastPriceChartTs;
        buildRealCandlesFrom1sKlines(klines1s, cutoff);
        currentPrice = parseFloat(klines1s[klines1s.length - 1][4]) || currentPrice;
        state.btcPrice = currentPrice;
        console.log(`[Binance] Upgraded to ${klines1s.length} real 1s klines and rebuilt 5s candles`);
      }
    } catch (_) {
      console.log('[Binance] 1s klines unavailable — using interpolated 1m data');
    }

  } catch (e) {
    console.warn('[Binance] History load failed:', e.message);
    try {
      const { data } = await binanceRestGet('/ticker/price', { symbol: 'BTCUSDT' }, 5000);
      currentPrice       = parseFloat(data.price) || currentPrice;
      seedMinimalChartState(currentPrice, Date.now(), 'binance-rest');
      console.log(`[Binance] Emergency seed: price=$${currentPrice} (waiting for real ticks)`);
    } catch (_) {
      if (currentPrice && isFinite(currentPrice) && currentPrice > 0) {
        seedMinimalChartState(currentPrice, Date.now(), state.priceSource || 'bootstrap');
      }
    }
  }
}

// ── POLYMARKET MARKETS ────────────────────────────────────────────────────────
async function fetchBTCMarkets() {
  try {
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
        clobTokenIds: parseClobTokenIds(m.clobTokenIds || m.clob_token_ids || m.asset_ids || []),
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
    applyPolyLivePrices();
    const top = mapped[0];
    console.log(`[Polymarket] Loaded ${mapped.length} real BTC markets | top: "${top.question}" price=${top.outcomePrices[0]} vol=$${top.volume.toLocaleString()}`);
    broadcast({ type: 'MARKETS', data: state.markets });
    return;
  }

  // All fetches failed or no BTC markets found — fall back to sim markets
  seedSimMarkets();
  broadcast({ type: 'MARKETS', data: state.markets });
  } catch (err) {
    console.warn('[Polymarket] Market load failed:', err.message);
    seedSimMarkets();
    broadcast({ type: 'MARKETS', data: state.markets });
  }
}

function seedSimMarkets() {
  const btc = state.btcPrice || 0;
  const base = Math.round(btc / 10) * 10 || 50000;
  const strikes = [
    { id: 'sim-1', strike: base,       minutes: 5,  volume: 185000 },
    { id: 'sim-2', strike: base + 20,  minutes: 10, volume: 235000 },
    { id: 'sim-3', strike: base - 20,  minutes: 15, volume: 310000 },
    { id: 'sim-4', strike: base + 40,  minutes: 30, volume: 420000 },
  ];
  // Keep real (live) markets intact — only replace/refresh sim markets
  const liveMarkets = state.markets.filter(m => m.live);
  state.markets = [
    ...liveMarkets,
    ...strikes.map(({ id, strike, minutes, volume }) => ({
      id,
      question: `Will BTC be above $${strike.toLocaleString('en-US')} in ${minutes} min?`,
      outcomes: ['Yes', 'No'],
      outcomePrices: [0.5, 0.5],
      volume,
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + minutes * 60000).toISOString(),
      live: false,
    })),
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

function getMarketMinutesLeft(market, now = Date.now()) {
  if (!market?.endDate) return 10;
  return (new Date(market.endDate).getTime() - now) / 60000;
}

function getMarketYesPrice(market) {
  return market?.outcomePrices?.[0] ?? 0.5;
}

function getMarketPriceDistance(market) {
  return Math.abs(getMarketYesPrice(market) - 0.5);
}

function getSimStrike(market) {
  const strikeMatch = market?.question?.match(/\$([0-9,]+)/);
  return strikeMatch ? parseFloat(strikeMatch[1].replace(/,/g, '')) : null;
}

function hasUsableSimMarket(now = Date.now()) {
  return state.markets.some(m => {
    if (m.live) return false;
    const minutesLeft = getMarketMinutesLeft(m, now);
    const strike = getSimStrike(m);
    const strikeGap = strike && state.btcPrice ? Math.abs(strike - state.btcPrice) / state.btcPrice : 0;
    return (
      minutesLeft >= 2 &&
      minutesLeft <= 45 &&
      getMarketPriceDistance(m) <= 0.42 &&
      strikeGap <= 0.012
    );
  });
}

function pickBestSimMarket(now = Date.now()) {
  const sims = state.markets.filter(m => {
    if (m.live) return false;
    const minutesLeft = getMarketMinutesLeft(m, now);
    const strike = getSimStrike(m);
    const strikeGap = strike && state.btcPrice ? Math.abs(strike - state.btcPrice) / state.btcPrice : 0;
    return (
      minutesLeft >= 2 &&
      minutesLeft <= 45 &&
      getMarketPriceDistance(m) <= 0.42 &&
      strikeGap <= 0.02
    );
  });
  if (sims.length === 0) return null;
  return sims.sort((a, b) => {
    const aStrike = getSimStrike(a) ?? state.btcPrice;
    const bStrike = getSimStrike(b) ?? state.btcPrice;
    const aStrikeGap = Math.abs(aStrike - state.btcPrice);
    const bStrikeGap = Math.abs(bStrike - state.btcPrice);
    const aScore = getMarketPriceDistance(a) + aStrikeGap / Math.max(1, state.btcPrice) + getMarketMinutesLeft(a, now) / 1000;
    const bScore = getMarketPriceDistance(b) + bStrikeGap / Math.max(1, state.btcPrice) + getMarketMinutesLeft(b, now) / 1000;
    return aScore - bScore;
  })[0];
}

function hasTradableLiveMarket(now = Date.now()) {
  return state.markets.some(m => {
    if (!m.live || m.priceIsEstimated) return false;
    const minLeft = getMarketMinutesLeft(m, now);
    if (minLeft < 1 || minLeft > 1440) return false;
    return getMarketPriceDistance(m) <= 0.42;
  });
}

function getBestObservationMarket(preferLiveOnly = false) {
  if (state.markets.length === 0) return null;
  const now = Date.now();
  const scored = state.markets.map(m => {
    if (preferLiveOnly && !m.live) return { m, score: -1 };
    const minLeft = getMarketMinutesLeft(m, now);
    if (minLeft < 1 || minLeft > 1440) return { m, score: -1 };
    if (m.priceIsEstimated) return { m, score: -1 };
    const q = (m.question || '').toLowerCase();
    const isUpOrDown = /up or down/.test(q);
    const priceDist = getMarketPriceDistance(m);
    if (priceDist > 0.42) return { m, score: -1 };
    const timeScore = minLeft <= 15 ? 4 : minLeft <= 30 ? 3 : minLeft <= 60 ? 2 : 1;
    const volumeScore = m.volume >= 20000 ? 3 : m.volume >= 5000 ? 2 : m.volume > 0 ? 1 : 0;
    const priceScore = priceDist < 0.10 ? 3 : priceDist < 0.25 ? 2 : 1;
    return { m, score: timeScore + volumeScore + priceScore + (isUpOrDown ? 3 : 0) };
  }).filter(x => x.score >= 0).sort((a, b) => b.score - a.score || b.m.volume - a.m.volume);

  return scored[0]?.m || null;
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
function getBestMarket(preferLiveOnly = false) {
  if (state.markets.length === 0) return null;
  const now = Date.now();
  const liveAvailable = hasTradableLiveMarket(now);
  // "Up or Down" short-term binaries are created ~24h in advance — allow up to 24h window.
  // Other live markets: up to 24h in LIVE. SIM fallback should stay short-dated and near ATM.
  const maxMinutes = state.config.mode === 'SIM' ? 1440 : 1440;
  const minMinutes = 1;
  const scored = state.markets.map(m => {
    if (preferLiveOnly && !m.live) return { m, score: -1 };
    const minLeft = getMarketMinutesLeft(m, now);
    if (minLeft < minMinutes || minLeft > maxMinutes) return { m, score: -1 };
    // Block markets with no real price data — would generate false signals against 0.5
    if (m.priceIsEstimated) return { m, score: -1 };
    const isSim = !m.live;
    if (!preferLiveOnly && liveAvailable && isSim) return { m, score: -1 };
    // Prefer short-term (5–30 min window) for momentum arb.
    const timeScore = minLeft <= 15 ? 4 : minLeft <= 30 ? 3 : minLeft <= 60 ? 2 : minLeft <= 1440 ? 1 : 0;
    const volScore  = m.volume >= 100000 ? 2 : m.volume >= 20000 ? 1 : 0;
    // Filter out near-certain markets (YES > 0.92 or YES < 0.08).
    const yesPrice  = getMarketYesPrice(m);
    const priceDist = getMarketPriceDistance(m);
    if (priceDist > 0.42) return { m, score: -1 }; // YES > 0.92 or < 0.08 — exclude
    const q = (m.question || '').toLowerCase();
    const isUpOrDown = /up or down/.test(q);
    if (isSim && minLeft > 45) return { m, score: -1 };
    const strike = getSimStrike(m);
    const strikeGap = isSim && strike && state.btcPrice
      ? Math.abs(strike - state.btcPrice) / state.btcPrice
      : 0;
    if (isSim && strikeGap > 0.012) return { m, score: -1 };
    // Prefer markets nearer to 0.5 (more uncertainty = larger edge swings possible)
    const priceScore = priceDist < 0.10 ? 3 : priceDist < 0.25 ? 2 : priceDist < 0.40 ? 1 : 0;
    // Bonus score for Up or Down markets (these are the ideal arb target)
    const upOrDownBonus = isUpOrDown ? 2 : 0;
    const edgeBonus = Math.min(4, Math.abs(computeEdge(m).edge) / Math.max(0.005, state.config.minEdge / 2));
    return { m, score: timeScore + volScore + priceScore + upOrDownBonus + edgeBonus };
  }).filter(x => x.score >= 0).sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // No real markets qualify — use simulated markets in SIM mode so the engine can trade
    if (state.config.mode === 'SIM' && !preferLiveOnly) {
      if (!hasUsableSimMarket(now)) {
        seedSimMarkets();
      }
      return pickBestSimMarket(now) || state.markets.find(m => !m.live) || null;
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
  const realizedVol = Math.max(0.001, recentVolatility(60000) * Math.sqrt(3600));

  // Black-Scholes d2: ln(S/K) / (σ√T)
  // Positive when BTC is above strike, negative when below.
  const sigmaT = realizedVol * Math.sqrt(hoursLeft);
  const d1     = Math.log(btc / strike) / Math.max(0.001, sigmaT);

  // Logistic CDF ≈ normal CDF Φ(d2)
  return clampProb(1 / (1 + Math.exp(-d1)));
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
  const sMult     = streak < 0
    ? Math.max(0.2, Math.pow(0.80, Math.abs(streak)))       // -20% per loss
    : streak > 0
      ? Math.min(2.5, Math.pow(1.10, streak))               // +10% per win
      : 1.0;
  const vol       = recentVolatility(20000);
  const vMult     = vol > 0.003 ? 0.70 : vol > 0.0015 ? 0.85 : 1.0;
  const capped    = Math.min(scaled, maxBetPct / 100) * sMult * vMult;
  const raw       = Math.round(balance * capped * 100) / 100;
  return raw >= 2 ? raw : 0;
}

function computeVPIN() {
  const now = Date.now();
  let buyVol = 0, sellVol = 0;
  for (const v of state.volHistory) {
    if (now - v.time <= 60000) {
      if (v.isSell) sellVol += v.qty;
      else buyVol += v.qty;
    }
  }
  const totalVol = buyVol + sellVol;
  return totalVol === 0 ? 0 : Math.abs(buyVol - sellVol) / totalVol;
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
  // 4-layer loss limit check
  if (state.trading.pausedUntil > Date.now()) {
    state.currentSignal = null;
    setSignalDiagnostics({ blockReason: 'PAUSED_UNTIL', blockers: ['paused_until'] });
    return;
  }

  // ── Single getBestMarket() call per tick ─────────────────────────────────
  // CRITICAL: getBestMarket() must be called ONCE here. Calling it separately
  // inside computeImpliedProb() and computePolyOdds() can return different
  // markets on consecutive calls (scoring is time-dependent), making the edge
  // meaningless (difference between two unrelated markets' model prices).
  const market = getBestMarket();
  if (!market) {
    state.currentSignal = null;
    setSignalDiagnostics({ blockReason: 'NO_MARKET', blockers: ['no_market'] });
    return;
  }

  const signalCandidate = buildTradeSignal(market);
  if (!signalCandidate) {
    state.currentSignal = null;
    const { implied, poly, edge } = computeEdge(market);
    const volScale = Math.max(1.0, Math.min(1.5, recentVolatility(20000) / 0.0015));
    const dynMinEdgeFail = state.config.minEdge * volScale;
    setSignalDiagnostics({
      marketId: market.id,
      question: market.question,
      side: edge > 0 ? 'BUY_YES' : 'BUY_NO',
      implied,
      poly,
      edge,
      dynMinEdge: dynMinEdgeFail,
      edgeOk: Math.abs(edge) >= dynMinEdgeFail,
      blockReason: 'MIN_EDGE',
      blockers: ['min_edge'],
    });
    return broadcastSignal();
  }

  const implied = signalCandidate.impliedProb;
  const poly = signalCandidate.polyOdds;
  const edge = signalCandidate._rawEdge;
  const now = signalCandidate.timestamp;
  const dynMinEdge = signalCandidate._dynMinEdge;

  // Debug log every 10s
  if (now - (runArbitrageCheck._lastLog || 0) > 10000) {
    runArbitrageCheck._lastLog = now;
    console.log(`[ARB] implied=${implied.toFixed(4)} poly=${poly.toFixed(4)} edge=${(edge*100).toFixed(2)}¢ minEdge=${(dynMinEdge*100).toFixed(2)}¢ mkt="${market.question?.slice(0,28)}" active=${state.trading.active} autoTrade=${state.config.autoTrade}`);
  }

  // Always record edge history so the Binance-vs-Poly chart is always populated.
  // The stability window (hasStableEdge) filters by minEdge separately below.
  state.edgeHistory.push({ time: now, edge, implied, poly });
  if (state.edgeHistory.length > 80) state.edgeHistory.shift();

  state.currentSignal = {
    marketId:    signalCandidate.marketId,
    question:    signalCandidate.question,
    side:        signalCandidate.side,
    edge:        signalCandidate.edge,
    impliedProb: signalCandidate.impliedProb,
    polyOdds:    signalCandidate.polyOdds,
    betSize:     signalCandidate.betSize,
    confidence:  signalCandidate.confidence,
    timestamp:   signalCandidate.timestamp,
  };
  const side = signalCandidate.side;

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
      const altSignal = buildTradeSignal(tradeMarket, now);
      if (!altSignal) {
        state.currentSignal = null;
        return broadcastSignal();
      }
      state.currentSignal = {
        marketId: altSignal.marketId,
        question: altSignal.question,
        side: altSignal.side,
        edge: altSignal.edge,
        impliedProb: altSignal.impliedProb,
        polyOdds: altSignal.polyOdds,
        betSize: altSignal.betSize,
        confidence: altSignal.confidence,
        timestamp: altSignal.timestamp,
      };
    }
  }

  // Total exposure cap: never risk more than 40% of effective balance across all open positions
  // Use effective balance (cash + open costs) not just cash — otherwise the cap tightens every
  // time a position is opened, eventually blocking all new trades.
  const totalExposure = state.positions
    .filter(p => p.status === 'OPEN')
    .reduce((s, p) => s + (p.cost || 0), 0);
  const effectiveBal  = state.trading.balance + totalExposure;
  const exposureOk = totalExposure + state.currentSignal.betSize <= effectiveBal * 0.40;
  // Keep enough cash to cover the bet
  const safeBalance = state.trading.balance >= state.currentSignal.betSize;
  const diagnostics = { blockers: [], blockReason: null, vpin: 0 };

  // ── ENTRY QUALITY GUARDS (applied before auto-trade and signal display) ───────
  // Based on research: homerun, aulekator, gamma-trade-lab, MrFadiAi

  // 1. SETTLEMENT TIMING GUARD
  // In the final 3 minutes of a short-term binary (≤30 min), 60-90% of informed
  // volume arrives. Entering here is strongly adversely selected.
  const mktMsLeft  = tradeMarket.endDate ? new Date(tradeMarket.endDate).getTime() - now : Infinity;
  const isShortMkt = mktMsLeft <= 30 * 60000;
  if (isShortMkt && mktMsLeft < 3 * 60000) {
    state.currentSignal = null;
    diagnostics.blockers.push('settlement_window');
    diagnostics.blockReason = 'SETTLEMENT_WINDOW';
    setSignalDiagnostics(diagnostics);
    return broadcastSignal();
  }

  // 2. VPIN TOXICITY
  // VPIN = |buyVol-sellVol|/totalVol; se > 0.75 → pausar entradas
  const vpin = computeVPIN();
  diagnostics.vpin = vpin;
  if (vpin > 0.75) {
    state.currentSignal = null;
    diagnostics.blockers.push('vpin');
    diagnostics.blockReason = 'VPIN';
    setSignalDiagnostics(diagnostics);
    return broadcastSignal();
  }

  // 3. SPIKE DETECTION & MULTI-SIGNAL CONFIRMATION
  // Spike detection: se |BTC move em 3s| > 15bps (0.0015) → entrada DipArb imediata
  const btc3sAgo = getPriceAt(3000);
  const btcSpike = btc3sAgo > 0 ? Math.abs(state.btcPrice - btc3sAgo) / btc3sAgo : 0;
  const isSpike = btcSpike > 0.0015;

  // Multi-signal: exigir 2-de-3 sinais concordando
  const btc10sAgo   = getPriceAt(10000);
  const btcTrend10s = btc10sAgo > 0 ? (state.btcPrice - btc10sAgo) / btc10sAgo : 0;
  const trendMatches = side === 'BUY_YES' ? btcTrend10s > 0 : btcTrend10s < 0;
  const velOk = edgeVelocity() > 0.001;
  const edgeOk = Math.abs(edge) >= dynMinEdge;

  const confirmedSignals = [trendMatches, velOk, edgeOk].filter(Boolean).length;
  Object.assign(diagnostics, {
    marketId: state.currentSignal.marketId,
    question: state.currentSignal.question,
    side: state.currentSignal.side,
    implied,
    poly,
    edge,
    dynMinEdge,
    confirmedSignals,
    trendMatches,
    velOk,
    edgeOk,
    stableOk,
    canTrade,
    safeBalance,
    exposureOk,
    hasOpposite,
    vpin: diagnostics.vpin || 0,
    btcSpike,
    isSpike,
  });
  if (!canTrade) diagnostics.blockers.push('max_open_positions');
  if (!stableOk) diagnostics.blockers.push('stable_edge');
  if (!safeBalance) diagnostics.blockers.push('insufficient_balance');
  if (!exposureOk) diagnostics.blockers.push('exposure_limit');
  if (hasOpposite) diagnostics.blockers.push('opposite_position');
  
  if (confirmedSignals < 2 && !isSpike) {
    state.currentSignal = null;
    diagnostics.blockers.push('signal_confirmation');
    diagnostics.blockReason = 'SIGNAL_CONFIRMATION';
    setSignalDiagnostics(diagnostics);
    return broadcastSignal();
  }

  // 4. ADVERSE SELECTION COOLDOWN
  // If ≥3 of the last 5 closed trades were losses, pause new auto-entries for 60s.
  // Signals the bot may be in a toxic-flow regime. (gamma-trade-lab pattern)
  const last5 = state.trading.trades.slice(0, 5);
  if (last5.length >= 5) {
    const lossCount = last5.filter(t => t.outcome === 'LOSS').length;
    if (lossCount >= 3) {
      const lastLossTs = (last5.find(t => t.outcome === 'LOSS') || {}).timestamp || 0;
      if (now - lastLossTs < 60000) {
        // Emit signal so UI shows it, but block auto-execution until cooldown expires
        diagnostics.blockers.push('recent_losses');
        diagnostics.blockReason = 'RECENT_LOSSES';
        setSignalDiagnostics(diagnostics);
        broadcastSignal();
        return;
      }
    }
  }

  if (!state.config.autoTrade) diagnostics.blockers.push('auto_trade_disabled');
  if (state.currentSignal.betSize < 2) diagnostics.blockers.push('bet_too_small');
  const liveVolumeMin = 50000;
  const liveVolume = Number(tradeMarket?.volume || 0);
  const volumeOk = !tradeMarket.live || liveVolume >= liveVolumeMin;
  if (!volumeOk) diagnostics.blockers.push('market_volume');

  if (state.config.autoTrade && state.currentSignal.betSize >= 2 && canTrade && stableOk && safeBalance && !hasOpposite && exposureOk && volumeOk) {
    diagnostics.blockReason = 'READY';
    setSignalDiagnostics(diagnostics);
    executeTrade(state.currentSignal);
  } else {
    diagnostics.blockReason = diagnostics.blockers[0] ? diagnostics.blockers[0].toUpperCase() : 'READY_MANUAL';
    setSignalDiagnostics(diagnostics);
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

  const MIN_VOL = 50000;
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

  // Record the raw mid-price at entry time (before spread/impact) so that
  // monitorPositions marks against the same reference frame as the fill.
  // Without this, every trade starts with unrealizedPnl = -(spread+impact)*shares
  // which can immediately trigger SL.
  const yesAtEntry = market.outcomePrices?.[0] ?? 0.5;
  const midAtEntry = side === 'BUY_YES' ? yesAtEntry : (1 - yesAtEntry);

  const pos = {
    id:               nextId('p'),
    marketId,
    question:         (question || 'BTC Market').slice(0, 60),
    side,
    entryOdds:        fillOdds,
    entryMidOdds:     midAtEntry,  // raw mid at entry — used as mark baseline
    markOdds:         fillOdds,    // start mark at fill price (no instant loss)
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
  console.log(`[CLOB] OPEN ${side} ${shares}sh @ ${fillOdds.toFixed(3)} mid=${midAtEntry.toFixed(3)} | spread=${(fill.spread*100).toFixed(1)}¢ impact=${(fill.impact*100).toFixed(1)}¢ | $${fillSize}${fillNote} | edge ${(edge*100).toFixed(1)}¢`);
}

// ── SIM MARKET PRICE MODEL ───────────────────────────────────────────────────────────────
// Updates prices for sim (non-live) markets every 2s using a proper binary option model.
// Sim markets are repriced every 2s from the same binary option model used for
// live implied calculation. Real market metadata still refreshes from Gamma.
function updateSimMarketPrices() {
  if (!state.btcPrice || state.btcPrice <= 0) return;

  // Auto-refresh sim markets only when the ladder expired or drifted too far from spot.
  // Price skew alone is not enough reason to reset, otherwise the ladder keeps snapping
  // back to 0.50 and hides the true SIM edge.
  const nowMs = Date.now();
  const activeSims = state.markets.filter(m => !m.live && getMarketMinutesLeft(m, nowMs) > 1);
  const ladderTooFar = activeSims.length > 0 && activeSims.every(m => {
    const strike = getSimStrike(m);
    return strike && state.btcPrice
      ? Math.abs(strike - state.btcPrice) / state.btcPrice > 0.012
      : true;
  });
  if (activeSims.length === 0 || ladderTooFar) seedSimMarkets();
  if (state.markets.length === 0) return;

  for (const m of state.markets) {
    if (m.live) continue;
    if (!m.outcomePrices) m.outcomePrices = [0.5, 0.5];
    const rawProb = computeBinaryMid(m, state.btcPrice);
    const newYes = clampProb(rawProb);
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
  const exitSpread    = reason === 'MERGE' ? 0 : clobSpread(Number(market?.volume || 0));
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

  if (!state.trading.peakBalanceDay) state.trading.peakBalanceDay = state.trading.balance;
  if (!state.trading.peakBalanceMonth) state.trading.peakBalanceMonth = state.trading.balance;

  state.trading.peakBalanceDay = Math.max(state.trading.peakBalanceDay, state.trading.balance);
  state.trading.peakBalanceMonth = Math.max(state.trading.peakBalanceMonth, state.trading.balance);

  const dayDrawdown = (state.trading.peakBalanceDay - state.trading.balance) / state.trading.peakBalanceDay;
  const monthDrawdown = (state.trading.peakBalanceMonth - state.trading.balance) / state.trading.peakBalanceMonth;

  if (monthDrawdown > 0.15 && state.trading.pausedUntil <= Date.now()) {
    state.trading.pausedUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
    state.trading.pauseReason = '15% Monthly Drawdown';
    console.log('[Risk] Monthly drawdown limit reached. Paused for 30d.');
  } else if (dayDrawdown > 0.05 && state.trading.pausedUntil <= Date.now()) {
    state.trading.pausedUntil = Date.now() + 60 * 60 * 1000;
    state.trading.pauseReason = '5% Daily Drawdown';
    console.log('[Risk] Daily drawdown limit reached. Paused for 60m.');
  }

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

function getNetExitOdds(market, rawMarkOdds) {
  return Math.max(0.01, rawMarkOdds - clobSpread(Number(market?.volume || 0)));
}

function monitorPositions() {
  const open = state.positions.filter(p => p.status === 'OPEN');
  if (open.length === 0) return;

  // Position merging YES+NO — quando tiver os dois lados do mesmo mercado, merge para resgatar $1.00
  const byMarket = {};
  for (const p of open) {
    if (!byMarket[p.marketId]) byMarket[p.marketId] = [];
    byMarket[p.marketId].push(p);
  }
  for (const mId in byMarket) {
    const group = byMarket[mId];
    const yesPos = group.find(p => p.side === 'BUY_YES');
    const noPos = group.find(p => p.side === 'BUY_NO');
    if (yesPos && noPos) {
      console.log(`[MERGE] Merging YES and NO positions for market ${mId} to redeem $1.00 per pair`);
      closePosition(yesPos, 0.5, 'MERGE');
      closePosition(noPos, 0.5, 'MERGE');
      return; // Array modified, let next tick handle the rest
    }
  }

  for (const pos of open) {
    const mktForPos = state.markets.find(m => m.id === pos.marketId);
    if (!mktForPos) continue;

    const effectiveYesOdds = mktForPos.outcomePrices?.[0];
    const midOdds = pos.side === 'BUY_YES'
      ? effectiveYesOdds
      : (1 - effectiveYesOdds);
    const newMark = Math.max(0.03, Math.min(0.97, midOdds ?? pos.markOdds));
    const netExitOdds = getNetExitOdds(mktForPos, newMark);
    pos.markOdds   = newMark;

    // Execution cost should not immediately trip TP/SL. We compare the current
    // exitable mark against the exitable mark that existed at entry time:
    // entry MID minus the same exit spread. This keeps TP/SL tied to real market
    // movement while unrealized PnL still reflects true liquidation value.
    const entryMarkBaseline = getNetExitOdds(mktForPos, pos.entryMidOdds ?? pos.entryOdds);
    const triggerDelta = netExitOdds - entryMarkBaseline;
    pos.unrealizedPnl = Math.round((netExitOdds - pos.entryOdds) * pos.shares * 100) / 100;
    pos.pnlPct = pos.cost > 0
      ? Math.round((pos.unrealizedPnl / pos.cost) * 10000) / 100
      : 0;

    const gainPct  = triggerDelta / entryMarkBaseline; // positive = market moved in our favor
    const lossPct  = -triggerDelta / entryMarkBaseline; // positive = market moved against us
    const elapsed  = Date.now() - pos.entryTime;

    if (gainPct >= state.config.takeProfitPct / 100 && pos.unrealizedPnl > 0) {
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
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

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
  applyConfigPatch(req.body);
  const { mode, privateKey } = req.body;
  if (privateKey && mode === 'LIVE') {
    const clean = privateKey.replace(/^0x/, '');
    if (/^[0-9a-fA-F]{64}$/.test(clean)) {
      state.config.privateKey = '0x' + clean;
    } else {
      return res.status(400).json({ error: 'Invalid private key' });
    }
  }

  saveConfig();
  saveSession();
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

app.get('/api/debug/feed', (_req, res) => {
  res.json({
    btcPrice: state.btcPrice,
    btcChange24h: state.btcChange24h,
    priceSource: state.priceSource,
    binanceConnected: state.binanceConnected,
    priceHistoryPoints: state.priceHistory.length,
    priceChartPoints: state.priceChart.length,
    closedCandles: state.candles.length,
    currentCandle: state.currentCandle,
    markets: state.markets.length,
    liveMarkets: state.markets.filter(m => m.live).length,
    simMarkets: state.markets.filter(m => !m.live).length,
    bestMarket: getBestMarket()?.question || null,
    signalDiagnostics: state.signalDiagnostics,
    polyLiveMarketId: state.polyLive.marketId,
    polyLiveMarketIds: state.polyLive.marketIds,
    polyLiveAssetIds: state.polyLive.assetIds,
    polyLiveConnected: state.polyLive.connected,
    polyLiveLastEventTs: state.polyLive.lastEventTs,
    lastPricePoint: state.priceHistory[state.priceHistory.length - 1] || null,
    serverTime: Date.now(),
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
    applyConfigPatch(saved);
    saveConfig();
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
  seedSimMarkets();
  connectBinance();
  await fetchBTCMarkets();
  syncPolyMarketSubscription();
  // Refresh markets every 90s — ensures fresh Polymarket prices and valid expiry windows.
  // This natural polling lag (90s) mirrors Polymarket's real update cycle for both SIM and LIVE.
  setInterval(fetchBTCMarkets, 90 * 1000);
  setInterval(syncPolyMarketSubscription, 2000);
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
    state.trading.peakBalanceDay = state.trading.balance; // Reset daily peak limit
    broadcastStatus();
    setTimeout(resetDay, 86400000);
  }, msToMidnight);
});
