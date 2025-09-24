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
            // 1. Main scoring system
            const scoring = this.checkScoring(candles.m5, indicators, "M5");
            logger.info(`[Debug] Scoring result: ${JSON.stringify(scoring)}`);
            if (!scoring.signal) {
                return { signal: null, reason: `scoring_failed: ${scoring.reason}` };
            }

            // 2. Scalping strategy confirmation
            const scalping = this.checkScalping(candles.m5, indicators);
            logger.info(`[Debug] Scalping result: ${JSON.stringify(scalping)}`);
            if (!scalping || scalping.signal !== scoring.signal) {
                return { signal: null, reason: "scalping_failed_or_conflict" };
            }

            // 3. Price action pattern confirmation
            const prev = candles.m5[candles.m5.length - 2];
            const last = candles.m5[candles.m5.length - 1];
            const paSignal = this.greenRedCandlePattern(scoring.signal === "BUY" ? "bullish" : "bearish", prev, last);
            logger.info(`[Debug] Price action pattern result: ${paSignal}`);
            if (paSignal !== scoring.signal) {
                return { signal: null, reason: "price_action_pattern_failed" };
            }

            // All filters passed
            return {
                signal: scoring.signal,
                context: scalping.context,
                reason: "all_filters_passed",
            };
        } catch (e) {
            logger.warn(`${symbol}: Signal check failed: ${e?.message || e}`);
            return { signal: null, reason: "error" };
        }
    }

    applyFilter(signal, filterName, candles, indicators) {
        if (!signal) return { signal: null, reason: "no_signal" };
        let res = null;
        switch (filterName) {
            case "1":
                res; //some strategy will be called here
                break;
            case "2":
                res; //some strategy will be called here

                break;
            case "3":
                res; //some strategy will be called here

                break;
            default:
                res = true;
        }
        // Normalize result: require either boolean true OR the same direction as `signal`
        if (res === true) {
            return { signal, reason: "filter_confirmed_boolean" };
        }
        if (typeof res === "string") {
            if (res === signal) {
                return { signal, reason: "filter_confirmed_direction" };
            } else {
                return { signal: null, reason: `filter_conflict: filterReturned=${res} expected=${signal}` };
            }
        }
        // anything else (null/false) -> not confirmed
        return { signal: null, reason: "filter_failed" };
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

        // Log actual candle properties
        logger.info(`[Pattern] Previous candle: ${isBullish(prev) ? "bullish" : "bearish"} (O:${getOpen(prev)} C:${getClose(prev)})`);
        logger.info(`[Pattern] Last candle: ${isBullish(last) ? "bullish" : "bearish"} (O:${getOpen(last)} C:${getClose(last)})`);

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

    checkScoring(candles, indicators, timeframe = "M5") {
        if (!candles || candles.length < 2) return { signal: null, reason: "not_enough_candles" };
        const { m1, m5, m15, h1 } = indicators || {};
        const prev = candles[candles.length - 2];
        const last = candles[candles.length - 1];

        // Select indicators based on timeframe
        const trendTimeframe = timeframe === "M15" ? "h1" : "m5";
        const priceTimeframe = timeframe.toLowerCase();

        const ema9h1 = h1.ema9;
        const ema21h1 = h1.ema21;
        const emaFastH1 = h1.emaFast;
        const emaSlowH1 = h1.emaSlow;

        const lastClose = last.close;

        // Build conditions explicitly
        const buyConditions = [
            emaFastH1 != null && emaSlowH1 != null ? emaFastH1 > emaSlowH1 : true,
            ema9h1 != null ? lastClose > ema9h1 : true,
            // m15.rsi != null ? m15.rsi > m15.adaptiveRSI : true,
            m15.macd.histogram != null ? m15.macd.histogram > 0 : true,
            // m15.adx.adx != null ? m15.adx.adx > m15.adaptiveADX : true,
        ];

        const sellConditions = [
            emaFastH1 != null && emaSlowH1 != null ? emaFastH1 < emaSlowH1 : true,
            ema9h1 != null ? lastClose < ema9h1 : true,
            // m15.rsi != null ? m15.rsi < 100 - m15.adaptiveRSI : true,
            m15.macd.histogram != null ? m15.macd.histogram < 0 : true,
            // m15.adx.adx != null ? m15.adx.adx > m15.adaptiveADX : true,
        ];

        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;

        const fixedAdx = Number(indicators[trendTimeframe].adx.adx.toFixed(2));
        const fixedAtr = Number(indicators[priceTimeframe].atr.toFixed(4));

        logger.info(`
            RequiredScore: ${REQUIRED_SCORE}
            BuyScore:  ${buyScore}/${buyConditions.length} | [${buyConditions.map(Boolean)}]
            SellScore: ${sellScore}/${sellConditions.length} | [${sellConditions.map(Boolean)}]
            M15 RSI: ${m15.rsi}
            M15 MACD hist: ${m15.macd.histogram}
            M15 ADX: ${m15.adx.adx}
            H1 ADX: ${h1.adx.adx}
        `);

        const longOK = buyScore >= REQUIRED_SCORE && fixedAdx > 10.0;
        const shortOK = sellScore >= REQUIRED_SCORE && fixedAdx > 10.0;

        let signal = null;
        let reason = null;

        if (longOK && !shortOK) signal = "BUY";
        else if (shortOK && !longOK) signal = "SELL";
        else reason = `score_too_low: buy ${buyScore}/${REQUIRED_SCORE}, sell ${sellScore}/${REQUIRED_SCORE}`;

        if (!signal) return { signal: null, reason };
        return { signal, reason: "rules" };
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
}

export default new Strategy();
