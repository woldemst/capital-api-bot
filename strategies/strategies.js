import { EMA, SMA } from "technicalindicators";

import { RISK, ANALYSIS } from "../config.js";
const { RSI } = ANALYSIS;
class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------

    // getSignal = ({ symbol, indicators = {}, candles = {}, bid, ask }) => {
    //     const m15Candles = candles?.m15Candles;

    //     // --- guards ---
    //     if (!Array.isArray(m15Candles) || m15Candles.length < 20) {
    //         return { signal: null, reason: "insufficient_m15_candles", context: {} };
    //     }
    //     if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    //         return { signal: null, reason: "invalid_bid_ask", context: {} };
    //     }

    //     // Use last *closed* candles (avoid the currently forming candle)
    //     const prev = m15Candles[m15Candles.length - 3];
    //     const last = m15Candles[m15Candles.length - 2];
    //     if (!prev || !last) return { signal: null, reason: "missing_prev_last", context: {} };

    //     const closes = m15Candles.map((c) => c?.close).filter((v) => Number.isFinite(v));
    //     if (closes.length < 20) return { signal: null, reason: "insufficient_close_series", context: { prev, last } };

    //     // --- compute EMA(5) and SMA(15) series ---
    //     const ema5 = EMA.calculate({ period: 5, values: closes });
    //     const sma15 = SMA.calculate({ period: 15, values: closes });

    //     // Need previous & current values to detect crossover
    //     if (ema5.length < 3 || sma15.length < 3) {
    //         return { signal: null, reason: "insufficient_ma_series", context: { prev, last } };
    //     }

    //     const emaPrev = ema5[ema5.length - 2];
    //     const emaCurr = ema5[ema5.length - 1];
    //     const smaPrev = sma15[sma15.length - 2];
    //     const smaCurr = sma15[sma15.length - 1];

    //     // --- MACD histogram confirmation (from your indicators) ---
    //     const macdHist = indicators?.m15?.macd?.histogram;
    //     if (!Number.isFinite(macdHist)) {
    //         return {
    //             signal: null,
    //             reason: "missing_macd_histogram",
    //             context: { prev, last, emaPrev, emaCurr, smaPrev, smaCurr, macdHist },
    //         };
    //     }

    //     // --- crossover detection ---
    //     const bullishCross = emaPrev <= smaPrev && emaCurr > smaCurr;
    //     const bearishCross = emaPrev >= smaPrev && emaCurr < smaCurr;

    //     console.log("bullishCross:", bullishCross, "bearishCross:", bearishCross, "macdHist:", macdHist);

    //     // --- final signal rules ---
    //     if (bullishCross && macdHist > 0) {
    //         return {
    //             signal: "BUY",
    //             reason: "ema5_sma15_bull_cross_macd_confirm",
    //             context: { prev, last, emaPrev, emaCurr, smaPrev, smaCurr, macdHist },
    //         };
    //     }

    //     if (bearishCross && macdHist < 0) {
    //         return {
    //             signal: "SELL",
    //             reason: "ema5_sma15_bear_cross_macd_confirm",
    //             context: { prev, last, emaPrev, emaCurr, smaPrev, smaCurr, macdHist },
    //         };
    //     }

    //     return {
    //         signal: null,
    //         reason: "no_signal",
    //         context: { prev, last, emaPrev, emaCurr, smaPrev, smaCurr, macdHist },
    //     };
    // };

    getSignal({ indicators, candles, bid, ask }) {
        const { m5, h1, h4 } = indicators;
        const m5Candles = candles.m5Candles;
        if (!m5Candles || m5Candles.length < 3) {
            return { signal: null, reason: "insufficient_candles", context: {} };
        }
        const prev = m5Candles[m5Candles.length - 3];
        const last = m5Candles[m5Candles.length - 2];
        // Check price‑action + Bollinger setup
        const sygnal = this.getPriceActionSignal(m5, m5, prev, last);
        if (sygnal) {
            return {
                signal: sygnal,
                reason: "price_action_bollinger",
                context: { prev, last, sygnal },
            };
        }

        return {
            signal: null,
            reason: "no_signal",
        };

        // ... fallback to EMA/SMA + MACD or multi‑timeframe logic if desired ...
    }
    // ------------------------------------------------------------
    //                       PRICE ACTION PATTERN
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

    getPriceActionSignal(trendIndicator, m5Indicators, prevCandle, lastCandle) {
        // 1) Identify price‑action pattern
        const paDirection = this.greenRedCandlePattern(
            this.pickTrend(trendIndicator), // trend context (e.g. m5)
            prevCandle,
            lastCandle
        );
        if (!paDirection) return null;
        // 2) Require the last candle’s close to be near Bollinger band extremes
        const bb = m5Indicators?.bb;

        if (!bb) return null;
        const close = lastCandle.close;

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
