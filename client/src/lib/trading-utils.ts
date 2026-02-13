import { format } from "date-fns";
import type { ComputedTrade, Trade } from "@/types/trading";

export function computePnL(trade: Trade): number {
  if (!trade.closePrice || trade.status !== "closed") return 0;
  
  const diff = trade.signal === "buy" 
    ? trade.closePrice - trade.entryPrice 
    : trade.entryPrice - trade.closePrice;
  
  return diff;
}

export function computeDuration(trade: Trade): number {
  if (!trade.closedAt) return 0;
  
  const opened = new Date(trade.openedAt).getTime();
  const closed = new Date(trade.closedAt).getTime();
  
  return Math.round((closed - opened) / (1000 * 60)); // minutes
}

export function enrichTrade(trade: Trade): ComputedTrade {
  return {
    ...trade,
    pnl: computePnL(trade),
    durationMinutes: computeDuration(trade),
  };
}

export function formatPnL(pnl: number, digits: number = 5): string {
  const formatted = Math.abs(pnl).toFixed(digits);
  return pnl >= 0 ? `+${formatted}` : `-${formatted}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function formatTimestamp(timestamp: string): string {
  return format(new Date(timestamp), "MMM dd, yyyy HH:mm");
}

export function formatDate(timestamp: string): string {
  return format(new Date(timestamp), "MMM dd, yyyy");
}

export function formatTime(timestamp: string): string {
  return format(new Date(timestamp), "HH:mm:ss");
}

export function formatPrice(price: number, digits: number = 5): string {
  return price.toFixed(digits);
}

export function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function getCloseReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    hit_tp: "Take Profit",
    hit_sl: "Stop Loss",
    timeout: "Timeout",
    manual_close: "Manual Close",
    unknown: "Unknown",
    CLOSED: "Closed",
  };
  return labels[reason] || reason;
}

export function getSignalLabel(signal: string): string {
  return signal === "buy" ? "Long" : "Short";
}

export function getTrendLabel(trend: string): string {
  const labels: Record<string, string> = {
    bullish: "Bullish",
    bearish: "Bearish",
    neutral: "Neutral",
  };
  return labels[trend] || trend;
}
