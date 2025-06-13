import { RISK_PER_TRADE, LEVERAGE, POSITION_SIZE_INCREASE, TAKE_PROFIT_FACTOR, TRAILING_STOP_PIPS } from "../config.js";
import { placeOrder, placePosition, updateTrailingStop, getHistorical } from "../api.js";

// Calculate position size based on risk management
function positionSize(balance, price, stopLossPips, profitThresholdReached, symbol) {
  const isForex = symbol && symbol.length === 6 && /^[A-Z]*$/.test(symbol);
  
  if (isForex) {
    // For forex pairs, always return 100 as per API requirement
    return 100;
  }

  // For other instruments (indices, commodities)
  if (!balance || balance <= 0) {
    console.log("Warning: Invalid balance, using minimum position size");
    return 1;
  }

  const amount = balance * RISK_PER_TRADE;
  const pipValue = 0.01; // For non-forex instruments
  const slPips = stopLossPips || 40;

  // Calculate size for other instruments
  let size = amount / (slPips * price * 0.01);
  size = Math.max(1, Math.round(size));
  size = Math.min(100, size); // Cap at 100 units

  console.log(`Position Size Calculation:
    Symbol: ${symbol}
    Instrument Type: ${isForex ? 'Forex' : 'Other'}
    Balance: ${balance}
    Risk Amount: ${amount}
    Stop Loss Pips: ${slPips}
    Price: ${price}
    Calculated Size: ${size} units
  `);

  return size;
}

