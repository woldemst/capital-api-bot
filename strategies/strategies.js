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


        return { signal: null, reason: "score_above_threshold", context };
    };







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
