import { RISK, ANALYSIS } from "../config.js";
const { RSI } = ANALYSIS;

class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------
    getSignal = ({ symbol, indicators = {}, candles = {}, bid, ask }) => {
        const { m5, m15, h1, h4 } = indicators;

        const price = (bid + ask) / 2;

        // --- Candle data ---
        const prev = candles.m5Candles[candles.m5Candles.length - 3];
        const last = candles.m5Candles[candles.m5Candles.length - 2];

        const context = { prev, last };

        const buyConditions = this.generateBuyConditions(h4, h1, m15, price);
        const sellConditions = this.generateSellConditions(h4, h1, m15, price);
        const evaluation = this.evaluateSignals(buyConditions, sellConditions, context);

        if (!evaluation.signal) return { ...evaluation, signal: null, reason: "score_below_threshold", context };

        return { ...evaluation, reason: "score_above_threshold", context };
    };

    pickTrend(indicator, _meta = {}) {
        if (!indicator) return "neutral";
        const { ema20, ema50, emaFast, emaSlow, ema9, ema21, trend } = indicator;

        if (Number.isFinite(ema20) && Number.isFinite(ema50)) {
            if (ema20 > ema50) return "bullish";
            if (ema20 < ema50) return "bearish";
        }

        if (Number.isFinite(emaFast) && Number.isFinite(emaSlow)) {
            if (emaFast > emaSlow) return "bullish";
            if (emaFast < emaSlow) return "bearish";
        }

        if (Number.isFinite(ema9) && Number.isFinite(ema21)) {
            if (ema9 > ema21) return "bullish";
            if (ema9 < ema21) return "bearish";
        }

        if (trend === "bullish" || trend === "bearish") {
            return trend;
        }

        return "neutral";
    }

    evaluateSignals(buyConditions, sellConditions, context) {
        const threshold = RISK.REQUIRED_SCORE; // 3
        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;

        let signal = null;
        if (buyScore >= threshold) signal = "BUY";
        if (sellScore >= threshold) signal = "SELL";

        return { signal, buyScore, sellScore, threshold, context };
    }

    generateBuyConditions(h4, h1, m15, price) {
        return [
            h4?.emaFast > h4?.emaSlow,
            h4?.macd?.histogram > 0,

            h1?.ema9 > h1?.ema21,
            h1?.rsi < RSI.EXIT_OVERSOLD,

            m15?.isBullishCross,
            m15?.rsi < RSI.OVERSOLD,

            price <= m15?.bb?.lower,
        ];
    }

    generateSellConditions(h4, h1, m15, price) {
        return [
            !h4?.isBullishTrend,
            h4?.macd?.histogram < 0,

            h1?.ema9 < h1?.ema21,
            h1?.rsi > RSI.OVERBOUGHT,

            m15?.isBearishCross,
            m15?.rsi > RSI.OVERBOUGHT,

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
