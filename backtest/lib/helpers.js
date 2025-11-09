import Strategy from "../../strategies/strategies.js";

export const MAX_BUF = 200;
export const MIN_BARS = 60;
export const LOOKAHEAD_CANDLES = 120;

export function pushUnique(buffer, candle) {
    if (!candle || !candle.timestamp) {
        return false;
    }
    const last = buffer[buffer.length - 1];
    if (last && last.timestamp === candle.timestamp) {
        return false;
    }
    buffer.push(candle);
    if (buffer.length > MAX_BUF) buffer.shift();
    return true;
}

export function getPipSize(symbol = "") {
    return symbol.includes("JPY") ? 0.01 : 0.0001;
}

export function extractFrameContext(indicators) {
    if (!indicators) return null;
    const trend = Strategy.pickTrend(indicators);
    return {
        ema20: indicators.ema20 ?? null,
        ema50: indicators.ema50 ?? null,
        ema200: indicators.ema200 ?? null,
        rsi: indicators.rsi ?? null,
        macdHist: indicators.macd?.histogram ?? null,
        atr: indicators.atr ?? null,
        trend,
    };
}

export function trendOpposite(direction, trend) {
    if (!trend) return false;
    if (!direction) return false;
    const dir = direction.toUpperCase();
    return (dir === "BUY" && trend === "bearish") || (dir === "SELL" && trend === "bullish");
}

export function toNumber(value, precision = 6) {
    if (typeof value !== "number" || Number.isNaN(value)) return null;
    return Number(value.toFixed(precision));
}

export function getSessionInfo(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return { session: "unknown", hour: null, weekday: null };
    }
    const hour = date.getUTCHours();
    const weekday = date.getUTCDay();

    const session = (() => {
        if ((hour >= 7 && hour < 16)) return "london";
        if (hour >= 12 && hour < 21) return "new_york";
        if (hour >= 21 || hour < 7) return "asia";
        return "off";
    })();

    return { session, hour, weekday };
}

export function formatCsvRow(columns, data) {
    return (
        columns
            .map((col) => {
                const value = data[col];
                if (value == null) return "";
                if (typeof value === "object") return JSON.stringify(value);
                return `${value}`;
            })
            .join(",") + "\n"
    );
}
