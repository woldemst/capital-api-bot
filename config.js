import "dotenv/config";

export const API_KEY = process.env.API_KEY;
export const API_IDENTIFIER = process.env.API_IDENTIFIER;
export const API_PASSWORD = process.env.API_PASSWORD;
export const BASE_URL = process.env.BASE_URL;
export const API_PATH = process.env.API_PATH;
export const WS_BASE_URL = process.env.WS_BASE_URL;

// Trading configuration
export const SYMBOLS = ["EURUSD", "GBPUSD", "EURGBP", "AUDUSD", "USDCAD"];
// export const SYMBOLS = ["US500", "SILVER"];
export const TIMEFRAMES = ["MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30", "HOUR", "HOUR_4", "DAY"]; // Supported timeframes
// Add these constants to your config.js
export const LEVERAGE = 30;                    // 1:30 leverage
export const RISK_PER_TRADE = 0.02;           // 2% risk per trade
export const TAKE_PROFIT_FACTOR = 2;          // Take profit at 2x stop loss
export const TRAILING_STOP_ACTIVATION = 0.5;   // Activate trailing stop at 50% of take profit
export const TRAILING_STOP_PIPS = 10;         // 10 pips trailing stop for EUR/USD
export const PROFIT_THRESHOLD = 0.05;         // 5% profit threshold
export const POSITION_SIZE_INCREASE = 0.5;    // 50% position size increase after profit threshold
export const MAX_OPEN_TRADES = 5;             // Maximum 5 positions at a time
export const BACKTEST_MODE = false; // Set to true for backtesting, false for live trading

// Strategy configuration
export const STRATEGY = {
  TIMEFRAMES: {
    TREND: 'HOUR_4',     // H4 for trend analysis
    SETUP: 'HOUR',       // H1 for setup confirmation
    ENTRY: 'MINUTE_15'   // M15 for precise entry
  },
  INDICATORS: {
    FAST_EMA: 9,
    SLOW_EMA: 21,
    TREND_EMA: 50,
    LONG_TREND_EMA: 200,
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 70,
    RSI_OVERSOLD: 30,
    MACD: {
      FAST: 12,
      SLOW: 26,
      SIGNAL: 9
    },
    BB_PERIOD: 20,
    BB_STD_DEV: 2,
    ATR_PERIOD: 14
  },
  RISK: {
    MAX_POSITIONS: 5,
    RISK_PER_TRADE: 0.02,    // 2% risk per trade
    RR_RATIO: 2,             // 2:1 reward-to-risk ratio
    ATR_MULTIPLIER: 1.5,     // SL distance = 1.5 × ATR
    TRAILING_ACTIVATION: 1,   // Trail after 1× risk in profit
    PARTIAL_TP_PCT: 0.5      // Take 50% profit at first target
  },
  SESSIONS: {
    LONDON_START: '08:00',   // UTC times
    LONDON_END: '16:00',
    NY_START: '13:00',
    NY_END: '21:00'
  }
};