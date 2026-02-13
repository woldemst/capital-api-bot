import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Clock, TrendingUp, TrendingDown, AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KPICardSkeleton } from "@/components/dashboard/loading-skeletons";
import { ErrorState } from "@/components/dashboard/error-state";
import { useTrade } from "@/hooks/use-trading-data";
import {
  enrichTrade,
  formatPnL,
  formatDuration,
  formatTimestamp,
  formatPrice,
  getCloseReasonLabel,
  getSignalLabel,
  getTrendLabel,
} from "@/lib/trading-utils";
import { cn } from "@/lib/utils";
import type { Timeframe, IndicatorSnapshot } from "@/types/trading";

const timeframes: Timeframe[] = ["d1", "h4", "h1", "m15", "m5", "m1"];

function IndicatorValue({
  label,
  openValue,
  closeValue,
  format = "number",
}: {
  label: string;
  openValue: number | string | boolean | undefined;
  closeValue: number | string | boolean | undefined;
  format?: "number" | "percent" | "boolean" | "trend";
}) {
  const formatValue = (val: number | string | boolean | undefined) => {
    if (val === undefined || val === null) return "-";
    if (format === "boolean") return val ? "Yes" : "No";
    if (format === "trend") return getTrendLabel(val as string);
    if (typeof val === "number") {
      return format === "percent" ? `${(val * 100).toFixed(1)}%` : val.toFixed(4);
    }
    return String(val);
  };

  const hasChanged = openValue !== closeValue;

  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-4 text-sm font-mono">
        <span>{formatValue(openValue)}</span>
        <span className="text-muted-foreground">→</span>
        <span className={cn(hasChanged && "text-primary font-medium")}>
          {formatValue(closeValue)}
        </span>
      </div>
    </div>
  );
}

function IndicatorPanel({
  opening,
  closing,
}: {
  opening?: IndicatorSnapshot;
  closing?: IndicatorSnapshot;
}) {
  if (!opening) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        No indicator data available
      </div>
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* Momentum Indicators */}
      <div className="glass-card p-4">
        <h4 className="mb-4 text-sm font-medium">Momentum</h4>
        <IndicatorValue label="RSI" openValue={opening?.rsi} closeValue={closing?.rsi} />
        <IndicatorValue label="ADX" openValue={opening?.adx?.adx} closeValue={closing?.adx?.adx} />
        <IndicatorValue label="MACD Histogram" openValue={opening?.macd?.histogram} closeValue={closing?.macd?.histogram} />
        <IndicatorValue label="BackQuant Score" openValue={opening?.backQuantScore} closeValue={closing?.backQuantScore} />
      </div>

      {/* Trend Indicators */}
      <div className="glass-card p-4">
        <h4 className="mb-4 text-sm font-medium">Trend</h4>
        <IndicatorValue label="Trend" openValue={opening?.trend} closeValue={closing?.trend} format="trend" />
        <IndicatorValue label="Price vs EMA9" openValue={opening?.price_vs_ema9} closeValue={closing?.price_vs_ema9} />
        <IndicatorValue label="Price vs EMA21" openValue={opening?.price_vs_ema21} closeValue={closing?.price_vs_ema21} />
        <IndicatorValue label="Bullish Cross" openValue={opening?.isBullishCross} closeValue={closing?.isBullishCross} format="boolean" />
        <IndicatorValue label="Bearish Cross" openValue={opening?.isBearishCross} closeValue={closing?.isBearishCross} format="boolean" />
      </div>

      {/* Volatility */}
      <div className="glass-card p-4">
        <h4 className="mb-4 text-sm font-medium">Volatility</h4>
        <IndicatorValue label="ATR" openValue={opening?.atr} closeValue={closing?.atr} />
        <IndicatorValue label="BB %B" openValue={opening?.bb?.pb} closeValue={closing?.bb?.pb} />
        <IndicatorValue label="BB Upper" openValue={opening?.bb?.upper} closeValue={closing?.bb?.upper} />
        <IndicatorValue label="BB Lower" openValue={opening?.bb?.lower} closeValue={closing?.bb?.lower} />
      </div>

      {/* EMAs */}
      <div className="glass-card p-4">
        <h4 className="mb-4 text-sm font-medium">Moving Averages</h4>
        <IndicatorValue label="EMA 9" openValue={opening?.ema9} closeValue={closing?.ema9} />
        <IndicatorValue label="EMA 21" openValue={opening?.ema21} closeValue={closing?.ema21} />
        <IndicatorValue label="EMA 50" openValue={opening?.ema50} closeValue={closing?.ema50} />
        <IndicatorValue label="Last Close" openValue={opening?.lastClose || opening?.close} closeValue={closing?.lastClose || closing?.close} />
      </div>
    </div>
  );
}

