import { STRATEGY } from "../config.js";
class Strategy {
    constructor() {}

    // ------------------------------------------------------------
    //     Strategy A: Bollinger Mean-Reversion (M5) + Filters
    // ------------------------------------------------------------
    getSignalBollingerMeanReversion({ symbol, indicators, candles, bid, ask }) {
        const { m5, m15 } = indicators;

        const m5Candles = candles?.m5Candles;
        if (m5Candles.length < 3) {
            return { signal: null, reason: "insufficient_m5_candles", context: {} };
        }

        // last CLOSED candles
        const prev = m5Candles[m5Candles.length - 3];
        const last = m5Candles[m5Candles.length - 2];
        if (!prev || !last) return { signal: null, reason: "missing_prev_last", context: {} };

        // Align indicators with the last closed candle (not the still-forming candle).
        const bb = m5.bbSeries[m5.bbSeries.length - 2];
        const rsi = m5.rsiSeries[m5.rsiSeries.length - 2];

        const adx = m5?.adx.adx;
        const ema200 = m5?.ema200;

        if (!bb || !Number.isFinite(bb.lower) || !Number.isFinite(bb.upper) || !Number.isFinite(bb.middle)) {
            return { signal: null, reason: "missing_bb", context: { last, prev } };
        }
        if (!Number.isFinite(rsi) || !Number.isFinite(adx)) {
            return { signal: null, reason: "missing_rsi_adx", context: { last, prev, bb } };
        }

        // Tunables (env overrides)
        const mrConfig = STRATEGY?.BOLLINGER_MR;
        const rsiBuyMax = mrConfig.RSI_BUY_MAX;
        const rsiSellMin = mrConfig?.RSI_SELL_MIN;
        const adxMax = mrConfig?.ADX_MAX;
        const useEma200Filter = mrConfig?.USE_EMA200_FILTER;
        const useM15TrendFilter = mrConfig?.USE_M15_TREND_FILTER;

        // Avoid strong trends
        console.log(`ADX: ${adx}, ADX Max: ${adxMax}`);

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

        // BUY conditions
        if (last.low <= bb.lower && rsi <= rsiBuyMax) {
            if (useEma200Filter && last.close <= ema200) {
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
        if (last.high >= bb.upper && rsi >= rsiSellMin) {
            if (useEma200Filter && last.close >= ema200) {
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
        const { m5, m15 } = indicators;

        if (candles?.m5Candles.length < 3) return { signal: null, reason: "insufficient_m5_candles", context: {} };
        if (candles?.m15Candles.length < 3) return { signal: null, reason: "insufficient_m15_candles", context: {} };

        const m5Prev = candles.m5Candles[candles.m5Candles.length - 3];
        const m5Last = candles.m5Candles[candles.m5Candles.length - 2];

        const m5Signal = this.greenRedCandlePattern(m5Prev, m5Last);
        if (!m5Signal) {
            return { signal: null, reason: "no_pattern", context: { last: m5Last, prev: m5Prev } };
        }

        const m5Trend = this.pickTrend(m5);
        const m15Trend = this.pickTrend(m15);
        const trendsAligned = m5Trend === m15Trend && (m5Trend === "bullish" || m5Trend === "bearish");

        if (!trendsAligned) {
            return { signal: null, reason: "trend_not_aligned", context: { last: m5Last, prev: m5Prev, m5Trend, m15Trend } };
        }

        if (m5Signal !== m5Trend) {
            return { signal: null, reason: "pattern_vs_trend_mismatch", context: { last: m5Last, prev: m5Prev, m5Signal, m5Trend, m15Trend } };
        }

        const adx = m5.adx.adx;
        if (adx >= 28) {
            return { signal: null, reason: "adx_too_high", context: { last: m5Last, prev: m5Prev, adx } };
        }

        // Option A: M15 quality filter (entry must not be "expensive/extended")
        const m15Rsi = m15.rsi.rsi;
        const m15Pb = m15.bb.pb;

        const m15QualityOk = m15Rsi <= 45 && m15Pb <= 0.3;
        if (!m15QualityOk) {
            return { signal: null, reason: "blocked_m15_quality", context: { last: m5Last, prev: m5Prev, adx, m15Rsi, m15Pb, m5Trend, m15Trend } };
        }

        const signal = m5Trend === "bullish" ? "BUY" : "SELL";
        return { signal, reason: "green_red_pattern", context: { last: m5Last, prev: m5Prev, m5Trend, m15Trend, adx, m15Rsi, m15Pb } };
    }

    greenRedCandlePattern(prev, last) {
        if (!prev || !last) return false;

        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        // --- Candle body strength check ---
        const body = Math.abs(last.close - last.open);
        const range = last.high - last.low;
        const strong = range > 0 && body / range >= 0.3;

        if (isBear(prev) && isBull(last) && strong) return "bullish";
        if (isBull(prev) && isBear(last) && strong) return "bearish";

        return false;
    }

    pickTrend(indicator) {
        const { ema20, ema50, trend } = indicator;

        if (ema20 > ema50) return "bullish";
        if (ema20 < ema50) return "bearish";
        if (trend === "bullish" || trend === "bearish") return trend;

        return "neutral";
    }
}

export default new Strategy();
