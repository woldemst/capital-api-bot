import { STRATEGY } from "../config.js";
class Strategy {
    constructor() {}

    // ------------------------------------------------------------
    //     Strategy A: Bollinger Mean-Reversion (M5) + Filters
    // ------------------------------------------------------------
    getSignalBollingerMeanReversion({ symbol, indicators, candles, bid, ask }) {
        const m5 = indicators?.m5;
        const m15 = indicators?.m15;

        const m5Candles = candles?.m5Candles;
        if (!Array.isArray(m5Candles) || m5Candles.length < 3) {
            return { signal: null, reason: "insufficient_m5_candles", context: {} };
        }

        // last CLOSED candles
        const prev = m5Candles[m5Candles.length - 3];
        const last = m5Candles[m5Candles.length - 2];
        if (!prev || !last) return { signal: null, reason: "missing_prev_last", context: {} };

        const bbSeries = Array.isArray(m5?.bbSeries) ? m5.bbSeries : null;
        const rsiSeries = Array.isArray(m5?.rsiSeries) ? m5.rsiSeries : null;

        // Align indicators with the last closed candle (not the still-forming candle).
        const bb = bbSeries && bbSeries.length >= 2 ? bbSeries[bbSeries.length - 2] : m5?.bb;
        const rsi = rsiSeries && rsiSeries.length >= 2 ? rsiSeries[rsiSeries.length - 2] : m5?.rsi;
        const adxRaw = m5?.adx;
        const adx = Number.isFinite(adxRaw) ? adxRaw : adxRaw?.adx;
        const ema200 = m5?.ema200;

        if (!bb || !Number.isFinite(bb.lower) || !Number.isFinite(bb.upper) || !Number.isFinite(bb.middle)) {
            return { signal: null, reason: "missing_bb", context: { last, prev } };
        }
        if (!Number.isFinite(rsi) || !Number.isFinite(adx)) {
            return { signal: null, reason: "missing_rsi_adx", context: { last, prev, bb } };
        }

        // Tunables (env overrides)
        const mrConfig = STRATEGY?.BOLLINGER_MR ?? {};
        const rsiBuyMax = mrConfig.RSI_BUY_MAX ?? 30;
        const rsiSellMin = mrConfig.RSI_SELL_MIN ?? 70;
        const adxMax = mrConfig.ADX_MAX ?? 20;
        const useEma200Filter = mrConfig.USE_EMA200_FILTER ?? false;
        const useM15TrendFilter = mrConfig.USE_M15_TREND_FILTER ?? false;

        // Avoid strong trends
        if (adx >= adxMax) {
            return { signal: null, reason: "adx_too_high", context: { last, prev, adx, adxMax } };
        }

        // Optional M15 trend filter (avoid fading strong HTF trend)
        if (useM15TrendFilter && m15) {
            const m15Trend = this.pickTrend(m15);
            if (m15Trend === "bullish" && last.close >= bb.upper) {
                return { signal: null, reason: "m15_bull_avoid_top_fade", context: { last, prev, m15Trend } };
            }
            if (m15Trend === "bearish" && last.close <= bb.lower) {
                return { signal: null, reason: "m15_bear_avoid_bottom_fade", context: { last, prev, m15Trend } };
            }
        }

        const lastLow = Number.isFinite(last.low) ? last.low : last.close;
        const lastHigh = Number.isFinite(last.high) ? last.high : last.close;

        // BUY conditions
        if (Number.isFinite(lastLow) && lastLow <= bb.lower && rsi <= rsiBuyMax) {
            if (useEma200Filter && Number.isFinite(ema200) && last.close <= ema200) {
                return { signal: null, reason: "ema200_filter_block_buy", context: { last, prev, ema200 } };
            }

            return {
                signal: "BUY",
                reason: "bb_mean_reversion_buy",
                // TP target: mean (middle band)
                context: { last, prev, tpTarget: bb.middle, bb, rsi, adx },
            };
        }

        // SELL conditions
        if (Number.isFinite(lastHigh) && lastHigh >= bb.upper && rsi >= rsiSellMin) {
            if (useEma200Filter && Number.isFinite(ema200) && last.close >= ema200) {
                return { signal: null, reason: "ema200_filter_block_sell", context: { last, prev, ema200 } };
            }

            return {
                signal: "SELL",
                reason: "bb_mean_reversion_sell",
                context: { last, prev, tpTarget: bb.middle, bb, rsi, adx },
            };
        }

        return { signal: null, reason: "no_signal", context: { last, prev, bb, rsi, adx } };
    }

    // ------------------------------------------------------------
    //                       PRICE ACTION PATTERN | "GREEN RED"
    // ------------------------------------------------------------
    getSignalGreenRed({ indicators, candles }) {
        const { m5, m15, h1 } = indicators;

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

        const m15Trend = this.pickTrend(m15);
        // const h1Trend = this.pickTrend(h1);

        // console.log("m5Trend: ", m5Trend, "m5Prev: ", m5Prev, "m5Last: ", m5Last, "m5Signal: ", m5Signal);

        // console.log("======");

        // console.log("m15Trend: ", m15Trend, "m15Prev: ", m15Prev, "m15Last: ", m15Last, "m15Signal: ", m15Signal);

        if (m15Trend === "bullish" && m15Signal === "bullish") {
            if (m5Signal === "bullish") {
                return {
                    signal: "BUY",
                    reason: "grreen_red_pattern",
                    context: { last: m5Last, prev: m5Prev },
                };
            }
        }

        if (m15Trend === "bearish" && m15Signal === "bearish") {
            if (m5Signal === "bearish") {
                return {
                    signal: "SELL",
                    reason: "grreen_red_pattern",
                    context: { last: m5Last, prev: m5Prev },
                };
            }
        }

        return {
            signal: null,
            reason: "no_signal",
            context: { last: m5Last, prev: m5Prev },
        };
    }

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
