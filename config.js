import "dotenv/config";

// API Configuration
export const API = {
    KEY: process.env.API_KEY,
    IDENTIFIER: process.env.API_IDENTIFIER,
    PASSWORD: process.env.API_PASSWORD,
    BASE_URL: `${process.env.BASE_URL}${process.env.API_PATH}`,
    WS_URL: process.env.WS_BASE_URL,
};

// Trading Configuration
export const TRADING = {
    // Instruments and timeframes
    SYMBOLS: ["EURUSD", "GBPUSD", "EURGBP", "AUDUSD", "USDCAD"],
    TIMEFRAMES: ["HOUR", "HOUR_4", "DAY"],

    // Position sizing and risk management
    LEVERAGE: 30,
    RISK_PER_TRADE: 0.02, // 2% risk per trade
    MAX_POSITIONS: 5, // Maximum 3 simultaneous positions
    POSITION_BUFFER_PIPS: 1, // Buffer for SL calculation

    // Take profit and stop loss
    REWARD_RISK_RATIO: 2, // 2:1 reward-to-risk ratio
    MAX_HOLD_TIME: 240, // Maximum hold time in minutes

    // Partial profit taking
    PARTIAL_TP_ENABLED: true,
    PARTIAL_TP_PERCENTAGE: 0.5,

    // Slippage control (in pips)
    MAX_SLIPPAGE_PIPS: 2, // Maximum allowed slippage in pips

    // Daily risk control
    MAX_DAILY_LOSS: 0.04, // Stop trading after 4% loss in a day
    MAX_DAILY_PROFIT: 0.06, // Stop trading after 6% profit in a day
};

// Technical Analysis Configuration
export const ANALYSIS = {
    // Multi-Timeframe Strategy
    TIMEFRAMES: {
        D1: "DAY", // Daily trend direction
        H4: "HOUR_4", // 4-hour trend direction
        H1: "HOUR", // 1-hour entry timeframe
    },

    // EMAs for trend and entry
    EMA: {
        D1: {
            FAST: 20,
            SLOW: 50,
        },
        H4: {
            FAST: 20,
            SLOW: 50,
        },
        H1: {
            FAST: 9,
            SLOW: 21,
        },
    }, // RSI settings
    RSI: {
        PERIOD: 14,
        OVERBOUGHT: 70,
        OVERSOLD: 30,
        EXIT_OVERBOUGHT: 65, // Earlier exit
        EXIT_OVERSOLD: 35,
    },

    // Risk Management
    RISK: {
        PER_TRADE: 0.02, // 2% risk per trade
        REWARD_RATIO: 2.0, // Target 2:1 reward/risk
        PARTIAL_TAKE_PROFIT: 0.5, // Take 50% profit at 1:1
    },
};

// Trading Sessions (UTC times)
export const SESSIONS = {
    LONDON_START: "08:00",
    LONDON_END: "16:00",
    NY_START: "13:00",
    NY_END: "21:00",
};

export const HISTORY = {
    D1_BARS: 50, // For EMA50 calculation
    H4_BARS: 50, // For EMA50 calculation
    H1_BARS: 50, // For EMA21 and RSI
};

// Development overrides for faster testing
export const DEV = {
    INTERVAL: 5 * 1000, // 5 seconds between analyses (was 1 min)
    MODE: false,
};

export const PROD = {
    INTERVAL: (60 - new Date().getMinutes()) * 60 * 1000 - new Date().getSeconds() * 1000 - new Date().getMilliseconds() + 5000,
};
// For convenience in error messages and logging
export const VERSION = "1.0.0";
