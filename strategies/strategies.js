export const checkCalmRiver = (m5Candles, ema20, ema30, opts = {}) => {
    if (!m5Candles || !Array.isArray(m5Candles) || m5Candles.length < 30) return null;

    const {
        ema20Series,
        ema30Series,
        ema20Prev,
        ema30Prev,
        h1Ema20,
        h1Ema30,
        atr,
        macd,
        maxInside = 3,
        lookbackInside = 10,
        crossLimit = 1,
        triggerWindow = 3,
        minWidthAtrFrac = 0.3,
        requireSlope = true,
    } = opts;

    const n = m5Candles.length;
    const lastIdx = n - 1;
    const last = m5Candles[lastIdx];
    const lastClose = last.close;

    // slope checks (optional)
    const upSlope = typeof ema20Prev === "number" && typeof ema30Prev === "number" ? ema20 > ema20Prev && ema30 > ema30Prev : true;
    const downSlope = typeof ema20Prev === "number" && typeof ema30Prev === "number" ? ema20 < ema20Prev && ema30 < ema30Prev : true;
    if (requireSlope && !upSlope && !downSlope) return null;

    // helper to read series values safely
    const emaAt = (series, idx, fallback) => {
        if (Array.isArray(series) && series.length === n) return series[idx];
        return fallback;
    };

    // 1) Count closes inside the EMA channel in the last lookbackInside bars (excluding the last bar)
    let insideCount = 0;
    const start = Math.max(0, n - 1 - lookbackInside);
    for (let i = start; i < lastIdx; i++) {
        const e20 = emaAt(ema20Series, i, ema20);
        const e30 = emaAt(ema30Series, i, ema30);
        const hi = Math.max(e20, e30);
        const lo = Math.min(e20, e30);
        const c = m5Candles[i].close;
        if (c > lo && c < hi) insideCount++;
    }
    if (insideCount > maxInside) return null; // too congested

    // 2) Check EMA crosses over a recent window to ensure "calm river"
    if (Array.isArray(ema20Series) && Array.isArray(ema30Series) && ema20Series.length === n && ema30Series.length === n) {
        let crosses = 0;
        const crossStart = Math.max(1, n - 20);
        for (let i = crossStart; i < n; i++) {
            const prevDiff = ema20Series[i - 1] - ema30Series[i - 1];
            const currDiff = ema20Series[i] - ema30Series[i];
            if ((prevDiff <= 0 && currDiff > 0) || (prevDiff >= 0 && currDiff < 0)) crosses++;
        }
        if (crosses > crossLimit) return null;
    }

    // 3) Channel width vs ATR
    if (atr && Array.isArray(ema20Series) && Array.isArray(ema30Series) && ema20Series.length === n && ema30Series.length === n) {
        const widthArr = [];
        const wStart = Math.max(0, n - 10);
        for (let i = wStart; i < n; i++) widthArr.push(Math.abs(ema20Series[i] - ema30Series[i]));
        const avgWidth = widthArr.length ? widthArr.reduce((a, b) => a + b, 0) / widthArr.length : Math.abs(ema20 - ema30);
        if (avgWidth < atr * minWidthAtrFrac) return null;
    }

    // 4) Pullback detection: within the 3 bars before current, price must have touched the band
    let touchedIndex = -1;
    for (let i = n - 4; i <= n - 2; i++) {
        if (i < 0) continue;
        const bar = m5Candles[i];
        const e20 = emaAt(ema20Series, i, ema20);
        const e30 = emaAt(ema30Series, i, ema30);
        const hi = Math.max(e20, e30);
        const lo = Math.min(e20, e30);
        if (bar.low <= hi && bar.high >= lo) {
            touchedIndex = i;
            break;
        }
    }
    if (touchedIndex === -1) return null;

    // 5) Trigger: within triggerWindow bars after touch (including the candle after touch), a candle must close beyond EMA20
    let triggered = null; // "BUY" or "SELL"
    for (let k = 1; k <= triggerWindow; k++) {
        const idx = touchedIndex + k;
        if (idx <= 0 || idx >= n) continue;
        const bar = m5Candles[idx];
        const e20 = emaAt(ema20Series, idx, ema20);
        if (!bar || typeof e20 !== "number") continue;
        if (bar.close > e20 && ema20 > ema30 && upSlope) {
            triggered = "BUY";
            break;
        }
        if (bar.close < e20 && ema20 < ema30 && downSlope) {
            triggered = "SELL";
            break;
        }
    }
    if (!triggered) return null;

    // 6) MACD histogram validation (if provided)
    if (macd) {
        if (triggered === "BUY" && macd.histogram <= 0) return null;
        if (triggered === "SELL" && macd.histogram >= 0) return null;
    }

    // 7) Higher timeframe alignment: require H1 EMA20 > EMA30 for BUY, EMA20 < EMA30 for SELL
    if (triggered === "BUY" && !(h1Ema20 > h1Ema30)) return null;
    if (triggered === "SELL" && !(h1Ema20 < h1Ema30)) return null;

    // Final sanity checks: avoid entries when ADX low or ATR tiny can be checked in opts (caller should pass m5Indicators)
    // return detected signal
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
