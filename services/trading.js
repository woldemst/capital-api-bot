import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getHistorical } from "../api.js";

const { RISK: riskConfig } = TRADING;
const { ATR_PERIOD } = ANALYSIS; // ATR period configuration
const RSI_CONFIG = { OVERBOUGHT: 70, OVERSOLD: 30 }; // RSI levels configuration

// === LEGACY: Old m1/m5/m15 logic kept for reference ===
// function generateSignals(symbol, m1Data, m1Indicators, m15Indicators, trendAnalysis, bid, ask) { ... }
// function isBullishMACross(...) { ... }
// function isBearishMACross(...) { ... }
// function isBullishMomentum(...) { ... }
// function isBearishMomentum(...) { ... }
// === END LEGACY ===

// === NEW STRATEGY: Multi-Timeframe (H4/H1/M15) ===

/**
 * Calculate position size based on risk management (NEW STRATEGY)
 * Enforces minimum size of 100 units (1 lot) for all trades.
 */
function positionSize(balance, price, stopLossPips, symbol) {
  const minSize = 100;
  if (!balance || balance <= 0) {
    console.log("[PositionSize] Invalid balance, using minimum position size");
    return minSize;
  }
  const amount = balance * riskConfig.PER_TRADE;
  const slPips = stopLossPips || 10; // fallback if ATR not available
  let size = amount / (slPips * price * 0.01);
  size = Math.max(minSize, Math.round(size));
  size = Math.min(1000, size); // Cap at 1000 units (10 lots)
  console.log(`[PositionSize] Symbol: ${symbol}, Balance: ${balance}, Risk: ${amount}, SL: ${slPips}, Price: ${price}, Size: ${size}`);
  return size;
}

/**
 * Generate trading signals based on H4/H1/M15 indicators (NEW STRATEGY)
 */
function generateSignals(symbol, h4Data, h4Indicators, h1Indicators, m15Indicators, trendAnalysis, bid, ask) {
  if (!validateIndicatorData(h4Data, h4Indicators, h1Indicators, m15Indicators, trendAnalysis)) {
    return { signal: null };
  }
  logMarketConditions(symbol, bid, ask, h4Indicators, h1Indicators, m15Indicators, trendAnalysis);
  const buyConditions = generateBuyConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, bid);
  const sellConditions = generateSellConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, ask);
  // Optionally: logSignalConditions(buyConditions, sellConditions);
  const { signal, buyScore, sellScore } = evaluateSignals(buyConditions, sellConditions);
  return {
    signal,
    buyScore,
    sellScore,
    metrics: extractMetrics(m15Indicators),
  };
}

function validateIndicatorData(h4Data, h4Indicators, h1Indicators, m15Indicators, trendAnalysis) {
  if (!h4Data || !h4Indicators || !h1Indicators || !m15Indicators || !trendAnalysis) {
    console.log('[Signal] Missing required indicators data');
    return false;
  }
  return true;
}

function logMarketConditions(symbol, bid, ask, h4Indicators, h1Indicators, m15Indicators, trendAnalysis) {
  console.log(`\n=== Analyzing ${symbol} ===`);
  console.log('Current price:', { bid, ask });
  console.log('[H4] EMA50:', h4Indicators.ema50, 'EMA200:', h4Indicators.ema200, 'MACD:', h4Indicators.macd?.histogram);
  console.log('[H1] EMA9:', h1Indicators.ema9, 'EMA21:', h1Indicators.ema21, 'RSI:', h1Indicators.rsi);
  console.log('[M15] EMA9:', m15Indicators.ema9, 'EMA21:', m15Indicators.ema21, 'RSI:', m15Indicators.rsi, 'BB:', m15Indicators.bb);
  console.log('Trend:', trendAnalysis.h4Trend);
}

function generateBuyConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, bid) {
  return [
    h4Indicators.isBullishTrend || (h4Indicators.macd && h4Indicators.macd.histogram > 0),
    trendAnalysis.h4Trend === "bullish",
    h1Indicators.ema9 > h1Indicators.ema21, // H1 setup confirmation
    m15Indicators.isBullishCross, // EMA9 crosses above EMA21
    m15Indicators.rsi < 35,       // RSI oversold
    bid <= m15Indicators.bb?.lower // Price at/below lower BB
  ];
}
function generateSellConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, ask) {
  return [
    !h4Indicators.isBullishTrend || (h4Indicators.macd && h4Indicators.macd.histogram < 0),
    trendAnalysis.h4Trend === "bearish",
    h1Indicators.ema9 < h1Indicators.ema21, // H1 setup confirmation
    m15Indicators.isBearishCross, // EMA9 crosses below EMA21
    m15Indicators.rsi > 65,       // RSI overbought
    ask >= m15Indicators.bb?.upper // Price at/above upper BB
  ];
}

class TradingService {
  constructor() {
    this.openTrades = [];
    this.accountBalance = 0;
    this.profitThresholdReached = false;
    this.symbolMinSizes = {};
    this.virtualBalance = 10000;
    this.virtualPositions = [];
    this.orderAttempts = new Map();
  }

  setAccountBalance(balance) { this.accountBalance = balance; }
  setOpenTrades(trades) { this.openTrades = trades; }
  setProfitThresholdReached(reached) { this.profitThresholdReached = reached; }
  setSymbolMinSizes(minSizes) { this.symbolMinSizes = minSizes; }
  isSymbolTraded(symbol) { return this.openTrades.includes(symbol); }

  validatePrices(bid, ask, symbol) {
    if (typeof bid !== "number" || typeof ask !== "number" || isNaN(bid) || isNaN(ask)) {
      console.error(`[PriceValidation] Invalid prices for ${symbol}. Bid: ${bid}, Ask: ${ask}`);
      return false;
    }
    return true;
  }

  /**
   * Generate and validate signal for the new strategy (H4/H1/M15)
   */
  async generateAndValidateSignal(candle, message, symbol, bid, ask) {
    const indicators = candle.indicators || {};
    const trendAnalysis = message.payload.trendAnalysis;
    return generateSignals(symbol, message.h4Data, indicators.h4, indicators.h1, indicators.m15, trendAnalysis, bid, ask);
  }

  /**
   * Main trade execution logic for the new strategy
   */
  async executeTrade(signal, symbol, bid, ask, metrics) {
    console.log(`\n🎯 ${symbol} ${signal.toUpperCase()} signal generated!`);
    const params = await this.calculateTradeParameters(signal, symbol, bid, ask);
    this.logTradeParameters(signal, params.size, params.stopLossPrice, params.takeProfitPrice, params.stopLossPips);
    try {
      await this.executePosition(signal, symbol, params);
    } catch (error) {
      console.error(`[TradeExecution] Failed for ${symbol}:`, error);
      throw error;
    }
  }

  /**
   * Calculate trade parameters (stop, target, size, trailing)
   */
  async calculateTradeParameters(signal, symbol, bid, ask) {
    const price = signal === 'buy' ? ask : bid;
    const atr = await this.calculateATR(symbol);
    const stopLossPips = 1.5 * atr;
    const stopLossPrice = signal === 'buy' ? price - stopLossPips : price + stopLossPips;
    const takeProfitPips = 2 * stopLossPips;
    const takeProfitPrice = signal === 'buy' ? price + takeProfitPips : price - takeProfitPips;
    const size = positionSize(this.accountBalance, price, stopLossPips, symbol);
    const trailingStopParams = {
      activationPrice: signal === 'buy' ? price + (stopLossPips * 0.5) : price - (stopLossPips * 0.5),
      trailingDistance: atr
    };
    return { size, stopLossPrice, takeProfitPrice, stopLossPips, takeProfitPips, trailingStopParams };
  }

