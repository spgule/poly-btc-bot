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
export default function CandleChart({ candles = [], currentCandle = null }) {
  const containerRef   = useRef(null);
  const chartRef       = useRef(null);
  const seriesRef      = useRef(null);
  const volRef         = useRef(null);
  const initializedRef = useRef(false);
  const prevLenRef     = useRef(0);

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
      chartRef.current   = null;
      seriesRef.current  = null;
      volRef.current     = null;
      initializedRef.current = false;
      prevLenRef.current = 0;
    };
  }, []);

  // ── Load historical candles (once) or append newly-closed candle ──────────
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;

    if (!initializedRef.current) {
      // First render: bulk-load all closed candles + current forming candle
      const all = currentCandle ? [...candles, currentCandle] : candles;
      seriesRef.current.setData(
        all.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
      );
      if (volRef.current) {
        volRef.current.setData(
          all.map(c => ({
            time:  c.time,
            value: c.ticks || 1,
            color: c.close >= c.open ? 'rgba(0,224,130,0.28)' : 'rgba(255,68,102,0.28)',
          }))
        );
      }
      initializedRef.current = true;
      prevLenRef.current = candles.length;
    } else if (candles.length > prevLenRef.current) {
      // New closed candle — append via update (faster than setData)
      const c = candles[candles.length - 1];
      seriesRef.current.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
      if (volRef.current) {
        volRef.current.update({
          time: c.time, value: c.ticks || 1,
          color: c.close >= c.open ? 'rgba(0,224,130,0.28)' : 'rgba(255,68,102,0.28)',
        });
      }
      prevLenRef.current = candles.length;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, currentCandle]);

  // ── Real-time tick: update forming candle every ~150ms ────────────────────
  useEffect(() => {
    if (!seriesRef.current || !currentCandle || !initializedRef.current) return;
    seriesRef.current.update({
      time:  currentCandle.time,
      open:  currentCandle.open,
      high:  currentCandle.high,
      low:   currentCandle.low,
      close: currentCandle.close,
    });
    if (volRef.current) {
      volRef.current.update({
        time:  currentCandle.time,
        value: currentCandle.ticks || 1,
        color: currentCandle.close >= currentCandle.open
          ? 'rgba(0,224,130,0.28)'
          : 'rgba(255,68,102,0.28)',
      });
    }
  }, [currentCandle]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
