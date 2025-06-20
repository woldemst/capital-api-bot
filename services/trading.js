import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getHistorical } from "../api.js";

const RSI_CONFIG = {
  OVERBOUGHT: 70,
  OVERSOLD: 30,
  EXIT_OVERBOUGHT: 65,
  EXIT_OVERSOLD: 35,
}; // Added missing properties

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

  setAccountBalance(balance) {
    this.accountBalance = balance;
  }
  setOpenTrades(trades) {
    this.openTrades = trades;
  }
  setProfitThresholdReached(reached) {
    this.profitThresholdReached = reached;
  }
  setSymbolMinSizes(minSizes) {
    this.symbolMinSizes = minSizes;
  }
  isSymbolTraded(symbol) {
    return this.openTrades.includes(symbol);
  }

  validatePrices(bid, ask, symbol) {
    if (typeof bid !== "number" || typeof ask !== "number" || isNaN(bid) || isNaN(ask)) {
      console.error(`[PriceValidation] Invalid prices for ${symbol}. Bid: ${bid}, Ask: ${ask}`);
      return false;
    }
    return true;
  }
  validateIndicatorData(h4Data, h4Indicators, h1Indicators, m15Indicators, trendAnalysis) {
    if (!h4Data || !h4Indicators || !h1Indicators || !m15Indicators || !trendAnalysis) {
      console.log("[Signal] Missing required indicators data");
      return false;
    }
    return true;
  }
  logMarketConditions(symbol, bid, ask, h4Indicators, h1Indicators, m15Indicators, trendAnalysis) {
    // console.log(`\n=== Analyzing ${symbol} ===`);
    // console.log("Current price:", { bid, ask });
    // console.log("[H4] EMA Fast:", h4Indicators.emaFast, "EMA Slow:", h4Indicators.emaSlow, "MACD:", h4Indicators.macd?.histogram);
    // console.log("[H1] EMA9:", h1Indicators.ema9, "EMA21:", h1Indicators.ema21, "RSI:", h1Indicators.rsi);
    // console.log("[M15] EMA9:", m15Indicators.ema9, "EMA21:", m15Indicators.ema21, "RSI:", m15Indicators.rsi, "BB:", m15Indicators.bb);
    // console.log("Trend:", trendAnalysis.h4Trend);
  }

  evaluateSignals(buyConditions, sellConditions) {
    const buyScore = buyConditions.filter(Boolean).length;
    const sellScore = sellConditions.filter(Boolean).length;
    console.log(`[Signal] BuyScore: ${buyScore}/${buyConditions.length}, SellScore: ${sellScore}/${sellConditions.length}`);
    let signal = null;
    // Relaxed: only 3/6 conditions needed for a signal
    if (buyScore >= 3) {
      signal = "buy";
    } else if (sellScore >= 3) {
      signal = "sell";
    }
    return { signal, buyScore, sellScore };
  }

  async generateAndValidateSignal(candle, message, symbol, bid, ask) {
    const indicators = candle.indicators || {};
    // Log all indicator values for debugging
    // console.log(`[Signal] Generating signal for ${symbol}`);
    // console.log("[Indicators] H4:", indicators.h4);
    // console.log("[Indicators] H1:", indicators.h1);
    // console.log("[Indicators] M15:", indicators.m15);
    const trendAnalysis = message.trendAnalysis;
    const result = this.generateSignals(symbol, message.h4Data, indicators.h4, indicators.h1, indicators.m15, trendAnalysis, bid, ask);
    if (!result.signal) {
      console.log(`[Signal] No valid signal for ${symbol}. BuyScore: ${result.buyScore}, SellScore: ${result.sellScore}`);
    } else {
      console.log(`[Signal] Signal for ${symbol}: ${result.signal.toUpperCase()}`);
    }
    return result;
  }
  generateBuyConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, bid) {
    return [
      // H4 Trend conditions
      h4Indicators.emaFast > h4Indicators.emaSlow, // Primary trend filter
      h4Indicators.macd?.histogram > 0, // Trend confirmation

      // H1 Setup confirmation
      h1Indicators.ema9 > h1Indicators.ema21,
      h1Indicators.rsi < RSI_CONFIG.EXIT_OVERSOLD, // Slightly relaxed RSI

      // M15 Entry conditions
      m15Indicators.isBullishCross,
      m15Indicators.rsi < RSI_CONFIG.OVERSOLD,
      bid <= m15Indicators.bb?.lower,
    ];
  }

  generateSellConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, ask) {
    return [
      // H4 Trend conditions
      !h4Indicators.isBullishTrend,
      h4Indicators.macd?.histogram < 0,

      // H1 Setup confirmation
      h1Indicators.ema9 < h1Indicators.ema21,
      h1Indicators.rsi > RSI_CONFIG.EXIT_OVERBOUGHT,

      // M15 Entry conditions
      m15Indicators.isBearishCross,
      m15Indicators.rsi > RSI_CONFIG.OVERBOUGHT,
      ask >= m15Indicators.bb?.upper,
    ];
  }

  async executeTrade(signal, symbol, bid, ask) {
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

  async calculateTradeParameters(signal, symbol, bid, ask) {
    const price = signal === "buy" ? ask : bid;
    const atr = await this.calculateATR(symbol);
    const stopLossPips = 1.5 * atr;
    const stopLossPrice = signal === "buy" ? price - stopLossPips : price + stopLossPips;
    const takeProfitPips = 2 * stopLossPips; // 2:1 reward-risk ratio
    const takeProfitPrice = signal === "buy" ? price + takeProfitPips : price - takeProfitPips;
    const size = this.positionSize(this.accountBalance, price, stopLossPips, symbol);

    // Trailing stop parameters
    const trailingStopParams = {
      activationPrice:
        signal === "buy"
          ? price + stopLossPips // Activate at 1R profit
          : price - stopLossPips,
      trailingDistance: atr, // Trail by 1 ATR
    };

    return {
      size,
      stopLossPrice,
      takeProfitPrice,
      stopLossPips,
      takeProfitPips,
      trailingStopParams,
      partialTakeProfit:
        signal === "buy"
          ? price + stopLossPips // Take partial at 1R
          : price - stopLossPips,
    };
  }

  logTradeParameters(signal, size, stopLossPrice, takeProfitPrice, stopLossPips) {
    console.log(
      `[TradeParams] Entry: ${signal.toUpperCase()} | Size: ${size} | SL: ${stopLossPrice} (${stopLossPips}) | TP: ${takeProfitPrice}`
    );
  }

  async executePosition(signal, symbol, params) {
    const { size, stopLossPrice, takeProfitPrice, trailingStopParams } = params;
    try {
      const position = await placePosition(symbol, signal, size, null, stopLossPrice, takeProfitPrice);
      if (position?.dealId) {
        await this.setupTrailingStop(symbol, signal, position.dealId, trailingStopParams);
      }
      return position;
    } catch (error) {
      console.error(`[Position] Failed for ${symbol}:`, error);
      throw error;
    }
  }

  async setupTrailingStop(symbol, signal, dealId, params) {
    if (!dealId || !params?.trailingDistance) {
      console.warn("[TrailingStop] Missing required parameters");
      return;
    }

    setTimeout(async () => {
      try {
        const positions = await getOpenPositions();
        const position = positions?.positions?.find((p) => p.market.epic === symbol);
        if (position && position.profit > 0) {
          await updateTrailingStop(dealId, params.trailingDistance);
        }
      } catch (error) {
        console.error("[TrailingStop] Error:", error.message);
      }
    }, 5 * 60 * 1000);
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
        const prevClose = prices[i - 1].closePrice?.bid || prices[i - 1].close;
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        tr.push(Math.max(tr1, tr2, tr3));
      }
      const atr = tr.slice(-14).reduce((sum, val) => sum + val, 0) / 14;
      return atr;
    } catch (error) {
      console.error("[ATR] Error:", error);
      return 0.001;
    }
  }

  async processPrice(message, maxOpenTrades) {
    let symbol = null;
    try {
      if (!message) return;
      const candle = message;
      symbol = candle.symbol || candle.epic;
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
      // const hour = new Date().getUTCHours();
      // if (hour < 6 || hour > 22) {
      //   console.log(`[ProcessPrice] Outside main trading session. Skipping ${symbol}.`);
      //   return;
      // }
      const bid = candle.bid || candle.closePrice?.bid || candle.c || candle.close;
      const ask = candle.ask || candle.closePrice?.ask || candle.c || candle.close;
      if (!this.validatePrices(bid, ask, symbol)) return;

      // --- ADD THIS ---
      const { signal } = await this.generateAndValidateSignal(candle, message, symbol, bid, ask);
      if (signal) {
        await this.executeTrade(signal, symbol, bid, ask);
      }
      // ---------------
    } catch (error) {
      console.error(`[ProcessPrice] Error for ${symbol}:`, error);
    }
  }

  positionSize(balance, entryPrice, stopLossPrice, symbol) {
    const { FOREX_MIN_SIZE, RISK_PER_TRADE } = TRADING;
    const pipValue = this.getPipValue(symbol); // Dynamic pip value

    const riskAmount = balance * RISK_PER_TRADE;
    const stopLossPips = Math.abs(entryPrice - stopLossPrice) / pipValue;

    if (stopLossPips === 0) return FOREX_MIN_SIZE;

    const size = riskAmount / (stopLossPips * pipValue);
    return Math.max(FOREX_MIN_SIZE, Math.round(size));
  }

  // Add pip value determination
  getPipValue(symbol) {
    return symbol.includes("JPY") ? 0.01 : 0.0001;
  }

  generateSignals(symbol, h4Data, h4Indicators, h1Indicators, m15Indicators, trendAnalysis, bid, ask) {
    if (!this.validateIndicatorData(h4Data, h4Indicators, h1Indicators, m15Indicators, trendAnalysis)) {
      return { signal: null };
    }
    // this.logMarketConditions(symbol, bid, ask, h4Indicators, h1Indicators, m15Indicators, trendAnalysis);
    const buyConditions = this.generateBuyConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, bid);
    const sellConditions = this.generateSellConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, ask);
    const { signal, buyScore, sellScore } = this.evaluateSignals(buyConditions, sellConditions);
    return {
      signal,
      buyScore,
      sellScore,
    };
  }
}

export default new TradingService();