// Generate trading signals based on indicators
function generateSignals(symbol, m1Data, m1Indicators, m15Indicators, trendAnalysis, bid, ask) {
  // Validate inputs
  if (!m1Data || !m1Indicators || !m15Indicators || !trendAnalysis) {
    console.log(`${symbol}: Missing required indicators data`);
    return { signal: null };
  }

  console.log(`\n=== Analyzing ${symbol} ===`);
  console.log("Current price:", { bid, ask });
  console.log("M1 RSI:", m1Indicators.rsi);
  console.log("M15 RSI:", m15Indicators.rsi);
  console.log("Trend Analysis:", trendAnalysis.overallTrend);

  // Buy signal conditions with enhanced MA cross check
  const buyConditions = [
    // MA crossover (5 MA crosses above 20 MA) with recent price confirmation
    m1Indicators.maFast > m1Indicators.maSlow &&
      m1Data[m1Data.length - 2].close < m1Indicators.maSlow &&
      m1Data[m1Data.length - 1].close > m1Data[m1Data.length - 2].close,

    // RSI below 30 (oversold)
    m1Indicators.rsi < 30,

    // Price at lower Bollinger Band
    bid <= m1Indicators.bb.lower,

    // Higher timeframe trend confirmation
    trendAnalysis.overallTrend === "bullish",

    // M15 confirmation - trending momentum
    m15Indicators.rsi > 50 && m15Indicators.macd.histogram > 0,
  ];

  // Sell signal conditions with enhanced checks
  const sellConditions = [
    // MA crossover (5 MA crosses below 20 MA) with recent price confirmation
    m1Indicators.maFast < m1Indicators.maSlow &&
      m1Data[m1Data.length - 2].close > m1Indicators.maSlow &&
      m1Data[m1Data.length - 1].close < m1Data[m1Data.length - 2].close,

    // RSI above 70 (overbought)
    m1Indicators.rsi > 70,

    // Price at upper Bollinger Band
    ask >= m1Indicators.bb.upper,

    // Higher timeframe trend confirmation
    trendAnalysis.overallTrend === "bearish",

    // M15 confirmation - trending momentum
    m15Indicators.rsi < 50 && m15Indicators.macd.histogram < 0,
  ];

  // Enhanced logging for debugging
  console.log("\nBuy Conditions:");
  buyConditions.forEach((condition, i) => {
    console.log(
      `  ${i + 1}. ${condition ? "✅" : "❌"} ${
        i === 0 ? "MA Crossover" : i === 1 ? "RSI Oversold" : i === 2 ? "BB Lower Touch" : i === 3 ? "Trend Bullish" : "M15 Confirmation"
      }`
    );
  });

  console.log("\nSell Conditions:");
  sellConditions.forEach((condition, i) => {
    console.log(
      `  ${i + 1}. ${condition ? "✅" : "❌"} ${
        i === 0 ? "MA Crossover" : i === 1 ? "RSI Overbought" : i === 2 ? "BB Upper Touch" : i === 3 ? "Trend Bearish" : "M15 Confirmation"
      }`
    );
  });

  // Calculate signal scores - require more conditions for stronger signals
  const buyScore = buyConditions.filter(Boolean).length;
  const sellScore = sellConditions.filter(Boolean).length;

  // Generate signal only if we have strong confirmation (3 out of 5 conditions)
  let signal = null;
  if (buyScore >= 3) signal = "buy";
  if (sellScore >= 3) signal = "sell";

  // Log final decision
  console.log("\nSignal Analysis:");
  console.log(`Buy Score: ${buyScore}/5`);
  console.log(`Sell Score: ${sellScore}/5`);
  console.log(`Final Signal: ${signal || "NONE"}\n`);

  return {
    signal,
    buyScore,
    sellScore,
    metrics: {
      rsi: m1Indicators.rsi,
      maFast: m1Indicators.maFast,
      maSlow: m1Indicators.maSlow,
      bbUpper: m1Indicators.bb.upper,
      bbLower: m1Indicators.bb.lower,
      macdHistogram: m1Indicators.macd?.histogram,
    },
  };
}

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

    return generateSignals(symbol, message.m1Data, indicators.m1, indicators.m15, trendAnalysis, bid, ask);
  }

  async executeTrade(signal, symbol, bid, ask, metrics) {
    console.log(`\n🎯 ${symbol} ${signal.toUpperCase()} signal generated!`);

    // Calculate position parameters
    const stopLossPips = 40; // Base stop loss
    const takeProfitPips = stopLossPips * TAKE_PROFIT_FACTOR; // Default 2x stop loss
    const pipValue = symbol.includes("JPY") ? 0.01 : 0.0001;
    
    // Calculate entry, stop loss and take profit prices
    const entryPrice = signal === "buy" ? ask : bid;
    const stopLossPrice = signal === "buy" 
      ? (entryPrice - stopLossPips * pipValue).toFixed(5)
      : (entryPrice + stopLossPips * pipValue).toFixed(5);
    const takeProfitPrice = signal === "buy"
      ? (entryPrice + takeProfitPips * pipValue).toFixed(5)
      : (entryPrice - takeProfitPips * pipValue).toFixed(5);

    // Calculate position size based on risk
    const size = positionSize(this.accountBalance, entryPrice, stopLossPips, this.profitThresholdReached, symbol);

    console.log("\n=== Position Parameters ===");
    console.log(`Entry: Market ${signal.toUpperCase()} at ~${entryPrice}`);
    console.log(`Stop Loss: ${stopLossPrice} (${stopLossPips} pips)`);
    console.log(`Take Profit: ${takeProfitPrice} (${takeProfitPips} pips)`);
    console.log(`Position Size: ${size} lots`);
    console.log(`Risk per trade: $${(this.accountBalance * RISK_PER_TRADE).toFixed(2)}`);

    // Place the position with market execution
    try {
      console.log(`Creating ${signal} position for ${symbol} at market price...`);
      
      // Add to open trades list before placing the order
      this.setOpenTrades([...this.openTrades, symbol]);

      const positionResult = await placePosition(
        symbol,
        signal,
        size,
        null, // Market order, no entry price needed
        stopLossPrice,
        takeProfitPrice
      );

      if (positionResult && positionResult.dealReference) {
        console.log(`✅ Position opened successfully. Deal reference: ${positionResult.dealReference}`);
        return positionResult;
      } else {
        console.error("❌ Position creation failed: No deal reference received");
        this.setOpenTrades(this.openTrades.filter(t => t !== symbol));
      }
    } catch (error) {
      console.error(`❌ Error creating position for ${symbol}:`, error.message);
      // Remove from open trades if position creation failed
      this.setOpenTrades(this.openTrades.filter(t => t !== symbol));
      throw error;
    }
  }

  async setupTrailingStop(symbol, signal, entryPrice, takeProfitPips) {
    setTimeout(async () => {
      try {
        const positions = await getOpenPositions();
        const position = positions.positions.find((p) => p.market.epic === symbol);

        if (position && position.profit > 0) {
          const profitPips = Math.abs(position.level - entryPrice) / 0.0001;

          if (profitPips >= takeProfitPips * 0.5) {
            // 50% of take profit reached
            const trailingStopLevel =
              signal === "buy"
                ? position.level - 10 * 0.0001 // 10 pips trailing stop
                : position.level + 10 * 0.0001;

            await updateTrailingStop(position.position.dealId, trailingStopLevel);
            console.log(`🎯 Trailing stop set for ${symbol} at ${trailingStopLevel}`);
          }
        }
      } catch (error) {
        console.error("Error setting trailing stop:", error.message);
      }
    }, 5 * 60 * 1000); // Check after 5 minutes
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
}

export default new TradingService();
