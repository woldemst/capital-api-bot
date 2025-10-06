import "dotenv/config";

// API Configuration
export const API = {
    KEY: process.env.API_KEY,
    IDENTIFIER: process.env.API_IDENTIFIER,
    PASSWORD: process.env.API_PASSWORD,
    BASE_URL: `${process.env.BASE_URL}${process.env.API_PATH}`,
    WS_URL: process.env.WS_BASE_URL,
};

export const backtestSymbols = [
    "EURUSD",
    "GBPUSD",
    "EURGBP",
    "USDCHF",
    "EURJPY",
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "USDCAD",
    "AUDUSD",
    "NZDUSD",
    "AUDJPY",
    "NZDJPY",
    "USDJPY",
    "EURJPY",
    "AUDUSD",
    "NZDUSD",
];

// Trading Sessions (UTC times)
export const SESSIONS = {
    LONDON: {
        START: "08:00",
        END: "17:00",
        SYMBOLS: ["EURUSD", "GBPUSD", "EURGBP", "USDCHF"],
    },
    NY: {
        START: "13:00",
        END: "21:00",
        SYMBOLS: ["EURUSD", "GBPUSD", "USDJPY", "USDCAD"],
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
    CRYPTO: ["BTC/USD", "ETH/USD"],
    STOCKS: ["AAPL", "TSLA"],
    ETFS: ["SPY", "QQQ"],
};

export const RISK = {
    LEVERAGE: 30,
    PER_TRADE: 0.02, // 2% risk per trade
    MAX_POSITIONS: 5, // Maximum simultaneous positions
    BUFFER_PIPS: 1, // Buffer for SL calculation
    REWARD_RATIO: 2, // 2:1 reward-to-risk ratio
    MAX_HOLD_TIME: 60, // Maximum hold time in minutes
    PARTIAL_TP_ENABLED: true,
    PARTIAL_TP_PERCENTAGE: 0.5,
    MAX_SLIPPAGE_PIPS: 2,
    MAX_DAILY_LOSS: 0.04, // 4% daily loss limit
    MAX_DAILY_PROFIT: 0.06, // 6% daily profit limit
    REQUIRED_PRIMARY_SCORE: 3,    // Must have at least 3 primary conditions
    REQUIRED_SECONDARY_SCORE: 2,      // Must have total score of 4 or more
    ATR_MULTIPLIER: 1.8, // ATR multiplier for SL calculation
    RISK_REWARD: 2, // Reward-to-risk ratio
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
        TREND: {
            FAST: 50,
            SLOW: 200,
        },
        ENTRY: {
            FAST: 9,
            SLOW: 21,
        },
    },

    // RSI settings
    RSI: {
        PERIOD: 14,
        OVERBOUGHT: 70,
        OVERSOLD: 30,
        EXIT_OVERBOUGHT: 65, // Earlier exit
        EXIT_OVERSOLD: 35,
    },

    BACKTESTING: {
        ENABLED: false,
        START_DATE: "2024-01-01",
        END_DATE: "2025-12-31",
    },
};

export const HISTORY = {
    D1_BARS: 50, // For EMA50 calculation
    H4_BARS: 50, // For EMA50 calculation
    H1_BARS: 50, // For EMA21 and RSI
};

// Development overrides for faster testing
export const DEV = {
    INTERVAL: 15 * 1000, // 1 minute between analyses
    MODE: true,
};

export const PROD = {
    INTERVAL: 1 * 60 * 1000, // 15 minutes between analyses (aligned with M15)
};
