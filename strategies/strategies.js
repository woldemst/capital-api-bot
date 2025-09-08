//  Calm River strategy (enhanced)
export const checkCalmRiver = (m5Candles, ema20, ema30, ema50, opts = {}) => {
    // Require sufficient data
    if (!m5Candles || m5Candles.length < 60 || ema20 == null || ema30 == null || ema50 == null) return null;

    const { ema20Prev, ema50Prev, ema20Series = [], ema50Series = [], atr } = opts;

    const last = m5Candles[m5Candles.length - 1];
    const lastClose = last.close;

    // Slopes (if prev provided). If not provided, don't block on slope.
    const upSlope = typeof ema20Prev === "number" && typeof ema50Prev === "number" ? ema20 > ema20Prev && ema50 > ema50Prev : true;
    const downSlope = typeof ema20Prev === "number" && typeof ema50Prev === "number" ? ema20 < ema20Prev && ema50 < ema50Prev : true;

    // Helper to get EMA pair for a given candle index (fallbacks to current values if series not aligned)
    const getBandAt = (i) => {
        if (ema20Series.length === m5Candles.length && ema50Series.length === m5Candles.length) {
            return [ema20Series[i], ema50Series[i]];
        }
        return [ema20, ema50];
    };

    // 1) Congestion filter: count closes inside the EMA channel in the last 10 bars (excluding the latest)
    let insideCount = 0;
    for (let i = Math.max(0, m5Candles.length - 11); i < m5Candles.length - 1; i++) {
        const [e20, e50] = getBandAt(i);
        const hi = Math.max(e20, e50);
        const lo = Math.min(e20, e50);
        const c = m5Candles[i].close;
        if (c > lo && c < hi) insideCount++;
    }
    if (insideCount > 3) return null; // too much congestion

    // 2) Noisy channel filter: count EMA20/EMA50 crossovers in the last 20 bars of the series
    let crosses = 0;
    if (ema20Series.length && ema50Series.length) {
        const n = Math.min(ema20Series.length, ema50Series.length);
        const start = Math.max(1, n - 20);
        for (let i = start; i < n; i++) {
            const prevDiff = ema20Series[i - 1] - ema50Series[i - 1];
            const currDiff = ema20Series[i] - ema50Series[i];
            if ((prevDiff <= 0 && currDiff > 0) || (prevDiff >= 0 && currDiff < 0)) crosses++;
        }
    }
    if (crosses > 1) return null; // river should be calm

    // 3) Channel width filter: average width over last 10 bars must exceed a fraction of ATR
    let widthOK = true;
    if (ema20Series.length && ema50Series.length) {
        const n = Math.min(ema20Series.length, ema50Series.length);
        const start = Math.max(0, n - 10);
        const widths = [];
        for (let i = start; i < n; i++) widths.push(Math.abs(ema20Series[i] - ema50Series[i]));
        const avgWidth = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : Math.abs(ema20 - ema50);
        const minWidth = atr ? atr * 0.3 : 0; // 30% of ATR by default
        widthOK = avgWidth >= minWidth;
    }
    if (!widthOK) return null;

    // 4) Pullback: within last 3 bars before the trigger, price must touch the band
    const prev3 = [m5Candles[m5Candles.length - 4], m5Candles[m5Candles.length - 3], m5Candles[m5Candles.length - 2]];
    let touched = false;
    for (let i = m5Candles.length - 4; i <= m5Candles.length - 2; i++) {
        const bar = m5Candles[i];
        const [e20, e50] = getBandAt(i);
        const hi = Math.max(e20, e50);
        const lo = Math.min(e20, e50);
        if (bar && bar.low <= hi && bar.high >= lo) {
            touched = true;
            break;
        }
    }
    if (!touched) return null;

    // 5) Trend alignment and trigger candle
    const trendUp = lastClose > ema20 && ema20 > ema50 && upSlope;
    const trendDown = lastClose < ema20 && ema20 < ema50 && downSlope;

    if (trendUp && lastClose > ema20) return "BUY";
    if (trendDown && lastClose < ema20) return "SELL";
    return null;
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
export const scoring = () => {
    // const ema9h1 = indicators.h1.ema9;
    // const emaFastH1 = indicators.h1.emaFast;
    // const emaSlowH1 = indicators.h1.emaSlow;
    // const fixedH1Adx = Number(indicators.h1.adx.adx.toFixed(2));
    // const fixedM15Adx = Number(indicators.m15.adx.adx.toFixed(2));
    // const fixedM15Atr = Number(indicators.m15.atr.toFixed(4));
    // const patternDir = greenRedCandlePattern(h1Trend, prev, last);
    // const getClose = (c) => c.close;
    // const lastClose = getClose(last);
    // // Build conditions explicitly
    // const buyConditions = [
    //     patternDir === "bullish",
    //     emaFastH1 != null && emaSlowH1 != null ? emaFastH1 > emaSlowH1 : false,
    //     ema9h1 != null ? lastClose > ema9h1 : false,
    //     indicators.m15.macd.histogram != null ? indicators.m15.macd.histogram > 0 : false,
    // ];
    // const sellConditions = [
    //     patternDir === "bearish",
    //     emaFastH1 != null && emaSlowH1 != null ? emaFastH1 < emaSlowH1 : false,
    //     ema9h1 != null ? lastClose < ema9h1 : false,
    //     indicators.m15.macd.histogram != null ? indicators.m15.macd.histogram < 0 : false,
    // ];
    // const buyScore = buyConditions.filter(Boolean).length;
    // const sellScore = sellConditions.filter(Boolean).length;
    // logger.info(`[Signal Analysis] ${symbol}
    //     Pattern: ${patternDir}
    //     RequiredScore: ${REQUIRED_SCORE}
    //     BuyScore:  ${buyScore}/${buyConditions.length} | [${buyConditions.map(Boolean)}]
    //     SellScore: ${sellScore}/${sellConditions.length} | [${sellConditions.map(Boolean)}]
    //     M15 MACD hist: ${indicators.m15.macd.histogram}
    //     M15 RSI: ${indicators.m15.rsi}
    //     M15 ADX: ${fixedM15Adx}
    //     M15 ATR: ${fixedM15Atr}
    //     H1 ADX: ${fixedH1Adx}
    // `);
    // const longOK = buyScore >= REQUIRED_SCORE && fixedH1Adx > 15.0;
    // const shortOK = sellScore >= REQUIRED_SCORE && fixedM15Adx > 15.0;
    // let signal = null;
    // let reason = null;
    // if (longOK && !shortOK) {
    //     signal = "BUY";
    // } else if (shortOK && !longOK) {
    //     signal = "SELL";
    // } else if (longOK && shortOK) {
    //     // If both sides qualify, follow the pattern direction if any
    //     if (patternDir === "bullish") signal = "BUY"; else if (patternDir === "bearish") signal = "SELL"; else reason = "both_sides_ok";
    // } else {
    //     reason = `score_too_low: buy ${buyScore}/${REQUIRED_SCORE}, sell ${sellScore}/${REQUIRED_SCORE}`;
    // }
    // if (!signal) return { signal: null, reason };
    // if (fixedM15Atr < 0.0005) {
    //     logger.info(`[Signal] ${symbol}: ATR too low, skipping signal.`);
    //     return { signal: null, reason: "low_volatility" };
    // }
    // return { signal, reason: "rules" };
};
