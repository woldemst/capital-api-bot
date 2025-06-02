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
  getMarkets
} from "./api.js";

import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";
import axios from "axios";

// Main bot function
async function run() {
  try {
    // Start session and get account info
    await startSession();
    setInterval(async () => {
      try {
        await refreshSession();
        console.log("Session refreshed successfully");
      } catch (e) {
        console.error(`Error refreshing session: ${e.message}`);
      }
    }, 9 * 60 * 1000); // Refresh every 9 minutes

    
    // !!! NOT DELETE
    // Get account info
    // const accountData = await getAccountInfo();
    // const accountBalance = accountData.accounts[0].balance;

    // !!! NOT DELETE
    // Get open positions
    // await getOpenPositions();

    // !!! NOT DELETE
    // Get session details
    // await getSeesionDetails();

    const tokens = getSessionTokens();
    // await getActivityHistory('2025-05-24T15:09:47', '2025-05-26T15:10:05');

    // Test historical data  function
    // try {
      // Change this line
      // const m1Data = await getHistorical("USDCAD", "m1", 50, "2025-05-25T15:09:47", "2025-05-26T15:10:05");
      // await getMarkets();
    //   console.log(`Successfully fetched historical data for EUR_USD: ${m1Data.prices.length} candles`);
    // } catch (error) {
    //   console.error("Error testing historical data:", error.message);
    // }

    // Connect to WebSocket for real-time price updates
    // webSocketService.connect(tokens, SYMBOLS, async (data) => {
    //   try {
    //     logger.info("Raw WebSocket message received:");
    //     const rawMessage = data.toString();
    //     logger.info(rawMessage);

    //     const msg = JSON.parse(rawMessage);
    //     logger.info(`Parsed message: ${JSON.stringify(msg)}`);

    //     // Check if it's a price update message
    //     if (msg.epic) {
    //       const symbol = msg.epic.replace("_", "/");
    //       const bid = msg.bid;
    //       const ask = msg.offer;

    //       // Log price update
    //       logger.price(symbol, bid, ask);

    //       // Process price for trading decisions
    //       await tradingService.processPrice(symbol, bid, ask, getHistorical, MAX_OPEN_TRADES);
    //     }
    //   } catch (error) {
    //     logger.error("Error processing WebSocket message:", error.message);
    //   }
    // });

    // Periodically update account info and check profit threshold
    // setInterval(async () => {
    //   try {
    //     const accountData = await getAccountInfo();
    //     const currentBalance = accountData.accounts[0].balance;
    //     tradingService.setAccountBalance(currentBalance);

    //     // Check if profit threshold has been reached
    //     const initialBalance = parseFloat(process.env.INITIAL_BALANCE || currentBalance);
    //     const profitPercentage = (currentBalance - initialBalance) / initialBalance;

    //     if (profitPercentage >= PROFIT_THRESHOLD) {
    //       logger.info(`Profit threshold of ${PROFIT_THRESHOLD * 100}% reached! Increasing position size`);
    //       tradingService.setProfitThresholdReached(true);
    //     }
    //   } catch (error) {
    //     logger.error("Error updating account info:", error.message);
    //   }
    // }, 5 * 60 * 1000); // Every 5 minutes
  } catch (error) {
    console.error("Error in main bot execution:", error.message);
    throw error;
  }
}

run().catch((error) => console.error("Unhandled error:", error));
