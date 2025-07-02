import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getHistorical, getOpenPositions, getAllowedTPRange, closePosition as apiClosePosition } from "../api.js";
import logger from "../utils/logger.js";
import { ATR } from "technicalindicators";
const { RISK_PER_TRADE } = TRADING;

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
    // --- Overtrading protection: cooldown per symbol ---
    this.lastTradeTimestamps = {};
    this.COOLDOWN_MINUTES = 30; // Cooldown increased to 30 minutes
    this.winStreak = 0;
    this.lossStreak = 0;
    this.recentResults = [];
    this.dynamicRiskPerTrade = RISK_PER_TRADE;
    this.dynamicSignalThreshold = 4; // Default, will adapt
    this.maxRiskPerTrade = 0.02; // 2% max
    this.minRiskPerTrade = 0.003; // 0.3% min
    this.maxSignalThreshold = 5;
    this.minSignalThreshold = 3;
    // --- Daily loss limit ---
    this.dailyLoss = 0;
    this.dailyLossLimitPct = 0.05; // 5% of account balance
    this.lastLossReset = new Date().toDateString();
    this.dailyProfit = 0;
    this.dailyProfitLimitPct = 0.05; // 5% profit target per day
    this.lastProfitReset = new Date().toDateString();
    this.openPositionsById = {};
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

  /**
   * Logs the signal with all indicator values, price, and time as a CSV row in the price log.
   * Called on signal event.
   */
  logMarketConditions(symbol, bid, ask, h4Indicators = {}, h1Indicators = {}, m15Indicators = {}, trendAnalysis = {}, signal = null, tradeResult = null) {
    const ts = new Date().toISOString();
    const row = [
      'SIGNAL',
      ts,
      symbol,
      bid,
      ask,
      h4Indicators.emaFast,
      h4Indicators.emaSlow,
      h4Indicators.macd?.histogram,
      h1Indicators.ema9,
      h1Indicators.ema21,
      h1Indicators.rsi,
      m15Indicators.ema9,
      m15Indicators.ema21,
      m15Indicators.rsi,
      m15Indicators.bb?.lower,
      m15Indicators.bb?.upper,
      m15Indicators.atr,
      trendAnalysis?.h4Trend,
      signal,
      '' // Placeholder for result
    ].map(v => v === undefined ? '' : v).join(",");
    if (logger && typeof logger.price === 'function') {
      logger.price(symbol, bid, ask, row);
    }
  }

  /**
   * Logs the result (TP/SL, price, profit, time) as a CSV row in the price log.
   * Called after position close (TP/SL).
   */
  logTradeResult(symbol, closePrice, resultType, profit, openTime, closeTime) {
    const row = [
      'RESULT',
      closeTime || new Date().toISOString(),
      symbol,
      closePrice,
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      resultType, // e.g. 'TP', 'SL', 'MANUAL'
      profit
    ].map(v => v === undefined ? '' : v).join(",");
    if (logger && typeof logger.price === 'function') {
      logger.price(symbol, closePrice, '', row);
    }
  }

  // Call this after each trade closes (profit > 0 = win, else loss)
  updateTradeResult(profit) {
    // -------- Daily reset ----------
    const today = new Date().toDateString();
    if (today !== this.lastLossReset) {
      this.dailyLoss = 0;
      this.lastLossReset = today;
    }
    if (today !== this.lastProfitReset) {
      this.dailyProfit = 0;
      this.lastProfitReset = today;
    }
    // Track realised P/L
    this.dailyLoss += profit;
    this.dailyProfit += profit;
    if (this.dailyLoss < 0) logger.warn(`[Risk] Daily realised loss: ${this.dailyLoss.toFixed(2)} €`);
    if (this.dailyProfit > 0) logger.info(`[Risk] Daily realised profit: ${this.dailyProfit.toFixed(2)} €`);

    const isWin = profit > 0;
    this.recentResults.push(isWin ? 1 : 0);
    if (this.recentResults.length > 20) this.recentResults.shift();
    if (isWin) {
      this.winStreak++;
      this.lossStreak = 0;
    } else {
      this.lossStreak++;
      this.winStreak = 0;
    }
    this.updateDynamicRiskAndThreshold();
  }

  // Adjust risk and signal threshold based on streaks and win rate
  updateDynamicRiskAndThreshold() {
    // Win rate over last 20 trades
    const winRate = this.recentResults.length ? this.recentResults.reduce((a,b)=>a+b,0)/this.recentResults.length : 0.5;
    // Dynamic risk: increase after 2+ wins, decrease after 2+ losses
    if (this.winStreak >= 2) {
      this.dynamicRiskPerTrade = Math.min(this.dynamicRiskPerTrade * 1.2, this.maxRiskPerTrade);
    } else if (this.lossStreak >= 2) {
      this.dynamicRiskPerTrade = Math.max(this.dynamicRiskPerTrade * 0.7, this.minRiskPerTrade);
    } else {
      // Gradually revert to base risk
      this.dynamicRiskPerTrade += (RISK_PER_TRADE - this.dynamicRiskPerTrade) * 0.1;
    }
    // Dynamic signal threshold: stricter if win rate < 50%, looser if > 65%
    if (winRate > 0.65) {
      this.dynamicSignalThreshold = Math.max(this.minSignalThreshold, this.dynamicSignalThreshold - 1);
    } else if (winRate < 0.5) {
      this.dynamicSignalThreshold = Math.min(this.maxSignalThreshold, this.dynamicSignalThreshold + 1);
    } else {
      // Gradually revert to default
      this.dynamicSignalThreshold += (3 - this.dynamicSignalThreshold) * 0.2;
    }
    this.dynamicSignalThreshold = Math.round(this.dynamicSignalThreshold);
    logger.info(`[Adaptive] Risk: ${(this.dynamicRiskPerTrade*100).toFixed(2)}%, SignalThreshold: ${this.dynamicSignalThreshold}, WinRate: ${(winRate*100).toFixed(1)}%`);
  }

  evaluateSignals(buyConditions, sellConditions) {
    // Adaptive threshold, but minimum 4
    const threshold = Math.max(this.dynamicSignalThreshold || 3, 4);
    const buyScore = buyConditions.filter(Boolean).length;
    const sellScore = sellConditions.filter(Boolean).length;
    logger.info(`[Signal] BuyScore: ${buyScore}/${buyConditions.length}, SellScore: ${sellScore}/${sellConditions.length}, Threshold: ${threshold}`);
    let signal = null;
    if (buyScore >= threshold) {
      signal = "buy";
    } else if (sellScore >= threshold) {
      signal = "sell";
    }
    return { signal, buyScore, sellScore };
  }

  // Range filter: skip signals in low volatility/ranging markets
  passesRangeFilter(indicators, price) {
    // Volatility filter always enabled
    const RANGE_FILTER = { ENABLED: true, MIN_ATR_PCT: 0.0007, MIN_BB_WIDTH_PCT: 0.001, MIN_EMA_DIST_PCT: 0.0004 };
    if (!RANGE_FILTER?.ENABLED) return true;
    if (!indicators) return true;
    if (indicators.atr && price) {
      const atrPct = indicators.atr / price;
      if (atrPct < RANGE_FILTER.MIN_ATR_PCT) {
        logger.info(`[RangeFilter] ATR too low (${(atrPct*100).toFixed(3)}%). No signal.`);
        return false;
      }
    }
    if (indicators.bb && price) {
      const bbWidth = indicators.bb.upper - indicators.bb.lower;
      const bbWidthPct = bbWidth / price;
      if (bbWidthPct < RANGE_FILTER.MIN_BB_WIDTH_PCT) {
        logger.info(`[RangeFilter] BB range too low (${(bbWidthPct*100).toFixed(3)}%). No signal.`);
        return false;
      }
    }
    if (indicators.emaFast && indicators.emaSlow && price) {
      const emaDist = Math.abs(indicators.emaFast - indicators.emaSlow);
      const emaDistPct = emaDist / price;
      if (emaDistPct < RANGE_FILTER.MIN_EMA_DIST_PCT) {
        logger.info(`[RangeFilter] EMA distance too low (${(emaDistPct*100).toFixed(3)}%). No signal.`);
        return false;
      }
    }
    return true;
  }

  async generateAndValidateSignal(candle, message, symbol, bid, ask) {
    const indicators = candle.indicators || {};
    const trendAnalysis = message.trendAnalysis;
    // --- Range filter ---
    const price = bid || ask || 1;
    if (!this.passesRangeFilter(indicators.m15 || indicators, price)) {
      logger.info(`[Signal] Skipping ${symbol} due to range filter.`);
      return { signal: null, buyScore: 0, sellScore: 0 };
    }
    const result = this.generateSignals(symbol, message.h4Data, indicators.h4, indicators.h1, indicators.m15, trendAnalysis, bid, ask);
    // Log again, now including the decided signal
    this.logMarketConditions(symbol, bid, ask, indicators.h4, indicators.h1, indicators.m15 || indicators, trendAnalysis, result.signal);
    if (!result.signal) {
      console.log(`[Signal] No valid signal for ${symbol}. BuyScore: ${result.buyScore}, SellScore: ${result.sellScore}`);
    } else {
      console.log(`[Signal] Signal for ${symbol}: ${result.signal.toUpperCase()}`);
    }
    return result;
  }
  generateBuyConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, bid) {
    // Multi-timeframe trend filter: require both H4 and D1 bullish
    const higherTimeframeBullish = trendAnalysis?.h4Trend === 'bullish' && trendAnalysis?.d1Trend === 'bullish';
    // Mean-reversion filter: avoid new buys if price at upper BB and RSI > 70
    const meanReversionBlock = m15Indicators.bb && m15Indicators.rsi > 70 && bid >= m15Indicators.bb.upper;
    return [
      higherTimeframeBullish, // Only buy if both H4 and D1 are bullish
      h4Indicators.emaFast > h4Indicators.emaSlow, // H4 EMA trend
      h4Indicators.macd?.histogram > 0, // H4 MACD confirms trend
      h1Indicators.ema9 > h1Indicators.ema21, // H1 EMA9 > EMA21
      h1Indicators.rsi > 50, // H1 RSI confirms bullish
      m15Indicators.isBullishCross, // M15 bullish cross
      m15Indicators.rsi > 50, // M15 RSI confirms
      !meanReversionBlock // Block entry if mean-reversion filter triggers
    ];
  }

  generateSellConditions(h4Indicators, h1Indicators, m15Indicators, trendAnalysis, ask) {
    // Multi-timeframe trend filter: require both H4 and D1 bearish
    const higherTimeframeBearish = trendAnalysis?.h4Trend === 'bearish' && trendAnalysis?.d1Trend === 'bearish';
    // Mean-reversion filter: avoid new sells if price at lower BB and RSI < 30
    const meanReversionBlock = m15Indicators.bb && m15Indicators.rsi < 30 && ask <= m15Indicators.bb.lower;
    return [
      higherTimeframeBearish, // Only sell if both H4 and D1 are bearish
      h4Indicators.emaFast < h4Indicators.emaSlow, // H4 EMA trend
      h4Indicators.macd?.histogram < 0, // H4 MACD confirms trend
      h1Indicators.ema9 < h1Indicators.ema21, // H1 EMA9 < EMA21
      h1Indicators.rsi < 50, // H1 RSI confirms bearish
      m15Indicators.isBearishCross, // M15 bearish cross
      m15Indicators.rsi < 50, // M15 RSI confirms
      !meanReversionBlock // Block entry if mean-reversion filter triggers
    ];
  }

  async calculateTradeParameters(signal, symbol, bid, ask) {
    const price = signal === "buy" ? ask : bid;
    const atr = await this.calculateATR(symbol);
    // ATR-based dynamic stop-loss and take-profit
    const stopLossPips = 1.5 * atr; // Tighter, but adaptive
    const stopLossPrice = signal === "buy" ? price - stopLossPips : price + stopLossPips;
    const takeProfitPips = 2.5 * atr; // 1.66:1 RR
    const takeProfitPrice = signal === "buy" ? price + takeProfitPips : price - takeProfitPips;
    const size = this.positionSize(this.accountBalance, price, stopLossPrice, symbol);
    // Trailing stop: activate at 1R, trail by 1*ATR
    const trailingStopParams = {
      activationPrice: signal === "buy" ? price + stopLossPips : price - stopLossPips,
      trailingDistance: atr
    };
    return {
      size,
      stopLossPrice,
      takeProfitPrice,
      stopLossPips,
      takeProfitPips,
      trailingStopParams,
      partialTakeProfit: signal === "buy" ? price + stopLossPips : price - stopLossPips,
    };
  }

  logTradeParameters(signal, size, stopLossPrice, takeProfitPrice, stopLossPips) {
    console.log(
      `[TradeParams] Entry: ${signal.toUpperCase()} | Size: ${size} | SL: ${stopLossPrice} (${stopLossPips}) | TP: ${takeProfitPrice}`
    );
  }

  async executePosition(signal, symbol, params, expectedPrice) {
    const { size, stopLossPrice, takeProfitPrice, trailingStopParams } = params;
    try {
      const position = await placePosition(symbol, signal, size, null, stopLossPrice, takeProfitPrice);
      if (position?.dealReference) {
        // Track the opened position for later result logging
        this.openPositionsById[position.dealReference] = {
          symbol,
          direction: signal,
          openTime: new Date().toISOString(),
          openPrice: expectedPrice,
          indicators: params.indicators || {},
        };
        // Fetch and log deal confirmation
        const { getDealConfirmation } = await import("../api.js");
        const confirmation = await getDealConfirmation(position.dealReference);
        if (confirmation.dealStatus !== 'ACCEPTED' && confirmation.dealStatus !== 'OPEN') {
          console.error(`[Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
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
      if (!data?.prices || data.prices.length < 21) {
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
      const atrArr = ATR.calculate({ period: 21, high: highs, low: lows, close: closes });
      return atrArr.length ? atrArr[atrArr.length - 1] : 0.001;
    } catch (error) {
      console.error("[ATR] Error:", error);
      return 0.001;
    }
  }

  async processPrice(message, maxOpenTrades) {
    let symbol = null;
    try {
      if (!message) return;
      // ---- Daily loss and profit limit ----
      const maxDailyLoss = -this.accountBalance * this.dailyLossLimitPct;
      const maxDailyProfit = this.accountBalance * this.dailyProfitLimitPct;
      if (this.dailyLoss <= maxDailyLoss) {
        logger.warn(`[Risk] Daily loss limit (${this.dailyLossLimitPct * 100}% ) reached. No new trades today.`);
        return;
      }
      if (this.dailyProfit >= maxDailyProfit) {
        logger.info(`[Risk] Daily profit target (${this.dailyProfitLimitPct * 100}% ) reached. No new trades today.`);
        return;
      }
      const candle = message;
      symbol = candle.symbol || candle.epic;
      logger.info(`[ProcessPrice] Open trades: ${this.openTrades.length}/${maxOpenTrades} | Balance: ${this.accountBalance}€`);
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
      // No cooldown logic: allow high-frequency trading
      const bid = candle.close?.bid;
      const ask = candle.close?.ask;
      
      if (!this.validatePrices(bid, ask, symbol)) return;
      const { signal } = await this.generateAndValidateSignal(candle, message, symbol, bid, ask);
      if (signal) {
        await this.executeTrade(signal, symbol, bid, ask);
      }
    } catch (error) {
      console.error(`[ProcessPrice] Error for ${symbol}:`, error);
    }
  }

  positionSize(balance, entryPrice, stopLossPrice, symbol) {
    // Risk per trade: max 2% of equity
    const riskAmount = balance * 0.02;
    const pipValue = this.getPipValue(symbol);
    if (!pipValue || pipValue <= 0) {
      console.error("Invalid pip value calculation");
      return 100;
    }
    const stopLossPips = Math.abs(entryPrice - stopLossPrice) / pipValue;
    if (stopLossPips === 0) return 0;
    let size = riskAmount / (stopLossPips * pipValue);
    size = size * 1000;
    size = Math.floor(size / 100) * 100;
    if (size < 100) size = 100;
    // Limit concurrent trades to 5, adjust margin
    const leverage = 30;
    const marginRequired = (size * entryPrice) / leverage;
    const availableMargin = this.accountBalance;
    const maxMarginPerTrade = availableMargin / 5;
    if (marginRequired > maxMarginPerTrade) {
      size = Math.floor((maxMarginPerTrade * leverage) / entryPrice / 100) * 100;
      if (size < 100) size = 100;
      logger.info(`[PositionSize] Adjusted for margin: New size: ${size}`);
    }
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
    // Simple retry logic for getOpenPositions (handles 500 errors and timeouts)
    let positionsData = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        positionsData = await getOpenPositions();
        if (positionsData?.positions) break;
      } catch (err) {
        lastError = err;
        const is500 = err?.response?.status === 500;
        const isTimeout = (err?.code && err.code.toString().toUpperCase().includes('TIMEOUT'));
        if (is500 || isTimeout) {
          logger.warn(`[Monitoring] getOpenPositions failed (attempt ${attempt}/3): ${err.message || err}`);
          await new Promise(res => setTimeout(res, 1000 * attempt));
        } else {
          logger.error(`[Monitoring] getOpenPositions failed:`, err);
          break;
        }
      }
    }
    if (!positionsData?.positions) {
      logger.error(`[Monitoring] Could not fetch open positions after 3 attempts`, lastError);
      return;
    }
    const now = Date.now();
    const currentOpenDealIds = new Set();
    for (const p of positionsData.positions) {
      const dealId = p.position.dealId;
      currentOpenDealIds.add(dealId);
      // ...existing code...
    }
    // Check for closed positions and log their result
    for (const dealId in this.openPositionsById) {
      if (!currentOpenDealIds.has(dealId)) {
        const pos = this.openPositionsById[dealId];
        // You may want to fetch the final close price and result type (TP/SL) from your broker API or from your logic
        // For now, we log with available info
        this.logTradeResult(
          pos.symbol,
          pos.openPrice, // You may want to use the actual close price if available
          'CLOSED', // You can improve this to 'TP' or 'SL' if you have that info
          null, // Profit can be calculated if you have entry/exit
          pos.openTime,
          new Date().toISOString()
        );
        delete this.openPositionsById[dealId];
      }
    }
  }
}

export default new TradingService();