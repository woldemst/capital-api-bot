import "dotenv/config";

// API Configuration
export const API = {
    KEY: process.env.API_KEY,
    IDENTIFIER: process.env.API_IDENTIFIER,
    PASSWORD: process.env.API_PASSWORD,
    BASE_URL: `${process.env.BASE_URL}${process.env.API_PATH}`,
    WS_URL: process.env.WS_BASE_URL,
};

// Trading Sessions (UTC times)
export const SESSIONS = {
    LONDON: {
        START: "08:00",
        END: "17:00",
        SYMBOLS: ["EURUSD", "GBPUSD", "EURGBP", "USDCHF", "EURJPY"],
    },
    NY: {
        START: "13:00",
        END: "21:00",
        SYMBOLS: ["EURUSD", "GBPUSD", "USDJPY", "USDCAD", "GOLD"],
    },
    SYDNEY: {
        START: "22:00",
        END: "07:00",
        SYMBOLS: ["AUDUSD", "NZDUSD", "AUDJPY", "NZDJPY"],
    },
    TOKYO: {
        START: "00:00",
        END: "09:00",
        SYMBOLS: ["USDJPY", "EURJPY", "AUDJPY", "AUDUSD", "NZDUSD"],
    },
};

// London & New York (13:00 – 17:00 GMT) → 🔥 most volatile, most liquidity.

// Tokyo & London (08:00 – 09:00 GMT) → short overlap, moderate moves.

// Sydney & Tokyo (00:00 – 07:00 GMT) → smooth liquidity for AUD, NZD, JPY pairs.

// Trading Configuration
export const CRYPTO = ["BTC/USD", "ETH/USD"];
export const STOCKS = ["AAPL", "TSLA"];
export const ETFS = ["SPY", "QQQ"];

export const RISK = {
    LEVERAGE: 30,
    PER_TRADE: 0.02, // 2% risk per trade
    MAX_POSITIONS: 5, // Maximum simultaneous positions
    BUFFER_PIPS: 1, // Buffer for SL calculation
    REWARD_RATIO: 2, // 2:1 reward-to-risk ratio
    MAX_HOLD_TIME: 120, // Maximum hold time in minutes
    PARTIAL_TP_ENABLED: true,
    PARTIAL_TP_PERCENTAGE: 0.5,
    MAX_SLIPPAGE_PIPS: 2,
    MAX_DAILY_LOSS: 0.04, // 4% daily loss limit
    MAX_DAILY_PROFIT: 0.06, // 6% daily profit limit
    REQUIRED_SCORE: 2,
};

// Technical Analysis Configuration
export const ANALYSIS = {
    // Multi-Timeframe Strategy
    TIMEFRAMES: {
        D1: "DAY", // Daily trend direction
        H4: "HOUR_4", // 4-hour trend direction
        H1: "HOUR", // 1-hour entry timeframe
        M15: "MINUTE_15", // 15-minute entry timeframe
        M5: "MINUTE_5", // 5-minute entry timeframe
        M1: "MINUTE", // 1-minute entry timeframe
    },

    // EMAs for trend and entry
    EMA: {
        D1: { FAST: 20, SLOW: 50 },
        H4: { FAST: 20, SLOW: 50 },
        H1: { FAST: 9, SLOW: 21 },
    }, // RSI settings
    RSI: {
        PERIOD: 14,
        OVERBOUGHT: 70,
        OVERSOLD: 30,
        EXIT_OVERBOUGHT: 65, // Earlier exit
        EXIT_OVERSOLD: 35,
    },

    BACKTESTING: {
        ENABLED: false,
        START_DATE: "2023-01-01",
        END_DATE: "2023-12-31",
    },
};

export const HISTORY = {
    D1_BARS: 50, // For EMA50 calculation
    H4_BARS: 50, // For EMA50 calculation
    H1_BARS: 50, // For EMA21 and RSI
};

// Development overrides for faster testing
export const DEV = {
    INTERVAL: 10 * 1000, // 5 seconds between analyses (was 1 min)
    MODE: true,
};

export const PROD = {
    // INTERVAL: (60 - new Date().getMinutes()) * 60 * 1000 - new Date().getSeconds() * 1000 - new Date().getMilliseconds() + 5000,
    INTERVAL: 60 * 1000, // 60 seconds between analyses
};
// For convenience in error messages and logging
export const VERSION = "1.0.0";
