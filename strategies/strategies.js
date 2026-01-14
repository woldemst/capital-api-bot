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

        const m5Prev = candles.m5Candles[candles.m5Candles.length - 2];
        const m5Last = candles.m5Candles[candles.m5Candles.length - 1];

        const h1Prev = candles.h1Candles[candles.h1Candles.length - 2];
        const h1Last = candles.h1Candles[candles.h1Candles.length - 1];

        // Check price-action
        const m5Signal = this.greenRedCandlePattern(m5, m5Prev, m5Last);

        const h1Signal = this.greenRedCandlePattern(h1, h1Prev, h1Last);

        if (m5Signal === "bullish" && h1Signal === "bullish") {
            return {
                signal: "BUY",
                reason: "grreen_red_pattern",

                context: { last: m5Last, prev: m5Prev },
            };
        } else if (m5Signal === "bearish" && h1Signal === "bearish") {
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
    greenRedCandlePattern(indicator, prev, last) {
        if (!prev || !last || !indicator) return false;

        const trend = this.pickTrend(indicator);

        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        // --- Candle body strength check ---
        // const body = Math.abs(last.close - last.open);
        // const range = last.high - last.low;
        // const strong = range > 0 && body / range >= 0.3;

        if (trend === "bullish" && isBear(prev) && isBull(last)) return "bullish";
        if (trend === "bearish" && isBull(prev) && isBear(last)) return "bearish";

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
