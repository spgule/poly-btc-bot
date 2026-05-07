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
      pausedUntil:  state.trading.pausedUntil,
      pauseReason:  state.trading.pauseReason,
      manualRearmRequired: state.trading.manualRearmRequired,
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
      if (s.pausedUntil  !== undefined) state.trading.pausedUntil  = s.pausedUntil;
      if (s.pauseReason  !== undefined) state.trading.pauseReason  = s.pauseReason;
      if (s.manualRearmRequired !== undefined) state.trading.manualRearmRequired = Boolean(s.manualRearmRequired);
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
      maxOpenPos:            state.config.maxOpenPos,
      requireStableEdge:     state.config.requireStableEdge,
      allowDuplicateMarkets: state.config.allowDuplicateMarkets,
      cooldownMs:            Math.max(2000, state.trading.cooldownMs),
      liveRiskEnabled:       state.config.liveRiskEnabled,
      liveDailyPauseDrawdownPct: state.config.liveDailyPauseDrawdownPct,
      liveDailyPauseMs:      state.config.liveDailyPauseMs,
      liveMonthlyPauseDrawdownPct: state.config.liveMonthlyPauseDrawdownPct,
      liveMonthlyPauseMs:    state.config.liveMonthlyPauseMs,
      livePauseLossStreak:   state.config.livePauseLossStreak,
      livePauseRequireStreak: state.config.livePauseRequireStreak,
      liveManualRearm:       state.config.liveManualRearm,
      orderType:             state.config.orderType,
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Config] Failed to save config:', e.message);
  }
}

function clearTradingPause() {
  state.trading.pausedUntil = 0;
  state.trading.pauseReason = null;
  state.trading.manualRearmRequired = false;
}

function armLiveRiskPause(reason, pauseMs) {
  const durationMs = Math.max(60000, Number(pauseMs) || 0);
  state.trading.pausedUntil = Date.now() + durationMs;
  state.trading.pauseReason = reason;
  state.trading.manualRearmRequired = Boolean(state.config.liveManualRearm);
}

function isTradingPaused(now = Date.now()) {
  return state.trading.manualRearmRequired || state.trading.pausedUntil > now;
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
    c.fixedAmount = Math.min(100000, Math.max(1, Number(patch.fixedAmount) || c.fixedAmount));
  }
  if (patch.maxBetPct !== undefined) c.maxBetPct = Math.min(50, Math.max(1, Number(patch.maxBetPct) || c.maxBetPct));
  if (patch.minEdge !== undefined) c.minEdge = Math.min(0.5, Math.max(0.01, Number(patch.minEdge) || c.minEdge));
  if (patch.killThreshold !== undefined) c.killThreshold = Math.min(100, Math.max(0, Number(patch.killThreshold) || 0));
  if (patch.autoTrade !== undefined) c.autoTrade = Boolean(patch.autoTrade);
  if (patch.takeProfitPct !== undefined) c.takeProfitPct = Math.min(100, Math.max(1, Number(patch.takeProfitPct) || c.takeProfitPct));
  if (patch.stopLossPct !== undefined) c.stopLossPct = Math.min(100, Math.max(1, Number(patch.stopLossPct) || c.stopLossPct));
  if (patch.maxOpenPos !== undefined) c.maxOpenPos = Math.min(20, Math.max(1, Number(patch.maxOpenPos) || c.maxOpenPos));
  if (patch.requireStableEdge !== undefined) c.requireStableEdge = Boolean(patch.requireStableEdge);
  if (patch.allowDuplicateMarkets !== undefined) c.allowDuplicateMarkets = Boolean(patch.allowDuplicateMarkets);
  if (patch.cooldownMs !== undefined) state.trading.cooldownMs = Math.min(60000, Math.max(2000, Number(patch.cooldownMs) || state.trading.cooldownMs));
  if (patch.liveRiskEnabled !== undefined) c.liveRiskEnabled = Boolean(patch.liveRiskEnabled);
  if (patch.liveDailyPauseDrawdownPct !== undefined) c.liveDailyPauseDrawdownPct = Math.min(50, Math.max(1, Number(patch.liveDailyPauseDrawdownPct) || c.liveDailyPauseDrawdownPct));
  if (patch.liveDailyPauseMs !== undefined) c.liveDailyPauseMs = Math.min(7 * 24 * 60 * 60 * 1000, Math.max(60000, Number(patch.liveDailyPauseMs) || c.liveDailyPauseMs));
  if (patch.liveMonthlyPauseDrawdownPct !== undefined) c.liveMonthlyPauseDrawdownPct = Math.min(80, Math.max(1, Number(patch.liveMonthlyPauseDrawdownPct) || c.liveMonthlyPauseDrawdownPct));
  if (patch.liveMonthlyPauseMs !== undefined) c.liveMonthlyPauseMs = Math.min(90 * 24 * 60 * 60 * 1000, Math.max(60000, Number(patch.liveMonthlyPauseMs) || c.liveMonthlyPauseMs));
  if (patch.livePauseLossStreak !== undefined) c.livePauseLossStreak = Math.min(10, Math.max(0, Number(patch.livePauseLossStreak) || 0));
  if (patch.livePauseRequireStreak !== undefined) c.livePauseRequireStreak = Boolean(patch.livePauseRequireStreak);
  if (patch.liveManualRearm !== undefined) c.liveManualRearm = Boolean(patch.liveManualRearm);
  if (patch.orderType !== undefined) c.orderType = ['TAKER', 'MAKER'].includes(patch.orderType) ? patch.orderType : c.orderType;
  if (patch.liveRiskEnabled !== undefined && !c.liveRiskEnabled) clearTradingPause();
  if (!c.liveManualRearm && state.trading.manualRearmRequired && state.trading.pausedUntil <= Date.now()) {
    state.trading.manualRearmRequired = false;
    state.trading.pauseReason = null;
  }
  if (c.mode === 'SIM') clearTradingPause();
}

function buildTradeSignal(market, now = Date.now()) {
  const context = buildSignalContext(market, now);
  if (!context) return null;
  const {
    implied, poly, edge, dynMinEdge, side,
    bollinger, bollingerBias, trendIndicators, trendBias, fib, fibBias,
  } = context;
  if (Math.abs(edge) < dynMinEdge) return null;

  // Cap edge at 15¢: in a real CLOB institutional arbitrageurs would eliminate
  // anything larger within seconds. Anything above 15¢ is a model artefact
  // (missing friction, stale poly price, or unrealistic vol estimate).
  const cappedEdge = Math.min(0.15, Math.abs(edge));

  const winProb    = edge > 0 ? implied : (1 - implied);
  const marketYes  = market.outcomePrices?.[0] ?? 0.5;
  const entryPrice = side === 'BUY_YES' ? marketYes : (1 - marketYes);
  // ── Kelly sizing base ────────────────────────────────────────────────────────
  const rawBetSize = state.config.entryMode === 'fixed'
    ? Math.min(state.config.fixedAmount, state.trading.balance)
    : kellySize(cappedEdge, winProb, entryPrice, state.trading.balance, state.config.maxBetPct);

  // ── Time-decay sizing (live markets only) ──────────────────────────────────────
  // For real live markets: reduce size in first 90s after opening (low liquidity).
  // For SIM markets: startDate is the NEXT 5-min UTC boundary (up to 5 min in the future)
  // so secsAlive would be negative → timeMult=0.65 → betSize<$1 → bet_too_small block.
  // SIM markets have constant synthetic volume — no liquidity ramp needed.
  let timeMult = 1.0;
  if (market.live) {
    const marketOpenTs = market.startDate ? new Date(market.startDate).getTime() : 0;
    const secsAlive    = marketOpenTs > 0 ? (Date.now() - marketOpenTs) / 1000 : 9999;
    timeMult = secsAlive < 60 ? 0.65 : secsAlive < 120 ? 0.80 : 1.0;
  }
  const betSize      = Math.round(rawBetSize * timeMult * 100) / 100;

  // ── Confidence score ──────────────────────────────────────────────────────────
  const velBonus      = edgeVelocity(market) > 0.003 ? 10 : 0;
  const qualBonus     = Math.round(edgeQuality(cappedEdge, market) * 20);
  const bollingerBonus = bollingerBias === 'favorable' ? 6 : bollingerBias === 'unfavorable' ? -8 : 0;
  const trendBonus    = trendBias === 'favorable' ? 6 : trendBias === 'unfavorable' ? -8 : 0;
  const fibBonus      = fibBias === 'favorable' ? 8 : fibBias === 'unfavorable' ? -10 : 0;
  const fibRoomBonus  = fib?.roomToTargetPct > 0.0025 ? 4 : fib?.roomToTargetPct > 0.0015 ? 2 : 0;

  // Flow imbalance bonus: pressão de compra/venda alinhada com direção do trade → +7
  // contra → -7. Usa Binance aggTrades (isSell flag), populado igual em SIM e LIVE.
  // Fonte: Polymarket-BTC-15-Minute-Trading-Bot order_book_imbalance_processor.py
  const imb = flowImbalance(market);
  const imbBonus = Math.abs(imb) >= 0.30
    ? ((side === 'BUY_YES' && imb > 0) || (side === 'BUY_NO' && imb < 0) ? 7 : -7)
    : 0;

  const confidence = Math.min(99, Math.max(1,
    50 + cappedEdge * 250 + velBonus + qualBonus + bollingerBonus + trendBonus + fibBonus + fibRoomBonus + imbBonus
  ));

  return {
    marketId: context.marketId,
    question: context.question,
    asset: getAssetKey(market),
    side,
    edge: cappedEdge,
    impliedProb: implied,
    polyOdds: poly,
    betSize,
    confidence,
    flowImbalance: Math.round(imb * 1000) / 1000,
    timeMult,
    timestamp: context.timestamp,
    bollinger,
    bollingerBias,
    trendIndicators,
    trendBias,
    fib,
    fibBias,
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
const POLY_WS_STALE_MS = 20000; // If no Polymarket book event arrives in this window, force reconnect
const SIM_PRICE_STEP = 0.01;   // SIM fallback markets trade in coarse 1¢ ticks, not continuous fair value
let _idSeq = 0; // Monotonic counter — prevents Date.now() collisions at SIM 10 Hz
const nextId = (prefix) => `${prefix}-${Date.now()}-${++_idSeq}`;
const PRICE_HIST_MS  = 300000; // 5 minutes of price history for charts
const POLY_FEE_RATE  = 0.02;   // Polymarket: 2% protocol fee on gross winnings (applied at settlement)
const CANDLE_SEC     = 5;      // 5-second OHLCV candles for TradingView-style chart

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  btcPrice:          0,
  btcPriceCoalesced: 0,   // 100ms VWAP — used for edge computation to smooth tick noise
  _coalesceWin:      { sumPQ: 0, sumQ: 0, start: 0 }, // accumulator for 100ms window
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
    maxOpenPos:    10,
    requireStableEdge: false,
    allowDuplicateMarkets: true,
    liveRiskEnabled: true,
    liveDailyPauseDrawdownPct: 5,
    liveDailyPauseMs: 60 * 60 * 1000,
    liveMonthlyPauseDrawdownPct: 15,
    liveMonthlyPauseMs: 30 * 24 * 60 * 60 * 1000,
    livePauseLossStreak: 0,
    livePauseRequireStreak: false,
    liveManualRearm: false,
    orderType: 'TAKER',   // 'TAKER' (market order, pays spread) | 'MAKER' (GTC limit, fills at mid, 0% spread)
  },

  trading: {
    balance:       1000,
    startBalance:  1000,
    peakBalance:   1000,
    peakBalanceDay: 0,
    peakBalanceMonth: 0,
    pausedUntil:   0,
    pauseReason:   null,
    manualRearmRequired: false,
    active:        false,
    trades:        [],
    lastTradeTs:   0,
    lastTradeTsByAsset: { BTC: 0, SOL: 0, ETH: 0 },
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
  assetSignals:     { BTC: null, SOL: null, ETH: null },
  signalDiagnostics: {
    ts: null,
    asset: 'BTC',
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
    bollinger: null,
    bollingerBias: 'neutral',
    trendIndicators: null,
    trendBias: 'neutral',
    fib: null,
    fibBias: 'neutral',
    pausedUntil: 0,
    pauseReason: null,
    manualRearmRequired: false,
    trendAgainst: false,
    flowAgainst: false,
    vetoCount: 0,
  },
  // ── SOL state (mirrors BTC state for multi-asset trading) ───────────────────
  solPrice:          0,
  solPriceCoalesced: 0,
  _solCoalesceWin:   { sumPQ: 0, sumQ: 0, start: 0 },
  solPriceHistory:   [],
  solVolHistory:     [],
  solCandles:        [],
  solCurrentCandle:  null,
  solConnected:      false,

  // ── ETH state (mirrors BTC state for multi-asset trading) ───────────────────
  ethPrice:          0,
  ethPriceCoalesced: 0,
  _ethCoalesceWin:   { sumPQ: 0, sumQ: 0, start: 0 },
  ethPriceHistory:   [],
  ethVolHistory:     [],
  ethCandles:        [],
  ethCurrentCandle:  null,
  ethConnected:      false,

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

// ── PER-ASSET ROUTING HELPERS ─────────────────────────────────────────────────
// Route price/history/candle reads to the correct asset based on market.asset.
// BTC is the default (backward-compatible).

function getAssetKey(market) {
  return (market?.asset || 'BTC').toUpperCase();
}

function getAssetPrice(market) {
  const a = getAssetKey(market);
  if (a === 'SOL') return state.solPrice > 0 ? state.solPrice : state.btcPrice;
  if (a === 'ETH') return state.ethPrice > 0 ? state.ethPrice : state.btcPrice;
  return state.btcPrice;
}

function getAssetPriceCoalesced(market) {
  const a = getAssetKey(market);
  if (a === 'SOL') return (state.solPriceCoalesced > 0 ? state.solPriceCoalesced : state.solPrice) || state.btcPriceCoalesced;
  if (a === 'ETH') return (state.ethPriceCoalesced > 0 ? state.ethPriceCoalesced : state.ethPrice) || state.btcPriceCoalesced;
  return state.btcPriceCoalesced > 0 ? state.btcPriceCoalesced : state.btcPrice;
}

function getAssetPriceHistory(market) {
  const a = getAssetKey(market);
  if (a === 'SOL') return state.solPriceHistory;
  if (a === 'ETH') return state.ethPriceHistory;
  return state.priceHistory;
}

function getAssetVolHistory(market) {
  const a = getAssetKey(market);
  if (a === 'SOL') return state.solVolHistory;
  if (a === 'ETH') return state.ethVolHistory;
  return state.volHistory;
}

function getAssetCandles(market) {
  const a = getAssetKey(market);
  if (a === 'SOL') return state.solCandles;
  if (a === 'ETH') return state.ethCandles;
  return state.candles;
}

function getAssetCurrentCandle(market) {
  const a = getAssetKey(market);
  if (a === 'SOL') return state.solCurrentCandle;
  if (a === 'ETH') return state.ethCurrentCandle;
  return state.currentCandle;
}

// Get the live price at a given msAgo for a given history array.
function getPriceAtFromHistory(history, msAgo, fallback = 0) {
  if (!history || history.length === 0) return fallback;
  const target = Date.now() - msAgo;
  let closest = history[0];
  let minDiff  = Math.abs(closest.time - target);
  for (const p of history) {
    const d = Math.abs(p.time - target);
    if (d < minDiff) { minDiff = d; closest = p; }
  }
  return closest.price;
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
    ts: null,
    asset: 'BTC',
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
    bollinger: null,
    bollingerBias: 'neutral',
    trendIndicators: null,
    trendBias: 'neutral',
    fib: null,
    fibBias: 'neutral',
    pausedUntil: 0,
    pauseReason: null,
    manualRearmRequired: false,
    trendAgainst: false,
    flowAgainst: false,
    vetoCount: 0,
    ...patch,
    ts: patch.ts ?? Date.now(),
  };
}

function getMarketById(marketId) {
  if (!marketId) return null;
  return state.markets.find(m => m.id === marketId) || null;
}

function recomputeCurrentSignal() {
  const ranked = Object.values(state.assetSignals)
    .filter(Boolean)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || Math.abs(b.edge || 0) - Math.abs(a.edge || 0));
  state.currentSignal = ranked[0] || null;
}

