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
    // --- Overtrading protection: cooldown per symbol ---
    this.lastTradeTimestamps = {};
    this.COOLDOWN_MINUTES = 15; // Minimum minutes between trades per symbol
    this.winStreak = 0;
    this.lossStreak = 0;
    this.recentResults = [];
    this.dynamicRiskPerTrade = RISK_PER_TRADE;
    this.dynamicSignalThreshold = 3; // Default, will adapt
    this.maxRiskPerTrade = 0.02; // 2% max
    this.minRiskPerTrade = 0.003; // 0.3% min
    this.maxSignalThreshold = 5;
    this.minSignalThreshold = 2;
    // --- Daily loss limit ---
    this.dailyLoss = 0;
    this.dailyLossLimitPct = 0.05; // 5 % vom Kontostand
    this.lastLossReset = new Date().toDateString();
    // --- Session trading window (MEZ / Berlin time) ---
    this.sessionStart = 8;   // 08:00 MEZ
    this.sessionEnd   = 18;  // 18:00 MEZ
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

  // Call this after each trade closes (profit > 0 = win, else loss)
  updateTradeResult(profit) {
    // -------- Daily reset ----------
    const today = new Date().toDateString();
    if (today !== this.lastLossReset) {
      this.dailyLoss = 0;
      this.lastLossReset = today;
    }
    // Track realised P/L
    this.dailyLoss += profit;
    if (this.dailyLoss < 0) logger.warn(`[Risk] Daily realised loss: ${this.dailyLoss.toFixed(2)} €`);

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
    // Use adaptive threshold
    const threshold = this.dynamicSignalThreshold || 3;
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

  // Regime filter: identify trending market (ATR % + ADX)
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

  // Session filter: trade only during London & NY overlap (08‑18 MEZ)
  isActiveSession() {
    // Convert current UTC hour to MEZ (+2 in summer, +1 in winter).
    const now = new Date();
    // crude daylight‑saving approximation (March‑Oct = +2, else +1)
    const month = now.getUTCMonth(); // 0=Jan
    const offset = month >= 2 && month <= 9 ? 2 : 1;
    const mezHour = (now.getUTCHours() + offset) % 24;
    const active = mezHour >= this.sessionStart && mezHour <= this.sessionEnd;
    if (!active) logger.info(`[Session] Outside active window (${this.sessionStart}‑${this.sessionEnd} MEZ). Hour=${mezHour}`);
    return active;
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
    // --- Regime filter (trend) ---
    const trending = this.isTrending(indicators.m15 || indicators, price);
    if (!trending) {
      logger.info(`[Regime] ${symbol} is not trending – skipping signal.`);
      return { signal: null, buyScore: 0, sellScore: 0 };
    }
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

    async executeTrade(signal, symbol, bid, ask, h4Indicators) {
    logger.trade(signal.toUpperCase(), symbol, { bid, ask });
    const params = await this.calculateTradeParameters(signal, symbol, bid, ask, h4Indicators);
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

  async calculateTradeParameters(signal, symbol, bid, ask, h4Indicators) {
    const price = signal === "buy" ? ask : bid;
    const atr = await this.calculateATR(symbol);
    if (!atr) {
      logger.warn(`[Trade] Skipping ${symbol} because ATR could not be calculated.`);
      return;
    }
    const stopLossPips = 2 * atr;           // mehr Puffer
    const stopLossPrice = signal === "buy" ? price - stopLossPips : price + stopLossPips;
    // Adaptive TP: higher TP if in strong trend, lower TP in choppy markets
    const strongTrend = h4Indicators && h4Indicators.macd?.histogram > 0 && h4Indicators.emaFast > h4Indicators.emaSlow;
    const takeProfitMultiplier = strongTrend ? 2.0 : 1.2;
    const takeProfitPips = takeProfitMultiplier * stopLossPips;
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
      const data = await getHistorical(symbol, ANALYSIS.TIMEFRAMES.ENTRY, 21);
      if (!data?.prices || data.prices.length < 21) {
        logger.warn(`[ATR] Not enough data to calculate ATR for ${symbol}. Needed 21, got ${data?.prices?.length || 0}. Skipping trade.`);
        return null; // Signal to skip trade
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
      return atrArr.length ? atrArr[atrArr.length - 1] : null;
    } catch (error) {
      logger.error(`[ATR] Unexpected error for ${symbol}: ${error.message}`);
      return null;
    }
  }

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
      // No cooldown logic: allow high-frequency trading
      const bid = candle.close?.bid;
      const ask = candle.close?.ask;
      if (!this.validatePrices(bid, ask, symbol)) return;
      // --- Diagnostic logging for entry ---
      logger.info(`[ProcessPrice] Checking entry for ${symbol}. Bid: ${bid}, Ask: ${ask}`);
      const { signal, buyScore, sellScore } = await this.generateAndValidateSignal(candle, message, symbol, bid, ask);
      logger.info(`[ProcessPrice] Signal: ${signal}, BuyScore: ${buyScore}, SellScore: ${sellScore}, Threshold: ${this.dynamicSignalThreshold}`);
      if (!signal) {
        logger.info(`[ProcessPrice] No entry signal for ${symbol}. Skipping.`);
        return;
      }
      // --- End diagnostics ---
      const indicators = candle.indicators || {};
      await this.executeTrade(signal, symbol, bid, ask, indicators.h4);
    } catch (error) {
      logger.error(`[ProcessPrice] Error for ${symbol}:`, error);
    }
  }

  positionSize(balance, entryPrice, stopLossPrice, symbol) {
    // --- Kelly Criterion Kick-In ---
    const recent = this.recentResults.slice(-20);
    const wins = recent.reduce((a, b) => a + b, 0);
    const losses = recent.length - wins;
    const winRate = recent.length > 0 ? wins / recent.length : 0.5;
    const rewardRiskRatio = 1.5; // assume 1.5R average payoff
    let kellyFraction = winRate - ((1 - winRate) / rewardRiskRatio);
    kellyFraction = Math.max(0.001, Math.min(kellyFraction, this.maxRiskPerTrade));
    const adjustedRisk = kellyFraction * 0.5; // safety factor to reduce aggressiveness
    logger.info(`[Kelly] WinRate=${(winRate*100).toFixed(1)}% KellyFraction=${(kellyFraction*100).toFixed(2)}% AdjustedRisk=${(adjustedRisk*100).toFixed(2)}%`);

    // Use dynamic risk per trade (now replaced by adjustedRisk)
    const riskAmount = balance * adjustedRisk;
    // Simpler, more aggressive sizing (like old version)
    const pipValue = this.getPipValue(symbol); // Dynamic pip value
    if (!pipValue || pipValue <= 0) {
      logger.error("Invalid pip value calculation");
      return 100; // Fallback with warning
    }
    const stopLossPips = Math.abs(entryPrice - stopLossPrice) / pipValue;
    if (stopLossPips === 0) return 0;
    let size = riskAmount / (stopLossPips * pipValue);
    size = size * 1000;
    size = Math.floor(size / 100) * 100;
    if (size < 100) size = 100;
    // --- Margin check for 5 simultaneous trades (no max positions from config, just divide by 5) ---
    const leverage = 30;
    const marginRequired = (size * entryPrice) / leverage;
    const availableMargin = this.accountBalance;
    const maxMarginPerTrade = availableMargin / 5;
    if (marginRequired > maxMarginPerTrade) {
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
}

export default new TradingService();
