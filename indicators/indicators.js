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
    const closes = stableBars.map((b) => b.close || b.Close || b.closePrice?.bid || 0);
    const highs = stableBars.map((b) => b.high || b.High || b.highPrice?.bid || 0);
    const lows = stableBars.map((b) => b.low || b.Low || b.lowPrice?.bid || 0);

    const last = (series) => (Array.isArray(series) && series.length ? series[series.length - 1] : undefined);

    // Keep only indicator fields that are currently used for decisions/logging.
    const ema9 = last(EMA.calculate({ period: 9, values: closes }));
    const ema20 = last(EMA.calculate({ period: 20, values: closes }));
    const ema50 = last(EMA.calculate({ period: 50, values: closes }));

    const rsiSeries = RSI.calculate({ period: RSI_PERIOD, values: closes });
    const rsi = last(rsiSeries);
    const rsiPrev = rsiSeries.length > 1 ? rsiSeries[rsiSeries.length - 2] : undefined;

    const bb = last(BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes }));

    const adx = last(
        ADX.calculate({
            period: ADX_PERIOD,
            close: closes,
            high: highs,
            low: lows,
        }),
    );

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
    const macdHistPrev = macdPrev?.histogram;

    const lastClose = closes[closes.length - 1];
    const price_vs_ema9 = Number.isFinite(lastClose) && Number.isFinite(ema9) && ema9 !== 0 ? (lastClose - ema9) / ema9 : null;

    const trend = ema20 > ema50 ? "bullish" : ema20 < ema50 ? "bearish" : "neutral";

    return {
        ema9,
        ema20,
        ema50,
        price_vs_ema9,
        bb,
        lastClose,
        close: lastClose,
        rsi,
        rsiPrev,
        adx,
        atr,
        macd,
        macdHistPrev,
        trend,
    };
}

export async function tradeWatchIndicators(bars) {
    const closes = bars.map((b) => b.close || b.Close || b.closePrice?.bid || 0);
    const highs = bars.map((b) => b.high || b.High || b.highPrice?.bid || 0);
    const lows = bars.map((b) => b.low || b.Low || b.lowPrice?.bid || 0);
}
