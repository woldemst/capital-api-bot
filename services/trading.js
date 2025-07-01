import { TRADING, ANALYSIS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getHistorical, getOpenPositions, getAllowedTPRange, closePosition as apiClosePosition } from "../api.js";
import logger from "../utils/logger.js";
import { ATR } from "technicalindicators";
const { FOREX_MIN_SIZE, RISK_PER_TRADE } = TRADING;

// --- CONFIGURATION CONSTANTS ---
const COOLDOWN_BETWEEN_TRADES_MINUTES = 15; // Minimum time between trades per symbol
const MAX_WIN_STREAK = 2;
const MAX_LOSS_STREAK = 2;
const DEFAULT_SIGNAL_THRESHOLD = 3;
const MAX_SIGNAL_THRESHOLD = 5;
const MIN_SIGNAL_THRESHOLD = 2;
const MAX_RISK_PER_TRADE = 0.02; // 2%
const MIN_RISK_PER_TRADE = 0.003; // 0.3%
const DAILY_LOSS_LIMIT_PCT = 0.05; // 5% of account balance
const SESSION_START_HOUR = 8;   // 08:00 MEZ
const SESSION_END_HOUR = 18;    // 18:00 MEZ

// --- RSI CONFIGURATION ---
const RSI_CONFIG = {
  OVERBOUGHT: 70,
  OVERSOLD: 30,
  EXIT_OVERBOUGHT: 65,
  EXIT_OVERSOLD: 35,
};

/**
 * TradingService: Manages all trading logic, including signal generation, risk management, trade execution, and trade monitoring.
 * Refactored for clarity, maintainability, and human readability.
 */
class TradingService {
  constructor() {
    // --- State ---
    this.openTrades = [];
    this.accountBalance = 0;
    this.profitThresholdReached = false;
    this.symbolMinSizes = {};
    this.virtualBalance = 10000;
    this.virtualPositions = [];
    this.orderAttempts = new Map();
    this.availableMargin = 0;
    this.lastTradeTimestamps = {}; // For cooldown per symbol
    this.winStreak = 0;
    this.lossStreak = 0;
    this.recentResults = [];
    this.dynamicRiskPerTrade = TRADING.RISK_PER_TRADE;
    this.dynamicSignalThreshold = DEFAULT_SIGNAL_THRESHOLD;
    this.maxRiskPerTrade = MAX_RISK_PER_TRADE;
    this.minRiskPerTrade = MIN_RISK_PER_TRADE;
    this.maxSignalThreshold = MAX_SIGNAL_THRESHOLD;
    this.minSignalThreshold = MIN_SIGNAL_THRESHOLD;
    this.dailyLoss = 0;
    this.dailyLossLimitPct = DAILY_LOSS_LIMIT_PCT;
    this.lastLossReset = new Date().toDateString();
    this.sessionStart = SESSION_START_HOUR;
    this.sessionEnd = SESSION_END_HOUR;
  }

  // --- State Setters ---
  setAccountBalance(balance) { this.accountBalance = balance; }
  setOpenTrades(trades) { this.openTrades = trades; }
  setProfitThresholdReached(reached) { this.profitThresholdReached = reached; }
  setSymbolMinSizes(minSizes) { this.symbolMinSizes = minSizes; }
  setAvailableMargin(margin) { this.availableMargin = margin; }

  // --- Trade State Checks ---
  isSymbolTraded(symbol) { return this.openTrades.includes(symbol); }

  // --- Price and Indicator Validation ---
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

