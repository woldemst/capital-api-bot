import { EMA, RSI, ATR } from "technicalindicators";
import { ANALYSIS } from "./config.js";
import logger from "./utils/logger.js";


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
    let ema9, ema21, ema20, ema50;

    if (timeframe === ANALYSIS.TIMEFRAMES.D1) {
        ema20 = EMA.calculate({ period: 20, values: closes });
        ema50 = EMA.calculate({ period: 50, values: closes });

        return {
            trend: ema20[ema20.length - 1] > ema50[ema50.length - 1] ? "bullish" : ema20[ema20.length - 1] < ema50[ema50.length - 1] ? "bearish" : "neutral",
        };
    } else if (timeframe === ANALYSIS.TIMEFRAMES.H4) {
        ema20 = EMA.calculate({ period: 20, values: closes });
        ema50 = EMA.calculate({ period: 50, values: closes });

        return {
            trend: ema20[ema20.length - 1] > ema50[ema50.length - 1] ? "bullish" : ema20[ema20.length - 1] < ema50[ema50.length - 1] ? "bearish" : "neutral",
        };
    } else {
        // H1 timeframe
        ema9 = EMA.calculate({ period: 9, values: closes });
        ema21 = EMA.calculate({ period: 21, values: closes });

        const currentEMA9 = ema9[ema9.length - 1];
        const currentEMA21 = ema21[ema21.length - 1];
        const prevEMA9 = ema9[ema9.length - 2];
        const prevEMA21 = ema21[ema21.length - 2];

        // Add trend property for H1
        let trend = "neutral";
        if (currentEMA9 > currentEMA21) trend = "bullish";
        else if (currentEMA9 < currentEMA21) trend = "bearish";

        return {
            ema9: currentEMA9,
            ema21: currentEMA21,
            rsi: RSI.calculate({ period: 14, values: closes }).pop(),
            crossover: prevEMA9 <= prevEMA21 && currentEMA9 > currentEMA21 ? "bullish" : prevEMA9 >= prevEMA21 && currentEMA9 < currentEMA21 ? "bearish" : null,
            close: closes[closes.length - 1],
            high: highs[highs.length - 1],
            low: lows[lows.length - 1],
            trend,
        };
    }
}
