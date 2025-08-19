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
        const [h4Data, d1Data] = await Promise.all([getHistorical(symbol, "HOUR_4", 50), getHistorical(symbol, "DAY", 30)]);

        // console.log(`h4Data from analyzeTrend:`, h4Data);

        // Add validation for historical data
        if (!h4Data?.prices || !d1Data?.prices) {
            console.error("Missing prices in historical data");
            return { overallTrend: "unknown" };
        }

        console.log(`Analyzing trend for ${symbol} on higher timeframes`);

        // Calculate indicators for H4 timeframe
        const h4Indicators = await calcIndicators(h4Data);

        // Calculate indicators for D1 timeframe
        const d1Indicators = await calcIndicators(d1Data);

        // Determine trend direction
        const h4Trend = h4Indicators.maFast > h4Indicators.maSlow ? "bullish" : "bearish";
        const d1Trend = d1Indicators.maFast > d1Indicators.maSlow ? "bullish" : "bearish";

        console.log(`${symbol} H4 Trend: ${h4Trend}, D1 Trend: ${d1Trend}`);

        // Return trend analysis
        return {
            h4Trend,
            d1Trend,
            h4Indicators,
            d1Indicators,
            // Overall trend is bullish if both timeframes are bullish
            overallTrend: h4Trend === "bullish" && d1Trend === "bullish" ? "bullish" : h4Trend === "bearish" && d1Trend === "bearish" ? "bearish" : "mixed",
        };
    } catch (error) {
        console.error(`Error analyzing trend for ${symbol}:`, error);
        return { overallTrend: "unknown" };
    }
}
