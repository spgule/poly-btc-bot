import React, { useState } from 'react';
import { X, ShieldAlert, Eye, EyeOff, Settings } from 'lucide-react';
import { cn } from '../lib/utils';
import { api } from '../services/api';

function formatMs(ms) {
  if (!ms) return '0m';
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes >= 1440) return `${Math.round(totalMinutes / 1440)}d`;
  if (totalMinutes >= 60) return `${Math.round(totalMinutes / 60)}h`;
  return `${totalMinutes}m`;
}

const S = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 100,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,.75)', backdropFilter: 'blur(6px)',
    padding: '12px',
  },
  modal: {
    background: 'var(--s1)', border: '1px solid var(--border)',
    borderRadius: 8, width: '100%', maxWidth: 480, maxHeight: '90vh',
    overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,.6)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 20px', borderBottom: '1px solid var(--border)',
    background: 'var(--s2)',
  },
  body:   { padding: 20 },
  label:  {
    display: 'block', fontSize: 10, color: 'var(--t2)',
    textTransform: 'uppercase', letterSpacing: '0.1em',
    fontFamily: 'Inter, sans-serif', marginBottom: 4,
  },
  hint:   { fontSize: 9, color: 'var(--t3)', marginBottom: 8, lineHeight: 1.5 },
  field:  { marginBottom: 18 },
  input:  {
    width: '100%', background: 'var(--s2)', border: '1px solid var(--border)',
    color: 'var(--t1)', padding: '10px 12px', borderRadius: 4,
    fontSize: 14, fontFamily: 'JetBrains Mono, monospace', outline: 'none',
  },
  range: { width: '100%', accentColor: 'var(--blue)', cursor: 'pointer' },
};

