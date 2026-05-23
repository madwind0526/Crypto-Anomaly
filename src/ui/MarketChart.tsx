import { useEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import type { BlockedSignal, Candle, Trade } from "../types/trading";
import { normalizeChartInterval, type ChartInterval } from "../data/candleAggregation";

interface MarketChartProps {
  boundaryTimestamp?: number;
  blockedSignals?: BlockedSignal[];
  candles: Candle[];
  interval: ChartInterval;
  metrics?: {
    detail?: ReactNode;
    detailClassName?: string;
    returnRate: number;
    returnTitle?: string;
  };
  themeMode: "light" | "dark";
  trades?: Trade[];
  variant?: "mini" | "large";
}

interface MeasurementPoints {
  p1: Candle | null;
  p2: Candle | null;
}

export function MarketChart({
  boundaryTimestamp,
  blockedSignals = [],
  candles,
  interval,
  metrics,
  themeMode,
  trades = [],
  variant = "mini",
}: MarketChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markerSeriesRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const boundaryPrimitiveRef = useRef<DailyBoundaryPrimitive | null>(null);
  const blockedSignalPrimitiveRef = useRef<BlockedSignalPrimitive | null>(null);
  const candlesByTimeRef = useRef<Map<Time, Candle>>(new Map());
  const [measurementPoints, setMeasurementPoints] = useState<MeasurementPoints>({ p1: null, p2: null });
  const normalizedInterval = useMemo(() => normalizeChartInterval(interval), [interval]);
  const [windowEndIndex, setWindowEndIndex] = useState(candles.length);

  const visibleCandles = useMemo(() => {
    const safeEnd = Math.min(Math.max(windowEndIndex, 0), candles.length);
    const endCandle = candles[safeEnd - 1];
    if (!endCandle) return [];

    const startTimestamp = endCandle.timestamp - getVisibleDurationMs(normalizedInterval);
    let start = 0;
    for (let index = safeEnd - 1; index >= 0; index -= 1) {
      if (candles[index].timestamp < startTimestamp) {
        start = index + 1;
        break;
      }
    }

    return candles.slice(start, safeEnd);
  }, [candles, normalizedInterval, windowEndIndex]);

  useEffect(() => {
    setWindowEndIndex(candles.length);
    setMeasurementPoints({ p1: null, p2: null });
  }, [candles.length, normalizedInterval]);

  useEffect(() => {
    candlesByTimeRef.current = new Map(visibleCandles.map((candle) => [toChartTime(candle.timestamp), candle]));
  }, [visibleCandles]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const colors = getChartColors(themeMode);
    const responsiveOptions = getResponsiveChartOptions(container.clientWidth, variant);
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: colors.text,
        fontSize: responsiveOptions.fontSize,
      },
      localization: {
        timeFormatter: formatChartTimeLabel,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: {
        borderVisible: false,
        entireTextOnly: true,
        minimumWidth: responsiveOptions.priceScaleWidth,
        scaleMargins: {
          top: 0.08,
          bottom: 0.32,
        },
      },
      timeScale: {
        borderVisible: false,
        visible: true,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: formatChartTimeLabel,
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        horzLine: {
          visible: true,
          labelVisible: true,
          color: colors.crosshair,
          width: 1,
        },
        vertLine: {
          visible: true,
          labelVisible: true,
          color: colors.crosshair,
          width: 1,
        },
      },
      handleScroll: false,
      handleScale: variant === "large",
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceLineVisible: false,
      lastValueVisible: variant === "large",
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: colors.volumeUp,
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: "",
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.74,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    markerSeriesRef.current = createSeriesMarkers(candleSeries, [], { zOrder: "top" });
    const boundaryPrimitive = new DailyBoundaryPrimitive(themeMode, variant);
    candleSeries.attachPrimitive(boundaryPrimitive);
    boundaryPrimitiveRef.current = boundaryPrimitive;
    const blockedSignalPrimitive = new BlockedSignalPrimitive(themeMode, variant);
    candleSeries.attachPrimitive(blockedSignalPrimitive);
    blockedSignalPrimitiveRef.current = blockedSignalPrimitive;

    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !container) return;

      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        tooltip.style.display = "none";
        return;
      }

      const candle = candlesByTimeRef.current.get(param.time);
      if (!candle) {
        tooltip.style.display = "none";
        return;
      }

      const tooltipWidth = variant === "mini" ? 168 : 190;
      tooltip.style.display = "grid";
      tooltip.style.left = `${Math.min(param.point.x + 12, container.clientWidth - tooltipWidth)}px`;
      tooltip.style.top = `${Math.max(param.point.y - 88, 8)}px`;
      tooltip.innerHTML = `
        <strong>${formatTooltipTime(candle.timestamp)}</strong>
        <span>O ${formatNumber(candle.open)} H ${formatNumber(candle.high)}</span>
        <span>L ${formatNumber(candle.low)} C ${formatNumber(candle.close)}</span>
        <span>Value ${formatCompactKrw(candle.quoteVolume)}</span>
      `;
    });

    chart.subscribeClick((param) => {
      if (variant !== "large" || !param.time) return;

      const candle = candlesByTimeRef.current.get(param.time);
      if (!candle) return;

      setMeasurementPoints((current) => {
        if (!current.p1 || current.p2) {
          return { p1: candle, p2: null };
        }

        if (candle.timestamp < current.p1.timestamp) {
          return { p1: candle, p2: current.p1 };
        }

        return { p1: current.p1, p2: candle };
      });
    });

    return () => {
      candleSeries.detachPrimitive(boundaryPrimitive);
      candleSeries.detachPrimitive(blockedSignalPrimitive);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markerSeriesRef.current = null;
      boundaryPrimitiveRef.current = null;
      blockedSignalPrimitiveRef.current = null;
    };
  }, [themeMode, variant]);

  useEffect(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;

    const applyResponsiveOptions = () => {
      const { fontSize, priceScaleWidth } = getResponsiveChartOptions(container.clientWidth, variant);
      chart.applyOptions({
        layout: { fontSize },
        rightPriceScale: { minimumWidth: priceScaleWidth },
      });
    };

    applyResponsiveOptions();
    const observer = new ResizeObserver(applyResponsiveOptions);
    observer.observe(container);

    return () => observer.disconnect();
  }, [variant]);
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;

    const colors = getChartColors(themeMode);
    candleSeries.setData(
      visibleCandles.map((candle) => ({
        time: toChartTime(candle.timestamp),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    );

    volumeSeries.setData(
      visibleCandles.map((candle) => ({
        time: toChartTime(candle.timestamp),
        value: candle.quoteVolume,
        color: candle.close >= candle.open ? colors.volumeUp : colors.volumeDown,
      })),
    );

    chart.timeScale().fitContent();
    boundaryPrimitiveRef.current?.update(getBoundaryChartTime(boundaryTimestamp, visibleCandles), themeMode, variant);
    blockedSignalPrimitiveRef.current?.update(blockedSignals, visibleCandles, themeMode, variant);
  }, [blockedSignals, boundaryTimestamp, themeMode, variant, visibleCandles]);

  useEffect(() => {
    const markerSeries = markerSeriesRef.current;
    if (!markerSeries) return;

    const visibleTimes = new Set(visibleCandles.map((candle) => candle.timestamp));
    markerSeries.setMarkers([
      ...createTradeMarkers(trades, visibleCandles, themeMode, variant),
      ...(variant === "large" ? createMeasurementMarkers(measurementPoints, visibleTimes, themeMode) : []),
    ]);
  }, [measurementPoints, themeMode, trades, variant, visibleCandles]);

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (candles.length <= visibleCandles.length) return;

    event.preventDefault();
    event.stopPropagation();

    const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const step = Math.max(1, Math.round(Math.max(visibleCandles.length, 12) * 0.35));
    const direction = rawDelta > 0 ? 1 : -1;
    const minEnd = Math.min(Math.max(visibleCandles.length, 1), candles.length);

    setWindowEndIndex((current) => {
      const next = current + direction * step;
      return Math.min(candles.length, Math.max(minEnd, next));
    });
  }

  const rangeLabel = formatRangeLabel(visibleCandles);

  return (
    <div className={`market-chart-wrap market-chart-wrap--${variant}`} onWheel={handleWheel}>
      <div className={`market-chart market-chart--${variant}`} ref={containerRef} />
      <div className="market-chart-tooltip" ref={tooltipRef} />
      {metrics ? (
        <div className="market-chart-metrics">
          <span className={metrics.returnRate >= 0 ? "gain" : "loss"} title={metrics.returnTitle}>
            {formatPct(metrics.returnRate)}
          </span>
          {metrics.detail ? <strong className={metrics.detailClassName}>{metrics.detail}</strong> : null}
        </div>
      ) : null}
      <div className="market-chart-range">{rangeLabel}</div>
      {variant === "large" ? <MeasurementPanel points={measurementPoints} /> : null}
    </div>
  );
}

