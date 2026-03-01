import { useEffect, useMemo, useState } from "react";
import { DateRangePicker } from "@/components/filters/filter-bar";
import { useBacktestCompare, useBacktestOptions, useRuntimeConfig } from "@/hooks/use-trading-data";
import { formatPercentage } from "@/lib/trading-utils";
import { ErrorState } from "@/components/dashboard/error-state";
import { KPICard } from "@/components/dashboard/kpi-card";
import { EquityChart } from "@/components/charts/equity-charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BacktestCompareFilters, BacktestStrategyId } from "@/types/trading";

const KNOWN_CRYPTO_SYMBOLS = ["BTCUSD", "ETHUSD", "DOGEUSD"];

function formatPoints(value: number, digits = 5) {
  if (!Number.isFinite(value)) return "0";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function formatMoney(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "0";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}€`;
}

function formatMinute(minute: number) {
  const normalized = ((minute % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hh = Math.floor(normalized / 60).toString().padStart(2, "0");
  const mm = (normalized % 60).toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatWindows(windows: Array<{ start: number; end: number }>) {
  return windows.map((window) => `${formatMinute(window.start)}-${formatMinute(window.end)}`).join(", ");
}

function strategyLabel(id: BacktestStrategyId) {
  if (id === "INTRADAY_7STEP_V1") return "Intraday 7-Step";
  return id;
}

export default function Overview() {
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [selectedStrategies, setSelectedStrategies] = useState<BacktestStrategyId[]>(["INTRADAY_7STEP_V1"]);
  const [startBalanceInput, setStartBalanceInput] = useState<number>(500);
  const [forexRiskInputPct, setForexRiskInputPct] = useState<number>(3);
  const [cryptoRiskInputPct, setCryptoRiskInputPct] = useState<number>(2);
  const [respectNewsGuard, setRespectNewsGuard] = useState<boolean>(true);
  const [defaultsApplied, setDefaultsApplied] = useState<boolean>(false);
  const [runFilters, setRunFilters] = useState<BacktestCompareFilters | null>(null);
  const [equityStrategyId, setEquityStrategyId] = useState<BacktestStrategyId>("INTRADAY_7STEP_V1");

  const optionsQuery = useBacktestOptions();
  const runtimeConfigQuery = useRuntimeConfig();
  const compareQuery = useBacktestCompare(runFilters || {}, !!runFilters);
  const availableCryptoSymbols = useMemo(
    () => (optionsQuery.data?.symbols || []).filter((symbol) => KNOWN_CRYPTO_SYMBOLS.includes(symbol)),
    [optionsQuery.data?.symbols],
  );

  useEffect(() => {
    if (dateFrom || dateTo) return;
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    setDateFrom(from);
    setDateTo(now);
  }, [dateFrom, dateTo]);

  useEffect(() => {
    if (!optionsQuery.data || defaultsApplied) return;

    const availableSymbols = optionsQuery.data.symbols;
    const availableSessions = optionsQuery.data.sessions;
    const availableStrategyIds = new Set(optionsQuery.data.strategies.map((strategy) => strategy.id));
    const runtimeDefaults = runtimeConfigQuery.data?.defaults;
    const runtimeRisk = runtimeConfigQuery.data?.risk;

    const fallbackSymbols = availableSymbols.slice(0, 8);
    const nextSymbols = (runtimeDefaults?.symbols || []).filter((symbol) => availableSymbols.includes(symbol));
    setSelectedSymbols(nextSymbols.length ? nextSymbols : fallbackSymbols);

    const fallbackSessions = availableSessions;
    const nextSessions = (runtimeDefaults?.sessions || []).filter((session) => availableSessions.includes(session));
    const selectedDefaultSessions = nextSessions.length ? nextSessions : fallbackSessions;
    setSelectedSessions(selectedDefaultSessions);

    const nextStrategies = ((runtimeDefaults?.strategies || []) as BacktestStrategyId[]).filter((id) => availableStrategyIds.has(id));
    if (nextStrategies.length) {
      setSelectedStrategies(nextStrategies);
      setEquityStrategyId(nextStrategies[0]);
    }

    if (Number.isFinite(runtimeDefaults?.startBalance) && Number(runtimeDefaults?.startBalance) > 0) {
      setStartBalanceInput(Number(runtimeDefaults.startBalance));
    }
    if (Number.isFinite(runtimeRisk?.forexRiskPct) && Number(runtimeRisk?.forexRiskPct) > 0) {
      setForexRiskInputPct(Number(runtimeRisk.forexRiskPct) * 100);
    }
    if (Number.isFinite(runtimeRisk?.cryptoRiskPct) && Number(runtimeRisk?.cryptoRiskPct) > 0) {
      setCryptoRiskInputPct(Number(runtimeRisk.cryptoRiskPct) * 100);
    }
    if (typeof runtimeConfigQuery.data?.newsGuard?.enabledInBacktestByDefault === "boolean") {
      setRespectNewsGuard(runtimeConfigQuery.data.newsGuard.enabledInBacktestByDefault);
    }

    if (selectedDefaultSessions.includes("CRYPTO") && availableCryptoSymbols.length) {
      setSelectedSymbols((prev) => Array.from(new Set([...prev, ...availableCryptoSymbols])));
    }
    setDefaultsApplied(true);
  }, [optionsQuery.data, runtimeConfigQuery.data, defaultsApplied, availableCryptoSymbols]);

  useEffect(() => {
    const best = compareQuery.data?.strategyResults?.[0];
    if (best) {
      setEquityStrategyId(best.strategyId);
    }
  }, [compareQuery.data]);

  const strategyResults = compareQuery.data?.strategyResults || [];
  const portfolioSummary = compareQuery.data?.portfolioSummary || null;
  const bestStrategy = strategyResults[0] || null;
  const selectedStrategy = strategyResults.find((result) => result.strategyId === equityStrategyId) || strategyResults[0] || null;

  const totalComparedTrades = useMemo(
    () => strategyResults.reduce((acc, result) => acc + result.totalTrades, 0),
    [strategyResults],
  );
  const rangeLabel = useMemo(() => {
    if (dateFrom && dateTo) {
      return `${dateFrom.toLocaleDateString()} - ${dateTo.toLocaleDateString()}`;
    }
    if (dateFrom && !dateTo) {
      return `Since ${dateFrom.toLocaleDateString()}`;
    }
    return "All Time";
  }, [dateFrom, dateTo]);
  const assumptions = compareQuery.data?.portfolioAssumptions || null;
  const moneyPnl = portfolioSummary ? portfolioSummary.endBalance - portfolioSummary.startBalance : 0;
  const dataCoverage = compareQuery.data?.dataCoverage || null;
  const staleCoverageSymbols = useMemo(
    () => (dataCoverage?.symbols || []).filter((item) => item.isStaleForRangeEnd).map((item) => item.symbol),
    [dataCoverage],
  );
  const missingCoverageSymbols = useMemo(
    () => (dataCoverage?.symbols || []).filter((item) => !item.hasDataInRange).map((item) => item.symbol),
    [dataCoverage],
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
  const toggleSession = (session: string) => {
    const isCryptoSession = session === "CRYPTO";
    const cryptoSymbols = availableCryptoSymbols;
    const cryptoSet = new Set(cryptoSymbols);

    setSelectedSessions((prevSessions) => {
      const nextSessions = prevSessions.includes(session)
        ? prevSessions.filter((item) => item !== session)
        : [...prevSessions, session];

      if (isCryptoSession && cryptoSymbols.length) {
        setSelectedSymbols((prevSymbols) => {
          if (nextSessions.includes("CRYPTO")) {
            const merged = Array.from(new Set([...prevSymbols, ...cryptoSymbols]));
            if (merged.length === prevSymbols.length && prevSymbols.every((symbol) => merged.includes(symbol))) return prevSymbols;
            return merged;
          }
          const filtered = prevSymbols.filter((symbol) => !cryptoSet.has(symbol));
          if (filtered.length === prevSymbols.length) return prevSymbols;
          return filtered;
        });
      }

      return nextSessions;
    });
  };

  const runBacktest = () => {
    const startBalance = Number.isFinite(startBalanceInput) && startBalanceInput > 0 ? startBalanceInput : 500;
    const forexRiskPct = Number.isFinite(forexRiskInputPct) && forexRiskInputPct > 0 ? Math.min(forexRiskInputPct, 100) / 100 : 0.03;
    const cryptoRiskPct = Number.isFinite(cryptoRiskInputPct) && cryptoRiskInputPct > 0 ? Math.min(cryptoRiskInputPct, 100) / 100 : 0.02;

    setRunFilters({
      from: dateFrom?.toISOString(),
      to: dateTo?.toISOString(),
      symbols: selectedSymbols,
      sessions: selectedSessions,
      strategies: selectedStrategies,
      sampleLimit: 200,
      startBalance,
      forexRiskPct,
      cryptoRiskPct,
      respectNewsGuard,
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
    <div className="animate-fade-in space-y-4 sm:space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-bold gradient-text sm:text-2xl">Backtesting Hub</h1>
        <p className="text-sm text-muted-foreground">Compare strategy performance by time range, sessions, symbols and risk assumptions.</p>
      </div>

      <div className="glass-card space-y-4 p-3 sm:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <DateRangePicker from={dateFrom} to={dateTo} onRangeChange={(from, to) => { setDateFrom(from); setDateTo(to); }} />
          <Button className="w-full sm:w-auto" onClick={runBacktest} disabled={compareQuery.isFetching || !selectedSymbols.length || !selectedStrategies.length}>
            {compareQuery.isFetching ? "Running..." : "Run Backtest"}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="start-balance">Start Capital (€)</Label>
            <Input
              id="start-balance"
              type="number"
              min={1}
              step={10}
              value={startBalanceInput}
              onChange={(event) => setStartBalanceInput(Number(event.target.value || 0))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="forex-risk">Forex Risk (%)</Label>
            <Input
              id="forex-risk"
              type="number"
              min={0.1}
              max={100}
              step={0.1}
              value={forexRiskInputPct}
              onChange={(event) => setForexRiskInputPct(Number(event.target.value || 0))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="crypto-risk">Crypto Risk (%)</Label>
            <Input
              id="crypto-risk"
              type="number"
              min={0.1}
              max={100}
              step={0.1}
              value={cryptoRiskInputPct}
              onChange={(event) => setCryptoRiskInputPct(Number(event.target.value || 0))}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
              <Label htmlFor="news-guard-switch">Respect News Guard (Forex)</Label>
              <Switch id="news-guard-switch" checked={respectNewsGuard} onCheckedChange={setRespectNewsGuard} />
            </div>
            <p className="text-xs text-muted-foreground">Uses price-log flag `newsBlocked` only for forex, like live trading.</p>
          </div>
          {runtimeConfigQuery.data ? (
            <div className="space-y-2 rounded-lg border border-border/60 p-3 text-xs text-muted-foreground">
              <p>
                Bot Sync: Max open trades {runtimeConfigQuery.data.risk.maxOpenTrades} | Forex window {formatWindows(runtimeConfigQuery.data.tradingWindows.forex)} UTC
              </p>
              <p>Crypto windows {formatWindows(runtimeConfigQuery.data.tradingWindows.crypto)} UTC</p>
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label>Symbols</Label>
          <div className="rounded-lg border border-border/60 p-2">
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto pr-1">
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
        </div>

        <div className="space-y-2">
          <Label>Sessions</Label>
          <div className="flex flex-wrap gap-2">
            {optionsQuery.data?.sessions.map((session) => (
              <Button
                key={session}
                size="sm"
                variant={selectedSessions.includes(session) ? "default" : "outline"}
                onClick={() => toggleSession(session)}
              >
                {session}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Selecting CRYPTO session auto-enables crypto symbols.</p>
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
          <p className="text-xs text-muted-foreground">Combined preset is already active by default.</p>
        </div>
      </div>

      {compareQuery.isError ? (
        <ErrorState
          title="Backtest run failed"
          message="Could not compute comparison. Check selected filters and API logs."
          onRetry={() => compareQuery.refetch()}
        />
      ) : null}

      {dataCoverage ? (
        <div className={`rounded-lg border p-3 text-xs sm:text-sm ${dataCoverage.warnings.length ? "border-amber-500/40 bg-amber-500/5" : "border-border/60 bg-background/30"}`}>
          <div className="flex flex-col gap-1">
            <p className="font-medium">
              Data Coverage: {dataCoverage.summary.symbolsWithDataInRange}/{dataCoverage.summary.symbolsRequested} symbols in selected range
              {Number.isFinite(dataCoverage.summary.avgCoverageRatio)
                ? ` | Avg coverage ${(Number(dataCoverage.summary.avgCoverageRatio) * 100).toFixed(1)}%`
                : ""}
            </p>
            {dataCoverage.warnings.map((warning) => (
              <p key={warning} className="text-amber-300">{warning}</p>
            ))}
            {staleCoverageSymbols.length ? (
              <p className="text-muted-foreground">Stale symbols near range end: {staleCoverageSymbols.join(", ")}</p>
            ) : null}
            {missingCoverageSymbols.length ? (
              <p className="text-muted-foreground">No data in range: {missingCoverageSymbols.join(", ")}</p>
            ) : null}
            {(dataCoverage.notes || []).map((note) => (
              <p key={note} className="text-muted-foreground">{note}</p>
            ))}
          </div>
        </div>
      ) : null}

      {strategyResults.length > 0 && bestStrategy && selectedStrategy ? (
        <>
          {portfolioSummary ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
              <KPICard
                title="Combined End Balance"
                value={formatMoney(portfolioSummary.endBalance)}
                subtitle={`Start ${formatMoney(portfolioSummary.startBalance)}`}
                trend={portfolioSummary.endBalance >= portfolioSummary.startBalance ? "up" : "down"}
              />
              <KPICard
                title="Money Earned"
                value={formatMoney(moneyPnl)}
                subtitle={rangeLabel}
                trend={moneyPnl >= 0 ? "up" : "down"}
              />
              <KPICard
                title="Combined Return"
                value={formatPercentage(portfolioSummary.returnPct)}
                trend={portfolioSummary.returnPct >= 0 ? "up" : "down"}
              />
              <KPICard
                title="Combined Total R"
                value={formatPoints(portfolioSummary.totalR, 3)}
                trend={portfolioSummary.totalR >= 0 ? "up" : "down"}
              />
              <KPICard title="Combined Trades" value={portfolioSummary.totalTrades} />
              <KPICard title="Trades / Day" value={portfolioSummary.tradesPerDay.toFixed(2)} />
              <KPICard
                title="Combined Win Rate"
                value={formatPercentage(portfolioSummary.winRate)}
                trend={portfolioSummary.winRate >= 0.5 ? "up" : "down"}
              />
              <KPICard
                title="Combined Max DD"
                value={formatPercentage(portfolioSummary.maxDrawdownPct)}
                trend={portfolioSummary.maxDrawdownPct >= -0.03 ? "up" : "down"}
              />
            </div>
          ) : null}

          {portfolioSummary ? (
            <div className="glass-card p-4">
              <div className="mb-3 space-y-1">
                <h3 className="text-sm font-medium text-muted-foreground">Combined Portfolio Breakdown</h3>
                <p className="text-xs text-muted-foreground">
                  Assumptions: Start {formatMoney(assumptions?.startBalance ?? startBalanceInput)} | Forex Risk{" "}
                  {((assumptions?.forexRiskPct ?? (forexRiskInputPct / 100)) * 100).toFixed(2)}% | Crypto Risk{" "}
                  {((assumptions?.cryptoRiskPct ?? (cryptoRiskInputPct / 100)) * 100).toFixed(2)}%
                </p>
              </div>
              <div className="overflow-x-auto">
                <Table className="min-w-[620px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Asset</TableHead>
                      <TableHead>Trades</TableHead>
                      <TableHead>Win Rate</TableHead>
                      <TableHead>Total R</TableHead>
                      <TableHead>Money PnL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell>Forex</TableCell>
                      <TableCell>{portfolioSummary.byAsset.forex.trades}</TableCell>
                      <TableCell>{formatPercentage(portfolioSummary.byAsset.forex.winRate)}</TableCell>
                      <TableCell className={portfolioSummary.byAsset.forex.totalR >= 0 ? "text-profit" : "text-loss"}>
                        {formatPoints(portfolioSummary.byAsset.forex.totalR, 3)}
                      </TableCell>
                      <TableCell className={portfolioSummary.byAsset.forex.pnlMoney >= 0 ? "text-profit" : "text-loss"}>
                        {formatMoney(portfolioSummary.byAsset.forex.pnlMoney)}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>Crypto</TableCell>
                      <TableCell>{portfolioSummary.byAsset.crypto.trades}</TableCell>
                      <TableCell>{formatPercentage(portfolioSummary.byAsset.crypto.winRate)}</TableCell>
                      <TableCell className={portfolioSummary.byAsset.crypto.totalR >= 0 ? "text-profit" : "text-loss"}>
                        {formatPoints(portfolioSummary.byAsset.crypto.totalR, 3)}
                      </TableCell>
                      <TableCell className={portfolioSummary.byAsset.crypto.pnlMoney >= 0 ? "text-profit" : "text-loss"}>
                        {formatMoney(portfolioSummary.byAsset.crypto.pnlMoney)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}

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
            <div className="overflow-x-auto">
              <Table className="min-w-[840px]">
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
              <div className="overflow-x-auto">
                <Table className="min-w-[560px]">
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
            </div>

            <div className="glass-card p-4">
              <h3 className="mb-3 text-sm font-medium text-muted-foreground">Recent Trades ({strategyLabel(selectedStrategy.strategyId)})</h3>
              <div className="overflow-x-auto">
                <Table className="min-w-[520px]">
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