function setAssetSignal(asset, signal) {
  const key = String(asset || 'BTC').toUpperCase();
  if (!state.assetSignals[key]) state.assetSignals[key] = null;
  state.assetSignals[key] = signal;
  recomputeCurrentSignal();
}

function clearAssetSignal(asset) {
  const key = String(asset || 'BTC').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(state.assetSignals, key)) return;
  state.assetSignals[key] = null;
  recomputeCurrentSignal();
}

function getActiveSignalMarket() {
  return getMarketById(state.currentSignal?.marketId)
    || getMarketById(state.signalDiagnostics?.marketId)
    || getBestMarket();
}

function getPolyLiveAgeMs(now = Date.now()) {
  if (!state.polyLive.lastEventTs) return Infinity;
  return Math.max(0, now - state.polyLive.lastEventTs);
}

function isPolyLiveFresh(now = Date.now()) {
  return state.polyLive.connected && getPolyLiveAgeMs(now) <= POLY_WS_STALE_MS;
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
      // 100ms VWAP coalescing — accumulate tick volume into 100ms windows.
      // computeEdge() reads btcPriceCoalesced (VWAP) instead of raw last tick,
      // preventing single-tick spikes from triggering false signals.
      const w = state._coalesceWin;
      const tickW = Math.max(qty, 0.0001); // weight by trade size, floor to avoid div-by-zero
      if (now - w.start > 100) {
        // Commit completed window → coalesced price
        if (w.sumQ > 0) state.btcPriceCoalesced = Math.round((w.sumPQ / w.sumQ) * 100) / 100;
        w.sumPQ = price * tickW;
        w.sumQ  = tickW;
        w.start = now;
      } else {
        w.sumPQ += price * tickW;
        w.sumQ  += tickW;
      }
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

// ── ALT-ASSET BINANCE WS ──────────────────────────────────────────────────────
// Connects to Binance aggTrade stream for SOL or ETH.
// Updates state.sol*/state.eth* price, history, candles, and coalesce window.
const altWsTimers = {};
const altWsUrlIndex = {};

function connectAltAsset(symbol, assetKey) {
  const KEY = assetKey.toUpperCase(); // 'SOL' or 'ETH'
  const priceKey     = KEY === 'SOL' ? 'solPrice'     : 'ethPrice';
  const coalKey      = KEY === 'SOL' ? 'solPriceCoalesced' : 'ethPriceCoalesced';
  const coalWinKey   = KEY === 'SOL' ? '_solCoalesceWin' : '_ethCoalesceWin';
  const histKey      = KEY === 'SOL' ? 'solPriceHistory' : 'ethPriceHistory';
  const candlesKey   = KEY === 'SOL' ? 'solCandles'   : 'ethCandles';
  const curCandleKey = KEY === 'SOL' ? 'solCurrentCandle' : 'ethCurrentCandle';
  const connKey      = KEY === 'SOL' ? 'solConnected' : 'ethConnected';

  if (!altWsUrlIndex[KEY]) altWsUrlIndex[KEY] = 0;
  const wsUrl = `wss://data-stream.binance.vision/ws/${symbol.toLowerCase()}@aggTrade`;
  const ws = new WebSocket(wsUrl);
  let socketOpenedAt = 0;
  let sawRealTick = false;
  let lastWsMsg = 0;

  ws.on('open', () => {
    socketOpenedAt = Date.now();
    state[connKey] = false;
    console.log(`[Binance WS] ${KEY} connected: ${wsUrl}`);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const price = parseFloat(msg.p);
      if (!price || isNaN(price)) return;
      sawRealTick = true;
      lastWsMsg = Date.now();
      state[connKey] = true;
      state[priceKey] = price;
      const now = Date.now();
      const qty = parseFloat(msg.q || 0);

      // Price history (5-min window)
      state[histKey].push({ price, time: now });
      state[histKey] = state[histKey].filter(p => now - p.time <= PRICE_HIST_MS);
      const volHistKey = KEY === 'SOL' ? 'solVolHistory' : 'ethVolHistory';
      state[volHistKey].push({ qty, isSell, time: now });
      state[volHistKey] = state[volHistKey].filter(v => now - v.time <= 60000);

      // 5s OHLCV candles
      updateCandleForAsset(price, now, qty, candlesKey, curCandleKey);

      // 100ms VWAP coalescing
      const w = state[coalWinKey];
      const tickW = Math.max(qty, 0.0001);
      if (now - w.start > 100) {
        if (w.sumQ > 0) state[coalKey] = Math.round((w.sumPQ / w.sumQ) * 100) / 100;
        w.sumPQ = price * tickW;
        w.sumQ  = tickW;
        w.start = now;
      } else {
        w.sumPQ += price * tickW;
        w.sumQ  += tickW;
      }

      // Seed SIM markets for this asset on first price tick (deferred init)
      const hasSims = state.markets.some(m => !m.live && (m.asset || 'BTC').toUpperCase() === KEY);
      if (!hasSims) seedSimMarketsForAsset(KEY, price);

      // Trigger arb engine on alt ticks — same as BTC (100ms throttle)
      if (state.trading.active && now - lastArbCheckTs >= 100) {
        lastArbCheckTs = now;
        runArbitrageCheck();
      }
    } catch (e) { /* ignore */ }
  });

  ws.on('error', (err) => {
    console.error(`[Binance WS] ${KEY} error:`, err.message);
    try { ws.terminate(); } catch (_) {}
  });

  const hbGuard = setInterval(() => {
    const noFirst = socketOpenedAt > 0 && !sawRealTick && Date.now() - socketOpenedAt > 10000;
    const stale   = sawRealTick && Date.now() - lastWsMsg > 15000;
    if (noFirst || stale) {
      console.warn(`[Binance WS] ${KEY} stale — reconnecting`);
      state[connKey] = false;
      clearInterval(hbGuard);
      altWsTimers[KEY] = setTimeout(() => connectAltAsset(symbol, KEY), 1000);
      try { ws.terminate(); } catch (_) {}
    }
  }, 5000);

  ws.on('close', () => {
    clearInterval(hbGuard);
    state[connKey] = false;
    console.log(`[Binance WS] ${KEY} disconnected — reconnecting in 4s`);
    altWsTimers[KEY] = setTimeout(() => connectAltAsset(symbol, KEY), 4000);
  });
}

// Update a 5s OHLCV candle for a given asset using keyed state properties.
function updateCandleForAsset(price, now, qty, candlesKey, curCandleKey) {
  const CANDLE_MS = 5000;
  const candleTime = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  let cur = state[curCandleKey];
  if (!cur || cur.time !== candleTime) {
    if (cur) {
      state[candlesKey].push(cur);
      if (state[candlesKey].length > 300) state[candlesKey].shift();
    }
    state[curCandleKey] = {
      time: candleTime,
      open: price, high: price, low: price, close: price,
      volume: qty, ticks: 1,
    };
  } else {
    cur.high = Math.max(cur.high, price);
    cur.low  = Math.min(cur.low,  price);
    cur.close = price;
    cur.volume += qty;
    cur.ticks  += 1;
  }
}