function MeasurementPanel({ points }: { points: MeasurementPoints }) {
  const { p1, p2 } = points;
  const summary = p1 && p2 ? getMeasurementSummary(p1, p2) : null;

  return (
    <div className="measurement-panel">
      <MeasurementPoint label="P1" candle={p1} />
      <MeasurementPoint label="P2" candle={p2} />
      <div className="measurement-summary">
        <span>Summary</span>
        {summary ? (
          <strong className={summary.returnRate >= 0 ? "gain" : "loss"}>
            {formatSignedNumber(summary.priceDiff)} / {formatPct(summary.returnRate)}
          </strong>
        ) : (
          <strong>Click two candles</strong>
        )}
        {summary ? (
          <small>
            {summary.elapsed} / Volume {formatCompactNumber(summary.volumeDiff)} / Value{" "}
            {formatCompactKrw(summary.quoteVolumeDiff)}
          </small>
        ) : (
          <small>P1 then P2</small>
        )}
      </div>
    </div>
  );
}

function MeasurementPoint({ candle, label }: { candle: Candle | null; label: "P1" | "P2" }) {
  return (
    <div className="measurement-point">
      <span>{label}</span>
      {candle ? (
        <>
          <strong>{formatNumber(candle.close)}</strong>
          <small>{formatTooltipTime(candle.timestamp)}</small>
        </>
      ) : (
        <>
          <strong>-</strong>
          <small>not set</small>
        </>
      )}
    </div>
  );
}

