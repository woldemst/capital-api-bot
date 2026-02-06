import { EMA, RSI, BollingerBands, MACD, ADX, ATR } from "technicalindicators";
import { ANALYSIS } from "../config.js";
import { calculateBackQuantSignal } from "./BackQuant.js";

const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const BB_STDDEV = 2;
const ATR_PERIOD = 14;

const MACD_CONFIG = {
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
};

export async function calcIndicators(bars) {
    if (!Array.isArray(bars) || bars.length === 0) {
        return null;
    }

    const closes = bars.map((b) => b.close || b.Close || b.closePrice?.bid || 0);
    const highs = bars.map((b) => b.high || b.High || b.highPrice?.bid || 0);
    const lows = bars.map((b) => b.low || b.Low || b.lowPrice?.bid || 0);

    const last = (series) => (Array.isArray(series) && series.length ? series[series.length - 1] : undefined);
    const prevOr = (series, fallback) => (Array.isArray(series) && series.length > 1 ? series[series.length - 2] : fallback);
    const slope = (current, previous) => (Number.isFinite(current) && Number.isFinite(previous) ? current - previous : 0);

    // Trend EMAs from config
    const emaFastTrendSeries = EMA.calculate({ period: ANALYSIS.EMA.TREND.FAST, values: closes });
    const emaSlowTrendSeries = EMA.calculate({ period: ANALYSIS.EMA.TREND.SLOW, values: closes });

    // EMA series (required by strategies/logging)
    const ema5Series = EMA.calculate({ period: 5, values: closes });
    const ema9Series = EMA.calculate({ period: 9, values: closes });
    const ema10Series = EMA.calculate({ period: 10, values: closes });
    const ema12Series = EMA.calculate({ period: 12, values: closes });
    const ema20Series = EMA.calculate({ period: 20, values: closes });
    const ema21Series = EMA.calculate({ period: 21, values: closes });
    const ema26Series = EMA.calculate({ period: 26, values: closes });
    const ema30Series = EMA.calculate({ period: 30, values: closes });
    const ema50Series = EMA.calculate({ period: 50, values: closes });
    const ema100Series = EMA.calculate({ period: 100, values: closes });
    const ema200Series = EMA.calculate({ period: 200, values: closes });

    const ema5 = last(ema5Series);
    const ema9 = last(ema9Series);
    const ema10 = last(ema10Series);
    const emaFast = last(ema12Series);
    const emaSlow = last(ema26Series);
    const ema20 = last(ema20Series);
    const ema21 = last(ema21Series);
    const ema30 = last(ema30Series);
    const ema50 = last(ema50Series);
    const ema100 = last(ema100Series);
    const ema200 = last(ema200Series);

    const ema20Prev = prevOr(ema20Series, ema20);
    const ema30Prev = prevOr(ema30Series, ema30);
    const ema50Prev = prevOr(ema50Series, ema50);
    const ema20Slope = slope(ema20, ema20Prev);
    const ema30Slope = slope(ema30, ema30Prev);
    const ema50Slope = slope(ema50, ema50Prev);

    const emaFastPrev = prevOr(ema12Series, emaFast);
    const emaSlowPrev = prevOr(ema26Series, emaSlow);

    const rsiSeries = RSI.calculate({ period: RSI_PERIOD, values: closes });
    const rsi = last(rsiSeries);
    const rsiPrev = rsiSeries.length > 1 ? rsiSeries[rsiSeries.length - 2] : undefined;

    const bbSeries = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
    const bb = last(bbSeries);

    const adxSeries = ADX.calculate({
        period: RSI_PERIOD,
        close: closes,
        high: highs,
        low: lows,
    });
    const currentADX = last(adxSeries);

    // Keep legacy field names but align trend basis with strategy pickTrend (EMA20/EMA50).
    const maFast = ema20;
    const maSlow = ema50;

    const atrSeries = ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: closes });
    const atr = last(atrSeries);

    const lastClose = closes[closes.length - 1];

    // BackQuant Fourier For Loop signal (uses HLC3 internally)
    const backQuant = calculateBackQuantSignal({
        highs,
        lows,
        closes,
        N: 50,
        start: 1,
        end: 45,
        upper: 40,
        lower: -10,
    });

    const price_vs_ema9 = Number.isFinite(lastClose) && Number.isFinite(ema9) && ema9 !== 0 ? (lastClose - ema9) / ema9 : 0;
    const price_vs_ema21 = Number.isFinite(lastClose) && Number.isFinite(ema21) && ema21 !== 0 ? (lastClose - ema21) / ema21 : 0;
    const price_vs_bb_mid = bb?.middle ? (lastClose - bb.middle) / bb.middle : 0;

    const macdSeries = MACD.calculate({
        ...MACD_CONFIG,
        values: closes,
    });
    const macd = last(macdSeries);
    const macdPrev = macdSeries.length > 1 ? macdSeries[macdSeries.length - 2] : undefined;
    const macdHistPrev = macdPrev ? macdPrev.histogram : undefined;

    const trend = ema20 > ema50 ? "bullish" : ema20 < ema50 ? "bearish" : "neutral";

    return {
        maFast,
        maSlow,
        emaFast,
        emaSlow,

        ema5,
        ema9,
        ema10,
        ema20,
        ema21,
        ema30,
        ema50,
        ema100,
        ema200,

        ema20Prev,
        ema30Prev,
        ema50Prev,
        ema20Slope,
        ema30Slope,
        ema50Slope,

        price_vs_ema9,
        price_vs_ema21,
        price_vs_bb_mid,

        bb,
        lastClose,
        close: lastClose,
        rsi,
        rsiPrev,
        adx: currentADX,
        atr,
        adaptiveRSI: (() => {
            const baseRSI = 50;
            return atr ? baseRSI + Math.min(10, atr * 100) : baseRSI;
        })(),
        adaptiveADX: (() => {
            const baseADX = 20;
            return atr ? baseADX + Math.min(10, atr * 10) : baseADX;
        })(),
        macd,
        macdHistPrev,
        // series removed from payload to keep snapshots light
        trend,
        trendStrength: currentADX,
        trendDetails: {
            adx: currentADX,
            emaFast: emaFast,
            emaSlow: emaSlow,
            emaFastSlope: slope(emaFast, emaFastPrev),
        },
        // Add profitable version indicators
        emaFastTrend: emaFastTrendSeries.length ? last(emaFastTrendSeries) : null,
        emaSlowTrend: emaSlowTrendSeries.length ? last(emaSlowTrendSeries) : null,
        // Store trend state
        isBullishTrend:
            typeof emaFast === "number" &&
            typeof emaSlow === "number" &&
            emaFast > emaSlow &&
            typeof lastClose === "number" &&
            lastClose > emaFast,
        isBullishCross: (() => {
            const ema9Prev = ema9Series[ema9Series.length - 2];
            const ema21Prev = ema21Series[ema21Series.length - 2];
            return (
                typeof ema9 === "number" &&
                typeof ema21 === "number" &&
                typeof ema9Prev === "number" &&
                typeof ema21Prev === "number" &&
                ema9 > ema21 &&
                ema9Prev <= ema21Prev
            );
        })(),
        isBearishCross: (() => {
            const ema9Prev = ema9Series[ema9Series.length - 2];
            const ema21Prev = ema21Series[ema21Series.length - 2];
            return (
                typeof ema9 === "number" &&
                typeof ema21 === "number" &&
                typeof ema9Prev === "number" &&
                typeof ema21Prev === "number" &&
                ema9 < ema21 &&
                ema9Prev >= ema21Prev
            );
        })(),

        // BackQuant Fourier For Loop output
        backQuantScore: backQuant?.score ?? null,
        backQuantSignal: backQuant?.out ?? 0,
        backQuantIsLong: backQuant?.isLong ?? false,
        backQuantIsShort: backQuant?.isShort ?? false,
    };
}
