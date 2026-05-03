// In production (Railway) the frontend is served by the same Express process,
// so API calls use same-origin (empty BASE). If VITE_API_URL is set, ensure it
// has a protocol prefix — without it the browser treats it as a relative path
// and duplicates the hostname in the URL.
function sanitizeBase(raw) {
  if (!raw) return '';
  if (/^https?:\/\//.test(raw)) return raw.replace(/\/$/, ''); // already has protocol
  return `https://${raw.replace(/\/$/, '')}`; // add missing https://
}
const BASE = sanitizeBase(
  typeof __VITE_API_URL__ !== 'undefined' ? __VITE_API_URL__ : ''
);
export { BASE };

// WebSocket URL derived from BASE (https → wss, http → ws, empty → same host)
export function getWsUrl() {
  const base = !BASE
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    : BASE.replace(/^https/, 'wss').replace(/^http/, 'ws');
  return base;
}

async function post(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
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
  getCandles:     ()        => get('/api/candles'),
  simReset:       ()        => post('/api/sim/reset'),
};
