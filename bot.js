// --- TradingBot: Main orchestrator for trading logic, data flow, and scheduling ---
// Human-readable, robust, and well-commented for maintainability.

import { startSession, pingSession, getHistorical, getAccountInfo, getOpenPositions, getSessionTokens, refreshSession } from "./api.js";
import { TRADING, MODE, DEV, ANALYSIS } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import { calcIndicators } from "./indicators.js";
import logger from "./utils/logger.js";

const { SYMBOLS, MAX_POSITIONS } = TRADING;
const { BACKTEST_MODE } = MODE;

class TradingBot {
  constructor() {
    this.isRunning = false;
    this.analysisInterval = null;
    this.sessionRefreshInterval = null;
    this.pingInterval = 9 * 60 * 1000;
    this.maxRetries = 3;
    this.retryDelay = 30000; // 30 seconds
    this.latestCandles = {}; // Store latest candles for each symbol
    this.monitorInterval = null; // Add monitor interval for open trades
  }

  /**
   * Initializes the bot, handles session retries, and starts trading or backtest mode.
   */
  async initialize() {
    let retryCount = 0;

    while (retryCount < this.maxRetries) {
      try {
        await startSession();
        const tokens = getSessionTokens();

        if (!tokens.cst || !tokens.xsecurity) {
          logger.error(`[Bot] Invalid session tokens, attempt ${retryCount + 1}/${this.maxRetries}`);
          throw new Error("Invalid session tokens");
        }

        if (!BACKTEST_MODE) {
          await this.startLiveTrading(tokens);
        } else {
          await this.runBacktest();
        }

        return; // Success, exit the retry loop
      } catch (error) {
        retryCount++;
        logger.error(`[Bot] Initialization attempt ${retryCount} failed:`, error);

        if (retryCount < this.maxRetries) {
          logger.info(`[Bot] Refreshing session and retrying in ${this.retryDelay / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
          await refreshSession();
        } else {
          logger.error("[Bot] Max retry attempts reached. Shutting down.");
          throw error;
        }
      }
    }
  }

  /**
   * Starts live trading mode: sets up WebSocket, session ping, analysis, and trade monitoring.
   */
  async startLiveTrading(tokens) {
    this.setupWebSocket(tokens);
    this.startSessionPing();
    this.startAnalysisInterval();
    this.startMonitorOpenTrades();
    this.isRunning = true;
  }

  /**
   * Sets up the WebSocket connection for real-time price data.
   * Handles incoming messages and merges bid/ask candles for analysis.
   */
  setupWebSocket(tokens) {
    webSocketService.connect(tokens, SYMBOLS, (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.payload?.epic) {
          const candle = message.payload;
          const symbol = candle.epic;
          const timestamp = candle.t;

          // Initialize storage for this symbol if needed
          if (!this.latestCandles[symbol]) this.latestCandles[symbol] = {};

          // Store bid/ask by timestamp
          if (!this.latestCandles[symbol][timestamp]) this.latestCandles[symbol][timestamp] = {};
          this.latestCandles[symbol][timestamp][candle.priceType] = candle;

          // If both bid and ask are present for this timestamp, merge and analyze
          const merged = this.latestCandles[symbol][timestamp];
          if (merged.bid && merged.ask) {
            const mergedCandle = {
              epic: symbol,
              timestamp,
              open: { bid: merged.bid.o, ask: merged.ask.o },
              high: { bid: merged.bid.h, ask: merged.ask.h },
              low: { bid: merged.bid.l, ask: merged.ask.l },
              close: { bid: merged.bid.c, ask: merged.ask.c },
              lastTradedVolume: merged.bid.lastTradedVolume || merged.ask.lastTradedVolume,
              complete: candle.complete,
              snapshotTimeUTC: candle.snapshotTimeUTC,
            };
            // Store the merged candle for analysis
            this.latestCandles[symbol].latest = mergedCandle;
            // Only analyze on completed candles
            if (candle.complete || candle.snapshotTimeUTC) {
              this.analyzeSymbol(symbol);
            }
          }
        } else {
          // Log all other messages for debugging
          // console.log("[WebSocket] Message received but no epic:", message);
        }
      } catch (error) {
        logger.error("WebSocket message processing error:", error.message, data?.toString());
      }
    });
  }

  /**
   * Starts a periodic session ping to keep the API session alive.
   */
  startSessionPing() {
    this.sessionPingInterval = setInterval(async () => {
      try {
        await pingSession();
        logger.info("Session pinged successfully");
      } catch (error) {
        logger.error("Session ping failed:", error.message);
      }
    }, this.pingInterval);
  }

  /**
   * Starts the periodic analysis interval for scheduled trading logic.
   */
  startAnalysisInterval() {
    const interval = MODE.DEV_MODE ? DEV.ANALYSIS_INTERVAL_MS : 15 * 60 * 1000;
    logger.info(`[${MODE.DEV_MODE ? 'DEV' : 'PROD'}] Starting analysis interval: ${interval}s`);
    this.analysisInterval = setInterval(async () => {
      try {
        logger.info(`[Running scheduled analysis...`);
        await this.updateAccountInfo();
        await this.analyzeAllSymbols();
      } catch (error) {
        logger.error("Analysis interval error:", error);
      }
    }, interval);
  }

  /**
   * Updates account balance, margin, and open trades in the trading service.
   */
  async updateAccountInfo() {
    try {
      const accountData = await getAccountInfo();
      if (accountData?.accounts?.[0]?.balance?.balance) {
        tradingService.setAccountBalance(accountData.accounts[0].balance.balance);
        // Set available margin if present
        if (typeof accountData.accounts[0].balance.available !== 'undefined') {
          tradingService.setAvailableMargin(accountData.accounts[0].balance.available);
        }
      } else {
        throw new Error("Invalid account data structure");
      }

      const positions = await getOpenPositions();
      if (positions?.positions) {
        tradingService.setOpenTrades(positions.positions.map((p) => p.market.epic));
        logger.info(`Current open positions: ${positions.positions.length}`);
      }
    } catch (error) {
      logger.error("Failed to update account info:", error);
      throw error;
    }
  }

  /**
   * Fetches historical data for all required timeframes for a symbol.
   * Returns H4, H1, and M15 data objects.
   */
  async fetchHistoricalData(symbol) {
    const timeframes = MODE.DEV_MODE
      ? [DEV.TIMEFRAMES.TREND, DEV.TIMEFRAMES.SETUP, DEV.TIMEFRAMES.ENTRY]
      : [ANALYSIS.TIMEFRAMES.TREND, ANALYSIS.TIMEFRAMES.SETUP, ANALYSIS.TIMEFRAMES.ENTRY];

    const count = 220; // Fetch enough candles for EMA200
    const delays = [1000, 1000, 1000];
    const results = [];
    for (let i = 0; i < timeframes.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, delays[i - 1]));
      const data = await getHistorical(symbol, timeframes[i], count);
      results.push(data);
    }
    return {
      h4Data: results[0],
      h1Data: results[1],
      m15Data: results[2],
    };
  }

  /**
   * Analyzes a single symbol: fetches data, calculates indicators, and triggers trading logic.
   */
  async analyzeSymbol(symbol) {
    logger.info(`\n\n=== Processing ${symbol} ===`);

    // Fetch and calculate all required data
    const { h4Data, h1Data, m15Data } = await this.fetchHistoricalData(symbol);

    const indicators = {
      h4: await calcIndicators(h4Data.prices), // Trend direction
      h1: await calcIndicators(h1Data.prices), // Setup confirmation
      m15: await calcIndicators(m15Data.prices), // Entry/Exit timing
    };

    // We don't need separate trend analysis anymore as it's part of the H4 indicators
    const trendAnalysis = {
      h4Trend: indicators.h4.isBullishTrend ? "bullish" : "bearish",
      h4Indicators: indicators.h4,
    };

    // Use the latest real-time merged candle for bid/ask
    const latestCandle = this.latestCandles[symbol]?.latest;
    if (!latestCandle) {
      logger.info(`[Bot] No latest candle for ${symbol}, skipping analysis.`);
      return;
    }
    await tradingService.processPrice(
      {
        ...latestCandle,
        symbol: symbol,
        indicators,
        trendAnalysis,
        h4Data: h4Data.prices,
        h1Data: h1Data.prices,
        m15Data: m15Data.prices,
      },
      MAX_POSITIONS
    );
  }

  /**
   * Analyzes all symbols in the trading universe.
   */
  async analyzeAllSymbols() {
    for (const symbol of SYMBOLS) {
      if (!this.latestCandles[symbol]?.latest) continue;
      try {
        await this.analyzeSymbol(symbol);
      } catch (error) {
        logger.error(`Error analyzing ${symbol}:`, error.message);
      }
    }
  }

  /**
   * Runs a simple backtest (skeleton for future expansion).
   */
  async runBacktest() {
    try {
      const m1Data = await getHistorical("USDCAD", "MINUTE", 50);
      logger.info(`Backtest data fetched for USDCAD: ${m1Data.prices.length} candles`);
    } catch (error) {
      logger.error("Backtest error:", error.message);
    }
  }

  /**
   * Cleanly shuts down the bot and all intervals/connections.
   */
  async shutdown() {
    this.isRunning = false;
    clearInterval(this.analysisInterval);
    clearInterval(this.sessionRefreshInterval);
    webSocketService.disconnect();
  }

  /**
   * Fetches and stores minDealSize and dealSizeIncrement for all symbols.
   * Used for position sizing and validation.
   */
  async fetchAndStoreSymbolMinSizes() {
    const minSizes = {};
    for (const symbol of SYMBOLS) {
      try {
        const details = await import("./api.js").then((api) => api.getMarketDetails(symbol));
        const minDealSize = details.instrument?.minDealSize || 1;
        const dealSizeIncrement = details.instrument?.dealSizeIncrement || 1;
        minSizes[symbol] = { minDealSize, dealSizeIncrement };
        logger.info(`[SymbolConfig] ${symbol}: minDealSize=${minDealSize}, dealSizeIncrement=${dealSizeIncrement}`);
      } catch (e) {
        logger.warn(`[SymbolConfig] Could not fetch min size for ${symbol}:`, e.message);
        minSizes[symbol] = { minDealSize: 1, dealSizeIncrement: 1 };
      }
    }
    tradingService.setSymbolMinSizes(minSizes);
  }

  /**
   * Monitors open trades at a regular interval and triggers trade management logic.
   */
  startMonitorOpenTrades() {
    logger.info("[Monitoring] Starting open trade monitor interval (every 1 minute)");
    this.monitorInterval = setInterval(async () => {
      logger.info(`[Monitoring] Checking open trades at ${new Date().toISOString()}`);
      try {
        const latestIndicatorsBySymbol = {};
        for (const symbol of TRADING.SYMBOLS) {
          const mergedCandle = this.latestCandles[symbol]?.latest;
          logger.info(`[Monitoring] Symbol: ${symbol}, merged candle present: ${!!mergedCandle}`);
          if (mergedCandle) {
            latestIndicatorsBySymbol[symbol] = await calcIndicators([mergedCandle], symbol);
            logger.info(`[Monitoring] Calculated indicators for ${symbol}`);
          }
        }
        await tradingService.monitorOpenTrades(latestIndicatorsBySymbol);
        logger.info("[Monitoring] monitorOpenTrades completed");
      } catch (error) {
        logger.error("[Bot] Error in monitorOpenTrades:", error);
      }
    }, 1 * 60 * 1000); // every 1 min
  }
}

// Create and start the bot
const bot = new TradingBot();
bot.initialize().catch((error) => {
  logger.error("Bot initialization failed:", error);
  process.exit(1);
});
