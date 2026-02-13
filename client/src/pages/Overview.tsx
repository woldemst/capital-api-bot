import { useState } from "react";
import {
  DollarSign,
  Target,
  TrendingUp,
  TrendingDown,
  Clock,
  BarChart3,
  Activity,
} from "lucide-react";
import { KPICard } from "@/components/dashboard/kpi-card";
import { KPICardSkeleton, ChartSkeleton } from "@/components/dashboard/loading-skeletons";
import { ErrorState } from "@/components/dashboard/error-state";
import { EquityChart, DailyPnLChart } from "@/components/charts/equity-charts";
import { DateRangePicker, SymbolSelect, DirectionSelect } from "@/components/filters/filter-bar";
import { useMetricsSummary, useEquity, useDailyPnL } from "@/hooks/use-trading-data";
import { formatPnL, formatPercentage, formatDuration } from "@/lib/trading-utils";

export default function Overview() {
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [symbol, setSymbol] = useState<string | undefined>(undefined);

  const filters = {
    from: dateFrom?.toISOString(),
    to: dateTo?.toISOString(),
    symbol,
  };

  const { data: metrics, isLoading: metricsLoading, isError: metricsError, refetch: refetchMetrics } = useMetricsSummary(filters);
  const { data: equity, isLoading: equityLoading } = useEquity(filters);
  const { data: dailyPnL, isLoading: dailyPnLLoading } = useDailyPnL(filters);

  const handleDateChange = (from: Date | undefined, to: Date | undefined) => {
    setDateFrom(from);
    setDateTo(to);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold gradient-text">Overview</h1>
        <p className="text-sm text-muted-foreground">Trading performance at a glance</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <DateRangePicker from={dateFrom} to={dateTo} onRangeChange={handleDateChange} />
        <SymbolSelect value={symbol} onChange={setSymbol} />
      </div>

      {/* KPI Cards */}
      {metricsError ? (
        <ErrorState 
          title="Failed to load metrics" 
          message="Unable to fetch trading metrics. Please check your API connection."
          onRetry={() => refetchMetrics()} 
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {metricsLoading ? (
            <>
              {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                <KPICardSkeleton key={i} />
              ))}
            </>
          ) : metrics ? (
            <>
              <KPICard
                title="Total PnL"
                value={formatPnL(metrics.totalPnL, 2)}
                trend={metrics.totalPnL >= 0 ? "up" : "down"}
                icon={<DollarSign className="h-5 w-5 text-primary" />}
              />
              <KPICard
                title="Win Rate"
                value={formatPercentage(metrics.winRate)}
                subtitle={`${metrics.wins}W / ${metrics.losses}L`}
                icon={<Target className="h-5 w-5 text-primary" />}
              />
              <KPICard
                title="Profit Factor"
                value={metrics.profitFactor.toFixed(2)}
                trend={metrics.profitFactor >= 1 ? "up" : "down"}
                icon={<TrendingUp className="h-5 w-5 text-primary" />}
              />
              <KPICard
                title="Expectancy"
                value={formatPnL(metrics.expectancy, 4)}
                trend={metrics.expectancy >= 0 ? "up" : "down"}
                icon={<Activity className="h-5 w-5 text-primary" />}
              />
              <KPICard
                title="Max Drawdown"
                value={formatPnL(metrics.maxDrawdown, 2)}
                trend="down"
                icon={<TrendingDown className="h-5 w-5 text-primary" />}
              />
              <KPICard
                title="Avg Duration"
                value={formatDuration(metrics.avgTradeDurationMinutes)}
                icon={<Clock className="h-5 w-5 text-primary" />}
              />
              <KPICard
                title="Total Trades"
                value={metrics.totalTrades}
                icon={<BarChart3 className="h-5 w-5 text-primary" />}
              />
            </>
          ) : null}
        </div>
      )}

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        {equityLoading ? (
          <ChartSkeleton />
        ) : equity?.points.length ? (
          <EquityChart data={equity.points} />
        ) : (
          <div className="glass-card p-4">
            <h3 className="mb-4 text-sm font-medium text-muted-foreground">Equity Curve</h3>
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              No equity data available
            </div>
          </div>
        )}

        {dailyPnLLoading ? (
          <ChartSkeleton />
        ) : dailyPnL?.days.length ? (
          <DailyPnLChart data={dailyPnL.days} />
        ) : (
          <div className="glass-card p-4">
            <h3 className="mb-4 text-sm font-medium text-muted-foreground">Daily PnL</h3>
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              No daily PnL data available
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
