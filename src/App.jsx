import React, { useState, useEffect, useRef, useMemo } from 'react';
import GridLayout, { WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  Play, Square, Settings, Wifi, WifiOff, Zap,
  TrendingUp, TrendingDown, Activity, AlertTriangle, X,
  LayoutDashboard, Eye, EyeOff, RotateCcw, GripHorizontal, ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { cn } from './lib/utils';
import { api, getWsUrl, BASE } from './services/api';
import ConfigModal from './components/ConfigModal';
import CandleChart from './components/CandleChart';

const RGL = WidthProvider(GridLayout);

// ─── MOBILE DETECTION ─────────────────────────────────────────────────────────
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

// ─── GRID CONSTANTS ──────────────────────────────────────────────────────────
const COLS      = 36;
const ROW_H     = 18;
const MARGIN    = [6, 6];
const LS_LAYOUT = 'ptb-layout-v3';
const LS_HIDDEN = 'ptb-hidden-v4';

const DEFAULT_LAYOUT = [
  { i: 'signal',    x: 0,  y: 0,  w: 8,  h: 16, minW: 6,  minH: 10 },
  { i: 'markets',   x: 0,  y: 16, w: 8,  h: 20, minW: 5,  minH: 8  },
  { i: 'chart',     x: 8,  y: 0,  w: 20, h: 22, minW: 10, minH: 14 },
  { i: 'edge',      x: 8,  y: 22, w: 20, h: 14, minW: 8,  minH: 8  },
  { i: 'balance',   x: 28, y: 0,  w: 8,  h: 8,  minW: 5,  minH: 5  },
  { i: 'stats',     x: 28, y: 8,  w: 8,  h: 12, minW: 5,  minH: 8  },
  { i: 'risk',      x: 28, y: 20, w: 8,  h: 12, minW: 5,  minH: 8  },
  { i: 'positions', x: 28, y: 32, w: 8,  h: 10, minW: 5,  minH: 6  },
  { i: 'trades',    x: 0,  y: 36, w: 20, h: 16, minW: 8,  minH: 8  },
  { i: 'history',   x: 20, y: 36, w: 16, h: 16, minW: 8,  minH: 8  },
];

const PANEL_NAMES = {
  signal:    'Signal',
  markets:   'Mercados BTC',
  chart:     'BTC / USDT',
  edge:      'Live Edge',
  balance:   'Balance Curve',
  stats:     'Performance',
  risk:      'Risk Monitor',
  positions: 'Posições Abertas',
  trades:    'Trade Log',
  history:   'Histórico',
};

// ─── FORMATTERS ──────────────────────────────────────────────────────────────
const fmt$ = (n, dec = 0) => {
  if (n == null || isNaN(n)) return '$0';
  const s = n < 0 ? '-' : n > 0 ? '+' : '';
  const a = Math.abs(n);
  if (a >= 1e6)  return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1000) return `${s}$${(a / 1000).toFixed(1)}K`;
  return `${s}$${a.toFixed(dec)}`;
};
const fmtPrice = (n) =>
  n == null ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const fmtEdge  = (n) =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}¢`;
const TZ       = 'America/Sao_Paulo';
const fmtTime  = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour12: false, timeZone: TZ });
const fmtClock = ()   => new Date().toLocaleTimeString('pt-BR', { hour12: false, timeZone: TZ });
const fmtDate  = (ts) => new Date(ts).toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const fmtBRT   = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('pt-BR', {
    timeZone: TZ, day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

// ─── BOT HOOK ─────────────────────────────────────────────────────────────────
function useBot() {
  const wsRef = useRef(null);
  const [connected, setConnected]           = useState(false);
  const [market, setMarket]                 = useState({
    btcPrice: 0, btcChange24h: 0, laggedPrice: 0,
    impliedProb: 0.5, polyOdds: 0.5, edge: 0,
    edgeHistory: [], priceChart: [], priceSource: 'binance',
  });
  const [candles, setCandles]               = useState([]);
  const [currentCandle, setCurrentCandle]   = useState(null);
  const [signal, setSignal]                 = useState(null);
  const [status, setStatus]                 = useState({
    mode: 'SIM', active: false,
    balance: 1000, startBalance: 1000, peakBalance: 1000, drawdown: 0,
    binanceConnected: false, priceSource: 'binance',
    stats: { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, todayPnl: 0, streak: 0 },
    config: {
      mode: 'SIM', capital: 1000,
      entryMode: 'kelly', fixedAmount: 30,
      maxBetPct: 6, minEdge: 0.03,
      killThreshold: 20, autoTrade: false, hasPrivateKey: false,
      takeProfitPct: 14, stopLossPct: 16, posTimeoutMs: 150000,
      maxOpenPos: 10, requireStableEdge: false, allowDuplicateMarkets: true,
      cooldownMs: 500,
    },
  });
  const [trades, setTrades]       = useState([]);
  const [markets, setMarkets]     = useState([]);
  const [positions, setPositions] = useState([]);
  const [actionPending, setActionPending] = useState(false);
  const [botError, setBotError]           = useState(null);

  // ── HTTP polling fallback when WS is down ──────────────────────────────────
  // Every 2s when disconnected, every 30s when connected (safety net)
  useEffect(() => {
    async function poll() {
      try {
        const [st, mkts, prices, candleData] = await Promise.all([
          api.getStatus(),
          api.getMarkets(),
          fetch(BASE + '/api/prices').then(r => r.json()).catch(() => null),
          api.getCandles().catch(() => null),
        ]);
        if (st) setStatus(st);
        if (mkts) setMarkets(mkts);
        if (prices) {
          setMarket(d => ({
            ...d,
            btcPrice: prices.current ?? d.btcPrice,
            btcChange24h: prices.change24h ?? d.btcChange24h,
            priceSource: prices.source ?? d.priceSource,
            priceChart: prices.chart ?? d.priceChart,
          }));
        }
        if (candleData?.candles) setCandles(candleData.candles);
        if (candleData?.currentCandle) setCurrentCandle(candleData.currentCandle);
        if (candleData) {
          setMarket(d => ({
            ...d,
            edgeHistory: candleData.edgeHistory ?? d.edgeHistory,
            impliedProb: candleData.impliedProb ?? d.impliedProb,
            polyOdds: candleData.polyOdds ?? d.polyOdds,
            edge: candleData.edge ?? d.edge,
          }));
        }
      } catch (_) { /* ignore */ }
    }
    poll(); // immediate on mount
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  // ── Candles + edge polling (independent of WS) ────────────────────────────
  // Runs every 3s always — ensures chart shows data even when WS is glitchy
  useEffect(() => {
    let destroyed = false;
    function connect() {
      if (destroyed) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;
      ws.onopen    = () => { if (!destroyed) setConnected(true); };
      ws.onclose   = () => { if (!destroyed) { setConnected(false); setTimeout(connect, 3000); } };
      ws.onerror   = () => ws.close();
      ws.onmessage = (ev) => {
        if (destroyed) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg.type) {
          case 'MARKET_DATA':
            setMarket(d => ({ ...d, ...msg.data }));
            if (msg.data.candles?.length) setCandles(msg.data.candles);
            if (msg.data.currentCandle)   setCurrentCandle(msg.data.currentCandle);
            break;
          case 'CONNECTION':
            setStatus(d => ({ ...d, binanceConnected: msg.data.binanceConnected, priceSource: msg.data.priceSource }));
            break;
          case 'SIGNAL':         setSignal(msg.data); break;
          case 'STATUS':         setStatus(msg.data); break;
          case 'TRADE':          setTrades(t => [msg.data, ...t].slice(0, 500)); break;
          case 'TRADES_HISTORY': setTrades(msg.data); break;
          case 'MARKETS':        setMarkets(msg.data); break;
          case 'POSITIONS':      setPositions(msg.data); break;
          case 'POSITION_OPENED':
            setPositions(prev => [msg.data, ...prev.filter(p => p.id !== msg.data.id)]);
            break;
          default: break;
        }
      };
    }
    connect();
    return () => { destroyed = true; wsRef.current?.close(); };
  }, []);

  const startBot      = () => {
    if (actionPending) return;
    setBotError(null);
    setActionPending(true);
    api.startBot()
      .then(r => {
        if (r && r.active !== undefined) setStatus(d => ({ ...d, active: r.active }));
        else setStatus(d => ({ ...d, active: true }));
      })
      .catch(e => { setBotError(e.message || 'Erro ao iniciar o bot'); console.error(e); })
      .finally(() => setActionPending(false));
  };
  const stopBot       = () => {
    if (actionPending) return;
    setBotError(null);
    setActionPending(true);
    api.stopBot()
      .then(r => {
        if (r && r.active !== undefined) setStatus(d => ({ ...d, active: r.active }));
        else setStatus(d => ({ ...d, active: false }));
      })
      .catch(e => { setBotError(e.message || 'Erro ao parar o bot'); console.error(e); })
      .finally(() => setActionPending(false));
  };
  const manualTrade   = () => api.manualTrade().catch(console.error);
  const closePosition = (id) => api.closePosition(id).catch(console.error);

  return { connected, market, candles, currentCandle, signal, status, trades, markets, positions, startBot, stopBot, manualTrade, closePosition, actionPending, botError, setBotError };
}

// ─── CHART TOOLTIP ────────────────────────────────────────────────────────────
const ChartTip = ({ active, payload, formatter }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--s2)', border: '1px solid var(--border)', padding: '5px 9px', borderRadius: 4, fontSize: 10 }}>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>{p.name}: {formatter ? formatter(p.value) : p.value}</div>
      ))}
    </div>
  );
};

// ─── PANEL SHELL ──────────────────────────────────────────────────────────────
function PanelShell({ id, label, badge, onHide, children }) {
  const [confirmHide, setConfirmHide] = React.useState(false);
  const confirmTimer = React.useRef(null);

  const handleHideClick = () => {
    if (confirmHide) {
      clearTimeout(confirmTimer.current);
      setConfirmHide(false);
      onHide(id);
    } else {
      setConfirmHide(true);
      confirmTimer.current = setTimeout(() => setConfirmHide(false), 2000);
    }
  };

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: 'var(--s1)', border: '1px solid var(--border)',
      borderRadius: 6, overflow: 'hidden',
    }}>
      <div
        className="card-header drag-handle"
        style={{ cursor: 'grab', userSelect: 'none', flexShrink: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <GripHorizontal size={9} color="var(--t3)" style={{ flexShrink: 0 }} />
          <span className="card-label">{label}</span>
          {badge}
        </div>
        <button
          onClick={handleHideClick}
          style={{
            background: confirmHide ? 'var(--amber)' : 'none',
            border: 'none', padding: '2px 6px',
            cursor: 'pointer',
            color: confirmHide ? '#000' : 'var(--t3)',
            display: 'flex', alignItems: 'center', gap: 3,
            borderRadius: 3, fontSize: 8, fontWeight: confirmHide ? 700 : 400,
            transition: 'all .15s',
          }}
          title={confirmHide ? 'Clique novamente para confirmar' : 'Ocultar painel'}
        >
          {confirmHide ? <><EyeOff size={9} /> confirmar?</> : <EyeOff size={9} />}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  );
}

// ─── TOP BAR MOBILE ───────────────────────────────────────────────────────────
function TopBarMobile({ status, market, connected, clock, onStart, onStop, onSettings, actionPending }) {
  const up    = (market.btcChange24h ?? 0) >= 0;
  const stats = status.stats || {};
  const wr    = stats.totalTrades > 0 ? Math.round(stats.wins / stats.totalTrades * 100) : 0;

  return (
    <header className="top-bar-mobile">
      {/* Row 1: logo + price + controls */}
      <div className="top-bar-mobile-row1">
        <Zap size={14} color="var(--amber)" style={{ flexShrink: 0 }} />
        <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: '0.1em', color: 'var(--t1)' }}>POLY·BTC</span>
        <span className={cn('badge', status.mode === 'LIVE' ? 'badge-red' : 'badge-blue')} style={{ fontSize: 8 }}>{status.mode}</span>
        <span className={cn('tb-conn', connected && status.binanceConnected ? 'tb-conn-ok' : 'tb-conn-err')} style={{ fontSize: 9 }}>
          {connected && status.binanceConnected ? <Wifi size={10} /> : <WifiOff size={10} />}
          {connected ? (status.binanceConnected ? 'LIVE' : 'SYNC') : 'OFF'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={onSettings} title="Configurações" style={{ minHeight: 36, padding: '6px 12px' }}>
          <Settings size={16} />
        </button>
        {status.active
          ? <button className="btn btn-red" onClick={onStop} disabled={actionPending} style={{ minHeight: 36 }}>
              <Square size={12} /> {actionPending ? '…' : 'STOP'}
            </button>
          : <button className="btn btn-green" onClick={onStart} disabled={actionPending} style={{ minHeight: 36 }}>
              <Play size={12} /> {actionPending ? '…' : 'START'}
            </button>
        }
      </div>
      {/* Row 2: scrollable stats chips */}
      <div className="top-bar-mobile-row2">
        <div className="mobile-stat-chip">
          <span className="mobile-stat-chip-label">BTC</span>
          <span className="mobile-stat-chip-val" style={{ color: up ? 'var(--green)' : 'var(--red)', fontSize: 14 }}>
            {market.btcPrice ? fmtPrice(market.btcPrice) : '—'}
          </span>
        </div>
        <div className="mobile-stat-chip">
          <span className="mobile-stat-chip-label">BALANCE</span>
          <span className="mobile-stat-chip-val" style={{ color: status.balance >= (status.startBalance || 1000) ? 'var(--green)' : 'var(--red)' }}>
            {fmtPrice(status.balance)}
          </span>
        </div>
        <div className="mobile-stat-chip">
          <span className="mobile-stat-chip-label">P&L</span>
          <span className="mobile-stat-chip-val" style={{ color: (stats.totalPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {fmt$(stats.totalPnl, 2)}
          </span>
        </div>
        <div className="mobile-stat-chip">
          <span className="mobile-stat-chip-label">TODAY</span>
          <span className="mobile-stat-chip-val" style={{ color: (stats.todayPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {fmt$(stats.todayPnl, 2)}
          </span>
        </div>
        <div className="mobile-stat-chip">
          <span className="mobile-stat-chip-label">WIN%</span>
          <span className="mobile-stat-chip-val" style={{ color: wr >= 55 ? 'var(--green)' : wr >= 45 ? 'var(--amber)' : 'var(--red)' }}>
            {wr}%
          </span>
        </div>
        <div className="mobile-stat-chip">
          <span className="mobile-stat-chip-label">DD</span>
          <span className="mobile-stat-chip-val" style={{ color: (status.drawdown || 0) > 0.1 ? 'var(--red)' : 'var(--t2)' }}>
            {((status.drawdown || 0) * 100).toFixed(1)}%
          </span>
        </div>
        <div className="mobile-stat-chip">
          <span className="mobile-stat-chip-label">BRT</span>
          <span className="mobile-stat-chip-val" style={{ fontSize: 11 }}>{clock}</span>
        </div>
      </div>
    </header>
  );
}

// ─── COLLAPSIBLE MOBILE CARD ──────────────────────────────────────────────────
function MobileCard({ title, badge, defaultOpen = true, children, bodyStyle }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mobile-card">
      <div className="mobile-card-header" onClick={() => setOpen(v => !v)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="mobile-card-title">{title}</span>
          {badge}
        </div>
        {open ? <ChevronDown size={12} color="var(--t3)" /> : <ChevronRight size={12} color="var(--t3)" />}
      </div>
      {open && (
        <div className="mobile-card-body" style={bodyStyle}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── TOP BAR ─────────────────────────────────────────────────────────────────
function TopBar({ status, market, connected, clock, onStart, onStop, onSettings, onLayout, actionPending }) {
  const up    = (market.btcChange24h ?? 0) >= 0;
  const stats = status.stats || {};
  const wr    = stats.totalTrades > 0 ? Math.round(stats.wins / stats.totalTrades * 100) : 0;

  return (
    <header className="top-bar">
      <div className="tb-brand">
        <Zap size={13} color="var(--amber)" />
        <span className="tb-logo">POLY·BTC</span>
        <span className={cn('badge', status.mode === 'LIVE' ? 'badge-red' : 'badge-blue')} style={{ fontSize: 8 }}>
          {status.mode}
        </span>
        <span className={cn('tb-conn', connected && status.binanceConnected ? 'tb-conn-ok' : 'tb-conn-err')}>
          {connected && status.binanceConnected ? <Wifi size={8} /> : <WifiOff size={8} />}
          {connected ? (status.binanceConnected ? 'LIVE' : 'SYNC') : 'OFF'}
        </span>
      </div>

      <div className="tb-divider" />

      <div className="tb-price">
        <span className="tb-price-val" style={{ color: up ? 'var(--green)' : 'var(--red)' }}>
          {market.btcPrice ? fmtPrice(market.btcPrice) : '—'}
        </span>
        <span className="tb-price-chg" style={{ color: up ? 'var(--green)' : 'var(--red)' }}>
          {market.btcChange24h != null ? `${up ? '+' : ''}${market.btcChange24h.toFixed(2)}%` : ''}
        </span>
      </div>

      <div className="tb-divider" />

      <div className="tb-stats">
        {[
          { l: 'BALANCE',  v: fmtPrice(status.balance), c: status.balance >= (status.startBalance || 1000) ? 'var(--green)' : 'var(--red)' },
          { l: 'P&L',      v: fmt$(stats.totalPnl, 2),  c: (stats.totalPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' },
          { l: 'TODAY',    v: fmt$(stats.todayPnl, 2),  c: (stats.todayPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' },
          { l: 'WIN RATE', v: `${wr}%`,                  c: wr >= 55 ? 'var(--green)' : wr >= 45 ? 'var(--amber)' : 'var(--red)' },
          { l: 'TRADES',   v: stats.totalTrades || 0,   c: 'var(--t1)' },
          { l: 'DRAWDOWN', v: `${((status.drawdown || 0) * 100).toFixed(1)}%`, c: (status.drawdown || 0) > 0.1 ? 'var(--red)' : 'var(--t2)' },
        ].map(s => (
          <div key={s.l} className="tb-stat">
            <span className="tb-stat-label">{s.l}</span>
            <span className="tb-stat-val" style={{ color: s.c }}>{s.v}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <div className="tb-controls">
        <div className="tb-clock">
          <span className="tb-clock-time">{clock}</span>
          <span className="tb-clock-tz">BRT</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onLayout} title="Gerenciar painéis">
          <LayoutDashboard size={12} />
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onSettings} title="Configurações">
          <Settings size={12} />
        </button>
        {status.active
          ? <button className="btn btn-red" onClick={onStop} disabled={actionPending}>
              <Square size={10} /> {actionPending ? 'PARANDO…' : 'STOP'}
            </button>
          : <button className="btn btn-green" onClick={onStart} disabled={actionPending}>
              <Play size={10} /> {actionPending ? 'INICIANDO…' : 'START BOT'}
            </button>
        }
      </div>
    </header>
  );
}

// ─── LAYOUT MENU ──────────────────────────────────────────────────────────────
function LayoutMenu({ hidden, onToggle, onReset, onClose }) {
  return (
    <div style={{
      position: 'fixed', top: 60, right: 16, zIndex: 200,
      background: 'var(--s2)', border: '1px solid var(--border)',
      borderRadius: 8, minWidth: 230,
      boxShadow: '0 8px 32px rgba(0,0,0,.7)',
    }}>
      <div style={{
        padding: '10px 14px', display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Painéis
        </span>
        <div style={{ display: 'flex', gap: 5 }}>
          <button className="btn btn-ghost btn-sm" onClick={onReset} style={{ gap: 4, fontSize: 9 }}>
            <RotateCcw size={9} /> Reset
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: '3px 7px' }}>
            <X size={10} />
          </button>
        </div>
      </div>
      <div style={{ padding: '5px 0' }}>
        {Object.entries(PANEL_NAMES).map(([id, name]) => {
          const visible = !hidden.has(id);
          return (
            <button
              key={id}
              onClick={() => onToggle(id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '8px 14px',
                background: 'none', border: 'none', cursor: 'pointer',
                color: visible ? 'var(--t1)' : 'var(--t3)',
                transition: 'background 0.1s', textAlign: 'left',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--s3)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              {visible
                ? <Eye size={11} color="var(--green)" />
                : <EyeOff size={11} color="var(--t3)" />
              }
              <span style={{ fontSize: 11, fontWeight: 500 }}>{name}</span>
              {!visible && <span style={{ marginLeft: 'auto', fontSize: 8, color: 'var(--t3)', fontFamily: 'Inter' }}>oculto</span>}
            </button>
          );
        })}
      </div>
      <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)' }}>
        <span style={{ fontSize: 8, color: 'var(--t3)', fontFamily: 'Inter', lineHeight: 1.5 }}>
          Arraste pelo cabeçalho · Redimensione pelo canto inferior direito
        </span>
      </div>
    </div>
  );
}

// ─── SIGNAL BODY ──────────────────────────────────────────────────────────────
function SignalBody({ signal, market, status, onManualTrade }) {
  const minEdge   = status.config?.minEdge ?? 0.05;
  const hasSignal = signal && signal.edge >= minEdge;
  const isUp      = signal?.side === 'BUY_YES';
  const edge      = market.edge || 0;
  const absEdge   = Math.abs(edge);
  const edgePct   = Math.min(100, absEdge * 400);

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className={cn('badge', status.active ? 'badge-green' : 'badge-gray')} style={{ fontSize: 7 }}>
          {status.active ? '● RUNNING' : '● IDLE'}
        </span>
        {hasSignal
          ? <span className={cn('badge', isUp ? 'badge-green' : 'badge-red')}>
              {isUp ? '▲ BUY YES' : '▼ BUY NO'} {fmtEdge(signal.edge)}
            </span>
          : <span className="badge badge-gray" style={{ fontSize: 8 }}>SCANNING…</span>
        }
      </div>

      {hasSignal ? (
        <div className={cn('direction-block', isUp ? 'direction-up' : 'direction-down')}>
          {isUp ? <TrendingUp size={26} /> : <TrendingDown size={26} />}
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1 }}>
              {isUp ? 'BUY YES' : 'BUY NO'}
            </div>
            <div style={{ fontSize: 10, opacity: 0.75, marginTop: 3 }}>
              edge {fmtEdge(signal.edge)} · {signal.confidence?.toFixed(0)}% conf
            </div>
          </div>
        </div>
      ) : (
        <div className="direction-idle">
          <Activity size={20} color="var(--t3)" />
          <span style={{ fontSize: 10, color: 'var(--t2)' }}>
            {status.active ? 'Scanning for edge…' : 'Inicie o bot para começar'}
          </span>
        </div>
      )}

      <div className="odds-pair">
        <div className="odds-box">
          <span className="odds-label">Binance Implied</span>
          <span className="odds-val" style={{ color: (market.impliedProb || 0.5) > 0.5 ? 'var(--green)' : 'var(--red)' }}>
            {((market.impliedProb || 0.5) * 100).toFixed(1)}¢
          </span>
        </div>
        <div className="odds-sep">vs</div>
        <div className="odds-box">
          <span className="odds-label">Poly (lag)</span>
          <span className="odds-val" style={{ color: 'var(--t1)' }}>
            {((market.polyOdds || 0.5) * 100).toFixed(1)}¢
          </span>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--t2)', marginBottom: 5 }}>
          <span>Edge</span>
          <span style={{ fontWeight: 700, color: absEdge >= minEdge ? (edge > 0 ? 'var(--green)' : 'var(--red)') : 'var(--t3)' }}>
            {fmtEdge(edge)} <span style={{ opacity: 0.5 }}>/ min {(minEdge * 100).toFixed(0)}¢</span>
          </span>
        </div>
        <div className="edge-track">
          <div style={{
            height: '100%', borderRadius: 3, transition: 'width .4s', width: `${edgePct}%`,
            background: absEdge >= minEdge ? (edge > 0 ? 'var(--green)' : 'var(--red)') : 'var(--border2)',
          }} />
        </div>
      </div>

      {hasSignal && (
        <div className="signal-detail">
          <div className="signal-detail-row">
            <span style={{ color: 'var(--t2)' }}>Mercado</span>
            <span style={{ color: 'var(--t1)', fontWeight: 600, maxWidth: 160, textAlign: 'right', lineHeight: 1.3 }}>
              {signal.question?.slice(0, 48)}
            </span>
          </div>
          <div className="signal-detail-row">
            <span style={{ color: 'var(--t2)' }}>Aposta</span>
            <span style={{ color: 'var(--amber)', fontWeight: 700 }}>{fmt$(signal.betSize, 2)}</span>
          </div>
        </div>
      )}

      {status.config?.autoTrade ? (
        <div className="auto-badge"><Zap size={11} /> AUTO TRADE ATIVO</div>
      ) : (
        <button
          className={cn('btn btn-lg', hasSignal && status.active ? (isUp ? 'btn-green' : 'btn-red') : 'btn-ghost')}
          style={{ width: '100%' }}
          onClick={onManualTrade}
          disabled={!hasSignal || !status.active}>
          {hasSignal && status.active
            ? (isUp ? <><TrendingUp size={11} /> EXECUTAR BUY YES</> : <><TrendingDown size={11} /> EXECUTAR BUY NO</>)
            : 'SEM SINAL'}
        </button>
      )}
    </div>
  );
}

// ─── MARKETS BODY ─────────────────────────────────────────────────────────────
function MarketsBody({ markets }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 8px' }}>
      {markets.length === 0
        ? <div style={{ padding: '18px 0', textAlign: 'center', color: 'var(--t2)', fontSize: 10 }}>
            Conectando ao Polymarket…
          </div>
        : markets.map((m, i) => {
            const yes      = m.outcomePrices?.[0] ?? 0.5;
            const vol      = m.volume >= 1e6 ? `$${(m.volume / 1e6).toFixed(1)}M`
                           : m.volume >= 1000 ? `$${(m.volume / 1000).toFixed(0)}K`
                           : `$${m.volume}`;
            const msLeft   = m.endDate ? new Date(m.endDate).getTime() - Date.now() : null;
            const minLeft  = msLeft != null ? Math.max(0, Math.round(msLeft / 60000)) : null;
            const expiring = minLeft !== null && minLeft <= 10;
            return (
              <div key={m.id || i} className="market-row">
                <div style={{ fontSize: 10, color: 'var(--t1)', marginBottom: 4, lineHeight: 1.4 }}>
                  {m.question.length > 58 ? m.question.slice(0, 56) + '…' : m.question}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <div style={{ display: 'flex', gap: 6, fontSize: 11, fontWeight: 700 }}>
                    <span style={{ color: 'var(--green)' }}>YES {(yes * 100).toFixed(0)}¢</span>
                    <span style={{ color: 'var(--t3)' }}>/</span>
                    <span style={{ color: 'var(--red)' }}>NO {((1 - yes) * 100).toFixed(0)}¢</span>
                  </div>
                  <span style={{ fontSize: 9, color: 'var(--t3)' }}>{vol}</span>
                </div>
                {m.endDate && (
                  <div style={{ fontSize: 8, color: expiring ? 'var(--red)' : 'var(--t3)', marginBottom: 4 }}>
                    ⏱ {fmtBRT(m.endDate)} BRT{minLeft !== null ? ` · ${minLeft}min` : ''}
                  </div>
                )}
                <div className="odds-bar">
                  <div className="odds-yes" style={{ width: `${yes * 100}%` }} />
                  <div className="odds-no" />
                </div>
              </div>
            );
          })}
    </div>
  );
}

// ─── BTC CHART BODY ───────────────────────────────────────────────────────────
function BtcChartBody({ market, candles, currentCandle }) {
  const up   = (market.btcPrice || 0) >= (market.laggedPrice || market.btcPrice || 0);
  const diff = (market.btcPrice || 0) - (market.laggedPrice || market.btcPrice || 0);
  const pct  = market.laggedPrice > 0 ? (diff / market.laggedPrice * 100) : 0;

  return (
    <>
      <div style={{
        padding: '4px 12px', background: 'var(--s2)', borderBottom: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 8 }}>
          <span style={{ fontWeight: 700, color: up ? 'var(--green)' : 'var(--red)' }}>
            {up ? '▲' : '▼'} {Math.abs(pct).toFixed(3)}% vs lag
          </span>
          {market.priceSource === 'binance'
            ? <span className="blink" style={{ color: 'var(--green)' }}>● LIVE</span>
            : market.priceSource === 'binance-rest'
              ? <span style={{ color: 'var(--amber)' }}>● REST</span>
              : <span style={{ color: 'var(--red)' }}>● OFF</span>
          }
          <span style={{ color: 'var(--t3)' }}>candles 5s</span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 8 }}>
          <span style={{ color: 'var(--t2)' }}>
            IMPLIED <span style={{ color: (market.impliedProb || 0.5) > 0.5 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
              {((market.impliedProb || 0.5) * 100).toFixed(1)}¢
            </span>
          </span>
          <span style={{ color: 'var(--t2)' }}>
            POLY <span style={{ color: 'var(--t1)', fontWeight: 700 }}>{((market.polyOdds || 0.5) * 100).toFixed(1)}¢</span>
          </span>
          <span style={{ fontWeight: 700, color: Math.abs(market.edge || 0) > 0.03 ? ((market.edge || 0) > 0 ? 'var(--green)' : 'var(--red)') : 'var(--t3)' }}>
            EDGE {fmtEdge(market.edge || 0)}
          </span>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {candles.length > 0 || currentCandle
          ? <CandleChart candles={candles} currentCandle={currentCandle} />
          : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t2)', fontSize: 10 }}>
              Aguardando dados do Binance…
            </div>
        }
      </div>
    </>
  );
}

// ─── EDGE CHART BODY ──────────────────────────────────────────────────────────
function EdgeChartBody({ market }) {
  const data = (market.edgeHistory || []).slice(-80).map((e, i) => ({
    i,
    binance: parseFloat((e.implied * 100).toFixed(1)),
    poly:    parseFloat((e.poly    * 100).toFixed(1)),
  }));

  return (
    <div style={{ flex: 1, padding: '6px 6px 2px', minHeight: 0 }}>
      {data.length > 2 ? (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
            <XAxis dataKey="i" hide />
            <YAxis domain={[0, 100]} tick={{ fontSize: 8, fill: 'var(--t2)' }} />
            <Tooltip content={<ChartTip formatter={v => `${v}¢`} />} />
            <Line type="monotone" dataKey="binance" stroke="var(--blue)" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Binance" />
            <Line type="monotone" dataKey="poly"    stroke="var(--red)"  strokeWidth={1.5} dot={false} isAnimationActive={false} name="Poly" />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t2)', fontSize: 10 }}>
          Aguardando dados de mercado…
        </div>
      )}
    </div>
  );
}

// ─── BALANCE CURVE BODY ───────────────────────────────────────────────────────
function BalanceCurveBody({ trades, status }) {
  const startBal = status.startBalance || status.config?.capital || 1000;
  const curBal   = status.balance ?? startBal;

  let data;
  if (trades.length === 0) {
    data = [{ i: 0, v: startBal }, { i: 1, v: curBal }];
  } else {
    const chrono = [...trades].reverse();
    data = [{ i: 0, v: startBal }];
    chrono.forEach(t => { if (t.balance != null) data.push({ i: data.length, v: t.balance }); });
    if (Math.abs(data[data.length - 1].v - curBal) > 0.005)
      data.push({ i: data.length, v: curBal });
  }

  const startVal = data[0]?.v ?? startBal;
  const lastVal  = data[data.length - 1]?.v ?? startVal;
  const up       = lastVal >= startVal;
  const pnlPct   = startVal > 0 ? ((lastVal - startVal) / startVal * 100).toFixed(2) : '0.00';
  const color    = up ? 'var(--green)' : 'var(--red)';

  return (
    <>
      <div style={{
        padding: '4px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0, background: 'var(--s2)', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 9, fontWeight: 600, color }}>{up ? '+' : ''}{pnlPct}%</span>
        <span style={{ fontSize: 12, fontWeight: 700, color }}>
          {fmtPrice(lastVal)}
          <span style={{ fontSize: 9, color: 'var(--t2)', fontWeight: 400, marginLeft: 6 }}>/ {fmtPrice(startVal)}</span>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={color} stopOpacity={0.22} />
                <stop offset="95%" stopColor={color} stopOpacity={0}    />
              </linearGradient>
            </defs>
            <YAxis domain={['auto', 'auto']} hide />
            <ReferenceLine y={startVal} stroke="var(--border2)" strokeDasharray="3 3" />
            <Area type="monotone" dataKey="v"
              stroke={color} fill="url(#balGrad)" strokeWidth={1.5}
              dot={data.length < 15} isAnimationActive={false} />
            <Tooltip content={<ChartTip formatter={fmtPrice} />} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

// ─── STATS BODY ───────────────────────────────────────────────────────────────
function StatsBody({ status }) {
  const { stats, drawdown, startBalance, peakBalance, config } = status;
  const wr   = stats.totalTrades > 0 ? stats.wins / stats.totalTrades * 100 : 0;
  const dd   = (drawdown || 0) * 100;
  const kill = config?.killThreshold ?? 20;

  const tiles = [
    { l: 'WIN RATE',  v: `${wr.toFixed(0)}%`,     s: `${stats.wins}W / ${stats.losses}L`,  c: wr >= 55 ? 'var(--green)' : wr >= 45 ? 'var(--amber)' : 'var(--red)' },
    { l: 'TOTAL P&L', v: fmt$(stats.totalPnl, 2), s: `${stats.totalTrades} trades`,         c: (stats.totalPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' },
    { l: 'TODAY P&L', v: fmt$(stats.todayPnl, 2), s: 'desde 00:00 UTC',                     c: (stats.todayPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' },
    { l: 'PEAK',      v: fmtPrice(peakBalance),   s: `início ${fmtPrice(startBalance)}`,    c: 'var(--amber)' },
    { l: 'DRAWDOWN',  v: `${dd.toFixed(1)}%`,     s: `kill @ ${kill}%`,
      c: dd > kill * 0.7 ? 'var(--red)' : dd > kill * 0.4 ? 'var(--amber)' : 'var(--t2)',
      bar: Math.min(100, (dd / kill) * 100), barColor: 'var(--red)' },
    { l: 'STREAK',
      v: stats.streak > 0 ? `+${stats.streak}W` : stats.streak < 0 ? `${stats.streak}L` : '—',
      s: 'sequência atual',
      c: stats.streak > 0 ? 'var(--green)' : stats.streak < 0 ? 'var(--red)' : 'var(--t2)' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, padding: 8, overflowY: 'auto', height: '100%' }}>
      {tiles.map((t, i) => (
        <div key={i} className="stat-tile">
          <span className="stat-label">{t.l}</span>
          <span className="stat-val" style={{ color: t.c, fontSize: 13 }}>{t.v}</span>
          <span className="stat-sub">{t.s}</span>
          {t.bar != null && (
            <div className="progress-track" style={{ marginTop: 4 }}>
              <div className="progress-fill" style={{ width: `${t.bar}%`, background: t.barColor }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── RISK BODY ────────────────────────────────────────────────────────────────
function RiskBody({ status }) {
  const dd    = (status.drawdown || 0) * 100;
  const kill  = status.config?.killThreshold ?? 20;
  const pct   = Math.min(100, (dd / kill) * 100);
  const hot   = dd >= kill * 0.75;
  const color = hot ? 'var(--red)' : dd > kill * 0.4 ? 'var(--amber)' : 'var(--green)';

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', height: '100%' }}>
      {hot && (
        <div style={{
          display: 'flex', gap: 6, background: 'var(--red-bg)', border: '1px solid var(--red-b)',
          borderRadius: 4, padding: '7px 10px', fontSize: 9, color: 'var(--red)',
        }}>
          <AlertTriangle size={10} style={{ flexShrink: 0, marginTop: 1 }} />
          Aproximando kill switch — pare o bot
        </div>
      )}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 5 }}>
          <span style={{ color: 'var(--t2)' }}>Drawdown</span>
          <span style={{ fontWeight: 700, color }}>{dd.toFixed(1)}% / {kill}%</span>
        </div>
        <div className="progress-track" style={{ height: 5 }}>
          <div className="progress-fill" style={{ width: `${pct}%`, background: color }} />
        </div>
      </div>
      {[
        ['Entrada',  status.config?.entryMode === 'fixed' ? `$${status.config.fixedAmount} FIXO` : `${status.config?.maxBetPct}% Kelly`],
        ['Min Edge', `${((status.config?.minEdge ?? 0.05) * 100).toFixed(0)}¢`],
        ['Execução', status.config?.autoTrade ? 'AUTO' : 'MANUAL'],
        ['Modo',     status.mode],
        ['Capital',  fmtPrice(status.config?.capital)],
      ].map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
          <span style={{ color: 'var(--t2)' }}>{k}</span>
          <span style={{
            fontWeight: 700,
            color: k === 'Modo' && status.mode === 'LIVE' ? 'var(--red)'
              : k === 'Execução' && status.config?.autoTrade ? 'var(--amber)'
              : 'var(--t1)',
          }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

// ─── POSITIONS BODY ───────────────────────────────────────────────────────────
function PositionsBody({ positions, onClose }) {
  if (positions.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t2)', fontSize: 10 }}>
        Nenhuma posição aberta
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 8px' }}>
      {positions.map(pos => {
        const up      = pos.side === 'BUY_YES';
        const pnlUp   = pos.unrealizedPnl >= 0;
        const pct     = pos.pnlPct ?? 0;
        const elapsed = Math.round((Date.now() - pos.entryTime) / 1000);
        return (
          <div key={pos.id} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: up ? 'var(--green)' : 'var(--red)', flexShrink: 0 }}>
                {up ? '▲ YES' : '▼ NO'}
              </span>
              <span style={{ fontSize: 9, color: 'var(--t2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {pos.question}
              </span>
              <span style={{ fontSize: 9, color: 'var(--t3)', flexShrink: 0 }}>{elapsed}s</span>
              <button onClick={() => onClose(pos.id)} style={{
                background: 'var(--red-bg)', border: '1px solid var(--red-b)', borderRadius: 3,
                color: 'var(--red)', cursor: 'pointer', display: 'flex', alignItems: 'center',
                padding: '2px 5px', gap: 3, fontSize: 8, fontWeight: 700, flexShrink: 0,
              }}>
                <X size={8} /> FECHAR
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
              {[
                ['ENTRY',  `${(pos.entryOdds * 100).toFixed(1)}¢`, 'var(--t2)'],
                ['MARK',   `${(pos.markOdds  * 100).toFixed(1)}¢`, pnlUp ? 'var(--green)' : 'var(--red)'],
                ['UNRLZD', `${pnlUp ? '+' : ''}$${pos.unrealizedPnl?.toFixed(2)}`, pnlUp ? 'var(--green)' : 'var(--red)'],
                ['P%',     `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, pnlUp ? 'var(--green)' : 'var(--red)'],
              ].map(([l, v, c]) => (
                <div key={l} style={{ background: 'var(--s2)', borderRadius: 3, padding: '3px 5px' }}>
                  <div style={{ fontSize: 7, color: 'var(--t3)', textTransform: 'uppercase' }}>{l}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: c }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── TRADES BODY ──────────────────────────────────────────────────────────────
function TradesBody({ trades }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px' }}>
      {trades.length === 0 ? (
        <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--t2)', fontSize: 10 }}>
          Nenhum trade ainda
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ fontSize: 8, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '0.08em', position: 'sticky', top: 0, background: 'var(--s1)' }}>
              {['HORA', 'DIR', 'EDGE', 'TAMANHO', 'SPREAD', 'P&L', 'MOTIVO'].map(h => (
                <th key={h} style={{ textAlign: h === 'HORA' ? 'left' : 'right', padding: '6px 4px 4px', borderBottom: '1px solid var(--border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={t.id || i} style={{ borderBottom: '1px solid var(--border)', fontSize: 9 }}>
                <td style={{ padding: '5px 4px', color: 'var(--t2)', fontVariantNumeric: 'tabular-nums' }}>{fmtTime(t.timestamp)}</td>
                <td style={{ padding: '5px 4px', textAlign: 'right', fontWeight: 700, color: t.side === 'BUY_YES' ? 'var(--green)' : 'var(--red)' }}>
                  {t.side === 'BUY_YES' ? '▲' : '▼'}
                </td>
                <td style={{ padding: '5px 4px', textAlign: 'right', color: 'var(--blue)', fontVariantNumeric: 'tabular-nums' }}>{fmtEdge(t.edge)}</td>
                <td style={{ padding: '5px 4px', textAlign: 'right', color: 'var(--amber)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt$(t.betSize, 1)}
                  {t.partialFill && <span style={{ color: 'var(--amber)', fontSize: 7, marginLeft: 2 }} title={`Pedido: $${t.requestedSize}`}>P</span>}
                </td>
                <td style={{ padding: '5px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--t3)', fontSize: 8 }}>
                  {t.spread != null ? `${(t.spread * 100).toFixed(1)}¢` : '—'}
                </td>
                <td style={{ padding: '5px 4px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: t.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {fmt$(t.pnl, 2)}
                </td>
                <td style={{ padding: '5px 4px', textAlign: 'right' }}>
                  {t.closeReason && (
                    <span className={`badge badge-${t.closeReason === 'TP' ? 'green' : t.closeReason === 'SL' ? 'red' : 'gray'}`}
                      style={{ fontSize: 7, padding: '1px 4px' }}>
                      {t.closeReason}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── HISTORY BODY ─────────────────────────────────────────────────────────────
function HistoryBody({ trades }) {
  const [filter, setFilter] = useState('ALL');

  const dailyData = useMemo(() => {
    const days = {};
    trades.forEach(t => {
      const day = fmtDate(t.timestamp);
      if (!days[day]) days[day] = { date: day, ts: t.timestamp, trades: 0, wins: 0, losses: 0, pnl: 0, tp: 0, sl: 0, timeout: 0 };
      const d = days[day];
      d.trades++;
      if ((t.pnl || 0) >= 0) d.wins++; else d.losses++;
      d.pnl += t.pnl || 0;
      if (t.closeReason === 'TP')      d.tp++;
      if (t.closeReason === 'SL')      d.sl++;
      if (t.closeReason === 'TIMEOUT') d.timeout++;
    });
    return Object.values(days).sort((a, b) => b.ts - a.ts);
  }, [trades]);

  const filteredTrades = useMemo(() => {
    if (filter === 'ALL') return trades;
    return trades.filter(t => t.closeReason === filter);
  }, [trades, filter]);

  const sorted  = [...trades].sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
  const best    = sorted[0];
  const worst   = sorted[sorted.length - 1];
  const avgPnl  = trades.length ? trades.reduce((s, t) => s + (t.pnl || 0), 0) / trades.length : 0;
  const tpCount = trades.filter(t => t.closeReason === 'TP').length;
  const slCount = trades.filter(t => t.closeReason === 'SL').length;
  const toCount = trades.filter(t => t.closeReason === 'TIMEOUT').length;
  const barData = dailyData.slice(0, 14).reverse().map(d => ({ date: d.date, pnl: parseFloat(d.pnl.toFixed(2)) }));

  if (trades.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t2)', fontSize: 10 }}>
        Nenhum histórico ainda — inicie o bot
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      {/* Summary tiles */}
      <div style={{ display: 'flex', gap: 5, padding: '8px 10px', flexShrink: 0, borderBottom: '1px solid var(--border)' }}>
        {[
          { l: 'AVG P&L', v: fmt$(avgPnl, 2), c: avgPnl >= 0 ? 'var(--green)' : 'var(--red)' },
          { l: 'TP',      v: tpCount,          c: 'var(--green)' },
          { l: 'SL',      v: slCount,          c: 'var(--red)' },
          { l: 'TIMEOUT', v: toCount,          c: 'var(--t2)' },
          { l: 'MELHOR',  v: best ? fmt$(best.pnl, 2) : '—', c: 'var(--green)' },
          { l: 'PIOR',    v: worst ? fmt$(worst.pnl, 2) : '—', c: 'var(--red)' },
        ].map(s => (
          <div key={s.l} style={{ flex: 1, background: 'var(--s2)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 7px', minWidth: 0 }}>
            <div style={{ fontSize: 7, color: 'var(--t3)', textTransform: 'uppercase', fontFamily: 'Inter' }}>{s.l}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: s.c }}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Bar chart */}
      {barData.length > 1 && (
        <div style={{ height: 76, padding: '4px 8px 0', flexShrink: 0, borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 8, color: 'var(--t3)', marginBottom: 2 }}>P&L diário</div>
          <ResponsiveContainer width="100%" height={56}>
            <BarChart data={barData} margin={{ top: 2, right: 2, bottom: 0, left: -28 }}>
              <XAxis dataKey="date" tick={{ fontSize: 7, fill: 'var(--t3)' }} />
              <YAxis tick={{ fontSize: 7, fill: 'var(--t2)' }} />
              <ReferenceLine y={0} stroke="var(--border2)" />
              <Tooltip content={<ChartTip formatter={v => fmt$(v, 2)} />} />
              <Bar dataKey="pnl" radius={[2, 2, 0, 0]} isAnimationActive={false} name="P&L">
                {barData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? 'var(--green)' : 'var(--red)'} fillOpacity={0.8} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Daily table */}
      <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', maxHeight: 130, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ fontSize: 8, color: 'var(--t2)', textTransform: 'uppercase', position: 'sticky', top: 0, background: 'var(--s1)' }}>
              {['DATA', '#', 'W', 'L', 'P&L', 'TP', 'SL', 'TMT'].map(h => (
                <th key={h} style={{ textAlign: h === 'DATA' ? 'left' : 'right', padding: '5px 4px', borderBottom: '1px solid var(--border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dailyData.map(d => (
              <tr key={d.date} style={{ borderBottom: '1px solid var(--border)', fontSize: 9 }}>
                <td style={{ padding: '4px', color: 'var(--t2)' }}>{d.date}</td>
                <td style={{ padding: '4px', textAlign: 'right', color: 'var(--t1)' }}>{d.trades}</td>
                <td style={{ padding: '4px', textAlign: 'right', color: 'var(--green)', fontWeight: 700 }}>{d.wins}</td>
                <td style={{ padding: '4px', textAlign: 'right', color: 'var(--red)', fontWeight: 700 }}>{d.losses}</td>
                <td style={{ padding: '4px', textAlign: 'right', fontWeight: 700, color: d.pnl >= 0 ? 'var(--green)' : 'var(--red)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt$(d.pnl, 2)}
                </td>
                <td style={{ padding: '4px', textAlign: 'right', color: 'var(--green)' }}>{d.tp}</td>
                <td style={{ padding: '4px', textAlign: 'right', color: 'var(--red)' }}>{d.sl}</td>
                <td style={{ padding: '4px', textAlign: 'right', color: 'var(--t3)' }}>{d.timeout}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '5px 10px', flexShrink: 0, borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        {['ALL', 'TP', 'SL', 'TIMEOUT'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={cn('badge', filter === f ? 'badge-blue' : 'badge-gray')}
            style={{ cursor: 'pointer', fontSize: 8 }}>
            {f}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--t2)' }}>{filteredTrades.length} trades</span>
      </div>

      {/* Trade list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {filteredTrades.map((t, i) => (
              <tr key={t.id || i} style={{ borderBottom: '1px solid var(--border)', fontSize: 9 }}>
                <td style={{ padding: '4px', color: 'var(--t2)' }}>{fmtTime(t.timestamp)}</td>
                <td style={{ padding: '4px', fontWeight: 700, color: t.side === 'BUY_YES' ? 'var(--green)' : 'var(--red)' }}>
                  {t.side === 'BUY_YES' ? '▲' : '▼'}
                </td>
                <td style={{ padding: '4px', color: 'var(--t3)', fontSize: 8, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.question?.slice(0, 32)}
                </td>
                <td style={{ padding: '4px', textAlign: 'right', fontWeight: 700, color: (t.pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {fmt$(t.pnl, 2)}
                </td>
                <td style={{ padding: '4px', textAlign: 'right' }}>
                  {t.closeReason && (
                    <span className={`badge badge-${t.closeReason === 'TP' ? 'green' : t.closeReason === 'SL' ? 'red' : 'gray'}`}
                      style={{ fontSize: 7, padding: '1px 4px' }}>
                      {t.closeReason}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────
export default function App() {
  const { connected, market, candles, currentCandle, signal, status, trades, markets, positions,
          startBot, stopBot, manualTrade, closePosition, actionPending, botError, setBotError } = useBot();
  const [showConfig, setShowConfig] = useState(false);
  const [showLayout, setShowLayout] = useState(false);
  const [clock, setClock]           = useState(fmtClock());
  const isMobile                    = useIsMobile();

  const [layout, setLayout] = useState(() => {
    try { const s = localStorage.getItem(LS_LAYOUT); return s ? JSON.parse(s) : DEFAULT_LAYOUT; }
    catch { return DEFAULT_LAYOUT; }
  });
  const [hidden, setHidden] = useState(() => {
    try { const s = localStorage.getItem(LS_HIDDEN); return s ? new Set(JSON.parse(s)) : new Set(); }
    catch { return new Set(); }
  });

  useEffect(() => {
    const t = setInterval(() => setClock(fmtClock()), 1000);
    return () => clearInterval(t);
  }, []);

  const handleLayoutChange = (newLayout) => {
    setLayout(newLayout);
    localStorage.setItem(LS_LAYOUT, JSON.stringify(newLayout));
  };

  const hidePanel = (id) => {
    setHidden(prev => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem(LS_HIDDEN, JSON.stringify([...next]));
      return next;
    });
  };

  const togglePanel = (id) => {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem(LS_HIDDEN, JSON.stringify([...next]));
      return next;
    });
  };

  const resetLayout = () => {
    setLayout(DEFAULT_LAYOUT);
    setHidden(new Set());
    localStorage.removeItem(LS_LAYOUT);
    localStorage.removeItem(LS_HIDDEN);
  };

  const handleResizeStop = () => setTimeout(() => window.dispatchEvent(new Event('resize')), 50);

  // Combine saved layout with any new panels (e.g. panels added after save)
  const activeLayout = (() => {
    const savedIds = new Set(layout.map(l => l.i));
    const extra = DEFAULT_LAYOUT.filter(d => !savedIds.has(d.i));
    return [...layout, ...extra].filter(l => !hidden.has(l.i));
  })();

  const panelBadge = (id) => {
    if (id === 'markets') {
      const isReal = markets.some(m => m.live);
      return <span className={cn('badge', isReal ? 'badge-green' : 'badge-amber')} style={{ fontSize: 7 }}>{isReal ? '● LIVE' : '● SIM'}</span>;
    }
    if (id === 'chart') {
      const up = (market.btcChange24h ?? 0) >= 0;
      return <span style={{ fontSize: 9, fontWeight: 700, color: up ? 'var(--green)' : 'var(--red)', marginLeft: 4 }}>{market.btcPrice ? fmtPrice(market.btcPrice) : '—'}</span>;
    }
    if (id === 'edge') {
      const edge = market.edge || 0;
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 8, marginLeft: 4 }}>
          <span style={{ color: 'var(--blue)' }}>■ Binance</span>
          <span style={{ color: 'var(--red)' }}>■ Poly</span>
          <span style={{ fontWeight: 700, color: Math.abs(edge) > 0.05 ? (edge > 0 ? 'var(--green)' : 'var(--red)') : 'var(--t2)' }}>{fmtEdge(edge)}</span>
        </div>
      );
    }
    if (id === 'positions' && positions.length > 0) {
      return <span className="badge badge-amber blink" style={{ fontSize: 7 }}>{positions.length} LIVE</span>;
    }
    if (id === 'trades') {
      return <span style={{ fontSize: 8, color: 'var(--t2)', marginLeft: 4 }}>{trades.length} fills</span>;
    }
    if (id === 'history') {
      return <span style={{ fontSize: 8, color: 'var(--t2)', marginLeft: 4 }}>{trades.length} trades</span>;
    }
    if (id === 'risk' && (status.drawdown || 0) * 100 >= (status.config?.killThreshold ?? 20) * 0.75) {
      return <span className="badge badge-red blink" style={{ fontSize: 7 }}>KILL ZONE</span>;
    }
    if (id === 'signal') {
      return <span className={cn('badge', status.active ? 'badge-green' : 'badge-gray')} style={{ fontSize: 7 }}>{status.active ? '● ON' : '● OFF'}</span>;
    }
    return null;
  };

  const renderBody = (id) => {
    switch (id) {
      case 'signal':    return <SignalBody signal={signal} market={market} status={status} onManualTrade={manualTrade} />;
      case 'markets':   return <MarketsBody markets={markets} />;
      case 'chart':     return <BtcChartBody market={market} candles={candles} currentCandle={currentCandle} />;
      case 'edge':      return <EdgeChartBody market={market} />;
      case 'balance':   return <BalanceCurveBody trades={trades} status={status} />;
      case 'stats':     return <StatsBody status={status} />;
      case 'risk':      return <RiskBody status={status} />;
      case 'positions': return <PositionsBody positions={positions} onClose={closePosition} />;
      case 'trades':    return <TradesBody trades={trades} />;
      case 'history':   return <HistoryBody trades={trades} />;
      default:          return null;
    }
  };

  const errorBanner = botError && (
    <div style={{
      position: 'fixed', top: isMobile ? 0 : 48, left: '50%', transform: 'translateX(-50%)',
      zIndex: 999, background: 'var(--red)', color: '#fff',
      padding: '8px 18px', borderRadius: 6, fontSize: 11, fontWeight: 600,
      boxShadow: '0 4px 16px rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', gap: 10,
      maxWidth: '90vw',
    }}>
      <AlertTriangle size={13} />
      {botError}
      <button onClick={() => setBotError(null)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 0, marginLeft: 4 }}>
        <X size={12} />
      </button>
    </div>
  );

  // ── MOBILE LAYOUT ──────────────────────────────────────────────────────────
  if (isMobile) {
    const isReal = markets.some(m => m.live);
    const edge   = market.edge || 0;
    return (
      <div className="app-shell">
        <TopBarMobile
          status={status} market={market} connected={connected} clock={clock}
          onStart={startBot} onStop={stopBot}
          onSettings={() => setShowConfig(true)}
          actionPending={actionPending}
        />
        {errorBanner}
        <div className="mobile-body">

          {/* Signal */}
          <MobileCard
            title="Signal"
            badge={<span className={cn('badge', status.active ? 'badge-green' : 'badge-gray')} style={{ fontSize: 7 }}>{status.active ? '● ON' : '● OFF'}</span>}
            defaultOpen
          >
            <SignalBody signal={signal} market={market} status={status} onManualTrade={manualTrade} />
          </MobileCard>

          {/* Posições abertas */}
          <MobileCard
            title="Posições Abertas"
            badge={positions.length > 0 ? <span className="badge badge-amber blink" style={{ fontSize: 7 }}>{positions.length} LIVE</span> : null}
            defaultOpen={positions.length > 0}
            bodyStyle={{ minHeight: positions.length > 0 ? 120 : 60 }}
          >
            <PositionsBody positions={positions} onClose={closePosition} />
          </MobileCard>

          {/* BTC Chart */}
          <MobileCard
            title="BTC / USDT"
            badge={<span style={{ fontSize: 9, fontWeight: 700, color: (market.btcChange24h ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{market.btcPrice ? fmtPrice(market.btcPrice) : '—'}</span>}
            defaultOpen
          >
            <div className="mobile-chart-wrap">
              <BtcChartBody market={market} candles={candles} currentCandle={currentCandle} />
            </div>
          </MobileCard>

          {/* Edge Chart */}
          <MobileCard
            title="Live Edge"
            badge={
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 8 }}>
                <span style={{ color: 'var(--blue)' }}>■ Binance</span>
                <span style={{ color: 'var(--red)' }}>■ Poly</span>
                <span style={{ fontWeight: 700, color: Math.abs(edge) > 0.05 ? (edge > 0 ? 'var(--green)' : 'var(--red)') : 'var(--t2)' }}>{fmtEdge(edge)}</span>
              </div>
            }
            defaultOpen
          >
            <div className="mobile-edge-wrap">
              <EdgeChartBody market={market} />
            </div>
          </MobileCard>

          {/* Performance */}
          <MobileCard title="Performance" defaultOpen>
            <StatsBody status={status} />
          </MobileCard>

          {/* Risk */}
          <MobileCard
            title="Risk Monitor"
            badge={(status.drawdown || 0) * 100 >= (status.config?.killThreshold ?? 20) * 0.75
              ? <span className="badge badge-red blink" style={{ fontSize: 7 }}>KILL ZONE</span> : null}
            defaultOpen
          >
            <RiskBody status={status} />
          </MobileCard>

          {/* Balance Curve */}
          <MobileCard title="Balance Curve" defaultOpen={false} bodyStyle={{ height: 160 }}>
            <BalanceCurveBody trades={trades} status={status} />
          </MobileCard>

          {/* Mercados */}
          <MobileCard
            title="Mercados BTC"
            badge={<span className={cn('badge', isReal ? 'badge-green' : 'badge-amber')} style={{ fontSize: 7 }}>{isReal ? '● LIVE' : '● SIM'}</span>}
            defaultOpen={false}
          >
            <MarketsBody markets={markets} />
          </MobileCard>

          {/* Trade Log */}
          <MobileCard
            title="Trade Log"
            badge={<span style={{ fontSize: 8, color: 'var(--t2)' }}>{trades.length} fills</span>}
            defaultOpen={false}
            bodyStyle={{ maxHeight: 320, overflowY: 'auto' }}
          >
            <TradesBody trades={trades} />
          </MobileCard>

          {/* Histórico */}
          <MobileCard
            title="Histórico"
            badge={<span style={{ fontSize: 8, color: 'var(--t2)' }}>{trades.length} trades</span>}
            defaultOpen={false}
          >
            <HistoryBody trades={trades} />
          </MobileCard>

        </div>

        {showConfig && (
          <ConfigModal key={JSON.stringify(status.config)} initialConfig={status.config} onClose={() => setShowConfig(false)} />
        )}
      </div>
    );
  }

  // ── DESKTOP LAYOUT ─────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      <TopBar
        status={status} market={market} connected={connected} clock={clock}
        onStart={startBot} onStop={stopBot}
        onSettings={() => setShowConfig(true)}
        onLayout={() => setShowLayout(v => !v)}
        actionPending={actionPending}
      />

      {errorBanner}

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}>
        <RGL
          layout={activeLayout}
          cols={COLS}
          rowHeight={ROW_H}
          margin={MARGIN}
          containerPadding={[8, 8]}
          draggableHandle=".drag-handle"
          onLayoutChange={handleLayoutChange}
          onResizeStop={handleResizeStop}
          isResizable
          isDraggable
          useCSSTransforms
          compactType="vertical"
        >
          {activeLayout.map(({ i }) => (
            <div key={i} style={{ overflow: 'hidden' }}>
              <PanelShell id={i} label={PANEL_NAMES[i]} badge={panelBadge(i)} onHide={hidePanel}>
                {renderBody(i)}
              </PanelShell>
            </div>
          ))}
        </RGL>
      </div>

      {showLayout && (
        <LayoutMenu hidden={hidden} onToggle={togglePanel} onReset={resetLayout} onClose={() => setShowLayout(false)} />
      )}

      {showConfig && (
        <ConfigModal key={JSON.stringify(status.config)} initialConfig={status.config} onClose={() => setShowConfig(false)} />
      )}
    </div>
  );
}
