const ENV = process.env;

function parseSymbolCsv(value) {
    return String(value || "")
        .split(",")
        .map((s) => String(s || "").trim().toUpperCase())
        .filter(Boolean);
}

function parseSymbolSessionFilter(value) {
    const parsed = {};
    const text = String(value || "").trim();
    if (!text) return parsed;
    const entries = text
        .split(";")
        .map((part) => String(part || "").trim())
        .filter(Boolean);
    for (const entry of entries) {
        const [symbolRaw, sessionsRaw = ""] = entry.split(":");
        const symbol = String(symbolRaw || "").trim().toUpperCase();
        if (!symbol) continue;
        const sessions = String(sessionsRaw || "")
            .split(/[|,+/]/)
            .map((x) => String(x || "").trim().toUpperCase())
            .filter(Boolean);
        parsed[symbol] = sessions;
    }
    return parsed;
}

const RAW_SESSION_SYMBOLS = {
    LONDON: ["EURJPY", "GBPJPY", "CHFJPY", "USDJPY", "EURUSD", "GBPUSD", "EURGBP", "EURCHF", "GBPCHF", "USDCHF"],
    NY: ["USDJPY", "EURJPY", "GBPJPY", "CADJPY", "CHFJPY", "EURUSD", "GBPUSD", "USDCAD", "EURCHF", "GBPCHF", "USDCHF"],
    SYDNEY: ["EURJPY", "USDJPY", "AUDUSD", "AUDJPY", "NZDUSD", "NZDJPY"],
    TOKYO: ["EURJPY", "GBPJPY", "CADJPY", "CHFJPY", "USDJPY", "AUDUSD", "AUDJPY", "NZDUSD", "NZDJPY"],
};

const FOREX_SYMBOL_BLOCKLIST_DEFAULT = ["USDCHF"];
const FOREX_SYMBOL_BLOCKLIST_RAW =
    ENV.FOREX_SYMBOL_BLOCKLIST === undefined ? FOREX_SYMBOL_BLOCKLIST_DEFAULT.join(",") : ENV.FOREX_SYMBOL_BLOCKLIST;
const FOREX_SYMBOL_BLOCKLIST = new Set(parseSymbolCsv(FOREX_SYMBOL_BLOCKLIST_RAW));

export const SESSION_SYMBOLS = Object.fromEntries(
    Object.entries(RAW_SESSION_SYMBOLS).map(([session, symbols]) => [
        session,
        (Array.isArray(symbols) ? symbols : [])
            .map((symbol) => String(symbol || "").trim().toUpperCase())
            .filter((symbol) => symbol && !FOREX_SYMBOL_BLOCKLIST.has(symbol)),
    ]),
);

export const CRYPTO_SYMBOLS = [];
const DEFAULT_SYMBOL_SESSIONS = {
    EURUSD: ["LONDON", "NY"],
    GBPUSD: ["LONDON", "NY"],
    EURCHF: ["LONDON", "NY"],
    USDJPY: ["TOKYO", "NY"],
    USDCAD: ["NY"],
    USDCHF: [],
    AUDUSD: ["SYDNEY", "TOKYO"],
    NZDUSD: ["SYDNEY", "TOKYO"],
};
const DEFAULT_PAIR_OVERRIDES = {
    EURUSD: {
        context: {
            adxTrendMin: 25,
        },
        setup: {
            maxH1AdxForTrendSetup: 55,
        },
    },
    GBPUSD: {
        context: {
            adxTrendMin: 25,
        },
        setup: {
            maxH1AdxForTrendSetup: 50,
        },
    },
    EURCHF: {},
    USDJPY: {
        risk: {
            forexRiskPct: 0.02,
        },
        schedule: {
            blockedUtcHourBuckets: ["18-23"],
        },
    },
    USDCAD: {},
    USDCHF: {},
    AUDUSD: {},
    NZDUSD: {
        risk: {
            forexRiskPct: 0.02,
        },
        trigger: {
            requireStructureBreak: true,
        },
    },
};
const SYMBOL_SESSION_FILTER_RAW =
    ENV.FOREX_SYMBOL_SESSION_FILTER === undefined
        ? Object.entries(DEFAULT_SYMBOL_SESSIONS)
              .map(([symbol, sessions]) => `${symbol}:${sessions.join("|")}`)
              .join(";")
        : ENV.FOREX_SYMBOL_SESSION_FILTER;
