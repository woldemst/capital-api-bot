// strategies.js
import logger from "../utils/logger.js";
import { RISK, ANALYSIS } from "../config.js";

const { RSI } = ANALYSIS;

const { REQUIRED_SCORE } = RISK;

class Strategy {
    constructor() {}

    // getSignal({ symbol, indicators, candles, bid, ask }) {
    //     const { m1, m5, m15, h1, h4 } = indicators;
    //     const { m15Candles } = candles;

    //     try {
    //         let h1Trend = h1.emaFast > h1.emaSlow ? "bullish" : h1.emaFast < h1.emaSlow ? "bearish" : "neutral";

    //         const prev = m15Candles[m15Candles.length - 3]; // previous closed
    //         const last = m15Candles[m15Candles.length - 2]; // most recent closed

    //         const pattern = this.greenRedCandlePattern(h1Trend, prev, last) || this.engulfingPattern(prev, last) || this.pinBarPattern(last);

    //         // if (!pattern) return { signal: null, reason: "no_valid_pattern" };

    //         let buyConditions = [];
    //         let sellConditions = [];

    //         switch (symbol) {
    //             case "EURUcSD": {
    //                 buyConditions = [
    //                     { name: "Pattern Bullish", value: pattern === "bullish" || pattern === "BUY", weight: 2 },
    //                     { name: "H1 EMA Fast > Slow", value: h1.emaFast > h1.emaSlow, weight: 2 },
    //                     { name: "M5 EMA20 > EMA50", value: m5.ema20 > m5.ema50, weight: 2 },
    //                     { name: "RSI 45–65", value: m5.rsi > 45 && m5.rsi < 65, weight: 1 },
    //                     { name: "ADX > 20", value: m5.adx?.adx > 20, weight: 1 },
    //                     { name: "BB Lower Zone", value: m5.bb?.pb < 0.3, weight: 1 },
    //                     { name: "ATR > 0.0004", value: m5.atr > 0.0004, weight: 1 },
    //                 ];

    //                 sellConditions = [
    //                     { name: "Pattern Bearish", value: pattern === "bearish" || pattern === "SELL", weight: 2 },
    //                     { name: "H1 EMA Fast < Slow", value: h1.emaFast < h1.emaSlow, weight: 2 },
    //                     { name: "M5 EMA20 < EMA50", value: m5.ema20 < m5.ema50, weight: 2 },
    //                     { name: "RSI 35–55", value: m5.rsi < 55 && m5.rsi > 35, weight: 1 },
    //                     { name: "ADX > 20", value: m5.adx?.adx > 20, weight: 1 },
    //                     { name: "BB Upper Zone", value: m5.bb?.pb > 0.7, weight: 1 },
    //                     { name: "ATR > 0.0004", value: m5.atr > 0.0004, weight: 1 },
    //                 ];
    //                 break;
    //             }
    //             // case "AUDUSD": {
    //             //     buyConditions = [
    //             //         { name: "Pattern Bullish", value: pattern === "bullish" || pattern === "BUY", weight: 2 },
    //             //         { name: "H1 EMA Fast > Slow", value: h1.emaFast > h1.emaSlow, weight: 2 },
    //             //         { name: "M5 EMA20 > EMA50", value: m5.ema20 > m5.ema50, weight: 2 },
    //             //         { name: "RSI 38–55", value: m5.rsi > 38 && m5.rsi < 55, weight: 1 },
    //             //         { name: "ADX > 20", value: m5.adx?.adx > 20, weight: 1 },
    //             //         { name: "BB Lower Zone", value: m5.bb?.pb < 0.3, weight: 1 },
    //             //         { name: "ATR > 0.0004", value: m5.atr > 0.0004, weight: 1 },
    //             //     ];

    //             //     sellConditions = [
    //             //         { name: "Pattern Bearish", value: pattern === "bearish" || pattern === "SELL", weight: 2 },
    //             //         { name: "H1 EMA Fast < Slow", value: h1.emaFast < h1.emaSlow, weight: 2 },
    //             //         { name: "M5 EMA20 < EMA50", value: m5.ema20 < m5.ema50, weight: 2 },
    //             //         { name: "RSI 45–65", value: m5.rsi > 45 && m5.rsi < 65, weight: 1 },
    //             //         { name: "ADX > 20", value: m5.adx?.adx > 20, weight: 1 },
    //             //         { name: "BB Upper Zone", value: m5.bb?.pb > 0.7, weight: 1 },
    //             //         { name: "ATR > 0.0004", value: m5.atr > 0.0004, weight: 1 },
    //             //     ];