  logTradeParameters(signal, size, stopLossPrice, takeProfitPrice, stopLossPips) {
    console.log(`[TradeParams] Entry: ${signal.toUpperCase()} | Size: ${size} | SL: ${stopLossPrice} (${stopLossPips}) | TP: ${takeProfitPrice}`);
  }

  /**
   * Place position and set up trailing stop (partial TP placeholder)
   */
  async executePosition(signal, symbol, params) {
    const { size, stopLossPrice, takeProfitPrice, trailingStopParams } = params;
    // TODO: Implement partial take profit logic if supported by broker API
    try {
      const position = await placePosition(symbol, signal, size, null, stopLossPrice, takeProfitPrice);
      if (position.dealId) {
        await this.setupTrailingStop(symbol, signal, position.dealId, trailingStopParams);
      }
      return position;
    } catch (error) {
      console.error(`[Position] Failed for ${symbol}:`, error);
      throw error;
    }
  }

  async setupTrailingStop(symbol, signal, entryPrice, trailingStopParams) {
    setTimeout(async () => {
      try {
        const positions = await getOpenPositions();
        const position = positions.positions.find((p) => p.market.epic === symbol);
        if (position && position.profit > 0) {
          // Trailing stop logic here
        }
      } catch (error) {
        console.error("[TrailingStop] Error:", error.message);
      }
    }, 5 * 60 * 1000); // Check after 5 minutes
  }

  async calculateATR(symbol) {
    try {
      const data = await getHistorical(symbol, ANALYSIS.TIMEFRAMES.ENTRY, 15);
      if (!data?.prices || data.prices.length < 14) {
        throw new Error("Insufficient data for ATR calculation");
      }
      let tr = [];
      const prices = data.prices;
      for (let i = 1; i < prices.length; i++) {
        const high = prices[i].highPrice?.ask || prices[i].high;
        const low = prices[i].lowPrice?.bid || prices[i].low;
        const prevClose = prices[i-1].closePrice?.bid || prices[i-1].close;
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        tr.push(Math.max(tr1, tr2, tr3));
      }
      const atr = tr.slice(-14).reduce((sum, val) => sum + val, 0) / 14;
      return atr;
    } catch (error) {
      console.error("[ATR] Error:", error);
      return 0.0010;
    }
  }

  /**
   * Main entry point for processing a new price update
   */
  async processPrice(message, maxOpenTrades) {
    let symbol = null;
    try {
      if (!message || !message.payload) {
        console.log("[ProcessPrice] Invalid message format:", message);
        return;
      }
      const candle = message.payload;
      symbol = candle.epic;
      console.log(`\n=== Processing ${symbol} ===`);
      console.log(`[ProcessPrice] Open trades: ${this.openTrades.length}/${maxOpenTrades} | Balance: ${this.accountBalance}€`);
      if (this.openTrades.length >= maxOpenTrades) {
        console.log(`[ProcessPrice] Max trades reached. Skipping ${symbol}.`);
        return;
      }
      if (this.isSymbolTraded(symbol)) {
        console.log(`[ProcessPrice] ${symbol} already has an open position.`);
        return;
      }
      // Trading hours: 12-16 UTC (London/NY overlap)
if (hour < 6 || hour > 22) {
  console.log(`[ProcessPrice] Outside main trading session. Skipping ${symbol}.`);
  return;
}
      // Extract bid/ask
      const bid = candle.bid || candle.closePrice?.bid || candle.c || candle.close;
      const ask = candle.ask || candle.closePrice?.ask || candle.c || candle.close;
      if (!this.validatePrices(bid, ask, symbol)) return;
      // Get indicators and generate signal
      const { signal, metrics } = await this.generateAndValidateSignal(candle, message, symbol, bid, ask);
      if (signal) {
        await this.executeTrade(signal, symbol, bid, ask, metrics);
      }
    } catch (error) {
      console.error(`[ProcessPrice] Error for ${symbol}:`, error.message);
    }
  }
}

export default new TradingService();