const SYMBOL_SESSION_FILTER = parseSymbolSessionFilter(SYMBOL_SESSION_FILTER_RAW);

export const NEWS_MODE = {
    AVOID: "AVOID",
    TRADE: "TRADE",
};

export const DEFAULT_CRYPTO_INTRADAY_CONFIG = {
    strategyId: "INTRADAY_7STEP_CRYPTO",
    context: {
        adxTrendMin: 18,
        adxRangeMax: 18,
    },
    setup: {
        trendPullbackZonePct: 0.0023,
        maxH1AdxForTrendSetup: 45,
        trendRsiMin: 38,
        trendRsiMax: 62,
        rangeBbPbLow: 0.2,
        rangeBbPbHigh: 0.8,
        rangeRsiLow: 40,
        rangeRsiHigh: 60,
    },
    trigger: {
        displacementAtrMultiplier: 1.0,
        requireStructureBreak: false,
        requireFvg: true,
        useFvgBonus: true,
    },
    guardrails: {
        allowRangeContrarian: true,
    },
};

export const DEFAULT_INTRADAY_CONFIG = {
    strategyId: "INTRADAY_7STEP_V1",
    sessionPriority: ["NY", "LONDON", "TOKYO", "SYDNEY"],
    sessionsUtc: {
        LONDON: { start: "08:00", end: "17:00" },
        NY: { start: "13:00", end: "21:00" },
        SYDNEY: { start: "22:00", end: "07:00" },
        TOKYO: { start: "00:00", end: "09:00" },
    },
    symbolSessions: SYMBOL_SESSION_FILTER,
    intradayOnly: {
        flatPositionsCutoffUtcForex: { hour: 20, minute: 55 },
        flatPositionsCutoffUtcCrypto: { hour: 23, minute: 55 },
        cryptoDayBoundaryExit: true,
    },
    schedule: {},
    guardrails: {
        maxTradesPerDay: 15,
        blockDuplicateSymbolEntries: true,
        requireInitialSlTp: true,
        allowRangeContrarian: false,
        sentimentCrowdedThreshold: 0.78,
        newsMode: NEWS_MODE.AVOID,
        newsStrategySetupTypes: ["NEWS_EVENT_BREAKOUT"],
    },
    news: {
        preMinutesHighImpact: 30,
        postMinutesHighImpact: 15,
    },
    context: {
        h1EmaFast: "ema20",
        h1EmaMid: "ema50",
        h1EmaSlow: "ema200",
        adxTrendMin: 28,
        adxRangeMax: 18,
        atrPctLow: 0.0002,
        atrPctHigh: 0.03,
    },
    setup: {
        trendPullbackZonePct: 0.0015,
        maxH1AdxForTrendSetup: 45,
        trendRsiMin: 40,
        trendRsiMax: 60,
        trendEntryMode: "continuation",
        rangeBbPbLow: 0.1,
        rangeBbPbHigh: 0.9,
        rangeRsiLow: 35,
        rangeRsiHigh: 65,
    },
    trigger: {
        displacementAtrMultiplier: 0.9,
        requireDisplacement: true,
        requireStructureBreak: false,
        requireFvg: true,
        useFvgBonus: true,
        invertSignal: false,
        invertSignalH1AdxMin: 0,
    },
    risk: {
        forexRiskPct: 0.05,
        cryptoRiskPct: 0.04,
        rr: 2,
        atrStopMultiplier: 1.2,
        spreadStopMultiplier: 2.5,
        minStopPctForex: 0.00025,
        minStopPctCrypto: 0.003,
        minSize: 0,
        contractPointValue: 1,
    },
    management: {
        breakevenAtR: 1,
        trailMode: "ATR_M5",
        trailAtrMultiplier: 1.0,
        trailOnlyAfterBreakeven: true,
    },
    backtest: {
        slippage: {
            model: "bps",
            entryBpsForex: 0.2,
            exitBpsForex: 0.2,
            entryBpsCrypto: 1.5,
            exitBpsCrypto: 1.5,
        },
        sameBarFillPriority: "STOP_FIRST",
    },
    pairProfiles: {
        JPY_MAJOR_SCALP: {
            context: {
                adxTrendMin: 35,
            },
            trigger: {
                requireDisplacement: false,
            },
        },
        CHF_MAJOR_SCALP: {
            context: {
                adxTrendMin: 35,
            },
            trigger: {
                requireDisplacement: false,
            },
        },
    },
    pairProfileBySymbol: {
        USDJPY: "JPY_MAJOR_SCALP",
        USDCHF: "CHF_MAJOR_SCALP",
    },
    pairOverrides: DEFAULT_PAIR_OVERRIDES,
};

