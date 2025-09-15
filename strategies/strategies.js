// strategies.js
import logger from "../utils/logger.js";
import { RISK } from "../config.js";

const { REQUIRED_SCORE } = RISK;

class Strategy {
    constructor() {}

    /**
     * Main entry: returns signal and reason for a given strategy and market state.
     * @param {Object} params - { symbol, strategy, indicators, candles }
     * @returns {Object} { signal, reason }
     */
    getSignal({ symbol, strategy, indicators, candles }) {
        if (!symbol || !candles || !indicators) return { signal: null, reason: "missing_data" };

        try {
            // Always start with scoring
            const scoringResult = this.checkScoring(candles.m15, indicators);
            if (!scoringResult.signal) return scoringResult;

            // Apply session-specific filter
            const filterResult = this.applyFilter(scoringResult.signal, strategy, candles, indicators);
            return filterResult;
        } catch (e) {
            logger.warn(`${strategy} ${symbol}: check failed: ${e?.message || e}`);
            return { signal: null, reason: "error" };
        }
    }

    applyFilter(signal, filterName, candles, indicators) {
        if (!signal) return { signal: null, reason: "no_signal" };
        let confirmed = true;
        switch (filterName) {
            case "checkBreakout":
                confirmed = this.checkBreakout(
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
                confirmed = this.checkMeanReversion(
                    candles.m15,
                    indicators.m15.rsiSeries || [],
                    indicators.m15.bbUpperSeries || [],
                    indicators.m15.bbLowerSeries || [],
                    indicators.m15.atr,
                    signal
                );
                break;
            case "checkPullbackHybrid":
                confirmed = this.checkPullbackHybrid(
                    candles.m5,
                    indicators.m5.ema20SeriesTail || [],
                    indicators.m5.ema30SeriesTail || [],
                    indicators.h1.emaFast,
                    indicators.h1.emaSlow,
                    indicators.m15.adx?.adx ?? 0,
                    indicators.m15.macd
                );
                break;
            default:
                confirmed = true;
        }
        let trigger = confirmed ? signal : null;
        return { signal: trigger, reason: "passed_trough_filter" };
    }

    checkBreakout(m15Candles, h1EmaFast, h1EmaSlow, m15EmaFast, m15EmaSlow, atr, macd, opts = {}) {
        if (!m15Candles || !Array.isArray(m15Candles) || m15Candles.length < 20) return null;
        if (typeof h1EmaFast !== "number" || typeof h1EmaSlow !== "number" || typeof m15EmaFast !== "number" || typeof m15EmaSlow !== "number") return null;
        if (typeof atr !== "number" || !macd) return null;

        const lastIdx = m15Candles.length - 1;
        const last = m15Candles[lastIdx];

        const bullishTrend = h1EmaFast > h1EmaSlow && m15EmaFast > m15EmaSlow;
        const bearishTrend = h1EmaFast < h1EmaSlow && m15EmaFast < m15EmaSlow;
        if (!bullishTrend && !bearishTrend) return null;

        const lookback = opts.lookback || 32;
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
        if (!m5Candles || !Array.isArray(m5Candles) || m5Candles.length < 10) return null;
        if (!Array.isArray(ema20Series) || !Array.isArray(ema30Series)) return null;
        if (typeof h1EmaFast !== "number" || typeof h1EmaSlow !== "number") return null;
        if (typeof m15Adx !== "number" || !macd) return null;

        const n = m5Candles.length;
        const lastIdx = n - 1;
        const last = m5Candles[lastIdx];

        const bullishTrend = h1EmaFast > h1EmaSlow;
        const bearishTrend = h1EmaFast < h1EmaSlow;
        if (!bullishTrend && !bearishTrend) return null;
        if (m15Adx < 20) return null;

        let touchedIndex = -1;
        for (let i = n - 5; i <= n - 2; i++) {
            if (i < 0) continue;
            const bar = m5Candles[i];
            const e20 = ema20Series[i];
            const e30 = ema30Series[i];
            if (e20 == null || e30 == null) continue;
            const hi = Math.max(e20, e30);
            const lo = Math.min(e20, e30);
            if (bar.low <= hi && bar.high >= lo) {
                touchedIndex = i;
                break;
            }
        }
        if (touchedIndex === -1) return null;

        let triggered = null;
        for (let k = 1; k <= 3; k++) {
            const idx = touchedIndex + k;
            if (idx <= 0 || idx >= n) continue;
            const bar = m5Candles[idx];
            const e20 = ema20Series[idx];
            if (!bar || typeof e20 !== "number") continue;
            if (bar.close > e20 && bullishTrend && macd.histogram > 0) {
                triggered = "BUY";
                break;
            }
            if (bar.close < e20 && bearishTrend && macd.histogram < 0) {
                triggered = "SELL";
                break;
            }
        }
        if (!triggered) return null;
        return triggered;
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
        if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) {
            return "bullish";
        }
        if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) {
            return "bearish";
        }
        return false;
    }

    checkScoring(candles, indicators) {
        if (!candles || candles.length < 2) return { signal: null, reason: "not_enough_candles" };
        const prev = candles[candles.length - 2];
        const last = candles[candles.length - 1];
        const ema9h1 = indicators.h1.ema9;
        const emaFastH1 = indicators.h1.emaFast;
        const emaSlowH1 = indicators.h1.emaSlow;
        const fixedH1Adx = Number(indicators.h1.adx.adx.toFixed(2));
        const fixedM15Adx = Number(indicators.m15.adx.adx.toFixed(2));
        const fixedM15Atr = Number(indicators.m15.atr.toFixed(4));
        const h1Trend = emaFastH1 > emaSlowH1 ? "bullish" : "bearish";
        const patternDir = this.greenRedCandlePattern(h1Trend, prev, last);
        const lastClose = last.close;
        const buyConditions = [
            emaFastH1 != null && emaSlowH1 != null ? emaFastH1 > emaSlowH1 : false,
            ema9h1 != null ? lastClose > ema9h1 : false,
            indicators.m15.macd.histogram != null ? indicators.m15.macd.histogram > 0 : false,
        ];
        const sellConditions = [
            emaFastH1 != null && emaSlowH1 != null ? emaFastH1 < emaSlowH1 : false,
            ema9h1 != null ? lastClose < ema9h1 : false,
            indicators.m15.macd.histogram != null ? indicators.m15.macd.histogram < 0 : false,
        ];
        const buyScore = buyConditions.filter(Boolean).length;
        const sellScore = sellConditions.filter(Boolean).length;
        logger.info(`
            RequiredScore: ${REQUIRED_SCORE}
            BuyScore:  ${buyScore}/${buyConditions.length} | [${buyConditions.map(Boolean)}]
            SellScore: ${sellScore}/${sellConditions.length} | [${sellConditions.map(Boolean)}]
            M15 MACD hist: ${indicators.m15.macd.histogram}
            M15 RSI: ${indicators.m15.rsi}
            M15 ATR: ${fixedM15Atr}
            M15 ADX: ${fixedM15Adx}
            H1 ADX: ${fixedH1Adx}
        `);
        const longOK = buyScore >= REQUIRED_SCORE && fixedH1Adx > 15.0;
        const shortOK = sellScore >= REQUIRED_SCORE && fixedM15Adx > 15.0;
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