function createMeasurementMarkers(
  points: MeasurementPoints,
  visibleTimes: Set<number>,
  themeMode: "light" | "dark",
): SeriesMarker<Time>[] {
  const markerColor = themeMode === "dark" ? "#a4f0cf" : "#123c34";
  const markers: SeriesMarker<Time>[] = [];

  if (points.p1 && visibleTimes.has(points.p1.timestamp)) {
    markers.push({
      time: toChartTime(points.p1.timestamp),
      position: "aboveBar",
      shape: "circle",
      color: markerColor,
      text: "P1",
      size: 1.2,
    });
  }

  if (points.p2 && visibleTimes.has(points.p2.timestamp)) {
    markers.push({
      time: toChartTime(points.p2.timestamp),
      position: "aboveBar",
      shape: "circle",
      color: points.p2.close >= (points.p1?.close ?? points.p2.close) ? "#0b7a43" : "#b33a3a",
      text: "P2",
      size: 1.2,
    });
  }

  return markers;
}

function createTradeMarkers(
  trades: Trade[],
  visibleCandles: Candle[],
  themeMode: "light" | "dark",
  variant: "mini" | "large",
): SeriesMarker<Time>[] {
  if (trades.length === 0 || visibleCandles.length === 0) return [];

  const sortedTrades = trades.slice().sort((a, b) => a.timestamp - b.timestamp);
  const markers: SeriesMarker<Time>[] = [];
  const buyColor = themeMode === "dark" ? "#00f5a0" : "#008f5a";
  const sellColor = themeMode === "dark" ? "#ff4f7b" : "#c51f4a";
  const markerSize = variant === "large" ? 2.4 : 1.8;

  for (const trade of sortedTrades) {
    const markerCandle = findVisibleCandleForTrade(visibleCandles, trade.timestamp);
    if (!markerCandle) continue;

    if (trade.side === "buy") {
      markers.push({
        time: toChartTime(markerCandle.timestamp),
        position: "belowBar",
        shape: "arrowUp",
        color: buyColor,
        size: markerSize,
      });
      continue;
    }

    markers.push({
      time: toChartTime(markerCandle.timestamp),
      position: "aboveBar",
      shape: "arrowDown",
      color: sellColor,
      size: markerSize,
    });
  }

  return markers;
}

