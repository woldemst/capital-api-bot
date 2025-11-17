class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------
    getSignal = ({ symbol, indicators, candles, bid, ask }) => {
        const { m5, m15, h1, h4 } = indicators || {};

        // --- Basic sanity checks ---
        if (!m15 || !h1) return { signal: null, reason: "missing_tf_indicators" };

        // --- Multi-timeframe trends ---
        const m15Trend = m15.ema20 > m15.ema50 ? "bullish" : m15.ema20 < m15.ema50 ? "bearish" : "neutral";
        const m5Trend = m5.ema20 > m5.ema50 ? "bullish" : m5.ema20 < m5.ema50 ? "bearish" : "neutral";
        // const m1Trend = m1.ema20 > m1.ema50 ? "bullish" : m1.ema20 < m1.ema50 ? "bearish" : "neutral";

        // --- Check alignment between higher timeframes ---
        const alignedTrend = m15Trend === m5Trend && (m15Trend === "bullish" || m15Trend === "bearish");
        if (!alignedTrend) return { signal: null, reason: "trend_not_aligned" };

        // --- Candle data ---
        const prev = candles.m5Candles[candles.m5Candles.length - 3];
        const last = candles.m5Candles[candles.m5Candles.length - 2];
        if (!prev || !last) return { signal: null, reason: "no_candle_data" };

        // --- Pattern recognition ---
        const pattern = this.greenRedCandlePattern(m5Trend, prev, last) || this.pinBarPattern(last);
        if (!pattern) return { signal: null, reason: "no_pattern" };

        // --- Candle body strength check ---
        const body = Math.abs(last.close - last.open);
        const avgBody = Math.abs(prev.close - prev.open);
        if (body < avgBody * 0.8) return { signal: null, reason: "weak_candle" };

        // --- Combine all signals ---
        if (pattern === "bullish" && alignedTrend) return { signal: "BUY", reason: "pattern_trend_alignment", context: { prev, last } };

        if (pattern === "bearish" && alignedTrend) return { signal: "SELL", reason: "pattern_trend_alignment", context: { prev, last } };

        return { signal: null, reason: "no_signal" };
    };

    // ------------------------------------------------------------
    //                       PATTERN LOGIC
    // ------------------------------------------------------------
    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last) return false;

        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        const body = Math.abs(last.close - last.open);
        const range = last.high - last.low;
        const strong = range > 0 && body / range >= 0.3;

        const dir = trend.toLowerCase();

        if (isBear(prev) && isBull(last) && dir === "bullish" && strong) return "bullish";
        if (isBull(prev) && isBear(last) && dir === "bearish" && strong) return "bearish";

        return false;
    }

    engulfingPattern(prev, last) {
        if (!prev || !last) return null;

        const bull = last.close > last.open && prev.close < prev.open && last.close > prev.open && last.open < prev.close;

        const bear = last.close < last.open && prev.close > prev.open && last.close < prev.open && last.open > prev.close;

        if (bull) return "bullish";
        if (bear) return "bearish";
        return null;
    }

    pinBarPattern(last) {
        if (!last) return null;

        const body = Math.abs(last.close - last.open);
        const upper = last.high - Math.max(last.open, last.close);
        const lower = Math.min(last.open, last.close) - last.low;

        if (lower > body * 2) return "bullish";
        if (upper > body * 2) return "bearish";

        return null;
    }
}

export default new Strategy();
