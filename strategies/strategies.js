import { STRATEGY } from "../config.js";
class Strategy {
    constructor() {}

    generateSignal({ symbol, indicators, bid, ask, candles }) {
        const { h4, h1, m15 } = indicators;
        const buyConditions = this.generateBuyConditions(h4, h1, m15, bid);
        const sellConditions = this.generateSellConditions(h4, h1, m15, ask);
        const { signal, buyScore, sellScore } = this.evaluateSignals(buyConditions, sellConditions);
        return {
            signal,
            buyScore,
            sellScore,
            reason: "condition_evaluation",
            context: {},
        };
    }

    generateBuyConditions(h4Indicators, h1Indicators, m15Indicators, bid) {
        return [
            // H4 Trend conditions
            h4Indicators.emaFast > h4Indicators.emaSlow, // Primary trend filter
            h4Indicators.macd?.histogram > 0, // Trend confirmation

            // H1 Setup confirmation
            h1Indicators.ema9 > h1Indicators.ema21,
            h1Indicators.rsi < 35, // Slightly relaxed RSI

            // M15 Entry conditions
            m15Indicators.isBullishCross,
            m15Indicators.rsi < 30,
            bid <= m15Indicators.bb?.lower,
        ];
    }

    generateSellConditions(h4Indicators, h1Indicators, m15Indicators, ask) {
        return [
            // H4 Trend conditions
            !h4Indicators.isBullishTrend,
            h4Indicators.macd?.histogram < 0,

            // H1 Setup confirmation
            h1Indicators.ema9 < h1Indicators.ema21,
            h1Indicators.rsi > 65,

            // M15 Entry conditions
            m15Indicators.isBearishCross,
            m15Indicators.rsi > 70,
            ask >= m15Indicators.bb?.upper,
        ];
    }

    evaluateSignals(buyConditions, sellConditions) {
        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;
        console.log(`[Signal] BuyScore: ${buyScore}/${buyConditions.length}, SellScore: ${sellScore}/${sellConditions.length}`);
        let signal = null;
        // Relaxed: only 3/6 conditions needed for a signal
        if (buyScore >= 3) {
            signal = "buy";
        } else if (sellScore >= 3) {
            signal = "sell";
        }
        return { signal, buyScore, sellScore };
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

        // if (!trendsAligned) {
        //     return { signal: null, reason: "trend_not_aligned", context: { last: m5Last, prev: m5Prev, m5Trend, m15Trend } };
        // }

        // if (m5Signal !== m5Trend) {
        //     return { signal: null, reason: "pattern_vs_trend_mismatch", context: { last: m5Last, prev: m5Prev, m5Signal, m5Trend, m15Trend } };
        // }

        const signal = m5Trend === "bullish" ? "BUY" : "SELL";

        const m15Rsi = m15.rsi;
        const m15Pb = m15.bb.pb;
        console.log(m15Rsi, m15Pb);

        const buyQualityOk = m15Rsi <= 55 && m15Pb <= 0.7;
        const sellQualityOk = m15Rsi >= 45 && m15Pb >= 0.3;

        if (signal === "BUY" && !buyQualityOk) {
            return { signal: null, reason: "blocked_m15_quality_buy", context: { m15Rsi, m15Pb } };
        }
        if (signal === "SELL" && !sellQualityOk) {
            return { signal: null, reason: "blocked_m15_quality_sell", context: { m15Rsi, m15Pb } };
        }

        return { signal, reason: "green_red_pattern", context: { last: m5Last, prev: m5Prev, m15Rsi, m15Pb } };
    }

    greenRedCandlePattern(prev, last) {
        console.log(`Prev: ${prev.close}, Last: ${prev.close}`);

        if (!prev || !last) return false;

        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        // --- Candle body strength check ---
        // const body = Math.abs(last.close - last.open);
        // const range = last.high - last.low;
        // const strong = range > 0 && body / range >= 0.3;

        // if (isBear(prev) && isBull(last) && strong) return "bullish";
        // if (isBull(prev) && isBear(last) && strong) return "bearish";

        if (isBear(prev) && isBull(last)) return "bullish";
        if (isBull(prev) && isBear(last)) return "bearish";

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
