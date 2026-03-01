export const SESSION_SYMBOLS = {
    LONDON: ["EURJPY", "USDJPY", "EURUSD", "GBPUSD", "EURGBP"],
    NY: ["USDJPY", "EURJPY", "EURUSD", "GBPUSD", "USDCAD"],
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
        adxTrendMin: 32,
        adxRangeMax: 18,
        atrPctLow: 0.0002,
        atrPctHigh: 0.03,
    },
    setup: {
        trendPullbackZonePct: 0.0015,
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
        requireStructureBreak: true,
        useFvgBonus: true,
        invertSignal: false,
        invertSignalH1AdxMin: 0,
    },
    risk: {
        forexRiskPct: 0.005,
        cryptoRiskPct: 0.004,
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
};

export function isCryptoSymbol(symbol) {
    return CRYPTO_SYMBOLS.includes(String(symbol || "").toUpperCase());
}

export function assetClassOfSymbol(symbol) {
    return isCryptoSymbol(symbol) ? "crypto" : "forex";
}
