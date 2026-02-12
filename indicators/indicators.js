import { EMA, RSI, BollingerBands, MACD, ADX, ATR } from "technicalindicators";

const RSI_PERIOD = 14;
const ADX_PERIOD = 14;
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

    // Use closed candles only to avoid indicator drift from a still-forming live bar.
    const stableBars = bars.length > 1 ? bars.slice(0, -1) : bars;
    const toNum = (value) => {
        const num = typeof value === "number" ? value : Number(value);
        return Number.isFinite(num) ? num : null;
    };
    const normalizedBars = stableBars
        .map((b) => ({
            close: toNum(b?.close ?? b?.Close ?? b?.closePrice?.bid),
            high: toNum(b?.high ?? b?.High ?? b?.highPrice?.bid),
            low: toNum(b?.low ?? b?.Low ?? b?.lowPrice?.bid),
        }))
        .filter((b) => b.close !== null && b.high !== null && b.low !== null);

    if (!normalizedBars.length) return null;

    const closes = normalizedBars.map((b) => b.close);
    const highs = normalizedBars.map((b) => b.high);
    const lows = normalizedBars.map((b) => b.low);

    const last = (series) => (Array.isArray(series) && series.length ? series[series.length - 1] : undefined);

    // Keep only indicator fields that are currently used for decisions/logging.
    const ema9 = last(EMA.calculate({ period: 9, values: closes }));
    const ema20 = last(EMA.calculate({ period: 20, values: closes }));
    const ema50 = last(EMA.calculate({ period: 50, values: closes }));

    const rsiSeries = RSI.calculate({ period: RSI_PERIOD, values: closes });
    const rsi = last(rsiSeries);
    const rsiPrev = rsiSeries.length > 1 ? rsiSeries[rsiSeries.length - 2] : undefined;

    const bb = last(BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes }));

    const adxSeries = ADX.calculate({
        period: ADX_PERIOD,
        close: closes,
        high: highs,
        low: lows,
    });
    const adx = last(adxSeries);
    const adxPrev = adxSeries.length > 1 ? adxSeries[adxSeries.length - 2] : undefined;
    const adxValue = Number.isFinite(adx?.adx) ? adx.adx : Number.isFinite(adx) ? adx : null;
    const adxPrevValue = Number.isFinite(adxPrev?.adx) ? adxPrev.adx : Number.isFinite(adxPrev) ? adxPrev : null;

    const atr = last(
        ATR.calculate({
            period: ATR_PERIOD,
            high: highs,
            low: lows,
            close: closes,
        }),
    );

    const macdSeries = MACD.calculate({
        ...MACD_CONFIG,
        values: closes,
    });
    const macd = last(macdSeries);
    const macdPrev = macdSeries.length > 1 ? macdSeries[macdSeries.length - 2] : undefined;
    const macdHist = Number.isFinite(macd?.histogram) ? macd.histogram : null;
    const macdHistPrev = Number.isFinite(macdPrev?.histogram) ? macdPrev.histogram : null;

    const lastClose = closes[closes.length - 1];
    const price_vs_ema9 = Number.isFinite(lastClose) && Number.isFinite(ema9) && ema9 !== 0 ? (lastClose - ema9) / ema9 : null;
    const atrPct = Number.isFinite(atr) && Number.isFinite(lastClose) && lastClose !== 0 ? atr / lastClose : null;
    const bbWidth =
        Number.isFinite(bb?.upper) && Number.isFinite(bb?.lower) && Number.isFinite(bb?.middle) && bb.middle !== 0
            ? (bb.upper - bb.lower) / bb.middle
            : null;
    const ema20_50_spreadPct = Number.isFinite(ema20) && Number.isFinite(ema50) && ema50 !== 0 ? (ema20 - ema50) / ema50 : null;
    const adxSlope = Number.isFinite(adxValue) && Number.isFinite(adxPrevValue) ? adxValue - adxPrevValue : null;
    const macdHistSlope = Number.isFinite(macdHist) && Number.isFinite(macdHistPrev) ? macdHist - macdHistPrev : null;

    const trend = Number.isFinite(ema20) && Number.isFinite(ema50) ? (ema20 > ema50 ? "bullish" : ema20 < ema50 ? "bearish" : "neutral") : "neutral";

    return {
        ema9: Number.isFinite(ema9) ? ema9 : null,
        ema20: Number.isFinite(ema20) ? ema20 : null,
        ema50: Number.isFinite(ema50) ? ema50 : null,
        price_vs_ema9,
        bb: bb ?? null,
        lastClose: Number.isFinite(lastClose) ? lastClose : null,
        close: Number.isFinite(lastClose) ? lastClose : null,
        rsi: Number.isFinite(rsi) ? rsi : null,
        rsiPrev: Number.isFinite(rsiPrev) ? rsiPrev : null,
        adx: adx ?? null,
        atr: Number.isFinite(atr) ? atr : null,
        macd: macd ?? null,
        macdHistPrev,
        atrPct,
        bbWidth,
        ema20_50_spreadPct,
        adxSlope,
        macdHistSlope,
        trend,
    };
}

export async function tradeWatchIndicators(bars) {
    const closes = bars.map((b) => b.close || b.Close || b.closePrice?.bid || 0);
    const highs = bars.map((b) => b.high || b.High || b.highPrice?.bid || 0);
    const lows = bars.map((b) => b.low || b.Low || b.lowPrice?.bid || 0);
}
