export const SESSION_SYMBOLS = {
    LONDON: ["EURJPY", "USDJPY", "EURUSD", "GBPUSD", "EURGBP", "USDCHF"],
    NY: ["USDJPY", "EURJPY", "EURUSD", "GBPUSD", "USDCAD", "USDCHF"],
    SYDNEY: ["EURJPY", "USDJPY", "AUDUSD", "AUDJPY"],
    TOKYO: ["EURJPY", "USDJPY", "AUDUSD", "AUDJPY"],
};

export const CRYPTO_SYMBOLS = ["BTCUSD", "SOLUSD", "XRPUSD", "DOGEUSD", "ETHUSD"];

export const NEWS_MODE = {
    AVOID: "AVOID",
    TRADE: "TRADE",
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
    intradayOnly: {
        flatPositionsCutoffUtcForex: { hour: 20, minute: 55 },
        flatPositionsCutoffUtcCrypto: { hour: 23, minute: 55 },
        cryptoDayBoundaryExit: true,
    },
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
    pairOverrides: {},
};

const NESTED_OBJECT_KEYS = ["guardrails", "intradayOnly", "context", "setup", "trigger", "risk", "management", "backtest", "news", "sessionsUtc"];

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
