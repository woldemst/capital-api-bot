// strategies.js
import logger from "../utils/logger.js";
import { RISK } from "../config.js";

const { REQUIRED_SCORE } = RISK;

class Strategy {
    constructor() {}

    getSignal({ symbol, strategy, indicators, candles }) {
        if (!symbol || !candles || !indicators) return { signal: null, reason: "missing_data" };

        try {
            let m15Pattern = null; // Define these variables at the start
            let m1Pattern = null;

            // 1. Try M15 pattern with H1 trend first
            const m15Candles = candles.m15;
            const h1Trend = indicators.h1.trend;
            logger.info(`${symbol} H1 Trend: ${h1Trend}`);

            // Check M15 scoring first
            const m15ScoringResult = this.checkScoring(m15Candles, indicators, "M15");

            if (m15ScoringResult.signal) {
                m15Pattern = this.greenRedCandlePattern(h1Trend, m15Candles[m15Candles.length - 2], m15Candles[m15Candles.length - 1]);

                if (m15Pattern && m15Pattern.toUpperCase() === m15ScoringResult.signal) {
                    return {
                        signal: m15ScoringResult.signal,
                        reason: "m15_pattern_and_score_confirmed",
                    };
                }
            }

            // 2. If M15 didn't work, try M1 pattern with M5 trend
            const m1Candles = candles.m1;
            const m5Trend = indicators.m5.trend;
            logger.info(`${symbol} M5 Trend: ${m5Trend}`);

            // Check M1 scoring
            const m1ScoringResult = this.checkScoring(m1Candles, indicators, "M1");

            if (m1ScoringResult.signal) {
                m1Pattern = this.greenRedCandlePattern(m5Trend, m1Candles[m1Candles.length - 2], m1Candles[m1Candles.length - 1]);

                if (m1Pattern && m1Pattern.toUpperCase() === m1ScoringResult.signal) {
                    return {
                        signal: m1ScoringResult.signal,
                        reason: "m1_pattern_and_score_confirmed",
                    };
                }
            }

            // 3. No pattern confirmed the scoring
            return {
                signal: null,
                reason:
                    `m15_score=${m15ScoringResult.signal}, m15_pattern=${m15Pattern || "none"}, ` +
                    `m1_score=${m1ScoringResult.signal}, m1_pattern=${m1Pattern || "none"}`,
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
            case "checkBreakout":
                res = this.checkBreakout(
                    candles.m15,
                    indicators.h1.emaFast,
                    indicators.h1.emaSlow,
                    indicators.m15.emaFast,
                    indicators.m15.emaSlow,
                    indicators.m15.atr,
                    indicators.m15.macd
                );
                break;
            case "checkMeanReversion":
                res = this.checkMeanReversion(
                    candles.m15,
                    indicators.m15.rsiSeries,
                    indicators.m15.bbUpperSeries,
                    indicators.m15.bbLowerSeries,
                    indicators.m15.atr,
                    signal
                );
                break;
            case "checkPullbackHybrid":
                res = this.checkPullbackHybrid(
                    candles.m5,
                    indicators.m5.ema20SeriesTail,
                    indicators.m5.ema30SeriesTail,
                    indicators.h1.emaFast,
                    indicators.h1.emaSlow,
                    indicators.m15.adx?.adx,
                    indicators.m15.macd
                );
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

    checkBreakout(m15Candles, h1EmaFast, h1EmaSlow, m15EmaFast, m15EmaSlow, atr, macd) {
        if (!m15Candles || !Array.isArray(m15Candles) || m15Candles.length < 20) return null;
        if (typeof h1EmaFast !== "number" || typeof h1EmaSlow !== "number" || typeof m15EmaFast !== "number" || typeof m15EmaSlow !== "number") return null;
        if (typeof atr !== "number" || !macd) return null;

        console.log(`
                m15Candles length: ${m15Candles.length}
                h1EmaFast: ${h1EmaFast}
                h1EmaSlow: ${h1EmaSlow}
                m15EmaFast: ${m15EmaFast}
                m15EmaSlow: ${m15EmaSlow}
                atr: ${atr}
                macd histogram: ${macd.histogram}

            `);

        const lastIdx = m15Candles.length - 1;
        const last = m15Candles[lastIdx];

        const bullishTrend = h1EmaFast > h1EmaSlow && m15EmaFast > m15EmaSlow;
        const bearishTrend = h1EmaFast < h1EmaSlow && m15EmaFast < m15EmaSlow;
        if (!bullishTrend && !bearishTrend) return null;

        const lookback = 32;
        const highs = m15Candles.slice(lastIdx - lookback + 1, lastIdx + 1).map((c) => c.high);
        const lows = m15Candles.slice(lastIdx - lookback + 1, lastIdx + 1).map((c) => c.low);

        const prevHigh = Math.max(...highs.slice(0, highs.length - 1));
        const prevLow = Math.min(...lows.slice(0, lows.length - 1));

        const breakoutUp = last.close > prevHigh && bullishTrend && macd.histogram > 0 && atr > 0;
        const breakoutDown = last.close < prevLow && bearishTrend && macd.histogram < 0 && atr > 0;

        if (breakoutUp) return "BUY";
        if (breakoutDown) return "SELL";
        return null;
    }

    checkMeanReversion(m15Candles, rsiSeries, bbUpperSeries, bbLowerSeries, atr, proposedSignal) {
        if (!m15Candles || !Array.isArray(m15Candles) || m15Candles.length < 20) return null;
        if (!Array.isArray(rsiSeries) || !Array.isArray(bbUpperSeries) || !Array.isArray(bbLowerSeries)) return null;
        if (typeof atr !== "number") return null;

        const last = m15Candles[m15Candles.length - 1];
        const lastRsi = rsiSeries.length ? rsiSeries[rsiSeries.length - 1] : null;
        const lastUpper = bbUpperSeries.length ? bbUpperSeries[bbUpperSeries.length - 1] : null;
        let lastLower = bbLowerSeries.length ? bbLowerSeries[bbLowerSeries.length - 1] : null;
        if (lastRsi == null || lastUpper == null || lastLower == null) return null;

        if (proposedSignal === "BUY" && lastRsi < 30 && last.close < lastLower && atr > 0) return "BUY";
        if (proposedSignal === "SELL" && lastRsi > 70 && last.close > lastUpper && atr > 0) return "SELL";
        return null;
    }

    checkPullbackHybrid(m5Candles, ema20Series, ema30Series, h1EmaFast, h1EmaSlow, m15Adx, macd) {
        console.log(
            `m5Candles.length: ${m5Candles.length}, ema20Series.length: ${ema20Series.length}, ema30Series.length: ${ema30Series.length}, h1EmaFast: ${h1EmaFast}, h1EmaSlow: ${h1EmaSlow}, m15Adx: ${m15Adx}, macd: ${macd.histogram}`
        );
        if (!m5Candles || !Array.isArray(m5Candles) || m5Candles.length < 10) return null;
        if (!Array.isArray(ema20Series) || !Array.isArray(ema30Series)) return null;
        if (typeof h1EmaFast !== "number" || typeof h1EmaSlow !== "number") return null;
        if (typeof m15Adx !== "number" || !macd) return null;

        const n = m5Candles.length;
        const lastIdx = n - 1;
        const last = m5Candles[lastIdx];

        const bullishTrend = h1EmaFast > h1EmaSlow;
        const bearishTrend = h1EmaFast < h1EmaSlow;
        if (!bullishTrend && !bearishTrend) {
            logger.info(`[PullbackHybrid] No clear trend: h1EmaFast=${h1EmaFast}, h1EmaSlow=${h1EmaSlow}`);
            return null;
        }
        if (m15Adx < 20) {
            logger.info(`[PullbackHybrid] ADX too low: ${m15Adx}`);
            return null;
        }

        let touchedIndex = -1;
        for (let i = n - 60; i <= n - 2; i++) {
            if (i < 0) continue;
            const bar = m5Candles[i];
            const e20 = ema20Series[i];
            const e30 = ema30Series[i];
            if (e20 == null || e30 == null) continue;
            const hi = Math.max(e20, e30);
            const lo = Math.min(e20, e30);
            if (bar.low <= hi && bar.high >= lo) {
                touchedIndex = i;
                logger.info(`[PullbackHybrid] EMA touch at index ${i}: bar.low=${bar.low}, bar.high=${bar.high}, hi=${hi}, lo=${lo}`);
                break;
            }
        }
        if (touchedIndex === -1) {
            logger.info(`[PullbackHybrid] No EMA touch found in recent candles`);
            return null;
        }

        let triggered = null;
        for (let k = 1; k <= 3; k++) {
            const idx = touchedIndex + k;
            if (idx <= 0 || idx >= n) continue;
            const bar = m5Candles[idx];
            const e20 = ema20Series[idx];
            if (!bar || typeof e20 !== "number") continue;
            if (bar.close > e20 && bullishTrend && macd.histogram > 0) {
                triggered = "BUY";
                logger.info(`[PullbackHybrid] BUY triggered at index ${idx}: bar.close=${bar.close}, e20=${e20}, MACD=${macd.histogram}`);
                break;
            }
            if (bar.close < e20 && bearishTrend && macd.histogram < 0) {
                triggered = "SELL";
                logger.info(`[PullbackHybrid] SELL triggered at index ${idx}: bar.close=${bar.close}, e20=${e20}, MACD=${macd.histogram}`);
                break;
            }
        }
        if (!triggered) logger.info(`[PullbackHybrid] No trigger found after EMA touch`);
        return triggered;
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
        logger.info(`[Pattern] Previous candle: ${isBullish(prev) ? 'bullish' : 'bearish'} (O:${getOpen(prev)} C:${getClose(prev)})`);
        logger.info(`[Pattern] Last candle: ${isBullish(last) ? 'bullish' : 'bearish'} (O:${getOpen(last)} C:${getClose(last)})`);

        const trendDirection = String(trend).toLowerCase();

        // Pattern logic with detailed logging
        if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) {
            logger.info(`[Pattern] Found bullish pattern: red->green in bullish trend`);
            return "BUY";  // Changed from "bullish" to "BUY"
        }
        if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) {
            logger.info(`[Pattern] Found bearish pattern: green->red in bearish trend`);
            return "SELL";  // Changed from "bearish" to "SELL"
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
}

export default new Strategy();
