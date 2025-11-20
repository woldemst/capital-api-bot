import { RISK, ANALYSIS } from "../config.js";

class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------
    getSignal = ({ symbol, indicators, candles, bid, ask }) => {
        const { m5, m15, h1, h4 } = indicators || {};

        const price = (bid + ask) / 2;

        const buyConditions = this.generateBuyConditions(h4, h1, m15, price);
        const sellConditions = this.generateSellConditions(h4, h1, m15, price);
        const { signal: dir } = this.evaluateSignals(buyConditions, sellConditions);

        if (!dir) return { signal: null, reason: "score_below_threshold" };

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
        // const pattern = this.greenRedCandlePattern(dir === "BUY" ? "bullish" : "bearish", prev, last);
        // if (!pattern || (pattern === "bullish" && dir !== "BUY") || (pattern === "bearish" && dir !== "SELL")) {
        //     return { signal: null, reason: "no_pattern_trigger" };
        // }

        // --- Combine all signals ---
        if (alignedTrend) return { signal: "BUY", reason: "trend_alignment", context: { prev, last } };

        if (alignedTrend) return { signal: "SELL", reason: "trend_alignment", context: { prev, last } };
        // --- Combine all signals ---
        // if (pattern === "bullish" && alignedTrend) return { signal: "BUY", reason: "pattern_trend_alignment", context: { prev, last } };

        // if (pattern === "bearish" && alignedTrend) return { signal: "SELL", reason: "pattern_trend_alignment", context: { prev, last } };

        return { signal: null, reason: "no_signal" };
    };

    evaluateSignals(buyConditions, sellConditions) {
        const threshold = RISK.REQUIRED_SCORE; // 3
        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;

        let signal = null;
        if (buyScore >= threshold && buyScore > sellScore) signal = "BUY";
        if (sellScore >= threshold && sellScore > buyScore) signal = "SELL";

        return { signal, buyScore, sellScore, threshold };
    }

    generateBuyConditions(h4, h1, m15, price) {
        return [
            h4?.emaFast > h4?.emaSlow,
            h4?.macd?.histogram > 0,
            h1?.ema9 > h1?.ema21,
            h1?.rsi < 50,
            m15?.isBullishCross,
            m15?.rsi < 30,
            price <= m15?.bb?.lower,
        ];
    }

    generateSellConditions(h4, h1, m15, price) {
        return [
            h4?.emaFast < h4?.emaSlow,
            h4?.macd?.histogram < 0,
            h1?.ema9 < h1?.ema21,
            h1?.rsi > 50,
            m15?.isBearishCross,
            m15?.rsi > 70,
            price >= m15?.bb?.upper,
        ];
    }

    // ------------------------------------------------------------
    //                       PATTERN LOGIC
    // ------------------------------------------------------------
    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last) return false;

        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        // --- Candle body strength check ---
        const body = Math.abs(last.close - last.open);
        const range = last.high - last.low;
        const strong = range > 0 && body / range >= 0.3;

        const dir = trend.toLowerCase();

        if (isBear(prev) && isBull(last) && dir === "bullish" && strong) return "bullish";
        if (isBull(prev) && isBear(last) && dir === "bearish" && strong) return "bearish";

        return false;
    }
}

export default new Strategy();
