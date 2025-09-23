import { SMA, EMA, RSI, BollingerBands, MACD, ADX, ATR } from "technicalindicators";
import logger from "./utils/logger.js";

export async function calcIndicators(bars, symbol, timeframe) {
    if (!bars || !Array.isArray(bars) || bars.length === 0) {
        return null;
    }

    const closes = bars.map((b) => b.close || b.Close || b.closePrice?.bid || 0);
    const highs = bars.map((b) => b.high || b.High || b.highPrice?.bid || 0);
    const lows = bars.map((b) => b.low || b.Low || b.lowPrice?.bid || 0);

    // EMA series and helpers (needed for Calm River)
    const ema20Series = EMA.calculate({ period: 20, values: closes });
    const ema30Series = EMA.calculate({ period: 30, values: closes });
    const ema50Series = EMA.calculate({ period: 50, values: closes });
    const ema20Val = ema20Series[ema20Series.length - 1];
    const ema30Val = ema30Series[ema30Series.length - 1];
    const ema50Val = ema50Series[ema50Series.length - 1];
    const ema20Prev = ema20Series[ema20Series.length - 2] ?? ema20Val;
    const ema30Prev = ema30Series[ema30Series.length - 2] ?? ema30Val;
    const ema50Prev = ema50Series[ema50Series.length - 2] ?? ema50Val;
    const ema20Slope = typeof ema20Val === "number" && typeof ema20Prev === "number" ? ema20Val - ema20Prev : 0;
    const ema30Slope = typeof ema30Val === "number" && typeof ema30Prev === "number" ? ema30Val - ema30Prev : 0;
    const ema50Slope = typeof ema50Val === "number" && typeof ema50Prev === "number" ? ema50Val - ema50Prev : 0;

    // Ensure we have enough data points
    const minLength = Math.max(20, bars.length);

    // --- Add missing indicator series for strategies ---
    // RSI series for Mean Reversion
    const rsiSeries = RSI.calculate({ period: 14, values: closes });
    // Bollinger Bands series for Mean Reversion
    const bbSeries = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    const bbUpperSeries = bbSeries.map((b) => b.upper);
    const bbLowerSeries = bbSeries.map((b) => b.lower);

    // Calculate EMAs for trend
    const emaFastCurrent = EMA.calculate({ period: 12, values: closes }).pop();
    const emaSlowCurrent = EMA.calculate({ period: 26, values: closes }).pop();
    const emaFastPrev = EMA.calculate({ period: 12, values: closes.slice(0, -1) }).pop();

    // Calculate ADX
    const adxResult = ADX.calculate({
        period: 14,
        close: closes,
        high: highs,
        low: lows,
    });
    const currentADX = adxResult[adxResult.length - 1];

    const maFast = SMA.calculate({ period: 5, values: closes }).slice(-minLength).pop();
    const maSlow = SMA.calculate({ period: 20, values: closes }).slice(-minLength).pop();

    return {
        maFast,
        maSlow,
        emaFast: EMA.calculate({ period: 12, values: closes }).pop(),
        emaSlow: EMA.calculate({ period: 26, values: closes }).pop(),
        ema5: EMA.calculate({ period: 5, values: closes }).pop(),
        ema9: EMA.calculate({ period: 9, values: closes }).pop(),
        ema10: EMA.calculate({ period: 10, values: closes }).pop(),
        ema20: ema20Val,
        ema21: EMA.calculate({ period: 21, values: closes }).pop(),
        ema30: ema30Val,
        ema50: ema50Val,
        ema100: EMA.calculate({ period: 100, values: closes }).pop(),
        ema200: EMA.calculate({ period: 200, values: closes }).pop(),
        // Extras for strategies
        ema20Prev,
        ema30Prev,
        ema50Prev,
        ema20Slope,
        ema30Slope,
        ema50Slope,
        // keep short tails to avoid heavy payloads
        ema20SeriesTail: ema20Series.slice(-30),
        ema30SeriesTail: ema30Series.slice(-30),
        ema50SeriesTail: ema50Series.slice(-30),
        rsi: rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : undefined,
        bb: bbSeries.length > 0 ? bbSeries[bbSeries.length - 1] : undefined,
        adx: ADX.calculate({ period: 14, close: closes, high: highs, low: lows }).pop(),
        atr: ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).pop(),
        adaptiveRSI: (() => {
            const baseRSI = 50;
            const atrVal = ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).pop();
            return atrVal ? baseRSI + Math.min(10, atrVal * 100) : baseRSI;
        })(),
        adaptiveADX: (() => {
            const baseADX = 20;
            const atrVal = ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).pop();
            return atrVal ? baseADX + Math.min(10, atrVal * 10) : baseADX;
        })(),
        macd: MACD.calculate({
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            values: closes,
            SimpleMAOscillator: false,
            SimpleMASignal: false,
        }).pop(),
        // --- Added series for strategies ---
        rsiSeries,
        bbSeries,
        bbUpperSeries,
        bbLowerSeries,
        trend: maFast > maSlow ? "bullish" : maFast < maSlow ? "bearish" : "neutral",
        trendStrength: currentADX,
        trendDetails: {
            adx: currentADX,
            emaFast: emaFastCurrent,
            emaSlow: emaSlowCurrent,
            emaFastSlope: emaFastCurrent - emaFastPrev,
        },
    };
}
