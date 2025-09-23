// strategies.js
import logger from "../utils/logger.js";
import { RISK, STRATEGY_PARAMS, SESSIONS } from "../config.js";

const { REQUIRED_SCORE } = RISK;

class Strategy {
    constructor() {}

    getSignal({ symbol, strategy, indicators, candles }) {
        if (!symbol || !candles || !indicators) {
            return { signal: null, reason: "missing_data" };
        }

        try {
            // Get current time
            const currentTime = new Date();

            // Determine active session based on current time
            const hour = Number(
                currentTime.toLocaleString("en-US", {
                    hour: "2-digit",
                    hour12: false,
                    timeZone: "Europe/Berlin",
                })
            );

            // Find active session from config
            let activeSession = null;
            if (hour >= 8 && hour < 17 && SESSIONS.LONDON.SYMBOLS.includes(symbol)) {
                activeSession = { ...SESSIONS.LONDON, name: "LONDON" };
            } else if (hour >= 13 && hour < 21 && SESSIONS.NY.SYMBOLS.includes(symbol)) {
                activeSession = { ...SESSIONS.NY, name: "NY" };
            } else if ((hour >= 22 || hour < 7) && SESSIONS.SYDNEY.SYMBOLS.includes(symbol)) {
                activeSession = { ...SESSIONS.SYDNEY, name: "SYDNEY" };
            } else if (hour < 9 && SESSIONS.TOKYO.SYMBOLS.includes(symbol)) {
                activeSession = { ...SESSIONS.TOKYO, name: "TOKYO" };
            }

            if (!activeSession) {
                return { signal: null, reason: "no_active_session" };
            }

            // 2. If no session signal, try scalping strategy
            const scalpingResult = this.checkScalping(candles.m5, indicators);

            if (scalpingResult) {
                logger.info(`[${symbol}] Scalping signal: ${scalpingResult.signal}`);
                return {
                    signal: scalpingResult.signal,
                    reason: "scalping",
                };
            }

            // 3. No valid signals found
            return {
                signal: null,
                reason: "no_scalping_signals",
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

    checkScoring(candles, indicators, timeframe = "M15") {
        if (!candles || candles.length < 2) return { signal: null, reason: "not_enough_candles" };

        const prev = candles[candles.length - 2];
        const last = candles[candles.length - 1];

        // Select indicators based on timeframe
        const trendTimeframe = timeframe === "M15" ? "h1" : "m5";
        const priceTimeframe = timeframe.toLowerCase();

        const ema9 = indicators[trendTimeframe].ema9;
        const emaFast = indicators[trendTimeframe].emaFast;
        const emaSlow = indicators[trendTimeframe].emaSlow;
        const fixedAdx = Number(indicators[trendTimeframe].adx.adx.toFixed(2));
        const fixedAtr = Number(indicators[priceTimeframe].atr.toFixed(4));
        const lastClose = last.close;

        const buyConditions = [
            emaFast != null && emaSlow != null ? emaFast > emaSlow : false,
            ema9 != null ? lastClose > ema9 : false,
            indicators[priceTimeframe].macd.histogram != null ? indicators[priceTimeframe].macd.histogram > 0 : false,
        ];

        const sellConditions = [
            emaFast != null && emaSlow != null ? emaFast < emaSlow : false,
            ema9 != null ? lastClose < ema9 : false,
            indicators[priceTimeframe].macd.histogram != null ? indicators[priceTimeframe].macd.histogram < 0 : false,
        ];

        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;

        logger.info(`
            Timeframe: ${timeframe} with ${trendTimeframe.toUpperCase()} trend
            RequiredScore: ${REQUIRED_SCORE}
            BuyScore:  ${buyScore}/${buyConditions.length} | [${buyConditions.map(Boolean)}]
            SellScore: ${sellScore}/${sellConditions.length} | [${sellConditions.map(Boolean)}]
            ${priceTimeframe.toUpperCase()} MACD hist: ${indicators[priceTimeframe].macd.histogram}
            ${priceTimeframe.toUpperCase()} RSI: ${indicators[priceTimeframe].rsi}
            ${priceTimeframe.toUpperCase()} ATR: ${fixedAtr}
            ${trendTimeframe.toUpperCase()} ADX: ${fixedAdx}
        `);

        const longOK = buyScore >= REQUIRED_SCORE && fixedAdx > 10.0;
        const shortOK = sellScore >= REQUIRED_SCORE && fixedAdx > 10.0;

        let signal = null;
        let reason = null;

        if (longOK && !shortOK) signal = "BUY";
        else if (shortOK && !longOK) signal = "SELL";
        else if (longOK && shortOK) reason = "both_sides_ok";
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
            return { signal, reason: "scalping_combined" };
        }

        logger.info("[Scalping] No valid scalping signal found");
        return null;
    }
}

export default new Strategy();
