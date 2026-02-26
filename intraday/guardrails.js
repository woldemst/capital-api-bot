import { DEFAULT_INTRADAY_CONFIG, NEWS_MODE } from "./config.js";

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function evaluateGuardrails(input, config = DEFAULT_INTRADAY_CONFIG) {
    const state = input?.state || {};
    const snapshot = input?.snapshot || {};
    const step1 = input?.step1 || {};
    const step2 = input?.step2 || {};
    const step3 = input?.step3 || {};
    const step4 = input?.step4 || {};
    const side = String(input?.side || step4.side || step3.side || "").toUpperCase();
    const guardrails = config.guardrails || {};

    const checks = {
        symbolAllowed: Boolean(step1.symbolAllowed),
        notPastCutoff: !Boolean(step1.forceFlatNow),
        triggerConfirmed: Boolean(step4.triggerOk),
        maxTradesPerDay: (state.dailyTradeCount || 0) < Number(guardrails.maxTradesPerDay || 15),
        duplicateSymbol: true,
        newsMode: true,
        sentimentCrowded: true,
        rangeContrarian: true,
    };

    const symbolKey = String(snapshot?.symbol || input?.symbol || "").toUpperCase();
    if (guardrails.blockDuplicateSymbolEntries && state?.openPositions instanceof Map) {
        checks.duplicateSymbol = !state.openPositions.has(symbolKey);
    }

    const newsMode = String(guardrails.newsMode || NEWS_MODE.AVOID).toUpperCase();
    const newsWindowActive = Boolean(snapshot?.newsWindowActive ?? snapshot?.newsBlocked);
    if (newsWindowActive) {
        if (newsMode === NEWS_MODE.AVOID) {
            checks.newsMode = false;
        } else if (newsMode === NEWS_MODE.TRADE) {
            const allowedNewsSetupTypes = new Set(guardrails.newsStrategySetupTypes || []);
            checks.newsMode = allowedNewsSetupTypes.has(step3.setupType);
        }
    }

    const sentiment = input?.sentiment || snapshot?.sentiment || {};
    const clientLongPct = toNum(sentiment.clientLongPct);
    const clientShortPct = toNum(sentiment.clientShortPct);
    const crowdedThreshold = Number(guardrails.sentimentCrowdedThreshold || 0.78);
    if (step2.regimeType === "TREND" && side === "LONG" && Number.isFinite(clientLongPct) && clientLongPct >= crowdedThreshold) {
        checks.sentimentCrowded = false;
    }
    if (step2.regimeType === "TREND" && side === "SHORT" && Number.isFinite(clientShortPct) && clientShortPct >= crowdedThreshold) {
        checks.sentimentCrowded = false;
    }

    const isRangeContrarian = step2.regimeType === "RANGE" && step3.setupType === "RANGE_REVERSION";
    if (isRangeContrarian && !guardrails.allowRangeContrarian) {
        checks.rangeContrarian = false;
    }

    const blockReasons = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([key]) => key);

    return {
        allowed: blockReasons.length === 0,
        blockReasons,
        checks,
        logFields: {
            guardrailsAllowed: blockReasons.length === 0,
            guardrailBlockReasons: blockReasons,
            clientLongPct,
            clientShortPct,
            dailyTradeCount: state.dailyTradeCount || 0,
        },
    };
}