    //             //     break;
    //             // }

    //             // case "EURJPY": {
    //             //     const adx = m5.adx?.adx || 0;
    //             //     const atr = m5.atr || 0;
    //             //     const pb = m5.bb?.pb ?? null;

    //             //     buyConditions = [
    //             //         { name: "Pattern Bullish", value: pattern === "bullish" || pattern === "BUY", weight: 2 },
    //             //         { name: "H1 EMA Fast > Slow", value: h1.emaFast > h1.emaSlow, weight: 2 },
    //             //         { name: "M5 EMA20 > EMA50", value: m5.ema20 > m5.ema50, weight: 2 },
    //             //         { name: "ADX > 20", value: adx > 20, weight: 1 },
    //             //         { name: "ATR < 0.12", value: atr < 0.12, weight: 1 },
    //             //         { name: "BB not extreme", value: pb !== null && pb < 1.2, weight: 1 },
    //             //     ];

    //             //     sellConditions = [
    //             //         { name: "Pattern Bearish", value: pattern === "bearish" || pattern === "SELL", weight: 2 },
    //             //         { name: "H1 EMA Fast < Slow", value: h1.emaFast < h1.emaSlow, weight: 2 },
    //             //         { name: "M5 EMA20 < EMA50", value: m5.ema20 < m5.ema50, weight: 2 },
    //             //         { name: "ADX > 20", value: adx > 20, weight: 1 },
    //             //         { name: "ATR < 0.12", value: atr < 0.12, weight: 1 },
    //             //         { name: "BB not extreme", value: pb !== null && pb < 1.2, weight: 1 },
    //             //     ];

    //             //     break;
    //             // }

    //             // case "GBPJPY": {
    //             //     const adx = m5.adx?.adx || 0;
    //             //     const atr = m5.atr || 0;
    //             //     const pb = m5.bb?.pb ?? null;

    //             //     buyConditions = [
    //             //         { name: "Pattern Bullish", value: pattern === "bullish" || pattern === "BUY", weight: 2 },
    //             //         { name: "H1 EMA Fast > Slow", value: h1.emaFast > h1.emaSlow, weight: 2 },
    //             //         { name: "M5 EMA20 > EMA50", value: m5.ema20 > m5.ema50, weight: 2 },
    //             //         { name: "RSI 40–55", value: m5.rsi > 40 && m5.rsi < 55, weight: 1 },
    //             //         { name: "ADX > 20", value: adx > 20, weight: 1 },
    //             //         { name: "BB Lower Zone", value: pb !== null && pb < 0.35, weight: 1 },
    //             //         { name: "ATR 0.10–0.25", value: atr >= 0.1 && atr <= 0.25, weight: 1 },
    //             //     ];

    //             //     sellConditions = [
    //             //         { name: "Pattern Bearish", value: pattern === "bearish" || pattern === "SELL", weight: 2 },
    //             //         { name: "H1 EMA Fast < Slow", value: h1.emaFast < h1.emaSlow, weight: 2 },
    //             //         { name: "M5 EMA20 < EMA50", value: m5.ema20 < m5.ema50, weight: 2 },
    //             //         { name: "RSI 50–65", value: m5.rsi > 50 && m5.rsi < 65, weight: 1 },
    //             //         { name: "ADX > 20", value: adx > 20, weight: 1 },
    //             //         { name: "BB Upper Zone", value: pb !== null && pb > 0.65, weight: 1 },
    //             //         { name: "ATR 0.10–0.25", value: atr >= 0.1 && atr <= 0.25, weight: 1 },
    //             //     ];

    //             //     break;
    //             // }

