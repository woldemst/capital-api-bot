import { EMA, SMA } from "technicalindicators";

import { RISK, ANALYSIS } from "../config.js";
const { RSI } = ANALYSIS;
class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------

    getSignal = ({ symbol, indicators = {}, candles = {}, bid, ask }) => {
        const m15Candles = candles?.m15Candles;

        // --- guards ---
        if (!Array.isArray(m15Candles) || m15Candles.length < 20) {
            return { signal: null, reason: "insufficient_m15_candles", context: {} };
        }
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
            return { signal: null, reason: "invalid_bid_ask", context: {} };
        }

        // Use last *closed* candles (avoid the currently forming candle)
        const prev = m15Candles[m15Candles.length - 3];
        const last = m15Candles[m15Candles.length - 2];
        if (!prev || !last) return { signal: null, reason: "missing_prev_last", context: {} };

        const closes = m15Candles.map((c) => c?.close).filter((v) => Number.isFinite(v));
        if (closes.length < 20) return { signal: null, reason: "insufficient_close_series", context: { prev, last } };

        // --- compute EMA(5) and SMA(15) series ---
        const ema5 = EMA.calculate({ period: 5, values: closes });
        const sma15 = SMA.calculate({ period: 15, values: closes });

        // Need previous & current values to detect crossover
        if (ema5.length < 3 || sma15.length < 3) {
            return { signal: null, reason: "insufficient_ma_series", context: { prev, last } };
        }

        const emaPrev = ema5[ema5.length - 2];
        const emaCurr = ema5[ema5.length - 1];
        const smaPrev = sma15[sma15.length - 2];
        const smaCurr = sma15[sma15.length - 1];

        
        // --- MACD histogram confirmation (from your indicators) ---
        const macdHist = indicators?.m15?.macd?.histogram;
        if (!Number.isFinite(macdHist)) {
            return {
                signal: null,
                reason: "missing_macd_histogram",
                context: { prev, last, emaPrev, emaCurr, smaPrev, smaCurr, macdHist },
            };
        }

        // --- crossover detection ---
        const bullishCross = emaPrev <= smaPrev && emaCurr > smaCurr;
        const bearishCross = emaPrev >= smaPrev && emaCurr < smaCurr;

        console.log("bullishCross:", bullishCross, "bearishCross:", bearishCross, "macdHist:", macdHist);
        

        // --- final signal rules ---
        if (bullishCross && macdHist > 0) {
            return {
                signal: "BUY",
                reason: "ema5_sma15_bull_cross_macd_confirm",
                context: { prev, last, emaPrev, emaCurr, smaPrev, smaCurr, macdHist },
            };
        }

        if (bearishCross && macdHist < 0) {
            return {
                signal: "SELL",
                reason: "ema5_sma15_bear_cross_macd_confirm",
                context: { prev, last, emaPrev, emaCurr, smaPrev, smaCurr, macdHist },
            };
        }

        return {
            signal: null,
            reason: "no_signal",
            context: { prev, last, emaPrev, emaCurr, smaPrev, smaCurr, macdHist },
        };
    };

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
}

export default new Strategy();
