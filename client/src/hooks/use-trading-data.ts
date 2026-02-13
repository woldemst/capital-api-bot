// React Query hooks for trading data

import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import {
  getHealth,
  getTrades,
  getTrade,
  getMetricsSummary,
  getEquity,
  getDailyPnL,
  getPatterns,
  getPriceSnapshots,
} from "@/lib/api";
import type { TradeFilters, MetricFilters, PriceFilters } from "@/types/trading";

// Health check
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 30000, // Check every 30 seconds
    retry: 1,
  });
}

// Single trade
export function useTrade(dealId: string | undefined) {
  return useQuery({
    queryKey: ["trade", dealId],
    queryFn: () => getTrade(dealId!),
    enabled: !!dealId,
  });
}

// Trades list with infinite scroll
export function useTradesInfinite(filters?: Omit<TradeFilters, "cursor">) {
  return useInfiniteQuery({
    queryKey: ["trades", filters],
    queryFn: ({ pageParam }) => getTrades({ ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
  });
}

// Trades list (simple)
export function useTrades(filters?: TradeFilters) {
  return useQuery({
    queryKey: ["trades", filters],
    queryFn: () => getTrades(filters),
  });
}

// Metrics summary
export function useMetricsSummary(filters?: MetricFilters) {
  return useQuery({
    queryKey: ["metrics", "summary", filters],
    queryFn: () => getMetricsSummary(filters),
  });
}

// Equity curve
export function useEquity(filters?: MetricFilters) {
  return useQuery({
    queryKey: ["metrics", "equity", filters],
    queryFn: () => getEquity(filters),
  });
}

// Daily PnL
export function useDailyPnL(filters?: MetricFilters) {
  return useQuery({
    queryKey: ["metrics", "daily-pnl", filters],
    queryFn: () => getDailyPnL(filters),
  });
}

// Patterns
export function usePatterns(filters?: MetricFilters) {
  return useQuery({
    queryKey: ["patterns", filters],
    queryFn: () => getPatterns(filters),
  });
}

// Price snapshots with infinite scroll
export function usePriceSnapshotsInfinite(filters: Omit<PriceFilters, "cursor">) {
  return useInfiniteQuery({
    queryKey: ["prices", filters],
    queryFn: ({ pageParam }) => getPriceSnapshots({ ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    enabled: !!filters.symbol,
  });
}

// Price snapshots (simple)
export function usePriceSnapshots(filters: PriceFilters) {
  return useQuery({
    queryKey: ["prices", filters],
    queryFn: () => getPriceSnapshots(filters),
    enabled: !!filters.symbol,
  });
}