    //             default: {
    //                 // Default logic for other pairs
    //                 // buyConditions = [
    //                 //     { name: "H4 EMA Fast > Slow", value: h4.emaFast > h4.emaSlow, weight: 2 },
    //                 //     { name: "H4 MACD Histogram > 0", value: h4.macd?.histogram > 0, weight: 2 },
    //                 //     { name: "H1 EMA9 > EMA21", value: h1.ema9 > h1.ema21, weight: 2 },
    //                 //     { name: "H1 RSI < 35", value: h1.rsi < RSI.EXIT_OVERSOLD, weight: 2 },
    //                 //     { name: "M15 Bullish Cross", value: m15.isBullishCross, weight: 1 },
    //                 //     { name: "M15 RSI < 30", value: m15.rsi < RSI.OVERSOLD, weight: 1 },
    //                 //     { name: "Price at BB Lower", value: bid <= m15.bb?.lower, weight: 1 },
    //                 // ];

    //                 // sellConditions = [
    //                 //     { name: "H4 Bearish Trend", value: !h4.isBullishTrend, weight: 2 },
    //                 //     { name: "H4 MACD Histogram < 0", value: h4.macd?.histogram < 0, weight: 2 },
    //                 //     { name: "H1 EMA9 < EMA21", value: h1.ema9 < h1.ema21, weight: 2 },
    //                 //     { name: "H1 RSI > 65", value: h1.rsi > RSI.EXIT_OVERBOUGHT, weight: 2 },
    //                 //     { name: "M15 Bearish Cross", value: m15.isBearishCross, weight: 1 },
    //                 //     { name: "M15 RSI > 70", value: m15.rsi > RSI.OVERBOUGHT, weight: 1 },
    //                 //     { name: "Price at BB Upper", value: ask >= m15.bb?.upper, weight: 1 },
    //                 // ];

    //                 buyConditions = [
    //                     h1Trend === "bullish",
    //                     h1.emaFast != null && h1.emaSlow != null ? h1.emaFast > h1.emaSlow : true,
    //                     h1.ema9 != null ? lastClose > h1.ema9 : true,
    //                     m15.macd.histogram != null ? m15.macd.histogram > 0 : true,
    //                 ];

    //                 sellConditions = [
    //                     h1Trend === "bearish",
    //                     h1.emaFast != null && h1.emaSlow != null ? h1.emaFast < h1.emaSlow : true,
    //                     h1.ema9 != null ? lastClose < h1.ema9 : true,
    //                     m15.macd.histogram != null ? m15.macd.histogram < 0 : true,
    //                 ];
    //                 break;
    //             }
    //         }

    //         // const buyScore = buyConditions.filter((c) => c.value).length;
    //         // const sellScore = sellConditions.filter((c) => c.value).length;

    //         const buyScore = buyConditions.filter(Boolean).length;
    //         const sellScore = sellConditions.filter(Boolean).length;

    //         logger.info(`[${symbol}] BuyScore: ${buyScore}, SellScore: ${sellScore}`);

    //         let signal = null;
    //         // if (pattern === "bullish" || ("BUY" && buyScore >= REQUIRED_SCORE)) signal = "BUY";
    //         // if (pattern === "bearish" || ("SELL" && sellScore >= REQUIRED_SCORE)) signal = "SELL";

    //         if (buyScore >= REQUIRED_SCORE) {
    //             return { signal: "BUY", reason: "confirmed", buyScore, sellScore };
    //         }

    //         if (sellScore >= REQUIRED_SCORE) {
    //             return { signal: "SELL", reason: "confirmed", buyScore, sellScore };
    //         }

    //         if (!signal) {
    //             return { signal: null, reason: "score_too_low", buyScore, sellScore };
    //         }
    //         if (m15.adx && m15.adx < 20) {
    //             logger.info(`[Signal] ${symbol}: Market is ranging, skipping trend-following signal.`);
    //             return { signal: null, reason: "ranging_market" };
    //         }
    //         if (m15.atr && m15.atr < 0.0005) {
    //             // adjust threshold for your market
    //             logger.info(`[Signal] ${symbol}: ATR too low, skipping signal.`);
    //             return { signal: null, reason: "low_volatility" };
    //         }

    //         logger.info(`[Signal Analysis] ${symbol}
    //             H1 Trend: ${h1Trend}
    //             Pattern: ${pattern}
    //             BuyScore: ${buyScore}/${buyConditions.length}
    //             SellScore: ${sellScore}/${sellConditions.length}
    //             M15 RSI: ${m15.rsi}
    //             M15 MACD hist: ${m15.macd?.histogram}
    //             M15 ADX: ${m15.adx}
    //         `);