function findVisibleCandleForTrade(visibleCandles: Candle[], timestamp: number) {
  let selected: Candle | null = null;
  for (const candle of visibleCandles) {
    if (candle.timestamp > timestamp) break;
    selected = candle;
  }
  return selected;
}

function getBoundaryChartTime(boundaryTimestamp: number | undefined, visibleCandles: Candle[]) {
  if (!boundaryTimestamp || visibleCandles.length === 0) return null;

  const first = visibleCandles[0];
  const last = visibleCandles[visibleCandles.length - 1];
  if (boundaryTimestamp < first.timestamp || boundaryTimestamp > last.timestamp) return null;

  return toChartTime(findNearestCandleTimestamp(visibleCandles, boundaryTimestamp));
}

function findNearestCandleTimestamp(candles: Candle[], timestamp: number) {
  let nearest = candles[0].timestamp;
  let nearestDistance = Math.abs(nearest - timestamp);

  for (const candle of candles) {
    const distance = Math.abs(candle.timestamp - timestamp);
    if (distance < nearestDistance) {
      nearest = candle.timestamp;
      nearestDistance = distance;
    }
    if (candle.timestamp >= timestamp && distance > nearestDistance) break;
  }

  return nearest;
}

interface BlockedSignalDrawingPoint {
  color: string;
  x: number;
  y: number;
}

class BlockedSignalPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  private series: ISeriesApi<"Candlestick"> | null = null;
  private readonly view = new BlockedSignalView();

  constructor(themeMode: "light" | "dark", variant: "mini" | "large") {
    this.view.update([], [], themeMode, variant);
  }

  attached(param: SeriesAttachedParameter<Time, "Candlestick">) {
    this.chart = param.chart as IChartApi;
    this.series = param.series as ISeriesApi<"Candlestick">;
    this.requestUpdate = param.requestUpdate;
    this.view.setChart(this.chart, this.series);
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.view.setChart(null, null);
  }

  paneViews() {
    return [this.view];
  }

  update(
    signals: BlockedSignal[],
    visibleCandles: Candle[],
    themeMode: "light" | "dark",
    variant: "mini" | "large",
  ) {
    this.view.update(signals, visibleCandles, themeMode, variant);
    this.requestUpdate?.();
  }
}

class BlockedSignalView implements IPrimitivePaneView {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Candlestick"> | null = null;
  private signals: BlockedSignal[] = [];
  private visibleCandles: Candle[] = [];
  private themeMode: "light" | "dark" = "dark";
  private variant: "mini" | "large" = "mini";

  setChart(chart: IChartApi | null, series: ISeriesApi<"Candlestick"> | null) {
    this.chart = chart;
    this.series = series;
  }

