// Trading Dashboard Type Definitions

export type Direction = "buy" | "sell";

export type CloseReason = 
  | "hit_sl" 
  | "hit_tp" 
  | "timeout" 
  | "manual_close" 
  | "unknown" 
  | "CLOSED";

export type Trend = "bullish" | "bearish" | "neutral";

export type Timeframe = "d1" | "h4" | "h1" | "m15" | "m5" | "m1";

export type TradeStatus = "open" | "closed";

// Indicator Snapshot
export interface ADXIndicator {
  adx: number;
  pdi: number;
  mdi: number;
}

export interface MACDIndicator {
  MACD: number;
  signal: number;
  histogram: number;
}

export interface BollingerBands {
  middle: number;
  upper: number;
  lower: number;
  pb: number;
}

export interface IndicatorSnapshot {
  rsi: number;
  adx: ADXIndicator;
  macd: MACDIndicator;
  atr: number;
  ema9: number;
  ema21: number;
  ema20: number;
  ema50: number;
  price_vs_ema9: number;
  price_vs_ema21: number;
  bb: BollingerBands;
  trend: Trend;
  isBullishCross: boolean;
  isBearishCross: boolean;
  backQuantScore: number;
  backQuantSignal: number;
  lastClose?: number;
  close?: number;
}

export type IndicatorsByTimeframe = Record<Timeframe, IndicatorSnapshot>;

// Trade
export interface Trade {
  dealId: string;
  symbol: string;
  signal: Direction;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: string;
  status: TradeStatus;
  closeReason?: CloseReason;
  closePrice?: number;
  closedAt?: string;
  indicatorsOnOpening: IndicatorsByTimeframe;
  indicatorsOnClosing?: IndicatorsByTimeframe;
}

export interface TradesResponse {
  data: Trade[];
  nextCursor?: string;
  hasMore: boolean;
}

// Metrics
export interface MetricsSummary {
  totalPnL: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  avgTradeDurationMinutes: number;
  totalTrades: number;
  wins: number;
  losses: number;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
}

export interface EquityResponse {
  points: EquityPoint[];
}

export interface DailyPnL {
  date: string;
  pnl: number;
}

export interface DailyPnLResponse {
  days: DailyPnL[];
}

// Patterns
export interface CloseReasonPattern {
  closeReason: CloseReason;
  count: number;
  winRate: number;
}

export interface SymbolPattern {
  symbol: string;
  count: number;
  winRate: number;
  avgPnL?: number;
}

export interface IndicatorDistribution {
  buckets: number[];
  counts: number[];
}

export interface IndicatorDistributions {
  wins: IndicatorDistribution;
  losses: IndicatorDistribution;
}

export interface TrendFade {
  dealId: string;
  symbol: string;
  maxUnrealized: number;
  finalPnL: number;
}

export interface PatternsResponse {
  byCloseReason: CloseReasonPattern[];
  bySymbol: SymbolPattern[];
  indicatorDistributions: Record<string, IndicatorDistributions>;
  trendFade: TrendFade[];
}

// Price Snapshots
export interface PriceSnapshot {
  symbol: string;
  timestamp: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  price: number;
  sessions: string[];
  newsBlocked: boolean;
  indicators: IndicatorsByTimeframe;
}

export interface PriceSnapshotsResponse {
  data: PriceSnapshot[];
  nextCursor?: string;
  hasMore: boolean;
}

// Health
export interface HealthResponse {
  status: "ok" | "error";
  timestamp: string;
}

// Filter params
export interface TradeFilters {
  symbol?: string;
  from?: string;
  to?: string;
  direction?: Direction;
  closeReason?: CloseReason;
  status?: TradeStatus;
  limit?: number;
  cursor?: string;
}

export interface MetricFilters {
  from?: string;
  to?: string;
  symbol?: string;
}