    //         return { signal: null, reason: "conditions_not_met", buyScore, sellScore };
    //     } catch (e) {
    //         logger.warn(`${symbol}: Signal check failed: ${e?.message || e}`);
    //         return { signal: null, reason: "error" };
    //     }
    // }

    getSignal = ({ symbol, indicators, candles }) => {
        const { m1, m5, m15, h1 } = indicators;

        // --- Multi-timeframe trends ---
        // const h1Trend =
        //     h1 && h1.ema20 != null && h1.ema50 != null ? (h1.ema20 > h1.ema50 ? "bullish" : h1.ema20 < h1.ema50 ? "bearish" : "neutral") : "neutral";
        // const m15Trend = m15.ema20 > m15.ema50 ? "bullish" : m15.ema20 < m15.ema50 ? "bearish" : "neutral";
        const m5Trend = m5.ema20 > m5.ema50 ? "bullish" : m5.ema20 < m5.ema50 ? "bearish" : "neutral";
        const m1Trend = m1.ema20 > m1.ema50 ? "bullish" : m1.ema20 < m1.ema50 ? "bearish" : "neutral";

        // --- Check alignment between higher timeframes ---
        const alignedTrend = m5Trend === m1Trend && (m5Trend === "bullish" || m5Trend === "bearish");
        if (!alignedTrend) return { signal: null, reason: "trend_not_aligned" };

        // --- Candle data ---
        const prev = candles.m1Candles[candles.m1Candles.length - 3];
        const last = candles.m1Candles[candles.m1Candles.length - 2];
        if (!prev || !last) return { signal: null, reason: "no_candle_data" };

        // --- Pattern recognition based on M1 trend ---
        // const pattern = this.greenRedCandlePattern(m1Trend, prev, last);
        const pattern = this.greenRedCandlePattern(m1Trend, prev, last) || this.engulfingPattern(prev, last) || this.pinBarPattern(last);

        // --- Candle body strength check ---
        // const body = Math.abs(last.close - last.open);
        // const avgBody = Math.abs(prev.close - prev.open);
        // if (body < avgBody * 0.8) return { signal: null, reason: "weak_candle" };

        // --- Combine all signals ---
        if (pattern === "bullish" && alignedTrend)
            return {
                signal: "BUY",
                reason: "pattern_trend_alignment",
                context: { prev, last },
            };

        if (pattern === "bearish" && alignedTrend)
            return {
                signal: "SELL",
                reason: "pattern_trend_alignment",
                context: { prev, last },
            };

        return {
            signal: null,
            reason: "no_signal",
        };
    };

    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last || !trend) return false;
        const getOpen = (c) => c.open;
        const getClose = (c) => c.close;

        if (getOpen(prev) == null || getClose(prev) == null || getOpen(last) == null || getClose(last) == null) return false;

        const isBullish = (c) => getClose(c) > getOpen(c);
        const isBearish = (c) => getClose(c) < getOpen(c);

        const trendDirection = String(trend).toLowerCase();

        if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) return "bullish";
        if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) return "bearish";

        return false;
    }

    engulfingPattern(prev, last) {
        const getOpen = (c) => c.open;
        const getClose = (c) => c.close;

        if (!prev || !last) return null;

        const prevOpen = getOpen(prev);
        const prevClose = getClose(prev);

        const lastOpen = getOpen(last);
        const lastClose = getClose(last);

        // Bullish engulfing
        if (lastClose > lastOpen && prevClose < prevOpen && lastClose > prevOpen && lastOpen < prevClose) return "bullish";

        // Bearish engulfing
        if (lastClose < lastOpen && prevClose > prevOpen && lastClose < prevOpen && lastOpen > prevClose) return "bearish";

        return null;
    }

    pinBarPattern(last) {
        if (!last) return null;
        const open = last.open;
        const close = last.close;
        const high = last.high;
        const low = last.low;

        const body = Math.abs(close - open);
        const upperWick = high - Math.max(open, close);
        const lowerWick = Math.min(open, close) - low;

        // Bullish pin bar: long lower wick (≥2× body)
        if (lowerWick > body * 2) return "bullish";

        // Bearish pin bar: long upper wick (≥2× body)
        if (upperWick > body * 2) return "bearish";

        return null;
    }
}

export default new Strategy();
