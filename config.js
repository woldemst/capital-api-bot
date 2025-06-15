import "dotenv/config";

// API Configuration
export const API = {
  KEY: process.env.API_KEY,
  IDENTIFIER: process.env.API_IDENTIFIER,
  PASSWORD: process.env.API_PASSWORD,
  BASE_URL: `${process.env.BASE_URL}${process.env.API_PATH}`,
  WS_URL: process.env.WS_BASE_URL
};

// Trading Configuration
export const TRADING = {
  // Instruments and timeframes
  SYMBOLS: ["EURUSD", "GBPUSD", "EURGBP", "AUDUSD", "USDCAD"],
  TIMEFRAMES: ["MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30", "HOUR", "HOUR_4", "DAY"],
  
  // Position sizing and risk management
  LEVERAGE: 30,
  RISK_PER_TRADE: 0.02,
  MAX_POSITIONS: 5,
  PROFIT_THRESHOLD: 0.05,
  POSITION_SIZE_INCREASE: 0.5,
  
  // Take profit and stop loss
  REWARD_RISK_RATIO: 2,
  TRAILING_STOP_ACTIVATION: 0.5,
  TRAILING_STOP_PIPS: 10,
  
  // Position sizing limits
  FOREX_MIN_SIZE: 100,
  FOREX_MAX_SIZE: 1000,
  
  // Partial profit taking
  PARTIAL_TP_ENABLED: true,
  PARTIAL_TP_PERCENTAGE: 0.5
};

// Technical Analysis Configuration
export const ANALYSIS = {
  // Timeframe strategy
  TREND_TIMEFRAME: 'HOUR_4',
  SETUP_TIMEFRAME: 'HOUR',
  ENTRY_TIMEFRAME: 'MINUTE_15',
  
  // Moving averages
  MA_FAST: 5,
  MA_SLOW: 20,
  MA_TREND: 50,
  MA_LONG: 200,
  
  // RSI settings
  RSI_PERIOD: 14,
  RSI_OVERBOUGHT: 70,
  RSI_OVERSOLD: 30,
  
  // MACD settings
  MACD_FAST: 12,
  MACD_SLOW: 26,
  MACD_SIGNAL: 9,
  
  // Bollinger Bands
  BB_PERIOD: 20,
  BB_STD_DEV: 2,
  
  // ATR for stop loss
  ATR_PERIOD: 14,
  ATR_MULTIPLIER: 1.5
};

// Trading Sessions (UTC times)
export const SESSIONS = {
  LONDON_START: '08:00',
  LONDON_END: '16:00',
  NY_START: '13:00',
  NY_END: '21:00'
};

// Mode Configuration
export const MODE = {
  BACKTEST_MODE: false
};

// For convenience in error messages and logging
export const VERSION = '1.0.0';