'use strict';
/**
 * signal-fusion.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-Source Signal Fusion Engine
 * Inspired by: aulekator/Polymarket-BTC-15-Minute-Trading-Bot (no license)
 *
 * Sources:
 *   1. Binance price (primary — already in state)
 *   2. Coinbase price (secondary — divergence detection)
 *   3. Fear & Greed Index (sentiment — alternative.me public API)
 *   4. Spike Detector     (>15% move in 3s)
 *   5. Divergence Signal  (Binance vs Coinbase > 0.3%)
 *
 * Each source produces a weighted vote { direction: 1|-1|0, weight: 0-1 }
 * The fusion engine combines votes into a composite signal [-1, +1].
 * A composite > FUSION_THRESHOLD → BUY YES
 * A composite < -FUSION_THRESHOLD → BUY NO
 * ─────────────────────────────────────────────────────────────────────────────
 */

const axios = require('axios');

// Coinbase REST endpoints (public, no auth required for spot price)
const COINBASE_URLS = [
  'https://api.coinbase.com/v2/prices/BTC-USD/spot',
  'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
];

const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1&format=json';

// Configuration
const FUSION_CONFIG = {
  spikeThreshold:      0.15,  // 15% price change in 3s → spike signal
  divergenceThreshold: 0.003, // 0.3% Binance vs Coinbase difference
  fusionThreshold:     0.20,  // composite score needed to generate signal
  fearGreedBullish:    60,    // F&G > 60 = greed (bullish bias)
  fearGreedBearish:    40,    // F&G < 40 = fear  (bearish bias)
  coinbasePollMs:      10000, // poll Coinbase every 10s
  fearGreedPollMs:     300000,// poll F&G every 5 min
};

// Source weights (must sum to meaningful total)
const WEIGHTS = {
  binance:    0.40,  // primary price signal
  coinbase:   0.25,  // divergence confirmation
  fearGreed:  0.20,  // market sentiment
  spike:      0.15,  // volatility event detection
};

class SignalFusion {
  constructor(config = {}) {
    this.cfg = { ...FUSION_CONFIG, ...config };

    this.sources = {
      binance: {
        price:      0,
        direction:  0,  // +1 bull, -1 bear, 0 neutral
        weight:     WEIGHTS.binance,
        lastUpdate: 0,
        label:      'Binance',
      },
      coinbase: {
        price:      0,
        direction:  0,
        weight:     WEIGHTS.coinbase,
        lastUpdate: 0,
        label:      'Coinbase',
        divergencePct: 0,
      },
      fearGreed: {
        value:      50,  // 0-100 scale
        direction:  0,
        weight:     WEIGHTS.fearGreed,
        lastUpdate: 0,
        label:      'Fear & Greed',
        classification: 'Neutral',
      },
      spike: {
        active:     false,
        direction:  0,
        weight:     WEIGHTS.spike,
        lastUpdate: 0,
        label:      'Spike Detector',
        spikeSize:  0,
      },
    };

    // Composite result
    this.composite = {
      score:     0,      // -1 to +1
      direction: 0,      // +1 BUY_YES | -1 BUY_NO | 0 NEUTRAL
      confidence: 0,     // 0-100
      sources:   {},
      ts:        0,
    };

    // Price buffer for spike detection (last 10s)
    this._priceBuffer = [];  // { price, ts }

    // Poll timers
    this._coinbaseTimer   = null;
    this._fearGreedTimer  = null;

    this.started = false;
  }

  // ── Start background pollers ───────────────────────────────────────────────
  start() {
    if (this.started) return;
    this.started = true;
    this._pollCoinbase();
    this._pollFearGreed();
    this._coinbaseTimer  = setInterval(() => this._pollCoinbase(),  this.cfg.coinbasePollMs);
    this._fearGreedTimer = setInterval(() => this._pollFearGreed(), this.cfg.fearGreedPollMs);
    console.log('[SignalFusion] Started (Coinbase + Fear&Greed pollers active)');
  }

