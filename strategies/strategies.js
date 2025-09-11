// strategies.js
import logger from "../utils/logger.js";
import { RISK } from "../config.js";

const { REQUIRED_SCORE } = RISK;
// Helper: applyFilter
export const applyFilter = (signal, filterName, candles, indicators) => {
    console.log("applyFilter", signal, filterName);

    if (!signal) return { signal: null, reason: "no_signal" };
    let confirmed = true;
    switch (filterName) {
        case "checkBreakout":
            confirmed = checkBreakout(
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
            confirmed = checkMeanReversion(
                candles.m15,
                indicators.m15.rsiSeries || [],
                indicators.m15.bbUpperSeries || [],
                indicators.m15.bbLowerSeries || [],
                indicators.m15.atr,
                signal
            );
            break;
        case "checkPullbackHybrid":
            confirmed = checkPullbackHybrid(
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
    return { signal: trigger, reason: "passed trough filter" };
};

export const checkBreakout = (m15Candles, h1EmaFast, h1EmaSlow, m15EmaFast, m15EmaSlow, atr, macd, opts = {}) => {
    logger.info(`m15Candles: ${m15Candles.length}

                H1 emaFast: ${h1EmaFast}
                H1 emaSlow: ${h1EmaSlow}

                M15 emaFast: ${m15EmaFast}
                M15 emaSlow: ${m15EmaSlow}

                M15 ATR:  ${atr}
                M15 MACD:  ${macd}`);

    if (!m15Candles || !Array.isArray(m15Candles) || m15Candles.length < 20) return null;
    if (typeof h1EmaFast !== "number" || typeof h1EmaSlow !== "number" || typeof m15EmaFast !== "number" || typeof m15EmaSlow !== "number") return null;
    if (typeof atr !== "number" || !macd) return null;

    const lastIdx = m15Candles.length - 1;
    const last = m15Candles[lastIdx];

    // Check trend filter on H1 and M15 EMAs
    const bullishTrend = h1EmaFast > h1EmaSlow && m15EmaFast > m15EmaSlow;
    const bearishTrend = h1EmaFast < h1EmaSlow && m15EmaFast < m15EmaSlow;

    if (!bullishTrend && !bearishTrend) return null;

    // Determine breakout: price breaks above recent high or below recent low in last 10 bars
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
};

// New strategy: checkMeanReversion
export const checkMeanReversion = (m15Candles, rsiSeries, bbUpperSeries, bbLowerSeries, atr, proposedSignal) => {
    // logger.info(`m15Candles: ${m15Candles.length}
    //     M15 rsiSeries: ${rsiSeries}
    //     M15 bbUpperSeries: ${bbUpperSeries}
    //     M15 bbLowerSeries: ${bbLowerSeries}
    //     M15 ATR:  ${atr}`);

    if (!m15Candles || !Array.isArray(m15Candles) || m15Candles.length < 20) return null;
    if (!Array.isArray(rsiSeries) || !Array.isArray(bbUpperSeries) || !Array.isArray(bbLowerSeries)) return null;
    if (typeof atr !== "number") return null;

    const last = m15Candles[m15Candles.length - 1];
    const lastRsi = rsiSeries.length ? rsiSeries[rsiSeries.length - 1] : null;
    const lastUpper = bbUpperSeries.length ? bbUpperSeries[bbUpperSeries.length - 1] : null;
    let lastLower = bbLowerSeries.length ? bbLowerSeries[bbLowerSeries.length - 1] : null;
    lastLower.toFixed(5);
    if (lastRsi == null || lastUpper == null || lastLower == null) return null;

    console.log(lastRsi, last.close, lastLower, atr);
    // Mean reversion buy: RSI oversold and price below lower Bollinger Band, ATR sufficient
    if (proposedSignal === "BUY" && lastRsi < 30 && last.close < lastLower && atr > 0) return "BUY";
    // Mean reversion sell: RSI overbought and price above upper Bollinger Band, ATR sufficient
    if (proposedSignal === "SELL" && lastRsi > 70 && last.close > lastUpper && atr > 0) return "SELL";

    return null;
};

// New strategy: checkPullbackHybrid
export const checkPullbackHybrid = (m5Candles, ema20Series, ema30Series, h1EmaFast, h1EmaSlow, m15Adx, macd, opts = {}) => {
    if (!m5Candles || !Array.isArray(m5Candles) || m5Candles.length < 10) return null;
    if (!Array.isArray(ema20Series) || !Array.isArray(ema30Series)) return null;
    if (typeof h1EmaFast !== "number" || typeof h1EmaSlow !== "number") return null;
    if (typeof m15Adx !== "number" || !macd) return null;

    const n = m5Candles.length;
    const lastIdx = n - 1;
    const last = m5Candles[lastIdx];

    // Confirm trend on H1 EMAs
    const bullishTrend = h1EmaFast > h1EmaSlow;
    const bearishTrend = h1EmaFast < h1EmaSlow;

    if (!bullishTrend && !bearishTrend) return null;

    // Check ADX strength on M15
    if (m15Adx < 20) return null;

    // Pullback detection: price touched EMA20/30 band within last 4 bars (excluding last)
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

    // Trigger: within 3 bars after touch, a candle must close beyond EMA20 to confirm entry
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
};

// Green Red Candle Pattern
export const greenRedCandlePattern = (trend, prev, last) => {
    if (!prev || !last || !trend) return false;

    // Support both {open, close} and {o, c}
    const getOpen = (c) => (typeof c.o !== "undefined" ? c.o : c.open);
    const getClose = (c) => (typeof c.c !== "undefined" ? c.c : c.close);

    if (getOpen(prev) == null || getClose(prev) == null || getOpen(last) == null || getClose(last) == null) {
        return false;
    }

    const isBullish = (c) => getClose(c) > getOpen(c);
    const isBearish = (c) => getClose(c) < getOpen(c);

    const trendDirection = String(trend).toLowerCase();

    if (trendDirection === "bullish" && isBearish(prev) && isBullish(last)) {
        // red -> green in bullish trend
        return "bullish";
    }
    if (trendDirection === "bearish" && isBullish(prev) && isBearish(last)) {
        // green -> red in bearish trend
        return "bearish";
    }
    return false;
};

// scoring strategy
export const checkScoring = (candles, indicators) => {
    if (!candles || candles.length < 2) return { signal: null, reason: "not_enough_candles" };

    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];

    const ema9h1 = indicators.h1.ema9;
    const emaFastH1 = indicators.h1.emaFast;
    const emaSlowH1 = indicators.h1.emaSlow;
    const fixedH1Adx = Number(indicators.h1.adx.adx.toFixed(2));
    const fixedM15Adx = Number(indicators.m15.adx.adx.toFixed(2));
    const fixedM15Atr = Number(indicators.m15.atr.toFixed(4));

    // Pattern direction based on trend & candles
    const h1Trend = emaFastH1 > emaSlowH1 ? "bullish" : "bearish";
    const patternDir = greenRedCandlePattern(h1Trend, prev, last);

    const lastClose = last.close;

    const buyConditions = [
        // patternDir === "bullish",
        emaFastH1 != null && emaSlowH1 != null ? emaFastH1 > emaSlowH1 : false,
        ema9h1 != null ? lastClose > ema9h1 : false,
        indicators.m15.macd.histogram != null ? indicators.m15.macd.histogram > 0 : false,
    ];

    const sellConditions = [
        // patternDir === "bearish",
        emaFastH1 != null && emaSlowH1 != null ? emaFastH1 < emaSlowH1 : false,
        ema9h1 != null ? lastClose < ema9h1 : false,
        indicators.m15.macd.histogram != null ? indicators.m15.macd.histogram < 0 : false,
    ];

    const buyScore = buyConditions.filter(Boolean).length;
    const sellScore = sellConditions.filter(Boolean).length;

    // Pattern: ${patternDir}
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
    // if (fixedM15Atr < 0.0005) {
    //     logger.info(`ATR too low, skipping signal.`);
    //     return { signal: null, reason: "low_volatility" };
    // }
    return { signal, reason: "rules" };
};
