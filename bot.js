import { calcIndicators, analyzeTrend } from "./indicators.js";
import { SYMBOLS, PROFIT_THRESHOLD, MAX_OPEN_TRADES } from "./config.js";
import { startSession, getHistorical, getAccountInfo, getOpenPositions, getSessionTokens } from "./api.js";
import logger from "./utils/logger.js";
import webSocketService from "./services/websocket.js";
import tradingService from "./services/trading.js";

// Main bot function
async function run() {
  try {
    // Start session and get account info
    await startSession();
    const accountData = await getAccountInfo();
    const accountBalance = accountData.accounts[0].balance;
    logger.info(`Initial account balance: ${JSON.stringify(accountBalance)}`);
    tradingService.setAccountBalance(accountBalance);

    // Get open positions
    const positions = await getOpenPositions();
    const openTrades = positions.positions.map((pos) => pos.market.epic.replace("_", "/"));
    logger.info(`Current open trades: ${JSON.stringify(openTrades)}`);
    tradingService.setOpenTrades(openTrades);

    // Test historical data function
    try {
      const m1Data = await getHistorical('EUR_USD', "m1", 100);
      logger.info(`Successfully fetched historical data for EUR_USD: ${m1Data.prices.length} candles`);
    } catch (error) {
      logger.error("Error testing historical data:", error.message);
    }

    // Get session tokens for WebSocket
    const tokens = getSessionTokens();

    // Connect to WebSocket for real-time price updates
    webSocketService.connect(tokens, SYMBOLS, async (data) => {
      try {
        logger.info("Raw WebSocket message received:");
        const rawMessage = data.toString();
        logger.info(rawMessage);

        const msg = JSON.parse(rawMessage);
        logger.info(`Parsed message: ${JSON.stringify(msg)}`);

        // Check if it's a price update message
        if (msg.epic) {
          const symbol = msg.epic.replace("_", "/");
          const bid = msg.bid;
          const ask = msg.offer;
          
          // Log price update
          logger.price(symbol, bid, ask);

          // Process price for trading decisions
          await tradingService.processPrice(symbol, bid, ask, getHistorical, MAX_OPEN_TRADES);
        }
      } catch (error) {
        logger.error("Error processing WebSocket message:", error.message);
      }
    });

    // Periodically update account info and check profit threshold
    setInterval(async () => {
      try {
        const accountData = await getAccountInfo();
        const currentBalance = accountData.accounts[0].balance;
        tradingService.setAccountBalance(currentBalance);

        // Check if profit threshold has been reached
        const initialBalance = parseFloat(process.env.INITIAL_BALANCE || currentBalance);
        const profitPercentage = (currentBalance - initialBalance) / initialBalance;

        if (profitPercentage >= PROFIT_THRESHOLD) {
          logger.info(`Profit threshold of ${PROFIT_THRESHOLD * 100}% reached! Increasing position size`);
          tradingService.setProfitThresholdReached(true);
        }
      } catch (error) {
        logger.error("Error updating account info:", error.message);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  } catch (error) {
    logger.error("Error in main bot execution:", error.message);
    throw error;
  }
}

run().catch((error) => logger.error("Unhandled error:", error));