export default function ConfigModal({ onClose, initialConfig, status }) {
  const [cfg, setCfg] = useState({
    mode:                  initialConfig?.mode || 'SIM',
    capital:               initialConfig?.capital || 1000,
    entryMode:             initialConfig?.entryMode || 'kelly',
    fixedAmount:           initialConfig?.fixedAmount || 50,
    maxBetPct:             initialConfig?.maxBetPct || 10,
    minEdge:               initialConfig?.minEdge || 0.05,
    killThreshold:         initialConfig?.killThreshold || 20,
    killSwitchEnabled:     initialConfig?.killSwitchEnabled ?? true,
    autoTrade:             initialConfig?.autoTrade || false,
    takeProfitPct:         initialConfig?.takeProfitPct || 14,
    stopLossPct:           initialConfig?.stopLossPct   || 16,
    maxOpenPos:            initialConfig?.maxOpenPos     || 10,
    requireStableEdge:     initialConfig?.requireStableEdge ?? false,
    allowDuplicateMarkets: initialConfig?.allowDuplicateMarkets ?? true,
    cooldownMs:            initialConfig?.cooldownMs || 2000,
    liveRiskEnabled:       initialConfig?.liveRiskEnabled ?? true,
    liveDailyPauseDrawdownPct: initialConfig?.liveDailyPauseDrawdownPct || 5,
    liveDailyPauseMs:      initialConfig?.liveDailyPauseMs || 3600000,
    liveMonthlyPauseDrawdownPct: initialConfig?.liveMonthlyPauseDrawdownPct || 15,
    liveMonthlyPauseMs:    initialConfig?.liveMonthlyPauseMs || 2592000000,
    livePauseLossStreak:   initialConfig?.livePauseLossStreak ?? 0,
    livePauseRequireStreak: initialConfig?.livePauseRequireStreak ?? false,
    liveManualRearm:       initialConfig?.liveManualRearm ?? false,
    privateKey:            '',
  });
  const [showKey, setShowKey] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [rearming, setRearming] = useState(false);

  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  async function handleReset() {
    if (!resetConfirm) { setResetConfirm(true); return; }
    setResetting(true); setError(null); setResetConfirm(false);
    try {
      await api.simReset();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setResetting(false);
    }
  }

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      const payload = { ...cfg };
      if (cfg.mode === 'SIM' || !cfg.privateKey) delete payload.privateKey;
      await api.setConfig(payload);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRearm() {
    setRearming(true); setError(null);
    try {
      await api.riskRearm();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setRearming(false);
    }
  }

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Settings size={14} color="var(--blue)" />
            <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.08em', color: 'var(--t1)' }}>
              Bot Configuration
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t2)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        <div style={S.body}>
          {/* Mode */}
          <div style={S.field}>
            <span style={S.label}>Trading Mode</span>
            <span style={S.hint}>SIM uses real market data with a virtual balance. LIVE executes real orders on Polymarket via Polygon.</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {['SIM', 'LIVE'].map(m => (
                <button key={m} onClick={() => set('mode', m)}
                  className={cn('btn', cfg.mode === m
                    ? (m === 'SIM' ? 'btn-green' : 'btn-red')
                    : 'btn-ghost')}
                  style={{ flex: 1 }}>
                  {m === 'SIM' ? '● SIMULATION' : '⚡ LIVE TRADING'}
                </button>
              ))}
            </div>
          </div>

          {/* LIVE warning */}
          {cfg.mode === 'LIVE' && (
            <div style={{ display: 'flex', gap: 8, background: 'var(--red-bg)', border: '1px solid var(--red-b)', borderRadius: 5, padding: '10px 12px', marginBottom: 18, fontSize: 10, color: 'var(--red)', lineHeight: 1.5 }}>
              <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>LIVE mode uses real money.</strong> Real USDC on Polygon will be traded.
                Your private key is stored in memory only — never written to disk.
              </div>
            </div>
          )}

          {/* Capital */}
          <div style={S.field}>
            <span style={S.label}>Starting Capital (USD)</span>
            <span style={S.hint}>Only applied when bot is stopped. Restarts the balance.</span>
            <input style={S.input} type="number" min={10} max={1000000}
              value={cfg.capital} onChange={e => set('capital', Number(e.target.value))} />
          </div>

          {/* ── ENTRY SIZE MODE ── */}
          {cfg.mode === 'LIVE' && (
            <div style={{ ...S.field, background: 'var(--s2)', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 16px', marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
                <div>
                  <span style={{ ...S.label, marginBottom: 2 }}>LIVE Risk Pause</span>
                  <span style={{ ...S.hint, marginBottom: 0 }}>Configura como o LIVE desacelera ou pausa quando o risco sai do controle.</span>
                </div>
                <button
                  onClick={() => set('liveRiskEnabled', !cfg.liveRiskEnabled)}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                    background: cfg.liveRiskEnabled ? 'var(--amber)' : 'var(--s4)',
                    position: 'relative', transition: 'background .2s', flexShrink: 0,
                  }}>
                  <span style={{
                    position: 'absolute', top: 3, borderRadius: '50%', width: 18, height: 18,
                    background: 'var(--t1)', transition: 'left .2s',
                    left: cfg.liveRiskEnabled ? 23 : 3,
                  }} />
                </button>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>Daily LIVE drawdown pause: <strong style={{ color: 'var(--amber)' }}>{cfg.liveDailyPauseDrawdownPct}%</strong></label>
                <span style={S.hint}>Quando o drawdown diario bater esse nivel, o bot pausa novas entradas LIVE pelo tempo configurado.</span>
                <input style={S.range} type="range" min={1} max={20} step={1}
                  value={cfg.liveDailyPauseDrawdownPct}
                  onChange={e => set('liveDailyPauseDrawdownPct', Number(e.target.value))} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>Daily pause duration: <strong style={{ color: 'var(--t1)' }}>{formatMs(cfg.liveDailyPauseMs)}</strong></label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[[300000, '5m'], [900000, '15m'], [1800000, '30m'], [3600000, '1h'], [14400000, '4h'], [86400000, '24h']].map(([ms, label]) => (
                    <button key={ms} onClick={() => set('liveDailyPauseMs', ms)}
                      className={cn('btn btn-sm', cfg.liveDailyPauseMs === ms ? 'btn-green' : 'btn-ghost')}
                      style={{ fontSize: 11 }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>Monthly LIVE drawdown pause: <strong style={{ color: 'var(--red)' }}>{cfg.liveMonthlyPauseDrawdownPct}%</strong></label>
                <span style={S.hint}>Protecao mais forte para descolar o bot quando o modelo passar por um regime ruim.</span>
                <input style={S.range} type="range" min={5} max={40} step={1}
                  value={cfg.liveMonthlyPauseDrawdownPct}
                  onChange={e => set('liveMonthlyPauseDrawdownPct', Number(e.target.value))} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>Monthly pause duration: <strong style={{ color: 'var(--t1)' }}>{formatMs(cfg.liveMonthlyPauseMs)}</strong></label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[[3600000, '1h'], [14400000, '4h'], [86400000, '24h'], [604800000, '7d'], [2592000000, '30d']].map(([ms, label]) => (
                    <button key={ms} onClick={() => set('liveMonthlyPauseMs', ms)}
                      className={cn('btn btn-sm', cfg.liveMonthlyPauseMs === ms ? 'btn-green' : 'btn-ghost')}
                      style={{ fontSize: 11 }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>Loss streak gate: <strong style={{ color: 'var(--t1)' }}>{cfg.livePauseLossStreak || 0}</strong></label>
                <span style={S.hint}>Use 0 para ignorar sequencia de perdas. Com valor maior, voce pode pedir drawdown + N losses seguidas.</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[0, 2, 3, 4, 5, 6].map(n => (
                    <button key={n} onClick={() => set('livePauseLossStreak', n)}
                      className={cn('btn btn-sm', cfg.livePauseLossStreak === n ? 'btn-green' : 'btn-ghost')}
                      style={{ fontSize: 11, minWidth: 38 }}>
                      {n === 0 ? 'Off' : `${n}L`}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
                <div>
                  <span style={S.label}>Require drawdown + streak</span>
                  <span style={{ ...S.hint, marginBottom: 0 }}>ON = so pausa quando o drawdown e a sequencia de perdas acontecerem juntos.</span>
                </div>
                <button
                  onClick={() => set('livePauseRequireStreak', !cfg.livePauseRequireStreak)}
                  style={{
                    width: 44, height: 24, border: 'none', borderRadius: 12, cursor: 'pointer',
                    background: cfg.livePauseRequireStreak ? 'var(--amber)' : 'var(--s4)',
                    position: 'relative', transition: 'background .2s', flexShrink: 0,
                  }}>
                  <span style={{
                    position: 'absolute', top: 3, borderRadius: '50%', width: 18, height: 18,
                    background: 'var(--t1)', transition: 'left .2s',
                    left: cfg.livePauseRequireStreak ? 23 : 3,
                  }} />
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: status?.isPaused ? 12 : 0 }}>
                <div>
                  <span style={S.label}>Manual rearm after pause</span>
                  <span style={{ ...S.hint, marginBottom: 0 }}>ON = depois de uma pausa, o LIVE so volta quando voce revisar e rearmar.</span>
                </div>
                <button
                  onClick={() => set('liveManualRearm', !cfg.liveManualRearm)}
                  style={{
                    width: 44, height: 24, border: 'none', borderRadius: 12, cursor: 'pointer',
                    background: cfg.liveManualRearm ? 'var(--amber)' : 'var(--s4)',
                    position: 'relative', transition: 'background .2s', flexShrink: 0,
                  }}>
                  <span style={{
                    position: 'absolute', top: 3, borderRadius: '50%', width: 18, height: 18,
                    background: 'var(--t1)', transition: 'left .2s',
                    left: cfg.liveManualRearm ? 23 : 3,
                  }} />
                </button>
              </div>

              {status?.mode === 'LIVE' && status?.isPaused && (
                <div style={{ marginTop: 12, background: 'var(--red-bg)', border: '1px solid var(--red-b)', borderRadius: 5, padding: '10px 12px' }}>
                  <div style={{ fontSize: 10, color: 'var(--red)', marginBottom: 4 }}>
                    <strong>LIVE currently paused.</strong> {status.pauseReason || 'Risk protection active.'}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--t2)', marginBottom: 10 }}>
                    {status.manualRearmRequired
                      ? 'Manual rearm is required before LIVE can trade again.'
                      : `Remaining pause: ${formatMs(status.pausedRemainingMs || 0)}.`}
                  </div>
                  <button className="btn btn-red" onClick={handleRearm} disabled={rearming}>
                    {rearming ? 'Rearming…' : 'Clear Pause / Rearm LIVE'}
                  </button>
                </div>
              )}
            </div>
          )}

          <div style={{ ...S.field, background: 'var(--s2)', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 16px', marginBottom: 18 }}>
            <span style={{ ...S.label, marginBottom: 10 }}>Entry Size Mode</span>

            {/* Mode toggle */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              {[['kelly', '📐 Kelly Criterion'], ['fixed', '💵 Fixed Amount']].map(([val, label]) => (
                <button key={val} onClick={() => set('entryMode', val)}
                  className={cn('btn', cfg.entryMode === val ? 'btn-green' : 'btn-ghost')}
                  style={{ flex: 1, fontSize: 11 }}>
                  {label}
                </button>
              ))}
            </div>

            {cfg.entryMode === 'kelly' && (
              <div>
                <label style={S.label}>Max Bet Size: <strong style={{ color: 'var(--t1)' }}>{cfg.maxBetPct}%</strong></label>
                <span style={S.hint}>Kelly sizes each trade proportionally to the detected edge. This cap prevents over-betting.</span>
                <input style={S.range} type="range" min={1} max={25} step={1}
                  value={cfg.maxBetPct} onChange={e => set('maxBetPct', Number(e.target.value))} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--t3)', marginTop: 3 }}>
                  <span>1%</span><span>25%</span>
                </div>
              </div>
            )}

            {cfg.entryMode === 'fixed' && (
              <div>
                <label style={S.label}>Fixed Entry Amount (USD)</label>
                <span style={S.hint}>Every trade uses exactly this amount regardless of edge size.</span>
                {/* Preset chips */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {[5, 10, 25, 50, 100, 200, 500].map(v => (
                    <button key={v} onClick={() => set('fixedAmount', v)}
                      className={cn('btn btn-sm', cfg.fixedAmount === v ? 'btn-green' : 'btn-ghost')}
                      style={{ minWidth: 44, fontSize: 11 }}>
                      ${v}
                    </button>
                  ))}
                </div>
                {/* Custom input */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--t2)', flexShrink: 0 }}>Custom:</span>
                  <div style={{ position: 'relative', flex: 1 }}>
                    <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--t2)' }}>$</span>
                    <input style={{ ...S.input, paddingLeft: 22 }} type="number" min={1} max={10000} step={1}
                      value={cfg.fixedAmount}
                      onChange={e => set('fixedAmount', Number(e.target.value))} />
                  </div>
                </div>
                <div style={{ marginTop: 8, fontSize: 9, color: 'var(--amber)', lineHeight: 1.5 }}>
                  ⚠ At ${cfg.fixedAmount}/trade with ${cfg.capital} capital = max {Math.floor(cfg.capital / cfg.fixedAmount)} consecutive losses before bust.
                </div>
              </div>
            )}
          </div>

          {/* Max Bet % — only shown in Kelly mode outside the entry block */}
          {/* (already rendered inside the Entry Size block above when mode=kelly) */}

          {/* Min Edge */}
          <div style={S.field}>
            <label style={S.label}>Min Edge Threshold: <strong style={{ color: 'var(--t1)' }}>{(cfg.minEdge * 100).toFixed(0)}¢</strong></label>
            <span style={S.hint}>Minimum edge (in cents) required before placing a trade.</span>
            <input style={S.range} type="range" min={1} max={25} step={1}
              value={Math.round(cfg.minEdge * 100)}
              onChange={e => set('minEdge', Number(e.target.value) / 100)} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--t3)', marginTop: 3 }}>
              <span>1¢</span><span>25¢</span>
            </div>
          </div>

          {/* Kill Threshold */}
          <div style={S.field}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
              <label style={{ ...S.label, marginBottom: 0 }}>
                Kill Switch Drawdown: <strong style={{ color: cfg.killSwitchEnabled ? 'var(--red)' : 'var(--t3)' }}>{cfg.killThreshold}%</strong>
              </label>
              <button
                onClick={() => set('killSwitchEnabled', !cfg.killSwitchEnabled)}
                style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                  cursor: 'pointer', border: 'none',
                  background: cfg.killSwitchEnabled ? 'var(--red-bg)' : 'var(--s3)',
                  color: cfg.killSwitchEnabled ? 'var(--red)' : 'var(--t3)',
                }}
              >
                {cfg.killSwitchEnabled ? 'LIGADO' : 'DESLIGADO'}
              </button>
            </div>
            <span style={S.hint}>Para o bot permanentemente quando drawdown exceder este % desde o saldo inicial.</span>
            <input style={{ ...S.range, opacity: cfg.killSwitchEnabled ? 1 : 0.35 }} type="range" min={1} max={100} step={1}
              value={cfg.killThreshold} onChange={e => set('killThreshold', Number(e.target.value))}
              disabled={!cfg.killSwitchEnabled} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--t3)', marginTop: 3 }}>
              <span>1%</span><span>100%</span>
            </div>
          </div>

          {/* ── POSITION MANAGEMENT ── */}
          <div style={{ ...S.field, background: 'var(--s2)', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 16px', marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
              <span style={{ fontSize: 10, color: 'var(--amber)' }}>⚡</span>
              <span style={{ ...S.label, marginBottom: 0 }}>Position Management</span>
              <span style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'Inter', marginLeft: 'auto' }}>
                Scalping arb — entry to exit
              </span>
            </div>

            {/* Take Profit */}
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>
                Take Profit: <strong style={{ color: 'var(--green)' }}>+{cfg.takeProfitPct}%</strong>
                <span style={{ color: 'var(--t3)', fontWeight: 400, marginLeft: 6 }}>
                  (e.g. buy 50¢ → exit at {(50 * (1 + cfg.takeProfitPct / 100)).toFixed(1)}¢)
                </span>
              </label>
              <span style={S.hint}>Close position when mark price gains this % above entry.</span>
              <input style={S.range} type="range" min={1} max={100} step={1}
                value={cfg.takeProfitPct} onChange={e => set('takeProfitPct', Number(e.target.value))} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--t3)', marginTop: 3 }}>
                <span>1%</span><span>100%</span>
              </div>
            </div>

            {/* Stop Loss */}
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>
                Stop Loss: <strong style={{ color: 'var(--red)' }}>-{cfg.stopLossPct}%</strong>
                <span style={{ color: 'var(--t3)', fontWeight: 400, marginLeft: 6 }}>
                  (e.g. buy 50¢ → cut at {(50 * (1 - cfg.stopLossPct / 100)).toFixed(1)}¢)
                </span>
              </label>
              <span style={S.hint}>Close position when mark price falls this % below entry. Limits max loss per trade.</span>
              <input style={S.range} type="range" min={1} max={100} step={1}
                value={cfg.stopLossPct} onChange={e => set('stopLossPct', Number(e.target.value))} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--t3)', marginTop: 3 }}>
                <span>1%</span><span>100%</span>
              </div>
            </div>

            {/* Risk/reward preview */}
            <div style={{ background: 'var(--s3)', borderRadius: 4, padding: '7px 10px', marginBottom: 14, fontSize: 9, lineHeight: 1.7 }}>
              <span style={{ color: 'var(--t2)' }}>R:R ratio: </span>
              <strong style={{ color: cfg.takeProfitPct >= cfg.stopLossPct ? 'var(--green)' : 'var(--red)' }}>
                {(cfg.takeProfitPct / cfg.stopLossPct).toFixed(2)}:1
              </strong>
              <span style={{ color: 'var(--t3)', marginLeft: 8 }}>
                Breakeven winrate: {(cfg.stopLossPct / (cfg.takeProfitPct + cfg.stopLossPct) * 100).toFixed(0)}%
              </span>
            </div>

            {/* Max open positions */}
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>Max Open Positions: <strong style={{ color: 'var(--t1)' }}>{cfg.maxOpenPos}</strong></label>
              <span style={S.hint}>Maximum concurrent open positions. Higher = more entries simultaneously (high-freq mode).</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[1, 2, 3, 5, 8, 10, 15, 20].map(n => (
                  <button key={n} onClick={() => set('maxOpenPos', n)}
                    className={cn('btn btn-sm', cfg.maxOpenPos === n ? 'btn-green' : 'btn-ghost')}
                    style={{ flex: '1 1 auto', fontSize: 11, minWidth: 32 }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Entry cooldown */}
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>Entry Cooldown: <strong style={{ color: 'var(--t1)' }}>
                {cfg.cooldownMs >= 1000 ? `${cfg.cooldownMs / 1000}s` : `${cfg.cooldownMs}ms`}
              </strong></label>
              <span style={S.hint}>Minimum time between entries. Shared with LIVE safety rules, so the practical minimum is 2s.</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[[2000,'2s'],[5000,'5s'],[10000,'10s'],[15000,'15s'],[30000,'30s'],[60000,'60s']].map(([ms, label]) => (
                  <button key={ms} onClick={() => set('cooldownMs', ms)}
                    className={cn('btn btn-sm', cfg.cooldownMs === ms ? 'btn-green' : 'btn-ghost')}
                    style={{ flex: '1 1 auto', fontSize: 11 }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Require stable edge toggle */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <span style={S.label}>Require Stable Edge</span>
                <span style={{ ...S.hint, marginBottom: 0 }}>ON = wait 1.5s of consistent edge (safer). OFF = fire immediately (high-freq).</span>
              </div>
              <button
                onClick={() => set('requireStableEdge', !cfg.requireStableEdge)}
                style={{
                  width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                  background: cfg.requireStableEdge ? 'var(--amber)' : 'var(--s4)',
                  position: 'relative', transition: 'background .2s', flexShrink: 0, marginLeft: 12,
                }}>
                <span style={{
                  position: 'absolute', top: 3, borderRadius: '50%', width: 18, height: 18,
                  background: 'var(--t1)', transition: 'left .2s',
                  left: cfg.requireStableEdge ? 23 : 3,
                }} />
              </button>
            </div>
          </div>

          {/* Auto-trade toggle */}
          <div style={{ ...S.field, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <span style={S.label}>Auto-Trade</span>
              <span style={S.hint}>Execute automatically when edge threshold is met.</span>
            </div>
            <button
              onClick={() => set('autoTrade', !cfg.autoTrade)}
              style={{
                width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                background: cfg.autoTrade ? 'var(--amber)' : 'var(--s4)',
                position: 'relative', transition: 'background .2s',
              }}>
              <span style={{
                position: 'absolute', top: 3, borderRadius: '50%', width: 18, height: 18,
                background: 'var(--t1)', transition: 'left .2s',
                left: cfg.autoTrade ? 23 : 3,
              }} />
            </button>
          </div>

          {/* Private key (LIVE only) */}
          {cfg.mode === 'LIVE' && (
            <div style={S.field}>
              <span style={S.label}>Private Key (Polygon Wallet)</span>
              <span style={S.hint}>64-character hex key. Stored in server memory only, never logged or persisted.</span>
              <div style={{ position: 'relative' }}>
                <input
                  style={{ ...S.input, paddingRight: 36, letterSpacing: showKey ? 'normal' : '0.3em' }}
                  type={showKey ? 'text' : 'password'}
                  placeholder="0x... or hex without prefix"
                  value={cfg.privateKey}
                  onChange={e => set('privateKey', e.target.value)}
                />
                <button
                  onClick={() => setShowKey(s => !s)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t2)', display: 'flex' }}>
                  {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{ marginBottom: 14, padding: '8px 12px', background: 'var(--red-bg)', border: '1px solid var(--red-b)', borderRadius: 4, fontSize: 10, color: 'var(--red)' }}>
              {error}
            </div>
          )}

          {/* SIM Reset — only visible in SIM mode */}
          {cfg.mode === 'SIM' && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 16 }}>
              <span style={S.label}>Danger Zone</span>
              <span style={S.hint}>Wipes all SIM trades, positions and resets balance to starting capital. Irreversible.</span>
              <button
                className="btn btn-red"
                style={{ width: '100%', marginTop: 6 }}
                onClick={handleReset}
                disabled={resetting}
              >
                {resetting ? 'Resetting…' : resetConfirm ? '⚠ Click again to confirm reset' : '🗑 Reset SIM Data'}
              </button>
              {resetConfirm && (
                <div style={{ fontSize: 9, color: 'var(--red)', marginTop: 4, textAlign: 'center' }}>
                  All trades and P&L will be permanently erased.
                </div>
              )}
            </div>
          )}

          {/* Footer buttons */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-green" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Config'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
