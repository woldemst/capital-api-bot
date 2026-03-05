const CANDLE_LAG_SANITY_MINUTES = {
    m1: { min: -3, max: 20 },
    m5: { min: -10, max: 40 },
    m15: { min: -20, max: 150 },
    h1: { min: -90, max: 400 },
};

const MAX_M1_MID_DEVIATION_PIPS = 8;

function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function toTimestampMs(value) {
    if (value === null || value === undefined || value === "") return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function getPipValue(symbol) {
    return String(symbol || "").toUpperCase().includes("JPY") ? 0.01 : 0.0001;
}

function isForexLikeSymbol(symbol) {
    return /^[A-Z]{6}$/.test(String(symbol || "").toUpperCase());
}

export function evaluatePriceSnapshotSanity(row, { symbol = "" } = {}) {
    const snapshotTs = Number.isFinite(row?.tsMs) ? row.tsMs : toTimestampMs(row?.timestamp);
    if (!Number.isFinite(snapshotTs)) {
        return { ok: false, reason: "invalid_snapshot_timestamp" };
    }

    const lagIssues = [];
    for (const [tf, bounds] of Object.entries(CANDLE_LAG_SANITY_MINUTES)) {
        const candleTs = toTimestampMs(row?.candles?.[tf]?.t);
        if (!Number.isFinite(candleTs)) {
            lagIssues.push(`${tf}:missing_or_invalid`);
            continue;
        }
        const lagMinutes = (snapshotTs - candleTs) / 60000;
        if (lagMinutes < bounds.min || lagMinutes > bounds.max) {
            lagIssues.push(`${tf}:lag=${lagMinutes.toFixed(2)}m`);
        }
    }
    if (lagIssues.length) {
        return { ok: false, reason: lagIssues.join(", "), code: "candle_lag" };
    }

    const checks = [];
    const bid = toNumber(row?.bid);
    const ask = toNumber(row?.ask);
    const mid = toNumber(row?.mid);
    const m1Close = toNumber(row?.candles?.m1?.c ?? row?.indicators?.m1?.close ?? row?.indicators?.m1?.lastClose);

    if (Number.isFinite(bid) && Number.isFinite(ask) && ask < bid) checks.push("ask_below_bid");
    if (Number.isFinite(mid) && Number.isFinite(bid) && Number.isFinite(ask) && (mid < bid || mid > ask)) checks.push("mid_outside_bid_ask");

    if (isForexLikeSymbol(symbol) && Number.isFinite(mid) && Number.isFinite(m1Close)) {
        const pipValue = getPipValue(symbol);
        const driftPips = pipValue > 0 ? Math.abs(mid - m1Close) / pipValue : null;
        if (Number.isFinite(driftPips) && driftPips > MAX_M1_MID_DEVIATION_PIPS) {
            checks.push(`m1_mid_drift_${driftPips.toFixed(2)}pip`);
        }
    }

    if (checks.length) {
        return { ok: false, reason: checks.join(", "), code: "market_price" };
    }

    return { ok: true, reason: "", code: "ok" };
}

export function sanitizePriceSnapshotRows(rows = [], { symbol = "", minValidRatio = 0 } = {}) {
    const validRows = [];
    const droppedRows = [];
    const droppedByCode = new Map();

    for (const row of rows) {
        const sanity = evaluatePriceSnapshotSanity(row, { symbol });
        if (sanity.ok) {
            validRows.push(row);
            continue;
        }
        droppedRows.push({ row, reason: sanity.reason, code: sanity.code || "invalid" });
        const codeKey = sanity.code || "invalid";
        droppedByCode.set(codeKey, (droppedByCode.get(codeKey) || 0) + 1);
    }

    const total = rows.length;
    const valid = validRows.length;
    const dropped = droppedRows.length;
    const validRatio = total > 0 ? valid / total : 1;
    const skipFile = total > 0 && validRatio < minValidRatio;

    return {
        validRows: skipFile ? [] : validRows,
        droppedRows,
        stats: {
            total,
            valid,
            dropped,
            validRatio,
            skipFile,
            droppedByCode: [...droppedByCode.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([code, count]) => ({ code, count })),
        },
    };
}
