import { useEffect, useRef } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, AreaSeries, HistogramSeries, AreaData, HistogramData, Time } from "lightweight-charts";
import { useTheme } from "@/components/theme-provider";
import type { EquityPoint, DailyPnL } from "@/types/trading";

interface EquityChartProps {
  data: EquityPoint[];
}

export function EquityChart({ data }: EquityChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const { theme } = useTheme();

  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    if (!containerRef.current) return;
    const initialHeight = window.innerWidth < 640 ? 220 : 300;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: isDark ? "#94a3b8" : "#64748b",
      },
      grid: {
        vertLines: { color: isDark ? "#1e293b" : "#e2e8f0" },
        horzLines: { color: isDark ? "#1e293b" : "#e2e8f0" },
      },
      width: containerRef.current.clientWidth,
      height: initialHeight,
      rightPriceScale: {
        borderVisible: false,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
      },
      crosshair: {
        horzLine: { color: isDark ? "#38bdf8" : "#0ea5e9" },
        vertLine: { color: isDark ? "#38bdf8" : "#0ea5e9" },
      },
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: "#22d3ee",
      topColor: "rgba(34, 211, 238, 0.4)",
      bottomColor: "rgba(34, 211, 238, 0.0)",
      lineWidth: 2,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: window.innerWidth < 640 ? 220 : 300,
        });
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [isDark]);

  useEffect(() => {
    if (!seriesRef.current) return;
    if (!data.length) {
      seriesRef.current.setData([]);
      return;
    }

    const chartData: AreaData<Time>[] = data
      .map((point) => {
        const tsMs = Date.parse(point.timestamp || "");
        if (!Number.isFinite(tsMs)) return null;
        return {
          time: Math.floor(tsMs / 1000) as Time,
          value: point.equity,
        };
      })
      .filter((point): point is AreaData<Time> => point !== null)
      .sort((a, b) => Number(a.time) - Number(b.time));

    if (!chartData.length) {
      seriesRef.current.setData([]);
      return;
    }

    seriesRef.current.setData(chartData);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">Equity Curve</h3>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}

interface DailyPnLChartProps {
  data: DailyPnL[];
}

export function DailyPnLChart({ data }: DailyPnLChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const { theme } = useTheme();

  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    if (!containerRef.current) return;
    const initialHeight = window.innerWidth < 640 ? 180 : 220;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: isDark ? "#94a3b8" : "#64748b",
      },
      grid: {
        vertLines: { color: isDark ? "#1e293b" : "#e2e8f0" },
        horzLines: { color: isDark ? "#1e293b" : "#e2e8f0" },
      },
      width: containerRef.current.clientWidth,
      height: initialHeight,
      rightPriceScale: {
        borderVisible: false,
      },
      timeScale: {
        borderVisible: false,
      },
    });

    const series = chart.addSeries(HistogramSeries, {
      color: "#22d3ee",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: window.innerWidth < 640 ? 180 : 220,
        });
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [isDark]);

  useEffect(() => {
    if (!seriesRef.current || !data.length) return;

    const chartData: HistogramData<Time>[] = data
      .map((day) => {
        const tsMs = Date.parse(day.date || "");
        if (!Number.isFinite(tsMs)) return null;
        return {
          time: Math.floor(tsMs / 1000) as Time,
          value: day.pnl,
          color: day.pnl >= 0 ? "#22c55e" : "#ef4444",
        };
      })
      .filter((point): point is HistogramData<Time> => point !== null)
      .sort((a, b) => Number(a.time) - Number(b.time));

    seriesRef.current.setData(chartData);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">Daily PnL</h3>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}
