import { positionSize, generateSignals } from "../trading.js";
import { placeOrder, updateTrailingStop, getHistorical } from "../api.js";
import { TAKE_PROFIT_FACTOR, TRAILING_STOP_PIPS } from "../config.js";

class TradingService {
  constructor() {
    this.openTrades = [];
    this.accountBalance = 0;
    this.profitThresholdReached = false;
    this.symbolMinSizes = {}; // Store min size per symbol
    this.virtualBalance = 10000;
    this.virtualPositions = [];
    this.orderAttempts = new Map(); // Track order attempts
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

  setSymbolMinSizes(minSizes) {
    this.symbolMinSizes = minSizes;
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
      
      // Log current state
      console.log(`\n=== Processing ${symbol} ===`);
      console.log(`Current open trades: ${this.openTrades.length}/${maxOpenTrades}`);
      console.log(`Account balance: ${this.accountBalance}€`);
      
      // Check trade limits
      if (this.openTrades.length >= maxOpenTrades) {
        console.log(`Maximum number of trades (${maxOpenTrades}) reached. Skipping analysis.`);
        return;
      }
      
      if (this.isSymbolTraded(symbol)) {
        console.log(`${symbol} already has an open position. Skipping analysis.`);
        return;
      }

      // Extract bid/ask with proper fallbacks
      const bid = candle.bid || candle.closePrice?.bid || candle.c || candle.close;
      const ask = candle.ask || candle.closePrice?.ask || candle.c || candle.close;
      
      if (!this.validatePrices(bid, ask, symbol)) {
        return;
      }

      // Get indicators and generate signal
      const { signal, metrics } = await this.generateAndValidateSignal(candle, message, symbol, bid, ask);
      
      if (signal) {
        await this.executeTrade(signal, symbol, bid, ask, metrics);
      }
    } catch (error) {
      console.error(`Error processing ${symbol}:`, error.message);
    }
  }

  validatePrices(bid, ask, symbol) {
    if (typeof bid !== "number" || typeof ask !== "number" || isNaN(bid) || isNaN(ask)) {
      console.error(`Invalid prices for ${symbol}. Bid: ${bid}, Ask: ${ask}`);
      return false;
    }
    return true;
  }

  async generateAndValidateSignal(candle, message, symbol, bid, ask) {
    const indicators = candle.indicators || {};
    const trendAnalysis = message.payload.trendAnalysis;
      
    if (!indicators.m1 || !indicators.m5 || !indicators.m15) {
      console.log(`Missing indicators for ${symbol}`);
      return { signal: null };
    }

    return generateSignals(
      symbol,
      message.m1Data,
      indicators.m1,
      indicators.m15,
      trendAnalysis,
      bid,
      ask
    );
  }

  async executeTrade(signal, symbol, bid, ask, metrics) {
    console.log(`\n🎯 ${symbol} ${signal.toUpperCase()} signal generated!`);

    // Calculate position parameters
    const stopLossPips = 40; // Base stop loss
    const takeProfitPips = stopLossPips * 2; // 2x stop loss as per requirements
    const entryPrice = signal === "buy" ? ask : bid;
    const stopLoss = signal === "buy"
      ? entryPrice - stopLossPips * 0.0001
      : entryPrice + stopLossPips * 0.0001;
    const takeProfit = signal === "buy"
      ? entryPrice + takeProfitPips * 0.0001
      : entryPrice - takeProfitPips * 0.0001;

    // Get min size and calculate position size
    const minSize = Math.max(0.1, this.symbolMinSizes[symbol] || 0.1);
    const size = Math.max(minSize, positionSize(
      this.accountBalance,
      entryPrice,
      stopLossPips,
      this.profitThresholdReached
    ));

    console.log('\n=== Trade Parameters ===');
    console.log(`Entry Price: ${entryPrice}`);
    console.log(`Stop Loss: ${stopLoss} (${stopLossPips} pips)`);
    console.log(`Take Profit: ${takeProfit} (${takeProfitPips} pips)`);
    console.log(`Position Size: ${size} lots`);

    // Place the order
    try {
      console.log(`Placing ${signal} order for ${symbol} at ${entryPrice}, size: ${size}`);
      console.log(`Stop Loss: ${stopLoss}, Take Profit: ${takeProfit}`);

      const orderResult = await placeOrder(
        symbol,
        signal,
        entryPrice,
        size,
        stopLoss,
        takeProfit
      );

      if (orderResult && orderResult.dealId) {
        this.openTrades.push(symbol);
        console.log(`✅ Order placed successfully for ${symbol}, Deal ID: ${orderResult.dealId}`);

        // Set up trailing stop after 5 minutes if position is profitable
        this.setupTrailingStop(symbol, signal, entryPrice, takeProfitPips);
      } else {
        console.error(`Failed to place order for ${symbol}: Invalid order result`);
      }
    } catch (error) {
      console.error(`❌ Error placing order for ${symbol}:`, error.message);
      
      // Handle specific error cases
      if (error.message.includes('invalid.size')) {
        console.log(`Retrying with minimum size for ${symbol}...`);
        try {
          const orderResult = await placeOrder(
            symbol,
            signal,
            entryPrice,
            0.1, // Use minimum size
            stopLoss,
            takeProfit
          );
          if (orderResult && orderResult.dealId) {
            this.openTrades.push(symbol);
            console.log(`✅ Order placed successfully with minimum size for ${symbol}`);
          }
        } catch (retryError) {
          console.error(`Failed retry for ${symbol}:`, retryError.message);
        }
      }
    }
  }

  async setupTrailingStop(symbol, signal, entryPrice, takeProfitPips) {
    setTimeout(async () => {
      try {
        const positions = await getOpenPositions();
        const position = positions.positions.find(p => p.market.epic === symbol);

        if (position && position.profit > 0) {
          const profitPips = Math.abs(position.level - entryPrice) / 0.0001;
          
          if (profitPips >= takeProfitPips * 0.5) {
            const trailingStopLevel = signal === "buy"
              ? position.level - 10 * 0.0001
              : position.level + 10 * 0.0001;
              
            await updateTrailingStop(position.position.dealId, trailingStopLevel);
            console.log(`🎯 Trailing stop set for ${symbol} at ${trailingStopLevel}`);
          }
        }
      } catch (error) {
        console.error("Error setting trailing stop:", error.message);
      }
    }, 5 * 60 * 1000);
  }

  simulateOrder({ symbol, price, indicators, trendAnalysis, balance }) {
    if (BACKTEST_MODE) {
      const signals = this.generateSignals(indicators, trendAnalysis);
      
      if (signals.strength > 0.7) {
        const size = this.positionSize(balance, price, signals.stopLoss);
        this.virtualPositions.push({
          symbol,
          entry: price,
          size,
          stopLoss: price - signals.stopLoss,
          takeProfit: price + signals.takeProfit
        });
      }
    }
  }

  getVirtualBalance() {
    return this.virtualBalance;
  }
}

export default new TradingService();
