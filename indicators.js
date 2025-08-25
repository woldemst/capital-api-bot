import { SMA, EMA, RSI, BollingerBands, MACD } from "technicalindicators";

export async function calcIndicators(bars) {
    if (!bars || !Array.isArray(bars) || bars.length === 0) {
        // console.error('Invalid or empty bars array:', bars);
        return {};
    }

    const closes = bars.map((b) => {
        // Handle different price formats
        return b.close || b.Close || b.closePrice?.bid || 0;
    });

    // Ensure we have enough data points
    const minLength = Math.max(20, bars.length);

    return {
        maFast: SMA.calculate({ period: 5, values: closes }).slice(-minLength).pop(),
        maSlow: SMA.calculate({ period: 20, values: closes }).slice(-minLength).pop(),
        ema5: EMA.calculate({ period: 5, values: closes }).pop(),
        ema20: EMA.calculate({ period: 20, values: closes }).pop(),
        rsi: RSI.calculate({ period: 14, values: closes }).pop(),
        bb: BollingerBands.calculate({ period: 20, stdDev: 2, values: closes }).pop(),
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
        const h4Data = await getHistorical(symbol, "HOUR_4", 50);

        if (!h4Data?.prices) {
            console.error("Missing prices in historical data");
            return { overallTrend: "unknown" };
        }

        console.log(`Analyzing trend for ${symbol} on H4 only`);

        // Calculate indicators for H4 timeframe
        const h4Indicators = await calcIndicators(h4Data.prices);

        // Determine trend direction only by H4
        const h4Trend = h4Indicators.maFast > h4Indicators.maSlow ? "bullish" : "bearish";

        console.log(`${symbol} H4 Trend: ${h4Trend}`);

        // Return trend analysis (overallTrend = h4Trend)
        return {
            h4Trend,
            h4Indicators,
            overallTrend: h4Trend,
        };
    } catch (error) {
        console.error(`Error analyzing trend for ${symbol}:`, error);
        return { overallTrend: "unknown" };
    }
}
