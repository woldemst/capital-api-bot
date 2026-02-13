import { useState, useMemo } from "react";
import { Download, Clock, DollarSign, Radio } from "lucide-react";
import Papa from "papaparse";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TableSkeleton } from "@/components/dashboard/loading-skeletons";
import { ErrorState } from "@/components/dashboard/error-state";
import { DateRangePicker, SymbolSelect } from "@/components/filters/filter-bar";
import { usePriceSnapshotsInfinite } from "@/hooks/use-trading-data";
import { formatTimestamp, formatPrice } from "@/lib/trading-utils";

export default function PriceInsights() {
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [symbol, setSymbol] = useState<string>("EURUSD");

  const filters = {
    symbol,
    from: dateFrom?.toISOString(),
    to: dateTo?.toISOString(),
    limit: 100,
  };

  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = usePriceSnapshotsInfinite(filters);

  const allSnapshots = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap((page) => page.data);
  }, [data]);

  // Calculate spread statistics
  const spreadStats = useMemo(() => {
    if (!allSnapshots.length) return null;
    
    const spreads = allSnapshots.map((s) => s.spread);
    const avg = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const min = Math.min(...spreads);
    const max = Math.max(...spreads);
    
    return { avg, min, max };
  }, [allSnapshots]);

  // Session breakdown
  const sessionStats = useMemo(() => {
    if (!allSnapshots.length) return [];
    
    const sessionCounts: Record<string, number> = {};
    allSnapshots.forEach((s) => {
      s.sessions.forEach((session) => {
        sessionCounts[session] = (sessionCounts[session] || 0) + 1;
      });
    });
    
    return Object.entries(sessionCounts)
      .map(([session, count]) => ({ session, count, percentage: count / allSnapshots.length }))
      .sort((a, b) => b.count - a.count);
  }, [allSnapshots]);

  // News blocked count
  const newsBlockedStats = useMemo(() => {
    if (!allSnapshots.length) return null;
    
    const blocked = allSnapshots.filter((s) => s.newsBlocked).length;
    return {
      blocked,
      total: allSnapshots.length,
      percentage: blocked / allSnapshots.length,
    };
  }, [allSnapshots]);

  const handleExportCSV = () => {
    const csvData = allSnapshots.map((snapshot) => ({
      Symbol: snapshot.symbol,
      Timestamp: snapshot.timestamp,
      Bid: snapshot.bid,
      Ask: snapshot.ask,
      Mid: snapshot.mid,
      Spread: snapshot.spread,
      Price: snapshot.price,
      Sessions: snapshot.sessions.join(", "),
      "News Blocked": snapshot.newsBlocked ? "Yes" : "No",
    }));

    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `price-snapshots-${symbol}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
  };

  const handleDateChange = (from: Date | undefined, to: Date | undefined) => {
    setDateFrom(from);
    setDateTo(to);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold gradient-text">Price Insights</h1>
          <p className="text-sm text-muted-foreground">
            Market data analysis from price snapshots
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={!allSnapshots.length}>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <SymbolSelect value={symbol} onChange={(v) => setSymbol(v || "EURUSD")} />
        <DateRangePicker from={dateFrom} to={dateTo} onRangeChange={handleDateChange} />
      </div>

      {isError ? (
        <ErrorState
          title="Failed to load price data"
          message="Unable to fetch price snapshots. Please check your API connection."
          onRetry={() => refetch()}
        />
      ) : (
        <>
          {/* Stats Cards */}
          <div className="grid gap-4 md:grid-cols-3">
            {/* Spread Stats */}
            <div className="kpi-card">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <DollarSign className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Spread Analysis</p>
                  {spreadStats ? (
                    <div className="space-y-1 mt-2">
                      <p className="text-sm">
                        Avg: <span className="font-mono font-medium">{spreadStats.avg.toFixed(5)}</span>
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Range: {spreadStats.min.toFixed(5)} - {spreadStats.max.toFixed(5)}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground mt-2">No data</p>
                  )}
                </div>
              </div>
            </div>

            {/* Session Stats */}
            <div className="kpi-card">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Clock className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Active Sessions</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {sessionStats.slice(0, 4).map((stat) => (
                      <Badge key={stat.session} variant="secondary" className="text-xs">
                        {stat.session}: {(stat.percentage * 100).toFixed(0)}%
                      </Badge>
                    ))}
                    {sessionStats.length === 0 && (
                      <p className="text-sm text-muted-foreground">No data</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* News Blocked */}
            <div className="kpi-card">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Radio className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">News Impact</p>
                  {newsBlockedStats ? (
                    <div className="mt-2">
                      <p className="text-sm">
                        <span className="font-medium">{newsBlockedStats.blocked}</span> blocked periods
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {(newsBlockedStats.percentage * 100).toFixed(1)}% of snapshots
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground mt-2">No data</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Data Table */}
          <section>
            <h2 className="mb-4 text-lg font-semibold">Price Snapshots</h2>
            {isLoading ? (
              <div className="glass-card overflow-hidden">
                <TableSkeleton rows={10} />
              </div>
            ) : allSnapshots.length === 0 ? (
              <div className="glass-card p-12 text-center">
                <p className="text-muted-foreground">No price snapshots found for {symbol}</p>
              </div>
            ) : (
              <div className="glass-card overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Timestamp</TableHead>
                      <TableHead className="text-right">Bid</TableHead>
                      <TableHead className="text-right">Ask</TableHead>
                      <TableHead className="text-right">Spread</TableHead>
                      <TableHead>Sessions</TableHead>
                      <TableHead>News</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allSnapshots.map((snapshot, i) => (
                      <TableRow key={`${snapshot.timestamp}-${i}`}>
                        <TableCell className="text-sm">
                          {formatTimestamp(snapshot.timestamp)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatPrice(snapshot.bid)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatPrice(snapshot.ask)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {snapshot.spread.toFixed(5)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {snapshot.sessions.map((session) => (
                              <Badge key={session} variant="outline" className="text-xs">
                                {session}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          {snapshot.newsBlocked ? (
                            <Badge variant="destructive" className="text-xs">
                              Blocked
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">
                              Clear
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {hasNextPage && (
                  <div className="flex justify-center border-t p-4">
                    <Button
                      variant="outline"
                      onClick={() => fetchNextPage()}
                      disabled={isFetchingNextPage}
                    >
                      {isFetchingNextPage ? "Loading..." : "Load More"}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
