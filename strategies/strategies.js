// strategies.js
import logger from "../utils/logger.js";
import { RISK, SESSIONS } from "../config.js";

const { REQUIRED_PRIMARY_SCORE, REQUIRED_SECONDARY_SCORE } = RISK;

class Strategy {
    constructor() {}

    getSignal({ symbol, indicators, candles, trendAnalysis }) {
        if (!symbol || !candles || !indicators) return { signal: null, reason: "missing_data" };
        const { m15Candles } = candles;
        const { m1, m5, m15, h1 } = indicators;

        try {
            // --- 1) Determine H1 trend (EMA fast vs slow or isBullishTrend if provided) ---
            let h1Trend = "neutral";
            if (typeof h1.emaFast === "number" && typeof h1.emaSlow === "number") {
                h1Trend = h1.emaFast > h1.emaSlow ? "bullish" : "bearish";
            } else if (trendAnalysis && typeof trendAnalysis.h1Trend === "string") {
                h1Trend = trendAnalysis.h1Trend.toLowerCase();
            }

            // --- 2) Take the last two CLOSED M15 candles: prev = second last, last = last closed ---
            if (m15Candles.length < 3) {
                return { signal: null, reason: "not_enough_m15_candles" };
            }
            const prev = m15Candles[m15Candles.length - 3]; // previous closed
            const last = m15Candles[m15Candles.length - 2]; // most recent closed

            // const patternDir = this.greenRedCandlePattern(h1Trend, prev, last) || this.engulfingPattern(prev, last) || this.pinBarPattern(last);
            // if (!patternDir) return { signal: null, reason: "price_action_pattern_failed" };

            const patternDir = this.greenRedCandlePattern(h1Trend, prev, last) || this.engulfingPattern(prev, last) || this.pinBarPattern(last);
            // const patternDir = this.greenRedCandlePattern(h1Trend, prev, last);
            if (!patternDir) {
                logger.info(`[Signal Analysis] ${symbol}: No valid M15 pattern for H1 trend (${h1Trend}).`);
                return { signal: null, reason: "no_valid_pattern" };
            }
            // --- 3) Indicator confirmation (simple, fast to compute) ---
            const getClose = (c) => (typeof c.c !== "undefined" ? c.c : c.close);

            // Use M15 RSI/MACD/ADX + H1 EMAs & EMA9 for momentum
            const rsi15 = typeof m15.rsi === "number" ? m15.rsi : null;
            const macd15 = m15.macd || null;
            const macd15Hist = macd15 && typeof macd15.histogram === "number" ? macd15.histogram : null;
            const adx15 = typeof m15.adx === "number" ? m15.adx : null;
            const atr15 = typeof m15.atr === "number" ? m15.atr : null;
            const baseRSI = 50;
            const baseADX = 20;
            const adaptiveRSI = atr15 ? baseRSI + Math.min(10, atr15 * 100) : baseRSI;
            const adaptiveADX = atr15 ? baseADX + Math.min(10, atr15 * 10) : baseADX;

            const ema9h1 = typeof h1.ema9 === "number" ? h1.ema9 : null;
            const ema21h1 = typeof h1.ema21 === "number" ? h1.ema21 : null;
            const emaFastH1 = typeof h1.emaFast === "number" ? h1.emaFast : null;
            const emaSlowH1 = typeof h1.emaSlow === "number" ? h1.emaSlow : null;

            const lastClose = getClose(last);

            // Build conditions explicitly
            const buyConditions = [
                h1Trend === "bullish",
                emaFastH1 != null && emaSlowH1 != null ? emaFastH1 > emaSlowH1 : true,
                ema9h1 != null ? lastClose > ema9h1 : true,
                rsi15 != null ? rsi15 > adaptiveRSI : true,
                macd15Hist != null ? macd15Hist > 0 : true,
                adx15 != null ? adx15 > adaptiveADX : true,
            ];

            const sellConditions = [
                h1Trend === "bearish",
                emaFastH1 != null && emaSlowH1 != null ? emaFastH1 < emaSlowH1 : true,
                ema9h1 != null ? lastClose < ema9h1 : true,
                rsi15 != null ? rsi15 < 100 - adaptiveRSI : true,
                macd15Hist != null ? macd15Hist < 0 : true,
                adx15 != null ? adx15 > adaptiveADX : true,
            ];

            const buyScore = buyConditions.filter(Boolean).length;
            const sellScore = sellConditions.filter(Boolean).length;

            // Decide signal
            const threshold = typeof REQUIRED_SCORE === "number" && REQUIRED_SCORE > 0 ? REQUIRED_SCORE : 3;
            let signal = null;
            if (patternDir === "bullish" && buyScore >= threshold) signal = "BUY";
            if (patternDir === "bearish" && sellScore >= threshold) signal = "SELL";

            logger.info(`[Signal Analysis] ${symbol}
                H1 Trend: ${h1Trend}
                Pattern: ${patternDir}
                BuyScore: ${buyScore}/${buyConditions.length}
                SellScore: ${sellScore}/${sellConditions.length}
                M15 RSI: ${rsi15}
                M15 MACD hist: ${macd15Hist}
                M15 ADX: ${adx15}
            `);

            if (!signal) {
                return { signal: null, reason: "score_too_low", buyScore, sellScore };
            }
            if (adx15 && adx15 < 20) {
                logger.info(`[Signal] ${symbol}: Market is ranging, skipping trend-following signal.`);
                return { signal: null, reason: "ranging_market" };
            }
            if (atr15 && atr15 < 0.0005) {
                // adjust threshold for your market
                logger.info(`[Signal] ${symbol}: ATR too low, skipping signal.`);
                return { signal: null, reason: "low_volatility" };
            }

            return {
                signal,
                reason: "all_filters_passed",
                metrics: {
                    rsi15: rsi15,
                    macd15Hist,
                    ema9h1,
                    ema21h1,
                    emaFastH1,
                    emaSlowH1,
                    adx15,
                },
                context: {
                    prevHigh: prev.high,
                    prevLow: prev.low,
                    prevOpen: prev.open,
                    prevClose: prev.close,
                },
            };
        } catch (e) {
            logger.warn(`${symbol}: Signal check failed: ${e?.message || e}`);
            return { signal: null, reason: "error" };
        }
    }

