import { useEffect, useRef } from 'react';
import {
  createChart,
  CrosshairMode,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
} from 'lightweight-charts';

function toTime(t) {
  const n = Math.floor(Number(t));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function candleVolume(candle) {
  const volume = Number(candle?.volume);
  if (Number.isFinite(volume) && volume >= 0) return volume;
  return Number(candle?.ticks) || 1;
}

function buildChartRows(candles = [], currentCandle = null) {
  const all = currentCandle ? [...candles, currentCandle] : candles;
  const rows = all
    .filter(Boolean)
    .map((candle) => ({
      time: toTime(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: candleVolume(candle),
    }))
    .filter((bar) => (
      bar.time > 0
      && Number.isFinite(bar.open)
      && Number.isFinite(bar.high)
      && Number.isFinite(bar.low)
      && Number.isFinite(bar.close)
    ));

  const byTime = new Map();
  for (const row of rows) byTime.set(row.time, row);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function calcEma(rows, period) {
  if (!rows.length) return [];
  const alpha = 2 / (period + 1);
  let ema = rows[0].close;
  return rows.map((row, index) => {
    ema = index === 0 ? row.close : ((row.close - ema) * alpha) + ema;
    return { time: row.time, value: ema };
  });
}

function calcVwap(rows) {
  let cumulativePV = 0;
  let cumulativeVol = 0;
  return rows.map((row) => {
    const typical = (row.high + row.low + row.close) / 3;
    const volume = row.volume > 0 ? row.volume : 1;
    cumulativePV += typical * volume;
    cumulativeVol += volume;
    return {
      time: row.time,
      value: cumulativeVol > 0 ? cumulativePV / cumulativeVol : row.close,
    };
  });
}

function calcBollinger(rows, period = 20, mult = 2) {
  const upper = [];
  const middle = [];
  const lower = [];

  for (let i = 0; i < rows.length; i += 1) {
    if (i + 1 < period) continue;
    const slice = rows.slice(i + 1 - period, i + 1).map((row) => row.close);
    const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
    const variance = slice.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / slice.length;
    const stdDev = Math.sqrt(variance);
    const time = rows[i].time;
    middle.push({ time, value: mean });
    upper.push({ time, value: mean + (stdDev * mult) });
    lower.push({ time, value: mean - (stdDev * mult) });
  }

  return { upper, middle, lower };
}

export default function CandleChart({
  candles = [],
  currentCandle = null,
  indicators = {},
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const overlaySeriesRef = useRef({});
  const latestRowsRef = useRef([]);

  function syncChart() {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    const rows = buildChartRows(candles, currentCandle);
    latestRowsRef.current = rows;
    if (!rows.length) {
      candleSeries.setData([]);
      volumeSeriesRef.current?.setData([]);
      const overlays = overlaySeriesRef.current;
      overlays.ema9?.setData([]);
      overlays.ema21?.setData([]);
      overlays.vwap?.setData([]);
      overlays.bbUpper?.setData([]);
      overlays.bbMiddle?.setData([]);
      overlays.bbLower?.setData([]);
      return;
    }

    candleSeries.setData(rows.map((row) => ({
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    })));

    volumeSeriesRef.current?.setData(rows.map((row) => ({
      time: row.time,
      value: row.volume,
      color: row.close >= row.open ? 'rgba(0,224,130,0.28)' : 'rgba(255,68,102,0.28)',
    })));

    const overlays = overlaySeriesRef.current;
    const ema9 = calcEma(rows, 9);
    const ema21 = calcEma(rows, 21);
    const vwap = calcVwap(rows);
    const bollinger = calcBollinger(rows, 20, 2);

    overlays.ema9?.setData(indicators.ema9 ? ema9 : []);
    overlays.ema21?.setData(indicators.ema21 ? ema21 : []);
    overlays.vwap?.setData(indicators.vwap ? vwap : []);
    overlays.bbUpper?.setData(indicators.bollinger ? bollinger.upper : []);
    overlays.bbMiddle?.setData(indicators.bollinger ? bollinger.middle : []);
    overlays.bbLower?.setData(indicators.bollinger ? bollinger.lower : []);

    chartRef.current?.timeScale().fitContent();
  }

  useEffect(() => {
    if (!containerRef.current) return undefined;

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

    candleSeriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#00e082',
      downColor: '#ff4466',
      borderUpColor: '#00e082',
      borderDownColor: '#ff4466',
      wickUpColor: '#00e08299',
      wickDownColor: '#ff446699',
    });

    volumeSeriesRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    overlaySeriesRef.current = {
      ema9: chart.addSeries(LineSeries, {
        color: '#f7b955',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      }),
      ema21: chart.addSeries(LineSeries, {
        color: '#6ea8ff',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      }),
      vwap: chart.addSeries(LineSeries, {
        color: '#c486ff',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      }),
      bbUpper: chart.addSeries(LineSeries, {
        color: 'rgba(255,68,102,0.78)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lastValueVisible: false,
        priceLineVisible: false,
      }),
      bbMiddle: chart.addSeries(LineSeries, {
        color: 'rgba(130,130,190,0.85)',
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      }),
      bbLower: chart.addSeries(LineSeries, {
        color: 'rgba(0,224,130,0.78)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lastValueVisible: false,
        priceLineVisible: false,
      }),
    };

    chartRef.current = chart;
    syncChart();

    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      overlaySeriesRef.current = {};
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    syncChart();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, currentCandle, indicators]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
