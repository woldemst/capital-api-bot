import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getHistorical } from "../api.js";
import logger from "../utils/logger.js";

const { FOREX_MIN_SIZE, RISK_PER_TRADE, MAX_POSITIONS } = TRADING;

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
  setAvailableMargin(m) {
    this.availableMargin = m;
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

  validateIndicatorData(h4Data, h4Indicators, h1Indicators, m15Indicators) {
    if (!h4Data || !h4Indicators || !h1Indicators || !m15Indicators) {
      console.log("[Signal] Missing required indicators data");
      return false;
    }
    return true;
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

  async generateAndValidateSignal(symbol, indicators, candles, bid, ask) {
    const result = this.generateSignals(symbol, indicators, bid, ask);
    if (!result.signal) {
      console.log(`[Signal] No valid signal for ${symbol}. BuyScore: ${result.buyScore}, SellScore: ${result.sellScore}`);
    } else {
      console.log(`[Signal] Signal for ${symbol}: ${result.signal.toUpperCase()}`);
    }
    return result;
  }

  generateBuyConditions(symbol, indicators, candles, bid) {
    const { h4, h1, m15 } = indicators;

    return [
      // H4 Trend conditions
      h4.emaFast > h4.emaSlow, // Primary trend filter
      h4.macd?.histogram > 0, // Trend confirmation

      // H1 Setup confirmation
      h1.ema9 > h1.ema21,
      h1.rsi < RSI_CONFIG.EXIT_OVERSOLD, // Slightly relaxed RSI
      // M15 Entry conditions
      m15.isBullishCross,
      m15.rsi < RSI_CONFIG.OVERSOLD,
      bid <= m15.bb?.lower,
    ];
  }

  generateSellConditions(symbol, indicators, candles, ask) {
    const { h4, h1, m15 } = indicators;
    return [
      // H4 Trend conditions
      !h4.isBullishTrend,
      h4.macd?.histogram < 0,

      // H1 Setup confirmation
      h1.ema9 < h1.ema21,
      h1.rsi > RSI_CONFIG.EXIT_OVERBOUGHT,

      // M15 Entry conditions
      m15.isBearishCross,
      m15.rsi > RSI_CONFIG.OVERBOUGHT,
      ask >= m15.bb?.upper,
    ];
  }

  async executeTrade(signal, symbol, bid, ask) {
    console.log(`\n🎯 ${symbol} ${signal.toUpperCase()} signal generated!`);
    const params = await this.calculateTradeParameters(signal, symbol, bid, ask);
    // this.logTradeParameters(signal, params.size, params.stopLossPrice, params.takeProfitPrice, params.stopLossPips);
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
    console.log(`[calculateTradeParameters] Size: ${size}`);

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
      if (position?.dealReference) {
        // Fetch and log deal confirmation
        const { getDealConfirmation } = await import("../api.js");
        const confirmation = await getDealConfirmation(position.dealReference);
        if (confirmation.dealStatus !== "ACCEPTED" && confirmation.dealStatus !== "OPEN") {
          console.error(`[Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
        }
      }
      return position;
    } catch (error) {
      console.error(`[Position] Failed for ${symbol}:`, error);
      throw error;
    }
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

  async processPrice({ symbol, indicators, candles, bid, ask }) {
    try {
      if (this.openTrades.length >= MAX_POSITIONS) {
        logger.info(`[ProcessPrice] Max positions reached.`);
        return;
      }
      if (this.isSymbolTraded(symbol)) {
        logger.debug(`[ProcessPrice] ${symbol} already in market.`);
        return;
      }

      const { signal } = this.generateSignals(symbol, indicators, candles, bid, ask);

      if (!signal) {
        logger.debug(`[Signal] ${symbol}: no signal (${reason})`);
        return;
      }

      if (signal) {
        await this.executeTrade(signal, symbol, bid, ask);
      }

      //   logger.info(`[Signal] ${symbol}: ${signal}`);
      //   await this.executeTrade(symbol, signal, bid, ask, indicators, candles, context);
    } catch (error) {
      console.error(`[ProcessPrice] Error for ${symbol}:`, error);
    }
  }

  positionSize(balance, entryPrice, stopLossPrice, symbol) {
    const riskAmount = balance * RISK_PER_TRADE;
    const pipValue = this.getPipValue(symbol); // Dynamic pip value

    if (!pipValue || pipValue <= 0) {
      console.error("Invalid pip value calculation");
      return 100; // Fallback with warning
    }

    const stopLossPips = Math.abs(entryPrice - stopLossPrice) / pipValue;
    if (stopLossPips === 0) return 0;

    let size = riskAmount / (stopLossPips * pipValue);
    // Convert to units (assuming size is in lots, so multiply by 1000)
    size = size * 1000;
    // Floor to nearest 100
    size = Math.floor(size / 100) * 100;
    if (size < 100) size = 100;

    // --- Margin check for 5 simultaneous trades ---
    // Assume leverage is 30:1 for forex (can be adjusted)
    const leverage = 30;
    // Margin required = (size * entryPrice) / leverage
    const marginRequired = (size * entryPrice) / leverage;
    // Use available margin from account (set by updateAccountInfo)
    const availableMargin = this.accountBalance; // You may want to use a more precise available margin if tracked
    // Ensure margin for one trade is no more than 1/5 of available
    const maxMarginPerTrade = availableMargin / 5;
    if (marginRequired > maxMarginPerTrade) {
      // Reduce size so marginRequired == maxMarginPerTrade
      size = Math.floor((maxMarginPerTrade * leverage) / entryPrice / 100) * 100;
      if (size < 100) size = 100;
      console.log(`[PositionSize] Adjusted for margin: New size: ${size}`);
    }
    console.log(
      `[PositionSize] Raw size: ${
        riskAmount / (stopLossPips * pipValue)
      }, Final size: ${size}, Margin required: ${marginRequired}, Max per trade: ${maxMarginPerTrade}`
    );
    return size;
  }

  // Add pip value determination
  getPipValue(symbol) {
    return symbol.includes("JPY") ? 0.01 : 0.0001;
  }

  generateSignals(symbol, indicators, candles, bid, ask) {
    const buyConditions = this.generateBuyConditions(symbol, indicators, candles, bid);
    const sellConditions = this.generateSellConditions(symbol, indicators, candles, ask);
    const { signal, buyScore, sellScore } = this.evaluateSignals(buyConditions, sellConditions);
    return {
      signal,
      buyScore,
      sellScore,
    };
  }

  // ============================================================
  //               Trailing Stop (Improved)
  // ============================================================
  async updateTrailingStopIfNeeded(position, indicators) {
    const { dealId, direction, entryPrice, stopLoss, takeProfit, currentPrice, symbol } = position;

    if (!dealId) return;

    // --- Trend misalignment → Breakeven exit ---
    const m5 = indicators.m5;
    const m15 = indicators.m15;
    if (m5 && m15) {
      const m5Trend = Strategy.pickTrend(m5, { symbol, timeframe: "M5", atr: m5.atr });
      const m15Trend = Strategy.pickTrend(m15, { symbol, timeframe: "M15", atr: m15.atr });

      const broken =
        (direction === "BUY" && (m5Trend === "bearish" || m15Trend === "bearish")) ||
        (direction === "SELL" && (m5Trend === "bullish" || m15Trend === "bullish"));

      if (broken) {
        await this.softExitToBreakeven(position);
        return;
      }
    }

    const tpDist = Math.abs(takeProfit - entryPrice);
    const activation = direction === "BUY" ? entryPrice + tpDist * 0.7 : entryPrice - tpDist * 0.7;

    const activated = (direction === "BUY" && currentPrice >= activation) || (direction === "SELL" && currentPrice <= activation);

    if (!activated) return;

    const trailDist = tpDist * 0.2;
    let newSL = direction === "BUY" ? currentPrice - trailDist : currentPrice + trailDist;

    if ((direction === "BUY" && newSL <= stopLoss) || (direction === "SELL" && newSL >= stopLoss)) return;

    try {
      await updateTrailingStop(dealId, currentPrice, newSL, null, direction.toUpperCase(), symbol, true);
      logger.info(`[Trail] Updated SL → ${newSL} for ${dealId}`);
    } catch (error) {
      logger.error(`[Trail] Error updating trailing stop:`, error);
    }
  }

  // ============================================================
  //               Breakeven Soft Exit
  // ============================================================
  async softExitToBreakeven(position) {
    const { dealId, entryPrice, direction, symbol } = position;

    const newSL = entryPrice;
    try {
      await updateTrailingStop(dealId, entryPrice, newSL, null, direction, symbol, true);

      logger.info(`[SoftExit] ${symbol}: misalignment → moved SL to breakeven for ${dealId}`);
    } catch (e) {
      logger.error(`[SoftExit] Error updating SL to breakeven:`, e);
    }
  }
}

export default new TradingService();
