import { CRYPTO_SYMBOLS } from "../config.js";
import { toUpperSymbolSet } from "../utils/symbols.js";

const CANDLE_LAG_SANITY_MINUTES = {
    m1: { min: -3, max: 20 },
    m5: { min: -10, max: 40 },
    m15: { min: -20, max: 150 },
    h1: { min: -90, max: 400 },
};

const MAX_M1_MID_DEVIATION_PIPS = 8;
const TF_CLOSE_TARGET_LAG_MINUTES = {
    m1: 1.5,
    m5: 7.5,
    m15: 22.5,
    h1: 90,
};
const CRYPTO_SYMBOL_SET = toUpperSymbolSet(CRYPTO_SYMBOLS);

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

function cloneRow(row) {
    if (!row || typeof row !== "object") return row;
    return JSON.parse(JSON.stringify(row));
}

function addShiftedTimestampCandidates(candidates, timestampMs) {
    if (!Number.isFinite(timestampMs)) return;
    candidates.add(timestampMs);
    candidates.add(timestampMs - 60 * 60000);
    candidates.add(timestampMs + 60 * 60000);
    candidates.add(timestampMs - 24 * 60 * 60000);
    candidates.add(timestampMs + 24 * 60 * 60000);
}

function swapMonthDayIso(value) {
    const raw = String(value || "").trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(T.+)$/);
    if (!match) return null;
    const [, year, month, day, rest] = match;
    const monthNum = Number(month);
    const dayNum = Number(day);
    if (!Number.isInteger(monthNum) || !Number.isInteger(dayNum)) return null;
    if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 12) return null;
    return `${year}-${day}-${month}${rest}`;
}

function floorToTimeframeBoundary(tsMs, tf) {
    const date = new Date(tsMs);
    if (!Number.isFinite(date.getTime())) return null;
    date.setUTCSeconds(0, 0);
    if (tf === "m1") return date.getTime();
    if (tf === "m5") {
        date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 5) * 5, 0, 0);
        return date.getTime();
    }
    if (tf === "m15") {
        date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 15) * 15, 0, 0);
        return date.getTime();
    }
    if (tf === "h1") {
        date.setUTCMinutes(0, 0, 0);
        return date.getTime();
    }
    return null;
}

function inferClosedCandleTimestamp(snapshotTs, tf) {
    const boundaryTs = floorToTimeframeBoundary(snapshotTs, tf);
    if (!Number.isFinite(boundaryTs)) return null;
    const tfMinutes = tf === "m1" ? 1 : tf === "m5" ? 5 : tf === "m15" ? 15 : tf === "h1" ? 60 : null;
    if (!Number.isFinite(tfMinutes)) return null;
    return boundaryTs - tfMinutes * 60 * 1000;
}

function scoreLagCandidate(candidateTs, snapshotTs, tf) {
    if (!Number.isFinite(candidateTs) || !Number.isFinite(snapshotTs)) return Number.POSITIVE_INFINITY;
    const bounds = CANDLE_LAG_SANITY_MINUTES[tf];
    if (!bounds) return Number.POSITIVE_INFINITY;
    const lagMinutes = (snapshotTs - candidateTs) / 60000;
    if (lagMinutes < bounds.min || lagMinutes > bounds.max) return Number.POSITIVE_INFINITY;
    const targetLag = TF_CLOSE_TARGET_LAG_MINUTES[tf] ?? 0;
    return Math.abs(lagMinutes - targetLag);
}

function pickBestTimestampCandidate(candidates, snapshotTs, tf) {
    let bestTs = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidateTs of candidates) {
        const score = scoreLagCandidate(candidateTs, snapshotTs, tf);
        if (score < bestScore) {
            bestScore = score;
            bestTs = candidateTs;
        }
    }
    return Number.isFinite(bestTs) ? bestTs : null;
}

export function repairPriceSnapshotRow(row) {
    const snapshotTs = Number.isFinite(row?.tsMs) ? row.tsMs : toTimestampMs(row?.timestamp);
    if (!Number.isFinite(snapshotTs) || !row || typeof row !== "object") {
        return { row, repaired: false, repairedFields: [] };
    }

    const repairedRow = cloneRow(row);
    const repairedFields = [];
    const candles = repairedRow?.candles;
    if (!candles || typeof candles !== "object") {
        return { row: repairedRow, repaired: false, repairedFields };
    }

    for (const tf of Object.keys(CANDLE_LAG_SANITY_MINUTES)) {
        const candle = candles?.[tf];
        if (!candle || typeof candle !== "object") continue;
        const rawValue = candle?.t;
        const candidates = new Set();
        const directTs = toTimestampMs(rawValue);
        addShiftedTimestampCandidates(candidates, directTs);

        const swappedIso = swapMonthDayIso(rawValue);
        const swappedTs = toTimestampMs(swappedIso);
        addShiftedTimestampCandidates(candidates, swappedTs);

        const inferredTs = inferClosedCandleTimestamp(snapshotTs, tf);
        if (Number.isFinite(inferredTs)) {
            candidates.add(inferredTs);
            candidates.add(inferredTs - 60 * 60000);
            candidates.add(inferredTs + 60 * 60000);
        }

        const bestTs = pickBestTimestampCandidate(candidates, snapshotTs, tf);
        if (!Number.isFinite(bestTs)) continue;

        const currentTs = toTimestampMs(rawValue);
        if (!Number.isFinite(currentTs) || currentTs !== bestTs) {
            repairedRow.candles[tf].t = new Date(bestTs).toISOString();
            repairedFields.push(tf);
        }
    }

    return {
        row: repairedRow,
        repaired: repairedFields.length > 0,
        repairedFields,
    };
}

function getPipValue(symbol) {
    return String(symbol || "").toUpperCase().includes("JPY") ? 0.01 : 0.0001;
}

function isForexLikeSymbol(symbol) {
    const upper = String(symbol || "").toUpperCase();
    if (CRYPTO_SYMBOL_SET.has(upper)) return false;
    return /^[A-Z]{6}$/.test(upper);
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
    let repaired = 0;
    const repairedFields = new Map();

    for (const row of rows) {
        const repairedResult = repairPriceSnapshotRow(row);
        const candidateRow = repairedResult.row;
        if (repairedResult.repaired) {
            repaired += 1;
            for (const field of repairedResult.repairedFields) {
                repairedFields.set(field, (repairedFields.get(field) || 0) + 1);
            }
        }
        const sanity = evaluatePriceSnapshotSanity(candidateRow, { symbol });
        if (sanity.ok) {
            validRows.push(candidateRow);
            continue;
        }
        droppedRows.push({ row: candidateRow, reason: sanity.reason, code: sanity.code || "invalid" });
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
            repaired,
            repairedFields: [...repairedFields.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([field, count]) => ({ field, count })),
        },
    };
}
