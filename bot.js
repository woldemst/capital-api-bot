import { API_KEY, API_PATH, BASE_URL, SYMBOLS, TIMEFRAMES, PROFIT_THRESHOLD, MAX_OPEN_TRADES, BACKTEST_MODE } from "./config.js";
import { calcIndicators, analyzeTrend } from "./indicators.js";
import {
  startSession,
  refreshSession,
  getHistorical,
  getAccountInfo,
  getOpenPositions,
  getSessionTokens,
  getSeesionDetails,
  getActivityHistory,
  getMarkets,
} from "./api.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";

class TradingBot {
  constructor() {
    this.latestCandles = {};
    this.isRunning = false;
    this.analysisInterval = null;
    this.sessionRefreshInterval = null;
  }

  // Initialize the bot and start necessary services
  async initialize() {
    try {
      await startSession();
      const tokens = getSessionTokens();

      if (!BACKTEST_MODE) {
        await this.startLiveTrading(tokens);
      } else {
        await this.runBacktest();
      }
    } catch (error) {
      console.error("Failed to initialize bot:", error);
      throw error;
    }
  }

  // Start live trading mode
  async startLiveTrading(tokens) {
    this.setupWebSocket(tokens);
    this.startSessionRefresh();
    this.startAnalysisInterval();
    this.isRunning = true;
  }

  // Set up WebSocket connection for real-time data
  setupWebSocket(tokens) {
    webSocketService.connect(tokens, SYMBOLS, (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.payload?.epic) {
          this.latestCandles[message.payload.epic] = message.payload;
        }
      } catch (error) {
        console.error("WebSocket message processing error:", error.message);
      }
    });
  }

  // Start session refresh interval
  startSessionRefresh() {
    this.sessionRefreshInterval = setInterval(async () => {
      try {
        await refreshSession();
        console.log("Session refreshed successfully");
      } catch (error) {
        console.error("Session refresh failed:", error.message);
      }
    }, 9 * 60 * 1000);
  }

  // Start analysis interval
  startAnalysisInterval() {
    this.analysisInterval = setInterval(async () => {
      try {
        await this.updateAccountInfo();
        await this.analyzeAllSymbols();
      } catch (error) {
        console.error("Analysis interval error:", error);
      }
    }, 30000);
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
    const delays = [1000, 1000, 1000]; // Delays between requests
    const timeframes = ["MINUTE", "MINUTE_5", "MINUTE_15"];

    const results = [];
    for (let i = 0; i < timeframes.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, delays[i - 1]));
      const data = await getHistorical(symbol, timeframes[i], 50);
      results.push(data);
    }

    return {
      m1Data: results[0],
      m5Data: results[1],
      m15Data: results[2],
    };
  }

  // Analyze a single symbol
  async analyzeSymbol(symbol) {
    if (!this.latestCandles[symbol]) {
      return;
    }

    console.log(`Analyzing ${symbol}...`);

    // Fetch and calculate all required data
    const { m1Data, m5Data, m15Data } = await this.fetchHistoricalData(symbol);

    const indicators = {
      m1: await calcIndicators(m1Data.prices),
      m5: await calcIndicators(m5Data.prices),
      m15: await calcIndicators(m15Data.prices),
    };

    const trendAnalysis = await analyzeTrend(symbol, getHistorical);

    // Process trading decision
    await tradingService.processPrice(
      {
        payload: {
          ...this.latestCandles[symbol],
          indicators,
          trendAnalysis,
        },
        m1Data: m1Data.prices,
      },
      MAX_OPEN_TRADES
    );
  }

  // Analyze all symbols
  async analyzeAllSymbols() {
    for (const symbol of SYMBOLS) {
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
}

// Create and start the bot
const bot = new TradingBot();
bot.initialize().catch((error) => {
  console.error("Bot initialization failed:", error);
  process.exit(1);
});