const NESTED_OBJECT_KEYS = [
    "guardrails",
    "intradayOnly",
    "schedule",
    "context",
    "setup",
    "trigger",
    "risk",
    "management",
    "backtest",
    "news",
    "sessionsUtc",
    "symbolSessions",
];

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeIntradayConfig(baseConfig = {}, overrideConfig = {}) {
    const base = isPlainObject(baseConfig) ? baseConfig : {};
    const override = isPlainObject(overrideConfig) ? overrideConfig : {};

    const merged = {
        ...base,
        ...override,
    };

    for (const key of NESTED_OBJECT_KEYS) {
        if (!isPlainObject(base[key]) && !isPlainObject(override[key])) continue;
        merged[key] = {
            ...(isPlainObject(base[key]) ? base[key] : {}),
            ...(isPlainObject(override[key]) ? override[key] : {}),
        };
    }

    const basePairProfileBySymbol = isPlainObject(base.pairProfileBySymbol) ? base.pairProfileBySymbol : {};
    const overridePairProfileBySymbol = isPlainObject(override.pairProfileBySymbol) ? override.pairProfileBySymbol : {};
    merged.pairProfileBySymbol = {
        ...basePairProfileBySymbol,
        ...overridePairProfileBySymbol,
    };

    const basePairOverrides = isPlainObject(base.pairOverrides) ? base.pairOverrides : {};
    const overridePairOverrides = isPlainObject(override.pairOverrides) ? override.pairOverrides : {};
    merged.pairOverrides = {
        ...basePairOverrides,
        ...overridePairOverrides,
    };

    const basePairProfiles = isPlainObject(base.pairProfiles) ? base.pairProfiles : {};
    const overridePairProfiles = isPlainObject(override.pairProfiles) ? override.pairProfiles : {};
    const profileNames = new Set([...Object.keys(basePairProfiles), ...Object.keys(overridePairProfiles)]);
    const mergedPairProfiles = {};
    for (const profileName of profileNames) {
        const baseProfile = isPlainObject(basePairProfiles[profileName]) ? basePairProfiles[profileName] : {};
        const overrideProfile = isPlainObject(overridePairProfiles[profileName]) ? overridePairProfiles[profileName] : {};
        mergedPairProfiles[profileName] = mergeIntradayConfig(baseProfile, overrideProfile);
    }
    merged.pairProfiles = mergedPairProfiles;

    return merged;
}

export function resolveIntradayConfigForSymbol(config = DEFAULT_INTRADAY_CONFIG, symbol = "") {
    const mergedBase = mergeIntradayConfig(DEFAULT_INTRADAY_CONFIG, config);
    const upperSymbol = String(symbol || "").toUpperCase();
    if (!upperSymbol) return mergedBase;

    const profileNameRaw = mergedBase?.pairProfileBySymbol?.[upperSymbol];
    const profileName = typeof profileNameRaw === "string" ? profileNameRaw.trim() : "";
    const profileOverrides = profileName && isPlainObject(mergedBase?.pairProfiles?.[profileName]) ? mergedBase.pairProfiles[profileName] : {};
    const symbolOverrides = isPlainObject(mergedBase?.pairOverrides?.[upperSymbol]) ? mergedBase.pairOverrides[upperSymbol] : {};

    return mergeIntradayConfig(mergeIntradayConfig(mergedBase, profileOverrides), symbolOverrides);
}

export function isCryptoSymbol(symbol) {
    return CRYPTO_SYMBOLS.includes(String(symbol || "").toUpperCase());
}

export function assetClassOfSymbol(symbol) {
    return isCryptoSymbol(symbol) ? "crypto" : "forex";
}