export default function TradeDetail() {
  const { dealId } = useParams<{ dealId: string }>();
  const { data: trade, isLoading, isError, refetch } = useTrade(dealId);

  if (isLoading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/trades">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <KPICardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !trade) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/trades">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        <ErrorState
          title="Trade not found"
          message={`Unable to find trade with ID: ${dealId}`}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  const enrichedTrade = enrichTrade(trade);
  const isProfit = (enrichedTrade.pnl ?? 0) >= 0;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/trades">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{trade.symbol}</h1>
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
              <Badge variant="secondary">
                {getCloseReasonLabel(trade.closeReason || "unknown")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground font-mono">
              {trade.dealId}
            </p>
          </div>
        </div>

        <div className={cn(
          "text-3xl font-bold",
          isProfit ? "text-profit" : "text-loss"
        )}>
          {formatPnL(enrichedTrade.pnl ?? 0)}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="kpi-card">
          <div className="flex items-center gap-3">
            {isProfit ? (
              <TrendingUp className="h-5 w-5 text-profit" />
            ) : (
              <TrendingDown className="h-5 w-5 text-loss" />
            )}
            <div>
              <p className="text-sm text-muted-foreground">Entry → Close</p>
              <p className="font-mono">
                {formatPrice(trade.entryPrice)} → {trade.closePrice ? formatPrice(trade.closePrice) : "-"}
              </p>
            </div>
          </div>
        </div>

        <div className="kpi-card">
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm text-muted-foreground">Duration</p>
              <p className="font-medium">{formatDuration(enrichedTrade.durationMinutes ?? 0)}</p>
            </div>
          </div>
        </div>

        <div className="kpi-card">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-loss" />
            <div>
              <p className="text-sm text-muted-foreground">Stop Loss</p>
              <p className="font-mono">{formatPrice(trade.stopLoss)}</p>
            </div>
          </div>
        </div>

        <div className="kpi-card">
          <div className="flex items-center gap-3">
            <CheckCircle className="h-5 w-5 text-profit" />
            <div>
              <p className="text-sm text-muted-foreground">Take Profit</p>
              <p className="font-mono">{formatPrice(trade.takeProfit)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Timestamps */}
      <div className="glass-card p-4">
        <div className="flex flex-wrap gap-8">
          <div>
            <p className="text-sm text-muted-foreground">Opened</p>
            <p className="font-medium">{formatTimestamp(trade.openedAt)}</p>
          </div>
          {trade.closedAt && (
            <div>
              <p className="text-sm text-muted-foreground">Closed</p>
              <p className="font-medium">{formatTimestamp(trade.closedAt)}</p>
            </div>
          )}
        </div>
      </div>

      {/* Indicator Comparison */}
      <div className="glass-card p-4">
        <h3 className="mb-4 text-lg font-semibold">Indicator Comparison</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          Opening values → Closing values (changed values highlighted)
        </p>
        
        <Tabs defaultValue="m15">
          <TabsList className="mb-4">
            {timeframes.map((tf) => (
              <TabsTrigger key={tf} value={tf} className="uppercase">
                {tf}
              </TabsTrigger>
            ))}
          </TabsList>
          
          {timeframes.map((tf) => (
            <TabsContent key={tf} value={tf}>
              <IndicatorPanel
                opening={trade.indicatorsOnOpening?.[tf]}
                closing={trade.indicatorsOnClosing?.[tf]}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
