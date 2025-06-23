import { startSession, pingSession, getHistorical, getAccountInfo, getOpenPositions, getSessionTokens } from "./api.js";
import { TRADING, MODE, DEV, ANALYSIS } from "./config.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import { calcIndicators } from "./indicators.js";

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
  }

  // Initialize the bot and start necessary services
  async initialize() {
    let retryCount = 0;

    // Fetch and store minDealSize and dealSizeIncrement for all symbols
    await this.fetchAndStoreSymbolMinSizes();

    while (retryCount < this.maxRetries) {
      try {
        await startSession();
        const tokens = getSessionTokens();

        if (!tokens.cst || !tokens.xsecurity) {
          console.warn(`[Bot] Invalid session tokens, attempt ${retryCount + 1}/${this.maxRetries}`);
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
        console.error(`[Bot] Initialization attempt ${retryCount} failed:`, error);

        if (retryCount < this.maxRetries) {
          console.log(`[Bot] Refreshing session and retrying in ${this.retryDelay / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
          await refreshSession();
        } else {
          console.error("[Bot] Max retry attempts reached. Shutting down.");
          throw error;
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
    const interval = MODE.DEV_MODE ? DEV.ANALYSIS_INTERVAL_MS : 15 * 60 * 1000;
    if (MODE.DEV_MODE) {
      console.log(`[DEV] Starting analysis interval: ${interval}s`);
    } else {
      console.log(`[PROD] Starting analysis interval: ${interval}s`);
    }
    this.analysisInterval = setInterval(async () => {
      try {
        const now = new Date();
        const date = now.toLocaleDateString();
        const time = now.toLocaleTimeString();
        console.log(`[${date} ${time}] Running scheduled analysis...`);
        await this.updateAccountInfo();
        await this.analyzeAllSymbols();
      } catch (error) {
        console.error("Analysis interval error:", error);
      }
    }, interval);
  }

  // Update account information and positions
  async updateAccountInfo() {
    try {
      const accountData = await getAccountInfo();
      if (accountData?.accounts?.[0]?.balance?.balance) {
        tradingService.setAccountBalance(accountData.accounts[0].balance.balance);
      } else {
        throw new Error("Invalid account data structure");
      }

      const positions = await getOpenPositions();
      if (positions?.positions) {
        tradingService.setOpenTrades(positions.positions.map((p) => p.market.epic));
        console.log(`Current open positions: ${positions.positions.length}`);
      }
    } catch (error) {
      console.error("Failed to update account info:", error);
      throw error;
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

    // We don't need separate trend analysis anymore as it's part of the H4 indicators
    const trendAnalysis = {
      h4Trend: indicators.h4.isBullishTrend ? "bullish" : "bearish",
      h4Indicators: indicators.h4,
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
        trendAnalysis,
        h4Data: h4Data.prices,
        h1Data: h1Data.prices,
        m15Data: m15Data.prices,
      },
      MAX_POSITIONS
    );
  }

  // Analyze all symbols
  async analyzeAllSymbols() {
    for (const symbol of SYMBOLS) {
      if (!this.latestCandles[symbol]) continue; // Only analyze if we have a candle
      try {
        await this.analyzeSymbol(symbol);
      } catch (error) {
        console.error(`Error analyzing ${symbol}:`, error.message);
      }
    }
  }

  // Run backtest mode
  async runBacktest() {
    try {
      const m1Data = await getHistorical("USDCAD", "MINUTE", 50);
      console.log(`Backtest data fetched for USDCAD: ${m1Data.prices.length} candles`);
    } catch (error) {
      console.error("Backtest error:", error.message);
    }
  }

  // Clean shutdown
  async shutdown() {
    this.isRunning = false;
    clearInterval(this.analysisInterval);
    clearInterval(this.sessionRefreshInterval);
    webSocketService.disconnect();
  }

  // Fetch and store minDealSize and dealSizeIncrement for all symbols
  async fetchAndStoreSymbolMinSizes() {
    const minSizes = {};
    for (const symbol of SYMBOLS) {
      try {
        const details = await import("./api.js").then(api => api.getMarketDetails(symbol));
        const minDealSize = details.instrument?.minDealSize || 1;
        const dealSizeIncrement = details.instrument?.dealSizeIncrement || 1;
        minSizes[symbol] = { minDealSize, dealSizeIncrement };
        console.log(`[SymbolConfig] ${symbol}: minDealSize=${minDealSize}, dealSizeIncrement=${dealSizeIncrement}`);
      } catch (e) {
        console.warn(`[SymbolConfig] Could not fetch min size for ${symbol}:`, e.message);
        minSizes[symbol] = { minDealSize: 1, dealSizeIncrement: 1 };
      }
    }
    tradingService.setSymbolMinSizes(minSizes);
  }
}

// Create and start the bot
const bot = new TradingBot();
bot.initialize().catch((error) => {
  console.error("Bot initialization failed:", error);
  process.exit(1);
});
