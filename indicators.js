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
    return {};
  }

  const closes = bars.map((b) => {
    return b.close || b.Close || b.closePrice?.bid || 0;
  });

  // Ensure we have enough data points
  const minLength = Math.max(BOLLINGER.PERIOD, bars.length);

  return {
    maFast: SMA.calculate({ period: MA.FAST, values: closes }).slice(-minLength).pop(),
    maSlow: SMA.calculate({ period: MA.SLOW, values: closes }).slice(-minLength).pop(),
    ema5: EMA.calculate({ period: MA.FAST, values: closes }).pop(),
    ema20: EMA.calculate({ period: MA.SLOW, values: closes }).pop(),
    rsi: RSI.calculate({ period: RSI_CONFIG.PERIOD, values: closes }).pop(),
    bb: BollingerBands.calculate({
      period: BOLLINGER.PERIOD,
      stdDev: BOLLINGER.STD_DEV,
      values: closes,
    }).pop(),
    macd: MACD.calculate({
      fastPeriod: MACD_CONFIG.FAST,
      slowPeriod: MACD_CONFIG.SLOW,
      signalPeriod: MACD_CONFIG.SIGNAL,
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
    const [h4Data, d1Data] = await Promise.all([
      getHistorical(symbol, STRATEGY.ANALYSIS.TIMEFRAMES.TREND, 50),
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
    const h4Trend = h4Indicators.maFast > h4Indicators.maSlow ? "bullish" : "bearish";
    const d1Trend = d1Indicators.maFast > d1Indicators.maSlow ? "bullish" : "bearish";

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
