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

  // Calculate EMAs for trend and entry
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });

  return {
    // Trend EMAs
    ema50: ema50.pop(),
    ema200: ema200.pop(),
    
    // Entry EMAs
    ema9: ema9.pop(),
    ema21: ema21.pop(),
    
    // RSI
    rsi: RSI.calculate({ period: RSI_CONFIG.PERIOD, values: closes }).pop(),
    
    // Bollinger Bands
    bb: BollingerBands.calculate({
      period: BOLLINGER.PERIOD,
      stdDev: BOLLINGER.STD_DEV,
      values: closes,
    }).pop(),
    
    // MACD
    macd: MACD.calculate({
      fastPeriod: MACD_CONFIG.FAST,
      slowPeriod: MACD_CONFIG.SLOW,
      signalPeriod: MACD_CONFIG.SIGNAL,
      values: closes,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    }).pop(),

    // Store trend state
    isBullishTrend: ema50[ema50.length - 1] > ema200[ema200.length - 1],
    isBullishCross: ema9[ema9.length - 1] > ema21[ema21.length - 1] && 
                    ema9[ema9.length - 2] <= ema21[ema21.length - 2],
    isBearishCross: ema9[ema9.length - 1] < ema21[ema21.length - 1] && 
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
