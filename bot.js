import { API, TRADING, MODE } from "./config.js";

const { SYMBOLS, TIMEFRAMES, MAX_POSITIONS } = TRADING;
const { BACKTEST_MODE } = MODE;
import { calcIndicators, analyzeTrend } from "./indicators.js";
import {
  startSession,
  refreshSession,
  pingSession,
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
    this.pingInterval = 9 * 60 * 1000;
  }

  // Initialize the bot and start necessary services
  async initialize() {
    try {
      await startSession();
      const tokens = getSessionTokens();
      // await getMarkets();

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
          this.latestCandles[message.payload.epic] = message.payload;
        }
      } catch (error) {
        console.error("WebSocket message processing error:", error.message);
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
    this.analysisInterval = setInterval(async () => {
      try {
        await this.updateAccountInfo();
        await this.analyzeAllSymbols();
      } catch (error) {
        console.error("Analysis interval error:", error);
      }
    }, 15 * 60 * 1000);
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
    const timeframes = ["HOUR_4", "HOUR", "MINUTE_15"];

    const results = [];
    for (let i = 0; i < timeframes.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, delays[i - 1]));
      const data = await getHistorical(symbol, timeframes[i], 50);
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
    if (!this.latestCandles[symbol]) {
      return;
    }

    console.log(`Analyzing ${symbol}...`);

    // Fetch and calculate all required data
    const { h4Data, h1Data, m15Data } = await this.fetchHistoricalData(symbol);

    const indicators = {
      h4: await calcIndicators(h4Data.prices),  // Trend direction
      h1: await calcIndicators(h1Data.prices),  // Setup confirmation
      m15: await calcIndicators(m15Data.prices), // Entry/Exit timing
    };

    // We don't need separate trend analysis anymore as it's part of the H4 indicators
    const trendAnalysis = {
      h4Trend: indicators.h4.isBullishTrend ? "bullish" : "bearish",
      h4Indicators: indicators.h4
    };

    // Process trading decision
    await tradingService.processPrice(
      {
        payload: {
          ...this.latestCandles[symbol],
          indicators,
          trendAnalysis,
        },
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
