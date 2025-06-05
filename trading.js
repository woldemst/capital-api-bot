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
  console.log(`Generating signals for ${symbol}:`,m1Data, m1Indicators, m15Indicators, trendAnalysis, bid, ask);

  // Buy signal conditions
  const buyConditions = [
    // MA crossover (5 MA crosses above 20 MA)
    m1Indicators.maFast > m1Indicators.maSlow && 
      m1Data[m1Data.length-2].close < m1Indicators.maSlow,
    
    // RSI below 30 (oversold)
    m1Indicators.rsi < 30,
    
    // Price at lower Bollinger Band
    bid <= m1Indicators.bb.lower,
    
    // Higher timeframe trend confirmation
    trendAnalysis.overallTrend === 'bullish',
    
    // M15 confirmation
    m15Indicators.rsi > 50
  ];
  
  // Sell signal conditions
  const sellConditions = [
    // MA crossover (5 MA crosses below 20 MA)
    m1Indicators.maFast < m1Indicators.maSlow && 
      m1Data[m1Data.length-2].close > m1Indicators.maSlow,
    
    // RSI above 70 (overbought)
    m1Indicators.rsi > 70,
    
    // Price at upper Bollinger Band
    ask >= m1Indicators.bb.upper,
    
    // Higher timeframe trend confirmation
    trendAnalysis.overallTrend === 'bearish',
    
    // M15 confirmation
    m15Indicators.rsi < 50
  ];
  
  // Calculate signal scores
  const buyScore = buyConditions.filter(Boolean).length;
  const sellScore = sellConditions.filter(Boolean).length;
  
  console.log(`${symbol} Signal Analysis:
    - MA Crossover: ${buyConditions[0] ? 'Bullish' : sellConditions[0] ? 'Bearish' : 'Neutral'}
    - RSI: ${m1Indicators.rsi.toFixed(2)}
    - BB Position: ${(bid - m1Indicators.bb.lower).toFixed(5)} from lower, ${(m1Indicators.bb.upper - ask).toFixed(5)} from upper
    - Higher Timeframe Trend: ${trendAnalysis.overallTrend}
    - M15 RSI: ${m15Indicators.rsi.toFixed(2)}
    - Buy Score: ${buyScore}/5
    - Sell Score: ${sellScore}/5
  `);
  
  // Generate signal if majority of conditions are met
  let signal = null;
  if (buyScore >= 3) signal = 'buy';
  if (sellScore >= 3) signal = 'sell';
  
  return { 
    signal, 
    buyScore, 
    sellScore,
    metrics: {
      rsi: m1Indicators.rsi,
      maFast: m1Indicators.maFast,
      maSlow: m1Indicators.maSlow,
      bbUpper: m1Indicators.bb.upper,
      bbLower: m1Indicators.bb.lower
    }
  };
}