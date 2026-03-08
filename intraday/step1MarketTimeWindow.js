import { CRYPTO_SYMBOLS, DEFAULT_INTRADAY_CONFIG, SESSION_SYMBOLS, assetClassOfSymbol } from "./config.js";

export const STEP1_NAME = "MARKET_TIME_WINDOW";

function toUtcDate(nowUtc) {
    return nowUtc instanceof Date ? nowUtc : new Date(nowUtc);
}

function minutesOfDayUtc(date) {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function parseHm(hm) {
    const [h, m] = String(hm || "").split(":").map((x) => Number.parseInt(x, 10));
    return { h, m };
}

function inWindow(currentMin, startMin, endMin) {
    if (startMin <= endMin) return currentMin >= startMin && currentMin <= endMin;
    return currentMin >= startMin || currentMin <= endMin;
}

export function determineActiveSessions(nowUtc, config = DEFAULT_INTRADAY_CONFIG) {
    const date = toUtcDate(nowUtc);
    const currentMin = minutesOfDayUtc(date);
    const active = [];

    for (const [session, win] of Object.entries(config.sessionsUtc || {})) {
        const { h: sh, m: sm } = parseHm(win.start);
        const { h: eh, m: em } = parseHm(win.end);
        if (![sh, sm, eh, em].every(Number.isFinite)) continue;
        const startMin = sh * 60 + sm;
        const endMin = eh * 60 + em;
        if (inWindow(currentMin, startMin, endMin)) active.push(session);
    }

    return active;
}

export function determineActiveSession(nowUtc, config = DEFAULT_INTRADAY_CONFIG) {
    const active = determineActiveSessions(nowUtc, config);
    if (!active.length) return null;
    const priority = Array.isArray(config.sessionPriority) ? config.sessionPriority : ["NY", "LONDON", "TOKYO", "SYDNEY"];
    for (const session of priority) {
        if (active.includes(session)) return session;
    }
    return active[0];
}

export function allowedSymbolsBySession(session) {
    const key = String(session || "").toUpperCase();
    return [...(SESSION_SYMBOLS[key] || [])];
}

function preferredSessionsForSymbol(symbol, config = DEFAULT_INTRADAY_CONFIG) {
    const key = String(symbol || "").toUpperCase();
    if (!key) return null;
    const sessions = config?.symbolSessions?.[key];
    if (!Array.isArray(sessions)) return null;
    return sessions.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean);
}

function cutoffMinutes(cutoff) {
    const hour = Number(cutoff?.hour);
    const minute = Number(cutoff?.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
}

function utcHourBucket(nowUtc) {
    const date = toUtcDate(nowUtc);
    const hour = date.getUTCHours();
    if (hour < 6) return "00-05";
    if (hour < 12) return "06-11";
    if (hour < 18) return "12-17";
    return "18-23";
}

function normalizedBucketList(value) {
    if (!Array.isArray(value)) return [];
    return value.map((bucket) => String(bucket || "").trim()).filter(Boolean);
}

export function isPastFlatPositionsCutoff(nowUtc, assetClass, config = DEFAULT_INTRADAY_CONFIG) {
    const date = toUtcDate(nowUtc);
    const currentMin = minutesOfDayUtc(date);
    const intradayOnly = config.intradayOnly || {};
    const selected = assetClass === "crypto" ? intradayOnly.flatPositionsCutoffUtcCrypto : intradayOnly.flatPositionsCutoffUtcForex;
    const cutoffMin = cutoffMinutes(selected);
    if (!Number.isFinite(cutoffMin)) return false;
    if (assetClass === "forex") {
        const windowMinutes = Number(intradayOnly.flatPositionsCutoffWindowMinutesForex || 65);
        if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return currentMin >= cutoffMin;
        const windowEndMin = (cutoffMin + windowMinutes) % 1440;
        return inWindow(currentMin, cutoffMin, windowEndMin);
    }
    return currentMin >= cutoffMin;
}

export function step1MarketTimeWindow(input, config = DEFAULT_INTRADAY_CONFIG) {
    const nowUtc = toUtcDate(input?.nowUtc || Date.now());
    const symbol = String(input?.symbol || "").toUpperCase();
    const assetClass = assetClassOfSymbol(symbol);
    const hourBucket = utcHourBucket(nowUtc);
    const activeSessions = determineActiveSessions(nowUtc, config);
    const activeSession = determineActiveSession(nowUtc, config);
    const sessionAllowedSymbols = activeSession ? allowedSymbolsBySession(activeSession) : [];
    const preferredSymbolSessions = preferredSessionsForSymbol(symbol, config);
    const allowedHourBuckets = normalizedBucketList(config?.schedule?.allowedUtcHourBuckets);
    const blockedHourBuckets = normalizedBucketList(config?.schedule?.blockedUtcHourBuckets);
    const hourAllowed =
        (!allowedHourBuckets.length || allowedHourBuckets.includes(hourBucket)) &&
        !blockedHourBuckets.includes(hourBucket);
    const sessionAllowedBySymbolFilter = !preferredSymbolSessions || (activeSession ? preferredSymbolSessions.includes(activeSession) : false);
    const allowedSymbols = [...new Set([...sessionAllowedSymbols, ...CRYPTO_SYMBOLS])];
    const symbolAllowed =
        assetClass === "crypto"
            ? CRYPTO_SYMBOLS.includes(symbol) && sessionAllowedBySymbolFilter && hourAllowed
            : sessionAllowedSymbols.includes(symbol) && sessionAllowedBySymbolFilter && hourAllowed;
    const forceFlatNow = isPastFlatPositionsCutoff(nowUtc, assetClass, config);

    const reasons = [];
    reasons.push(`session=${activeSession || "NONE"}`);
    if (activeSessions.length > 1) reasons.push(`overlap=${activeSessions.join("+")}`);
    if (!symbolAllowed) reasons.push("symbol_not_in_active_universe");
    if (preferredSymbolSessions && !sessionAllowedBySymbolFilter) reasons.push("symbol_session_filtered");
    if (!hourAllowed) reasons.push("hour_bucket_filtered");
    if (forceFlatNow) reasons.push("past_intraday_cutoff");

    const output = {
        step: 1,
        stepName: STEP1_NAME,
        nowUtc: nowUtc.toISOString(),
        symbol,
        assetClass,
        activeSessions,
        activeSession,
        sessionAllowedSymbols,
        allowedSymbols,
        symbolAllowed,
        intradayOnly: true,
        forceFlatNow,
        hourBucketUtc: hourBucket,
        flatCutoffUtc:
            assetClass === "crypto"
                ? config.intradayOnly?.flatPositionsCutoffUtcCrypto || null
                : config.intradayOnly?.flatPositionsCutoffUtcForex || null,
        step1Reasons: reasons,
        logFields: {
            session: activeSession,
            activeSessions,
            symbolAllowed,
            preferredSymbolSessions: preferredSymbolSessions || null,
            hourBucketUtc: hourBucket,
            allowedHourBuckets: allowedHourBuckets.length ? allowedHourBuckets : null,
            blockedHourBuckets: blockedHourBuckets.length ? blockedHourBuckets : null,
            forceFlatNow,
            assetClass,
        },
    };

    return output;
}
