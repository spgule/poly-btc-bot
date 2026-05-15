import React, { useState, useEffect } from 'react';
import { Shield, AlertTriangle, TrendingUp, TrendingDown, Activity, Zap } from 'lucide-react';
import { cn } from '../lib/utils';

// ─── Formatters ─────────────────────────────────────────────────────────────
const fmtPct = (n, dec = 1) => `${Number(n || 0).toFixed(dec)}%`;
const fmtAge = (ms) => {
  if (!ms || ms > 3600000) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
};

// ─── Mini progress bar ────────────────────────────────────────────────────────
function ProgressBar({ value, limit, color, height = 5 }) {
  const pct = Math.min(100, (value / Math.max(limit, 0.01)) * 100);
  const barColor = pct >= 90 ? 'var(--red)' : pct >= 60 ? 'var(--amber)' : color || 'var(--green)';
  return (
    <div style={{ background: 'var(--s3)', borderRadius: 3, height, overflow: 'hidden', position: 'relative' }}>
      <div style={{
        height: '100%', width: `${pct}%`, borderRadius: 3,
        background: barColor, transition: 'width .6s, background .3s',
      }} />
    </div>
  );
}

// ─── Risk Manager Panel ────────────────────────────────────────────────────────
export function RiskPanel({ riskStatus }) {
  if (!riskStatus) {
    return (
      <div style={{ padding: '12px 14px', color: 'var(--t3)', fontSize: 10, textAlign: 'center' }}>
        <Activity size={14} style={{ opacity: 0.4, display: 'block', margin: '0 auto 6px' }} />
        Aguardando Risk Manager…
      </div>
    );
  }

  const { blocked, blockReason, layers, streak } = riskStatus;

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', overflowY: 'auto' }}>
      {/* Status header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Shield size={11} color={blocked ? 'var(--red)' : 'var(--green)'} />
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', color: blocked ? 'var(--red)' : 'var(--green)', textTransform: 'uppercase' }}>
            {blocked ? 'BLOQUEADO' : 'PROTEGIDO'}
          </span>
        </div>
        {streak && (
          <div style={{ fontSize: 8, color: 'var(--t3)' }}>
            Size: <span style={{ color: 'var(--amber)', fontWeight: 700 }}>{(streak.sizeMultiplier || 1).toFixed(2)}×</span>
          </div>
        )}
      </div>

      {/* Block reason banner */}
      {blocked && blockReason && (
        <div style={{
          background: 'rgba(239,68,68,.12)', border: '1px solid var(--red)',
          borderRadius: 4, padding: '6px 8px', fontSize: 8,
          color: 'var(--red)', lineHeight: 1.5,
        }}>
          <AlertTriangle size={9} style={{ display: 'inline', marginRight: 4 }} />
          {blockReason}
        </div>
      )}

      {/* 4 Layers */}
      {layers && Object.values(layers).map((layer) => (
        <div key={layer.label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 8, color: 'var(--t2)', fontWeight: 600 }}>{layer.label}</span>
            <span style={{
              fontSize: 8, fontWeight: 700,
              color: layer.ok ? 'var(--green)' : 'var(--red)',
            }}>
              {fmtPct(layer.pct)} / {fmtPct(layer.limit)}
            </span>
          </div>
          <ProgressBar value={layer.pct} limit={layer.limit} />
        </div>
      ))}

      {/* Streak info */}
      {streak && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4,
          background: 'var(--s2)', borderRadius: 4, padding: '5px 7px',
        }}>
          {[
            { label: 'Perdas', value: streak.losses, color: streak.losses > 0 ? 'var(--red)' : 'var(--t3)' },
            { label: 'Ganhos', value: streak.wins, color: streak.wins > 0 ? 'var(--green)' : 'var(--t3)' },
            { label: 'Tamanho', value: `${(streak.sizeMultiplier || 1).toFixed(2)}×`, color: streak.sizeMultiplier > 1 ? 'var(--green)' : streak.sizeMultiplier < 0.9 ? 'var(--amber)' : 'var(--t2)' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 7, color: 'var(--t3)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
              <div style={{ fontSize: 11, fontWeight: 800, color }}>{value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Signal Fusion Panel ───────────────────────────────────────────────────────
export function FusionPanel({ fusionStatus }) {
  if (!fusionStatus) {
    return (
      <div style={{ padding: '12px 14px', color: 'var(--t3)', fontSize: 10, textAlign: 'center' }}>
        <Activity size={14} style={{ opacity: 0.4, display: 'block', margin: '0 auto 6px' }} />
        Aguardando Signal Fusion…
      </div>
    );
  }

  const { composite, fearGreed, spike, divergence } = fusionStatus;
  const dir = composite?.direction || 0;
  const score = composite?.score || 0;
  const absScore = Math.abs(score);

  const dirColor = dir > 0 ? 'var(--green)' : dir < 0 ? 'var(--red)' : 'var(--t3)';
  const dirLabel = dir > 0 ? 'BUY YES' : dir < 0 ? 'BUY NO' : 'NEUTRO';

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Zap size={11} color="var(--amber)" />
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', color: 'var(--t1)', textTransform: 'uppercase' }}>
            Signal Fusion
          </span>
        </div>
        <span style={{
          fontSize: 8, fontWeight: 800, color: dirColor,
          background: `${dirColor}20`, borderRadius: 3, padding: '2px 6px',
        }}>
          {dirLabel}
        </span>
      </div>

      {/* Composite score bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, marginBottom: 4, color: 'var(--t2)' }}>
          <span>Score composto</span>
          <span style={{ fontWeight: 700, color: dirColor }}>{(score * 100).toFixed(0)}%</span>
        </div>
        <div style={{ background: 'var(--s3)', borderRadius: 3, height: 6, position: 'relative', overflow: 'hidden' }}>
          {/* Center line */}
          <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--border)' }} />
          {/* Score bar */}
          <div style={{
            position: 'absolute',
            left: dir >= 0 ? '50%' : `${50 - absScore * 50}%`,
            width: `${absScore * 50}%`,
            height: '100%',
            background: dirColor,
            transition: 'all .5s',
          }} />
        </div>
      </div>

      {/* Fear & Greed */}
      {fearGreed && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'var(--s2)', borderRadius: 4, padding: '5px 8px',
        }}>
          <div>
            <div style={{ fontSize: 7, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Fear &amp; Greed</div>
            <div style={{ fontSize: 9, color: 'var(--t2)', marginTop: 1 }}>{fearGreed.classification}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{
              fontSize: 18, fontWeight: 900, lineHeight: 1,
              color: fearGreed.value >= 60 ? 'var(--green)' : fearGreed.value <= 40 ? 'var(--red)' : 'var(--amber)',
            }}>
              {fearGreed.value}
            </div>
            <div style={{ fontSize: 7, color: 'var(--t3)' }}>age: {fmtAge(fearGreed.age)}</div>
          </div>
        </div>
      )}

      {/* Coinbase divergence */}
      {divergence && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--t2)' }}>
            <span>Coinbase Divergência</span>
            <span style={{
              fontWeight: 700,
              color: Math.abs(divergence.divergencePct) >= 0.3 ? 'var(--amber)' : 'var(--t3)',
            }}>
              {divergence.cbPrice > 0 ? `${divergence.divergencePct > 0 ? '+' : ''}${divergence.divergencePct.toFixed(2)}%` : '—'}
            </span>
          </div>
          {divergence.cbPrice > 0 && (
            <div style={{ display: 'flex', gap: 6, fontSize: 7, color: 'var(--t3)' }}>
              <span>CB: ${divergence.cbPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
              <span>•</span>
              <span>age: {fmtAge(divergence.age)}</span>
            </div>
          )}
        </div>
      )}

      {/* Spike detector */}
      {spike && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: spike.active ? 'rgba(239,68,68,.08)' : 'var(--s2)',
          border: spike.active ? '1px solid var(--red)' : '1px solid transparent',
          borderRadius: 4, padding: '5px 8px',
          transition: 'all .3s',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {spike.active
              ? (spike.direction > 0 ? <TrendingUp size={10} color="var(--green)" /> : <TrendingDown size={10} color="var(--red)" />)
              : <Activity size={10} color="var(--t3)" />
            }
            <span style={{ fontSize: 8, color: spike.active ? 'var(--red)' : 'var(--t3)', fontWeight: 700 }}>
              {spike.active ? 'SPIKE DETECTADO' : 'Spike Detector'}
            </span>
          </div>
          <span style={{ fontSize: 9, fontWeight: 800, color: spike.active ? 'var(--red)' : 'var(--t3)' }}>
            {spike.sizeP > 0 ? `${spike.sizeP.toFixed(2)}%` : '—'}
          </span>
        </div>
      )}

      {/* Sources summary */}
      {composite?.sources && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3 }}>
          {Object.entries(composite.sources).map(([key, src]) => {
            const dir = src.dir || 0;
            const dotColor = dir > 0 ? 'var(--green)' : dir < 0 ? 'var(--red)' : 'var(--border)';
            return (
              <div key={key} style={{
                background: 'var(--s2)', borderRadius: 3, padding: '4px 4px', textAlign: 'center',
                border: `1px solid ${dir !== 0 ? dotColor + '40' : 'transparent'}`,
              }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor, margin: '0 auto 3px' }} />
                <div style={{ fontSize: 6, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {key === 'fearGreed' ? 'F&G' : key.charAt(0).toUpperCase() + key.slice(1, 4)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Combined widget (compact, for sidebar) ───────────────────────────────────
export function FusionRiskWidget({ riskStatus, fusionStatus }) {
  const [tab, setTab] = useState('risk');

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Tab switcher */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {[['risk', 'Risk'], ['fusion', 'Fusion']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              flex: 1, padding: '5px 0', background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: tab === key ? 'var(--t1)' : 'var(--t3)',
              borderBottom: tab === key ? '2px solid var(--amber)' : '2px solid transparent',
              transition: 'all .15s',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {tab === 'risk'   ? <RiskPanel   riskStatus={riskStatus}     /> : null}
        {tab === 'fusion' ? <FusionPanel fusionStatus={fusionStatus} /> : null}
      </div>
    </div>
  );
}