// Fetch live Polymarket markets for SOL or ETH, tag with market.asset, merge into state.markets.
async function fetchAltMarkets(asset, keyword) {
  const KEY = asset.toUpperCase();
  // Build a regex that matches the asset ticker AND/OR full name.
  // Polymarket titles use "SOL", "ETH", "Solana", "Ethereum" interchangeably.
  const tickerRe = KEY === 'SOL'
    ? /\bsol\b|solana/i
    : /\beth\b|ethereum/i;
  try {
    const fetches = [
      axios.get(`${POLY_GAMMA}/markets`, {
        params: { active: true, closed: false, limit: 300, order: 'volume', ascending: false },
        timeout: 15000,
        headers: { 'User-Agent': 'poly-btc-bot/1.0' },
      }).catch(() => null),
      axios.get(`${POLY_GAMMA}/markets`, {
        params: { active: true, closed: false, limit: 200, order: 'startDate', ascending: false },
        timeout: 10000,
      }).catch(() => null),
    ];
    const responses = await Promise.all(fetches);

    const seen = new Set();
    const altRaw = [];
    for (const resp of responses) {
      if (!resp) continue;
      const arr = Array.isArray(resp.data) ? resp.data : (resp.data?.markets || resp.data?.results || []);
      for (const m of arr) {
        const q = (m.question || m.title || '').toLowerCase();
        // Must mention this asset, must NOT mention BTC/Bitcoin/bitcoin-cash
        if (!tickerRe.test(q)) continue;
        if (/btc|bitcoin/.test(q)) continue;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        altRaw.push(m);
      }
    }

    if (altRaw.length === 0) {
      console.log(`[Polymarket] No live ${KEY} markets found (keyword=${tickerRe}) — SIM only`);
      return;
    }

    // Map to internal format (same as fetchBTCMarkets mapMarket)
    const newAltMarkets = [];
    for (const m of altRaw) {
      try {
        const prices = Array.isArray(m.outcomePrices)
          ? m.outcomePrices.map(Number)
          : JSON.parse(m.outcomePrices || '[0.5,0.5]').map(Number);
        if (!prices.length || !Number.isFinite(prices[0])) continue;
        const vol = getMarketLiquidityValue(m);
        if (vol < 2000) continue; // allow newer alt markets that still report volume=0 but have live liquidity
        const endDate = m.endDate || m.gameStartTime;
        const startDate = m.startDate;
        if (!endDate) continue;
        const minutesLeft = (new Date(endDate).getTime() - Date.now()) / 60000;
        if (minutesLeft <= 0 || minutesLeft > 1440) continue;
        const yesPrice = Math.round(prices[0] * 10000) / 10000;
        const dist = Math.abs(yesPrice - 0.5);
        if (dist > 0.42) continue; // skip near-resolved markets
        newAltMarkets.push({
          id: m.id,
          question: m.question || m.title,
          outcomes: m.outcomes || ['Yes', 'No'],
          outcomePrices: [yesPrice, Math.round((1 - yesPrice) * 10000) / 10000],
          volume: vol,
          liquidity: Number(m.liquidity || 0),
          volume24hr: Number(m.volume24hr || m.volume_24hr || m.volume24hrClob || 0),
          startDate,
          endDate,
          live: true,
          asset: KEY,
          clobTokenIds: m.clobTokenIds,
          priceIsEstimated: false,
        });
      } catch (_) { continue; }
    }

    if (newAltMarkets.length === 0) {
      console.log(`[Polymarket] ${KEY}: found ${altRaw.length} raw but none passed filters — SIM only`);
      return;
    }

    // Merge: remove old live alt markets for this asset, add new ones
    state.markets = [
      ...state.markets.filter(m => !(m.live && (m.asset || 'BTC').toUpperCase() === KEY)),
      ...newAltMarkets,
    ];
    console.log(`[Polymarket] ${KEY} live markets loaded: ${newAltMarkets.length} (from ${altRaw.length} raw)`);
  } catch (err) {
    console.error(`[Polymarket] fetchAltMarkets(${KEY}) error:`, err.message);
  }
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
  for (const asset of ['BTC', 'SOL', 'ETH']) {
    pushMarket(getBestMarket(true, asset));
    for (const obsMarket of getObservationMarkets(2, true, asset)) {
      pushMarket(obsMarket);
    }
  }
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
  const polyAge = getPolyLiveAgeMs();
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
  if (state.polyLive.lastEventTs > 0 && polyAge > POLY_WS_STALE_MS) {
    console.warn(`[Polymarket CLOB] Feed stale for ${Math.round(polyAge / 1000)}s — reconnecting`);
    state.polyLive.connected = false;
    try { polyMarketWs.close(); } catch (_) {}
    return;
  }
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
        asset: 'BTC',
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
    // Also preserve live SOL/ETH markets fetched by fetchAltMarkets
    const existingAlt = state.markets.filter(m => m.live && m.asset && m.asset !== 'BTC');
    state.markets = [...mapped, ...existingAlt, ...existingSim];
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
  // Generate SIM markets with the EXACT same format as real Polymarket "Up or Down"
  // markets: question = "Bitcoin Up or Down - May 4, 8:00PM-8:15PM ET", no fixed $
  // strike in question. Strike = BTC price at window open (stored in _strikeSnapshot),
  // identical to how computeBinaryMid handles real live markets.
  const nowMs  = Date.now();
  const btcNow = state.btcPrice || 50000;

  // Align window start to the next 5-min UTC boundary (mirrors ET clock alignment).
  const FIVE_MIN = 5 * 60000;
  const alignedStartMs = Math.ceil(nowMs / FIVE_MIN) * FIVE_MIN;

  // Format timestamp as "H:MMAM/PM" in ET. Robust fallback in case ICU data is
  // incomplete on the runtime (e.g. Railway Node slim builds without full-icu).
  function fmtET(ms) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: '2-digit', hour12: true,
      }).formatToParts(new Date(ms));
      const hour      = (parts.find(p => p.type === 'hour') || {}).value || '0';
      const minute    = (parts.find(p => p.type === 'minute') || {}).value || '00';
      const dayPeriod = ((parts.find(p => p.type === 'dayPeriod') || {}).value || '').toUpperCase();
      // Some ICU builds embed AM/PM inside the hour value (e.g. "7 PM") — strip and re-add.
      const hourClean = hour.replace(/\s?(AM|PM)$/i, '');
      const meridiem  = dayPeriod || (/PM/i.test(hour) ? 'PM' : 'AM');
      return `${hourClean}:${minute}${meridiem}`;
    } catch (_) {
      // Last-resort: manual UTC-4/UTC-5 offset (ET, no DST handling needed for correctness)
      const d = new Date(ms);
      const etOffset = -5; // EST; close enough for market label purposes
      const etHour = (d.getUTCHours() + 24 + etOffset) % 24;
      const meridiem = etHour >= 12 ? 'PM' : 'AM';
      const h = etHour % 12 || 12;
      const m = String(d.getUTCMinutes()).padStart(2, '0');
      return `${h}:${m}${meridiem}`;
    }
  }

  // Date label in ET: "May 4" — fallback to UTC if timezone data unavailable.
  let dateLabel;
  try {
    dateLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
    }).format(new Date(alignedStartMs));
  } catch (_) {
    const d = new Date(alignedStartMs);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dateLabel = `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  // One market per duration — same set of window sizes real Polymarket publishes.
  // Volumes calibrated to real Polymarket BTC binary market range (~$50k–$80k).
  const slots = [
    { id: 'sim-1', minutes: 5,  volume: 80000 },
    { id: 'sim-2', minutes: 10, volume: 70000 },
    { id: 'sim-3', minutes: 15, volume: 75000 },
    { id: 'sim-4', minutes: 20, volume: 65000 },
    { id: 'sim-5', minutes: 25, volume: 57000 },
    { id: 'sim-6', minutes: 30, volume: 52000 },
  ];

  // Strike = current BTC price at seed time (window open price).
  // With the lagged-poly design, edge = computeBinaryMid(btcNow) - computeBinaryMid(btcLagged90s).
  // Strike represents the price at the start of the market window — exactly how real
  // Polymarket "Up or Down" markets work. Edge builds naturally as BTC moves over 90s.
  // No need to use 5-min-old strike to create artificial immediate edge.
  const simStrike = btcNow;

  const liveMarkets = state.markets.filter(m => m.live);
  state.markets = [
    ...liveMarkets,
    ...slots.map(({ id, minutes, volume }) => {
      const windowStart = alignedStartMs;
      const endMs       = alignedStartMs + minutes * 60000;
      const startDate   = new Date(windowStart).toISOString();
      const endDate     = new Date(endMs).toISOString();
      const question    = `Bitcoin Up or Down - ${dateLabel}, ${fmtET(windowStart)}-${fmtET(endMs)} ET`;
      // Initial poly = computeBinaryMid with current BTC (0.5 when strike = btcNow).
      // updateSimMarketPrices() will update to btcLagged90s every 2s.
      return {
        id,
        question,
        outcomes: ['Yes', 'No'],
        outcomePrices: [0.5, 0.5],
        volume,
        startDate,
        endDate,
        live: false,
        asset: 'BTC',
        _strikeSnapshot: simStrike,
      };
    }),
  ];
  console.log(`[Polymarket] Sim markets seeded — Up/Down format, ${slots.length} markets, window start ${fmtET(alignedStartMs)} ET`);
}

// Seed SIM markets for SOL or ETH — identical structure to BTC but uses asset name/price.
function seedSimMarketsForAsset(asset, assetPrice) {
  if (!asset || !assetPrice || assetPrice <= 0) return;
  const assetUpper = asset.toUpperCase();
  const assetLabel = assetUpper === 'SOL' ? 'Solana' : assetUpper === 'ETH' ? 'Ethereum' : assetUpper;

  // Remove any existing SIM markets for this asset (but keep BTC and other assets)
  state.markets = state.markets.filter(m => {
    if (m.live) return true;
    const mAsset = (m.asset || 'BTC').toUpperCase();
    return mAsset !== assetUpper;
  });

  const nowMs = Date.now();
  const FIVE_MIN = 5 * 60000;
  const alignedStartMs = Math.ceil(nowMs / FIVE_MIN) * FIVE_MIN;

  function fmtET(ms) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric', minute: '2-digit', hour12: true,
      }).formatToParts(new Date(ms));
      const hour      = (parts.find(p => p.type === 'hour') || {}).value || '0';
      const minute    = (parts.find(p => p.type === 'minute') || {}).value || '00';
      const dayPeriod = ((parts.find(p => p.type === 'dayPeriod') || {}).value || '').toUpperCase();
      const hourClean = hour.replace(/\s?(AM|PM)$/i, '');
      const meridiem  = dayPeriod || (/PM/i.test(hour) ? 'PM' : 'AM');
      return `${hourClean}:${minute}${meridiem}`;
    } catch (_) {
      const d = new Date(ms);
      const etOffset = -5;
      const etHour = (d.getUTCHours() + 24 + etOffset) % 24;
      const meridiem = etHour >= 12 ? 'PM' : 'AM';
      const h = etHour % 12 || 12;
      const m = String(d.getUTCMinutes()).padStart(2, '0');
      return `${h}:${m}${meridiem}`;
    }
  }

  let dateLabel;
  try {
    dateLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
    }).format(new Date(alignedStartMs));
  } catch (_) {
    const d = new Date(alignedStartMs);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dateLabel = `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  const slots = [
    { id: `sim-${assetUpper.toLowerCase()}-1`, minutes: 5,  volume: 60000 },
    { id: `sim-${assetUpper.toLowerCase()}-2`, minutes: 10, volume: 55000 },
    { id: `sim-${assetUpper.toLowerCase()}-3`, minutes: 15, volume: 60000 },
    { id: `sim-${assetUpper.toLowerCase()}-4`, minutes: 20, volume: 52000 },
    { id: `sim-${assetUpper.toLowerCase()}-5`, minutes: 25, volume: 50000 },
    { id: `sim-${assetUpper.toLowerCase()}-6`, minutes: 30, volume: 50000 },
  ];

  const simStrike = assetPrice;
  const newMarkets = slots.map(({ id, minutes, volume }) => {
    const endMs    = alignedStartMs + minutes * 60000;
    const startDate = new Date(alignedStartMs).toISOString();
    const endDate   = new Date(endMs).toISOString();
    const question  = `${assetLabel} Up or Down - ${dateLabel}, ${fmtET(alignedStartMs)}-${fmtET(endMs)} ET`;
    return {
      id,
      question,
      outcomes: ['Yes', 'No'],
      outcomePrices: [0.5, 0.5],
      volume,
      startDate,
      endDate,
      live: false,
      asset: assetUpper,
      _strikeSnapshot: simStrike,
    };
  });

  state.markets = [...state.markets, ...newMarkets];
  console.log(`[Polymarket] ${assetUpper} sim markets seeded — ${slots.length} markets @ $${assetPrice.toFixed(2)}`);
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

function getPriceAtForMarket(market, msAgo) {
  const history = getAssetPriceHistory(market);
  return getPriceAtFromHistory(history, msAgo, getAssetPrice(market));
}

function getMarketMinutesLeft(market, now = Date.now()) {
  if (!market?.endDate) return 10;
  return (new Date(market.endDate).getTime() - now) / 60000;
}

function getMarketDurationMinutes(market) {
  // IMPORTANT: try question text FIRST — real Polymarket "Up or Down" markets are
  // created ~24 hours before their resolution window, so (endDate - startDate) gives
  // ~1440 min instead of the real 5–30 min window. The actual window is always
  // embedded in the question: "7:30PM-7:45PM ET" = 15 min window.
  const rangeMatch = market?.question?.match(/(\d{1,2}):(\d{2})(AM|PM)-(\d{1,2}):(\d{2})(AM|PM)/i);
  if (rangeMatch) {
    const toMinutes = (hourRaw, minuteRaw, meridiemRaw) => {
      let hour = Number(hourRaw) % 12;
      const minute = Number(minuteRaw);
      const meridiem = String(meridiemRaw).toUpperCase();
      if (meridiem === 'PM') hour += 12;
      return hour * 60 + minute;
    };
    const startMin = toMinutes(rangeMatch[1], rangeMatch[2], rangeMatch[3]);
    const endMin = toMinutes(rangeMatch[4], rangeMatch[5], rangeMatch[6]);
    const duration = endMin >= startMin ? endMin - startMin : (24 * 60 - startMin) + endMin;
    if (duration > 0 && duration <= 30.5) return duration;
  }
  // SIM market question: "Will BTC be above $X in 15 min?"
  const simMatch = market?.question?.match(/in\s+(\d+)\s+min/i);
  if (simMatch) return Number(simMatch[1]);
  // Fallback: use startDate/endDate (correct for SIM markets and point-in-time live markets)
  const start = market?.startDate ? new Date(market.startDate).getTime() : NaN;
  const end = market?.endDate ? new Date(market.endDate).getTime() : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return (end - start) / 60000;
  }
  return NaN;
}

function isValidTradingMarket(market) {
  const duration = getMarketDurationMinutes(market);
  if (!Number.isFinite(duration) || duration < 4.5 || duration > 30.5) return false;
  // Volume 24h filter (fontes: kalshi-deep-trading-bot, poly-market-maker)
  // Gamma API retorna volume_24hr em mercados reais. SIM markets não têm esse campo
  // → Number(undefined) = 0 → skip check. Requer pelo menos $500 de volume recente.
  const vol24h = Number(market.volume_24hr || market.volume24hr || 0);
  if (vol24h > 0 && vol24h < 500) return false;
  return true;
}

function isShortObservationMarket(market) {
  const duration = getMarketDurationMinutes(market);
  if (!Number.isFinite(duration)) return false;
  return duration >= 4.5 && duration <= 20.5;
}

function getMarketYesPrice(market) {
  return market?.outcomePrices?.[0] ?? 0.5;
}

function getMarketPriceDistance(market) {
  return Math.abs(getMarketYesPrice(market) - 0.5);
}

