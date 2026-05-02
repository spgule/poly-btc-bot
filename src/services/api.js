// In production (Railway) the frontend is served by the same Express process,
// so API calls go to the same origin. In local dev, Vite proxies /api and /ws
// to localhost:3001, so we also use same origin (empty BASE).
const BASE = (typeof __VITE_API_URL__ !== 'undefined' && __VITE_API_URL__)
  ? __VITE_API_URL__
  : '';

// WebSocket URL derived from BASE (https → wss, http → ws, empty → same host)
export function getWsUrl() {
  const base = !BASE
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    : BASE.replace(/^https/, 'wss').replace(/^http/, 'ws');
  return `${base}/ws`;
}

async function post(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export const api = {
  startBot:       ()        => post('/api/bot/start'),
  stopBot:        ()        => post('/api/bot/stop'),
  manualTrade:    ()        => post('/api/trade'),
  setConfig:      (cfg)     => post('/api/config', cfg),
  getStatus:      ()        => get('/api/status'),
  getTrades:      ()        => get('/api/trades'),
  getMarkets:     ()        => get('/api/markets'),
  closePosition:  (posId)   => post(`/api/positions/${posId}/close`),
  getFees:        ()        => get('/api/fees'),
};