  update(
    signals: BlockedSignal[],
    visibleCandles: Candle[],
    themeMode: "light" | "dark",
    variant: "mini" | "large",
  ) {
    this.signals = signals.slice().sort((a, b) => a.timestamp - b.timestamp);
    this.visibleCandles = visibleCandles;
    this.themeMode = themeMode;
    this.variant = variant;
  }

  zOrder() {
    return "top" as const;
  }

  renderer() {
    if (!this.chart || !this.series || this.signals.length === 0 || this.visibleCandles.length === 0) return null;

    const points: BlockedSignalDrawingPoint[] = [];
    const size = this.variant === "large" ? 6.5 : 4.5;
    for (const signal of this.signals) {
      const candle = findVisibleCandleForTrade(this.visibleCandles, signal.timestamp);
      if (!candle) continue;
      const x = this.chart.timeScale().timeToCoordinate(toChartTime(candle.timestamp));
      const y = this.series.priceToCoordinate(candle.high);
      if (x === null || y === null) continue;
      points.push({
        color: getBlockedSignalColor(signal, this.themeMode),
        x,
        y: Math.max(size + 3, y - size * 1.45),
      });
    }

    return points.length > 0 ? new BlockedSignalRenderer(points, size, this.variant) : null;
  }
}

class BlockedSignalRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly points: BlockedSignalDrawingPoint[],
    private readonly size: number,
    private readonly variant: "mini" | "large",
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = this.variant === "large" ? 2 : 1.5;

      for (const point of this.points) {
        if (point.x < -this.size || point.x > mediaSize.width + this.size) continue;
        if (point.y < -this.size || point.y > mediaSize.height + this.size) continue;

        context.strokeStyle = point.color;
        context.shadowColor = point.color;
        context.shadowBlur = this.variant === "large" ? 4 : 2.5;
        context.beginPath();
        context.moveTo(point.x - this.size, point.y - this.size);
        context.lineTo(point.x + this.size, point.y + this.size);
        context.moveTo(point.x + this.size, point.y - this.size);
        context.lineTo(point.x - this.size, point.y + this.size);
        context.stroke();
      }

      context.restore();
    });
  }
}

function getBlockedSignalColor(signal: BlockedSignal, themeMode: "light" | "dark") {
  if (signal.reason === "safety") return themeMode === "dark" ? "#ff4f7b" : "#c51f4a";
  return themeMode === "dark" ? "#63d7ff" : "#007db0";
}

class DailyBoundaryPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly view = new DailyBoundaryView();

  constructor(themeMode: "light" | "dark", variant: "mini" | "large") {
    this.view.update(null, themeMode, variant);
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart as IChartApi;
    this.requestUpdate = param.requestUpdate;
    this.view.setChart(this.chart);
  }

  detached() {
    this.chart = null;
    this.requestUpdate = null;
    this.view.setChart(null);
  }

  paneViews() {
    return [this.view];
  }

  update(time: Time | null, themeMode: "light" | "dark", variant: "mini" | "large") {
    this.view.update(time, themeMode, variant);
    this.requestUpdate?.();
  }
}

class DailyBoundaryView implements IPrimitivePaneView {
  private chart: IChartApi | null = null;
  private color = "#f2b15e";
  private time: Time | null = null;
  private variant: "mini" | "large" = "mini";

  setChart(chart: IChartApi | null) {
    this.chart = chart;
  }

  update(time: Time | null, themeMode: "light" | "dark", variant: "mini" | "large") {
    this.time = time;
    this.variant = variant;
    this.color = themeMode === "dark" ? "#f2b15e" : "#c77713";
  }

  zOrder() {
    return "top" as const;
  }

  renderer() {
    if (!this.chart || this.time === null) return null;
    const x = this.chart.timeScale().timeToCoordinate(this.time);
    if (x === null) return null;
    return new DailyBoundaryRenderer(x, this.color, this.variant);
  }
}

class DailyBoundaryRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly x: number,
    private readonly color: string,
    private readonly variant: "mini" | "large",
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      if (this.x < 0 || this.x > mediaSize.width) return;

      context.save();
      context.strokeStyle = this.color;
      context.lineWidth = this.variant === "large" ? 3 : 2;
      context.setLineDash(this.variant === "large" ? [8, 5] : [6, 4]);
      context.shadowColor = this.color;
      context.shadowBlur = this.variant === "large" ? 8 : 5;
      context.beginPath();
      context.moveTo(this.x, 0);
      context.lineTo(this.x, mediaSize.height);
      context.stroke();
      context.restore();
    });
  }
}

function getVisibleDurationMs(interval: ChartInterval) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;

  if (interval.unit === "hour") return 30 * day;
  if (interval.value >= 30) return 7 * day;
  if (interval.value >= 5) return day;
  return 6 * hour;
}

function toChartTime(timestamp: number): Time {
  return Math.floor(timestamp / 1000) as Time;
}

function fromChartTime(time: Time) {
  if (typeof time === "number") return time * 1000;
  if (typeof time === "string") return Date.parse(`${time}T00:00:00Z`);
  return Date.UTC(time.year, time.month - 1, time.day);
}

function formatChartTimeLabel(time: Time) {
  return formatHourMinute(fromChartTime(time));
}

function formatTooltipTime(timestamp: number) {
  return formatMonthDayTime(timestamp);
}

function formatRangeLabel(candles: Candle[]) {
  if (candles.length === 0) return "No data";
  const first = candles[0];
  const last = candles[candles.length - 1];
  return `${formatShortDate(first.timestamp)} - ${formatShortDate(last.timestamp)}`;
}

function formatShortDate(timestamp: number) {
  return formatMonthDayTime(timestamp);
}

function formatHourMinute(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

function formatMonthDayTime(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value);
}

function formatSignedNumber(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber(value)}`;
}

function formatPct(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${(value * 100).toFixed(2)}%`;
}

function formatCompactKrw(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function getMeasurementSummary(p1: Candle, p2: Candle) {
  const priceDiff = p2.close - p1.close;
  const returnRate = priceDiff / p1.close;
  const volumeDiff = p2.volume - p1.volume;
  const quoteVolumeDiff = p2.quoteVolume - p1.quoteVolume;
  return {
    elapsed: formatElapsedTime(Math.abs(p2.timestamp - p1.timestamp)),
    priceDiff,
    quoteVolumeDiff,
    returnRate,
    volumeDiff,
  };
}

function formatElapsedTime(milliseconds: number) {
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getResponsiveChartOptions(width: number, variant: "mini" | "large") {
  if (variant === "large") {
    return {
      fontSize: clampNumber(Math.round(width / 92), 11, 14),
      priceScaleWidth: clampNumber(Math.round(width / 15), 84, 112),
    };
  }

  return {
    fontSize: clampNumber(Math.round(width / 38), 8, 12),
    priceScaleWidth: clampNumber(Math.round(width / 7), 48, 70),
  };
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
function getChartColors(themeMode: "light" | "dark") {
  if (themeMode === "dark") {
    return {
      text: "#a9bab3",
      grid: "rgba(169, 186, 179, 0.12)",
      crosshair: "rgba(164, 240, 207, 0.58)",
      up: "#6bd0a4",
      down: "#ef8181",
      volumeUp: "rgba(107, 208, 164, 0.32)",
      volumeDown: "rgba(239, 129, 129, 0.32)",
    };
  }

  return {
    text: "#65756f",
    grid: "rgba(101, 117, 111, 0.14)",
    crosshair: "rgba(18, 60, 52, 0.55)",
    up: "#16805a",
    down: "#c44e4e",
    volumeUp: "rgba(22, 128, 90, 0.34)",
    volumeDown: "rgba(196, 78, 78, 0.32)",
  };
}