    legacyMultiTfStrategy({ indicators, bid, ask }) {
        const RSI_CONFIG = {
            OVERBOUGHT: 70,
            OVERSOLD: 30,
            EXIT_OVERBOUGHT: 65,
            EXIT_OVERSOLD: 35,
        };

        const h4 = indicators.h4;
        const h1 = indicators.h1;
        const m15 = indicators.m15;

        // --- Buy conditions with logging ---
        const buyConditions = [
            // PRIMARY (must have 2/3)
            { name: "H4 EMA Fast > Slow", value: h4.emaFast > h4.emaSlow, weight: 2 },
            { name: "H4 MACD Histogram > 0", value: h4.macd?.histogram > 0, weight: 2 },
            { name: "H1 EMA9 > EMA21", value: h1.ema9 > h1.ema21, weight: 2 },

            // SECONDARY (need 2/4)
            { name: "H1 RSI < 35", value: h1.rsi < RSI_CONFIG.EXIT_OVERSOLD, weight: 1 },
            { name: "M15 Bullish Cross", value: m15.isBullishCross, weight: 1 },
            { name: "M15 RSI < 30", value: m15.rsi < RSI_CONFIG.OVERSOLD, weight: 1 },
            { name: "Price at BB Lower", value: bid <= m15.bb?.lower, weight: 1 },
        ];

        // --- Sell conditions with logging ---
        const sellConditions = [
            // PRIMARY (must have 2/3)
            { name: "H4 Bearish Trend", value: !h4.isBullishTrend, weight: 2 },
            { name: "H4 MACD Histogram < 0", value: h4.macd?.histogram < 0, weight: 2 },
            { name: "H1 EMA9 < EMA21", value: h1.ema9 < h1.ema21, weight: 2 },

            // SECONDARY (need 2/4)
            { name: "H1 RSI > 65", value: h1.rsi > RSI_CONFIG.EXIT_OVERBOUGHT, weight: 1 },
            { name: "M15 Bearish Cross", value: m15.isBearishCross, weight: 1 },
            { name: "M15 RSI > 70", value: m15.rsi > RSI_CONFIG.OVERBOUGHT, weight: 1 },
            { name: "Price at BB Upper", value: ask >= m15.bb?.upper, weight: 1 },
        ];

        // Calculate scores first
        const buyScore = buyConditions.reduce((score, condition) => score + (condition.value ? condition.weight : 0), 0);
        const sellScore = sellConditions.reduce((score, condition) => score + (condition.value ? condition.weight : 0), 0);

        logger.info("\n🔍 ANALYSIS SUMMARY");
        logger.info("═══════════════════");

        // BUY Signal Analysis
        logger.info("\n🔵 BUY CONDITIONS");
        logger.info("---------------");
        logger.info("Main Trend (need 2/3):");
        logger.info(`${h4.emaFast > h4.emaSlow ? "✅" : "❌"} H4 EMA Fast (${h4.emaFast?.toFixed(5)}) > Slow (${h4.emaSlow?.toFixed(5)})`);
        logger.info(`${h4.macd?.histogram > 0 ? "✅" : "❌"} H4 MACD (${h4.macd?.histogram?.toFixed(5)})`);
        logger.info(`${h1.ema9 > h1.ema21 ? "✅" : "❌"} H1 EMA Cross: 9(${h1.ema9?.toFixed(5)}) vs 21(${h1.ema21?.toFixed(5)})`);

        logger.info("\nEntry Filters (need any 2):");
        logger.info(`${h1.rsi < 35 ? "✅" : "❌"} H1 RSI: ${h1.rsi?.toFixed(1)} < 35`);
        logger.info(`${m15.isBullishCross ? "✅" : "❌"} M15 Bullish Cross`);
        logger.info(`${m15.rsi < 30 ? "✅" : "❌"} M15 RSI: ${m15.rsi?.toFixed(1)} < 30`);
        logger.info(`${bid <= m15.bb?.lower ? "✅" : "❌"} Price at BB: ${bid} <= ${m15.bb?.lower?.toFixed(5)}`);

        // SELL Signal Analysis
        logger.info("\n🔴 SELL CONDITIONS");
        logger.info("----------------");
        logger.info(`Main Trend (need ${REQUIRED_PRIMARY_SCORE}/3):`);
        logger.info(`${!h4.isBullishTrend ? "✅" : "❌"} H4 Bearish Trend`);
        logger.info(`${h4.macd?.histogram < 0 ? "✅" : "❌"} H4 MACD (${h4.macd?.histogram?.toFixed(5)})`);
        logger.info(`${h1.ema9 < h1.ema21 ? "✅" : "❌"} H1 EMA Cross: 9(${h1.ema9?.toFixed(5)}) vs 21(${h1.ema21?.toFixed(5)})`);

        logger.info(`\nEntry Filters (need any ${REQUIRED_SECONDARY_SCORE}):`);
        logger.info(`${h1.rsi > 65 ? "✅" : "❌"} H1 RSI: ${h1.rsi?.toFixed(1)} > 65`);
        logger.info(`${m15.isBearishCross ? "✅" : "❌"} M15 Bearish Cross`);
        logger.info(`${m15.rsi > 70 ? "✅" : "❌"} M15 RSI: ${m15.rsi?.toFixed(1)} > 70`);
        logger.info(`${ask >= m15.bb?.upper ? "✅" : "❌"} Price at BB: ${ask} >= ${m15.bb?.upper?.toFixed(5)}`);

        // Score calculation
        const primaryBuyScore = buyConditions.slice(0, 3).filter((c) => c.value).length;
        const secondaryBuyScore = buyConditions.slice(3).filter((c) => c.value).length;
        const primarySellScore = sellConditions.slice(0, 3).filter((c) => c.value).length;
        const secondarySellScore = sellConditions.slice(3).filter((c) => c.value).length;

        // Final Decision
        logger.info("\n📊 FINAL SCORES");
        logger.info("═════════════");
        logger.info(`BUY  → Main: ${primaryBuyScore}/${REQUIRED_PRIMARY_SCORE}, Entry: ${secondaryBuyScore}/${REQUIRED_SECONDARY_SCORE}`);
        logger.info(`SELL → Main: ${primarySellScore}/${REQUIRED_PRIMARY_SCORE}, Entry: ${secondarySellScore}/${REQUIRED_SECONDARY_SCORE}`);

        // Signal determination
        let signal = null;
        if (primaryBuyScore >= REQUIRED_PRIMARY_SCORE && secondaryBuyScore >= REQUIRED_SECONDARY_SCORE) {
            signal = "BUY";
            logger.info("\n✨ SIGNAL: BUY");
        } else if (primarySellScore >= REQUIRED_PRIMARY_SCORE && secondarySellScore >= REQUIRED_SECONDARY_SCORE) {
            signal = "SELL";
            logger.info("\n✨ SIGNAL: SELL");
        } else {
            logger.info("\n❌ NO SIGNAL");
        }

        logger.info("═══════════════════\n");

        return { signal, buyScore: primaryBuyScore + secondaryBuyScore, sellScore: primarySellScore + secondarySellScore };
    }

    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last || !trend) return false;
        const getOpen = (c) => (typeof c.o !== "undefined" ? c.o : c.open);
        const getClose = (c) => (typeof c.c !== "undefined" ? c.c : c.close);
        if (getOpen(prev) == null || getClose(prev) == null || getOpen(last) == null || getClose(last) == null) {
            return false;
        }
        const isBullish = (c) => getClose(c) > getOpen(c);
        const isBearish = (c) => getClose(c) < getOpen(c);
        const trendDirection = String(trend).toLowerCase();
        if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) return "bullish";
        if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) return "bearish";
        return false;
    }

    engulfingPattern(prev, last) {
        const getOpen = (c) => c.o ?? c.open;
        const getClose = (c) => c.c ?? c.close;

        if (!prev || !last) return null;

        const prevOpen = getOpen(prev),
            prevClose = getClose(prev);
        const lastOpen = getOpen(last),
            lastClose = getClose(last);

        // Bullish engulfing
        if (lastClose > lastOpen && prevClose < prevOpen && lastClose > prevOpen && lastOpen < prevClose) {
            return "BUY";
        }

        // Bearish engulfing
        if (lastClose < lastOpen && prevClose > prevOpen && lastClose < prevOpen && lastOpen > prevClose) {
            return "SELL";
        }

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
        if (lowerWick > body * 2) return "BUY";

        // Bearish pin bar: long upper wick (≥2× body)
        if (upperWick > body * 2) return "SELL";

        return null;
    }

    // isSessionTime(now) {
    //     const hour = now.getHours();
    //     const minute = now.getMinutes();

    //     // Example: block 00–15 & 20–24 for all sessions
    //     if (minute < 15 || minute > 44) return false;

    //     // Keep logic simple: just let it run during any session; you can extend
    //     // to block specific session windows if you want.
    //     return true;
    // }
}

export default new Strategy();
