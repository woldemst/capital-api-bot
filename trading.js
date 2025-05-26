import { RISK_PER_TRADE, LEVERAGE, POSITION_SIZE_INCREASE } from "./config.js";

// Calculate position size based on risk management
export function positionSize(balance, price, stopLossPips, profitThresholdReached) {
  const amount = balance * RISK_PER_TRADE;
  const pipValue = 0.0001;
  const slPips = stopLossPips || 40;
  
  // Apply position size increase if profit threshold reached
  const multiplier = profitThresholdReached ? (1 + POSITION_SIZE_INCREASE) : 1;
  
  return Math.max(0.01, (amount * LEVERAGE * multiplier) / (slPips * pipValue));
}

// Generate trading signals based on indicators
export function generateSignals(symbol, m1Data, m1Indicators, m15Indicators, trendAnalysis, bid, ask) {
  // Buy signal conditions
  const buyConditions = [
    // MA crossover (fast MA crosses above slow MA)
    m1Indicators.maFast > m1Indicators.maSlow && 
      m1Data[m1Data.length-2].close < m1Indicators.maSlow,
    
    // RSI conditions (oversold and trending up)
    m1Indicators.rsi < 30 || (m1Indicators.rsi < 50 && m1Indicators.rsi > m1Indicators.rsi),
    
    // Price near lower Bollinger Band
    bid <= m1Indicators.bb.lower * 1.001,
    
    // MACD histogram turning positive
    m1Indicators.macd.histogram > 0 && m1Data[m1Data.length-2].close < 0,
    
    // Higher timeframe confirmation
    trendAnalysis.overallTrend === 'bullish',
    
    // M15 confirmation
    m15Indicators.rsi > 50
  ];
  
  // Sell signal conditions
  const sellConditions = [
    // MA crossover (fast MA crosses below slow MA)
    m1Indicators.maFast < m1Indicators.maSlow && 
      m1Data[m1Data.length-2].close > m1Indicators.maSlow,
    
    // RSI conditions (overbought and trending down)
    m1Indicators.rsi > 70 || (m1Indicators.rsi > 50 && m1Indicators.rsi < m1Indicators.rsi),
    
    // Price near upper Bollinger Band
    ask >= m1Indicators.bb.upper * 0.999,
    
    // MACD histogram turning negative
    m1Indicators.macd.histogram < 0 && m1Data[m1Data.length-2].close > 0,
    
    // Higher timeframe confirmation
    trendAnalysis.overallTrend === 'bearish',
    
    // M15 confirmation
    m15Indicators.rsi < 50
  ];
  
  // Count how many buy conditions are met
  const buyScore = buyConditions.filter(Boolean).length;
  const sellScore = sellConditions.filter(Boolean).length;
  
  console.log(`${symbol} Signal Scores - Buy: ${buyScore}/6, Sell: ${sellScore}/6`);
  
  // Generate signal if at least 4 conditions are met
  let signal = null;
  if (buyScore >= 4) signal = 'buy';
  if (sellScore >= 4) signal = 'sell';
  
  return { signal, buyScore, sellScore };
}