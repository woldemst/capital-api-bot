import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getHistorical, getOpenPositions, getAllowedTPRange, closePosition as apiClosePosition } from "../api.js";
import logger from "../utils/logger.js";
import { ATR } from "technicalindicators";
const { FOREX_MIN_SIZE, RISK_PER_TRADE } = TRADING;

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
    this.availableMargin = 0; // Initialize availableMargin
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
  setAvailableMargin(margin) {
    this.availableMargin = margin;
  }
  isSymbolTraded(symbol) {
    return this.openTrades.includes(symbol);
  }

  validatePrices(bid, ask, symbol) {
    if (typeof bid !== "number" || typeof ask !== "number" || isNaN(bid) || isNaN(ask)) {
      logger.error(`[PriceValidation] Invalid prices for ${symbol}. Bid: ${bid}, Ask: ${ask}`);
      return false;
    }
    return true;
  }

  validateIndicatorData(h4Data, h4Indicators, h1Indicators, m15Indicators, trendAnalysis) {
    if (!h4Data || !h4Indicators || !h1Indicators || !m15Indicators || !trendAnalysis) {
      logger.info("[Signal] Missing required indicators data");
      return false;
    }
    return true;
  }

  logMarketConditions(symbol, bid, ask, h4Indicators, h1Indicators, m15Indicators, trendAnalysis) {
    // logger.info(`\n=== Analyzing ${symbol} ===`);
    // logger.info("Current price:", { bid, ask });
    // logger.info("[H4] EMA Fast:", h4Indicators.emaFast, "EMA Slow:", h4Indicators.emaSlow, "MACD:", h4Indicators.macd?.histogram);
    // logger.info("[H1] EMA9:", h1Indicators.ema9, "EMA21:", h1Indicators.ema21, "RSI:", h1Indicators.rsi);
    // logger.info("[M15] EMA9:", m15Indicators.ema9, "EMA21:", m15Indicators.ema21, "RSI:", m15Indicators.rsi, "BB:", m15Indicators.bb);
    // logger.info("Trend:", trendAnalysis.h4Trend);
  }

  evaluateSignals(buyConditions, sellConditions) {
    const buyScore = buyConditions.filter(Boolean).length;
    const sellScore = sellConditions.filter(Boolean).length;
    logger.info(`[Signal] BuyScore: ${buyScore}/${buyConditions.length}, SellScore: ${sellScore}/${sellConditions.length}`);
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
    // logger.info(`[Signal] Generating signal for ${symbol}`);
    // logger.info("[Indicators] H4:", indicators.h4);
    // logger.info("[Indicators] H1:", indicators.h1);
    // logger.info("[Indicators] M15:", indicators.m15);
    const trendAnalysis = message.trendAnalysis;
    const result = this.generateSignals(symbol, message.h4Data, indicators.h4, indicators.h1, indicators.m15, trendAnalysis, bid, ask);
    if (!result.signal) {
      logger.info(`[Signal] No valid signal for ${symbol}. BuyScore: ${result.buyScore}, SellScore: ${result.sellScore}`);
    } else {
      logger.info(`[Signal] Signal for ${symbol}: ${result.signal.toUpperCase()}`);
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

  // Validate and adjust TP/SL to allowed range
  async validateTPandSL(symbol, direction, entryPrice, stopLossPrice, takeProfitPrice) {
    const range = await getAllowedTPRange(symbol);
    let newTP = takeProfitPrice;
    let newSL = stopLossPrice;
    const decimals = range.decimals || 5;
    // For forex, TP/SL must be at least minTPDistance away from entry, and not violate maxTPDistance
    // For SELL: TP < entry, SL > entry. For BUY: TP > entry, SL < entry
    if (direction === "buy") {
      const minTP = entryPrice + range.minTPDistance * Math.pow(10, -decimals);
      const maxTP = entryPrice + range.maxTPDistance * Math.pow(10, -decimals);
      if (newTP < minTP) {
        logger.warn(`[TP Validation] TP (${newTP}) < min allowed (${minTP}). Adjusting.`);
        newTP = minTP;
      }
      if (newTP > maxTP) {
        logger.warn(`[TP Validation] TP (${newTP}) > max allowed (${maxTP}). Adjusting.`);
        newTP = maxTP;
      }
      // Repeat for SL
      const minSL = entryPrice - range.maxSLDistance * Math.pow(10, -decimals);
      const maxSL = entryPrice - range.minSLDistance * Math.pow(10, -decimals);
      if (newSL < minSL) {
        logger.warn(`[SL Validation] SL (${newSL}) < min allowed (${minSL}). Adjusting.`);
        newSL = minSL;
      }
      if (newSL > maxSL) {
        logger.warn(`[SL Validation] SL (${newSL}) > max allowed (${maxSL}). Adjusting.`);
        newSL = maxSL;
      }
    } else {
      // SELL
      const minTP = entryPrice - range.maxTPDistance * Math.pow(10, -decimals);
      const maxTP = entryPrice - range.minTPDistance * Math.pow(10, -decimals);
      if (newTP > maxTP) {
        logger.warn(`[TP Validation] TP (${newTP}) > max allowed (${maxTP}). Adjusting.`);
        newTP = maxTP;
      }
      if (newTP < minTP) {
        logger.warn(`[TP Validation] TP (${newTP}) < min allowed ( ${minTP}). Adjusting.`);
        newTP = minTP;
      }
      // Repeat for SL
      const minSL = entryPrice + range.minSLDistance * Math.pow(10, -decimals);
      const maxSL = entryPrice + range.maxSLDistance * Math.pow(10, -decimals);
      if (newSL < minSL) {
        logger.warn(`[SL Validation] SL (${newSL}) < min allowed (${minSL}). Adjusting.`);
        newSL = minSL;
      }
      if (newSL > maxSL) {
        logger.warn(`[SL Validation] SL (${newSL}) > max allowed (${maxSL}). Adjusting.`);
        newSL = maxSL;
      }
    }
    return { stopLossPrice: newSL, takeProfitPrice: newTP };
  }

  async executeTrade(signal, symbol, bid, ask) {
    logger.trade(signal.toUpperCase(), symbol, { bid, ask });
    const params = await this.calculateTradeParameters(signal, symbol, bid, ask);
    // Validate TP/SL before placing trade
    const price = signal === "buy" ? ask : bid;
    const validated = await this.validateTPandSL(symbol, signal, price, params.stopLossPrice, params.takeProfitPrice);
    params.stopLossPrice = validated.stopLossPrice;
    params.takeProfitPrice = validated.takeProfitPrice;
    try {
      // Pass expected entry price for slippage check
      await this.executePosition(signal, symbol, params, price);
    } catch (error) {
      logger.error(`[TradeExecution] Failed for ${symbol}:`, error);
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
    logger.info(`[calculateTradeParameters] Size: ${size}`);

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
    logger.info(
      `[TradeParams] Entry: ${signal.toUpperCase()} | Size: ${size} | SL: ${stopLossPrice} (${stopLossPips}) | TP: ${takeProfitPrice}`
    );
  }

  async executePosition(signal, symbol, params, expectedPrice) {
    const { size, stopLossPrice, takeProfitPrice, trailingStopParams } = params;
    try {
      const position = await placePosition(symbol, signal, size, null, stopLossPrice, takeProfitPrice);
      if (position?.dealReference) {
        // Fetch and log deal confirmation
        const { getDealConfirmation } = await import("../api.js");
        const confirmation = await getDealConfirmation(position.dealReference);
        if (confirmation.dealStatus !== 'ACCEPTED' && confirmation.dealStatus !== 'OPEN') {
          logger.error(`[Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
        }
        // --- Slippage check ---
        if (confirmation.level && expectedPrice) {
          const { TRADING } = await import("../config.js");
          // Calculate slippage in pips
          const decimals = 5; // Most FX pairs
          const pip = Math.pow(10, -decimals);
          const slippage = Math.abs(confirmation.level - expectedPrice) / pip;
          if (slippage > TRADING.MAX_SLIPPAGE_PIPS) {
            logger.warn(`[Slippage] ${symbol}: Intended ${expectedPrice}, Executed ${confirmation.level}, Slippage: ${slippage.toFixed(1)} pips (max allowed: ${TRADING.MAX_SLIPPAGE_PIPS})`);
            // Optionally: take action (e.g., close trade, alert, etc.)
          } else {
            logger.info(`[Slippage] ${symbol}: Intended ${expectedPrice}, Executed ${confirmation.level}, Slippage: ${slippage.toFixed(1)} pips`);
          }
        }
        // --- End slippage check ---
      }
      return position;
    } catch (error) {
      logger.error(`[Position] Failed for ${symbol}:`, error);
      throw error;
    }
  }

  async setupTrailingStop(symbol, signal, dealId, params) {
    if (!dealId || !params?.trailingDistance) {
      logger.warn("[TrailingStop] Missing required parameters");
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
        logger.error("[TrailingStop] Error:", error.message);
      }
    }, 5 * 60 * 1000);
  }

  async calculateATR(symbol) {
    try {
      const data = await getHistorical(symbol, ANALYSIS.TIMEFRAMES.ENTRY, 15);
      if (!data?.prices || data.prices.length < 14) {
        throw new Error("Insufficient data for ATR calculation");
      }
      // Use mid price for ATR calculation for consistency
      const highs = data.prices.map((b) => {
        if (b.high && typeof b.high === 'object' && b.high.bid != null && b.high.ask != null) return (b.high.bid + b.high.ask) / 2;
        if (typeof b.high === 'number') return b.high;
        return b.high?.bid ?? b.high?.ask ?? 0;
      });
      const lows = data.prices.map((b) => {
        if (b.low && typeof b.low === 'object' && b.low.bid != null && b.low.ask != null) return (b.low.bid + b.low.ask) / 2;
        if (typeof b.low === 'number') return b.low;
        return b.low?.bid ?? b.low?.ask ?? 0;
      });
      const closes = data.prices.map((b) => {
        if (b.close && typeof b.close === 'object' && b.close.bid != null && b.close.ask != null) return (b.close.bid + b.close.ask) / 2;
        if (typeof b.close === 'number') return b.close;
        return b.close?.bid ?? b.close?.ask ?? 0;
      });
      const atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
      return atrArr.length ? atrArr[atrArr.length - 1] : 0.001;
    } catch (error) {
      logger.error("[ATR] Error:", error);
      return 0.001;
    }
  }

  async processPrice(message, maxOpenTrades) {
    let symbol = null;
    try {
      if (!message) return;
      const candle = message;
      symbol = candle.symbol || candle.epic;
      logger.info(`\n=== Processing ${symbol} ===`);
      logger.info("")
      logger.info(`[ProcessPrice] Open trades: ${this.openTrades.length}/${maxOpenTrades} | Balance: ${this.accountBalance}€`);
      if (this.openTrades.length >= maxOpenTrades) {
        logger.info(`[ProcessPrice] Max trades reached. Skipping ${symbol}.`);
        return;
      }
      if (this.isSymbolTraded(symbol)) {
        logger.info(`[ProcessPrice] ${symbol} already has an open position.`);
        return;
      }
      // Extract bid/ask from merged candle structure
      const bid = candle.close?.bid;
      const ask = candle.close?.ask;
      // logger.info('bid ask', bid, ask);
      if (!this.validatePrices(bid, ask, symbol)) return;

      // --- ADD THIS ---
      const { signal } = await this.generateAndValidateSignal(candle, message, symbol, bid, ask);
      if (signal) {
        await this.executeTrade(signal, symbol, bid, ask);
      }
      // ---------------
    } catch (error) {
      logger.error(`[ProcessPrice] Error for ${symbol}:`, error);
    }
  }

  positionSize(balance, entryPrice, stopLossPrice, symbol) {
    const riskAmount = balance * RISK_PER_TRADE;
    const pipValue = this.getPipValue(symbol); // Dynamic pip value

    if (!pipValue || pipValue <= 0) {
      logger.error("Invalid pip value calculation");
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
    const availableMargin = this.availableMargin ?? this.accountBalance;
    // Ensure margin for one trade is no more than 1/5 of available
    const maxMarginPerTrade = availableMargin / 5;
    if (marginRequired > maxMarginPerTrade) {
        // Reduce size so marginRequired == maxMarginPerTrade
        size = Math.floor((maxMarginPerTrade * leverage) / entryPrice / 100) * 100;
        if (size < 100) size = 100;
        logger.info(`[PositionSize] Adjusted for margin: New size: ${size}`);
    }
    logger.info(`[PositionSize] Raw size: ${riskAmount / (stopLossPips * pipValue)}, Final size: ${size}, Margin required: ${marginRequired}, Max per trade: ${maxMarginPerTrade}`);
    return size;
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

  // --- Improved: Monitor open trades and close if exit conditions are met ---
  async monitorOpenTrades(latestIndicatorsBySymbol) {
    const positionsData = await getOpenPositions();
    if (!positionsData?.positions) return;
    for (const p of positionsData.positions) {
      const symbol = p.market.epic;
      const direction = p.position.direction.toLowerCase();
      const dealId = p.position.dealId;
      const entry = p.position.openLevel;
      const size = p.position.size;
      const stopLevel = p.position.stopLevel;
      const price = direction === "buy" ? p.market.bid : p.market.offer;
      const profit = (direction === "buy" ? price - entry : entry - price) * size;
      const indicators = latestIndicatorsBySymbol[symbol];
      if (!indicators) continue;

      // 1. Trailing stop logic (move SL up if price moves in favor)
      if (profit > 0) {
        const newStop = direction === "buy" ? price - indicators.atr : price + indicators.atr;
        if ((direction === "buy" && newStop > stopLevel) || (direction === "sell" && newStop < stopLevel)) {
          await updateTrailingStop(dealId, newStop);
          logger.info(`[TrailingStop] Updated for ${symbol} to ${newStop}`);
        }
      }

      // 2. Indicator-based exit: close if trend reverses and in profit
      let exitReason = null;
      if (profit > 0) {
        // EMA cross exit
        if ((direction === "buy" && indicators.emaFast < indicators.emaSlow) ||
            (direction === "sell" && indicators.emaFast > indicators.emaSlow)) {
          exitReason = "EMA cross";
        }
        // MACD cross exit (optional, can combine with EMA)
        if ((direction === "buy" && indicators.macd?.histogram < 0) ||
            (direction === "sell" && indicators.macd?.histogram > 0)) {
          exitReason = exitReason ? exitReason + ", MACD" : "MACD";
        }
        // RSI overbought/oversold exit (optional)
        if ((direction === "buy" && indicators.rsi > 65) ||
            (direction === "sell" && indicators.rsi < 35)) {
          exitReason = exitReason ? exitReason + ", RSI" : "RSI";
        }
      }
      if (exitReason) {
        // You need to implement closePosition in your API
        if (typeof this.closePosition === "function") {
          await this.closePosition(dealId);
          logger.info(`[Exit] Closed ${symbol} (${direction}) due to: ${exitReason}, locked profit: ${profit}`);
        } else {
          logger.info(`[Exit] Would close ${symbol} (${direction}) due to: ${exitReason}, locked profit: ${profit}`);
        }
      }
    }
  }

  // Close position by dealId
  async closePosition(dealId) {
    try {
      await apiClosePosition(dealId);
      logger.info(`[API] Closed position for dealId: ${dealId}`);
    } catch (error) {
      logger.error(`[API] Failed to close position for dealId: ${dealId}`, error);
    }
  }
}

export default new TradingService();
