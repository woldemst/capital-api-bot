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
