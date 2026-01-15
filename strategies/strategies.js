import { EMA, SMA } from "technicalindicators";

import { RISK, ANALYSIS } from "../config.js";
const { RSI } = ANALYSIS;
class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------

    getSignal({ indicators, candles, bid, ask }) {
        const { m5, h1 } = indicators;

        if (!candles?.m5Candles?.length || candles.m5Candles.length < 3) {
            return { signal: null, reason: "insufficient_m5_candles", context: {} };
        }
        if (!candles?.m15Candles?.length || candles.m15Candles.length < 3) {
            return { signal: null, reason: "insufficient_m15_candles", context: {} };
        }

        // Use the last CLOSED candles (avoid the still-forming candle at the end)
        const m5Prev = candles.m5Candles[candles.m5Candles.length - 3];
        const m5Last = candles.m5Candles[candles.m5Candles.length - 2];

        const m15Prev = candles.m15Candles[candles.m15Candles.length - 3];
        const m15Last = candles.m15Candles[candles.m15Candles.length - 2];

        // Check price-action
        const m5Signal = this.greenRedCandlePattern(m5Prev, m5Last);

        const m15Signal = this.greenRedCandlePattern(m15Prev, m15Last);

        const m5Trend = this.pickTrend(m5);
        // const h1Trend = this.pickTrend(h1);

        console.log("m5Trend: ", m5Trend,"m5Prev: ", m5Prev, "m5Last: ", m5Last, "m5Signal: ", m5Signal);
        console.log("======");
        
        const m15Trend = this.pickTrend(indicators?.m15);
        console.log("m15Trend: ", m15Trend, "m15Prev: ", m15Prev, "m15Last: ", m15Last, "m15Signal: ", m15Signal);
        

        if (m5Trend === "bullish" && m15Trend === "bullish" && m5Signal === "bullish" && m15Signal === "bullish") {
            return {
                signal: "BUY",
                reason: "grreen_red_pattern",

                context: { last: m5Last, prev: m5Prev },
            };
        } else if (m5Trend === "bearish" && m15Trend === "bearish" && m5Signal === "bearish" && m15Signal === "bearish") {
            return {
                signal: "SELL",
                reason: "grreen_red_pattern",
                context: { last: m5Last, prev: m5Prev },
            };
        } else {
            return {
                signal: null,
                reason: "no_signal",
                context: { last: m5Last, prev: m5Prev },
            };
        }
    }

    // getPriceActionSignal(indicator, prev, last) {
    //     // 1) Identify price‑action pattern
    //     const paDirection = this.greenRedCandlePattern(indicator, prev, last);

    //     // 2) Require the last candle’s close to be near Bollinger band extremes
    //     const bb = indicator?.bb;
    //     console.log("bb", bb.lower, bb.upper, last.close);

    //     if (!bb) return null;
    //     const close = last.close;

    //     // For a BUY, price should be under or at the lower band
    //     if (paDirection === "bullish" && close <= bb.lower) {
    //         return "BUY";
    //     }
    //     // For a SELL, price should be above or at the upper band
    //     if (paDirection === "bearish" && close >= bb.upper) {
    //         return "SELL";
    //     }
    //     return null;
    // }

    // ------------------------------------------------------------
    //                       PRICE ACTION PATTERN
    // ------------------------------------------------------------
    greenRedCandlePattern(prev, last) {
        if (!prev || !last) return false;

        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        // --- Candle body strength check ---
        // const body = Math.abs(last.close - last.open);
        // const range = last.high - last.low;
        // const strong = range > 0 && body / range >= 0.3;

        if (isBear(prev) && isBull(last)) return "bullish";
        if (isBull(prev) && isBear(last)) return "bearish";

        return false;
    }

    pickTrend(indicator) {
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
}

export default new Strategy();
