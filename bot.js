import { startSession, pingSession, getHistorical, getAccountInfo, getOpenPositions, getSessionTokens, refreshSession } from "./api.js";
import { TRADING, MODE, DEV, ANALYSIS, SESSIONS } from "./config.js";
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

    // Define allowed trading windows (UTC, Berlin time for example)
    this.allowedTradingWindows = [
      // London: 08:15–16:45
      { start: 8 * 60 + 15, end: 16 * 60 + 45 },
      // NY: 13:15–20:45
      { start: 13 * 60 + 15, end: 20 * 60 + 45 },
      // Sydney: 22:15–6:45 (overnight, so split into two ranges)
      { start: 22 * 60 + 15, end: 23 * 60 + 59 },
      { start: 0, end: 6 * 60 + 45 },
      // Tokyo: 0:15–8:45
      { start: 0 * 60 + 15, end: 8 * 60 + 45 },
    ];
  }

  // Initialize the bot and start necessary services
  async initialize() {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await startSession();
        const tokens = getSessionTokens();
        if (!tokens.cst || !tokens.xsecurity) throw new Error("Invalid session tokens");
        await this.startLiveTrading(tokens);
        this.scheduleMidnightSessionRefresh();
        return;
      } catch (error) {
        console.error(`[Bot] Initialization attempt ${attempt} failed:`, error);
        if (attempt < this.maxRetries) {
          console.info(`[Bot] Retrying in ${this.retryDelay / 1000}s...`);
          await this.delay(this.retryDelay);
          await refreshSession();
        } else {
          console.error("[Bot] Max retry attempts reached. Shutting down.");
          process.exit(1);
        }
      }
    }
  }

  // Start live trading mode
  async startLiveTrading(tokens) {
    this.setupWebSocket(tokens);
    this.startSessionPing();
    this.startAnalysisInterval();
    this.isRunning = true;
  }

  // Set up WebSocket connection for real-time data
  setupWebSocket(tokens) {
    webSocketService.connect(tokens, SYMBOLS, (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.payload?.epic) {
          const candle = message.payload;
          // Improved: log every received candle for debugging
          // console.log("[WebSocket] Received candle for", candle.epic, candle);
          // Store the latest candle for the symbol
          this.latestCandles[candle.epic] = candle;
          // Only analyze on completed candles (avoid duplicates)
          if (candle.complete || candle.snapshotTimeUTC) {
            this.analyzeSymbol(candle.epic);
          }
        } else {
          // Log all other messages for debugging
          // console.log("[WebSocket] Message received but no epic:", message);
        }
      } catch (error) {
        console.error("WebSocket message processing error:", error.message, data?.toString());
      }
    });
  }

  // Start session ping interval
  startSessionPing() {
    this.sessionPingInterval = setInterval(async () => {
      try {
        await pingSession();
        console.log("Session pinged successfully");
      } catch (error) {
        console.error("Session ping failed:", error.message);
      }
    }, this.pingInterval);
  }

  // Start analysis interval
  startAnalysisInterval() {
    const getNextDelay = () =>
      ((5 - (new Date().getMinutes() % 5)) * 60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds() + 5000;

    const runAnalysis = async () => {
      try {
        // if (!this.isTradingAllowed()) {
        //     console.info("[Bot] Skipping analysis: Trading not allowed at this time.");
        //     return;
        // }
        await this.updateAccountInfo();
        await this.analyzeAllSymbols();
        await this.startMonitorOpenTrades();
      } catch (error) {
        console.error("[bot.js] Analysis interval error:", error);
      }
    };
    // First run: align to next 5th minute + 5 seconds
    const interval = DEV.MODE ? DEV.INTERVAL : getNextDelay();
    console.info(`[${DEV.MODE ? "DEV" : "PROD"}] Setting up analysis interval: ${interval}ms`);

    setTimeout(() => {
      runAnalysis();
      // After first run, repeat every 5 minutes
      this.analysisInterval = setInterval(runAnalysis, DEV.MODE ? DEV.INTERVAL : 5 * 60 * 1000);
    }, interval);
  }

  // Update account information and positions
  async updateAccountInfo() {
    let retries = 3;
    while (retries > 0) {
      try {
        const accountData = await getAccountInfo();
        if (accountData?.accounts?.[0]?.balance?.balance) {
          tradingService.setAccountBalance(accountData.accounts[0].balance.balance);
          if (typeof accountData.accounts[0].balance.available !== "undefined") {
            tradingService.setAvailableMargin(accountData.accounts[0].balance.available);
          }

          const positions = await getOpenPositions();
          if (positions?.positions) {
            tradingService.setOpenTrades(positions.positions.map((p) => p.market.epic));
            this.openedPositions = positions.positions.length;
            console.info(`Current open positions: ${positions.positions.length}`);
          }
          return; // Success - exit the method
        }
      } catch (error) {
        retries--;
        if (retries === 0) {
          console.error("[bot.js] Failed to update account info after all retries:", error);
          // Don't throw - just continue with old values
          return;
        }
        console.warn(`Account info update failed, retrying... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
      }
    }
  }

  // Get historical data for all timeframes
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

  // Analyze a single symbol
  async analyzeSymbol(symbol) {
    console.log(`Analyzing ${symbol}...`);

    // Fetch and calculate all required data
    const { h4Data, h1Data, m15Data } = await this.fetchHistoricalData(symbol);

    const indicators = {
      h4: await calcIndicators(h4Data.prices), // Trend direction
      h1: await calcIndicators(h1Data.prices), // Setup confirmation
      m15: await calcIndicators(m15Data.prices), // Entry/Exit timing
    };

    // Use the latest real-time candle for bid/ask
    const latestCandle = this.latestCandles[symbol];
    if (!latestCandle) {
      console.log(`[Bot] No latest candle for ${symbol}, skipping analysis.`);
      return;
    }
    await tradingService.processPrice(
      {
        ...latestCandle,
        symbol: symbol,
        indicators,
        h4Data: h4Data.prices,
        h1Data: h1Data.prices,
        m15Data: m15Data.prices,
      },
      MAX_POSITIONS
    );
  }

  getActiveSymbols() {
    const now = new Date();
    const hour = Number(now.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "Europe/Berlin" }));

    // Helper to check if hour is in session
    const inSession = (start, end) => {
      if (start < end) return hour >= start && hour < end;
      return hour >= start || hour < end; // Overnight session
    };

    const activeSessions = [];
    if (inSession(8, 17)) activeSessions.push(SESSIONS.LONDON.SYMBOLS);
    if (inSession(13, 21)) activeSessions.push(SESSIONS.NY.SYMBOLS);
    if (inSession(22, 7)) activeSessions.push(SESSIONS.SYDNEY.SYMBOLS);
    if (inSession(0, 9)) activeSessions.push(SESSIONS.TOKYO.SYMBOLS);

    // Combine symbols from all active sessions, remove duplicates
    let combined = [];
    activeSessions.forEach((arr) => combined.push(...arr));
    combined = [...new Set(combined)];

    logger.info(`[Bot] Active sessions: ${activeSessions.length}, Trading symbols: ${combined.join(", ")}`);
    return combined;
  }

  // Analyzes all symbols in the trading universe.
  async analyzeAllSymbols() {
    const activeSymbols = this.getActiveSymbols();
    for (const symbol of activeSymbols) {
      await this.analyzeSymbol(symbol);
      await this.delay(2000);
    }
  }

  // Clean shutdown
  async shutdown() {
    this.isRunning = false;
    clearInterval(this.analysisInterval);
    clearInterval(this.sessionRefreshInterval);
    webSocketService.disconnect();
  }

  async startMonitorOpenTrades() {
    console.info(`[Monitoring] Checking open trades at ${new Date().toISOString()}`);
    try {
      const positions = await getOpenPositions();
      for (const pos of positions.positions) {
        const symbol = pos.market ? pos.market.epic : pos.position.epic;

        // Fetch recent candles for the symbol (e.g. M15)
        const m15Data = await getHistorical(symbol, "MINUTE_15", 50);
        const indicators = await calcIndicators(m15Data.prices);

        const positionData = {
          symbol,
          dealId: pos.position.dealId,
          currency: pos.position.currency,
          direction: pos.position.direction,
          size: pos.position.size,
          leverage: pos.position.leverage,
          entryPrice: pos.position.level,
          takeProfit: pos.position.profitLevel,
          stopLoss: pos.position.stopLevel,
          currentPrice: pos.market.bid,
          trailingStop: pos.position.trailingStop,
        };

        // Pass indicators to trailing stop logic
        await tradingService.updateTrailingStopIfNeeded(positionData, indicators);
      }
    } catch (error) {
      console.error("[bot.js][Bot] Error in monitorOpenTrades:", error);
    }
  }

  isTradingAllowed() {
    const now = new Date();

    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    if (day === 0 || day === 6) {
      logger.info("[Bot] Trading blocked: Weekend.");
      return false;
    }

    // Get current time in minutes (Berlin time)
    const hour = Number(now.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "Europe/Berlin" }));
    const minute = Number(now.toLocaleString("en-US", { minute: "2-digit", timeZone: "Europe/Berlin" }));
    const currentMinutes = hour * 60 + minute;

    // Check if current time is inside any allowed window
    const allowed = this.allowedTradingWindows.some((win) => {
      if (win.start <= win.end) {
        return currentMinutes >= win.start && currentMinutes <= win.end;
      } else {
        // Overnight session (e.g. Sydney)
        return currentMinutes >= win.start || currentMinutes <= win.end;
      }
    });

    if (!allowed) {
      logger.info("[Bot] Trading blocked: Not in allowed session window (first/last 15 min excluded).");
      return false;
    }
    return true;
  }

  async closeAllPositions() {
    console.info("[Bot] Closing all positions before weekend...");
    try {
      const positions = await getOpenPositions();
      for (const pos of positions.positions) {
        await tradingService.closePosition(pos.dealId);
        console.info(`[Bot] Closed position: ${pos.market.epic}`);
      }
    } catch (error) {
      console.error("[Bot] Error closing all positions:", error);
    }
  }

  scheduleMidnightSessionRefresh() {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0); // Next 00:00
    const msUntilMidnight = nextMidnight - now;
    setTimeout(() => {
      this.refreshSessionAtMidnight();
      // After first run, repeat every 24h
      setInterval(() => this.refreshSessionAtMidnight(), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
    console.info(`[Bot] Scheduled session refresh at midnight in ${(msUntilMidnight / 1000 / 60).toFixed(2)} minutes.`);
  }

  async refreshSessionAtMidnight() {
    try {
      console.info("[Bot] Refreshing session at midnight...");
      await refreshSession();
      console.info("[Bot] Session refreshed at midnight.");
    } catch (error) {
      console.error("[bot.js][Bot] Midnight session refresh failed:", error);
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Create and start the bot
const bot = new TradingBot();
bot.initialize().catch((error) => {
  console.error("Bot initialization failed:", error);
  process.exit(1);
});
