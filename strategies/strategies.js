import { RISK, ANALYSIS } from "../config.js";

class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------
    getSignal = ({ symbol, indicators, candles, bid, ask }) => {
        const { m5, m15, h1, h4 } = indicators || {};

        // --- Basic sanity checks ---
        if (!m5 || !m15 || !h1) return { signal: null, reason: "missing_tf_indicators" };

        const price = (bid + ask) / 2;

        if (ANALYSIS.RANGE_FILTER.ENABLED) {
            if (!this.passesRangeFilter(m15, price, ANALYSIS.MIN_ATR_PCT)) {
                return { signal: null, reason: "range_filter_block" };
            }
        }

        // 2) Multi-TF condition scoring
        const buyConditions = this.generateBuyConditions(h4, h1, m15, price);
        const sellConditions = this.generateSellConditions(h4, h1, m15, price);
        const { signal: dir, buyScore, sellScore, threshold } = this.evaluateSignals(buyConditions, sellConditions);

        if (!dir) return { signal: null, reason: "score_below_threshold", meta: { buyScore, sellScore, threshold } };

        // --- Multi-timeframe trends ---
        // const m15Trend = m15.ema20 > m15.ema50 ? "bullish" : m15.ema20 < m15.ema50 ? "bearish" : "neutral";
        // const m5Trend = m5.ema20 > m5.ema50 ? "bullish" : m5.ema20 < m5.ema50 ? "bearish" : "neutral";
        // const m1Trend = m1.ema20 > m1.ema50 ? "bullish" : m1.ema20 < m1.ema50 ? "bearish" : "neutral";

        // --- Check alignment between higher timeframes ---
        // const alignedTrend = m15Trend === m5Trend && (m15Trend === "bullish" || m15Trend === "bearish");
        // if (!alignedTrend) return { signal: null, reason: "trend_not_aligned" };

        // --- Candle data ---
        const prev = candles.m5Candles[candles.m5Candles.length - 3];
        const last = candles.m5Candles[candles.m5Candles.length - 2];
        if (!prev || !last) return { signal: null, reason: "no_candle_data" };

        // --- Pattern recognition ---
        const pattern = this.greenRedCandlePattern(dir === "BUY" ? "bullish" : "bearish", prev, last) || this.pinBarPattern(last);
        if (!pattern || (pattern === "bullish" && dir !== "BUY") || (pattern === "bearish" && dir !== "SELL")) {
            return { signal: null, reason: "no_pattern_trigger", meta: { buyScore, sellScore, threshold } };
        }
        // --- Candle body strength check ---
        const body = Math.abs(last.close - last.open);
        const avgBody = Math.abs(prev.close - prev.open);
        if (body < avgBody * 0.8) {
            return { signal: null, reason: "weak_candle", meta: { buyScore, sellScore, threshold } };
        }
        // --- Combine all signals ---
        // if (pattern === "bullish" && alignedTrend) return { signal: "BUY", reason: "pattern_trend_alignment", context: { prev, last } };

        // if (pattern === "bearish" && alignedTrend) return { signal: "SELL", reason: "pattern_trend_alignment", context: { prev, last } };

        // return { signal: null, reason: "no_signal" };

        return { signal: dir, reason: "score_and_pattern", context: { prev, last } };
    };

    passesRangeFilter(indicators, price, config) {
        if (!config?.ENABLED || !indicators || !price) return true;

        // ATR
        if (indicators.atr) {
            const atrPct = indicators.atr / price;
            if (atrPct < config.MIN_ATR_PCT) return false;
        }

        // BB width
        if (indicators.bb) {
            const width = indicators.bb.upper - indicators.bb.lower;
            const widthPct = width / price;
            if (widthPct < config.MIN_BB_WIDTH_PCT) return false;
        }

        // EMA distance
        if (indicators.emaFast && indicators.emaSlow) {
            const distPct = Math.abs(indicators.emaFast - indicators.emaSlow) / price;
            if (distPct < config.MIN_EMA_DIST_PCT) return false;
        }

        return true;
    }

    evaluateSignals(buyConditions, sellConditions) {
        const threshold = RISK.REQUIRED_SCORE;
        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;

        let signal = null;
        if (buyScore >= threshold && buyScore > sellScore) signal = "BUY";
        if (sellScore >= threshold && sellScore > buyScore) signal = "SELL";

        return { signal, buyScore, sellScore, threshold };
    }

    // adjust to your indicator schema
    generateBuyConditions(h4, h1, m15, price) {
        return [
            h4?.ema20 > h4?.ema50,
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
            h4?.ema20 < h4?.ema50,
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
