import { RISK, ANALYSIS } from "../config.js";
const { RSI } = ANALYSIS;

class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------
    getSignal = ({ symbol, indicators = {}, candles = {}, bid, ask }) => {
        const { m5, m15, h1, h4, d1, m1 } = indicators;

        const price = (bid + ask) / 2;

        // --- Candle data ---
        const prev = candles.m5Candles[candles.m5Candles.length - 3];
        const last = candles.m5Candles[candles.m5Candles.length - 2];

        const context = { prev, last };

        const buyConditions = this.generateBuyConditions(h4, h1, m15, m5, price);
        const sellConditions = this.generateSellConditions(h4, h1, m15, m5, price);
        const evaluation = this.evaluateSignals(buyConditions, sellConditions, context);

        if (!evaluation.signal) return { ...evaluation, signal: null, reason: "score_below_threshold", context };

        const filter = this.passesDirectionalFilters(evaluation.signal, { d1, m1, m5 });
        if (!filter.pass) return { ...evaluation, signal: null, reason: filter.reason, context };

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

    passesDirectionalFilters(direction, { d1, m1, m5 }) {
        const toNumber = (value) => {
            if (value === undefined || value === null || value === "") return NaN;
            const num = typeof value === "number" ? value : Number(value);
            return Number.isFinite(num) ? num : NaN;
        };

        const m5Adx = toNumber(m5?.adx?.adx ?? m5?.adx);
        if (Number.isFinite(m5Adx) && m5Adx > 23) {
            return { pass: false, reason: "filter_m5_adx" };
        }

        if (direction === "BUY") {
            if (d1?.trend && d1.trend !== "bullish") return { pass: false, reason: "filter_d1_trend" };

            const d1Rsi = toNumber(d1?.rsi);
            if (Number.isFinite(d1Rsi) && d1Rsi < 55) return { pass: false, reason: "filter_d1_rsi" };

            const d1PriceVsEma9 = toNumber(d1?.price_vs_ema9);
            if (Number.isFinite(d1PriceVsEma9) && d1PriceVsEma9 < 0.0017) return { pass: false, reason: "filter_d1_price_vs_ema9" };

            const m1Rsi = toNumber(m1?.rsi);
            if (Number.isFinite(m1Rsi) && m1Rsi < 52) return { pass: false, reason: "filter_m1_rsi" };
        }

        if (direction === "SELL") {
            if (d1?.trend && d1.trend !== "bearish") return { pass: false, reason: "filter_d1_trend" };

            const d1Rsi = toNumber(d1?.rsi);
            if (Number.isFinite(d1Rsi) && d1Rsi > 45) return { pass: false, reason: "filter_d1_rsi" };

            const d1PriceVsEma9 = toNumber(d1?.price_vs_ema9);
            if (Number.isFinite(d1PriceVsEma9) && d1PriceVsEma9 > -0.0017) return { pass: false, reason: "filter_d1_price_vs_ema9" };

            const m1Rsi = toNumber(m1?.rsi);
            if (Number.isFinite(m1Rsi) && m1Rsi > 48) return { pass: false, reason: "filter_m1_rsi" };
        }

        return { pass: true, reason: "" };
    }

    generateBuyConditions(h4, h1, m15, m5, price) {
        const m5Trend = this.pickTrend(m5);

        return [
            // Higher timeframe bullish bias
            h4?.emaFast > h4?.emaSlow,
            h4?.macd?.histogram > 0,

            h1?.ema9 > h1?.ema21,
            h1?.rsi < RSI.EXIT_OVERSOLD,

            // M15 confirmation
            m15?.isBullishCross,
            m15?.rsi > 50,
            price >= m15?.bb?.middle,

            // NEW: M5 structure alignment for M5-focused trading
            m5Trend === "bullish",
            m5?.ema9 > m5?.ema21,
            m5?.close > m5?.ema50,

            m5?.rsi > 50 && m5?.rsi < RSI.OVERBOUGHT,
        ];
    }

    generateSellConditions(h4, h1, m15, m5, price) {
        const m5Trend = this.pickTrend(m5);

        return [
            // Higher timeframe bearish bias
            h4?.emaFast < h4?.emaSlow,
            h4?.macd?.histogram < 0,

            h1?.ema9 < h1?.ema21,
            h1?.rsi > RSI.OVERBOUGHT,

            // M15 confirmation
            m15?.isBearishCross,
            m15?.rsi < 50,
            price <= m15?.bb?.middle,

            // NEW: M5 structure alignment for M5-focused trading
            m5Trend === "bearish",
            m5?.ema9 < m5?.ema21,
            m5?.close < m5?.ema50,

            m5?.rsi < 50 && m5?.rsi > RSI.OVERSOLD,
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
