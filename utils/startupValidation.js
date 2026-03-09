import { getAccountInfo, getMarketDetails } from "../api.js";

function toFiniteNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? num : null;
}

function sanitizeCurrencyCode(value) {
    const raw = String(value || "").trim().toUpperCase();
    const match = raw.match(/[A-Z]{3}/);
    return match ? match[0] : null;
}

export function normalizeSymbols(symbols = []) {
    const normalized = [];
    for (const rawSymbol of Array.isArray(symbols) ? symbols : []) {
        const symbol = String(rawSymbol || "").trim().toUpperCase();
        if (symbol) normalized.push(symbol);
    }
    return [...new Set(normalized)];
}

export function collectConfiguredSessionSymbols(sessions = {}) {
    const set = new Set();
    for (const session of Object.values(sessions || {})) {
        for (const rawSymbol of session?.SYMBOLS || []) {
            const symbol = String(rawSymbol || "").trim().toUpperCase();
            if (symbol) set.add(symbol);
        }
    }
    return [...set].sort();
}

export function deriveApiEnvironment(baseUrl = "") {
    const raw = String(baseUrl || "").trim().toLowerCase();
    if (!raw) return "UNKNOWN";
    if (raw.includes("demo")) return "DEMO";
    if (raw.includes("backend-capital.com")) return "LIVE";
    return "UNKNOWN";
}

function isValidForexWindow(window) {
    const start = toFiniteNumber(window?.start);
    const end = toFiniteNumber(window?.end);
    return Number.isFinite(start) && Number.isFinite(end);
}

export function validateStartupConfig({
    api = {},
    liveSymbols = [],
    sessions = {},
    tradingWindows = {},
    newsGuard = {},
    env = process.env,
} = {}) {
    const errors = [];
    const warnings = [];
    const normalizedLiveSymbols = normalizeSymbols(liveSymbols);
    const configuredSessionSymbols = collectConfiguredSessionSymbols(sessions);
    const configuredSessionSet = new Set(configuredSessionSymbols);
    const apiBaseUrl = String(api?.BASE_URL || "").trim();
    const environment = deriveApiEnvironment(apiBaseUrl);

    if (!String(api?.KEY || "").trim()) errors.push("API_KEY fehlt.");
    if (!String(api?.IDENTIFIER || "").trim()) errors.push("API_IDENTIFIER fehlt.");
    if (!String(api?.PASSWORD || "").trim()) errors.push("API_PASSWORD fehlt.");
    if (!apiBaseUrl) {
        errors.push("BASE_URL/API_PATH fehlt.");
    } else {
        try {
            // Validate the fully composed API URL early to avoid partial live starts.
            new URL(apiBaseUrl);
        } catch {
            errors.push(`API-URL ist ungueltig: ${apiBaseUrl}`);
        }
    }

    if (!normalizedLiveSymbols.length) errors.push("LIVE_SYMBOLS ist leer.");
    if (!configuredSessionSymbols.length) errors.push("SESSIONS enthaelt keine konfigurierten Symbole.");

    const unsupportedLiveSymbols = normalizedLiveSymbols.filter((symbol) => !configuredSessionSet.has(symbol));
    if (unsupportedLiveSymbols.length) {
        errors.push(`LIVE_SYMBOLS nicht in SESSIONS enthalten: ${unsupportedLiveSymbols.join(", ")}`);
    }

    const forexWindows = Array.isArray(tradingWindows?.FOREX) ? tradingWindows.FOREX : [];
    if (!forexWindows.length) {
        errors.push("TRADING_WINDOWS.FOREX ist leer.");
    } else if (!forexWindows.every(isValidForexWindow)) {
        errors.push("TRADING_WINDOWS.FOREX enthaelt ungueltige Zeitfenster.");
    }

    if (environment === "UNKNOWN") {
        warnings.push(`API-Umgebung konnte nicht sicher erkannt werden: ${apiBaseUrl}`);
    }

    if (newsGuard?.ENABLED && !Boolean(newsGuard?.FOREX_ONLY)) {
        warnings.push("NEWS_GUARD ist aktiv, aber nicht auf Forex begrenzt.");
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        environment,
        apiBaseUrl,
        liveSymbols: normalizedLiveSymbols,
        configuredSessionSymbols,
        forexWindowCount: forexWindows.length,
    };
}