  // --- Trade Result Tracking and Adaptive Risk ---
  updateTradeResult(profit) {
    // Reset daily loss if new day
    const today = new Date().toDateString();
    if (today !== this.lastLossReset) {
      this.dailyLoss = 0;
      this.lastLossReset = today;
    }
    this.dailyLoss += profit;
    if (this.dailyLoss < 0) logger.warn(`[Risk] Daily realised loss: ${this.dailyLoss.toFixed(2)} €`);
    const isWin = profit > 0;
    this.recentResults.push(isWin ? 1 : 0);
    if (this.recentResults.length > 20) this.recentResults.shift();
    if (isWin) { this.winStreak++; this.lossStreak = 0; }
    else { this.lossStreak++; this.winStreak = 0; }
    this.updateDynamicRiskAndThreshold();
  }
  updateDynamicRiskAndThreshold() {
    // Win rate over last 20 trades
    const winRate = this.recentResults.length ? this.recentResults.reduce((a,b)=>a+b,0)/this.recentResults.length : 0.5;
    // Dynamic risk: increase after 2+ wins, decrease after 2+ losses
    if (this.winStreak >= 2) {
      this.dynamicRiskPerTrade = Math.min(this.dynamicRiskPerTrade * 1.2, this.maxRiskPerTrade);
    } else if (this.lossStreak >= 2) {
      this.dynamicRiskPerTrade = Math.max(this.dynamicRiskPerTrade * 0.7, this.minRiskPerTrade);
    } else {
      this.dynamicRiskPerTrade += (RISK_PER_TRADE - this.dynamicRiskPerTrade) * 0.1;
    }
    // Dynamic signal threshold: stricter if win rate < 50%, looser if > 65%
    if (winRate > 0.65) {
      this.dynamicSignalThreshold = Math.max(this.minSignalThreshold, this.dynamicSignalThreshold - 1);
    } else if (winRate < 0.5) {
      this.dynamicSignalThreshold = Math.min(this.maxSignalThreshold, this.dynamicSignalThreshold + 1);
    } else {
      this.dynamicSignalThreshold += (3 - this.dynamicSignalThreshold) * 0.2;
    }
    this.dynamicSignalThreshold = Math.round(this.dynamicSignalThreshold);
    logger.info(`[Adaptive] Risk: ${(this.dynamicRiskPerTrade*100).toFixed(2)}%, SignalThreshold: ${this.dynamicSignalThreshold}, WinRate: ${(winRate*100).toFixed(1)}%`);
  }

  // --- Signal Evaluation ---
  evaluateSignals(buyConditions, sellConditions) {
    const threshold = this.dynamicSignalThreshold || 3;
    const buyScore = buyConditions.filter(Boolean).length;
    const sellScore = sellConditions.filter(Boolean).length;
    logger.info(`[Signal] BuyScore: ${buyScore}/${buyConditions.length}, SellScore: ${sellScore}/${sellConditions.length}, Threshold: ${threshold}`);
    let signal = null;
    if (buyScore >= threshold) signal = "buy";
    else if (sellScore >= threshold) signal = "sell";
    return { signal, buyScore, sellScore };
  }

  // --- Market Filters ---
  passesRangeFilter(indicators, price) {
    const { RANGE_FILTER } = ANALYSIS;
    if (!RANGE_FILTER?.ENABLED) return true;
    if (!indicators) return true;
    // ATR filter
    if (indicators.atr && price) {
      const atrPct = indicators.atr / price;
      if (atrPct < RANGE_FILTER.MIN_ATR_PCT) {
        logger.info(`[RangeFilter] ATR too low (${(atrPct*100).toFixed(3)}%). Skipping signal.`);
        return false;
      }
    }
    // Bollinger Band width filter
    if (indicators.bb && price) {
      const bbWidth = indicators.bb.upper - indicators.bb.lower;
      const bbWidthPct = bbWidth / price;
      if (bbWidthPct < RANGE_FILTER.MIN_BB_WIDTH_PCT) {
        logger.info(`[RangeFilter] BB width too low (${(bbWidthPct*100).toFixed(3)}%). Skipping signal.`);
        return false;
      }
    }
    // EMA distance filter
    if (indicators.emaFast && indicators.emaSlow && price) {
      const emaDist = Math.abs(indicators.emaFast - indicators.emaSlow);
      const emaDistPct = emaDist / price;
      if (emaDistPct < RANGE_FILTER.MIN_EMA_DIST_PCT) {
        logger.info(`[RangeFilter] EMA distance too low (${(emaDistPct*100).toFixed(3)}%). Skipping signal.`);
        return false;
      }
    }
    return true;
  }
  // --- Regime filter: identify trending market (ATR % + ADX)
  /*
  isTrending(indicators, price) {
    if (!indicators || !price) return false;
    const atrPct = indicators.atr ? indicators.atr / price : 0;
    // Loosened: allow trading if ATR >= 0.0001 (0.01%)
    // Ignore ADX for now (or use only if present and >15)
    const adx = indicators.adx ?? null;
    const trending = atrPct >= 0.0001 && (adx === null ? true : adx > 15);
    logger.info(`[Regime] atrPct=${(atrPct*100).toFixed(2)}% adx=${adx} trending=${trending}`);
    return trending;
  }
  */
  isActiveSession() {
    const now = new Date();
    const month = now.getUTCMonth();
    const offset = month >= 2 && month <= 9 ? 2 : 1;
    const mezHour = (now.getUTCHours() + offset) % 24;
    const active = mezHour >= this.sessionStart && mezHour <= this.sessionEnd;
    if (!active) logger.info(`[Session] Outside active window (${this.sessionStart}‑${this.sessionEnd} MEZ). Hour=${mezHour}`);
    return active;
  }

