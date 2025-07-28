import { EMA, RSI, ATR } from "technicalindicators";
import { ANALYSIS } from "./config.js";
import logger from "./utils/logger.js";

const { RSI: RSI_CONFIG } = ANALYSIS;

export async function calcIndicators(bars, symbol = "", timeframe = "", priceType = "mid") {
    if (!bars || !Array.isArray(bars) || bars.length === 0) {
        logger.error(`[Indicators] No bars provided for indicator calculation for ${symbol} ${timeframe}`);
        return {};
    }

    // Helper to extract price by type
    function getPrice(val) {
        if (!val) return 0;
        if (typeof val === "number") return val;
        if (priceType === "bid") return val.bid ?? 0;
        if (priceType === "ask") return val.ask ?? 0;
        // Default: mid
        if (val.bid != null && val.ask != null) return (val.bid + val.ask) / 2;
        return val.bid ?? val.ask ?? 0;
    }

    const closes = bars.map((b) => getPrice(b.close));
    const highs = bars.map((b) => getPrice(b.high));
    const lows = bars.map((b) => getPrice(b.low));

    // Calculate EMAs based on timeframe
    let emaFast, emaSlow;

    if (timeframe === ANALYSIS.TIMEFRAMES.D1) {
        emaFast = EMA.calculate({
            period: ANALYSIS.EMA.D1.FAST,
            values: closes,
        });
        emaSlow = EMA.calculate({
            period: ANALYSIS.EMA.D1.SLOW,
            values: closes,
        });
    } else if (timeframe === ANALYSIS.TIMEFRAMES.H4) {
        emaFast = EMA.calculate({
            period: ANALYSIS.EMA.H4.FAST,
            values: closes,
        });
        emaSlow = EMA.calculate({
            period: ANALYSIS.EMA.H4.SLOW,
            values: closes,
        });
    } else {
        // H1 timeframe
        emaFast = EMA.calculate({
            period: ANALYSIS.EMA.H1.FAST,
            values: closes,
        });
        emaSlow = EMA.calculate({
            period: ANALYSIS.EMA.H1.SLOW,
            values: closes,
        });
    }

    // Use library ATR for consistency
    const atrArr = ATR.calculate({
        period: 14,
        high: highs,
        low: lows,
        close: closes,
    });
    const atr = atrArr.length ? atrArr[atrArr.length - 1] : null;

    // Get the current and previous values
    const currentFastEMA = emaFast[emaFast.length - 1] || 0;
    const currentSlowEMA = emaSlow[emaSlow.length - 1] || 0;
    const prevFastEMA = emaFast[emaFast.length - 2] || 0;
    const prevSlowEMA = emaSlow[emaSlow.length - 2] || 0;
    const currentPrice = closes[closes.length - 1];

    const result = {
        // Basic indicator values
        emaFast: currentFastEMA,
        emaSlow: currentSlowEMA,
        rsi: RSI.calculate({ period: RSI_CONFIG.PERIOD, values: closes }).pop(),
        atr: atr,

        // Trend determination
        trend: currentFastEMA > currentSlowEMA ? "bullish" : "bearish",

        // Cross detection
        crossover: prevFastEMA <= prevSlowEMA && currentFastEMA > currentSlowEMA ? "bullish" : prevFastEMA >= prevSlowEMA && currentFastEMA < currentSlowEMA ? "bearish" : null,

        // Price position
        priceAboveEMAs: currentPrice > currentFastEMA && currentPrice > currentSlowEMA,
        close: currentPrice,
    };
    // Removed obsolete logger.indicator call (no longer needed)
    return result;
}

// Analyze trend on higher timeframes
export async function analyzeTrend(symbol, getHistorical) {
    if (!symbol || typeof getHistorical !== "function") {
        console.error("Invalid parameters for analyzeTrend");
        return { overallTrend: "unknown" };
    }

    try {
        const [h4Data, d1Data] = await Promise.all([
            getHistorical(symbol, ANALYSIS.TIMEFRAMES.TREND, 50), // Changed from STRATEGY.ANALYSIS
            getHistorical(symbol, "DAY", 30),
        ]);

        if (!h4Data?.prices || !d1Data?.prices) {
            console.error("Missing prices in historical data");
            return { overallTrend: "unknown" };
        }

        console.log(`Analyzing trend for ${symbol} on higher timeframes`);

        const h4Indicators = await calcIndicators(h4Data.prices);
        const d1Indicators = await calcIndicators(d1Data.prices);

        // Get trend from indicators
        const h4Trend = h4Indicators.trend;
        const d1Trend = d1Indicators.trend;

        console.log(`${symbol} H4 Trend: ${h4Trend}, D1 Trend: ${d1Trend}`);

        return {
            h4Trend,
            d1Trend,
            h4Indicators,
            d1Indicators,
            overallTrend: h4Trend === "bullish" && d1Trend === "bullish" ? "bullish" : h4Trend === "bearish" && d1Trend === "bearish" ? "bearish" : "mixed",
        };
    } catch (error) {
        console.error(`Error analyzing trend for ${symbol}:`, error);
        return { overallTrend: "unknown" };
    }
}

export function isTrendWeak(indicators, direction) {
    if (!indicators) return false;

    // Check for trend weakness based on new strategy
    if (direction === "BUY") {
        return (
            indicators.trend !== "bullish" || // Trend no longer bullish
            indicators.crossover === "bearish" || // Bearish crossover
            !indicators.priceAboveFastEMA || // Price below fast EMA
            indicators.rsi < 50 // RSI showing weakness
        );
    }

    if (direction === "SELL") {
        return (
            indicators.trend !== "bearish" || // Trend no longer bearish
            indicators.crossover === "bullish" || // Bullish crossover
            indicators.priceAboveFastEMA || // Price above fast EMA
            indicators.rsi > 50 // RSI showing strength
        );
    }

    return false;
}

export function getTPProgress(entry, current, tp, direction) {
    if (!entry || !current || !tp) return 0;
    if (direction === "BUY") {
        if (tp <= entry) return 0;
        return Math.max(0, Math.min(100, ((current - entry) / (tp - entry)) * 100));
    } else {
        if (tp >= entry) return 0;
        return Math.max(0, Math.min(100, ((entry - current) / (entry - tp)) * 100));
    }
}
