import { useEffect, useMemo, useState } from "react";
import { DateRangePicker } from "@/components/filters/filter-bar";
import { useBacktestCompare, useBacktestOptions } from "@/hooks/use-trading-data";
import { formatPercentage } from "@/lib/trading-utils";
import { ErrorState } from "@/components/dashboard/error-state";
import { KPICard } from "@/components/dashboard/kpi-card";
import { EquityChart } from "@/components/charts/equity-charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BacktestCompareFilters, BacktestStrategyId } from "@/types/trading";

function formatPoints(value: number, digits = 5) {
  if (!Number.isFinite(value)) return "0";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function strategyLabel(id: BacktestStrategyId) {
  if (id === "FOREX_H1_M15_M5") return "Forex H1 / M15 / M5";
  if (id === "CRYPTO_H1_M15_M5") return "Crypto H1 / M15 / M5";
  return "Logged Live";
}

export default function Overview() {
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [selectedStrategies, setSelectedStrategies] = useState<BacktestStrategyId[]>(["FOREX_H1_M15_M5", "CRYPTO_H1_M15_M5", "logged_live"]);
  const [maxHoldMinutes, setMaxHoldMinutes] = useState<number>(300);
  const [runFilters, setRunFilters] = useState<BacktestCompareFilters | null>(null);
  const [equityStrategyId, setEquityStrategyId] = useState<BacktestStrategyId>("FOREX_H1_M15_M5");

  const optionsQuery = useBacktestOptions();
  const compareQuery = useBacktestCompare(runFilters || {}, !!runFilters);

  useEffect(() => {
    if (!optionsQuery.data) return;
    if (!selectedSymbols.length) {
      setSelectedSymbols(optionsQuery.data.symbols.slice(0, 6));
    }
    if (!selectedSessions.length) {
      setSelectedSessions(optionsQuery.data.sessions);
    }
  }, [optionsQuery.data, selectedSymbols.length, selectedSessions.length]);

  useEffect(() => {
    const best = compareQuery.data?.strategyResults?.[0];
    if (best) {
      setEquityStrategyId(best.strategyId);
    }
  }, [compareQuery.data]);

  const strategyResults = compareQuery.data?.strategyResults || [];
  const bestStrategy = strategyResults[0] || null;
  const selectedStrategy = strategyResults.find((result) => result.strategyId === equityStrategyId) || strategyResults[0] || null;

  const totalComparedTrades = useMemo(
    () => strategyResults.reduce((acc, result) => acc + result.totalTrades, 0),
    [strategyResults],
  );

  const toggleFromList = (value: string, list: string[], setList: (next: string[]) => void) => {
    if (list.includes(value)) {
      setList(list.filter((item) => item !== value));
    } else {
      setList([...list, value]);
    }
  };

  const toggleStrategy = (strategyId: BacktestStrategyId) => {
    if (selectedStrategies.includes(strategyId)) {
      const next = selectedStrategies.filter((item) => item !== strategyId);
      if (next.length) setSelectedStrategies(next);
      return;
    }
    setSelectedStrategies([...selectedStrategies, strategyId]);
  };

  const runBacktest = () => {
    setRunFilters({
      from: dateFrom?.toISOString(),
      to: dateTo?.toISOString(),
      symbols: selectedSymbols,
      sessions: selectedSessions,
      strategies: selectedStrategies,
      includeLogged: selectedStrategies.includes("logged_live"),
      maxHoldMinutes,
      sampleLimit: 200,
    });
  };

  if (optionsQuery.isError) {
    return (
      <ErrorState
        title="Backtest options could not be loaded"
        message="Please check if the Hub API is running and /api/backtest/options is reachable."
        onRetry={() => optionsQuery.refetch()}
      />
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold gradient-text">Backtesting Hub</h1>
        <p className="text-sm text-muted-foreground">Compare strategies on JSONL minute logs by period, session and symbol.</p>
      </div>

      <div className="glass-card space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-4">
          <DateRangePicker from={dateFrom} to={dateTo} onRangeChange={(from, to) => { setDateFrom(from); setDateTo(to); }} />
          <div className="w-40">
            <Label htmlFor="max-hold">Max Hold (min)</Label>
            <Input
              id="max-hold"
              type="number"
              min={30}
              max={720}
              value={maxHoldMinutes}
              onChange={(event) => setMaxHoldMinutes(Number(event.target.value || 300))}
            />
          </div>
          <Button onClick={runBacktest} disabled={compareQuery.isFetching || !selectedSymbols.length || !selectedStrategies.length}>
            {compareQuery.isFetching ? "Running..." : "Run Backtest"}
          </Button>
        </div>

        <div className="space-y-2">
          <Label>Symbols</Label>
          <div className="flex flex-wrap gap-2">
            {optionsQuery.data?.symbols.map((symbol) => (
              <Button
                key={symbol}
                size="sm"
                variant={selectedSymbols.includes(symbol) ? "default" : "outline"}
                onClick={() => toggleFromList(symbol, selectedSymbols, setSelectedSymbols)}
              >
                {symbol}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Sessions</Label>
          <div className="flex flex-wrap gap-2">
            {optionsQuery.data?.sessions.map((session) => (
              <Button
                key={session}
                size="sm"
                variant={selectedSessions.includes(session) ? "default" : "outline"}
                onClick={() => toggleFromList(session, selectedSessions, setSelectedSessions)}
              >
                {session}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Strategies</Label>
          <div className="flex flex-wrap gap-2">
            {optionsQuery.data?.strategies.map((strategy) => (
              <Button
                key={strategy.id}
                size="sm"
                variant={selectedStrategies.includes(strategy.id) ? "default" : "outline"}
                onClick={() => toggleStrategy(strategy.id)}
              >
                {strategy.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {compareQuery.isError ? (
        <ErrorState
          title="Backtest run failed"
          message="Could not compute comparison. Check selected filters and API logs."
          onRetry={() => compareQuery.refetch()}
        />
      ) : null}

      {strategyResults.length && bestStrategy && selectedStrategy ? (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <KPICard title="Best Strategy" value={strategyLabel(bestStrategy.strategyId)} />
            <KPICard title="Best Total Points" value={formatPoints(bestStrategy.totalPoints)} trend={bestStrategy.totalPoints >= 0 ? "up" : "down"} />
            <KPICard title="Compared Strategies" value={strategyResults.length} />
            <KPICard title="Total Compared Trades" value={totalComparedTrades} />
          </div>

          <div className="glass-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-muted-foreground">Strategy Comparison</h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Strategy</TableHead>
                  <TableHead>Trades</TableHead>
                  <TableHead>Win Rate</TableHead>
                  <TableHead>Total Points</TableHead>
                  <TableHead>Expectancy</TableHead>
                  <TableHead>Profit Factor</TableHead>
                  <TableHead>Max Drawdown</TableHead>
                  <TableHead>Avg Hold</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {strategyResults.map((result) => (
                  <TableRow key={result.strategyId}>
                    <TableCell>{strategyLabel(result.strategyId)}</TableCell>
                    <TableCell>{result.totalTrades}</TableCell>
                    <TableCell>{formatPercentage(result.winRate)}</TableCell>
                    <TableCell className={result.totalPoints >= 0 ? "text-profit" : "text-loss"}>{formatPoints(result.totalPoints)}</TableCell>
                    <TableCell>{formatPoints(result.expectancyPoints)}</TableCell>
                    <TableCell>{result.profitFactor.toFixed(2)}</TableCell>
                    <TableCell className="text-loss">{formatPoints(result.maxDrawdownPoints)}</TableCell>
                    <TableCell>{result.avgHoldMinutes.toFixed(1)}m</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="glass-card p-4">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Equity Strategy:</span>
              {strategyResults.map((result) => (
                <Button
                  key={`equity-${result.strategyId}`}
                  size="sm"
                  variant={equityStrategyId === result.strategyId ? "default" : "outline"}
                  onClick={() => setEquityStrategyId(result.strategyId)}
                >
                  {strategyLabel(result.strategyId)}
                </Button>
              ))}
            </div>
            {selectedStrategy?.equityPoints?.length ? (
              <EquityChart data={selectedStrategy.equityPoints} />
            ) : (
              <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">No equity points for selected strategy.</div>
            )}
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <div className="glass-card p-4">
              <h3 className="mb-3 text-sm font-medium text-muted-foreground">By Symbol ({strategyLabel(selectedStrategy.strategyId)})</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Trades</TableHead>
                    <TableHead>Win Rate</TableHead>
                    <TableHead>Total Points</TableHead>
                    <TableHead>Avg Points</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedStrategy.bySymbol.map((item) => (
                    <TableRow key={`${selectedStrategy.strategyId}-${item.symbol}`}>
                      <TableCell>{item.symbol}</TableCell>
                      <TableCell>{item.trades}</TableCell>
                      <TableCell>{formatPercentage(item.winRate)}</TableCell>
                      <TableCell className={item.totalPoints >= 0 ? "text-profit" : "text-loss"}>{formatPoints(item.totalPoints)}</TableCell>
                      <TableCell>{formatPoints(item.avgPoints)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="glass-card p-4">
              <h3 className="mb-3 text-sm font-medium text-muted-foreground">Recent Trades ({strategyLabel(selectedStrategy.strategyId)})</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Signal</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Points</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedStrategy.tradesSample.slice(0, 20).map((trade) => (
                    <TableRow key={trade.dealId}>
                      <TableCell>{trade.symbol}</TableCell>
                      <TableCell>{trade.signal.toUpperCase()}</TableCell>
                      <TableCell>{trade.closeReason}</TableCell>
                      <TableCell className={trade.pnlPoints >= 0 ? "text-profit" : "text-loss"}>{formatPoints(trade.pnlPoints)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      ) : (
        <div className="glass-card p-6 text-sm text-muted-foreground">
          Run a backtest to see strategy comparison, equity and symbol-level performance.
        </div>
      )}
    </div>
  );
}
