import logger from "../utils/logger.js";

class Strategy {
    constructor() {}

    trendFrom = (fast, slow, minGap = 0) => {
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

    // --- Main signal with H1 filter ---
    getSignal = ({ symbol, indicators, candles }) => {
        const { m5, m15, h1 } = indicators || {};
        const m5Candles = candles?.m5Candles || [];

        // Use last two CLOSED M5 candles
        const prev = m5Candles[m5Candles.length - 2];
        const last = m5Candles[m5Candles.length - 1];
        if (!prev || !last) return { signal: null, reason: "no_candle_data" };

        const m5Trend = this.pickTrend(m5);
        const m15Trend = this.pickTrend(m15);

        if (m5Trend !== m15Trend || !["bullish", "bearish"].includes(m5Trend)) {
            return { signal: null, reason: "tf_misaligned", context: { m5Trend, m15Trend } };
        }
        const h1Trend = this.pickTrend(h1, ["ema20", "emaFast", "ema21"], ["ema50", "emaSlow", "ema200", "ema100", "ema50"]);

        // allow trades when H1 is neutral or aligned
        if (h1Trend !== "neutral" && h1Trend !== m5Trend) {
            return { signal: null, reason: "h1_filter_blocked", context: { h1Trend } };
        }

        // Entry pattern on M5 (using closed candles only)
        const pattern = this.greenRedCandlePattern(m5Trend, prev, last);
        if (!pattern) return { signal: null, reason: "no_pattern" };

        const decision = pattern === "bullish" ? "BUY" : "SELL";
        return {
            signal: decision,
            reason: "pattern+tf_alignment",
            context: { prev, last },
        };
    };

    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last) return false;
        const isBullish = (c) => c.close > c.open;
        const isBearish = (c) => c.close < c.open;

        const bodySize = Math.abs(last.close - last.open);
        const range = last.high - last.low;
        const minBodyRatio = 0.3; // require body ≥ 30% of total range

        const trendDirection = String(trend).toLowerCase();

        // Only strong candle in direction of trend counts
        const strongCandle = range > 0 && bodySize / range >= minBodyRatio;

        if (isBearish(prev) && isBullish(last) && trendDirection === "bullish" && strongCandle) {
            return "bullish";
        }

        if (isBullish(prev) && isBearish(last) && trendDirection === "bearish" && strongCandle) {
            return "bearish";
        }

        return false;
    }

    engulfingPattern(prev, last) {
        const getOpen = (c) => c.open;
        const getClose = (c) => c.close;

        if (!prev || !last) return null;

        const prevOpen = getOpen(prev);
        const prevClose = getClose(prev);

        const lastOpen = getOpen(last);
        const lastClose = getClose(last);

        // Bullish engulfing
        if (lastClose > lastOpen && prevClose < prevOpen && lastClose > prevOpen && lastOpen < prevClose) return "bullish";

        // Bearish engulfing
        if (lastClose < lastOpen && prevClose > prevOpen && lastClose < prevOpen && lastOpen > prevClose) return "bearish";

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

        // Bullish pin bar: long lower wick (≥2× body)
        if (lowerWick > body * 2) return "bullish";

        // Bearish pin bar: long upper wick (≥2× body)
        if (upperWick > body * 2) return "bearish";

        return null;
    }
}

export default new Strategy();
