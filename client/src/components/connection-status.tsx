import { useHealth } from "@/hooks/use-trading-data";
import { cn } from "@/lib/utils";

export function ConnectionStatus() {
  const { data, isLoading, isError } = useHealth();

  const status = isLoading ? "connecting" : isError ? "disconnected" : data?.status === "ok" ? "connected" : "error";

  return (
    <div className="flex items-center gap-2 text-sm">
      <div
        className={cn(
          "h-2 w-2 rounded-full",
          status === "connected" && "bg-profit animate-pulse",
          status === "connecting" && "bg-primary animate-pulse",
          status === "disconnected" && "bg-loss",
          status === "error" && "bg-loss"
        )}
      />
      <span className="hidden text-muted-foreground sm:inline">
        {status === "connected" && "API Connected"}
        {status === "connecting" && "Connecting..."}
        {status === "disconnected" && "Disconnected"}
        {status === "error" && "Connection Error"}
      </span>
    </div>
  );
}
