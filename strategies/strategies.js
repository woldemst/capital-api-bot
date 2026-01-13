import { EMA, SMA } from "technicalindicators";

import { RISK, ANALYSIS } from "../config.js";
const { RSI } = ANALYSIS;
class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------

    getSignal({ indicators, candles, bid, ask }) {
        const { m5 } = indicators;

        const prev = candles.m5Candles[candles.m5Candles.length - 2];
        const last = candles.m5Candles[candles.m5Candles.length - 1];

        // Check price-action + Bollinger setup
        const signal = this.greenRedCandlePattern(m5, prev, last);

        console.log("signal:", signal, "prev", prev, "last", last);

        if (signal === "bullish") {
            return {
                signal: "BUY",
                reason: "price_action_bollinger",
                context: { prev, last },
            };
        } else if (signal === "bearish") {
            return {
                signal: "SELL",
                reason: "price_action_bollinger",
                context: { prev, last },
            };
        } else {
            return {
                signal: null,
                reason: "no_signal",
                context: { prev, last },
            };
        }
    }

    getPriceActionSignal(indicator, prev, last) {
        // 1) Identify price‑action pattern
        const paDirection = this.greenRedCandlePattern(indicator, prev, last);

        // 2) Require the last candle’s close to be near Bollinger band extremes
        const bb = indicator?.bb;
        console.log("bb", bb.lower, bb.upper, last.close);

        if (!bb) return null;
        const close = last.close;

        // For a BUY, price should be under or at the lower band
        if (paDirection === "bullish" && close <= bb.lower) {
            return "BUY";
        }
        // For a SELL, price should be above or at the upper band
        if (paDirection === "bearish" && close >= bb.upper) {
            return "SELL";
        }
        return null;
    }

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

        if (isBear(prev) && isBull(last) && trend === "bullish") return "bullish";
        if (isBull(prev) && isBear(last) && trend === "bearish") return "bearish";

        return false;
    }

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
}

export default new Strategy();