  // --- Signal Generation ---
  async generateAndValidateSignal(candle, message, symbol, bid, ask) {
    const indicators = candle.indicators || {};
    const trendAnalysis = message.trendAnalysis;
    const price = bid || ask || 1;
    if (!this.passesRangeFilter(indicators.m15 || indicators, price)) {
      logger.info(`[Signal] Skipping ${symbol} due to range filter.`);
      return { signal: null, buyScore: 0, sellScore: 0 };
    }
    // const trending = this.isTrending(indicators.m15 || indicators, price);
    // if (!trending) {
    //   logger.info(`[Regime] ${symbol} is not trending – skipping signal.`);
    //   return { signal: null, buyScore: 0, sellScore: 0 };
    // }
    const result = this.generateSignals(symbol, message.h4Data, indicators.h4, indicators.h1, indicators.m15, trendAnalysis, bid, ask);
    if (!result.signal) {
      logger.info(`[Signal] No valid signal for ${symbol}. BuyScore: ${result.buyScore}, SellScore: ${result.sellScore}`);
    } else {
      logger.info(`[Signal] Signal for ${symbol}: ${result.signal.toUpperCase()}`);
    }
    return result;
  }
  generateBuyConditions(h4, h1, m15, trend, bid) {
    return [
      h4.emaFast > h4.emaSlow,
      h4.macd?.histogram > 0,
      h1.ema9 > h1.ema21,
      h1.rsi < RSI_CONFIG.EXIT_OVERSOLD,
      m15.isBullishCross,
      m15.rsi < RSI_CONFIG.OVERSOLD,
      bid <= m15.bb?.lower,
    ];
  }
  generateSellConditions(h4, h1, m15, trend, ask) {
    return [
      !h4.isBullishTrend,
      h4.macd?.histogram < 0,
      h1.ema9 < h1.ema21,
      h1.rsi > RSI_CONFIG.EXIT_OVERBOUGHT,
      m15.isBearishCross,
      m15.rsi > RSI_CONFIG.OVERBOUGHT,
      ask >= m15.bb?.upper,
    ];
  }
  generateSignals(symbol, h4Data, h4, h1, m15, trend, bid, ask) {
    if (!this.validateIndicatorData(h4Data, h4, h1, m15, trend)) return { signal: null };
    const buyConditions = this.generateBuyConditions(h4, h1, m15, trend, bid);
    const sellConditions = this.generateSellConditions(h4, h1, m15, trend, ask);
    return this.evaluateSignals(buyConditions, sellConditions);
  }

