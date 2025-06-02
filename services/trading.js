import { positionSize, generateSignals } from "../trading.js";
import { placeOrder, updateTrailingStop } from "../api.js";
import { TAKE_PROFIT_FACTOR, TRAILING_STOP_PIPS } from "../config.js";


class TradingService {
  constructor() {
    this.openTrades = [];
    this.accountBalance = 0;
    this.profitThresholdReached = false;
  }

  setAccountBalance(balance) {
    this.accountBalance = balance;
  }

  setOpenTrades(trades) {
    this.openTrades = trades;
  }

  setProfitThresholdReached(reached) {
    this.profitThresholdReached = reached;
  }

  isSymbolTraded(symbol) {
    return this.openTrades.includes(symbol);
  }

  async processPrice(symbol, bid, ask, getHistorical, maxOpenTrades) {
    try {
      // Skip if we already have max open trades or this symbol is already traded
      if (this.openTrades.length >= maxOpenTrades || this.isSymbolTraded(symbol)) {
        return;
      }

      // Analyze trend on higher timeframes
      const trendAnalysis = await analyzeTrend(symbol, getHistorical);

      // Only proceed if overall trend is clear (not mixed)
      if (trendAnalysis.overallTrend === "mixed") {
        console.log(`Skipping ${symbol} due to mixed trend on higher timeframes`);
        return;
      }

      // Get data for entry signals
      const m1Data = await getHistorical(symbol, "m1", 100);
      const m15Data = await getHistorical(symbol, "m15", 50);

      // Calculate indicators
      const m1Indicators = await calcIndicators(m1Data);
      const m15Indicators = await calcIndicators(m15Data);

      console.log(`${symbol} Indicators calculated`);

      // Generate trading signals
      const { signal } = generateSignals(symbol, m1Data, m1Indicators, m15Indicators, trendAnalysis, bid, ask);

      if (signal) {
        console.log(`${symbol} ${signal.toUpperCase()} signal generated!`);

        // Calculate stop loss and take profit levels
        const stopLossPips = 40; // Default 40 pips stop loss
        const takeProfitPips = stopLossPips * TAKE_PROFIT_FACTOR;

        // Calculate position size based on risk management
        const size = positionSize(this.accountBalance, bid, stopLossPips, this.profitThresholdReached);

        // Place the order
        const orderResult = await placeOrder(
          symbol,
          signal,
          signal === "buy" ? ask : bid,
          size,
          stopLossPips * 0.0001, // Convert pips to price
          takeProfitPips * 0.0001 // Convert pips to price
        );

        // Add to open trades
        this.openTrades.push(symbol);

        // Set up trailing stop once position is in profit
        setTimeout(async () => {
          try {
            // Get current position details
            const positions = await getOpenPositions();
            const position = positions.positions.find((p) => p.market.epic.replace("_", "/") === symbol);

            if (position && position.profit > 0) {
              // Calculate trailing stop level
              const trailingStopLevel =
                signal === "buy" ? position.level - TRAILING_STOP_PIPS * 0.0001 : position.level + TRAILING_STOP_PIPS * 0.0001;

              // Update trailing stop
              await updateTrailingStop(position.position.dealId, trailingStopLevel);
            }
          } catch (error) {
            console.error("Error setting trailing stop:", error.message);
          }
        }, 5 * 60 * 1000); // Check after 5 minutes
      }
    } catch (error) {
      console.error(`Error processing price for ${symbol}:`, error.message);
    }
  }
}

export default new TradingService();