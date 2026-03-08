import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  BadgeEuro,
  CalendarRange,
  Shield,
  Wallet,
} from "lucide-react";
import { ErrorState } from "@/components/dashboard/error-state";
import { KPICard } from "@/components/dashboard/kpi-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useForexPlannerDashboard } from "@/hooks/use-trading-data";
import { formatPercentage } from "@/lib/trading-utils";

function formatMoney(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "0.00 EUR";
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value) + " EUR";
}

function formatCompactMoney(value: number, digits = 0) {
  if (!Number.isFinite(value)) return "0 EUR";
  return new Intl.NumberFormat("de-DE", {
    notation: "compact",
    maximumFractionDigits: digits,
  }).format(value) + " EUR";
}

function formatSignedMoney(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "0.00 EUR";
  return `${value >= 0 ? "+" : ""}${formatMoney(value, digits)}`;
}

function formatSignedR(value: number) {
  if (!Number.isFinite(value)) return "0.00R";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function formatMonth(month: string) {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("de-DE", { month: "long", year: "numeric", timeZone: "UTC" })
    : month;
}

function formatSessionWindow(start: string | null, end: string | null) {
  if (!start || !end) return "-";
  return `${start}-${end} UTC`;
}

export default function Overview() {
  const plannerQuery = useForexPlannerDashboard();
  const [taxReservePctInput, setTaxReservePctInput] = useState(40);
  const [firstPayoutMonthInput, setFirstPayoutMonthInput] = useState(3);
  const [initialPayoutInput, setInitialPayoutInput] = useState(2000);
  const [monthlyPayoutStepInput, setMonthlyPayoutStepInput] = useState(1000);
  const [maxPayoutInput, setMaxPayoutInput] = useState(10000);
  const [minBrokerBalanceInput, setMinBrokerBalanceInput] = useState(500);

  const dashboard = plannerQuery.data;
  const monthlyTemplateRows = dashboard?.monthlyPlan.rows || [];
  const annualSummary = dashboard?.annualSummary || null;
  const plannerErrorMessage =
    plannerQuery.error instanceof Error && plannerQuery.error.message
      ? `${plannerQuery.error.message}. Prüfe den Hub-Server, den Vite-/API-Proxy und den Referenzreport für das Forex-Desk.`
      : "Prüfe den Hub-Server, den Vite-/API-Proxy und den Referenzreport für das Forex-Desk.";

  const plannedMonthlyRows = useMemo(() => {
    if (!dashboard || !annualSummary) return [];

    const taxReservePct = Math.max(0, Math.min(100, taxReservePctInput)) / 100;
    const firstPayoutMonthIndex = Math.max(1, Math.floor(firstPayoutMonthInput || 1));
    const initialPayout = Math.max(0, initialPayoutInput || 0);
    const monthlyPayoutStep = Math.max(0, monthlyPayoutStepInput || 0);
    const maxMonthlyPayout = Math.max(0, maxPayoutInput || 0);
    const minBrokerBalance = Math.max(0, minBrokerBalanceInput || 0);

    let brokerBalance = annualSummary.startCapital;
    let taxReserveBalance = 0;
    let payoutIndex = 0;

    return monthlyTemplateRows.map((row, index) => {
      const startBroker = brokerBalance;
      const startTaxReserve = taxReserveBalance;
      const taxTransfer = row.rawPnl > 0 ? row.rawPnl * taxReservePct : 0;

      taxReserveBalance += taxTransfer;
      brokerBalance += row.rawPnl - taxTransfer;

      let plannedPayout = 0;
      if (index + 1 >= firstPayoutMonthIndex) {
        plannedPayout = Math.min(initialPayout + payoutIndex * monthlyPayoutStep, maxMonthlyPayout);
        payoutIndex += 1;
      }

      const maxWithdrawable = Math.max(0, brokerBalance - minBrokerBalance);
      const actualPayout = Math.min(plannedPayout, maxWithdrawable);
      brokerBalance -= actualPayout;

      return {
        ...row,
        startBroker,
        startTaxReserve,
        taxTransfer,
        taxReserveBalance,
        plannedPayout,
        actualPayout,
        endBroker: brokerBalance,
      };
    });
  }, [
    annualSummary,
    dashboard,
    firstPayoutMonthInput,
    initialPayoutInput,
    maxPayoutInput,
    minBrokerBalanceInput,
    monthlyPayoutStepInput,
    monthlyTemplateRows,
    taxReservePctInput,
  ]);

  const plannerTotals = useMemo(() => {
    if (!plannedMonthlyRows.length) {
      return {
        totalPayout: 0,
        finalBroker: annualSummary?.startCapital || 0,
        taxReserve: 0,
      };
    }
    const last = plannedMonthlyRows[plannedMonthlyRows.length - 1];
    const totalPayout = plannedMonthlyRows.reduce((sum, row) => sum + row.actualPayout, 0);
    return {
      totalPayout,
      finalBroker: last.endBroker,
      taxReserve: last.taxReserveBalance,
    };
  }, [annualSummary?.startCapital, plannedMonthlyRows]);

  if (plannerQuery.isLoading) {
    return (
      <div className="animate-fade-in space-y-4 sm:space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-bold gradient-text sm:text-2xl">Forex Desk</h1>
          <p className="text-sm text-muted-foreground">Lade Live-Setup, Referenzreport und Cashflow-Planer.</p>
        </div>
        <div className="glass-card p-6 text-sm text-muted-foreground">Dashboard-Daten werden geladen...</div>
      </div>
    );
  }

  if (plannerQuery.isError || !dashboard || !annualSummary) {
    return (
      <ErrorState
        title="Forex-Dashboard konnte nicht geladen werden"
        message={plannerErrorMessage}
        onRetry={() => plannerQuery.refetch()}
      />
    );
  }

  return (
    <div className="animate-fade-in space-y-4 sm:space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-bold gradient-text sm:text-2xl">Forex Desk</h1>
        <p className="text-sm text-muted-foreground">
          Live-Setup, Guardrails und Cashflow-Planer für dein 5er-Forex-Set. Keine Compare-UI mehr, nur Operations und
          Auszahlungshilfe.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KPICard
          title="Environment"
          value={dashboard.live.environment}
          subtitle={dashboard.live.baseUrl || "-"}
          icon={<Shield className="h-5 w-5 text-primary" />}
        />
        <KPICard
          title="Aktive Symbole"
          value={dashboard.live.symbols.length}
          subtitle={dashboard.live.symbols.join(", ")}
          icon={<CalendarRange className="h-5 w-5 text-primary" />}
        />
        <KPICard
          title="Live Risk"
          value={formatPercentage(dashboard.live.risk.perTradePct)}
          subtitle={`Max ${dashboard.live.risk.maxOpenTrades} Trades | Open risk ${formatPercentage(
            dashboard.live.risk.maxOpenRiskPct,
          )}`}
          icon={<AlertTriangle className="h-5 w-5 text-primary" />}
        />
        <KPICard
          title="2025 Referenz"
          value={formatSignedMoney(annualSummary.rawPnl)}
          subtitle={`PF ${annualSummary.profitFactor.toFixed(2)} | Winrate ${formatPercentage(annualSummary.winrate)}`}
          trend={annualSummary.rawPnl >= 0 ? "up" : "down"}
          icon={<BadgeEuro className="h-5 w-5 text-primary" />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="glass-card p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Live Setup</h2>
            <p className="text-sm text-muted-foreground">Der Screen ist jetzt auf Forex-Operations ausgerichtet, nicht auf Backtest-Vergleiche.</p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Strategie</div>
                <div className="mt-1 text-sm font-medium">{dashboard.live.strategy}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Guardrails</div>
                <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                  <li>{dashboard.live.risk.maxOpenTrades} gleichzeitige Trades</li>
                  <li>1 Position pro Symbol</li>
                  <li>{formatPercentage(dashboard.live.risk.maxOpenRiskPct)} max offenes Gesamtrisiko</li>
                  <li>{dashboard.live.risk.maxSymbolLossesPerDay} Verluste pro Symbol/Tag bis Block</li>
                  <li>Daily Stop bei {dashboard.live.risk.maxDailyLossR.toFixed(0)}R</li>
                </ul>
              </div>
            </div>

            <div className="space-y-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Sessions</div>
              <div className="space-y-2 text-sm">
                {dashboard.live.sessions.map((session) => (
                  <div key={session.name} className="rounded-lg border border-border/60 bg-background/30 px-3 py-2">
                    <div className="font-medium">{session.name}</div>
                    <div className="text-muted-foreground">{formatSessionWindow(session.start, session.end)}</div>
                    <div className="text-xs text-muted-foreground">{session.symbols.join(", ") || "-"}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="glass-card p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Operations</h2>
            <p className="text-sm text-muted-foreground">Die Regeln, die du jeden Monat und vor jeder Entnahme befolgen willst.</p>
          </div>

          <div className="space-y-3 text-sm">
            {dashboard.operatingRules.map((rule) => (
              <div key={rule} className="rounded-lg border border-border/60 bg-background/30 px-3 py-2 text-muted-foreground">
                {rule}
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-lg border border-border/60 bg-background/30 p-3 text-sm text-muted-foreground">
            Referenzlauf: {new Date(dashboard.report.rangeStartIso || "").toLocaleDateString("de-DE")} bis{" "}
            {new Date(dashboard.report.rangeEndIso || "").toLocaleDateString("de-DE")} | Report: {dashboard.report.file}
          </div>
        </div>
      </div>

      <div className="glass-card space-y-4 p-4">
        <div>
          <h2 className="text-lg font-semibold">Cashflow-Planer</h2>
          <p className="text-sm text-muted-foreground">
            Der Rechner nimmt den 2025er Referenzlauf, legt zuerst die Steuerreserve weg und plant erst danach
            Entnahmen.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-2">
            <Label htmlFor="tax-reserve">Steuerreserve (%)</Label>
            <Input
              id="tax-reserve"
              type="number"
              min={0}
              max={100}
              step={1}
              value={taxReservePctInput}
              onChange={(event) => setTaxReservePctInput(Number(event.target.value || 0))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="first-payout-month">Erste Auszahlung (Monat)</Label>
            <Input
              id="first-payout-month"
              type="number"
              min={1}
              step={1}
              value={firstPayoutMonthInput}
              onChange={(event) => setFirstPayoutMonthInput(Number(event.target.value || 1))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="initial-payout">Start-Auszahlung</Label>
            <Input
              id="initial-payout"
              type="number"
              min={0}
              step={500}
              value={initialPayoutInput}
              onChange={(event) => setInitialPayoutInput(Number(event.target.value || 0))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="monthly-step">Monatsanstieg</Label>
            <Input
              id="monthly-step"
              type="number"
              min={0}
              step={500}
              value={monthlyPayoutStepInput}
              onChange={(event) => setMonthlyPayoutStepInput(Number(event.target.value || 0))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="max-payout">Payout-Cap</Label>
            <Input
              id="max-payout"
              type="number"
              min={0}
              step={500}
              value={maxPayoutInput}
              onChange={(event) => setMaxPayoutInput(Number(event.target.value || 0))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="min-broker">Broker-Mindeststand</Label>
            <Input
              id="min-broker"
              type="number"
              min={0}
              step={100}
              value={minBrokerBalanceInput}
              onChange={(event) => setMinBrokerBalanceInput(Number(event.target.value || 0))}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <KPICard
            title="Gesamt entnehmbar"
            value={formatMoney(plannerTotals.totalPayout)}
            subtitle="Über den ganzen Referenzlauf"
            icon={<ArrowDownToLine className="h-5 w-5 text-primary" />}
          />
          <KPICard
            title="End Broker"
            value={formatCompactMoney(plannerTotals.finalBroker)}
            subtitle="Nach Steuerrücklage und Entnahmen"
            trend={plannerTotals.finalBroker >= annualSummary.startCapital ? "up" : "down"}
            icon={<Wallet className="h-5 w-5 text-primary" />}
          />
          <KPICard
            title="Steuerkonto"
            value={formatCompactMoney(plannerTotals.taxReserve)}
            subtitle="Reserviert, nicht reinvestieren"
            icon={<BadgeEuro className="h-5 w-5 text-primary" />}
          />
          <KPICard
            title="Max Drawdown"
            value={formatPercentage(annualSummary.maxDrawdownPct)}
            subtitle={`Ø Hold ${annualSummary.avgHoldMinutes.toFixed(1)} min`}
            trend="down"
            icon={<AlertTriangle className="h-5 w-5 text-primary" />}
          />
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Monat</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead>Start Broker</TableHead>
                <TableHead>Trades</TableHead>
                <TableHead>Winrate</TableHead>
                <TableHead>Net R</TableHead>
                <TableHead>PnL</TableHead>
                <TableHead>Steuerkonto +</TableHead>
                <TableHead>Geplant</TableHead>
                <TableHead>Tatsächlich</TableHead>
                <TableHead>End Broker</TableHead>
                <TableHead>Steuerkonto gesamt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plannedMonthlyRows.map((row) => (
                <TableRow key={row.month}>
                  <TableCell>{formatMonth(row.month)}</TableCell>
                  <TableCell>{row.risk}</TableCell>
                  <TableCell>{formatMoney(row.startBroker)}</TableCell>
                  <TableCell>{row.trades}</TableCell>
                  <TableCell>{row.trades ? formatPercentage(row.winrate) : "n/a"}</TableCell>
                  <TableCell className={row.netR >= 0 ? "text-profit" : "text-loss"}>{formatSignedR(row.netR)}</TableCell>
                  <TableCell className={row.rawPnl >= 0 ? "text-profit" : "text-loss"}>{formatSignedMoney(row.rawPnl)}</TableCell>
                  <TableCell>{formatMoney(row.taxTransfer)}</TableCell>
                  <TableCell>{formatMoney(row.plannedPayout)}</TableCell>
                  <TableCell>{formatMoney(row.actualPayout)}</TableCell>
                  <TableCell>{formatMoney(row.endBroker)}</TableCell>
                  <TableCell>{formatMoney(row.taxReserveBalance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="glass-card p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Phasenübersicht</h2>
            <p className="text-sm text-muted-foreground">Wie das Referenzjahr nach Risiko-Stufen aufgebaut war.</p>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phase</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Trades</TableHead>
                  <TableHead>Winrate</TableHead>
                  <TableHead>PnL</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>Ende</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.phaseRows.map((row) => (
                  <TableRow key={row.phase}>
                    <TableCell>{row.phase}</TableCell>
                    <TableCell>{row.risk}</TableCell>
                    <TableCell>{row.trades}</TableCell>
                    <TableCell>{row.trades ? formatPercentage(row.winrate) : "n/a"}</TableCell>
                    <TableCell className={row.rawPnl >= 0 ? "text-profit" : "text-loss"}>{formatSignedMoney(row.rawPnl)}</TableCell>
                    <TableCell>{formatCompactMoney(row.startBalance)}</TableCell>
                    <TableCell>{formatCompactMoney(row.endBalance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="glass-card p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Wöchentliche Referenz</h2>
            <p className="text-sm text-muted-foreground">
              Wochenübersicht aus dem 2025er Lauf inklusive aktivem Risiko, Startsaldo und Drawdown.
            </p>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Woche</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Startkonto</TableHead>
                  <TableHead>Trades</TableHead>
                  <TableHead>Winrate</TableHead>
                  <TableHead>Net R</TableHead>
                  <TableHead>PnL</TableHead>
                  <TableHead>Endkonto</TableHead>
                  <TableHead>DD</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.weekRows.map((row) => (
                  <TableRow key={row.week}>
                    <TableCell>{row.week}</TableCell>
                    <TableCell>{row.risk}</TableCell>
                    <TableCell>{formatMoney(row.startEquity)}</TableCell>
                    <TableCell>{row.trades}</TableCell>
                    <TableCell>{row.trades ? formatPercentage(row.winrate) : "n/a"}</TableCell>
                    <TableCell className={row.netR >= 0 ? "text-profit" : "text-loss"}>{formatSignedR(row.netR)}</TableCell>
                    <TableCell className={row.rawPnl >= 0 ? "text-profit" : "text-loss"}>{formatSignedMoney(row.rawPnl)}</TableCell>
                    <TableCell>{formatMoney(row.endEquity)}</TableCell>
                    <TableCell>{formatPercentage(row.maxDrawdownPct)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  );
}