  // --- Trade Parameter Calculation ---
  async calculateTradeParameters(signal, symbol, bid, ask, h4Indicators) {
    const price = signal === "buy" ? ask : bid;
    const atr = await this.calculateATR(symbol);
    const stopLossPips = 2 * atr; // More buffer
    const stopLossPrice = signal === "buy" ? price - stopLossPips : price + stopLossPips;
    // Adaptive TP: higher TP if in strong trend, lower TP in choppy markets
    const strongTrend = h4Indicators && h4Indicators.macd?.histogram > 0 && h4Indicators.emaFast > h4Indicators.emaSlow;
    const takeProfitMultiplier = strongTrend ? 2.0 : 1.2;
    const takeProfitPips = takeProfitMultiplier * stopLossPips;
    const takeProfitPrice = signal === "buy" ? price + takeProfitPips : price - takeProfitPips;
    const size = this.positionSize(this.accountBalance, price, stopLossPips, symbol);
    logger.info(`[TradeParams] Size: ${size}`);
    // Trailing stop parameters
    const trailingStopParams = {
      activationPrice: signal === "buy" ? price + stopLossPips : price - stopLossPips,
      trailingDistance: atr,
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

  // --- TP/SL Validation ---
  async validateTPandSL(symbol, direction, entryPrice, stopLossPrice, takeProfitPrice) {
    const range = await getAllowedTPRange(symbol);
    let newTP = takeProfitPrice;
    let newSL = stopLossPrice;
    const decimals = range.decimals || 5;
    if (direction === "buy") {
      const minTP = entryPrice + range.minTPDistance * Math.pow(10, -decimals);
      const maxTP = entryPrice + range.maxTPDistance * Math.pow(10, -decimals);
      if (newTP < minTP) { logger.warn(`[TP Validation] TP (${newTP}) < min allowed (${minTP}). Adjusting.`); newTP = minTP; }
      if (newTP > maxTP) { logger.warn(`[TP Validation] TP (${newTP}) > max allowed (${maxTP}). Adjusting.`); newTP = maxTP; }
      const minSL = entryPrice - range.maxSLDistance * Math.pow(10, -decimals);
      const maxSL = entryPrice - range.minSLDistance * Math.pow(10, -decimals);
      if (newSL < minSL) { logger.warn(`[SL Validation] SL (${newSL}) < min allowed (${minSL}). Adjusting.`); newSL = minSL; }
      if (newSL > maxSL) { logger.warn(`[SL Validation] SL (${newSL}) > max allowed (${maxSL}). Adjusting.`); newSL = maxSL; }
    } else {
      const minTP = entryPrice - range.maxTPDistance * Math.pow(10, -decimals);
      const maxTP = entryPrice - range.minTPDistance * Math.pow(10, -decimals);
      if (newTP > maxTP) { logger.warn(`[TP Validation] TP (${newTP}) > max allowed (${maxTP}). Adjusting.`); newTP = maxTP; }
      if (newTP < minTP) { logger.warn(`[TP Validation] TP (${newTP}) < min allowed ( ${minTP}). Adjusting.`); newTP = minTP; }
      const minSL = entryPrice + range.minSLDistance * Math.pow(10, -decimals);
      const maxSL = entryPrice + range.maxSLDistance * Math.pow(10, -decimals);
      if (newSL < minSL) { logger.warn(`[SL Validation] SL (${newSL}) < min allowed (${minSL}). Adjusting.`); newSL = minSL; }
      if (newSL > maxSL) { logger.warn(`[SL Validation] SL (${newSL}) > max allowed (${maxSL}). Adjusting.`); newSL = maxSL; }
    }
    return { stopLossPrice: newSL, takeProfitPrice: newTP };
  }

  // --- TRADE EXECUTION & MANAGEMENT ---
  async executeTrade(symbol, entrySignal, positionSize, candle, indicators) {
    try {
      // Place order (pseudo-code, replace with actual API call)
      logger.info(`[${symbol}] Executing ${entrySignal.side} trade. Size: ${positionSize.toFixed(2)}. Reason: ${entrySignal.reason}`);
      // await api.placeOrder(symbol, entrySignal.side, positionSize, ...)
      this.lastTradeTimestamps[symbol] = Date.now();
      // Do NOT push to openTrades here; always refresh from broker after placing a trade
      try {
        const positions = await getOpenPositions();
        if (positions?.positions) {
          this.setOpenTrades(positions.positions.map((p) => p.market.epic));
          logger.info(`[Trade] Refreshed open trades after placing new position. Currently open: ${positions.positions.length}`);
        }
      } catch (err) {
        logger.warn(`[Trade] Could not refresh open trades after placing new position:`, err.message || err);
      }
      // Update streaks
      this.updateStreaks(true); // Assume win for now, update on close
    } catch (err) {
      logger.error(`[${symbol}] Trade execution failed: ${err.message}`);
    }
  }

  updateStreaks(win) {
    if (win) {
      this.winStreak++;
      this.lossStreak = 0;
    } else {
      this.lossStreak++;
      this.winStreak = 0;
    }
  }

  // --- Trade Execution ---
  async executePosition(signal, symbol, params, expectedPrice) {
    const { size, stopLossPrice, takeProfitPrice, trailingStopParams } = params;
    try {
      const position = await placePosition(symbol, signal, size, null, stopLossPrice, takeProfitPrice);
      if (position?.dealReference) {
        const { getDealConfirmation } = await import("../api.js");
        const confirmation = await getDealConfirmation(position.dealReference);
        if (confirmation.dealStatus !== 'ACCEPTED' && confirmation.dealStatus !== 'OPEN') {
          logger.error(`[Order] Not placed: ${confirmation.reason || confirmation.reasonCode}`);
        }
        if (confirmation.level && expectedPrice) {
          const { TRADING } = await import("../config.js");
          const decimals = 5;
          const pip = Math.pow(10, -decimals);
          const slippage = Math.abs(confirmation.level - expectedPrice) / pip;
          if (slippage > TRADING.MAX_SLIPPAGE_PIPS) {
            logger.warn(`[Slippage] ${symbol}: Intended ${expectedPrice}, Executed ${confirmation.level}, Slippage: ${slippage.toFixed(1)} pips (max allowed: ${TRADING.MAX_SLIPPAGE_PIPS})`);
          } else {
            logger.info(`[Slippage] ${symbol}: Intended ${expectedPrice}, Executed ${confirmation.level}, Slippage: ${slippage.toFixed(1)} pips`);
          }
        }
      }
      return position;
    } catch (error) {
      logger.error(`[Position] Failed for ${symbol}:`, error);
      throw error;
    }
  }

  // --- POSITION SIZING ---
  calculatePositionSize(account, symbol, candle, indicators, entrySignal) {
    // Dynamic risk per trade based on streaks and win rate
    let risk = this.dynamicRiskPerTrade;
    if (this.winStreak >= MAX_WIN_STREAK) risk = Math.max(this.minRiskPerTrade, risk * 0.7);
    if (this.lossStreak >= MAX_LOSS_STREAK) risk = Math.min(this.maxRiskPerTrade, risk * 1.3);
    risk = Math.max(this.minRiskPerTrade, Math.min(this.maxRiskPerTrade, risk));

    // Calculate stop distance (ATR-based)
    const atr = indicators.atr || 0.001;
    const stopDistance = atr * 2;
    const riskAmount = account.balance * risk;
    const positionSize = riskAmount / stopDistance;

    // Enforce min/max size
    const minSize = this.symbolMinSizes[symbol] || 1;
    if (positionSize < minSize) return 0;
    return positionSize;
  }
  getPipValue(symbol) { return symbol.includes("JPY") ? 0.01 : 0.0001; }

  // --- ATR Calculation ---
  async calculateATR(symbol) {
    try {
      const data = await getHistorical(symbol, ANALYSIS.TIMEFRAMES.ENTRY, 15);
      if (!data?.prices || data.prices.length < 21) throw new Error("Insufficient data for ATR calculation");
      const highs = data.prices.map((b) => (b.high && typeof b.high === 'object' && b.high.bid != null && b.high.ask != null) ? (b.high.bid + b.high.ask) / 2 : (typeof b.high === 'number' ? b.high : b.high?.bid ?? b.high?.ask ?? 0));
      const lows = data.prices.map((b) => (b.low && typeof b.low === 'object' && b.low.bid != null && b.low.ask != null) ? (b.low.bid + b.low.ask) / 2 : (typeof b.low === 'number' ? b.low : b.low?.bid ?? b.low?.ask ?? 0));
      const closes = data.prices.map((b) => (b.close && typeof b.close === 'object' && b.close.bid != null && b.close.ask != null) ? (b.close.bid + b.close.ask) / 2 : (typeof b.close === 'number' ? b.close : b.close?.bid ?? b.close?.ask ?? 0));
      const atrArr = ATR.calculate({ period: 21, high: highs, low: lows, close: closes });
      return atrArr.length ? atrArr[atrArr.length - 1] : 0.001;
    } catch (error) {
      logger.error("[ATR] Error:", error);
      return 0.001;
    }
  }

  // --- MAIN TRADE LOOP ---
  async onNewCandle({ symbol, candles, indicators, account }) {
    // 1. Check if trading session is open
    if (!this.isWithinSession()) {
      logger.info(`[${symbol}] Outside trading session hours.`);
      return;
    }

    // 2. Reset daily loss if new day
    this.resetDailyLossIfNeeded();

    // 3. Check daily loss limit
    if (this.dailyLossExceeded()) {
      logger.warn(`[${symbol}] Daily loss limit reached. No more trades today.`);
      return;
    }

    // 4. Cooldown between trades
    if (!this.canTradeNow(symbol)) {
      logger.info(`[${symbol}] Cooldown active. Waiting before next trade.`);
      return;
    }

    // 5. Get latest candle and indicators
    const candle = candles[candles.length - 1];
    if (!candle || !indicators) {
      logger.warn(`[${symbol}] Missing candle or indicators.`);
      return;
    }

    // 6. Evaluate entry signal
    const entrySignal = this.getEntrySignal(symbol, candle, indicators);
    if (!entrySignal) {
      logger.debug(`[${symbol}] No entry signal.`);
      return;
    }

    // 7. Calculate position size
    const positionSize = this.calculatePositionSize(account, symbol, candle, indicators, entrySignal);
    if (!positionSize || positionSize <= 0) {
      logger.warn(`[${symbol}] Position size too small or invalid.`);
      return;
    }

    // 8. Execute trade
    await this.executeTrade(symbol, entrySignal, positionSize, candle, indicators);
  }

  // --- SESSION & LOSS MANAGEMENT ---
  isWithinSession() {
    const now = new Date();
    const hour = now.getHours();
    return hour >= this.sessionStart && hour < this.sessionEnd;
  }

  resetDailyLossIfNeeded() {
    const today = new Date().toDateString();
    if (this.lastLossReset !== today) {
      this.dailyLoss = 0;
      this.lastLossReset = today;
      logger.info('Daily loss counter reset.');
    }
  }

  dailyLossExceeded() {
    return this.dailyLoss <= -this.dailyLossLimitPct * this.accountBalance;
  }

  canTradeNow(symbol) {
    const last = this.lastTradeTimestamps[symbol];
    if (!last) return true;
    const now = Date.now();
    return (now - last) > COOLDOWN_BETWEEN_TRADES_MINUTES * 60 * 1000;
  }

  // --- Signal Processing ---
  async processPrice(message, maxOpenTrades) {
    let symbol = null;
    try {
      if (!message) return;
      const candle = message;
      symbol = candle.symbol || candle.epic;
      logger.info(`\n\n=== Processing ${symbol} ===`);
      logger.info("");
      logger.info(`[ProcessPrice] Open trades: ${this.openTrades.length}/${maxOpenTrades} | Balance: ${this.accountBalance}€`);
      if (this.openTrades.length >= maxOpenTrades) {
        logger.info(`[ProcessPrice] Max trades reached. Skipping ${symbol}.`);
        return;
      }
      if (this.isSymbolTraded(symbol)) {
        logger.info(`[ProcessPrice] ${symbol} already has an open position.`);
        return;
      }
      const bid = candle.close?.bid;
      const ask = candle.close?.ask;
      if (!this.validatePrices(bid, ask, symbol)) return;
      logger.info(`[ProcessPrice] Checking entry for ${symbol}. Bid: ${bid}, Ask: ${ask}`);
      const { signal, buyScore, sellScore } = await this.generateAndValidateSignal(candle, message, symbol, bid, ask);
      logger.info(`[ProcessPrice] Signal: ${signal}, BuyScore: ${buyScore}, SellScore: ${sellScore}, Threshold: ${this.dynamicSignalThreshold}`);
      if (!signal) {
        logger.info(`[ProcessPrice] No entry signal for ${symbol}. Skipping.`);
        return;
      }
      const indicators = candle.indicators || {};
      await this.executeTrade(signal, symbol, bid, ask, indicators.h4);
    } catch (error) {
      logger.error(`[ProcessPrice] Error for ${symbol}:`, error);
    }
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
          logger.warn(`[Monitor] getOpenPositions failed (attempt ${attempt}/3): ${err.message || err}`);
          await new Promise(res => setTimeout(res, 1000 * attempt));
        } else {
          logger.error(`[Monitor] getOpenPositions failed:`, err);
          break;
        }
      }
    }
    if (!positionsData?.positions) {
      logger.error(`[Monitor] Could not fetch open positions after 3 attempts`, lastError);
      return;
    }
    const now = Date.now();
    for (const p of positionsData.positions) {
      const symbol = p.market.epic;
      const direction = p.position.direction.toLowerCase();
      const dealId = p.position.dealId;
      const entry = p.position.openLevel;
      const size = p.position.size;
      const stopLevel = p.position.stopLevel;
      const tpLevel = p.position.limitLevel;
      const openTime = new Date(p.position.createdDate).getTime();
      const price = direction === "buy" ? p.market.bid : p.market.offer;
      const profit = (direction === "buy" ? price - entry : entry - price) * size;
      const indicators = latestIndicatorsBySymbol[symbol];
      if (!indicators) continue;

      // --- Track max profit for aggressive trailing and breakeven ---
      if (!p.position._maxProfit) p.position._maxProfit = 0;
      p.position._maxProfit = Math.max(p.position._maxProfit, profit);
      const maxProfit = p.position._maxProfit;
      // --- Helper imports ---
      const { isTrendWeak, getTPProgress } = await import("../indicators.js");
      const tpProgress = getTPProgress(entry, price, tpLevel, direction.toUpperCase());
      const holdMinutes = (now - openTime) / 60000;

      // --- Pyramiding‑Light: add up to 2 extra legs when +1 R reached ---
      if (!p.position._legsAdded) p.position._legsAdded = 0;
      try {
        const riskPips = Math.abs(entry - stopLevel);
        const rewardPips = Math.abs(price - entry);
        const R = rewardPips / riskPips;
        // Add leg at +1 R and +2 R, max 2 legs
        if (R >= (p.position._legsAdded + 1) && p.position._legsAdded < 2) {
          const addSize = size * 0.5; // 50 % der Ursprung‑Größe
          await placePosition(symbol, direction, addSize, null, stopLevel, tpLevel);
          p.position._legsAdded += 1;
          logger.info(`[Pyramiding] Added leg ${p.position._legsAdded} on ${symbol} (+${(p.position._legsAdded)} R). New size: ${size + addSize * p.position._legsAdded}`);
          // Move SL aller Legs auf Breakeven
          const breakevenStop = entry;
          await updateTrailingStop(dealId, breakevenStop);
          logger.info(`[Pyramiding] Stop moved to breakeven for ${symbol} at ${breakevenStop}`);
        }
      } catch (err) {
        logger.warn(`[Pyramiding] Could not add leg for ${symbol}: ${err.message}`);
      }

      // 1. Partial close & trailing stop if 60% TP reached and trend is weak
      if (tpProgress >= 60 && isTrendWeak(indicators, direction.toUpperCase())) {
        // Partial close: close 50% of position if possible
        if (size > 1) {
          const partialSize = size / 2;
          try {
            await placePosition(symbol, direction, -partialSize, null, null, null); // Negative size to reduce
            logger.info(`[PartialClose] Closed 50% of ${symbol} at ${price} (size: ${partialSize}) due to weak trend at 60% TP.`);
          } catch (e) {
            logger.warn(`[PartialClose] Could not partially close ${symbol}:`, e.message);
          }
        }
        // Tighten trailing stop to lock in profit
        const newStop = direction === "buy" ? price - indicators.atr : price + indicators.atr;
        // --- Trailing stop validation (Capital.com expects stop to be at least minStopDistance from current price, and on correct side) ---
        const range = await getAllowedTPRange(symbol);
        const decimals = range.decimals || 5;
        const minStopDistance = range.minSLDistance * Math.pow(10, -decimals);
        let valid = false;
        if (direction === "buy") {
          // For buy, stop must be BELOW current price by at least minStopDistance
          if (newStop < price - minStopDistance) valid = true;
        } else {
          // For sell, stop must be ABOVE current price by at least minStopDistance
          if (newStop > price + minStopDistance) valid = true;
        }
        logger.info(`[TrailingStop] Validation for ${symbol}: direction=${direction}, price=${price}, newStop=${newStop}, minStopDistance=${minStopDistance}, valid=${valid}`);
        if (valid) {
          await updateTrailingStop(dealId, newStop);
          logger.info(`[TrailingStop] Tightened for ${symbol} to ${newStop} after partial close.`);
        } else {
          logger.warn(`[TrailingStop] Not updated for ${symbol}: newStop ${newStop} not valid (must be at least ${minStopDistance} from price ${price})`);
        }
      }

      // 2. Timed exit: if held > 1 hour and 40% TP reached, close fully
      if (holdMinutes > 60 && tpProgress >= 40) {
        if (typeof this.closePosition === "function") {
          await this.closePosition(dealId);
          logger.info(`[TimedExit] Closed ${symbol} after >1h and 40% TP reached. Profit: ${profit}`);
          continue;
        }
      }

      // 3. Trailing Stop Step based on R multiples
      // Remove old aggressive trailing stop logic and replace with stepped trailing stop
      // --- Trailing stop validation ---
      const range = await getAllowedTPRange(symbol);
      const decimals = range.decimals || 5;
      const minStopDistance = range.minSLDistance * Math.pow(10, -decimals);

      let stepTrail = false;
      let steppedStop = stopLevel;
      // Calculate R multiple
      const rMultiple = profit / (Math.abs(entry - stopLevel) * size);
      let trailDistance = null;

      if (rMultiple >= 2) {
        trailDistance = indicators.atr * 0.5;
      } else if (rMultiple >= 1) {
        trailDistance = indicators.atr * 0.8;
      }

      if (trailDistance) {
        if (direction === "buy") {
          const candidate = price - trailDistance;
          if (candidate > stopLevel + minStopDistance) {
            steppedStop = candidate;
            stepTrail = true;
          }
        } else {
          const candidate = price + trailDistance;
          if (candidate < stopLevel - minStopDistance) {
            steppedStop = candidate;
            stepTrail = true;
          }
        }
      }

      if (stepTrail && steppedStop !== stopLevel) {
        await updateTrailingStop(dealId, steppedStop);
        logger.info(`[TrailingStep] Updated for ${symbol} at ${steppedStop} based on +${rMultiple.toFixed(2)}R`);
      }

      // 4. Dynamic exit on reversal: if price retraces 50% from max profit, close
      if (maxProfit > 0 && profit < maxProfit * 0.5 && tpProgress > 30) {
        if (typeof this.closePosition === "function") {
          await this.closePosition(dealId);
          logger.info(`[ReversalExit] Closed ${symbol} after retrace >50% from max profit. Locked: ${profit}`);
          this.updateTradeResult(profit);
          continue;
        }
      }

      // 5. Indicator-based exit: close if trend reverses (regardless of profit)
      let exitReason = null;
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
      if (exitReason) {
        if (typeof this.closePosition === "function") {
          await this.closePosition(dealId);
          logger.info(`[Exit] Closed ${symbol} (${direction}) due to: ${exitReason}, profit/loss: ${profit}`);
          this.updateTradeResult(profit); // <-- Track result
        } else {
          logger.info(`[Exit] Would close ${symbol} (${direction}) due to: ${exitReason}, profit/loss: ${profit}`);
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

  // --- EXIT LOGIC (SKELETON, FOR CLARITY) ---
  manageOpenTrades(candle, indicators) {
    // For each open trade, check exit conditions
    for (const trade of this.openTrades) {
      // Example: aggressive trailing stop, break-even, reversal exit, partial exit
      // ...implement exit logic here...
      // Log exit actions
      // logger.info(`[${trade.symbol}] Exiting trade at ${candle.close} due to ...`);
    }
  }

  // --- ENTRY SIGNAL LOGIC ---
  getEntrySignal(symbol, candle, indicators) {
    // Example: Use regime, RSI, and trend for entry
    const { regime, rsi, adx, atr } = indicators;
    if (!regime || !rsi) return null;

    // Regime filter (trend strength)
    if (typeof adx === 'number' && adx < 15) return null;
    if (typeof atr === 'number' && atr < 0.0005) return null;

    // Adaptive signal threshold
    let threshold = this.dynamicSignalThreshold;
    if (this.winStreak >= MAX_WIN_STREAK) threshold++;
    if (this.lossStreak >= MAX_LOSS_STREAK) threshold--;
    threshold = Math.max(this.minSignalThreshold, Math.min(this.maxSignalThreshold, threshold));

    // Buy signal
    if (regime > threshold && rsi < RSI_CONFIG.OVERSOLD) {
      return { side: 'buy', reason: 'Regime+RSI' };
    }
    // Sell signal
    if (regime < -threshold && rsi > RSI_CONFIG.OVERBOUGHT) {
      return { side: 'sell', reason: 'Regime+RSI' };
    }
    return null;
  }
}

export default new TradingService();
