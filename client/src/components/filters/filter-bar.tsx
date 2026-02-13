import { useState } from "react";
import { format, subDays, subMonths } from "date-fns";
import { Calendar as CalendarIcon, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Direction, CloseReason } from "@/types/trading";

interface DateRangePickerProps {
  from?: Date;
  to?: Date;
  onRangeChange: (from: Date | undefined, to: Date | undefined) => void;
}

export function DateRangePicker({ from, to, onRangeChange }: DateRangePickerProps) {
  const presets = [
    { label: "Last 7 days", value: "7d", from: subDays(new Date(), 7), to: new Date() },
    { label: "Last 30 days", value: "30d", from: subDays(new Date(), 30), to: new Date() },
    { label: "Last 3 months", value: "3m", from: subMonths(new Date(), 3), to: new Date() },
    { label: "All time", value: "all", from: undefined, to: undefined },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {presets.map((preset) => (
        <Button
          key={preset.value}
          variant="outline"
          size="sm"
          onClick={() => onRangeChange(preset.from, preset.to)}
          className={cn(
            "text-xs",
            from?.getTime() === preset.from?.getTime() && 
            to?.getTime() === preset.to?.getTime() && 
            "bg-primary/10 border-primary"
          )}
        >
          {preset.label}
        </Button>
      ))}
      
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="text-xs">
            <CalendarIcon className="mr-2 h-3 w-3" />
            {from ? format(from, "MMM dd") : "Start"} - {to ? format(to, "MMM dd") : "End"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={{ from, to }}
            onSelect={(range) => onRangeChange(range?.from, range?.to)}
            numberOfMonths={2}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface SymbolSelectProps {
  value?: string;
  onChange: (value: string | undefined) => void;
  symbols?: string[];
}

export function SymbolSelect({ value, onChange, symbols = [] }: SymbolSelectProps) {
  const defaultSymbols = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF"];
  const allSymbols = symbols.length > 0 ? symbols : defaultSymbols;

  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? undefined : v)}>
      <SelectTrigger className="w-32 h-9 text-xs">
        <SelectValue placeholder="All Symbols" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Symbols</SelectItem>
        {allSymbols.map((symbol) => (
          <SelectItem key={symbol} value={symbol}>
            {symbol}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface DirectionSelectProps {
  value?: Direction;
  onChange: (value: Direction | undefined) => void;
}

export function DirectionSelect({ value, onChange }: DirectionSelectProps) {
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? undefined : v as Direction)}>
      <SelectTrigger className="w-28 h-9 text-xs">
        <SelectValue placeholder="All" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All</SelectItem>
        <SelectItem value="buy">Long</SelectItem>
        <SelectItem value="sell">Short</SelectItem>
      </SelectContent>
    </Select>
  );
}

interface CloseReasonSelectProps {
  value?: CloseReason;
  onChange: (value: CloseReason | undefined) => void;
}

export function CloseReasonSelect({ value, onChange }: CloseReasonSelectProps) {
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? undefined : v as CloseReason)}>
      <SelectTrigger className="w-32 h-9 text-xs">
        <SelectValue placeholder="All Reasons" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Reasons</SelectItem>
        <SelectItem value="hit_tp">Take Profit</SelectItem>
        <SelectItem value="hit_sl">Stop Loss</SelectItem>
        <SelectItem value="timeout">Timeout</SelectItem>
        <SelectItem value="manual_close">Manual</SelectItem>
      </SelectContent>
    </Select>
  );
}

interface PnLFilterProps {
  value?: "positive" | "negative";
  onChange: (value: "positive" | "negative" | undefined) => void;
}

export function PnLFilter({ value, onChange }: PnLFilterProps) {
  return (
    <div className="flex gap-1">
      <Button
        variant={value === "positive" ? "default" : "outline"}
        size="sm"
        className="text-xs h-9"
        onClick={() => onChange(value === "positive" ? undefined : "positive")}
      >
        Winners
      </Button>
      <Button
        variant={value === "negative" ? "default" : "outline"}
        size="sm"
        className="text-xs h-9"
        onClick={() => onChange(value === "negative" ? undefined : "negative")}
      >
        Losers
      </Button>
    </div>
  );
}
