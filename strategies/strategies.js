// strategies.js
import logger from "../utils/logger.js";
import { RISK } from "../config.js";

const {
    REQUIRED_SCORE,
    REQUIRED_PRIMARY_SCORE,
    REQUIRED_SECONDARY_SCORE,
    BUFFER_PIPS = 1,
    ATR_MULTIPLIER = 2,
    RISK_REWARD: CONFIG_RISK_REWARD,
    REWARD_RATIO: ALT_REWARD_RATIO,
} = RISK;

const TARGET_REWARD_RATIO = CONFIG_RISK_REWARD || ALT_REWARD_RATIO || 2;
const CANDLE_FIELD_MAP = {
    open: ["open", "Open", "o", "O"],
    high: ["high", "High", "h", "H"],
    low: ["low", "Low", "l", "L"],
    close: ["close", "Close", "c", "C"],
};

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function getCandleValue(candle, field) {
    if (!candle) return null;
    const keys = CANDLE_FIELD_MAP[field] || [field];
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(candle, key)) {
            const num = toNumber(candle[key]);
            if (num != null) return num;
        }
    }
    return null;
}

function getCandleBody(candle) {
    const open = getCandleValue(candle, "open");
    const close = getCandleValue(candle, "close");
    if (open == null || close == null) return null;
    return Math.abs(close - open);
}

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

    getSignal = ({ symbol, indicators = {}, candles = {}, bid, ask }) => {
        try {
            const { m5, m15, h1 } = indicators;

            if (!m5 || !m15 || !h1) {
                return { signal: null, reason: "missing_indicators" };
            }

            const pip = symbol.includes("JPY") ? 0.01 : 0.0001;
            const buffer = BUFFER_PIPS * pip;

            const history = Array.isArray(candles?.m5Candles) ? candles.m5Candles : Array.isArray(candles?.M5) ? candles.M5 : [];
            if (history.length < 3) {
                return { signal: null, reason: "insufficient_m5_history" };
            }

            const prev = history[history.length - 3];
            const last = history[history.length - 2];

            if (!prev || !last) return { signal: null, reason: "no_candle_data" };

            const prevLow = getCandleValue(prev, "low");
            const prevHigh = getCandleValue(prev, "high");
            const lastLow = getCandleValue(last, "low");
            const lastHigh = getCandleValue(last, "high");
            const lastClose = getCandleValue(last, "close");
            const lastOpen = getCandleValue(last, "open");
            const prevClose = getCandleValue(prev, "close");

            if ([prevLow, prevHigh, lastLow, lastHigh, lastClose, lastOpen].some((v) => v == null)) {
                return { signal: null, reason: "invalid_candle_values" };
            }

            const body = getCandleBody(last);
            if (body == null || body < pip * 3) {
                return { signal: null, reason: "weak_candle_body" };
            }

            const h1Trend = this.resolveTrend(h1);
            const m15Trend = this.resolveTrend(m15);
            const m5Trend = this.resolveTrend(m5);

            const bullishAligned = [h1Trend, m15Trend, m5Trend].every((trend) => trend === "bullish");
            const bearishAligned = [h1Trend, m15Trend, m5Trend].every((trend) => trend === "bearish");

            const pattern = this.greenRedCandlePattern(m5Trend, prev, last) || this.engulfingPattern(prev, last) || this.pinBarPattern(last);
            if (!pattern) {
                return { signal: null, reason: "no_valid_pattern" };
            }

            const atr = typeof m5?.atr === "number" ? m5.atr : typeof m15?.atr === "number" ? m15.atr : null;

            const evaluateDirection = (direction) => {
                const isBuy = direction === "BUY";
                const patternMatches = (pattern === "bullish" && isBuy) || (pattern === "bearish" && !isBuy);
                if (!patternMatches) return null;

                const alignedTrend = isBuy ? bullishAligned : bearishAligned;
                const entryPrice = isBuy ? toNumber(ask) ?? lastClose : toNumber(bid) ?? lastClose;
                if (entryPrice == null) return null;

                const swingLow = Math.min(prevLow, lastLow);
                const swingHigh = Math.max(prevHigh, lastHigh);
                let rawStop = isBuy ? swingLow - buffer : swingHigh + buffer;

                if (isBuy && rawStop >= entryPrice) rawStop = entryPrice - buffer;
                if (!isBuy && rawStop <= entryPrice) rawStop = entryPrice + buffer;

                const slDistance = Math.abs(entryPrice - rawStop);
                const minSlDistance = pip * 4;
                const maxSlDistance = atr != null ? atr * ATR_MULTIPLIER : null;
                const slValid = slDistance >= minSlDistance && (!maxSlDistance || slDistance <= maxSlDistance);

                const rewardDistance = slDistance * TARGET_REWARD_RATIO;
                const tpValid = rewardDistance >= pip * 6;

                const m5Adx = m5?.adx?.adx ?? 0;
                const m15Adx = m15?.adx?.adx ?? 0;
                const h1Adx = h1?.adx?.adx ?? 0;
                const momentum = m5Adx >= 23 || m15Adx >= 20 || h1Adx >= 20;

                const m5Rsi = m5?.rsi;
                const h1Rsi = h1?.rsi;
                const rsiValid = isBuy
                    ? (m5Rsi == null || (m5Rsi >= 40 && m5Rsi <= 62)) && (h1Rsi == null || h1Rsi <= 65)
                    : (m5Rsi == null || (m5Rsi >= 38 && m5Rsi <= 60)) && (h1Rsi == null || h1Rsi >= 35);

                const prevBody = getCandleBody(prev);
                const bodyStrength = prevBody == null ? true : body >= prevBody * 0.8;
                const breakout = isBuy ? lastClose > Math.max(prevHigh, prevClose ?? prevHigh) : lastClose < Math.min(prevLow, prevClose ?? prevLow);

                const secondaryConditions = [
                    { name: "momentum", weight: 1, passed: momentum },
                    { name: "rsi_filter", weight: 1, passed: rsiValid },
                    { name: "body_strength", weight: 1, passed: bodyStrength },
                    { name: "breakout", weight: 1, passed: breakout },
                    { name: "atr_reasonable", weight: 1, passed: !maxSlDistance || slDistance <= maxSlDistance },
                    { name: "tp_distance", weight: 1, passed: tpValid },
                ];

                const primaryConditions = [
                    { name: "trend_alignment", weight: 2, passed: alignedTrend },
                    { name: "pattern_confirmed", weight: 2, passed: patternMatches },
                    { name: "sl_distance", weight: 2, passed: slValid },
                ];

                const allConditions = [...primaryConditions, ...secondaryConditions];
                const score = allConditions.reduce((sum, cond) => (cond.passed ? sum + cond.weight : sum), 0);
                const primaryCount = primaryConditions.filter((c) => c.passed).length;
                const secondaryCount = secondaryConditions.filter((c) => c.passed).length;

                const qualifies =
                    alignedTrend &&
                    patternMatches &&
                    slValid &&
                    score >= REQUIRED_SCORE &&
                    primaryCount >= REQUIRED_PRIMARY_SCORE &&
                    secondaryCount >= REQUIRED_SECONDARY_SCORE;

                const breakdown = allConditions.map(({ name, weight, passed }) => ({ name, weight, passed }));

                if (!qualifies) {
                    const fail = allConditions.find((c) => !c.passed);
                    const reason = fail ? `failed_${fail.name}` : "score_threshold";
                    logger.debug(`[Strategy] ${symbol} ${direction} rejected | score=${score} | reason=${reason}`);
                    return {
                        direction,
                        qualifies: false,
                        score,
                        reason,
                        breakdown,
                    };
                }

                logger.info(`[Strategy] ${symbol} ${direction} confirmed | score=${score} primary=${primaryCount} secondary=${secondaryCount}`);

                return {
                    direction,
                    qualifies: true,
                    score,
                    result: {
                        signal: direction,
                        reason: "confluence_setup",
                        score,
                        breakdown,
                        context: {
                            prev,
                            last,
                            entryPrice,
                            stopLossPrice: rawStop,
                            slDistance,
                            rewardDistance,
                            atr,
                            swingHigh,
                            swingLow,
                        },
                    },
                };
            };

            const evaluations = ["BUY", "SELL"].map(evaluateDirection).filter(Boolean);
            if (!evaluations.length) {
                return { signal: null, reason: "pattern_not_confirmed" };
            }

            const qualified = evaluations.filter((e) => e.qualifies).sort((a, b) => b.score - a.score);
            if (qualified.length) {
                return qualified[0].result;
            }

            const bestAttempt = evaluations.sort((a, b) => b.score - a.score)[0];
            return {
                signal: null,
                reason: bestAttempt?.reason || "conditions_not_met",
                score: bestAttempt?.score || 0,
                breakdown: bestAttempt?.breakdown,
            };
        } catch (error) {
            logger.warn(`[Strategy] ${symbol}: signal generation failed: ${error?.message || error}`);
            return { signal: null, reason: "strategy_error" };
        }
    };

    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last || !trend) return false;

        const prevOpen = getCandleValue(prev, "open");
        const prevClose = getCandleValue(prev, "close");
        const lastOpen = getCandleValue(last, "open");
        const lastClose = getCandleValue(last, "close");

        if ([prevOpen, prevClose, lastOpen, lastClose].some((v) => v == null)) return false;

        const isBullish = (open, close) => close > open;
        const isBearish = (open, close) => close < open;

        const trendDirection = String(trend).toLowerCase();

        if (trendDirection === "bullish" && isBearish(prevOpen, prevClose) && isBullish(lastOpen, lastClose)) return "bullish";
        if (trendDirection === "bearish" && isBullish(prevOpen, prevClose) && isBearish(lastOpen, lastClose)) return "bearish";

        return false;
    }

    engulfingPattern(prev, last) {
        if (!prev || !last) return null;

        const prevOpen = getCandleValue(prev, "open");
        const prevClose = getCandleValue(prev, "close");

        const lastOpen = getCandleValue(last, "open");
        const lastClose = getCandleValue(last, "close");

        if ([prevOpen, prevClose, lastOpen, lastClose].some((v) => v == null)) return null;

        // Bullish engulfing
        if (lastClose > lastOpen && prevClose < prevOpen && lastClose > prevOpen && lastOpen < prevClose) return "bullish";

        // Bearish engulfing
        if (lastClose < lastOpen && prevClose > prevOpen && lastClose < prevOpen && lastOpen > prevClose) return "bearish";

        return null;
    }

    pinBarPattern(last) {
        if (!last) return null;
        const open = getCandleValue(last, "open");
        const close = getCandleValue(last, "close");
        const high = getCandleValue(last, "high");
        const low = getCandleValue(last, "low");

        if ([open, close, high, low].some((v) => v == null)) return null;

        const body = Math.abs(close - open);
        const upperWick = high - Math.max(open, close);
        const lowerWick = Math.min(open, close) - low;

        // Bullish pin bar: long lower wick (≥2× body)
        if (lowerWick > body * 2) return "bullish";

        // Bearish pin bar: long upper wick (≥2× body)
        if (upperWick > body * 2) return "bearish";

        return null;
    }

    resolveTrend(indicator) {
        if (!indicator) return "neutral";

        const fastCandidates = [indicator.ema20, indicator.emaFastTrend, indicator.emaFast, indicator.ema9, indicator.ema5];
        const slowCandidates = [indicator.ema50, indicator.emaSlowTrend, indicator.emaSlow, indicator.ema21, indicator.ema10];

        const fast = fastCandidates.find((val) => typeof val === "number");
        const slow = slowCandidates.find((val) => typeof val === "number");

        if (fast != null && slow != null) {
            if (fast > slow) return "bullish";
            if (fast < slow) return "bearish";
            return "neutral";
        }

        if (typeof indicator.trend === "string") return indicator.trend.toLowerCase();

        return "neutral";
    }
}

export default new Strategy();
