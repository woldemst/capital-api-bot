import "dotenv/config";

const ENV = process.env;
const isTrue = (value) => ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());

function parseSymbolCsv(value) {
    return String(value || "")
        .split(",")
        .map((s) => String(s || "").trim().toUpperCase())
        .filter(Boolean);
}

// API Configuration
export const API = {
    KEY: ENV.API_KEY,
    IDENTIFIER: ENV.API_IDENTIFIER,
    PASSWORD: ENV.API_PASSWORD,
    BASE_URL: `${ENV.BASE_URL}${ENV.API_PATH}`,
    WS_URL: ENV.WS_BASE_URL,
};

// Trading Sessions (UTC times)
const RAW_SESSION_SYMBOLS = {
    LONDON: ["EURJPY", "USDJPY", "EURUSD", "GBPUSD", "EURGBP", "USDCHF"],
    NY: ["USDJPY", "EURJPY", "EURUSD", "GBPUSD", "USDCAD", "USDCHF"],
    SYDNEY: ["EURJPY", "USDJPY", "AUDUSD", "AUDJPY", "NZDUSD", "NZDJPY"],
    TOKYO: ["EURJPY", "USDJPY", "AUDUSD", "AUDJPY", "NZDUSD", "NZDJPY"],
};
const FOREX_SYMBOL_BLOCKLIST_DEFAULT = ["USDCHF"];
const FOREX_SYMBOL_BLOCKLIST_RAW =
    ENV.FOREX_SYMBOL_BLOCKLIST === undefined ? FOREX_SYMBOL_BLOCKLIST_DEFAULT.join(",") : ENV.FOREX_SYMBOL_BLOCKLIST;
const FOREX_SYMBOL_BLOCKLIST = new Set(parseSymbolCsv(FOREX_SYMBOL_BLOCKLIST_RAW));
const SESSION_SYMBOLS = Object.fromEntries(
    Object.entries(RAW_SESSION_SYMBOLS).map(([session, symbols]) => [
        session,
        (Array.isArray(symbols) ? symbols : [])
            .map((symbol) => String(symbol || "").trim().toUpperCase())
            .filter((symbol) => symbol && !FOREX_SYMBOL_BLOCKLIST.has(symbol)),
    ]),
);
// can take them later as well AUDUSD, EURUSD, GBPUSD, USDCAD

export const CRYPTO_SYMBOLS = [];
export const TRADING_WINDOWS = {
    FOREX: [
        // 22:00-12:59 UTC
        { start: 22 * 60, end: 12 * 60 + 59 },
    ],
    CRYPTO: [],
};

export const NEWS_GUARD = {
    ENABLED: isTrue(ENV.NEWS_GUARD_ENABLED),
    FOREX_ONLY: true,
    INCLUDE_IMPACTS: ["High"],
    WINDOWS_BY_IMPACT: {
        High: { preMinutes: 10, postMinutes: 3 },
    },
};

export const PRICE_LOGGER = {
    ENABLED: isTrue(ENV.PRICE_LOGGER_ENABLED),
};

const DEFAULT_LIVE_SYMBOLS = ["AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDJPY"];

export const LIVE_SYMBOLS = parseSymbolCsv(String(ENV.LIVE_SYMBOLS || DEFAULT_LIVE_SYMBOLS.join(",")));

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
    PER_TRADE: 0.05, // 5% risk per forex trade
    CRYPTO_PER_TRADE: 0.04, // 4% risk per crypto trade
    MAX_POSITIONS: 5, // Maximum simultaneous positions
    GUARDS: {
        MAX_DAILY_LOSS_PCT: 0, // disabled: no daily-loss entry block
        MAX_OPEN_RISK_PCT: 0.25, // cap estimated total open risk across all positions
        MAX_LOSS_STREAK: 3, // consecutive losing closes before cooldown
        LOSS_STREAK_COOLDOWN_MINUTES: 0, // disabled
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

const CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_SYMBOLS = [];

export const STRATEGY_SELECTION = {
    FOREX_PRIMARY: ENV.FOREX_PRIMARY_STRATEGY || "INTRADAY_7STEP_V1",
    CRYPTO_PRIMARY: ENV.CRYPTO_PRIMARY_STRATEGY || ENV.CRYPTO_STRATEGY_NAME || "DISABLED",
};

export const STRATEGIES = {
    CRYPTO_LIQUIDITY_WINDOW_MOMENTUM: {
        id: "CRYPTO_LIQUIDITY_WINDOW_MOMENTUM",
        enabled: false,
        symbols: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_SYMBOLS,
        timezone: "Europe/Berlin",
        window: {
            start: ENV.CLWM_WINDOW_START || "14:00",
            end: ENV.CLWM_WINDOW_END || "20:00",
        },
        data: {
            minCandles5m: 200,
            minCandles1h: 50,
        },
        spread: {
            maxSpreadPctDefault: 0.0012,
        },
        jump: {
            lookbackBars5m: 12, // 60m
            jumpAtrMult: 2.5,
            cooldownMinutes: 60,
        },
        signal: {
            emaFastPeriod: 9,
            emaSlowPeriod: 21,
            slopeLookbackCandles: 3,
            volumeMult: 1.1,
            trendFilter1h: {
                enabled: !isTrue(ENV.CLWM_DISABLE_H1_FILTER),
                emaPeriod: 50,
            },
        },
        entry: {
            cooldownMinutes: 30,
            maxTradesPerSymbolPerDay: 1,
            maxTradesPerDay: 2,
        },
        exits: {
            tpR: 1.25,
            moveStopToBreakevenAtR: 0.8,
            breakevenBufferR: 0.05,
            timeStopMinutes: 120,
            timeStopMinR: 0.3,
            trailing: {
                enabled: true,
                atrMult: 1.0,
                activateAtR: 1.0,
            },
        },
        risk: {
            riskProfile: ["normal", "aggressive"].includes(String(ENV.CLWM_RISK_PROFILE || "").toLowerCase())
                ? String(ENV.CLWM_RISK_PROFILE || "").toLowerCase()
                : "normal",
            riskPctNormal: 0.04,
            riskPctAggressive: 0.04,
            dailyLossLimitPctNormal: 0.01,
            dailyLossLimitPctAggressive: 0.03,
            maxLeverageCrypto: 2.0,
        },
        perSymbolOverrides: {
            BTCUSD: {
                maxSpreadPct: 0.0008,
                jumpThresholdPct: 0.009,
                stopAtrMult: 1.0,
                minStopPct: 0.0025,
                filters: {
                    allowedSides: ["LONG"],
                    allowedWeekdays: ["SUN"],
                },
            },
            ETHUSD: {
                maxSpreadPct: 0.0008,
                jumpThresholdPct: 0.009,
                stopAtrMult: 1.0,
                minStopPct: 0.0025,
                filters: {
                    allowedSides: ["LONG"],
                    allowedWeekdays: ["SUN"],
                },
            },
            SOLUSD: {
                maxSpreadPct: 0.0012,
                jumpThresholdPct: 0.013,
                stopAtrMult: 1.2,
                minStopPct: 0.0035,
            },
            XRPUSD: {
                maxSpreadPct: 0.0012,
                jumpThresholdPct: 0.013,
                stopAtrMult: 1.2,
                minStopPct: 0.0035,
            },
            DOGEUSD: {
                maxSpreadPct: 0.0012,
                jumpThresholdPct: 0.013,
                stopAtrMult: 1.2,
                minStopPct: 0.0035,
            },
        },
        logging: {
            enabled: true,
        },
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
    SYMBOLS: ["AUDUSD", "EURUSD", "GBPUSD", "USDCAD", "USDJPY"],
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