export function formatStartupValidation(result) {
    const parts = [];
    if (result?.errors?.length) parts.push(`errors=${result.errors.join(" | ")}`);
    if (result?.warnings?.length) parts.push(`warnings=${result.warnings.join(" | ")}`);
    parts.push(`environment=${result?.environment || "UNKNOWN"}`);
    parts.push(`symbols=${(result?.liveSymbols || []).join(",") || "none"}`);
    return parts.join(" || ");
}

export function assertStartupConfig(result) {
    if (result?.ok) return result;
    throw new Error(formatStartupValidation(result));
}

function selectPrimaryAccount(accounts = []) {
    const rows = Array.isArray(accounts) ? accounts : [];
    return rows.find((account) => account?.preferred) || rows[0] || null;
}

export async function runBrokerPreflight({ symbols = [] } = {}) {
    const normalizedSymbols = normalizeSymbols(symbols);
    const accountData = await getAccountInfo();
    const accounts = Array.isArray(accountData?.accounts) ? accountData.accounts : [];
    const primaryAccount = selectPrimaryAccount(accounts);

    if (!primaryAccount) {
        throw new Error("Broker-Preflight fehlgeschlagen: keine Accounts vom Broker erhalten.");
    }

    const balance = toFiniteNumber(primaryAccount?.balance?.balance);
    const available = toFiniteNumber(primaryAccount?.balance?.available);
    const currency = sanitizeCurrencyCode(primaryAccount?.currency);

    if (!Number.isFinite(balance)) {
        throw new Error("Broker-Preflight fehlgeschlagen: Account-Balance ist ungueltig.");
    }
    if (!Number.isFinite(available)) {
        throw new Error("Broker-Preflight fehlgeschlagen: Available Margin ist ungueltig.");
    }
    if (!currency) {
        throw new Error("Broker-Preflight fehlgeschlagen: Account-Waehrung fehlt.");
    }

    const symbolChecks = [];
    const warnings = [];
    for (const symbol of normalizedSymbols) {
        const details = await getMarketDetails(symbol);
        const resolvedSymbol = String(details?.instrument?.symbol || details?.instrument?.epic || symbol).trim().toUpperCase();
        const bid = toFiniteNumber(details?.snapshot?.bid);
        const ask = toFiniteNumber(details?.snapshot?.offer ?? details?.snapshot?.ask);
        const minDealSize = toFiniteNumber(details?.dealingRules?.minDealSize?.value ?? details?.instrument?.minDealSize);
        const marketStatus = String(details?.snapshot?.marketStatus || details?.instrument?.marketStatus || "UNKNOWN").trim().toUpperCase();

        if (!details?.instrument) {
            throw new Error(`Broker-Preflight fehlgeschlagen: keine Instrumentdaten fuer ${symbol}.`);
        }
        if (!resolvedSymbol) {
            throw new Error(`Broker-Preflight fehlgeschlagen: Symbolauflösung fuer ${symbol} fehlgeschlagen.`);
        }
        if (!Number.isFinite(minDealSize) || minDealSize <= 0) {
            throw new Error(`Broker-Preflight fehlgeschlagen: minDealSize fuer ${symbol} ist ungueltig.`);
        }
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
            warnings.push(`${symbol}: keine vollstaendigen Bid/Ask-Snapshotpreise`);
        }

        symbolChecks.push({
            symbol,
            resolvedSymbol,
            marketStatus,
            bid,
            ask,
            minDealSize,
        });
    }

    return {
        checkedAt: new Date().toISOString(),
        account: {
            accountId: primaryAccount?.accountId || null,
            accountName: primaryAccount?.accountName || primaryAccount?.name || null,
            currency,
            balance,
            available,
        },
        symbols: symbolChecks,
        warnings,
    };
}