  stop() {
    if (this._coinbaseTimer)  clearInterval(this._coinbaseTimer);
    if (this._fearGreedTimer) clearInterval(this._fearGreedTimer);
    this.started = false;
  }

  // ── Update Binance price (call from WS handler) ────────────────────────────
  onBinancePrice(price, now = Date.now()) {
    const src = this.sources.binance;
    src.price      = price;
    src.lastUpdate = now;

    // Update spike detector buffer
    this._priceBuffer.push({ price, ts: now });
    this._priceBuffer = this._priceBuffer.filter(p => now - p.ts <= 10000); // 10s window

    this._detectSpike(now);
    this._fuse(now);
  }

  // ── Spike Detector ────────────────────────────────────────────────────────
  _detectSpike(now) {
    const buf = this._priceBuffer;
    if (buf.length < 2) return;

    // Find oldest price in the last 3 seconds
    const windowMs = 3000;
    const old = buf.find(p => now - p.ts >= windowMs - 100) || buf[0];
    const cur  = buf[buf.length - 1];

    if (!old || !cur || old.price <= 0) return;
    const changePct = Math.abs((cur.price - old.price) / old.price);
    const dir       = cur.price > old.price ? 1 : -1;

    const src = this.sources.spike;
    src.spikeSize  = changePct;
    src.lastUpdate = now;

    if (changePct >= this.cfg.spikeThreshold) {
      src.active    = true;
      src.direction = dir;  // +1 = price spiked up (BUY_NO counter-spike), -1 = down (BUY_YES)
      // Counter-trend: if spike UP → bet NO (price will revert), if spike DOWN → bet YES
      src.direction = -dir; // counter-spike direction
    } else {
      src.active    = false;
      src.direction = 0;
    }
  }

  // ── Coinbase poller ───────────────────────────────────────────────────────
  async _pollCoinbase() {
    for (const url of COINBASE_URLS) {
      try {
        const { data } = await axios.get(url, { timeout: 5000 });
        let cbPrice = 0;

        // api.coinbase.com/v2 format
        if (data?.data?.amount) cbPrice = parseFloat(data.data.amount);
        // api.exchange.coinbase.com format
        else if (data?.price)   cbPrice = parseFloat(data.price);

        if (!cbPrice || !isFinite(cbPrice) || cbPrice < 100) continue;

        const src = this.sources.coinbase;
        src.price      = cbPrice;
        src.lastUpdate = Date.now();

        // Compute divergence vs Binance
        const binPrice = this.sources.binance.price;
        if (binPrice > 0) {
          const div = (binPrice - cbPrice) / cbPrice;
          src.divergencePct = div;

          if (Math.abs(div) >= this.cfg.divergenceThreshold) {
            // Binance lower than Coinbase → lagging → BUY_YES (bin will catch up)
            src.direction = div < 0 ? 1 : -1;
          } else {
            src.direction = 0;
          }
        }

        this._fuse(Date.now());
        return; // success — stop trying
      } catch (e) {
        // try next URL
      }
    }
  }

  // ── Fear & Greed poller ───────────────────────────────────────────────────
  async _pollFearGreed() {
    try {
      const { data } = await axios.get(FEAR_GREED_URL, { timeout: 8000 });
      const entry = data?.data?.[0];
      if (!entry) return;

      const value = parseInt(entry.value, 10);
      if (!isFinite(value)) return;

      const src = this.sources.fearGreed;
      src.value          = value;
      src.classification = entry.value_classification || 'Neutral';
      src.lastUpdate     = Date.now();

      if      (value >= this.cfg.fearGreedBullish) src.direction =  1;  // greed → bullish
      else if (value <= this.cfg.fearGreedBearish) src.direction = -1;  // fear  → bearish
      else                                          src.direction =  0;  // neutral

      console.log(`[SignalFusion] Fear&Greed: ${value} (${src.classification}) → dir=${src.direction}`);
      this._fuse(Date.now());
    } catch (e) {
      // silent fail — optional signal
    }
  }

