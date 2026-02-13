import { useState } from "react";
import { Target, TrendingDown, BarChart3, AlertTriangle } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { KPICardSkeleton, TableSkeleton } from "@/components/dashboard/loading-skeletons";
import { ErrorState } from "@/components/dashboard/error-state";
import { DateRangePicker, SymbolSelect } from "@/components/filters/filter-bar";
import { usePatterns } from "@/hooks/use-trading-data";
import { formatPercentage, formatPnL, getCloseReasonLabel } from "@/lib/trading-utils";
import { cn } from "@/lib/utils";

export default function Patterns() {
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [symbol, setSymbol] = useState<string | undefined>(undefined);

  const filters = {
    from: dateFrom?.toISOString(),
    to: dateTo?.toISOString(),
    symbol,
  };

  const { data: patterns, isLoading, isError, refetch } = usePatterns(filters);

  const handleDateChange = (from: Date | undefined, to: Date | undefined) => {
    setDateFrom(from);
    setDateTo(to);
  };

  if (isError) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold gradient-text">Patterns</h1>
          <p className="text-sm text-muted-foreground">Discover trading patterns and edge analysis</p>
        </div>
        <ErrorState
          title="Failed to load patterns"
          message="Unable to fetch pattern data. Please check your API connection."
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold gradient-text">Patterns</h1>
        <p className="text-sm text-muted-foreground">Discover trading patterns and edge analysis</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <DateRangePicker from={dateFrom} to={dateTo} onRangeChange={handleDateChange} />
        <SymbolSelect value={symbol} onChange={setSymbol} />
      </div>

      {/* By Close Reason */}
      <section>
        <h2 className="mb-4 text-lg font-semibold flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          By Close Reason
        </h2>
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
            {[1, 2, 3, 4, 5].map((i) => (
              <KPICardSkeleton key={i} />
            ))}
          </div>
        ) : patterns?.byCloseReason?.length ? (
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
            {patterns.byCloseReason.map((item) => (
              <div key={item.closeReason} className="kpi-card">
                <p className="text-sm text-muted-foreground">
                  {getCloseReasonLabel(item.closeReason)}
                </p>
                <p className="text-2xl font-bold">{item.count}</p>
                <p className={cn(
                  "text-sm font-medium",
                  item.winRate >= 0.5 ? "text-profit" : "text-loss"
                )}>
                  {formatPercentage(item.winRate)} win rate
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="glass-card p-8 text-center text-muted-foreground">
            No close reason data available
          </div>
        )}
      </section>

      {/* By Symbol */}
      <section>
        <h2 className="mb-4 text-lg font-semibold flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          By Symbol
        </h2>
        {isLoading ? (
          <div className="glass-card overflow-hidden">
            <TableSkeleton rows={5} />
          </div>
        ) : patterns?.bySymbol?.length ? (
          <div className="glass-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                  <TableHead className="text-right">Win Rate</TableHead>
                  <TableHead className="text-right">Avg PnL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {patterns.bySymbol.map((item) => (
                  <TableRow key={item.symbol}>
                    <TableCell className="font-medium">{item.symbol}</TableCell>
                    <TableCell className="text-right">{item.count}</TableCell>
                    <TableCell className={cn(
                      "text-right font-medium",
                      item.winRate >= 0.5 ? "text-profit" : "text-loss"
                    )}>
                      {formatPercentage(item.winRate)}
                    </TableCell>
                    <TableCell className={cn(
                      "text-right font-mono",
                      (item.avgPnL ?? 0) >= 0 ? "text-profit" : "text-loss"
                    )}>
                      {item.avgPnL !== undefined ? formatPnL(item.avgPnL) : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="glass-card p-8 text-center text-muted-foreground">
            No symbol data available
          </div>
        )}
      </section>

      {/* Trend Fade Detector */}
      <section>
        <h2 className="mb-4 text-lg font-semibold flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-primary" />
          Trend Fade Detector
          <Badge variant="secondary" className="text-xs">
            Trades that were profitable but closed negative
          </Badge>
        </h2>
        {isLoading ? (
          <div className="glass-card overflow-hidden">
            <TableSkeleton rows={5} />
          </div>
        ) : patterns?.trendFade?.length ? (
          <div className="glass-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Deal ID</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Max Unrealized</TableHead>
                  <TableHead className="text-right">Final PnL</TableHead>
                  <TableHead className="text-right">Missed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {patterns.trendFade.map((item) => (
                  <TableRow key={item.dealId}>
                    <TableCell className="font-mono text-xs">
                      {item.dealId.slice(0, 8)}...
                    </TableCell>
                    <TableCell className="font-medium">{item.symbol}</TableCell>
                    <TableCell className="text-right font-mono text-profit">
                      {formatPnL(item.maxUnrealized)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-loss">
                      {formatPnL(item.finalPnL)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {formatPnL(item.maxUnrealized - item.finalPnL)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="glass-card p-8 text-center text-muted-foreground">
            No trend fade trades detected
          </div>
        )}
      </section>

      {/* Indicator Distributions */}
      <section>
        <h2 className="mb-4 text-lg font-semibold flex items-center gap-2">
          <TrendingDown className="h-5 w-5 text-primary" />
          Indicator Distributions
        </h2>
        {isLoading ? (
          <div className="glass-card p-8">
            <div className="h-40 w-full animate-pulse rounded bg-muted" />
          </div>
        ) : patterns?.indicatorDistributions && Object.keys(patterns.indicatorDistributions).length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            {Object.entries(patterns.indicatorDistributions).map(([key, dist]) => (
              <div key={key} className="glass-card p-4">
                <h4 className="mb-4 text-sm font-medium uppercase">{key.replace("_", " ")}</h4>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-12">Wins</span>
                    <div className="flex-1 flex gap-1">
                      {dist.wins.counts.map((count, i) => (
                        <div
                          key={i}
                          className="flex-1 bg-profit/20 rounded"
                          style={{ height: `${Math.max(4, count * 2)}px` }}
                          title={`${dist.wins.buckets[i]}-${dist.wins.buckets[i + 1]}: ${count}`}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-12">Losses</span>
                    <div className="flex-1 flex gap-1">
                      {dist.losses.counts.map((count, i) => (
                        <div
                          key={i}
                          className="flex-1 bg-loss/20 rounded"
                          style={{ height: `${Math.max(4, count * 2)}px` }}
                          title={`${dist.losses.buckets[i]}-${dist.losses.buckets[i + 1]}: ${count}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="glass-card p-8 text-center text-muted-foreground">
            No indicator distribution data available
          </div>
        )}
      </section>
    </div>
  );
}
