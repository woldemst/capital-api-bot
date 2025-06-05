import { calcIndicators, analyzeTrend } from "./indicators.js";
import { API_KEY, API_PATH, BASE_URL, SYMBOLS, PROFIT_THRESHOLD, MAX_OPEN_TRADES } from "./config.js";
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
import axios from "axios";

// Main bot function
async function run() {
  try {
    await startSession();

    // Fetch and set account balance
    const accountInfo = await getAccountInfo();
    if (accountInfo && accountInfo.accountInfo && typeof accountInfo.accountInfo.balance === 'number') {
      tradingService.setAccountBalance(accountInfo.accountInfo.balance);
    }

    // Session refresh interval
    setInterval(async () => {
      try {
        await refreshSession();
        console.log("Session refreshed successfully");
      } catch (e) {
        console.error(`Error refreshing session: ${e.message}`);
      }
    }, 9 * 60 * 1000);

    const tokens = getSessionTokens();

    // Store the latest candles for each symbol
    const latestCandles = {};

    // Connect to WebSocket and handle messages
    webSocketService.connect(tokens, SYMBOLS, async (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.payload && message.payload.epic) {
          const symbol = message.payload.epic;
          latestCandles[symbol] = message.payload;
        }
      } catch (error) {
        console.error("Error processing WebSocket message:", error.message);
      }
    });

    // Analysis interval (every 60 seconds)
    setInterval(async () => {
      for (const symbol of SYMBOLS) {
        try {
          if (!latestCandles[symbol]) continue;

          // Throttle requests to avoid 429 errors
          await new Promise(res => setTimeout(res, 500));

          // Get historical data for different timeframes
          const m1Data = await getHistorical(symbol, "MINUTE", 50);
          const m5Data = await getHistorical(symbol, "MINUTE_5", 50);
          const m15Data = await getHistorical(symbol, "MINUTE_15", 50);

          const m1Indicators = await calcIndicators(m1Data.prices);
          const m5Indicators = await calcIndicators(m5Data.prices);
          const m15Indicators = await calcIndicators(m15Data.prices);

          // Analyze trend
          const trendAnalysis = await analyzeTrend(symbol, getHistorical);

          // Process for trading decisions
          await tradingService.processPrice(
            {
              payload: {
                ...latestCandles[symbol],
                indicators: {
                  m1: m1Indicators,
                  m5: m5Indicators,
                  m15: m15Indicators,
                }
              },
              trendAnalysis
            },
            MAX_OPEN_TRADES
          );
        } catch (error) {
          console.error(`Error analyzing ${symbol}:`, error.message);
        }
      }
    }, 60000); // Run analysis every 60 seconds
    // }, 30000); // Run analysis every 60 seconds
  } catch (error) {
    console.error("Error in main bot function:", error);
  }
}

run().catch((error) => console.error("Unhandled error:", error));
