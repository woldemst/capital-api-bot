import { SMA, EMA, RSI, BollingerBands, MACD, ADX, ATR } from "technicalindicators";
import { ANALYSIS } from "../config.js";
import { calculateBackQuantSignal } from "./BackQuant.js";

export async function calcIndicators(bars) {
    if (!bars || !Array.isArray(bars) || bars.length === 0) {
        return null;
    }

    const closes = bars.map((b) => b.close || b.Close || b.closePrice?.bid || 0);
    const highs = bars.map((b) => b.high || b.High || b.highPrice?.bid || 0);
    const lows = bars.map((b) => b.low || b.Low || b.lowPrice?.bid || 0);

    // Add the essential trend EMAs from old version
    const emaFastTrendSeries = EMA.calculate({ period: ANALYSIS.EMA.TREND.FAST, values: closes });
    const emaSlowTrendSeries = EMA.calculate({ period: ANALYSIS.EMA.TREND.SLOW, values: closes });

    // EMA series and helpers (needed for Calm River)
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

    // Latest EMA values
    const ema5 = ema5Series[ema5Series.length - 1];
    const ema9 = ema9Series[ema9Series.length - 1];
    const ema10 = ema10Series[ema10Series.length - 1];
    const emaFast = ema12Series[ema12Series.length - 1];
    const emaSlow = ema26Series[ema26Series.length - 1];
    const ema20Val = ema20Series[ema20Series.length - 1];
    const ema30Val = ema30Series[ema30Series.length - 1];
    const ema50Val = ema50Series[ema50Series.length - 1];
    const ema20 = ema20Val;
    const ema21 = ema21Series[ema21Series.length - 1];
    const ema30 = ema30Val;
    const ema50 = ema50Val;
    const ema100 = ema100Series[ema100Series.length - 1];
    const ema200 = ema200Series[ema200Series.length - 1];

    // EMA prevs 
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

    const bb = bbSeries.length > 0 ? bbSeries[bbSeries.length - 1] : undefined;
    const emaFastPrev = ema12Series[ema12Series.length - 2] ?? emaFast;
    const emaSlowPrev = ema26Series[ema26Series.length - 2] ?? emaSlow;

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

    // Add ATR calculation from old version (more accurate)
    const tr = [];
    for (let i = 1; i < bars.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        tr.push(Math.max(hl, hc, lc));
    }
    const trWindow = tr.slice(-14);
    const atrManual = trWindow.length ? trWindow.reduce((sum, val) => sum + val, 0) / trWindow.length : undefined;
    const atrSeries = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const atrVal = atrSeries[atrSeries.length - 1];
    const atr = Number.isFinite(atrVal) ? atrVal : atrManual;
    const lastClose = closes[closes.length - 1];

    // BackQuant Fourier For Loop signal (uses HLC3 internally)
    const backQuant = calculateBackQuantSignal({
        highs,
        lows,
        closes,
        // You can tweak these values or later move them into ANALYSIS config
        N: 50,
        start: 1,
        end: 45,
        upper: 40,
        lower: -10,
    });

    const price_vs_ema9 = (lastClose - ema9) / ema9;
    const price_vs_ema21 = (lastClose - ema21) / ema21;
    const price_vs_bb_mid = bb && bb.middle ? (lastClose - bb.middle) / bb.middle : 0;

    const macdSeries = MACD.calculate({
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        values: closes,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
    });
    const macd = macdSeries[macdSeries.length - 1];
    const macdPrev = macdSeries[macdSeries.length - 2];
    const macdHistPrev = macdPrev ? macdPrev.histogram : undefined;
    const rsiPrev = rsiSeries.length > 1 ? rsiSeries[rsiSeries.length - 2] : undefined;
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
        // keep short tails to avoid heavy payloads

        price_vs_ema9,
        price_vs_ema21,
        price_vs_bb_mid,

        bb,
        lastClose,
        close: lastClose,
        rsi: rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : undefined,
        rsiPrev,
        adx: currentADX,
        atr: atr,
        adaptiveRSI: (() => {
            const baseRSI = 50;
            return atrVal ? baseRSI + Math.min(10, atrVal * 100) : baseRSI;
        })(),
        adaptiveADX: (() => {
            const baseADX = 20;
            return atrVal ? baseADX + Math.min(10, atrVal * 10) : baseADX;
        })(),
        macd,
        macdHistPrev,
        // --- Added series for strategies ---
        // series removed from payload to keep snapshots light
        trend: maFast > maSlow ? "bullish" : maFast < maSlow ? "bearish" : "neutral",
        trendStrength: currentADX,
        trendDetails: {
            adx: currentADX,
            emaFast: emaFast,
            emaSlow: emaSlow,
            emaFastSlope: typeof emaFast === "number" && typeof emaFastPrev === "number" ? emaFast - emaFastPrev : 0,
        },
        // Add profitable version indicators
        emaFastTrend: emaFastTrendSeries.length ? emaFastTrendSeries[emaFastTrendSeries.length - 1] : null,
        emaSlowTrend: emaSlowTrendSeries.length ? emaSlowTrendSeries[emaSlowTrendSeries.length - 1] : null,
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
