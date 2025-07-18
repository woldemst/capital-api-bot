import { EMA, RSI, BollingerBands, MACD, ATR } from "technicalindicators";
import { ANALYSIS } from "./config.js";
import logger from "./utils/logger.js";

const {
  RSI: RSI_CONFIG,
  MACD: MACD_CONFIG,
  BOLLINGER,
  ATR: ATR_CONFIG,
} = ANALYSIS;

export async function calcIndicators(
  bars,
  symbol = "",
  timeframe = "",
  priceType = "mid"
) {
  if (!bars || !Array.isArray(bars) || bars.length === 0) {
    logger.error(
      `[Indicators] No bars provided for indicator calculation for ${symbol} ${timeframe}`
    );
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

  // Essential indicators per strategy
  const emaFast = EMA.calculate({
    period: ANALYSIS.EMA.TREND.FAST,
    values: closes,
  });
  const emaSlow = EMA.calculate({
    period: ANALYSIS.EMA.TREND.SLOW,
    values: closes,
  });
  const ema9 = EMA.calculate({
    period: ANALYSIS.EMA.ENTRY.FAST,
    values: closes,
  });
  const ema21 = EMA.calculate({
    period: ANALYSIS.EMA.ENTRY.SLOW,
    values: closes,
  });

  // Use library ATR for consistency
  const atrArr = ATR.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes,
  });
  const atr = atrArr.length ? atrArr[atrArr.length - 1] : null;

  const result = {
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
      emaFast.length &&
      emaSlow.length &&
      emaFast[emaFast.length - 1] > emaSlow[emaSlow.length - 1] &&
      closes[closes.length - 1] > emaFast[emaFast.length - 1],
    isBullishCross:
      ema9.length > 1 &&
      ema21.length > 1 &&
      ema9[ema9.length - 1] > ema21[ema21.length - 1] &&
      ema9[ema9.length - 2] <= ema21[ema21.length - 2],
    isBearishCross:
      ema9.length > 1 &&
      ema21.length > 1 &&
      ema9[ema9.length - 1] < ema21[ema21.length - 1] &&
      ema9[ema9.length - 2] >= ema21[ema21.length - 2],
  };
  // Removed obsolete logger.indicator call (no longer needed)
  return result;
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
    const h4Trend =
      h4Indicators.emaFast > h4Indicators.emaSlow ? "bullish" : "bearish";
    const d1Trend =
      d1Indicators.emaFast > d1Indicators.emaSlow ? "bullish" : "bearish";

    console.log(`${symbol} H4 Trend: ${h4Trend}, D1 Trend: ${d1Trend}`);

    return {
      h4Trend,
      d1Trend,
      h4Indicators,
      d1Indicators,
      overallTrend:
        h4Trend === "bullish" && d1Trend === "bullish"
          ? "bullish"
          : h4Trend === "bearish" && d1Trend === "bearish"
          ? "bearish"
          : "mixed",
    };
  } catch (error) {
    console.error(`Error analyzing trend for ${symbol}:`, error);
    return { overallTrend: "unknown" };
  }
}

/**
 * Detects trend weakness based on indicator values.
 * Returns true if trend is weak (e.g., EMA cross against position, MACD/RSI reversal, or price below EMA).
 * @param {Object} indicators - Output from calcIndicators
 * @param {string} direction - 'BUY' or 'SELL'
 */
export function isTrendWeak(indicators, direction) {
  if (!indicators) return false;
  // Weakness for BUY: bearish cross, MACD < 0, RSI falling
  if (direction === "BUY") {
    return (
      indicators.isBearishCross ||
      (indicators.macd && indicators.macd.histogram < 0) ||
      (indicators.rsi && indicators.rsi < 50)
    );
  }
  // Weakness for SELL: bullish cross, MACD > 0, RSI rising
  if (direction === "SELL") {
    return (
      indicators.isBullishCross ||
      (indicators.macd && indicators.macd.histogram > 0) ||
      (indicators.rsi && indicators.rsi > 50)
    );
  }
  return false;
}

/**
 * Calculates the percentage of TP achieved.
 * @param {number} entry - Entry price
 * @param {number} current - Current price
 * @param {number} tp - Take profit price
 * @param {string} direction - 'BUY' or 'SELL'
 * @returns {number} - Percentage of TP achieved (0-100)
 */
export function getTPProgress(entry, current, tp, direction) {
  if (!entry || !current || !tp) return 0;
  if (direction === "BUY") {
    if (tp <= entry) return 0;
    return Math.max(0, Math.min(100, ((current - entry) / (tp - entry)) * 100));
  } else {
    if (tp >= entry) return 0;
    return Math.max(0, Math.min(100, ((entry - current) / (entry - tp)) * 100));
  }
}
