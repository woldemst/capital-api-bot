import { RISK_PER_TRADE, LEVERAGE, POSITION_SIZE_INCREASE } from "./config.js";

// Calculate position size based on risk management
export function positionSize(balance, price, stopLossPips, profitThresholdReached) {
  // Safety check for balance
  if (!balance || balance <= 0) {
    console.log('Warning: Invalid balance, using minimum position size');
    return 0.01; // Capital.com minimum position size is 0.01
  }

  const amount = balance * RISK_PER_TRADE;
  const pipValue = 0.0001;
  const slPips = stopLossPips || 40;
  
  // Apply position size increase if profit threshold reached
  const multiplier = profitThresholdReached ? (1 + POSITION_SIZE_INCREASE) : 1;
  
  // Calculate size in lots (Capital.com uses 0.01 lot increments)
  let size = (amount * LEVERAGE * multiplier) / (slPips * pipValue * 10000);
  
  // Round to 2 decimal places and ensure minimum size of 0.01
  size = Math.max(0.01, Math.round(size * 100) / 100);
  
  console.log(`Position Size Calculation:
    Balance: ${balance}
    Risk Amount: ${amount}
    Stop Loss Pips: ${slPips}
    Leverage: ${LEVERAGE}
    Multiplier: ${multiplier}
    Calculated Size: ${size} lots
  `);
  
  return size;
}

// Generate trading signals based on indicators
export function generateSignals(symbol, m1Data, m1Indicators, m15Indicators, trendAnalysis, bid, ask) {
  // Validate inputs
  if (!m1Data || !m1Indicators || !m15Indicators || !trendAnalysis) {
    console.log(`${symbol}: Missing required indicators data`);
    return { signal: null };
  }

  console.log(`\n=== Analyzing ${symbol} ===`);
  console.log('Current price:', { bid, ask });
  console.log('M1 RSI:', m1Indicators.rsi);
  console.log('M15 RSI:', m15Indicators.rsi);
  console.log('Trend Analysis:', trendAnalysis.overallTrend);

  // Buy signal conditions with enhanced MA cross check
  const buyConditions = [
    // MA crossover (5 MA crosses above 20 MA) with recent price confirmation
    m1Indicators.maFast > m1Indicators.maSlow && 
    m1Data[m1Data.length-2].close < m1Indicators.maSlow &&
    m1Data[m1Data.length-1].close > m1Data[m1Data.length-2].close,
    
    // RSI below 30 (oversold)
    m1Indicators.rsi < 30,
    
    // Price at lower Bollinger Band
    bid <= m1Indicators.bb.lower,
    
    // Higher timeframe trend confirmation
    trendAnalysis.overallTrend === 'bullish',
    
    // M15 confirmation - trending momentum
    m15Indicators.rsi > 50 && m15Indicators.macd.histogram > 0
  ];
  
  // Sell signal conditions with enhanced checks
  const sellConditions = [
    // MA crossover (5 MA crosses below 20 MA) with recent price confirmation
    m1Indicators.maFast < m1Indicators.maSlow && 
    m1Data[m1Data.length-2].close > m1Indicators.maSlow &&
    m1Data[m1Data.length-1].close < m1Data[m1Data.length-2].close,
    
    // RSI above 70 (overbought)
    m1Indicators.rsi > 70,
    
    // Price at upper Bollinger Band
    ask >= m1Indicators.bb.upper,
    
    // Higher timeframe trend confirmation
    trendAnalysis.overallTrend === 'bearish',
    
    // M15 confirmation - trending momentum
    m15Indicators.rsi < 50 && m15Indicators.macd.histogram < 0
  ];
  
  // Enhanced logging for debugging
  console.log('\nBuy Conditions:');
  buyConditions.forEach((condition, i) => {
    console.log(`  ${i+1}. ${condition ? '✅' : '❌'} ${
      i === 0 ? 'MA Crossover' :
      i === 1 ? 'RSI Oversold' :
      i === 2 ? 'BB Lower Touch' :
      i === 3 ? 'Trend Bullish' :
      'M15 Confirmation'
    }`);
  });

  console.log('\nSell Conditions:');
  sellConditions.forEach((condition, i) => {
    console.log(`  ${i+1}. ${condition ? '✅' : '❌'} ${
      i === 0 ? 'MA Crossover' :
      i === 1 ? 'RSI Overbought' :
      i === 2 ? 'BB Upper Touch' :
      i === 3 ? 'Trend Bearish' :
      'M15 Confirmation'
    }`);
  });
  
  // Calculate signal scores - require more conditions for stronger signals
  const buyScore = buyConditions.filter(Boolean).length;
  const sellScore = sellConditions.filter(Boolean).length;
  
  // Generate signal only if we have strong confirmation (3 out of 5 conditions)
  let signal = null;
  if (buyScore >= 3) signal = 'buy';
  if (sellScore >= 3) signal = 'sell';
  
  // Log final decision
  console.log('\nSignal Analysis:');
  console.log(`Buy Score: ${buyScore}/5`);
  console.log(`Sell Score: ${sellScore}/5`);
  console.log(`Final Signal: ${signal || 'NONE'}\n`);
  
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
      macdHistogram: m1Indicators.macd?.histogram
    }
  };
}