function getMarketLiquidityValue(market) {
  const candidates = [
    market?.volume,
    market?.volumeNum,
    market?.volume_24hr,
    market?.volume24hr,
    market?.volume24hrClob,
    market?.volumeClob,
    market?.liquidity,
    market?.liquidityNum,
    market?.usdcSize,
  ]
    .map(v => Number(v))
    .filter(v => Number.isFinite(v) && v > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

function getMarketMinVolume(market) {
  const asset = getAssetKey(market);
  if (asset === 'SOL' || asset === 'ETH') return 2000;
  return 50000;
}

function getSimStrike(market) {
  const strikeMatch = market?.question?.match(/\$([0-9,]+)/);
  return strikeMatch ? parseFloat(strikeMatch[1].replace(/,/g, '')) : null;
}

function hasUsableSimMarket(now = Date.now(), assetFilter = null) {
  return state.markets.some(m => {
    if (m.live) return false;
    if (assetFilter && getAssetKey(m) !== String(assetFilter).toUpperCase()) return false;
    if (!isValidTradingMarket(m)) return false;
    const minutesLeft = getMarketMinutesLeft(m, now);
    const assetPrice = getAssetPrice(m);
    const strike = getSimStrike(m);
    const strikeGap = strike && assetPrice ? Math.abs(strike - assetPrice) / assetPrice : 0;
    return (
      minutesLeft >= 2 &&
      minutesLeft <= 30.5 &&
      getMarketPriceDistance(m) <= 0.42 &&
      strikeGap <= 0.020
    );
  });
}

function pickBestSimMarket(now = Date.now(), assetFilter = null) {
  const sims = state.markets.filter(m => {
    if (m.live) return false;
    if (assetFilter && getAssetKey(m) !== String(assetFilter).toUpperCase()) return false;
    if (!isValidTradingMarket(m)) return false;
    const minutesLeft = getMarketMinutesLeft(m, now);
    const assetPrice = getAssetPrice(m);
    const strike = getSimStrike(m);
    const strikeGap = strike && assetPrice ? Math.abs(strike - assetPrice) / assetPrice : 0;
    return (
      minutesLeft >= 2 &&
      minutesLeft <= 30.5 &&
      getMarketPriceDistance(m) <= 0.42 &&
      strikeGap <= 0.02
    );
  });
  if (sims.length === 0) return null;
  return sims.sort((a, b) => {
    const aAssetPrice = getAssetPrice(a);
    const bAssetPrice = getAssetPrice(b);
    const aStrike = getSimStrike(a) ?? aAssetPrice;
    const bStrike = getSimStrike(b) ?? bAssetPrice;
    const aStrikeGap = Math.abs(aStrike - aAssetPrice);
    const bStrikeGap = Math.abs(bStrike - bAssetPrice);
    // Prefer shorter-duration markets (same priority as getBestMarket timeScore)
    const aDuration = getMarketDurationMinutes(a);
    const bDuration = getMarketDurationMinutes(b);
    const aTimeScore = aDuration <= 5.5 ? 4 : aDuration <= 10.5 ? 3 : aDuration <= 20.5 ? 2 : 1;
    const bTimeScore = bDuration <= 5.5 ? 4 : bDuration <= 10.5 ? 3 : bDuration <= 20.5 ? 2 : 1;
    if (bTimeScore !== aTimeScore) return bTimeScore - aTimeScore;
    const aScore = getMarketPriceDistance(a) + aStrikeGap / Math.max(1, aAssetPrice) + getMarketMinutesLeft(a, now) / 1000;
    const bScore = getMarketPriceDistance(b) + bStrikeGap / Math.max(1, bAssetPrice) + getMarketMinutesLeft(b, now) / 1000;
    return aScore - bScore;
  })[0];
}

function hasTradableLiveMarket(now = Date.now()) {
  return state.markets.some(m => {
    if (!m.live || m.priceIsEstimated) return false;
    if (!isValidTradingMarket(m)) return false;
    const minLeft = getMarketMinutesLeft(m, now);
    // Only count markets that are currently active (< 30.5 min left) — not future windows.
    // A market 400 min away is not "available" for trading right now and should not
    // block SIM fallback.
    if (minLeft < 1 || minLeft > 30.5) return false;
      if (getMarketLiquidityValue(m) < getMarketMinVolume(m)) return false;
    return getMarketPriceDistance(m) <= 0.42;
  });
}

function getBestObservationMarket(preferLiveOnly = false) {
  if (state.markets.length === 0) return null;
  const now = Date.now();
  const scored = state.markets.map(m => {
    if (preferLiveOnly && !m.live) return { m, score: -1 };
    if (!isShortObservationMarket(m)) return { m, score: -1 };
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

function getObservationMarkets(limit = 3, preferLiveOnly = false, assetFilter = null) {
  if (state.markets.length === 0) return [];
  const now = Date.now();
  return state.markets
    .map(m => {
      if (assetFilter && getAssetKey(m) !== String(assetFilter).toUpperCase()) return { m, score: -1 };
      if (preferLiveOnly && !m.live) return { m, score: -1 };
      if (!isShortObservationMarket(m)) return { m, score: -1 };
      const minLeft = getMarketMinutesLeft(m, now);
      if (minLeft < 1 || minLeft > 1440) return { m, score: -1 };
      if (m.priceIsEstimated) return { m, score: -1 };
      const q = (m.question || '').toLowerCase();
      const isUpOrDown = /up or down/.test(q);
      const priceDist = getMarketPriceDistance(m);
      if (priceDist > 0.42) return { m, score: -1 };
      const duration = getMarketDurationMinutes(m);
      const durationScore = duration <= 5.5 ? 5 : duration <= 10.5 ? 4 : duration <= 15.5 ? 3 : 2;
      const volumeScore = m.volume >= 20000 ? 3 : m.volume >= 5000 ? 2 : m.volume > 0 ? 1 : 0;
      const priceScore = priceDist < 0.10 ? 3 : priceDist < 0.25 ? 2 : 1;
      return { m, score: durationScore + volumeScore + priceScore + (isUpOrDown ? 3 : 0) };
    })
    .filter(x => x.score >= 0)
    .sort((a, b) => b.score - a.score || b.m.volume - a.m.volume)
    .slice(0, Math.max(1, limit))
    .map(x => x.m);
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
function recentVolatilityFromHistory(history, msWindow = 30000) {
  const now = Date.now();
  const pts  = (history || state.priceHistory).filter(p => now - p.time <= msWindow);
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

function recentVolatility(msWindow = 30000) {
  return recentVolatilityFromHistory(state.priceHistory, msWindow);
}

function computeBollinger(period = 20, mult = 2, candlesArg = null, currentCandleArg = undefined) {
  const candlesSrc = candlesArg ?? state.candles;
  const currentSrc = currentCandleArg !== undefined ? currentCandleArg : state.currentCandle;
  const closed = candlesSrc.slice(-Math.max(0, period - 1)).map(c => Number(c.close)).filter(Number.isFinite);
  const currentClose = Number(currentSrc?.close);
  const closes = Number.isFinite(currentClose) ? [...closed, currentClose] : closed;
  if (closes.length < period) return null;

  const window = closes.slice(-period);
  const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
  const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length;
  const stdDev = Math.sqrt(variance) || 0;
  const upper = mean + stdDev * mult;
  const lower = mean - stdDev * mult;
  const last = window[window.length - 1];
  const bandwidth = mean !== 0 ? (upper - lower) / mean : 0;
  const percentB = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  const zScore = stdDev > 0 ? (last - mean) / stdDev : 0;
  const squeeze = bandwidth < 0.0015;

  return {
    period,
    mult,
    middle: mean,
    upper,
    lower,
    last,
    bandwidth,
    percentB,
    zScore,
    squeeze,
  };
}

function getBollingerBias(side, bollinger) {
  if (!bollinger) return 'neutral';
  if (side === 'BUY_YES') {
    if (bollinger.percentB <= 0.35 || bollinger.zScore <= -0.5) return 'favorable';
    if (bollinger.percentB >= 0.9 || bollinger.zScore >= 1.5) return 'unfavorable';
    return 'neutral';
  }
  if (side === 'BUY_NO') {
    if (bollinger.percentB >= 0.65 || bollinger.zScore >= 0.5) return 'favorable';
    if (bollinger.percentB <= 0.1 || bollinger.zScore <= -1.5) return 'unfavorable';
    return 'neutral';
  }
  return 'neutral';
}

function getChartIndicatorRows(limit = 300, candlesArg = null, currentCandleArg = undefined) {
  const candlesSrc = candlesArg ?? state.candles;
  const currentSrc = currentCandleArg !== undefined ? currentCandleArg : state.currentCandle;
  const candles = currentSrc
    ? [...candlesSrc.slice(-limit), currentSrc]
    : candlesSrc.slice(-limit);
  return candles
    .filter(Boolean)
    .map((candle) => {
      const open = Number(candle.open);
      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);
      const volume = Number(candle.volume);
      return {
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : Math.max(1, Number(candle.ticks) || 1),
      };
    })
    .filter(row => [row.open, row.high, row.low, row.close].every(Number.isFinite));
}

function computeChartTrendIndicators(candlesArg = null, currentCandleArg = undefined) {
  const rows = getChartIndicatorRows(300, candlesArg, currentCandleArg);
  if (rows.length < 21) return null;

  const calcEmaValue = (period) => {
    const alpha = 2 / (period + 1);
    let ema = rows[0].close;
    for (let i = 1; i < rows.length; i++) {
      ema = ((rows[i].close - ema) * alpha) + ema;
    }
    return ema;
  };

  let cumulativePV = 0;
  let cumulativeVol = 0;
  for (const row of rows) {
    const typical = (row.high + row.low + row.close) / 3;
    const volume = row.volume > 0 ? row.volume : 1;
    cumulativePV += typical * volume;
    cumulativeVol += volume;
  }

  const lastClose = rows[rows.length - 1].close;
  return {
    lastClose,
    ema9: calcEmaValue(9),
    ema21: calcEmaValue(21),
    vwap: cumulativeVol > 0 ? cumulativePV / cumulativeVol : lastClose,
  };
}

function getTrendIndicatorBias(side, indicators) {
  if (!indicators) return 'neutral';
  let score = 0;
  const { lastClose, ema9, ema21, vwap } = indicators;
  if (side === 'BUY_YES') {
    score += lastClose >= vwap ? 1 : -1;
    score += ema9 >= ema21 ? 1 : -1;
    score += lastClose >= ema9 ? 1 : -1;
  } else {
    score += lastClose <= vwap ? 1 : -1;
    score += ema9 <= ema21 ? 1 : -1;
    score += lastClose <= ema9 ? 1 : -1;
  }
  if (score >= 2) return 'favorable';
  if (score <= -2) return 'unfavorable';
  return 'neutral';
}

function computeFibContext(side, lookback = 80, candlesArg = null, currentCandleArg = undefined) {
  const rows = getChartIndicatorRows(lookback, candlesArg, currentCandleArg);
  if (rows.length < 24) return null;

  const current = rows[rows.length - 1]?.close;
  if (!Number.isFinite(current) || current <= 0) return null;

  let start = side === 'BUY_YES'
    ? { idx: 0, price: rows[0].low }
    : { idx: 0, price: rows[0].high };
  let best = null;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (side === 'BUY_YES') {
      if (row.low < start.price) start = { idx: i, price: row.low };
      const impulsePct = start.price > 0 ? (row.high - start.price) / start.price : 0;
      if (!best || impulsePct > best.impulsePct) {
        best = {
          direction: 'up',
          startIdx: start.idx,
          endIdx: i,
          low: start.price,
          high: row.high,
          impulsePct,
        };
      }
    } else {
      if (row.high > start.price) start = { idx: i, price: row.high };
      const impulsePct = start.price > 0 ? (start.price - row.low) / start.price : 0;
      if (!best || impulsePct > best.impulsePct) {
        best = {
          direction: 'down',
          startIdx: start.idx,
          endIdx: i,
          high: start.price,
          low: row.low,
          impulsePct,
        };
      }
    }
  }

  if (!best || best.endIdx <= best.startIdx) return null;
  const range = Math.max(1, best.high - best.low);
  const rangePct = range / current;
  if (!Number.isFinite(rangePct) || rangePct < 0.0015) return null;

  if (side === 'BUY_YES') {
    const retracement = (best.high - current) / range;
    const extension = 1 + Math.max(0, current - best.high) / range;
    const target1272 = best.high + range * 0.272;
    const target1618 = best.high + range * 0.618;
    const roomToTargetPct = (target1272 - current) / current;
    const inGoldenPocket = retracement >= 0.382 && retracement <= 0.618;
    const healthyPullback = retracement >= 0.236 && retracement <= 0.786;
    const exhausted = extension >= 1.272;
    const failed = retracement > 0.786;
    const bias = failed || exhausted ? 'unfavorable'
      : inGoldenPocket ? 'favorable'
      : healthyPullback || (retracement >= -0.05 && roomToTargetPct > 0.0015) ? 'neutral'
      : 'unfavorable';
    return {
      ...best,
      current,
      range,
      rangePct,
      retracement,
      extension,
      target1272,
      target1618,
      roomToTargetPct,
      inGoldenPocket,
      healthyPullback,
      exhausted,
      failed,
      bias,
    };
  }

  const retracement = (current - best.low) / range;
  const extension = 1 + Math.max(0, best.low - current) / range;
  const target1272 = best.low - range * 0.272;
  const target1618 = best.low - range * 0.618;
  const roomToTargetPct = (current - target1272) / current;
  const inGoldenPocket = retracement >= 0.382 && retracement <= 0.618;
  const healthyPullback = retracement >= 0.236 && retracement <= 0.786;
  const exhausted = extension >= 1.272;
  const failed = retracement > 0.786;
  const bias = failed || exhausted ? 'unfavorable'
    : inGoldenPocket ? 'favorable'
    : healthyPullback || (retracement >= -0.05 && roomToTargetPct > 0.0015) ? 'neutral'
    : 'unfavorable';
  return {
    ...best,
    current,
    range,
    rangePct,
    retracement,
    extension,
    target1272,
    target1618,
    roomToTargetPct,
    inGoldenPocket,
    healthyPullback,
    exhausted,
    failed,
    bias,
  };
}

function getMarketMinEdge(market, volScale = 1) {
  const base = Math.max(0.0015, Number(state.config.minEdge) || 0.02);
  const durationMin = getMarketDurationMinutes(market);
  const shortWindowBias = durationMin <= 5.5 ? 0.70
    : durationMin <= 10.5 ? 0.82
    : durationMin <= 20.5 ? 0.92
    : 1.0;
  if (!market?.live && state.config.mode === 'SIM') {
    // SIM fallback prices are refreshed every 2s in discrete ticks, so a live-grade
    // 2¢ threshold suppresses almost every opportunity. Keep SIM strict, but scaled
    // to the coarser/staler simulated tape.
    const simBase = Math.min(base, 0.0035);
    const scaled = simBase * Math.min(1.08, volScale) * shortWindowBias;
    return Math.max(0.002, Math.min(0.0035, scaled));
  }
  if (market?.live && state.config.mode === 'SIM') {
    // In SIM mode, live market prices are polled every 30s. A realistic BTC move
    // between polls is 0.05-0.3%, generating edge of 0.2-0.8% on a 5-30 min binary.
    // Cap live dynMinEdge to 0.4% so entries fire when Gamma lag creates meaningful
    // mispricing — previously 0.8% blocked most opportunities outside spike moments.
    const liveBase = Math.min(base * 0.35, 0.0035);
    const scaled = liveBase * Math.min(1.15, volScale) * shortWindowBias;
    return Math.max(0.0025, Math.min(0.0035, scaled));
  }
  return base * volScale;
}

function buildSignalContext(market, now = Date.now()) {
  if (!market) return null;
  const { implied, poly, edge } = computeEdge(market);
  const assetHistory = getAssetPriceHistory(market);
  const assetCandles = getAssetCandles(market);
  const assetCurrentCandle = getAssetCurrentCandle(market);
  const volScale = Math.max(1.0, Math.min(1.5, recentVolatilityFromHistory(assetHistory, 20000) / 0.0015));
  const dynMinEdge = getMarketMinEdge(market, volScale);
  const side = edge > 0 ? 'BUY_YES' : 'BUY_NO';
  const bollinger = computeBollinger(20, 2, assetCandles, assetCurrentCandle);
  const bollingerBias = getBollingerBias(side, bollinger);
  const trendIndicators = computeChartTrendIndicators(assetCandles, assetCurrentCandle);
  const trendBias = getTrendIndicatorBias(side, trendIndicators);
  const fib = computeFibContext(side, 80, assetCandles, assetCurrentCandle);
  const fibBias = fib?.bias || 'neutral';
  return {
    marketId: market.id,
    question: market.question,
    implied,
    poly,
    edge,
    volScale,
    dynMinEdge,
    side,
    bollinger,
    bollingerBias,
    trendIndicators,
    trendBias,
    fib,
    fibBias,
    timestamp: now,
  };
}

// Edge velocity: is the edge currently OPENING (positive) or CLOSING (negative)?
// Only enter when edge is expanding — avoids chasing edges that already peaked.
// Uses relative window (last half vs first half of recent history) so it works
// correctly at both 10 Hz (WS) and 0.5 Hz (REST fallback) tick rates.
function edgeVelocity(market = null) {
  const asset = getAssetKey(market);
  const h = state.edgeHistory.filter(e => (e.asset || 'BTC') === asset);
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
function edgeQuality(edge, market = null) {
  const asset = getAssetKey(market);
  const h = state.edgeHistory.filter(e => (e.asset || 'BTC') === asset);
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
function getBestMarket(preferLiveOnly = false, assetFilter = null) {
  if (state.markets.length === 0) return null;
  const now = Date.now();
  const liveAvailable = hasTradableLiveMarket(now);
  const targetAsset = assetFilter ? String(assetFilter).toUpperCase() : null;
  // Strategy lock: trade BTC markets of 5–30 minutes. Prefer shorter durations.
  const maxMinutes = 30.5;
  const minMinutes = 1;
  const scored = state.markets.map(m => {
    if (targetAsset && getAssetKey(m) !== targetAsset) return { m, score: -1 };
    if (preferLiveOnly && !m.live) return { m, score: -1 };
    if (!isValidTradingMarket(m)) return { m, score: -1 };
    const minLeft = getMarketMinutesLeft(m, now);
    if (minLeft < minMinutes || minLeft > maxMinutes) return { m, score: -1 };
    // Block markets with no real price data — would generate false signals against 0.5
    if (m.priceIsEstimated) return { m, score: -1 };
    const isSim = !m.live;
    // Do NOT hard-exclude SIM when live markets exist — live dynMinEdge = 2% (minEdge),
    // which requires a BTC spike to trade. In calm markets BTC rarely moves 2% in 90s,
    // so live-only mode would block the bot indefinitely. Let scoring decide:
    // live markets score +3 bonus (liveBonus) so they naturally win when both have edge.
    // SIM markets fill in when live edge is insufficient.
    // Prefer shorter-duration markets — they resolve faster and edge is more predictable.
    const totalDuration = getMarketDurationMinutes(m);
    const timeScore = totalDuration <= 5.5 ? 4 : totalDuration <= 10.5 ? 3 : totalDuration <= 20.5 ? 2 : 1;
    const volScore  = m.volume >= 100000 ? 2 : m.volume >= 20000 ? 1 : 0;
    const liveBonus = (!isSim && liveAvailable) ? 3 : 0;
    // Filter out near-certain markets (YES > 0.92 or YES < 0.08).
    const yesPrice  = getMarketYesPrice(m);
    const priceDist = getMarketPriceDistance(m);
    if (priceDist > 0.42) return { m, score: -1 }; // YES > 0.92 or < 0.08 — exclude
    const q = (m.question || '').toLowerCase();
    const isUpOrDown = /up or down/.test(q);
    if (m.live && getMarketLiquidityValue(m) < getMarketMinVolume(m)) return { m, score: -1 };
    if (isSim && minLeft > maxMinutes) return { m, score: -1 };
    const assetCurrentPrice = getAssetPrice(m);
    const strike = getSimStrike(m);
    const strikeGap = isSim && strike && assetCurrentPrice
      ? Math.abs(strike - assetCurrentPrice) / assetCurrentPrice
      : 0;
    // Dead zone fix: match reseed threshold (2%) — previously 1.2% excluded sim markets
    // before updateSimMarketPrices() reseeded them (at 2%), leaving a 0.8% gap with no
    // tradeable markets. Now both thresholds align at 2%.
    if (isSim && strikeGap > 0.020) return { m, score: -1 };
    // Prefer markets nearer to 0.5 (more uncertainty = larger edge swings possible)
    const priceScore = priceDist < 0.10 ? 3 : priceDist < 0.25 ? 2 : priceDist < 0.40 ? 1 : 0;
    // Bonus score for Up or Down markets (these are the ideal arb target)
    const upOrDownBonus = isUpOrDown ? 2 : 0;
    const edgeBonus = Math.min(4, Math.abs(computeEdge(m).edge) / Math.max(0.005, state.config.minEdge / 2));
    return { m, score: timeScore + volScore + priceScore + upOrDownBonus + liveBonus + edgeBonus };
  }).filter(x => x.score >= 0).sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // No real markets qualify — use simulated markets in SIM mode so the engine can trade
    if (state.config.mode === 'SIM' && !preferLiveOnly) {
      if (!hasUsableSimMarket(now, targetAsset)) {
        if (targetAsset === 'SOL') seedSimMarketsForAsset('SOL', state.solPrice || state.btcPrice);
        else if (targetAsset === 'ETH') seedSimMarketsForAsset('ETH', state.ethPrice || state.btcPrice);
        else seedSimMarkets();
      }
      return pickBestSimMarket(now, targetAsset) || state.markets.find(m => !m.live && (!targetAsset || getAssetKey(m) === targetAsset)) || null;
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
function computeBinaryMid(market, priceOverride) {
  const assetPrice = priceOverride ?? getAssetPrice(market);
  const btc = assetPrice;
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
    const assetHist = getAssetPriceHistory(market);
    if (windowOpenMs > 0 && windowOpenMs <= nowMs) {
      // Window is open — use snapshotted strike if available (more accurate than
      // getPriceAt which is limited to 5-min history depth)
      strike = market._strikeSnapshot
        || getPriceAtFromHistory(assetHist, nowMs - windowOpenMs, 0) || 0
        || assetHist[0]?.price
        || btc;
    } else {
      strike = market._strikeSnapshot || btc;
    }
  }

  const now       = Date.now();
  const msLeft    = market.endDate ? new Date(market.endDate).getTime() - now : 15 * 60000;
  const hoursLeft = Math.max(1 / 3600, msLeft / 3600000); // min 1 second

  // Realized vol (1-min window) scaled to per-hour — use asset-specific history
  const assetHistory = getAssetPriceHistory(market);
  const realizedVol = Math.max(0.001, recentVolatilityFromHistory(assetHistory, 60000) * Math.sqrt(3600));

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
  // Use 100ms VWAP for edge signal — smooths single-tick outliers without losing latency.
  const priceForEdge = getAssetPriceCoalesced(market);
  const implied = computeBinaryMid(market, priceForEdge); // fair value from VWAP-smoothed price
  const poly    = market.outcomePrices?.[0] ?? 0.5;     // real market price (Gamma API or sim)
  return { implied, poly, edge: implied - poly };
}

// Legacy wrappers used by broadcastMarketData — always consistent because
// they call computeEdge with the same single getBestMarket() result.
function computeImpliedProb() {
  const market = getActiveSignalMarket();
  return computeEdge(market).implied;
}
function computePolyOdds() {
  const market = getActiveSignalMarket();
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
  // Minimum $1 floor: if Kelly is positive (real edge exists) and balance allows,
  // never let sMult/vMult shrink the bet below $1. A losing streak reduces SIZE,
  // not the ability to trade — blocking entirely after 3 losses was causing 30+ min
  // silences. The streak multiplier floor (0.2) already caps the max damage.
  if (raw < 1 && fullKelly > 0 && balance >= 3) return 1;
  return raw >= 1 ? raw : 0;
}

function computeVPIN(market = null) {
  const now = Date.now();
  const volHistory = getAssetVolHistory(market);
  let buyVol = 0, sellVol = 0;
  for (const v of volHistory) {
    if (now - v.time <= 60000) {
      if (v.isSell) sellVol += v.qty;
      else buyVol += v.qty;
    }
  }
  const totalVol = buyVol + sellVol;
  return totalVol === 0 ? 0 : Math.abs(buyVol - sellVol) / totalVol;
}

// ── FLOW IMBALANCE (direcional, janela 30s) ──────────────────────────────────
// Diferente do VPIN (que é imbalance absoluto / toxicidade), este retorna
// um score -1 a +1: positivo = pressão de compra, negativo = pressão de venda.
// Usa o mesmo state.volHistory (Binance aggTrades, isSell flag), populado
// identicamente em SIM e LIVE.
// Fonte: Polymarket-BTC-15-Minute-Trading-Bot / order_book_imbalance_processor.py
function flowImbalance(market = null) {
  const now = Date.now();
  const volHistory = getAssetVolHistory(market);
  let buyVol = 0, sellVol = 0;
  for (const v of volHistory) {
    if (now - v.time <= 30000) {  // janela 30s — mais responsiva que VPIN (60s)
      if (v.isSell) sellVol += v.qty;
      else          buyVol  += v.qty;
    }
  }
  const total = buyVol + sellVol;
  return total === 0 ? 0 : (buyVol - sellVol) / total;  // -1 a +1
}

function isGoodEntry(edge, market = null) {
  const vel   = edgeVelocity(market);
  const qual  = edgeQuality(edge, market);
  // Fast path: very strong edge + quality → enter immediately
  if (Math.abs(edge) >= state.config.minEdge * 2.0 && qual >= 0.65) return true;
  const now     = Date.now();
  const asset = getAssetKey(market);
  const recent  = state.edgeHistory.filter(e =>
    (e.asset || 'BTC') === asset &&
    now - e.time <= 1200 &&
    Math.abs(e.edge) >= state.config.minEdge * 0.5
  );
  const bullish = edge > 0;
  const sameDir = recent.length > 0 && recent.every(e => (e.edge > 0) === bullish);
  // Enter when edge is opening or holding (vel >= -0.002), quality >= 60%, 2+ recent samples
  return vel >= -0.002 && qual >= 0.60 && recent.length >= 2 && sameDir;
}
function hasStableEdge(edge, market = null) { return isGoodEntry(edge, market); }

function runArbitrageCheck(assetFilter = null) {
  if (!assetFilter) {
    for (const asset of ['BTC', 'SOL', 'ETH']) {
      runArbitrageCheck(asset);
    }
    broadcastSignal();
    return;
  }
  const assetKey = String(assetFilter).toUpperCase();
  const now = Date.now();
  const topMarket = getBestMarket(false, assetKey);
  // 4-layer loss limit check
  if (isTradingPaused(now)) {
    clearAssetSignal(assetKey);
    const context = buildSignalContext(topMarket, now);
    setSignalDiagnostics({
      marketId: context?.marketId ?? null,
      asset: getAssetKey(topMarket),
      question: context?.question ?? null,
      side: context?.side ?? null,
      implied: context?.implied ?? null,
      poly: context?.poly ?? null,
      edge: context?.edge ?? null,
      dynMinEdge: context?.dynMinEdge ?? null,
      bollinger: context?.bollinger ?? null,
      bollingerBias: context?.bollingerBias ?? 'neutral',
      trendIndicators: context?.trendIndicators ?? null,
      trendBias: context?.trendBias ?? 'neutral',
      fib: context?.fib ?? null,
      fibBias: context?.fibBias ?? 'neutral',
      pausedUntil: state.trading.pausedUntil,
      pauseReason: state.trading.pauseReason,
      manualRearmRequired: state.trading.manualRearmRequired,
      blockReason: state.trading.manualRearmRequired ? 'MANUAL_REARM' : 'PAUSED_UNTIL',
      blockers: [state.trading.manualRearmRequired ? 'manual_rearm' : 'paused_until'],
    });
    return;
  }

  // ── Single getBestMarket() call per tick ─────────────────────────────────
  // CRITICAL: getBestMarket() must be called ONCE here. Calling it separately
  // inside computeImpliedProb() and computePolyOdds() can return different
  // markets on consecutive calls (scoring is time-dependent), making the edge
  // meaningless (difference between two unrelated markets' model prices).
  if (!topMarket) {
    clearAssetSignal(assetKey);
    setSignalDiagnostics({ blockReason: 'NO_MARKET', blockers: ['no_market'] });
    return;
  }

  // ── Market cascade: try markets in order until one yields a signal ──────────
  // When the top-scored market fails MIN_EDGE (common for live markets in calm
  // conditions), cascade through all eligible markets (live + SIM) rather than
  // giving up. SIM markets have dynMinEdge ~0.4-0.8%, so they catch opportunities
  // that live markets miss during low-volatility periods.
  //
  // KEY FIX: live markets whose Polymarket WS feed is observed-but-stale are
  // excluded from the cascade BEFORE buildTradeSignal() — otherwise the cascade
  // picks the live market (it has edge), then POLY_LIVE_STALE fires at the entry
  // guard with no SIM fallback. By pruning here, SIM markets fill in seamlessly.
  const _polyStaleExclude = (m) =>
    m.live && state.polyLive.marketIds.includes(m.id) && !isPolyLiveFresh();
  const cascadePool = [topMarket, ...state.markets.filter(m => {
    if (m.id === topMarket.id) return false;
    if (_polyStaleExclude(m)) return false; // stale observed live markets → SIM fallback
    if (!isValidTradingMarket(m)) return false;
    const ml = getMarketMinutesLeft(m, now);
    if (ml < 1 || ml > 30.5) return false;
    if (m.priceIsEstimated) return false;
    if (m.live && getMarketLiquidityValue(m) < getMarketMinVolume(m)) return false;
    if (getMarketPriceDistance(m) > 0.42) return false;
    return true;
  })].filter(m => !_polyStaleExclude(m)).slice(0, 10); // also prune topMarket if stale

  let signalCandidate = null;
  let signalMarket = topMarket;
  for (const mkt of cascadePool) {
    const candidate = buildTradeSignal(mkt);
    if (candidate) { signalCandidate = candidate; signalMarket = mkt; break; }
  }

  if (!signalCandidate) {
    clearAssetSignal(assetKey);
    const context = buildSignalContext(topMarket, now);
    // Diagnostic: log why there's no signal every 30s so Railway logs show the block reason.
    // Previously silent — made it impossible to debug long stretches with no entries.
    if (now - (runArbitrageCheck._lastNoSignalLog || 0) > 30000) {
      runArbitrageCheck._lastNoSignalLog = now;
      const polyFresh = isPolyLiveFresh();
      const stalePrunedCount = state.markets.filter(m => m.live && state.polyLive.marketIds.includes(m.id) && !polyFresh).length;
      console.log(`[ARB NO-SIGNAL] topMkt="${topMarket.question?.slice(0,35)}" ` +
        `edge=${((context?.edge ?? 0)*100).toFixed(2)}¢ dynMin=${((context?.dynMinEdge ?? 0)*100).toFixed(2)}¢ ` +
        `polyFresh=${polyFresh} stalePruned=${stalePrunedCount} ` +
        `simMkts=${state.markets.filter(m => !m.live).length} liveMkts=${state.markets.filter(m => m.live).length} ` +
        `cascadeSize=${cascadePool.length} autoTrade=${state.config.autoTrade}`);
    }
    setSignalDiagnostics({
      marketId: context?.marketId ?? topMarket.id,
      asset: getAssetKey(topMarket),
      question: context?.question ?? topMarket.question,
      side: context?.side ?? null,
      implied: context?.implied ?? null,
      poly: context?.poly ?? null,
      edge: context?.edge ?? null,
      dynMinEdge: context?.dynMinEdge ?? null,
      edgeOk: Math.abs(context?.edge ?? 0) >= (context?.dynMinEdge ?? Infinity),
      bollinger: context?.bollinger ?? null,
      bollingerBias: context?.bollingerBias ?? 'neutral',
      trendIndicators: context?.trendIndicators ?? null,
      trendBias: context?.trendBias ?? 'neutral',
      fib: context?.fib ?? null,
      fibBias: context?.fibBias ?? 'neutral',
      pausedUntil: state.trading.pausedUntil,
      pauseReason: state.trading.pauseReason,
      blockReason: 'MIN_EDGE',
      blockers: ['min_edge'],
    });
    return broadcastSignal();
  }

  // Use the market that actually produced the signal (may differ from top-scored market)
  const market = signalMarket;
  const implied = signalCandidate.impliedProb;
  const poly = signalCandidate.polyOdds;
  const edge = signalCandidate._rawEdge;
  const signalTs = signalCandidate.timestamp;
  const dynMinEdge = signalCandidate._dynMinEdge;

  // Debug log every 10s
  if (signalTs - (runArbitrageCheck._lastLog || 0) > 10000) {
    runArbitrageCheck._lastLog = signalTs;
    console.log(`[ARB] implied=${implied.toFixed(4)} poly=${poly.toFixed(4)} edge=${(edge*100).toFixed(2)}¢ minEdge=${(dynMinEdge*100).toFixed(2)}¢ mkt="${market.question?.slice(0,28)}" active=${state.trading.active} autoTrade=${state.config.autoTrade}`);
  }

  // Always record edge history so the Binance-vs-Poly chart is always populated.
  // The stability window (hasStableEdge) filters by minEdge separately below.
  state.edgeHistory.push({ time: signalTs, edge, implied, poly, asset: getAssetKey(market) });
  if (state.edgeHistory.length > 80) state.edgeHistory.shift();

  let activeSignal = {
    marketId:    signalCandidate.marketId,
    question:    signalCandidate.question,
    asset:       signalCandidate.asset,
    side:        signalCandidate.side,
    edge:        signalCandidate.edge,
    impliedProb: signalCandidate.impliedProb,
    polyOdds:    signalCandidate.polyOdds,
    betSize:     signalCandidate.betSize,
    confidence:  signalCandidate.confidence,
    bollinger:   signalCandidate.bollinger,
    bollingerBias: signalCandidate.bollingerBias,
    trendIndicators: signalCandidate.trendIndicators,
    trendBias: signalCandidate.trendBias,
    fib: signalCandidate.fib,
    fibBias: signalCandidate.fibBias,
    _rawEdge: signalCandidate._rawEdge,
    _dynMinEdge: signalCandidate._dynMinEdge,
    timestamp:   signalCandidate.timestamp,
  };
  setAssetSignal(assetKey, activeSignal);
  const side = signalCandidate.side;

  // Guard: NEVER open opposite direction on the same market — self-canceling trades.
  // Also block same-side duplicate on the same market: concentrates risk with zero
  // diversification benefit. Use allowDuplicateMarkets to permit stacking only across
  // different markets, never on the same market+side.
  let tradeMarket = market;
  const hasSameSide = state.positions.some(p =>
    p.status === 'OPEN' && p.marketId === tradeMarket.id && p.side === side
  );
  let hasOpposite = state.positions.some(p =>
    p.status === 'OPEN' && p.marketId === tradeMarket.id && p.side !== side
  );
  if (hasSameSide || hasOpposite) {
    // Try to find an alternative market without a conflicting position for this side.
    // Must pass the same duration filter as getBestMarket — prevents long-dated markets leaking in.
    // KEY: also prune stale-WS live markets here (same as cascadePool) so SIM markets
    // fill in seamlessly when all live alternatives have a stale Polymarket feed.
    // Without this, a stale live market gets selected → POLY_LIVE_STALE fires with no SIM fallback.
    const alternatives = state.markets.filter(m => {
      if (m.id === tradeMarket.id) return false; // skip primary
      if (_polyStaleExclude(m)) return false; // stale observed live markets → SIM fallback
      if (!isValidTradingMarket(m)) return false; // duration 4.5–30.5 min only
      if (m.priceIsEstimated) return false;
      const priceDist = Math.abs((m.outcomePrices?.[0] ?? 0.5) - 0.5);
      if (priceDist > 0.42) return false; // skip skewed markets
      if (m.live && getMarketLiquidityValue(m) < getMarketMinVolume(m)) return false; // volume filter
      const msLeft = m.endDate ? new Date(m.endDate).getTime() - now : 10 * 60000;
      if (msLeft < 60000 || msLeft > 30.5 * 60000) return false; // respect duration window
      return !state.positions.some(p => p.status === 'OPEN' && p.marketId === m.id && p.side !== side);
    });
    if (alternatives.length === 0) {
      // No clean alternative exists — skip entirely rather than stacking on same market
      clearAssetSignal(assetKey);
      return broadcastSignal();
    } else {
      // Try each alternative in order until one produces a valid signal.
      // Previously only alternatives[0] was tried — if it had no edge the bot gave up.
      let altSignal = null;
      let altMarket = null;
      for (const candidate of alternatives) {
        const altHasSameSide = state.positions.some(p =>
          p.status === 'OPEN' && p.marketId === candidate.id && p.side === side
        );
        if (altHasSameSide) continue; // skip if same-side conflict
        const sig = buildTradeSignal(candidate, now);
        if (sig) { altSignal = sig; altMarket = candidate; break; }
      }
      if (!altSignal || !altMarket) {
        // No alternative had sufficient edge — nothing to do
        clearAssetSignal(assetKey);
        return broadcastSignal();
      }
      tradeMarket = altMarket;
      hasOpposite = false; // cleared — alternative has no conflicting position
      activeSignal = {
        marketId: altSignal.marketId,
        question: altSignal.question,
        asset: altSignal.asset,
        side: altSignal.side,
        edge: altSignal.edge,
        impliedProb: altSignal.impliedProb,
        polyOdds: altSignal.polyOdds,
        betSize: altSignal.betSize,
        confidence: altSignal.confidence,
        bollinger: altSignal.bollinger,
        bollingerBias: altSignal.bollingerBias,
        trendIndicators: altSignal.trendIndicators,
        trendBias: altSignal.trendBias,
        fib: altSignal.fib,
        fibBias: altSignal.fibBias,
        _rawEdge: altSignal._rawEdge,
        _dynMinEdge: altSignal._dynMinEdge,
        timestamp: altSignal.timestamp,
      };
      setAssetSignal(assetKey, activeSignal);
    }
  }

  const signalEdge = activeSignal?._rawEdge ?? edge;
  const signalDynMinEdge = activeSignal?._dynMinEdge ?? dynMinEdge;
  const signalMarketContext = tradeMarket;
  const openCount = state.positions.filter(p => p.status === 'OPEN').length;
  const canTrade  = openCount < state.config.maxOpenPos;
  // Stability check is optional — disable for high-frequency scalping
  const stableOk  = !state.config.requireStableEdge || isGoodEntry(signalEdge, signalMarketContext);

  // Total exposure cap: never risk more than 40% of effective balance across all open positions
  // Use effective balance (cash + open costs) not just cash — otherwise the cap tightens every
  // time a position is opened, eventually blocking all new trades.
  const totalExposure = state.positions
    .filter(p => p.status === 'OPEN')
    .reduce((s, p) => s + (p.cost || 0), 0);
  const effectiveBal  = state.trading.balance + totalExposure;
  const exposureOk = totalExposure + activeSignal.betSize <= effectiveBal * 0.40;
  // Keep enough cash to cover the bet
  const safeBalance = state.trading.balance >= activeSignal.betSize;
  const diagnostics = {
    blockers: [],
    blockReason: null,
    vpin: 0,
    pausedUntil: state.trading.pausedUntil,
    pauseReason: state.trading.pauseReason,
    manualRearmRequired: state.trading.manualRearmRequired,
    polyLiveFresh: isPolyLiveFresh(),
    polyLiveStaleMs: getPolyLiveAgeMs(),
  };

  // ── ENTRY QUALITY GUARDS (applied before auto-trade and signal display) ───────
  // Based on research: homerun, aulekator, gamma-trade-lab, MrFadiAi

  const tradeMarketObserved = tradeMarket.live && state.polyLive.marketIds.includes(tradeMarket.id);
  if (tradeMarketObserved && !isPolyLiveFresh()) {
    clearAssetSignal(assetKey);
    diagnostics.blockers.push('poly_live_stale');
    diagnostics.blockReason = 'POLY_LIVE_STALE';
    setSignalDiagnostics(diagnostics);
    return broadcastSignal();
  }

  // 1. SETTLEMENT TIMING GUARD
  // In the final minutes of a short-term binary (≤30 min), informed volume surges.
  // Guard scaled to market duration: 90s (1.5 min) for all markets ≤30 min.
  // Previously 3 min — too restrictive for 5-min markets (blocked 60% of window).
  // 90s still protects against end-of-window adverse selection while allowing
  // 3.5 min of tradeable window on 5-min markets (vs 2 min with 3-min guard).
  const mktMsLeft  = tradeMarket.endDate ? new Date(tradeMarket.endDate).getTime() - now : Infinity;
  const isShortMkt = mktMsLeft <= 30 * 60000;
  if (isShortMkt && mktMsLeft < 90 * 1000) {
    clearAssetSignal(assetKey);
    diagnostics.blockers.push('settlement_window');
    diagnostics.blockReason = 'SETTLEMENT_WINDOW';
    setSignalDiagnostics(diagnostics);
    return broadcastSignal();
  }

  // 2. VPIN TOXICITY
  // VPIN = |buyVol-sellVol|/totalVol; se > 0.75 → pausar entradas
  const vpin = computeVPIN(signalMarketContext);
  diagnostics.vpin = vpin;
  if (vpin > 0.75) {
    clearAssetSignal(assetKey);
    diagnostics.blockers.push('vpin');
    diagnostics.blockReason = 'VPIN';
    setSignalDiagnostics(diagnostics);
    return broadcastSignal();
  }

  // 3. SPIKE DETECTION & MULTI-SIGNAL CONFIRMATION
  // Spike detection: se |BTC move em 3s| > 15bps (0.0015) → entrada DipArb imediata
  const signalNow = getAssetPrice(signalMarketContext);
  const btc3sAgo = getPriceAtForMarket(signalMarketContext, 3000);
  const btcSpike = btc3sAgo > 0 ? Math.abs(signalNow - btc3sAgo) / btc3sAgo : 0;
  const isSpike = btcSpike > 0.0015;

  // Multi-signal: exigir 2-de-4 sinais concordando
  const btc10sAgo   = getPriceAtForMarket(signalMarketContext, 10000);
  const btcTrend10s = btc10sAgo > 0 ? (signalNow - btc10sAgo) / btc10sAgo : 0;
  const trendMatches = side === 'BUY_YES' ? btcTrend10s > 0 : btcTrend10s < 0;
  const velOk = edgeVelocity(signalMarketContext) > 0.001;

  // edgeOk: sempre true aqui pois buildTradeSignal já filtrou |edge| < dynMinEdge.
  // Preserva o baseline do código original (edgeOk garantido = 1 sinal confirmado).
  const edgeOk = Math.abs(signalEdge) >= signalDynMinEdge;

  // Confidence-adjusted edge como 4º sinal (kalshi-ai-trading-bot pattern):
  // Conta como confirmação extra quando o edge supera o limiar escalonado por confiança.
  // NÃO substitui edgeOk — apenas acrescenta. Assim o baseline de 1 sinal nunca cai.
  const conf = signalCandidate.confidence;
  const confAdjMinEdge = conf >= 80 ? signalDynMinEdge * 0.75
                       : conf <  60 ? signalDynMinEdge * 1.33
                       : signalDynMinEdge;
  const confEdgeOk = Math.abs(signalEdge) >= confAdjMinEdge;

  // Flow imbalance como 5º sinal de confirmação (polymarket-btc-15min pattern).
  // Limiar 0.15 (15%) é realista para BTC aggTrades em janelas de 30s.
  // Pressão de ordem alinhada com a direção do trade = confirmação extra de fluxo real.
  const imb = flowImbalance(signalMarketContext);
  const flowConfirms = Math.abs(imb) >= 0.15 &&
    ((side === 'BUY_YES' && imb > 0) || (side === 'BUY_NO' && imb < 0));
  const fibConfirms = signalCandidate.fibBias === 'favorable'
    || (signalCandidate.fibBias === 'neutral' && (signalCandidate.fib?.roomToTargetPct || 0) > 0.0015);

  // Confirmação de sinal: bloqueia apenas se MÚLTIPLOS sinais forem explicitamente
  // CONTRÁRIOS ao trade (veto por contradição, não por ausência de confirmação).
  // Antes era 2-de-5 favoráveis — isso bloqueava o bot em mercado calmo por horas
  // porque velOk/trendMatches/flowConfirms só se confirmam durante spikes.
  // Agora: bloqueia se ≥2 sinais contrários estiverem ativos simultaneamente.
  // edgeOk sempre é true aqui (buildTradeSignal já filtrou). O score mantém
  // todos os 5 sinais para diagnóstico e logging.
  const confirmedSignals = [trendMatches, velOk, edgeOk, confEdgeOk, flowConfirms, fibConfirms].filter(Boolean).length;
  const trendAgainst = !trendMatches && btc10sAgo > 0 && Math.abs(btcTrend10s) > 0.0005;
  const flowAgainst  = Math.abs(imb) >= 0.20 &&
    ((side === 'BUY_YES' && imb < 0) || (side === 'BUY_NO' && imb > 0));
  const fibAgainst   = signalCandidate.fibBias === 'unfavorable';
  const vetoCount    = [trendAgainst, flowAgainst, fibAgainst].filter(Boolean).length;
  Object.assign(diagnostics, {
    asset: activeSignal.asset || getAssetKey(signalMarketContext),
    marketId: activeSignal.marketId,
    question: activeSignal.question,
    side: activeSignal.side,
    implied,
    poly,
    edge: signalEdge,
    dynMinEdge: signalDynMinEdge,
    confirmedSignals,
    trendMatches,
    velOk,
    edgeOk,
    fibConfirms,
    stableOk,
    canTrade,
    safeBalance,
    exposureOk,
    hasOpposite,
    vpin: diagnostics.vpin || 0,
    btcSpike,
    isSpike,
    bollinger: signalCandidate.bollinger,
    bollingerBias: signalCandidate.bollingerBias,
    trendIndicators: activeSignal.trendIndicators,
    trendBias: activeSignal.trendBias,
    fib: activeSignal.fib,
    fibBias: activeSignal.fibBias,
    pausedUntil: state.trading.pausedUntil,
    pauseReason: state.trading.pauseReason,
    trendAgainst,
    flowAgainst,
    fibAgainst,
    vetoCount,
  });
  if (!canTrade) diagnostics.blockers.push('max_open_positions');
  if (!stableOk) diagnostics.blockers.push('stable_edge');
  if (!safeBalance) diagnostics.blockers.push('insufficient_balance');
  if (!exposureOk) diagnostics.blockers.push('exposure_limit');
  if (hasOpposite) diagnostics.blockers.push('opposite_position');
  
  // SIGNAL_VETO: only apply when requireStableEdge is explicitly enabled.
  // When requireStableEdge=false (default), user has opted out of all confirmation
  // filters — trade on edge alone. The veto was blocking post-spike entries even
  // when signals were good because trendAgainst+flowAgainst fire together during
  // normal BTC pullbacks after any spike.
  if (state.config.requireStableEdge && vetoCount >= 2 && !isSpike) {
    clearAssetSignal(assetKey);
    diagnostics.blockers.push('signal_confirmation');
    diagnostics.blockReason = 'SIGNAL_VETO';
    setSignalDiagnostics(diagnostics);
    return broadcastSignal();
  }

  if (fibAgainst && !isSpike && Math.abs(signalEdge) < signalDynMinEdge * 1.35) {
    clearAssetSignal(assetKey);
    diagnostics.blockers.push('fib_exhaustion');
    diagnostics.blockReason = 'FIB_EXHAUSTION';
    setSignalDiagnostics(diagnostics);
    return broadcastSignal();
  }

  // 4. ADVERSE SELECTION COOLDOWN
  // If ≥4 of the last 5 closed trades were losses, pause auto-entries for 15s.
  // Raised threshold from 3→4 and reduced window from 60s→15s: the original
  // 3/5 + 60s block was causing silences up to 60s after ANY moderate losing
  // stretch (common in normal market noise). 4/5 is a genuine toxic-flow signal;
  // 15s respects CLOB rate limits without over-suppressing entry frequency.
  const last5 = state.trading.trades.slice(0, 5);
  if (last5.length >= 5) {
    const lossCount = last5.filter(t => t.outcome === 'LOSS').length;
    if (lossCount >= 4) {
      const lastLossTs = (last5.find(t => t.outcome === 'LOSS') || {}).timestamp || 0;
      if (now - lastLossTs < 15000) {
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
  if (activeSignal.betSize < 1) diagnostics.blockers.push('bet_too_small');
  const liveVolumeMin = getMarketMinVolume(tradeMarket);
  const liveVolume = getMarketLiquidityValue(tradeMarket);
  const volumeOk = !tradeMarket.live || liveVolume >= liveVolumeMin;
  if (!volumeOk) diagnostics.blockers.push('market_volume');

  if (state.config.autoTrade && activeSignal.betSize >= 1 && canTrade && stableOk && safeBalance && !hasOpposite && exposureOk && volumeOk) {
    diagnostics.blockReason = 'READY';
    setSignalDiagnostics(diagnostics);
    executeTrade(activeSignal);
  } else {
    diagnostics.blockReason = diagnostics.blockers[0] ? diagnostics.blockers[0].toUpperCase() : 'READY_MANUAL';
    setSignalDiagnostics(diagnostics);
    // Log when bot has signal but something blocks auto-entry — helps diagnose quiet periods.
    if (state.config.autoTrade && now - (runArbitrageCheck._lastBlockLog || 0) > 30000) {
      runArbitrageCheck._lastBlockLog = now;
      console.log(`[ARB BLOCKED] reason=${diagnostics.blockReason} blockers=[${diagnostics.blockers.join(',')}] ` +
        `edge=${(signalEdge*100).toFixed(2)}¢ betSize=$${activeSignal.betSize} ` +
        `canTrade=${canTrade} stableOk=${stableOk} safeBalance=${safeBalance} exposureOk=${exposureOk} ` +
        `autoTrade=${state.config.autoTrade} mkt="${market.question?.slice(0,28)}"`);
    }
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

// Simulate CLOB fill: returns { fillOdds, fillSize, partialFill, spread, impact, orderType }
// fillSize may be < requested if order exceeds available depth.
// orderType='TAKER' (default): market order, pays bid-ask spread + price impact.
// orderType='MAKER': GTC limit posted at mid, 0 spread, 0 impact, 0% fee — but capped at
//   50% of taker depth (liquidity uncertainty of passive posting).
function simulateClobFill(side, requestedSize, market) {
  const vol      = getMarketLiquidityValue(market);
  const yesPrice = market.outcomePrices?.[0] ?? 0.50;
  const midOdds  = side === 'BUY_YES' ? yesPrice : (1 - yesPrice);
  const orderType = state.config.orderType || 'TAKER';

  if (orderType === 'MAKER') {
    // GTC limit order posted at mid — fills at mid price (no spread, no impact).
    // Passive fill depth is ~50% of taker depth (conservative: not all resting orders fill).
    const makerDepth = maxOrderSize(vol) * 0.5;
    const fillSize   = Math.min(requestedSize, makerDepth);
    return {
      fillOdds:    Math.round(midOdds * 10000) / 10000,
      fillSize:    Math.round(fillSize * 100) / 100,
      partialFill: fillSize < requestedSize,
      spread:      0,
      impact:      0,
      orderType,
    };
  }

  // TAKER: market order — pays bid-ask spread + price impact
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

  // 4. Partial fill guard (pmxt pattern): se menos de 50% do tamanho solicitado
  // for preenchido, o spread % efetivo dobra e a edge evapora — melhor não entrar.
  // Retorna fillSize=0 para sinalizar ao openPosition que deve abortar.
  if (partialFill && fillSize < requestedSize * 0.50) {
    console.log(`[CLOB] Skip — partial fill seria ${Math.round(fillSize)}/${Math.round(requestedSize)} (<50%), edge evaporaria`);
    return {
      fillOdds:    Math.round(rawFill * 10000) / 10000,
      fillSize:    0,
      partialFill: true,
      spread,
      impact,
      orderType,
    };
  }

  return {
    fillOdds:    Math.round(rawFill * 10000) / 10000,
    fillSize:    Math.round(fillSize * 100) / 100,
    partialFill,
    spread,
    impact,
    orderType,
  };
}

// ── POSITION MANAGEMENT ──────────────────────────────────────────────────────

function openPosition(signal) {
  const { side, betSize, edge, marketId, question } = signal;
  if (!betSize || betSize < 1) return;

  // ── Entry dedup lock (polymarket-copy-trading-bot pattern) ─────────────────
  // Bloqueia double-execution no mesmo mercado/lado em menos de 500ms.
  // Previne race condition quando runArbitrageCheck dispara em paralelo (400ms timer
  // + Binance tick handler). Aplica igual em SIM e LIVE.
  const lockKey = `${marketId}:${side}`;
  const lastEntry = openPosition._lastEntryTs?.[lockKey] || 0;
  if (Date.now() - lastEntry < 500) return;
  if (!openPosition._lastEntryTs) openPosition._lastEntryTs = {};
  openPosition._lastEntryTs[lockKey] = Date.now();

  // NEVER open opposite direction on same market — prevents self-canceling trades
  if (state.positions.some(p => p.status === 'OPEN' && p.marketId === marketId && p.side !== side)) return;

  // Block same-direction duplicate on the SAME market regardless of allowDuplicateMarkets.
  // allowDuplicateMarkets only permits stacking across *different* markets.
  if (state.positions.some(p => p.status === 'OPEN' && p.marketId === marketId && p.side === side)) return;

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
  const vol = getMarketLiquidityValue(market);

  const MIN_VOL = getMarketMinVolume(market);
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

  const entryTime = Date.now();
  const pos = {
    id:               nextId('p'),
    marketId,
    asset:            signal.asset || getAssetKey(market),
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
    fib:              signal.fib || null,
    fibBias:          signal.fibBias || 'neutral',
    entryTime,
    btcPriceAtEntry:  getAssetPrice(market),
    // CLOB execution metadata (shown in trade log)
    spread:           fill.spread,
    impact:           fill.impact,
    partialFill:      fill.partialFill,
    requestedSize:    betSize,
    orderType:        fill.orderType,
    status:           'OPEN',
  };
  pos.closeDeadline = getPositionCloseDeadline(pos, market);

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

  const nowMs = Date.now();

  // Process SIM markets grouped by asset, allowing independent reseed per asset
  const assetGroups = { BTC: [], SOL: [], ETH: [] };
  for (const m of state.markets) {
    if (!m.live && getMarketMinutesLeft(m, nowMs) > 1) {
      const a = (m.asset || 'BTC').toUpperCase();
      if (assetGroups[a]) assetGroups[a].push(m);
    }
  }

  for (const [asset, activeSims] of Object.entries(assetGroups)) {
    const assetPriceMkt = { asset };
    const assetCurrentPrice = getAssetPrice(assetPriceMkt);
    if (!assetCurrentPrice || assetCurrentPrice <= 0) continue;

    const allExpired = activeSims.length === 0;
    const ladderTooFar = activeSims.length > 0 && activeSims.every(m => {
      const strike = getSimStrike(m) ?? m._strikeSnapshot;
      return strike && assetCurrentPrice
        ? Math.abs(strike - assetCurrentPrice) / assetCurrentPrice > 0.02
        : false;
    });
    const allExtreme = activeSims.length > 0 &&
      activeSims.every(m => Math.abs(computeBinaryMid(m) - 0.5) > 0.42);

    if (allExpired || ladderTooFar || allExtreme) {
      if (asset === 'BTC') { seedSimMarkets(); }
      else { seedSimMarketsForAsset(asset, assetCurrentPrice); }
      continue;
    }

    // Lagged poly design — use per-asset price history
    const assetHistory = getAssetPriceHistory(assetPriceMkt);
    const laggedPrice = getPriceAtFromHistory(assetHistory, 90000, assetCurrentPrice);
    for (const m of activeSims) {
      const laggedPoly = computeBinaryMid(m, laggedPrice);
      m.outcomePrices = [
        Math.round(laggedPoly * 10000) / 10000,
        Math.round((1 - laggedPoly) * 10000) / 10000,
      ];
    }
  }
}

function getPositionCloseDeadline(pos, market) {
  // Deadline = market expiry (endDate - 5s), with a 30s minimum hold from entry.
  // posTimeoutMs is no longer user-configurable: all markets (SIM and real) have a
  // real endDate that defines the trading window, so the timeout is always market-driven.
  const marketCloseAt = market?.endDate ? new Date(market.endDate).getTime() : NaN;
  const minHoldAt = pos.entryTime + 30000;
  if (!Number.isFinite(marketCloseAt) || marketCloseAt <= pos.entryTime) return minHoldAt;
  const nearExpiryAt = Math.max(minHoldAt, marketCloseAt - 5000);
  return nearExpiryAt;
}

// ── POSITION CLOSE ───────────────────────────────────────────────────────────────

function closePosition(pos, exitOdds, reason) {
  pos.status      = 'CLOSED';
  pos.exitOdds    = Math.round(exitOdds * 1000) / 1000;
  pos.closeReason = reason;
  pos.closeTime   = Date.now();
  pos.holdMs      = pos.closeTime - pos.entryTime;

  // Apply CLOB exit spread (selling at BID = mid − half-spread).
  // MAKER mode: posted at mid → 0 spread on exit (fills at mid on the way out too).
  // clobSpread() returns the half-spread (distance from mid to ask/bid).
  const market = state.markets.find(m => m.id === pos.marketId);
  const isMaker = (pos.orderType === 'MAKER') || (state.config.orderType === 'MAKER');
  const exitSpread    = (reason === 'MERGE' || isMaker) ? 0 : clobSpread(Number(market?.volume || 0));
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

  if (state.config.mode === 'LIVE') {
    if (state.config.liveRiskEnabled && !isTradingPaused()) {
      const consecutiveLosses = state.stats.streak < 0 ? Math.abs(state.stats.streak) : 0;
      const requireStreak = state.config.livePauseRequireStreak && state.config.livePauseLossStreak > 0;
      const streakOk = !requireStreak || consecutiveLosses >= state.config.livePauseLossStreak;
      const streakSuffix = requireStreak ? ` + ${state.config.livePauseLossStreak} losses streak` : '';
      if (monthDrawdown > state.config.liveMonthlyPauseDrawdownPct / 100 && streakOk) {
        armLiveRiskPause(`${state.config.liveMonthlyPauseDrawdownPct}% Monthly Drawdown${streakSuffix}`, state.config.liveMonthlyPauseMs);
        console.log(`[Risk] Monthly live drawdown limit reached. Paused for ${Math.round(state.config.liveMonthlyPauseMs / 60000)}m.`);
      } else if (dayDrawdown > state.config.liveDailyPauseDrawdownPct / 100 && streakOk) {
        armLiveRiskPause(`${state.config.liveDailyPauseDrawdownPct}% Daily Drawdown${streakSuffix}`, state.config.liveDailyPauseMs);
        console.log(`[Risk] Daily live drawdown limit reached. Paused for ${Math.round(state.config.liveDailyPauseMs / 60000)}m.`);
      }
    }
  } else if (state.trading.pausedUntil > 0 || state.trading.pauseReason || state.trading.manualRearmRequired) {
    clearTradingPause();
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
    asset:         pos.asset || getAssetKey(market),
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
    fibBias:       pos.fibBias || 'neutral',
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
  // MAKER mode exits at mid (no spread cost). TAKER mode pays half-spread on exit.
  const isMaker = state.config.orderType === 'MAKER';
  const exitHalfSpread = isMaker ? 0 : clobSpread(Number(market?.volume || 0));
  return Math.max(0.01, rawMarkOdds - exitHalfSpread);
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

    const nowMs = Date.now();

    // Minimum hold: 2s before any TP/SL can fire.
    // In LIVE, order submission + confirmation takes 1-3s — you physically cannot
    // exit before your entry fill confirms. Prevents unrealistic 127ms round-trips.
    if (nowMs - pos.entryTime < 2000) continue;

    // For SIM markets: compute YES probability in real-time from asset price + strike.
    // For LIVE markets: use outcomePrices from CLOB (already live).
    let rawYesOdds;
    if (!mktForPos.live) {
      rawYesOdds = computeBinaryMid(mktForPos); // auto-detects asset via getAssetPrice
    } else {
      rawYesOdds = mktForPos.outcomePrices?.[0] ?? 0.5;
    }

    // ── Gap 5: Market resistance — EMA smoothing ─────────────────────────────
    // Real CLOB order books resist sudden BTC moves: market makers reprice
    // incrementally, not tick-by-tick. alpha=0.12 per 150ms tick ≈ tau ~1.1s.
    // For LIVE markets outcomePrices already carry this natural lag (90s poll).
    if (!mktForPos.live) {
      if (pos._markEMA == null) pos._markEMA = rawYesOdds;
      pos._markEMA = pos._markEMA * 0.88 + rawYesOdds * 0.12;
      rawYesOdds = pos._markEMA;
    }

    const rawMidOdds = pos.side === 'BUY_YES' ? rawYesOdds : (1 - rawYesOdds);

    // ── Gap 4: Mark cap by time-to-expiry ────────────────────────────────────
    // Institutional market makers keep bids well below 100¢ until the last
    // 2 minutes when outcome is near-certain. A 0.97 bid at T-10 min never
    // exists in real CLOB — you would be walking into an empty order book.
    const msLeft = mktForPos.endDate
      ? new Date(mktForPos.endDate).getTime() - nowMs
      : Infinity;
    const maxMark = msLeft > 5 * 60000 ? 0.88   // T > 5 min: arb ceiling
                  : msLeft > 2 * 60000 ? 0.92   // T 2-5 min: approaching resolution
                  : 0.97;                        // T < 2 min: near settlement, full range
    const newMark = Math.max(0.03, Math.min(maxMark, rawMidOdds));

    // ── Gap 2: Exit liquidity penalty near expiry ─────────────────────────────
    // Order book thins as market approaches expiry: fewer resting bids,
    // wider effective spread. Models the cost of liquidating a position
    // in a drying-out book. Penalty ramps from 0¢ at T=2min to 3¢ at T=30s.
    const liquidityPenalty = (Number.isFinite(msLeft) && msLeft < 120000)
      ? Math.min(0.03, 0.03 * (1 - Math.max(0, msLeft) / 120000))
      : 0;
    const netExitOdds = Math.max(0.01, getNetExitOdds(mktForPos, newMark) - liquidityPenalty);

    pos.markOdds = newMark;
    pos.unrealizedPnl = Math.round((netExitOdds - pos.entryOdds) * pos.shares * 100) / 100;
    pos.pnlPct = pos.cost > 0
      ? Math.round((pos.unrealizedPnl / pos.cost) * 10000) / 100
      : 0;

    // TP/SL trigger based on pnlPct — the same number the user sees in the UI.
    if (pos.pnlPct >= state.config.takeProfitPct) {
      closePosition(pos, newMark, 'TP'); continue;
    }
    if (pos.pnlPct <= -state.config.stopLossPct) {
      closePosition(pos, newMark, 'SL'); continue;
    }
    const closeDeadline = getPositionCloseDeadline(pos, mktForPos);
    pos.closeDeadline = closeDeadline;
    if (nowMs >= closeDeadline) {
      closePosition(pos, newMark, 'TIMEOUT'); continue;
    }
  }

  // Broadcast live open positions to UI
  broadcast({ type: 'POSITIONS', data: state.positions.filter(p => p.status === 'OPEN') });
}

// ── TRADE EXECUTION ───────────────────────────────────────────────────────────
// inFlight set: tracks (marketId+side) pairs currently in async executeTrade().
// Prevents duplicate orders when runArbitrageCheck fires at 100ms and 400ms
// simultaneously while the first await latency is still pending.
const _inFlight = new Set();

async function executeTrade(signal) {
  if (!signal || signal.betSize < 1) return;
  const assetKey = String(signal.asset || 'BTC').toUpperCase();

  // Duplicate-order guard: reject if this exact market+side combo is already
  // awaiting CLOB confirmation. Critical in LIVE — double-submitting an order
  // to the Polymarket CLOB creates two fills and doubles risk.
  const flightKey = `${signal.marketId}:${signal.side}`;
  if (_inFlight.has(flightKey)) return;
  _inFlight.add(flightKey);

  try {
  // Use effective balance (cash + open position cost) for drawdown.
  // Do NOT include unrealizedPnl — unrealized gains are not spendable and
  // inflating effectiveBal would loosen the exposure cap artificially.
  const openPos      = state.positions.filter(p => p.status === 'OPEN');
  const openCost     = openPos.reduce((s, p) => s + (p.cost || 0), 0);
  const effectiveBal = state.trading.balance + openCost;
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
  const nowTs = Date.now();
  const globalMinCooldown = 350;
  const perAssetCooldown = Math.max(state.trading.cooldownMs, 2000);
  if (nowTs - state.trading.lastTradeTs < globalMinCooldown) return;
  if (nowTs - (state.trading.lastTradeTsByAsset[assetKey] || 0) < perAssetCooldown) return;
  state.trading.lastTradeTs = nowTs;
  state.trading.lastTradeTsByAsset[assetKey] = nowTs;

  // ── Simulate execution latency (CLOB order roundtrip) ─────────────────────
  // Same range for SIM and LIVE: 50-300ms realistic network + chain roundtrip.
  const latencyMs = 50 + Math.floor(Math.random() * 250);
  await new Promise(r => setTimeout(r, latencyMs));

  openPosition(signal);
  if (state.config.mode === 'LIVE') console.log('[LIVE] Order stub — CLOB API not yet implemented');
  } finally {
    _inFlight.delete(flightKey);
  }
}

// legacy sim kept for reference but no longer called
function _legacySimTrade_unused(signal) {
  void signal;
}

// ── BROADCASTS ────────────────────────────────────────────────────────────────
function broadcastMarketData() {
  const mkt            = getActiveSignalMarket();
  const { implied, poly, edge } = computeEdge(mkt);
  const edgeHistory = state.edgeHistory.filter(e => (e.asset || 'BTC') === getAssetKey(mkt)).slice(-80);
  // Send only live tick + current candle. Full candle history (300 candles ~39KB)
  // is fetched by the 3s HTTP pollCandles — do NOT resend every 150ms WS tick.
  broadcast({
    type: 'MARKET_DATA',
    data: {
      btcPrice:     state.btcPrice,
      btcChange24h: state.btcChange24h,
      solPrice:     state.solPrice,
      ethPrice:     state.ethPrice,
      laggedPrice:  getPriceAt(LAG_MS),
      impliedProb:  implied,
      polyOdds:     poly,
      edge,
      edgeHistory,
      priceChart:   state.priceChart.slice(-100),
      currentCandle:state.currentCandle,
      bollinger:    computeBollinger(),
      trendIndicators: computeChartTrendIndicators(),
      priceSource:  state.priceSource,
      timestamp:    Date.now(),
    },
  });
}

function broadcastSignal() {
  broadcast({
    type: 'SIGNAL',
    data: {
      current: state.currentSignal,
      byAsset: state.assetSignals,
    },
  });
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
    isPaused:      isTradingPaused(),
    pausedUntil:   state.trading.pausedUntil,
    pausedRemainingMs: Math.max(0, state.trading.pausedUntil - Date.now()),
    pauseReason:   state.trading.pauseReason,
    manualRearmRequired: state.trading.manualRearmRequired,
    balance:       effectiveBalance,
    cashBalance:   state.trading.balance,
    startBalance:  state.trading.startBalance,
    peakBalance:   state.trading.peakBalance,
    drawdown,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    binanceConnected: state.binanceConnected,
    priceSource:   state.priceSource,
    solPrice:      state.solPrice,
    ethPrice:      state.ethPrice,
    solConnected:  state.solConnected,
    ethConnected:  state.ethConnected,
    stats:         state.stats,
    assetSignals:  state.assetSignals,
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
      maxOpenPos:            state.config.maxOpenPos,
      requireStableEdge:     state.config.requireStableEdge,
      allowDuplicateMarkets: state.config.allowDuplicateMarkets,
      cooldownMs:            state.trading.cooldownMs,
      liveRiskEnabled:       state.config.liveRiskEnabled,
      liveDailyPauseDrawdownPct: state.config.liveDailyPauseDrawdownPct,
      liveDailyPauseMs:      state.config.liveDailyPauseMs,
      liveMonthlyPauseDrawdownPct: state.config.liveMonthlyPauseDrawdownPct,
      liveMonthlyPauseMs:    state.config.liveMonthlyPauseMs,
      livePauseLossStreak:   state.config.livePauseLossStreak,
      livePauseRequireStreak: state.config.livePauseRequireStreak,
      liveManualRearm:       state.config.liveManualRearm,
      orderType:             state.config.orderType,
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
  state.config.autoTrade    = true;
  state.trading.lastTradeTs = 0;    // reset cooldown — first trade can fire immediately
  state.trading.lastTradeTsByAsset = { BTC: 0, SOL: 0, ETH: 0 };
  saveConfig();
  saveSession();
  broadcastStatus();
  // Run an immediate check so UI sees signal right away
  if (state.priceHistory.length >= 3) runArbitrageCheck();
  res.json({ success: true, active: true });
});

app.post('/api/bot/stop', (req, res) => {
  if (!state.trading.active) return res.json({ success: true, active: false }); // idempotent
  state.trading.active  = false;
  state.config.autoTrade = false;
  state.currentSignal   = null;
  state.assetSignals    = { BTC: null, SOL: null, ETH: null };
  state.trading.lastTradeTsByAsset = { BTC: 0, SOL: 0, ETH: 0 };
  saveConfig();
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

  if (req.body.autoTrade !== undefined) {
    const wantsAutoTrade = Boolean(req.body.autoTrade);
    state.config.autoTrade = wantsAutoTrade;
    state.trading.active = wantsAutoTrade;
    if (wantsAutoTrade) {
      state.trading.lastTradeTs = 0;
      state.trading.lastTradeTsByAsset = { BTC: 0, SOL: 0, ETH: 0 };
      if (state.priceHistory.length >= 3) runArbitrageCheck();
    } else {
      state.currentSignal = null;
      state.assetSignals = { BTC: null, SOL: null, ETH: null };
      state.trading.lastTradeTsByAsset = { BTC: 0, SOL: 0, ETH: 0 };
      broadcastSignal();
    }
  }

  saveConfig();
  saveSession();
  broadcastStatus();
  res.json({ success: true, config: buildStatusPayload().config });
});

app.post('/api/risk/rearm', (_req, res) => {
  clearTradingPause();
  saveSession();
  broadcastStatus();
  if (state.trading.active && state.config.autoTrade && state.priceHistory.length >= 3) {
    runArbitrageCheck();
  }
  res.json({ success: true, isPaused: isTradingPaused(), pausedUntil: state.trading.pausedUntil, pauseReason: state.trading.pauseReason });
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
  state.trading.lastTradeTsByAsset = { BTC: 0, SOL: 0, ETH: 0 };
  state.trading.peakBalanceDay   = state.config.capital;
  state.trading.peakBalanceMonth = state.config.capital;
  state.stats = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, todayPnl: 0, streak: 0, totalFees: 0 };
  state.currentSignal = null;
  state.assetSignals = { BTC: null, SOL: null, ETH: null };
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
  const market = getActiveSignalMarket();
  const { implied, poly, edge } = computeEdge(market);
  const edgeHistory = state.edgeHistory.filter(e => (e.asset || 'BTC') === getAssetKey(market)).slice(-80);
  res.json({
    candles:       state.candles.slice(-300),
    currentCandle: state.currentCandle,
    edgeHistory,
    impliedProb:   implied,
    polyOdds:      poly,
    edge,
    bollinger:     computeBollinger(),
    trendIndicators: computeChartTrendIndicators(),
    marketId: market?.id || null,
    marketQuestion: market?.question || null,
  });
});

// ── ALT ASSET CANDLES (SOL / ETH) ────────────────────────────────────────────
// Fetches 1m Binance klines and top Poly market price for SOL or ETH.
// Results cached 60s to avoid hammering Binance REST limits.
const _altCandleCache = {};
const ALT_CACHE_MS   = 60000;

app.get('/api/alt/candles', async (req, res) => {
  const asset = (req.query.asset || '').toUpperCase();
  if (!['SOL', 'ETH'].includes(asset)) {
    return res.status(400).json({ error: 'asset must be SOL or ETH' });
  }

  // ── Prefer live in-memory candles (built from Binance aggTrade WS, 5s resolution)
  // These are always up-to-date and require no HTTP request.
  const liveCandles      = asset === 'SOL' ? state.solCandles      : state.ethCandles;
  const liveCurCandle    = asset === 'SOL' ? state.solCurrentCandle : state.ethCurrentCandle;
  const livePrice        = asset === 'SOL' ? state.solPrice         : state.ethPrice;
  const isLiveConnected  = asset === 'SOL' ? state.solConnected     : state.ethConnected;

  if (isLiveConnected && liveCandles.length >= 2) {
    // Serve live WS candles directly — no caching needed, already in memory
    // Find best active alt market for this asset to show polyPrice/question
    const altMkt = getBestMarket(false, asset)
      || state.markets
        .filter(m => (m.asset || 'BTC').toUpperCase() === asset)
        .sort((a, b) => getMarketLiquidityValue(b) - getMarketLiquidityValue(a))[0]
      || null;
    const edgeCtx = computeEdge(altMkt);
    return res.json({
      candles:       liveCandles.slice(-300),
      currentCandle: liveCurCandle,
      price:         livePrice,
      polyPrice:     altMkt?.outcomePrices?.[0] ?? null,
      polyQuestion:  altMkt?.question?.slice(0, 80) ?? null,
      impliedProb:   edgeCtx.implied,
      polyOdds:      edgeCtx.poly,
      edge:          edgeCtx.edge,
      source:        'live-ws',
    });
  }

  // ── Fallback: Binance REST 1m klines (when WS hasn't warmed up yet)
  const cached = _altCandleCache[asset];
  if (cached && Date.now() - cached.ts < ALT_CACHE_MS) {
    return res.json(cached.data);
  }
  try {
    // Binance REST klines — 1m interval, 200 candles ≈ 3h 20m of history
    const symbol   = `${asset}USDT`;
    const klineUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=200`;
    const klineResp = await axios.get(klineUrl, { timeout: 10000 });
    const klines    = Array.isArray(klineResp.data) ? klineResp.data : [];
    const candles   = klines.map(k => ({
      time:   Math.floor(Number(k[0]) / 1000),
      open:   Number(k[1]),
      high:   Number(k[2]),
      low:    Number(k[3]),
      close:  Number(k[4]),
      volume: Number(k[5]),
    })).filter(c => c.time > 0 && c.close > 0);

    const price = livePrice > 0 ? livePrice : (candles.length > 0 ? candles[candles.length - 1].close : 0);

    // Use alt market already loaded in state (avoid extra Gamma API call)
    const altMkt = getBestMarket(false, asset)
      || state.markets
        .filter(m => (m.asset || 'BTC').toUpperCase() === asset)
        .sort((a, b) => getMarketLiquidityValue(b) - getMarketLiquidityValue(a))[0]
      || null;
    let polyPrice   = altMkt?.outcomePrices?.[0] ?? null;
    let polyQuestion = altMkt?.question?.slice(0, 80) ?? null;
    const edgeCtx = computeEdge(altMkt);

    const data = {
      candles,
      currentCandle: null,
      price,
      polyPrice,
      polyQuestion,
      impliedProb: edgeCtx.implied,
      polyOdds: edgeCtx.poly,
      edge: edgeCtx.edge,
      source: 'rest',
    };
    _altCandleCache[asset] = { data, ts: Date.now() };
    res.json(data);
  } catch (e) {
    console.error(`[Alt] Failed to fetch ${asset} candles:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug/feed', (_req, res) => {
  const market = getActiveSignalMarket();
  const polyLiveAgeMs = getPolyLiveAgeMs();
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
    bestMarket: market?.question || null,
    bestMarketId: market?.id || null,
    signalDiagnostics: state.signalDiagnostics,
    bollinger: computeBollinger(),
    trendIndicators: computeChartTrendIndicators(),
    isPaused: isTradingPaused(),
    pausedUntil: state.trading.pausedUntil,
    pausedRemainingMs: Math.max(0, state.trading.pausedUntil - Date.now()),
    pauseReason: state.trading.pauseReason,
    manualRearmRequired: state.trading.manualRearmRequired,
    polyLiveMarketId: state.polyLive.marketId,
    polyLiveMarketIds: state.polyLive.marketIds,
    polyLiveAssetIds: state.polyLive.assetIds,
    polyLiveConnected: isPolyLiveFresh(),
    polyLiveSocketConnected: state.polyLive.connected,
    polyLiveFresh: isPolyLiveFresh(),
    polyLiveStaleMs: Number.isFinite(polyLiveAgeMs) ? polyLiveAgeMs : null,
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
  const initMarket = getActiveSignalMarket();
  const { implied: initImp, poly: initPly, edge: initEdg } = computeEdge(initMarket);
  const initEdgeHistory = state.edgeHistory.filter(e => (e.asset || 'BTC') === getAssetKey(initMarket)).slice(-80);
  ws.send(JSON.stringify({ type: 'STATUS',  data: buildStatusPayload() }));
  ws.send(JSON.stringify({ type: 'MARKETS', data: state.markets }));
  ws.send(JSON.stringify({ type: 'TRADES_HISTORY', data: state.trading.trades.slice(0, 200) }));
  ws.send(JSON.stringify({ type: 'POSITIONS', data: state.positions.filter(p => p.status === 'OPEN') }));
  ws.send(JSON.stringify({ type: 'MARKET_DATA', data: {
    btcPrice: state.btcPrice, btcChange24h: state.btcChange24h,
    laggedPrice: getPriceAt(LAG_MS), impliedProb: initImp,
    polyOdds: initPly, edge: initEdg,
    edgeHistory: initEdgeHistory,
    priceChart: state.priceChart.slice(-100),
    candles: state.candles.slice(-300),
    currentCandle: state.currentCandle,
    trendIndicators: computeChartTrendIndicators(),
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
  if (state.config.mode === 'SIM' && (state.trading.pausedUntil > 0 || state.trading.pauseReason || state.trading.manualRearmRequired)) {
    clearTradingPause();
  }

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
  connectAltAsset('solusdt', 'SOL');
  connectAltAsset('ethusdt', 'ETH');
  await fetchBTCMarkets();
  // Fetch SOL/ETH markets in parallel (non-blocking, best-effort)
  fetchAltMarkets('SOL', 'sol').catch(() => {});
  fetchAltMarkets('ETH', 'eth').catch(() => {});
  // SIM markets for SOL/ETH are seeded automatically on first Binance WS tick
  // via connectAltAsset → seedSimMarketsForAsset(KEY, price)
  syncPolyMarketSubscription();
  // Refresh markets every 15s
  setInterval(fetchBTCMarkets, 15 * 1000);
  setInterval(() => {
    fetchAltMarkets('SOL', 'sol').catch(() => {});
    fetchAltMarkets('ETH', 'eth').catch(() => {});
  }, 30 * 1000);
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
    state.stats.todayPnl  = 0;
    state.trading.peakBalanceDay = state.trading.balance; // Reset daily peak reference
    broadcastStatus();
    setTimeout(resetDay, 86400000);
  }, msToMidnight);
});
