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
    LONDON: ["EURUSD", "GBPUSD", "EURGBP", "USDCHF"],
    NY: ["EURUSD", "GBPUSD", "USDJPY", "USDCAD"],
    SYDNEY: ["AUDUSD", "NZDUSD", "AUDJPY", "NZDJPY"],
    TOKYO: ["USDJPY", "EURJPY", "AUDJPY", "AUDUSD", "NZDUSD"],
};

export const CRYPTO_SYMBOLS = ["BTCUSD", "BTCEUR", "SOLUSD", "XRPUSD", "DOGEUSD", "ADAUSD"];

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
    PER_TRADE: 0.02, // 2% risk per trade
    MAX_POSITIONS: 5, // Maximum simultaneous positions
    MAX_HOLD_TIME: 180, // Maximum hold time in minutes
};

const TIMEFRAMES = {
    D1: "D1",
    H4: "H4",
    H1: "H1",
    M15: "M15",
    M5: "M5",
    M1: "M1",
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
    SYMBOLS: ["EURUSD", "GBPUSD", "EURGBP", "AUDUSD", "USDCAD"],
    EMA,
};

export const STRATEGY = {
    REGIME: {
        TREND_ADX: 25,
        TRANSITION_ADX: 20,
        ALLOW_TRANSITION_ENTRIES: true,
    },
    MID_TF: {
        MIN_ATR_PCT: 0.00015,
        MAX_CONTRADICTION_SCORE: 5,
        MIN_H1_ADX: 18,
        MIN_M15_ADX: 20,
        REQUIRE_DI_ALIGNMENT: true,
    },
    ENTRY: {
        M5_PULLBACK_ATR_MULT: 0.7,
        M5_PULLBACK_BB_LOWER_MAX: 0.55,
        M5_PULLBACK_BB_UPPER_MIN: 0.45,
        M1_RSI_PIVOT: 50,
        REQUIRE_PULLBACK: true,
        REQUIRE_M5_MOMENTUM: true,
        REQUIRE_M1_CONFIRMATION: true,
        M1_RSI_LONG_MIN: 50,
        M1_RSI_SHORT_MAX: 50,
        M5_RSI_LONG_MIN: 48,
        M5_RSI_SHORT_MAX: 52,
        MIN_CONFIRMATIONS_TREND: 2,
        MIN_CONFIRMATIONS_TRANSITION: 3,
    },
    BIAS_REVERSION: {
        ENABLED: true,
        REQUIRE_PHASE_C_MISALIGNMENT: true,
        M5_BB_PB_SHORT_MIN: 0.7,
        M5_BB_PB_LONG_MAX: 0.3,
        M5_RSI_SHORT_MIN: 55,
        M5_RSI_LONG_MAX: 45,
        M1_RSI_SHORT_MIN: 55,
        M1_RSI_LONG_MAX: 45,
        REQUIRE_M1_PRICE_E9_CONFIRM: true,
        REQUIRE_M5_MACD_DELTA_CONFIRM: true,
    },
};

export const LIVE_MANAGEMENT = {
    LOOP_MS: 20 * 1000,
    PARTIAL_CLOSE_FRACTION: 0.4,
    PARTIAL_MIN_R: 0.4,
    PARTIAL_GIVEBACK_PCT: 0.35,
    PARTIAL_DECAY_COUNT: 3,
    FULL_CLOSE_AFTER_PARTIAL_DECAY: 4,
    FULL_CLOSE_AFTER_PARTIAL_MIN_R: 0.1,
    EARLY_FULL_CLOSE_MIN_R: -0.45,
    EARLY_FULL_CLOSE_DECAY_COUNT: 2,
    WEAKENING_ADX_FLOOR: 20,
    TIGHTEN_SL_MIN_R: 0.5,
    TIGHTEN_SL_DECAY_COUNT: 2,
};

// Development overrides for faster testing
export const DEV = {
    INTERVAL: 15 * 1000, // 60 seconds between analyses
    MODE: false,
};

// 1 min
// export const PROD = { INTERVAL: (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds() + 5000 };

// 5 min
export const PROD = {
    INTERVAL: ((5 - (new Date().getMinutes() % 5)) * 60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds() + 5000,
};
