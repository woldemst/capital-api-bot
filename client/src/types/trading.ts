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
export type BacktestStrategyId = "H4_H1_M15" | "H1_M15_M5" | "logged_live";

export interface BacktestOptionStrategy {
  id: BacktestStrategyId;
  label: string;
}

export interface BacktestOptionsResponse {
  symbols: string[];
  sessions: string[];
  strategies: BacktestOptionStrategy[];
  defaults: {
    maxHoldMinutes: number;
    includeLogged: boolean;
  };
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
  maxHoldMinutes?: number;
  includeLogged?: boolean;
  sampleLimit?: number;
}

export interface BacktestCompareResponse {
  generatedAt: string;
  filtersApplied: {
    from: string | null;
    to: string | null;
    symbols: string[];
    sessions: string[];
    strategies: BacktestStrategyId[];
    maxHoldMinutes: number;
  };
  strategyResults: BacktestStrategyResult[];
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
