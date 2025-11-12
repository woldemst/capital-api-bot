class Strategy {
    constructor() {}

    trendFrom = (fast, slow, minGap = 0.1 * Math.abs(slow)) => {
        if (fast == null || slow == null) return "neutral";
        const diff = fast - slow;
        if (diff > minGap) return "bullish";
        if (diff < -minGap) return "bearish";
        return "neutral";
    };

    pickTrend(frame, fast = ["ema20", "emaFast", "ema9"], slow = ["ema50", "emaSlow", "ema21"]) {
        const fastVal = fast.map((k) => frame?.[k]).find((v) => v != null);
        const slowVal = slow.map((k) => frame?.[k]).find((v) => v != null);
        return this.trendFrom(fastVal, slowVal);
    }

    getSignal = ({ symbol, indicators, candles }) => {
        const { m5, m15, h1 } = indicators || {};
        const m5Candles = candles?.m5Candles || [];

        const prev = m5Candles[m5Candles.length - 2];
        const last = m5Candles[m5Candles.length - 1];
        if (!prev || !last) return { signal: null, reason: "no_candle_data" };

        const m5Trend = this.pickTrend(m5);
        const m15Trend = this.pickTrend(m15);
        const h1Trend = this.pickTrend(h1);

        if (m5Trend !== m15Trend || !["bullish", "bearish"].includes(m5Trend)) {
            return { signal: null, reason: "tf_misaligned", context: { m5Trend, m15Trend } };
        }

        if (h1Trend !== "neutral" && h1Trend !== m5Trend && h1Trend !== m15Trend) {
            return { signal: null, reason: "h1_filter_blocked", context: { h1Trend } };
        }

        const pattern = this.greenRedCandlePattern(m5Trend, prev, last);
        const engulfing = this.engulfingPattern(prev, last);
        const pinBar = this.pinBarPattern(last);

        const finalPattern = pattern || engulfing || pinBar;
        if (finalPattern !== m5Trend) return { signal: null, reason: "pattern_mismatch" };
        // Optional: Volume filter
        if (last.volume != null && prev.volume != null && last.volume < prev.volume * 0.8) {
            return { signal: null, reason: "low_volume" };
        }

        const decision = m5Trend === "bullish" ? "BUY" : "SELL";
        return {
            signal: decision,
            reason: "pattern+tf_alignment",
            context: {
                m5Trend,
                m15Trend,
                h1Trend,
                pattern,
                engulfing,
                pinBar,
                prev,
                last,
            },
        };
    };

    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last) return false;
        const isBullish = (c) => c.close > c.open;
        const isBearish = (c) => c.close < c.open;

        const bodySize = Math.abs(last.close - last.open);
        const range = last.high - last.low;
        const minBodyRatio = 0.3;

        const trendDirection = String(trend).toLowerCase();
        const strongCandle = range > 0 && bodySize / range >= minBodyRatio;

        if (isBearish(prev) && isBullish(last) && trendDirection === "bullish" && strongCandle) return "bullish";
        if (isBullish(prev) && isBearish(last) && trendDirection === "bearish" && strongCandle) return "bearish";

        return false;
    }

    engulfingPattern(prev, last) {
        if (!prev || !last) return null;

        if (last.close > last.open && prev.close < prev.open && last.close > prev.open && last.open < prev.close) return "bullish";

        if (last.close < last.open && prev.close > prev.open && last.close < prev.open && last.open > prev.close) return "bearish";

        return null;
    }

    pinBarPattern(last) {
        if (!last) return null;
        const open = last.open;
        const close = last.close;
        const high = last.high;
        const low = last.low;

        const body = Math.abs(close - open);
        const upperWick = high - Math.max(open, close);
        const lowerWick = Math.min(open, close) - low;

        if (lowerWick > body * 2) return "bullish";
        if (upperWick > body * 2) return "bearish";

        return null;
    }
}

export default new Strategy();