export interface PriceFilters {
  symbol: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

// Backtesting
export type BacktestStrategyId =
  | "INTRADAY_7STEP_V1";

export interface BacktestOptionStrategy {
  id: BacktestStrategyId;
  label: string;
}

export interface BacktestOptionsResponse {
  symbols: string[];
  sessions: string[];
  strategies: BacktestOptionStrategy[];
}

export interface BacktestTradeSample {
  dealId: string;
  symbol: string;
  signal: Direction;
  openedAt: string;
  closedAt: string;
  closeReason: string;
  entryPrice: number;
  closePrice: number;
  pnlPoints: number;
}

export interface BacktestSymbolBreakdown {
  symbol: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPoints: number;
  avgPoints: number;
}

export interface BacktestStrategyResult {
  strategyId: BacktestStrategyId;
  source: "simulation" | "logs";
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPoints: number;
  expectancyPoints: number;
  profitFactor: number;
  maxDrawdownPoints: number;
  avgHoldMinutes: number;
  closeReasonCounts: {
    hitTp: number;
    hitSl: number;
    timeout: number;
    manualClose: number;
    unknown: number;
  };
  bySymbol: BacktestSymbolBreakdown[];
  equityPoints: EquityPoint[];
  tradesSample: BacktestTradeSample[];
}

export interface BacktestCompareFilters {
  from?: string;
  to?: string;
  symbols?: string[];
  sessions?: string[];
  strategies?: BacktestStrategyId[];
  sampleLimit?: number;
  startBalance?: number;
  forexRiskPct?: number;
  cryptoRiskPct?: number;
  respectNewsGuard?: boolean;
}

export interface BacktestCompareResponse {
  generatedAt: string;
  filtersApplied: {
    from: string | null;
    to: string | null;
    symbols: string[];
    sessions: string[];
    strategies: BacktestStrategyId[];
    respectNewsGuard?: boolean;
    respectTradingWindows?: boolean;
  };
  strategyResults: BacktestStrategyResult[];
  portfolioAssumptions?: {
    startBalance: number;
    forexRiskPct: number;
    cryptoRiskPct: number;
  };
  portfolioSummary?: {
    startBalance: number;
    endBalance: number;
    returnPct: number;
    maxDrawdownPct: number;
    totalTrades: number;
    tradesPerDay: number;
    wins: number;
    losses: number;
    winRate: number;
    totalR: number;
    expectancyR: number;
    profitFactorR: number;
    byAsset: {
      forex: {
        trades: number;
        wins: number;
        totalR: number;
        pnlMoney: number;
        winRate: number;
      };
      crypto: {
        trades: number;
        wins: number;
        totalR: number;
        pnlMoney: number;
        winRate: number;
      };
    };
  };
  dataCoverage?: {
    requestedRange: {
      from: string | null;
      to: string | null;
    };
    summary: {
      symbolsRequested: number;
      symbolsWithDataInRange: number;
      missingInRangeCount: number;
      staleAtRangeEndCount: number;
      avgCoverageRatio: number | null;
    };
    symbols: Array<{
      symbol: string;
      totalRows: number;
      rowsInRange: number;
      firstTimestamp: string | null;
      lastTimestamp: string | null;
      firstInRangeTimestamp: string | null;
      lastInRangeTimestamp: string | null;
      hasDataInRange: boolean;
      isStaleForRangeEnd: boolean;
      coverageRatio: number | null;
    }>;
    warnings: string[];
    notes?: string[];
  };
}

export interface RuntimeWindow {
  start: number;
  end: number;
}

export interface RuntimeConfigResponse {
  timezone: string;
  risk: {
    forexRiskPct: number;
    cryptoRiskPct: number;
    maxOpenTrades: number;
  };
  tradingWindows: {
    forex: RuntimeWindow[];
    crypto: RuntimeWindow[];
  };
  newsGuard: {
    forexOnly: boolean;
    includeImpacts: string[];
    windowsByImpact: Record<string, { preMinutes: number; postMinutes: number }>;
    enabledInBacktestByDefault: boolean;
  };
  defaults: {
    sessions: string[];
    symbols: string[];
    strategies: BacktestStrategyId[];
    startBalance: number;
    sampleLimit: number;
  };
}

export interface ForexPlannerSession {
  name: string;
  start: string | null;
  end: string | null;
  symbols: string[];
}

export interface ForexPlannerWeekRow {
  week: string;
  risk: string;
  trades: number;
  wins: number;
  losses: number;
  winrate: number;
  netR: number;
  rawPnl: number;
  startEquity: number;
  endEquity: number;
  maxDrawdownPct: number;
}

export interface ForexPlannerPhaseRow {
  phase: string;
  risk: string;
  trades: number;
  wins: number;
  losses: number;
  winrate: number;
  netR: number;
  profitFactor: number;
  rawPnl: number;
  startBalance: number;
  endBalance: number;
}

export interface ForexPlannerMonthRow {
  month: string;
  risk: string;
  startBroker: number;
  trades: number;
  wins: number;
  losses: number;
  winrate: number;
  netR: number;
  rawPnl: number;
  taxTransfer: number;
  startTaxReserve: number;
  taxReserveBalance: number;
  plannedPayout: number;
  actualPayout: number;
  endBroker: number;
}

export interface ForexPlannerResponse {
  mode: "FOREX_ONLY";
  generatedAt: string;
  report: {
    file: string | null;
    generatedAt: string | null;
    rangeStartIso: string | null;
    rangeEndIso: string | null;
  };
  live: {
    environment: "DEMO" | "LIVE";
    baseUrl: string | null;
    symbols: string[];
    strategy: string;
    sessions: ForexPlannerSession[];
    risk: {
      perTradePct: number;
      maxOpenTrades: number;
      maxOpenRiskPct: number;
      maxDailyLossR: number;
      maxSymbolLossesPerDay: number;
    };
    guards: {
      symbolLossBlockEnabled: boolean;
      dailyLossStopEnabled: boolean;
      lossStreakCooldownEnabled: boolean;
    };
  };
  annualSummary: {
    startCapital: number;
    endCapital: number;
    rawPnl: number;
    returnPct: number;
    trades: number;
    winrate: number;
    profitFactor: number;
    avgHoldMinutes: number;
    medianHoldMinutes: number;
    maxDrawdownPct: number;
  } | null;
  phaseRows: ForexPlannerPhaseRow[];
  weekRows: ForexPlannerWeekRow[];
  monthlyPlan: {
    assumptions: {
      taxReservePct: number;
      firstPayoutMonthIndex: number;
      initialPayout: number;
      monthlyPayoutStep: number;
      maxMonthlyPayout: number;
      minBrokerBalance: number;
    } | null;
    rows: ForexPlannerMonthRow[];
  };
  operatingRules: string[];
}

// Utility type for computed trade data
export interface ComputedTrade extends Trade {
  pnl?: number;
  durationMinutes?: number;
}

// Chart data types for Lightweight Charts
export interface CandlestickData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface LineData {
  time: string;
  value: number;
}

export interface HistogramData {
  time: string;
  value: number;
  color?: string;
}
