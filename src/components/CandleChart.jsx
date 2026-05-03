import { useEffect, useRef } from 'react';
import {
  createChart,
  CrosshairMode,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
} from 'lightweight-charts';

// Coerce to integer seconds â€” guards against any object/non-numeric value
function toTime(t) {
  const n = Math.floor(Number(t));
  return isFinite(n) && n > 0 ? n : 0;
}

export default function CandleChart({ candles = [], currentCandle = null }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const seriesRef    = useRef(null);
  const volRef       = useRef(null);

  // Keep latest props in a ref so effects always see current values (avoids stale closures)
  const candlesRef      = useRef(candles);
  const curCandleRef    = useRef(currentCandle);
  candlesRef.current    = candles;
  curCandleRef.current  = currentCandle;

  // Internal chart state
  const lastChartTimeRef = useRef(0);  // highest time pushed to the chart
  const loadedCountRef   = useRef(0);  // # of closed candles in last setData/loadAll

  // â”€â”€ Create chart once â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        vertLine: { width: 1, color: '#4899ff50', style: 2, labelBackgroundColor: '#131320' },
        horzLine: { width: 1, color: '#4899ff50', style: 2, labelBackgroundColor: '#131320' },
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

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00e082', downColor: '#ff4466',
      borderUpColor: '#00e082', borderDownColor: '#ff4466',
      wickUpColor: '#00e08299', wickDownColor: '#ff446699',
    });

    const volSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current  = chart;
    seriesRef.current = candleSeries;
    volRef.current    = volSeries;

    const ro = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current)
        chartRef.current.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = seriesRef.current = volRef.current = null;
      lastChartTimeRef.current = loadedCountRef.current = 0;
    };
  }, []);

  // â”€â”€ Full reload: always reads from refs (never stale) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function reloadAll() {
    if (!seriesRef.current) return;
    const closed  = candlesRef.current;
    const forming = curCandleRef.current;
    const all = forming ? [...closed, forming] : closed;
    const bars = all.map(c => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })).filter(b => b.time > 0);
    const vols = all.map(c => ({
      time: toTime(c.time), value: c.ticks || 1,
      color: c.close >= c.open ? 'rgba(0,224,130,0.28)' : 'rgba(255,68,102,0.28)',
    })).filter(v => v.time > 0);
    if (bars.length === 0) return;
    seriesRef.current.setData(bars);
    if (volRef.current) volRef.current.setData(vols);
    lastChartTimeRef.current = bars[bars.length - 1].time;
    loadedCountRef.current   = closed.length;
  }

  // â”€â”€ Effect: handle closed candles array changes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;

    // First load
    if (loadedCountRef.current === 0) {
      reloadAll();
      return;
    }

    // New closed candle appended
    if (candles.length > loadedCountRef.current) {
      const c = candles[candles.length - 1];
      const t = toTime(c.time);

      if (t === 0) { loadedCountRef.current = candles.length; return; }

      if (t <= lastChartTimeRef.current) {
        // Out-of-order: closed candle arrived with time behind current chart time.
        // This happens when currentCandle already moved to next bucket via WS tick
        // before this HTTP poll delivered the now-closed candle.
        // Safe fix: full setData reload which is self-consistent.
        reloadAll();
      } else {
        try {
          seriesRef.current.update({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
          if (volRef.current) volRef.current.update({
            time: t, value: c.ticks || 1,
            color: c.close >= c.open ? 'rgba(0,224,130,0.28)' : 'rgba(255,68,102,0.28)',
          });
          lastChartTimeRef.current = t;
        } catch (_) { reloadAll(); }
      }
      loadedCountRef.current = candles.length;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles]);

  // â”€â”€ Effect: real-time forming candle tick (every ~150ms from WS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!seriesRef.current || !currentCandle || loadedCountRef.current === 0) return;
    const t = toTime(currentCandle.time);
    if (t === 0) return;

    try {
      seriesRef.current.update({ time: t, open: currentCandle.open, high: currentCandle.high, low: currentCandle.low, close: currentCandle.close });
      if (volRef.current) volRef.current.update({
        time: t, value: currentCandle.ticks || 1,
        color: currentCandle.close >= currentCandle.open ? 'rgba(0,224,130,0.28)' : 'rgba(255,68,102,0.28)',
      });
      if (t > lastChartTimeRef.current) lastChartTimeRef.current = t;
    } catch (_) {
      // Any error (including "Cannot update oldest data") â†’ full reload
      reloadAll();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCandle]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
