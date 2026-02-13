import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Download, ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";
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
import {
  DateRangePicker,
  SymbolSelect,
  DirectionSelect,
  CloseReasonSelect,
  PnLFilter,
} from "@/components/filters/filter-bar";
import { useTradesInfinite } from "@/hooks/use-trading-data";
import {
  enrichTrade,
  formatPnL,
  formatDuration,
  formatTimestamp,
  formatPrice,
  getCloseReasonLabel,
  getSignalLabel,
} from "@/lib/trading-utils";
import { cn } from "@/lib/utils";
import type { Direction, CloseReason, ComputedTrade } from "@/types/trading";

type SortField = "openedAt" | "closedAt" | "pnl" | "symbol" | "duration";
type SortDirection = "asc" | "desc";

export default function Trades() {
  const navigate = useNavigate();
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [symbol, setSymbol] = useState<string | undefined>(undefined);
  const [direction, setDirection] = useState<Direction | undefined>(undefined);
  const [closeReason, setCloseReason] = useState<CloseReason | undefined>(undefined);
  const [pnlFilter, setPnlFilter] = useState<"positive" | "negative" | undefined>(undefined);
  const [sortField, setSortField] = useState<SortField>("openedAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const filters = {
    from: dateFrom?.toISOString(),
    to: dateTo?.toISOString(),
    symbol,
    direction,
    closeReason,
    status: "closed" as const,
    limit: 50,
  };

  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useTradesInfinite(filters);

  const allTrades = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap((page) => page.data.map(enrichTrade));
  }, [data]);

  const filteredTrades = useMemo(() => {
    let trades = allTrades;

    if (pnlFilter === "positive") {
      trades = trades.filter((t) => (t.pnl ?? 0) > 0);
    } else if (pnlFilter === "negative") {
      trades = trades.filter((t) => (t.pnl ?? 0) < 0);
    }

    trades.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;

      switch (sortField) {
        case "openedAt":
          aVal = new Date(a.openedAt).getTime();
          bVal = new Date(b.openedAt).getTime();
          break;
        case "closedAt":
          aVal = a.closedAt ? new Date(a.closedAt).getTime() : 0;
          bVal = b.closedAt ? new Date(b.closedAt).getTime() : 0;
          break;
        case "pnl":
          aVal = a.pnl ?? 0;
          bVal = b.pnl ?? 0;
          break;
        case "symbol":
          aVal = a.symbol;
          bVal = b.symbol;
          break;
        case "duration":
          aVal = a.durationMinutes ?? 0;
          bVal = b.durationMinutes ?? 0;
          break;
      }

      if (sortDirection === "asc") {
        return aVal > bVal ? 1 : -1;
      }
      return aVal < bVal ? 1 : -1;
    });

    return trades;
  }, [allTrades, pnlFilter, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const handleExportCSV = () => {
    const csvData = filteredTrades.map((trade) => ({
      "Deal ID": trade.dealId,
      Symbol: trade.symbol,
      Direction: getSignalLabel(trade.signal),
      "Entry Price": trade.entryPrice,
      "Close Price": trade.closePrice,
      PnL: trade.pnl,
      "Close Reason": getCloseReasonLabel(trade.closeReason || "unknown"),
      "Opened At": trade.openedAt,
      "Closed At": trade.closedAt,
      "Duration (min)": trade.durationMinutes,
    }));

    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trades-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="ml-1 h-3 w-3 opacity-50" />;
    return sortDirection === "asc" ? (
      <ChevronUp className="ml-1 h-3 w-3" />
    ) : (
      <ChevronDown className="ml-1 h-3 w-3" />
    );
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold gradient-text">Trades</h1>
          <p className="text-sm text-muted-foreground">
            Browse and analyze your trade history
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={!filteredTrades.length}>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <DateRangePicker
          from={dateFrom}
          to={dateTo}
          onRangeChange={(from, to) => {
            setDateFrom(from);
            setDateTo(to);
          }}
        />
        <SymbolSelect value={symbol} onChange={setSymbol} />
        <DirectionSelect value={direction} onChange={setDirection} />
        <CloseReasonSelect value={closeReason} onChange={setCloseReason} />
        <PnLFilter value={pnlFilter} onChange={setPnlFilter} />
      </div>

      {/* Table */}
      {isError ? (
        <ErrorState
          title="Failed to load trades"
          message="Unable to fetch trade history. Please check your API connection."
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div className="glass-card overflow-hidden">
          <TableSkeleton rows={10} />
        </div>
      ) : filteredTrades.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <p className="text-muted-foreground">No trades found matching your filters</p>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-24">Deal ID</TableHead>
                <TableHead
                  className="cursor-pointer"
                  onClick={() => handleSort("symbol")}
                >
                  <span className="flex items-center">
                    Symbol <SortIcon field="symbol" />
                  </span>
                </TableHead>
                <TableHead>Direction</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Close</TableHead>
                <TableHead
                  className="cursor-pointer text-right"
                  onClick={() => handleSort("pnl")}
                >
                  <span className="flex items-center justify-end">
                    PnL <SortIcon field="pnl" />
                  </span>
                </TableHead>
                <TableHead>Reason</TableHead>
                <TableHead
                  className="cursor-pointer"
                  onClick={() => handleSort("openedAt")}
                >
                  <span className="flex items-center">
                    Opened <SortIcon field="openedAt" />
                  </span>
                </TableHead>
                <TableHead
                  className="cursor-pointer text-right"
                  onClick={() => handleSort("duration")}
                >
                  <span className="flex items-center justify-end">
                    Duration <SortIcon field="duration" />
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTrades.map((trade) => (
                <TableRow
                  key={trade.dealId}
                  className="cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => navigate(`/trades/${trade.dealId}`)}
                >
                  <TableCell className="font-mono text-xs">
                    {trade.dealId.slice(0, 8)}...
                  </TableCell>
                  <TableCell className="font-medium">{trade.symbol}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        trade.signal === "buy"
                          ? "border-profit text-profit"
                          : "border-loss text-loss"
                      )}
                    >
                      {getSignalLabel(trade.signal)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatPrice(trade.entryPrice)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {trade.closePrice ? formatPrice(trade.closePrice) : "-"}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-sm font-medium",
                      (trade.pnl ?? 0) >= 0 ? "text-profit" : "text-loss"
                    )}
                  >
                    {formatPnL(trade.pnl ?? 0)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {getCloseReasonLabel(trade.closeReason || "unknown")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatTimestamp(trade.openedAt)}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {formatDuration(trade.durationMinutes ?? 0)}
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
    </div>
  );
}