  // ── Fusion engine ─────────────────────────────────────────────────────────
  _fuse(now = Date.now()) {
    let totalWeight = 0;
    let weightedScore = 0;

    for (const [key, src] of Object.entries(this.sources)) {
      if (src.direction === 0) continue;
      const age = now - (src.lastUpdate || 0);
      // Decay weight for stale sources (>30s old)
      const decayFactor = age < 30000 ? 1.0 : Math.max(0.3, 1 - (age - 30000) / 120000);
      const effectiveWeight = src.weight * decayFactor;
      weightedScore += src.direction * effectiveWeight;
      totalWeight   += effectiveWeight;
    }

    const score      = totalWeight > 0 ? weightedScore / totalWeight : 0;
    const absScore   = Math.abs(score);
    const direction  = absScore >= this.cfg.fusionThreshold
      ? (score > 0 ? 1 : -1)
      : 0;
    const confidence = Math.min(100, Math.round(absScore * 100));

    this.composite = {
      score:      +score.toFixed(4),
      direction,
      confidence,
      sources: {
        binance:   { dir: this.sources.binance.direction,   age: now - (this.sources.binance.lastUpdate || 0)   },
        coinbase:  { dir: this.sources.coinbase.direction,  age: now - (this.sources.coinbase.lastUpdate || 0), div: +((this.sources.coinbase.divergencePct||0)*100).toFixed(3) },
        fearGreed: { dir: this.sources.fearGreed.direction, age: now - (this.sources.fearGreed.lastUpdate || 0), value: this.sources.fearGreed.value, label: this.sources.fearGreed.classification },
        spike:     { dir: this.sources.spike.direction,     age: now - (this.sources.spike.lastUpdate || 0),     size: +((this.sources.spike.spikeSize||0)*100).toFixed(2) },
      },
      ts: now,
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get fusion direction as a signal modifier.
   * Returns +1 (favors BUY_YES), -1 (favors BUY_NO), or 0 (neutral).
   */
  getDirection() {
    return this.composite.direction;
  }

  /**
   * Get Fear & Greed value (0-100).
   */
  getFearGreed() {
    return {
      value:          this.sources.fearGreed.value,
      classification: this.sources.fearGreed.classification,
      direction:      this.sources.fearGreed.direction,
      age:            Date.now() - (this.sources.fearGreed.lastUpdate || 0),
    };
  }

  /**
   * Get spike status.
   */
  getSpike() {
    return {
      active:    this.sources.spike.active,
      sizeP:     +((this.sources.spike.spikeSize || 0) * 100).toFixed(2),
      direction: this.sources.spike.direction,
    };
  }

  /**
   * Get Coinbase divergence.
   */
  getDivergence() {
    return {
      cbPrice:      this.sources.coinbase.price,
      binPrice:     this.sources.binance.price,
      divergencePct: +((this.sources.coinbase.divergencePct || 0) * 100).toFixed(3),
      direction:    this.sources.coinbase.direction,
      age:          Date.now() - (this.sources.coinbase.lastUpdate || 0),
    };
  }

  /**
   * Full dashboard payload.
   */
  getStatus() {
    return {
      composite:   this.composite,
      fearGreed:   this.getFearGreed(),
      spike:       this.getSpike(),
      divergence:  this.getDivergence(),
      running:     this.started,
    };
  }

  /**
   * Apply fusion bonus/penalty to an existing confidence score.
   * +10 if fusion confirms, -8 if fusion conflicts.
   */
  applyToConfidence(baseConfidence, tradeSide) {
    const dir = this.composite.direction;
    if (dir === 0) return baseConfidence;
    const aligned = (tradeSide === 'BUY_YES' && dir > 0) || (tradeSide === 'BUY_NO' && dir < 0);
    return baseConfidence + (aligned ? 10 : -8);
  }
}

module.exports = { SignalFusion, FUSION_CONFIG, WEIGHTS };
