import { useEffect, useRef } from 'react';
import {
  createChart,
  CrosshairMode,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
} from 'lightweight-charts';

/**
 * TradingView-style real-time candlestick chart.
 * Uses lightweight-charts (official TradingView open-source library).
 *
 * Props:
 *   candles       – array of closed { time(s), open, high, low, close, ticks }
 *   currentCandle – currently-forming candle, updated every ~150ms
 */

// Coerce to integer seconds, return 0 for any invalid value
function toChartTime(t) {
  const n = Math.floor(Number(t));
  return isFinite(n) && n > 0 ? n : 0;
}

function makeBar(c) {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
}

function makeVol(c) {
  return {
    time:  toChartTime(c.time),
    value: c.ticks || 1,
    color: c.close >= c.open ? 'rgba(0,224,130,0.28)' : 'rgba(255,68,102,0.28)',
  };
}

export default function CandleChart({ candles = [], currentCandle = null }) {
  const containerRef   = useRef(null);
  const chartRef       = useRef(null);
  const seriesRef      = useRef(null);
  const volRef         = useRef(null);
  const initializedRef = useRef(false);
  const prevLenRef     = useRef(0);
  // Tracks the highest time value ever passed to .update() or .setData(), so we
  // can detect when a newly-closed candle arrives with time < lastChartTime and
  // fall back to a full setData reload instead of throwing "Cannot update oldest data".
  const lastChartTimeRef = useRef(0);

  // ── Create chart once ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0a14' },
        textColor: '#5a5a88',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#14142a' },
        horzLines: { color: '#14142a' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          width: 1, color: '#4899ff50', style: 2,
          labelBackgroundColor: '#131320',
        },
        horzLine: {
          width: 1, color: '#4899ff50', style: 2,
          labelBackgroundColor: '#131320',
        },
      },
      rightPriceScale: {
        borderColor: '#202040',
        textColor: '#5a5a88',
        scaleMargins: { top: 0.06, bottom: 0.24 },
      },
      timeScale: {
        borderColor: '#202040',
        textColor: '#5a5a88',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 8,
        barSpacing: 10,
        fixRightEdge: false,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    // ── Candlestick series ──────────────────────────────────────────────────
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:         '#00e082',
      downColor:       '#ff4466',
      borderUpColor:   '#00e082',
      borderDownColor: '#ff4466',
      wickUpColor:     '#00e08299',
      wickDownColor:   '#ff446699',
    });

    // ── Volume histogram (bottom 18%) ───────────────────────────────────────
    const volSeries = chart.addSeries(HistogramSeries, {
      priceFormat:  { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current  = chart;
    seriesRef.current = candleSeries;
    volRef.current    = volSeries;

    // ── Responsive resize ───────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.resize(
          containerRef.current.clientWidth,
          containerRef.current.clientHeight,
        );
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current       = null;
      seriesRef.current      = null;
      volRef.current         = null;
      initializedRef.current = false;
      prevLenRef.current     = 0;
      lastChartTimeRef.current = 0;
    };
  }, []);

  // ── Helper: bulk-load all data (closed + current forming candle) ──────────
  function loadAll(closedCandles, forming) {
    if (!seriesRef.current) return;
    const all = forming ? [...closedCandles, forming] : closedCandles;
    const bars = all.map(makeBar).filter(b => b.time > 0);
    const vols = all.map(makeVol).filter(v => v.time > 0);
    if (bars.length === 0) return;
    seriesRef.current.setData(bars);
    if (volRef.current) volRef.current.setData(vols);
    lastChartTimeRef.current = bars[bars.length - 1].time;
  }

  // ── Load historical candles (once) or append newly-closed candle ──────────
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;

    if (!initializedRef.current) {
      // First render: bulk-load all closed candles + current forming candle
      loadAll(candles, currentCandle);
      initializedRef.current = true;
      prevLenRef.current = candles.length;
    } else if (candles.length > prevLenRef.current) {
      const c = candles[candles.length - 1];
      const t = toChartTime(c.time);

      if (t === 0) {
        // Invalid time — just update the count and move on
        prevLenRef.current = candles.length;
        return;
      }

      if (t <= lastChartTimeRef.current) {
        // Newly-closed candle has a time ≤ the last time we fed the chart.
        // This happens when currentCandle already advanced to the next bucket
        // and then the now-closed candle arrives via the 3s HTTP poll.
        // Solution: full reload so the chart is always self-consistent.
        loadAll(candles, currentCandle);
      } else {
        seriesRef.current.update({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
        if (volRef.current) volRef.current.update(makeVol(c));
        lastChartTimeRef.current = t;
      }
      prevLenRef.current = candles.length;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles]);

  // ── Real-time tick: update forming candle every ~150ms ────────────────────
  useEffect(() => {
    if (!seriesRef.current || !currentCandle || !initializedRef.current) return;
    const t = toChartTime(currentCandle.time);
    if (t === 0) return;

    try {
      seriesRef.current.update({ time: t, open: currentCandle.open, high: currentCandle.high, low: currentCandle.low, close: currentCandle.close });
      if (volRef.current) volRef.current.update(makeVol(currentCandle));
      if (t > lastChartTimeRef.current) lastChartTimeRef.current = t;
    } catch (_) {
      // Fallback: reload all data if update fails for any reason
      loadAll(candles, currentCandle);
    }
  }, [currentCandle]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

