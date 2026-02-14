// API Client for Trading Dashboard

import type {
  TradesResponse,
  Trade,
  MetricsSummary,
  EquityResponse,
  DailyPnLResponse,
  PatternsResponse,
  PriceSnapshotsResponse,
  HealthResponse,
  TradeFilters,
  MetricFilters,
  PriceFilters,
  BacktestOptionsResponse,
  BacktestCompareResponse,
  BacktestCompareFilters,
} from "@/types/trading";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
const API_PREFIX = "/api";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function fetchApi<T>(endpoint: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const path = `${API_BASE_URL}${API_PREFIX}${endpoint}`;
  const url = new URL(path, window.location.origin);
  
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.append(key, String(value));
      }
    });
  }

  const response = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new ApiError(response.status, `API Error: ${response.statusText}`);
  }

  return response.json();
}

// Health check
export async function getHealth(): Promise<HealthResponse> {
  return fetchApi<HealthResponse>("/health");
}

// Trades
export async function getTrades(filters?: TradeFilters): Promise<TradesResponse> {
  return fetchApi<TradesResponse>("/trades", filters as Record<string, string | number | undefined>);
}

export async function getTrade(dealId: string): Promise<Trade> {
  return fetchApi<Trade>(`/trades/${dealId}`);
}

// Metrics
export async function getMetricsSummary(filters?: MetricFilters): Promise<MetricsSummary> {
  return fetchApi<MetricsSummary>("/metrics/summary", filters as Record<string, string | number | undefined>);
}

export async function getEquity(filters?: MetricFilters): Promise<EquityResponse> {
  return fetchApi<EquityResponse>("/metrics/equity", filters as Record<string, string | number | undefined>);
}

export async function getDailyPnL(filters?: MetricFilters): Promise<DailyPnLResponse> {
  return fetchApi<DailyPnLResponse>("/metrics/daily-pnl", filters as Record<string, string | number | undefined>);
}

// Patterns
export async function getPatterns(filters?: MetricFilters): Promise<PatternsResponse> {
  return fetchApi<PatternsResponse>("/patterns", filters as Record<string, string | number | undefined>);
}

// Price Snapshots
export async function getPriceSnapshots(filters: PriceFilters): Promise<PriceSnapshotsResponse> {
  const { symbol, from, to, limit, cursor } = filters;
  return fetchApi<PriceSnapshotsResponse>("/prices", { symbol, from, to, limit, cursor });
}

// Backtesting
export async function getBacktestOptions(): Promise<BacktestOptionsResponse> {
  return fetchApi<BacktestOptionsResponse>("/backtest/options");
}

export async function runBacktestCompare(filters: BacktestCompareFilters): Promise<BacktestCompareResponse> {
  const params: Record<string, string | number | undefined> = {
    from: filters.from,
    to: filters.to,
    symbols: filters.symbols?.length ? filters.symbols.join(",") : undefined,
    sessions: filters.sessions?.length ? filters.sessions.join(",") : undefined,
    strategies: filters.strategies?.length ? filters.strategies.join(",") : undefined,
    maxHoldMinutes: filters.maxHoldMinutes,
    includeLogged: filters.includeLogged === undefined ? undefined : (filters.includeLogged ? "1" : "0"),
    sampleLimit: filters.sampleLimit,
  };
  return fetchApi<BacktestCompareResponse>("/backtest/compare", params);
}

export { ApiError };
