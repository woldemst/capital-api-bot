import { SMA, EMA, RSI, BollingerBands, MACD } from "technicalindicators";
import { ANALYSIS } from "./config.js";

const {
  MA,
  RSI: RSI_CONFIG,
  MACD: MACD_CONFIG,
  BOLLINGER,
  ATR: ATR_CONFIG,

  MA_FAST,
  MA_SLOW,
  MA_TREND,
  MA_LONG,

  RSI_PERIOD,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,


} = ANALYSIS;

export async function calcIndicators(bars) {
  if (!bars || !Array.isArray(bars) || bars.length === 0) {
    console.warn("[Indicators] No bars provided for indicator calculation.");
    return {};
  }

  const closes = bars.map((b) => b.close || b.Close || b.closePrice?.bid || 0);
  const highs = bars.map((b) => b.high || b.High || b.highPrice?.bid || 0);
  const lows = bars.map((b) => b.low || b.Low || b.lowPrice?.bid || 0);

  // Essential indicators per strategy
  const emaFast = EMA.calculate({ period: ANALYSIS.EMA.TREND.FAST, values: closes });
  const emaSlow = EMA.calculate({ period: ANALYSIS.EMA.TREND.SLOW, values: closes });
  const ema9 = EMA.calculate({ period: ANALYSIS.EMA.ENTRY.FAST, values: closes });
  const ema21 = EMA.calculate({ period: ANALYSIS.EMA.ENTRY.SLOW, values: closes });

  // Calculate ATR for dynamic stops
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }
  const atr = tr.slice(-14).reduce((sum, val) => sum + val, 0) / 14;

  return {
    // Trend EMAs
    emaFast: emaFast.length ? emaFast[emaFast.length - 1] : null,
    emaSlow: emaSlow.length ? emaSlow[emaSlow.length - 1] : null,
    // Entry EMAs
    ema9: ema9.length ? ema9[ema9.length - 1] : null,
    ema21: ema21.length ? ema21[ema21.length - 1] : null,
    // Previous values for crossover detection
    ema9Prev: ema9.length > 1 ? ema9[ema9.length - 2] : null,
    ema21Prev: ema21.length > 1 ? ema21[ema21.length - 2] : null,
    // RSI
    rsi: RSI.calculate({ period: RSI_CONFIG.PERIOD, values: closes }).pop(),
    // Bollinger Bands
    bb: BollingerBands.calculate({
      period: BOLLINGER.PERIOD,
      stdDev: BOLLINGER.STD_DEV,
      values: closes,
    }).pop(),
    // MACD for trend confirmation
    macd: MACD.calculate({
      fastPeriod: MACD_CONFIG.FAST,
      slowPeriod: MACD_CONFIG.SLOW,
      signalPeriod: MACD_CONFIG.SIGNAL,
      values: closes,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    }).pop(),
    // ATR for dynamic stops
    atr: atr,
    // Store trend state
    isBullishTrend: 
      emaFast.length && emaSlow.length && 
      emaFast[emaFast.length - 1] > emaSlow[emaSlow.length - 1] && 
      closes[closes.length - 1] > emaFast[emaFast.length - 1],
    isBullishCross: 
      ema9.length > 1 && ema21.length > 1 && 
      ema9[ema9.length - 1] > ema21[ema21.length - 1] && 
      ema9[ema9.length - 2] <= ema21[ema21.length - 2],
    isBearishCross: 
      ema9.length > 1 && ema21.length > 1 && 
      ema9[ema9.length - 1] < ema21[ema21.length - 1] && 
      ema9[ema9.length - 2] >= ema21[ema21.length - 2],
  };
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

    // Determine trend direction
    const h4Trend = h4Indicators.emaFast > h4Indicators.emaSlow ? "bullish" : "bearish";
    const d1Trend = d1Indicators.emaFast > d1Indicators.emaSlow ? "bullish" : "bearish";

    console.log(`${symbol} H4 Trend: ${h4Trend}, D1 Trend: ${d1Trend}`);

    return {
      h4Trend,
      d1Trend,
      h4Indicators,
      d1Indicators,
      overallTrend:
        h4Trend === "bullish" && d1Trend === "bullish" ? "bullish" : h4Trend === "bearish" && d1Trend === "bearish" ? "bearish" : "mixed",
    };
  } catch (error) {
    console.error(`Error analyzing trend for ${symbol}:`, error);
    return { overallTrend: "unknown" };
  }
}
