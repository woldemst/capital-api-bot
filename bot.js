import { calcIndicators, analyzeTrend } from "./indicators.js";
import { API_KEY, API_PATH, BASE_URL, SYMBOLS, TIMEFRAMES, PROFIT_THRESHOLD, MAX_OPEN_TRADES, BACKTEST_MODE } from "./config.js";
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

// Main bot function
async function run() {
  try {
    await startSession();

    // Session refresh interval
    setInterval(async () => {
      try {
        await refreshSession();
        console.log("Session refreshed successfully");
      } catch (e) {
        console.error(`Error refreshing session: ${e.message}`);
      }
    }, 9 * 60 * 1000);

    // Get account info and set balance
    // const accountData = await getAccountInfo();
    // if (accountData && accountData.accounts && accountData.accounts[0]) {
    //   tradingService.setAccountBalance(accountData.accounts[0].balance);
    //   console.log(`Account balance set to: ${accountData.accounts[0].balance}€`);
    // } else {
    //   console.error("Could not get account balance");
    //   return;
    // }

    // Get current open positions
    // const positions = await getOpenPositions();
    // if (positions && positions.positions) {
    //   tradingService.setOpenTrades(positions.positions.map(p => p.market.epic));
    //   console.log(`Current open positions: ${positions.positions.length}`);
    // }

    const tokens = getSessionTokens();
    
    // Store the latest candles for each symbol
    const latestCandles = {};

    if (!BACKTEST_MODE) {
      webSocketService.connect(tokens, SYMBOLS, async (data) => {
        try {
          const message = JSON.parse(data.toString());

          // Store only candle data
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

            console.log(`Fetching candles for ${symbol}`);

            // Get historical data for different timeframes
            await new Promise((resolve) => setTimeout(resolve, 1000)); // delay between requests
            const m1Data = await getHistorical(symbol, "MINUTE", 50);
            await new Promise((resolve) => setTimeout(resolve, 1000)); // delay between requests
            const m5Data = await getHistorical(symbol, "MINUTE_5", 50);
            await new Promise((resolve) => setTimeout(resolve, 1000)); // delay between requests
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
                  },
                  trendAnalysis,
                },
                m1Data: m1Data.prices,
              },
              MAX_OPEN_TRADES
            );
          } catch (error) {
            console.error(`Error analyzing ${symbol}:`, error.message);
          }
        }
      }, 30000); // Run analysis every 30 seconds
    } else {
      try {
        const m1Data = await getHistorical("USDCAD", "MINUTE", 50);

        console.log(`Successfully fetched historical data for USDCAD: ${m1Data.prices.length} candles`);

        // debug function for searching for market currencies
        // await getMarkets();

        // console.log(`Successfully fetched historical data for EUR_USD: ${m1Data.prices.length} candles`);
      } catch (error) {
        console.error("Error testing historical data:", error.message);
      }
    }
    // Connect to WebSocket and handle messages
  } catch (error) {
    console.error("Error in main bot function:", error);
  }
}

run().catch((error) => console.error("Unhandled error:", error));
