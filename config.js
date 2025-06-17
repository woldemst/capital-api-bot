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
  // Multi-Timeframe Strategy
  TIMEFRAMES: {
    TREND: 'HOUR_4',    // Trend direction
    SETUP: 'HOUR',      // Trade setup
    ENTRY: 'MINUTE_15'  // Entry/Exit timing
  },
  
  // EMAs for trend and entry
  EMA: {
    TREND: {
      FAST: 50,
      SLOW: 200
    },
    ENTRY: {
      FAST: 9,
      SLOW: 21
    }
  },
  
  // RSI settings
  RSI: {
    PERIOD: 14,
    OVERBOUGHT: 70,
    OVERSOLD: 30,
    EXIT_OVERBOUGHT: 65,
    EXIT_OVERSOLD: 35
  },
  
  // MACD settings
  MACD: {
    FAST: 12,
    SLOW: 26,
    SIGNAL: 9
  },
  
  // Bollinger Bands
  BOLLINGER: {
    PERIOD: 20,
    STD_DEV: 2
  },
  
  // ATR for stop loss and trailing
  ATR: {
    PERIOD: 14,
    STOP_MULTIPLIER: 1.5,
    TRAILING_MULTIPLIER: 1.0
  },
  
  // Risk Management
  RISK: {
    PER_TRADE: 0.02,        // 2% risk per trade
    REWARD_RATIO: 2.0,      // Target 2:1 reward/risk
    PARTIAL_TAKE_PROFIT: 0.5 // Take 50% profit at 1:1
  }
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
  BACKTEST_MODE: false,
  DEV_MODE: true, // Set to false in production
};

// Development overrides for faster testing
export const DEV = {
  TIMEFRAMES: {
    TREND: 'MINUTE_15',   // Trend direction (was HOUR_4)
    SETUP: 'MINUTE_5',    // Setup (was HOUR)
    ENTRY: 'MINUTE',      // Entry/Exit (was MINUTE_15)
  },
  ANALYSIS_INTERVAL_MS: 60 * 1000, // 1 minute between analyses (was 15 min)
};

// For convenience in error messages and logging
export const VERSION = '1.0.0';