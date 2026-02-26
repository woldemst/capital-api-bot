import "dotenv/config";

const ENV = process.env;

// API Configuration
export const API = {
    KEY: ENV.API_KEY,
    IDENTIFIER: ENV.API_IDENTIFIER,
    PASSWORD: ENV.API_PASSWORD,
    BASE_URL: `${ENV.BASE_URL}${ENV.API_PATH}`,
    WS_URL: ENV.WS_BASE_URL,
};

// Trading Sessions (UTC times)
const SESSION_SYMBOLS = {
    LONDON: ["EURJPY", "USDJPY", "EURUSD", "GBPUSD", "EURGBP"],
    NY: ["USDJPY", "EURJPY", "EURUSD", "GBPUSD", "USDCAD"],
    SYDNEY: ["EURJPY", "USDJPY", "AUDUSD", "AUDJPY"],
    TOKYO: ["EURJPY", "USDJPY", "AUDUSD", "AUDJPY"],
};
// can take them later as well AUDUSD, EURUSD, GBPUSD, USDCAD

export const CRYPTO_SYMBOLS = ["BTCUSD", "ETHUSD", "DOGEUSD", "XRPUSD"];
export const TRADING_WINDOWS = {
    FOREX: [
        // 22:00-12:59 UTC
        { start: 22 * 60, end: 12 * 60 + 59 },
    ],
    CRYPTO: [
        // 02:00-05:59 UTC
        { start: 2 * 60, end: 5 * 60 + 59 },
        // 08:00-16:59 UTC
        { start: 8 * 60, end: 16 * 60 + 59 },
    ],
};

export const NEWS_GUARD = {
    FOREX_ONLY: true,
    INCLUDE_IMPACTS: ["High"],
    WINDOWS_BY_IMPACT: {
        High: { preMinutes: 10, postMinutes: 3 },
    },
};

export const SESSIONS = {
    LONDON: {
        START: "08:00",
        END: "17:00",
        SYMBOLS: SESSION_SYMBOLS.LONDON,
    },
    NY: {
        START: "13:00",
        END: "21:00",
        SYMBOLS: SESSION_SYMBOLS.NY,
    },
    SYDNEY: {
        START: "22:00",
        END: "07:00",
        SYMBOLS: SESSION_SYMBOLS.SYDNEY,
    },
    TOKYO: {
        START: "00:00",
        END: "09:00",
        SYMBOLS: SESSION_SYMBOLS.TOKYO,
    },
    CRYPTO: {
        START: "00:00",
        END: "23:59",
        SYMBOLS: CRYPTO_SYMBOLS,
    },
};

export const RISK = {
    // Conservative defaults for small accounts; can be overridden via env later.
    PER_TRADE: 0.005, // 0.5% risk per forex trade
    CRYPTO_PER_TRADE: 0.004, // 0.4% risk per crypto trade
    MAX_POSITIONS: 3, // Maximum simultaneous positions
    GUARDS: {
        MAX_DAILY_LOSS_PCT: 0.02, // stop new entries after -2% estimated realized day PnL
        MAX_OPEN_RISK_PCT: 0.015, // cap estimated total open risk across all positions
        MAX_LOSS_STREAK: 3, // consecutive losing closes before cooldown
        LOSS_STREAK_COOLDOWN_MINUTES: 180,
        SUMMARY_CACHE_MS: 15000,
    },
    EXITS: {
        TRAIL_ACTIVATION_TP_PROGRESS: 0.45, // was 0.70
        BREAKEVEN_ACTIVATION_TP_PROGRESS: 0.5, // was 0.70
        TRAIL_DISTANCE_TP_FRACTION: 0.18,
        TRAIL_DISTANCE_ATR_MULTIPLIER: 0.8,
        SOFT_EXIT_ON_M5_M15_BREAK: true,
    },
};

const TIMEFRAMES = {
    D1: "DAY", // Daily trend direction
    H4: "HOUR_4", // 4-hour trend direction
    H1: "HOUR", // 1-hour entry timeframe
    M15: "MINUTE_15", // 15-minute entry timeframe
    M5: "MINUTE_5", // 5-minute entry timeframe
    M1: "MINUTE", // 1-minute entry timeframe
};

const EMA = {
    TREND: {
        FAST: 50,
        SLOW: 200,
    },
    ENTRY: {
        FAST: 9,
        SLOW: 21,
    },
};

// Technical Analysis Configuration
export const ANALYSIS = {
    TIMEFRAMES,
    SYMBOLS: ["EURJPY", "USDJPY", "BTCUSD", "ETHUSD", "DOGEUSD", "XRPUSD"],
    EMA,
};

// Development overrides for faster testing
export const DEV = {
    INTERVAL: 15 * 1000, // 15 seconds between analyses
    MODE: false,
};

// 1 min
// export const PROD = { INTERVAL: (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds() + 5000 };

// 1 min
export const PROD = {
    INTERVAL: (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds() + 5000,
};
