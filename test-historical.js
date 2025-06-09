import { startSession, getHistorical, getSessionTokens } from "./api.js";
import { SYMBOLS, TIMEFRAMES } from "./config.js";

export const testHistorical = async () => {
  try {
    // Start session to get authentication tokens
    await startSession();

    // Test different symbols and timeframes
    const devSymbols = ["EUR_USD", "GBP_USD", "USD_JPY"];

    for (const symbol of SYMBOLS) {
      for (const timeframe of TIMEFRAMES) {
        try {
          console.log(`Testing ${symbol} on ${timeframe} timeframe...`);
          const data = await getHistorical(symbol, timeframe, 10);
          console.log(`Success! Received ${data.prices?.length || 0} candles`);
          console.log("Sample data:", data.prices?.[0] || "No data");
        } catch (error) {
          console.error(`Failed for ${symbol} on ${timeframe}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error("Test failed:", error.message);
  }
};
