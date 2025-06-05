import { positionSize, generateSignals } from "../trading.js";
import { placeOrder, updateTrailingStop, getHistorical } from "../api.js";
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

  async processPrice(message, maxOpenTrades) {
    let symbol = null;
    try {
      if (!message || !message.payload) {
        console.log("Invalid message format:", message);
        return;
      }

      const candle = message.payload;
      symbol = candle.epic;
      if (!symbol) {
        console.log("No symbol (epic) in message:", message);
        return;
      }
      if (this.openTrades.length >= maxOpenTrades || this.isSymbolTraded(symbol)) {
        return;
      }
      if (!message || !message.payload || !message.payload.epic) {
        console.error("No correct message format");
        return;
      }

      // Extract bid/ask from candle (try multiple formats)
      const bid = candle.bid || candle.closePrice?.bid || candle.c || candle.close;
      const ask = candle.ask || candle.closePrice?.ask || candle.c || candle.close;
      if (typeof bid !== "number" || typeof ask !== "number") {
        console.error(`Bid/Ask not found for ${symbol}:`, candle);
        return;
      }

      // Extract and validate OHLC data
      const ohlcData = {
        timestamp: candle.t,
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
        volume: candle.lastTradedVolume,
      };

      console.log(`Processing ${symbol} OHLC data:`, ohlcData);

      // Use trendAnalysis from message (fix for undefined error)
      const trendAnalysis = message.trendAnalysis || { overallTrend: 'unknown' };
      if (!trendAnalysis || typeof trendAnalysis.overallTrend !== 'string') {
        console.error(`trendAnalysis missing or invalid for ${symbol}:`, trendAnalysis);
        return;
      }
      if (trendAnalysis.overallTrend === "mixed") {
        console.log(`Skipping ${symbol} due to mixed trend on higher timeframes`);
        return;
      }

      console.log(`${symbol} Indicators calculated`);

      // Defensive: ensure indicators are present
      const indicators = candle.indicators || {};
      if (!indicators.m1 || !indicators.m5 || !indicators.m15) {
        console.error(`Indicators missing for ${symbol}:`, indicators);
        return;
      }

      // Generate trading signals
      const { signal } = generateSignals(
        symbol,
        indicators.m1,
        indicators.m5,
        indicators.m15,
        trendAnalysis,
        bid,
        ask
      );

      if (signal) {
        console.log(`${symbol} ${signal.toUpperCase()} signal generated!`);

        // Calculate stop loss and take profit as price levels
        const stopLossPips = 40;
        const takeProfitPips = stopLossPips * TAKE_PROFIT_FACTOR;
        const entryPrice = signal === "buy" ? ask : bid;
        const stopLoss = signal === "buy"
          ? entryPrice - stopLossPips * 0.0001
          : entryPrice + stopLossPips * 0.0001;
        const takeProfit = signal === "buy"
          ? entryPrice + takeProfitPips * 0.0001
          : entryPrice - takeProfitPips * 0.0001;

        // Calculate position size
        const size = positionSize(this.accountBalance, entryPrice, stopLossPips, this.profitThresholdReached);

        // Place the order
        const orderResult = await placeOrder(
          symbol,
          signal,
          entryPrice,
          size,
          stopLoss,
          takeProfit
        );

        this.openTrades.push(symbol);

        // Set up trailing stop once position is in profit
        setTimeout(async () => {
          try {
            const positions = await getOpenPositions();
            const position = positions.positions.find((p) => p.market.epic.replace("_", "/") === symbol);

            if (position && position.profit > 0) {
              const trailingStopLevel =
                signal === "buy"
                  ? position.level - TRAILING_STOP_PIPS * 0.0001
                  : position.level + TRAILING_STOP_PIPS * 0.0001;
              await updateTrailingStop(position.position.dealId, trailingStopLevel);
            }
          } catch (error) {
            console.error("Error setting trailing stop:", error.message);
          }
        }, 5 * 60 * 1000);
      }
    } catch (error) {
      console.error(`Error processing price for ${symbol || "unknown symbol"}:`, error.message);
    }
  }
}

export default new TradingService();
