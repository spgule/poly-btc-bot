'use strict';
/**
 * risk-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 4-Layer Risk Management + Dynamic Position Sizing
 * Inspired by: MrFadiAi/Polymarket-bot (MIT License)
 *
 * Layers:
 *   1. Daily Loss Limit     (default 5%)  → pause 60 min
 *   2. Monthly Loss Limit   (default 15%) → pause 30 days
 *   3. Max Drawdown         (default 25%) → pause 7 days
 *   4. Total Loss Halt      (default 40%) → permanent halt (manual rearm)
 *
 * Dynamic Position Sizing:
 *   - Base: 2% of capital per trade
 *   - During losses: reduces 20% per consecutive loss
 *   - During wins:   increases 10% per consecutive win (capped at 5%)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RISK_DEFAULTS = {
  dailyLossPct:    0.05,   // 5%
  monthlyLossPct:  0.15,   // 15%
  maxDrawdownPct:  0.25,   // 25%
  totalHaltPct:    0.40,   // 40%

  dailyPauseMs:    60 * 60 * 1000,          // 1 hour
  monthlyPauseMs:  30 * 24 * 60 * 60 * 1000, // 30 days
  drawdownPauseMs: 7  * 24 * 60 * 60 * 1000, // 7 days

  baseSizePct:     0.02,   // 2% of capital base bet
  maxSizePct:      0.05,   // 5% cap
  lossReducePct:   0.20,   // reduce 20% per consecutive loss
  winIncreasePct:  0.10,   // increase 10% per consecutive win
};

class RiskManager {
  constructor(opts = {}) {
    this.cfg = { ...RISK_DEFAULTS, ...opts };

    // Persistent risk state
    this.state = {
      // Daily tracking (resets at UTC midnight)
      dayStart:        this._dayStart(),
      dayStartBalance: 0,  // set on first trade or startBot()

      // Monthly tracking (resets at UTC month start)
      monthStart:      this._monthStart(),
      monthStartBalance: 0,

      // Peak tracking for drawdown
      peakBalance:     0,

      // Consecutive streak
      consecutiveLosses: 0,
      consecutiveWins:   0,

      // Halt flags
      halted:        false,   // permanent (layer 4)
      pausedUntil:   0,       // temporary pause timestamp
      pauseLayer:    null,    // 1 | 2 | 3 | 4 | null
      pauseReason:   '',

      // Stats for dashboard
      dailyLossPct:   0,
      monthlyLossPct: 0,
      drawdownPct:    0,
      totalLossPct:   0,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  _dayStart(now = Date.now()) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  _monthStart(now = Date.now()) {
    const d = new Date(now);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  // ── Initialise with starting balance ─────────────────────────────────────
  init(balance) {
    const s = this.state;
    s.dayStartBalance   = balance;
    s.monthStartBalance = balance;
    s.peakBalance       = balance;
    s.halted            = false;
    s.pausedUntil       = 0;
    s.pauseLayer        = null;
    s.pauseReason       = '';
    s.consecutiveLosses = 0;
    s.consecutiveWins   = 0;
    s.dayStart          = this._dayStart();
    s.monthStart        = this._monthStart();
    console.log(`[RiskManager] Initialised. Capital=$${balance}`);
  }

  // ── Called after every trade close ───────────────────────────────────────
  onTradeClosed(balance, isWin) {
    const s    = this.state;
    const now  = Date.now();
    const cfg  = this.cfg;

    // Reset daily/monthly windows if new period
    if (now >= s.dayStart + 86400000) {
      s.dayStart        = this._dayStart(now);
      s.dayStartBalance = balance;
    }
    if (now >= s.monthStart + 30 * 86400000) {
      s.monthStart        = this._monthStart(now);
      s.monthStartBalance = balance;
    }

    // Update peak
    if (balance > s.peakBalance) s.peakBalance = balance;

    // Update streak
    if (isWin) { s.consecutiveWins++; s.consecutiveLosses = 0; }
    else        { s.consecutiveLosses++; s.consecutiveWins = 0; }

    // Compute percentages
    const dayLoss   = (s.dayStartBalance   - balance) / (s.dayStartBalance   || 1);
    const monthLoss = (s.monthStartBalance - balance) / (s.monthStartBalance || 1);
    const drawdown  = (s.peakBalance       - balance) / (s.peakBalance       || 1);
    const totalLoss = (s.dayStartBalance   - balance) / (s.dayStartBalance   || 1); // relative to start

    s.dailyLossPct   = Math.max(0, dayLoss);
    s.monthlyLossPct = Math.max(0, monthLoss);
    s.drawdownPct    = Math.max(0, drawdown);
    s.totalLossPct   = Math.max(0, totalLoss);

    // ── Layer 4: Total halt (40%) ──────────────────────────────────────────
    if (s.totalLossPct >= cfg.totalHaltPct && !s.halted) {
      s.halted      = true;
      s.pauseLayer  = 4;
      s.pauseReason = `PERMANENT HALT: total loss ${(s.totalLossPct*100).toFixed(1)}% >= ${(cfg.totalHaltPct*100)}%`;
      s.pausedUntil = Infinity;
      console.warn(`[RiskManager] ⛔ ${s.pauseReason}`);
      return this.getStatus();
    }

    // ── Layer 3: Drawdown (25%) ────────────────────────────────────────────
    if (s.drawdownPct >= cfg.maxDrawdownPct && !this.isPaused(now)) {
      s.pausedUntil = now + cfg.drawdownPauseMs;
      s.pauseLayer  = 3;
      s.pauseReason = `Drawdown ${(s.drawdownPct*100).toFixed(1)}% >= ${(cfg.maxDrawdownPct*100)}% — paused 7 days`;
      console.warn(`[RiskManager] 🔴 Layer 3 − ${s.pauseReason}`);
      return this.getStatus();
    }

    // ── Layer 2: Monthly loss (15%) ────────────────────────────────────────
    if (s.monthlyLossPct >= cfg.monthlyLossPct && !this.isPaused(now)) {
      s.pausedUntil = now + cfg.monthlyPauseMs;
      s.pauseLayer  = 2;
      s.pauseReason = `Monthly loss ${(s.monthlyLossPct*100).toFixed(1)}% >= ${(cfg.monthlyLossPct*100)}% — paused 30 days`;
      console.warn(`[RiskManager] 🟠 Layer 2 − ${s.pauseReason}`);
      return this.getStatus();
    }

    // ── Layer 1: Daily loss (5%) ───────────────────────────────────────────
    if (s.dailyLossPct >= cfg.dailyLossPct && !this.isPaused(now)) {
      s.pausedUntil = now + cfg.dailyPauseMs;
      s.pauseLayer  = 1;
      s.pauseReason = `Daily loss ${(s.dailyLossPct*100).toFixed(1)}% >= ${(cfg.dailyLossPct*100)}% — paused 1h`;
      console.warn(`[RiskManager] 🟡 Layer 1 − ${s.pauseReason}`);
      return this.getStatus();
    }

    return this.getStatus();
  }

  // ── Check if trading is blocked ───────────────────────────────────────────
  isBlocked(now = Date.now()) {
    if (this.state.halted) return { blocked: true, reason: this.state.pauseReason, layer: 4 };
    if (this.state.pausedUntil > now) {
      const remaining = Math.ceil((this.state.pausedUntil - now) / 60000);
      return { blocked: true, reason: `${this.state.pauseReason} (${remaining}min left)`, layer: this.state.pauseLayer };
    }
    return { blocked: false, reason: null, layer: null };
  }

  isPaused(now = Date.now()) {
    return this.state.halted || this.state.pausedUntil > now;
  }

  // ── Manual rearm (admin) ──────────────────────────────────────────────────
  rearm(newBalance) {
    const s = this.state;
    s.halted        = false;
    s.pausedUntil   = 0;
    s.pauseLayer    = null;
    s.pauseReason   = '';
    s.dayStartBalance   = newBalance || s.dayStartBalance;
    s.monthStartBalance = newBalance || s.monthStartBalance;
    s.peakBalance       = newBalance || s.peakBalance;
    console.log('[RiskManager] ✅ Manual rearm executed');
  }

  // ── Dynamic position sizing ───────────────────────────────────────────────
  // Returns a multiplier (0.5 → 1.5) to apply to the base bet size.
  // Never reduces below 50% or increases above 2.5×.
  getSizeMultiplier() {
    const s   = this.state;
    const cfg = this.cfg;
    let mult  = 1.0;

    // Consecutive losses reduce size
    if (s.consecutiveLosses > 0) {
      mult = Math.pow(1 - cfg.lossReducePct, s.consecutiveLosses);
    }

    // Consecutive wins increase size (capped)
    if (s.consecutiveWins > 0) {
      mult = Math.min(2.5, Math.pow(1 + cfg.winIncreasePct, s.consecutiveWins));
    }

    // Absolute floor/ceil
    return Math.max(0.5, Math.min(2.5, mult));
  }

  /**
   * Compute the adjusted bet size.
   * @param {number} baseBet - raw Kelly/fixed bet from signal engine
   * @param {number} capital - current balance
   * @returns {number} adjusted bet size, never exceeding maxSizePct of capital
   */
  adjustBetSize(baseBet, capital) {
    if (this.isBlocked().blocked) return 0;
    const mult    = this.getSizeMultiplier();
    const maxBet  = capital * this.cfg.maxSizePct;
    const adjusted = Math.min(baseBet * mult, maxBet);
    return Math.max(0, Math.round(adjusted * 100) / 100);
  }

  // ── Dashboard payload ─────────────────────────────────────────────────────
  getStatus() {
    const s    = this.state;
    const cfg  = this.cfg;
    const now  = Date.now();
    const blk  = this.isBlocked(now);

    return {
      blocked:       blk.blocked,
      blockReason:   blk.reason,
      blockLayer:    blk.layer,
      halted:        s.halted,
      pausedUntil:   s.pausedUntil === Infinity ? null : s.pausedUntil,
      pauseReason:   s.pauseReason,

      // Percentages for dashboard bars
      dailyLossPct:    +(s.dailyLossPct   * 100).toFixed(2),
      monthlyLossPct:  +(s.monthlyLossPct * 100).toFixed(2),
      drawdownPct:     +(s.drawdownPct    * 100).toFixed(2),
      totalLossPct:    +(s.totalLossPct   * 100).toFixed(2),

      // Limits (for progress bar rendering)
      limits: {
        daily:    +(cfg.dailyLossPct   * 100),
        monthly:  +(cfg.monthlyLossPct * 100),
        drawdown: +(cfg.maxDrawdownPct * 100),
        halt:     +(cfg.totalHaltPct   * 100),
      },

      // Layer status
      layers: {
        1: { label: 'Daily Loss',    pct: +(s.dailyLossPct   *100).toFixed(1), limit: +(cfg.dailyLossPct   *100), ok: s.dailyLossPct   < cfg.dailyLossPct   },
        2: { label: 'Monthly Loss',  pct: +(s.monthlyLossPct *100).toFixed(1), limit: +(cfg.monthlyLossPct *100), ok: s.monthlyLossPct < cfg.monthlyLossPct },
        3: { label: 'Max Drawdown',  pct: +(s.drawdownPct    *100).toFixed(1), limit: +(cfg.maxDrawdownPct  *100), ok: s.drawdownPct    < cfg.maxDrawdownPct  },
        4: { label: 'Total Halt',    pct: +(s.totalLossPct   *100).toFixed(1), limit: +(cfg.totalHaltPct    *100), ok: !s.halted },
      },

      // Streak info
      streak: {
        losses: s.consecutiveLosses,
        wins:   s.consecutiveWins,
        sizeMultiplier: +this.getSizeMultiplier().toFixed(3),
      },
    };
  }
}

module.exports = { RiskManager, RISK_DEFAULTS };
