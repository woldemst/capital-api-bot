// strategies.js
import logger from "../utils/logger.js";
import { RISK, STRATEGY_PARAMS, SESSIONS } from "../config.js";

const { REQUIRED_SCORE } = RISK;

class Strategy {
    constructor() {}

    getSignal({ symbol, indicators, candles }) {
        if (!symbol || !candles || !indicators) {
            return { signal: null, reason: "missing_data" };
        }

        try {
            const h1TrendBullish = indicators.h1.ema20 > indicators.h1.ema50;
            const m5TrendBullish = indicators.m5.ema20 > indicators.m5.ema50;
            const m15TrendBullish = indicators.m15.ema20 > indicators.m15.ema50;

            let trend = null;
            if (indicators.m5.ema20 > indicators.m5.ema50) trend = "bullish";
            else if (indicators.m5.ema20 < indicators.m5.ema50) trend = "bearish";
            else return { signal: null, reason: "no_clear_m5_trend" };
            logger.info(`[Debug] m5 trend determined as: ${trend}`);
            // if (h1TrendBullish !== m5TrendBullish) {
            //     return { signal: null, reason: "trend_mismatch" };
            // }
            // if (!this.isSessionTime(tradeTime)) {
            //     return { signal: null, reason: "outside_session" };
            // }

            const m5 = candles.m5;
            if (!m5 || m5.length < 2) return { signal: null, reason: "not_enough_m5_candles" };
            
            const prev = m5[m5.length - 2];
            const last = m5[m5.length - 1];
            const patternSignal = this.greenRedCandlePattern(trend, prev, last) || this.engulfingPattern(prev, last) || this.pinBarPattern(last);
            if (!patternSignal) return { signal: null, reason: "price_action_pattern_failed" };

            // --- 3. Scoring filter ---
            const scoring = this.checkScoring(m5, indicators);
            if (!scoring.signal || scoring.signal !== patternSignal) {
                return { signal: null, reason: `scoring_failed_or_conflict: ${scoring.reason}` };
            }

            // const scalping = this.checkScalping(candles.m5, indicators);
            // logger.info(`[Debug] Scalping result: ${JSON.stringify(scalping)}`);
            // if (!scalping) return { signal: null, reason: "scalping_failed" };

            return {
                signal: scoring.signal,
                reason: "all_filters_passed",
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

    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last || !trend) {
            logger.info(`[Pattern] Missing data: prev=${!!prev}, last=${!!last}, trend=${trend}`);
            return false;
        }

        // Support both {open, close} and {o, c}
        const getOpen = (c) => (typeof c.o !== "undefined" ? c.o : c.open);
        const getClose = (c) => (typeof c.c !== "undefined" ? c.c : c.close);

        if (getOpen(prev) == null || getClose(prev) == null || getOpen(last) == null || getClose(last) == null) {
            logger.info(`[Pattern] Null values in candles`);
            return false;
        }

        const isBullish = (c) => getClose(c) > getOpen(c);
        const isBearish = (c) => getClose(c) < getOpen(c);

        const trendDirection = String(trend).toLowerCase();

        // Pattern logic with detailed logging
        if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) {
            logger.info(`[Pattern] Found bullish pattern: red->green in bullish trend`);
            return "BUY"; // Changed from "bullish" to "BUY"
        }
        if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) {
            logger.info(`[Pattern] Found bearish pattern: green->red in bearish trend`);
            return "SELL"; // Changed from "bearish" to "SELL"
        }

        logger.info(`[Pattern] No valid pattern found for ${trendDirection} trend`);
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

    checkScoring(candles, indicators) {
        if (!candles || candles.length < 2) return { signal: null, reason: "not_enough_candles" };
        const { m5, m15, h1 } = indicators;

        // Build conditions explicitly
        const buyConditions = [
            h1.ema20 > h1.ema50, // Add H1 trend alignment
            m5.ema20 > m5.ema50,
            m5.macd.histogram > 0,
            m5.rsi > 40 && m5.rsi < 70, // Avoid overbought
            m5.adx.adx > 25, // Stronger trend required
        ];

        const sellConditions = [
            h1.ema20 < h1.ema50,
            m5.ema20 < m5.ema50,
            m5.macd.histogram < 0,
            m5.rsi < 60 && m5.rsi > 30,
            m5.adx.adx > 25, // Stronger trend required
        ];

        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;

        logger.info(`
            RequiredScore: ${REQUIRED_SCORE}
            BuyScore:  ${buyScore}/${buyConditions.length} | [${buyConditions.map(Boolean)}]
            SellScore: ${sellScore}/${sellConditions.length} | [${sellConditions.map(Boolean)}]
        `);

        if (buyScore >= REQUIRED_SCORE && sellScore < REQUIRED_SCORE) return { signal: "BUY" };
        if (sellScore >= REQUIRED_SCORE && buyScore < REQUIRED_SCORE) return { signal: "SELL" };

        const reason = `score_too_low: buy ${buyScore}/${REQUIRED_SCORE}, sell ${sellScore}/${REQUIRED_SCORE}`;
        return { signal: null, reason };
    }

    checkScalping(m5Candles, indicators) {
        if (!m5Candles || m5Candles.length < 10) return null;

        const last = m5Candles[m5Candles.length - 1];
        const prev = m5Candles[m5Candles.length - 2];

        // --- Trend filter on H1 ---
        const h1Ema20 = indicators.h1.ema20;
        const h1Ema50 = indicators.h1.ema50;
        if (typeof h1Ema20 !== "number" || typeof h1Ema50 !== "number") return null;
        const bullishTrend = h1Ema20 > h1Ema50;
        const bearishTrend = h1Ema20 < h1Ema50;
        if (!bullishTrend && !bearishTrend) {
            logger.info("[Scalping] No clear H1 trend, skipping");
            return null;
        }

        // --- Volatility filter (ATR on M5) ---
        const atr = indicators.m5.atr;
        if (typeof atr !== "number" || atr < 0.0003) {
            // adjust threshold depending on symbol
            logger.info(`[Scalping] ATR ${atr} too low, skipping`);
            return null;
        }

        // --- Oscillator confirmation ---
        const rsi = indicators.m5.rsi;
        const macd = indicators.m5.macd;
        if (!macd || typeof macd.histogram !== "number" || typeof rsi !== "number") return null;

        // --- Price action filter: breakout of prev candle ---
        let signal = null;
        if (bullishTrend && indicators.m5.ema5 > indicators.m5.ema10 && macd.histogram > 0 && rsi > 40 && rsi < 70 && last.close > prev.high) {
            signal = "BUY";
        } else if (bearishTrend && indicators.m5.ema5 < indicators.m5.ema10 && macd.histogram < 0 && rsi < 60 && rsi > 30 && last.close < prev.low) {
            signal = "SELL";
        }

        if (signal) {
            logger.info(`[Scalping] ${signal} signal confirmed (trend+oscillator+PA)`);
            return {
                signal,
                reason: "scalping_combined",
                context: {
                    prevHigh: prev.high,
                    prevLow: prev.low,
                    prevOpen: prev.open,
                    prevClose: prev.close,
                },
            };
        }

        logger.info("[Scalping] No valid scalping signal found");
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
