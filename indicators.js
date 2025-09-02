import { SMA, EMA, RSI, BollingerBands, MACD, ADX, ATR } from "technicalindicators";

export async function calcIndicators(bars) {
    if (!bars || !Array.isArray(bars) || bars.length === 0) {
        return {};
    }

    const closes = bars.map((b) => b.close || b.Close || b.closePrice?.bid || 0);
    const highs = bars.map((b) => b.high || b.High || b.highPrice?.bid || 0);
    const lows = bars.map((b) => b.low || b.Low || b.lowPrice?.bid || 0);

    // Ensure we have enough data points
    const minLength = Math.max(20, bars.length);

    return {
        maFast: SMA.calculate({ period: 5, values: closes }).slice(-minLength).pop(),
        maSlow: SMA.calculate({ period: 20, values: closes }).slice(-minLength).pop(),
        ema5: EMA.calculate({ period: 5, values: closes }).pop(),
        ema20: EMA.calculate({ period: 20, values: closes }).pop(),
        rsi: RSI.calculate({ period: 14, values: closes }).pop(),
        bb: BollingerBands.calculate({ period: 20, stdDev: 2, values: closes }).pop(),
        adx: ADX.calculate({ period: 14, close: closes, high: highs, low: lows }).pop(),
        atr: ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).pop(),
        macd: MACD.calculate({
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            values: closes,
            SimpleMAOscillator: false,
            SimpleMASignal: false,
        }).pop(),
    };
}

// Analyze trend on higher timeframes
export async function analyzeTrend(symbol, getHistorical) {
    if (!symbol || typeof getHistorical !== "function") {
        console.error("Invalid parameters for analyzeTrend");
        return { overallTrend: "unknown" };
    }

    try {
        const h1Data = await getHistorical(symbol, "HOUR", 50);

        if (!h1Data?.prices) {
            console.error("Missing prices in historical data");
            return { overallTrend: "unknown" };
        }

        // Calculate indicators for h1 timeframe
        const h1Indicators = await calcIndicators(h1Data.prices);

        // Determine trend direction only by H4
        const h1Trend = h1Indicators.maFast > h1Indicators.maSlow ? "bullish" : "bearish";

        console.log(`${symbol} H1 Trend: ${h1Trend}`);

        // Return trend analysis (overallTrend = h1Trend)
        return {
            h1Trend,
            h1Indicators,
            overallTrend: h1Trend,
        };
    } catch (error) {
        console.error(`Error analyzing trend for ${symbol}:`, error);
        return { overallTrend: "unknown" };
    }
}
