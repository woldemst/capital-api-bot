import fs from "fs";
import path from "path";
import { getHistorical, getMarketDetails } from "../api.js";
import { calcIndicators } from "../indicators/indicators.js";
import { ANALYSIS, SESSIONS, CRYPTO_SYMBOLS, NEWS_GUARD } from "../config.js";
import logger from "./logger.js";

const { TIMEFRAMES } = ANALYSIS;
const LOG_DIR = path.join(process.cwd(), "backtest", "prices");
const CANDLE_LAG_SANITY_MINUTES = {
    m1: { min: -3, max: 20 },
    m5: { min: -10, max: 40 },
    m15: { min: -20, max: 150 },
    h1: { min: -90, max: 400 },
};
const MAX_M1_MID_DEVIATION_PIPS = 8;
const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000;

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function sanitizeSymbol(symbol = "unknown") {
    return String(symbol || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function compactIndicators(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return snapshot;
    return JSON.parse(JSON.stringify(snapshot));
}

export function getSymbolLogPath(symbol = "unknown") {
    ensureLogDir();
    return path.join(LOG_DIR, `${sanitizeSymbol(symbol)}.jsonl`);
}

function appendLine(logPath, payload) {
    ensureLogDir();
    fs.appendFileSync(logPath, JSON.stringify(payload) + "\n");
}

class PriceLogger {
    constructor() {
        this.historyLength = 200;
        this.requestDelayMs = 250;
        this.symbolDelayMs = 1000;
        this.lastWrittenTsMsBySymbol = new Map();
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    toNumber(value) {
        if (value === undefined || value === null || value === "") return null;
        const num = typeof value === "number" ? value : Number(value);
        return Number.isFinite(num) ? num : null;
    }

    parseIsoNoZoneAsUtc(raw) {
        const isoNoZone = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
        if (!isoNoZone) return null;
        const [, y, m, d, hh, mm, ss = "00", frac = ""] = isoNoZone;
        const ms = frac ? Number(String(frac).slice(0, 3).padEnd(3, "0")) : 0;
        const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss), ms));
        return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
    }

    toTimestampMs(value) {
        if (value === undefined || value === null || value === "") return null;
        if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
        if (typeof value === "number") {
            const dt = new Date(value);
            return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
        }

        const raw = String(value).trim();
        if (!raw) return null;

        const hasExplicitZone = /(?:Z|[+\-]\d{2}:?\d{2})$/i.test(raw);
        if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && !hasExplicitZone) {
            const isoNoZoneTs = this.parseIsoNoZoneAsUtc(raw);
            if (Number.isFinite(isoNoZoneTs)) return isoNoZoneTs;
        }

        const ymdUtc = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
        if (ymdUtc) {
            const [, y, m, d, hh, mm, ss = "00", frac = ""] = ymdUtc;
            const ms = frac ? Number(String(frac).slice(0, 3).padEnd(3, "0")) : 0;
            const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss), ms));
            if (Number.isFinite(dt.getTime())) return dt.getTime();
        }

        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }

    toIsoTimestamp(value) {
        const tsMs = this.toTimestampMs(value);
        return Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null;
    }

    toTimestampMsLocalNoZone(value) {
        if (value === undefined || value === null || value === "") return null;
        if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
        if (typeof value === "number") {
            const dt = new Date(value);
            return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
        }
        const raw = String(value).trim();
        if (!raw) return null;
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }

    toIsoTimestampLocalNoZone(value) {
        const tsMs = this.toTimestampMsLocalNoZone(value);
        return Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null;
    }

    chooseTimestampClosestToReference(candidatesMs = [], referenceMs = null) {
        const finite = [...new Set(candidatesMs.filter((v) => Number.isFinite(v)))];
        if (!finite.length) return null;
        if (!Number.isFinite(referenceMs)) return finite[0];
        let best = finite[0];
        let bestDistance = Math.abs(best - referenceMs);
        for (let i = 1; i < finite.length; i += 1) {
            const candidate = finite[i];
            const distance = Math.abs(candidate - referenceMs);
            if (distance < bestDistance) {
                best = candidate;
                bestDistance = distance;
            }
        }
        return best;
    }

    normalizeHistoricalCandles(candles = []) {
        if (!Array.isArray(candles) || candles.length === 0) return [];
        const byTimestamp = new Map();
        for (const candle of candles) {
            const tsMs = this.toTimestampMs(candle?.timestamp ?? candle?.snapshotTimeUTC ?? candle?.snapshotTime ?? candle?.t);
            const open = this.toNumber(candle?.open ?? candle?.openPrice?.bid ?? candle?.openPrice?.ask ?? candle?.o);
            const high = this.toNumber(candle?.high ?? candle?.highPrice?.bid ?? candle?.highPrice?.ask ?? candle?.h);
            const low = this.toNumber(candle?.low ?? candle?.lowPrice?.bid ?? candle?.lowPrice?.ask ?? candle?.l);
            const close = this.toNumber(candle?.close ?? candle?.closePrice?.bid ?? candle?.closePrice?.ask ?? candle?.c);
            if (!Number.isFinite(tsMs)) continue;
            if (![open, high, low, close].every(Number.isFinite)) continue;
            byTimestamp.set(tsMs, {
                timestamp: new Date(tsMs).toISOString(),
                timestampMs: tsMs,
                open,
                high,
                low,
                close,
            });
        }
        return [...byTimestamp.values()].sort((a, b) => a.timestampMs - b.timestampMs);
    }

    getLastClosedCandle(candles = []) {
        if (!Array.isArray(candles) || candles.length === 0) return null;
        // Use the penultimate candle as a safe "last closed" candidate.
        const candle = candles.length > 1 ? candles[candles.length - 2] : candles[candles.length - 1];
        return {
            t: this.toIsoTimestamp(candle?.timestamp ?? candle?.snapshotTime ?? candle?.snapshotTimeUTC ?? candle?.t),
            o: this.toNumber(candle?.open ?? candle?.openPrice?.bid ?? candle?.openPrice?.ask ?? candle?.o),
            h: this.toNumber(candle?.high ?? candle?.highPrice?.bid ?? candle?.highPrice?.ask ?? candle?.h),
            l: this.toNumber(candle?.low ?? candle?.lowPrice?.bid ?? candle?.lowPrice?.ask ?? candle?.l),
            c: this.toNumber(candle?.close ?? candle?.closePrice?.bid ?? candle?.closePrice?.ask ?? candle?.c),
        };
    }

    getPipValue(symbol) {
        return String(symbol || "").toUpperCase().includes("JPY") ? 0.01 : 0.0001;
    }

    getActiveSessionsUtc(at = new Date()) {
        const now = at instanceof Date ? at : new Date(at);
        const hour = now.getUTCHours();
        const minute = now.getUTCMinutes();
        const currentMinutes = hour * 60 + minute;

        const sessions = [];
        for (const [name, win] of Object.entries(SESSIONS)) {
            if (!win?.START || !win?.END) continue;
            const [sh, sm] = win.START.split(":").map((v) => parseInt(v, 10));
            const [eh, em] = win.END.split(":").map((v) => parseInt(v, 10));
            if (!Number.isFinite(sh) || !Number.isFinite(sm) || !Number.isFinite(eh) || !Number.isFinite(em)) continue;
            const start = sh * 60 + sm;
            const end = eh * 60 + em;
            const active = start <= end ? currentMinutes >= start && currentMinutes <= end : currentMinutes >= start || currentMinutes <= end;
            if (active) sessions.push(name);
        }
        return sessions;
    }

    resolveSnapshotTimestamp({ marketTimestamp, candles }) {
        const marketTsMs = this.toTimestampMs(marketTimestamp);
        const m1TsMs = this.toTimestampMs(candles?.m1?.t);
        const lagOk = (candidateTsMs) => {
            if (!Number.isFinite(candidateTsMs) || !Number.isFinite(m1TsMs)) return false;
            const lagMinutes = (candidateTsMs - m1TsMs) / 60000;
            const bounds = CANDLE_LAG_SANITY_MINUTES.m1;
            return lagMinutes >= bounds.min && lagMinutes <= bounds.max;
        };

        if (Number.isFinite(m1TsMs)) {
            if (lagOk(marketTsMs)) {
                return new Date(marketTsMs).toISOString();
            }
            // Handle APIs that may return local clock fields without timezone suffix.
            const shiftedByHourCandidates = [marketTsMs - 60 * 60000, marketTsMs + 60 * 60000];
            for (const shiftedTsMs of shiftedByHourCandidates) {
                if (lagOk(shiftedTsMs)) {
                    return new Date(shiftedTsMs).toISOString();
                }
            }
            return new Date(m1TsMs).toISOString();
        }

        if (Number.isFinite(marketTsMs)) return new Date(marketTsMs).toISOString();
        return new Date().toISOString();
    }

    getLastWrittenTimestampMs(symbol) {
        const symbolKey = String(symbol || "").toUpperCase();
        if (this.lastWrittenTsMsBySymbol.has(symbolKey)) {
            return this.lastWrittenTsMsBySymbol.get(symbolKey);
        }

        let lastTsMs = null;
        const logPath = getSymbolLogPath(symbol);
        try {
            if (fs.existsSync(logPath)) {
                const content = fs.readFileSync(logPath, "utf8");
                const lines = content.split(/\r?\n/).filter(Boolean);
                for (let i = lines.length - 1; i >= 0; i -= 1) {
                    try {
                        const row = JSON.parse(lines[i]);
                        const tsMs = this.toTimestampMs(row?.timestamp);
                        if (Number.isFinite(tsMs)) {
                            lastTsMs = tsMs;
                            break;
                        }
                    } catch {
                        // skip malformed line
                    }
                }
            }
        } catch {
            // ignore file parsing issues; logger will continue with in-memory monotonic tracking
        }

        if (Number.isFinite(lastTsMs) && lastTsMs > Date.now() + FUTURE_TS_TOLERANCE_MS) {
            const rotated = this.rotateFutureTimestampLog({
                symbol: symbolKey,
                logPath,
                futureTsMs: lastTsMs,
            });
            if (rotated) {
                lastTsMs = null;
            }
        }

        this.lastWrittenTsMsBySymbol.set(symbolKey, lastTsMs);
        return lastTsMs;
    }

    rotateFutureTimestampLog({ symbol, logPath, futureTsMs }) {
        if (!logPath || !fs.existsSync(logPath)) return false;
        const safeStamp = new Date().toISOString().replace(/[:.]/g, "-");
        const rotatedPath = `${logPath}.future-ts-${safeStamp}.bak`;
        try {
            fs.renameSync(logPath, rotatedPath);
            logger.warn(
                `[PriceLogger] Rotated ${symbol} log due to future tail timestamp ${new Date(futureTsMs).toISOString()} -> ${rotatedPath}`,
            );
            return true;
        } catch (error) {
            logger.warn(
                `[PriceLogger] Failed to rotate ${symbol} log with future tail timestamp ${new Date(futureTsMs).toISOString()}: ${error.message}`,
            );
            return false;
        }
    }

    canAppendMonotonic(symbol, timestampValue) {
        const symbolKey = String(symbol || "").toUpperCase();
        const tsMs = this.toTimestampMs(timestampValue);
        if (!Number.isFinite(tsMs)) {
            return { ok: false, tsMs: null, reason: "invalid_timestamp" };
        }
        const lastTsMs = this.getLastWrittenTimestampMs(symbol);
        if (Number.isFinite(lastTsMs) && lastTsMs > Date.now() + FUTURE_TS_TOLERANCE_MS) {
            this.lastWrittenTsMsBySymbol.set(symbolKey, null);
            return { ok: true, tsMs, reason: "reset_future_tail_timestamp" };
        }
        if (Number.isFinite(lastTsMs) && tsMs <= lastTsMs) {
            return {
                ok: false,
                tsMs,
                reason: `non_monotonic current=${new Date(tsMs).toISOString()} last=${new Date(lastTsMs).toISOString()}`,
            };
        }
        return { ok: true, tsMs, reason: "" };
    }

    markTimestampWritten(symbol, tsMs) {
        if (!Number.isFinite(tsMs)) return;
        const symbolKey = String(symbol || "").toUpperCase();
        this.lastWrittenTsMsBySymbol.set(symbolKey, tsMs);
    }

    async fetchAllCandles(symbol, timeframes, historyLength) {
        try {
            const h1Data = await getHistorical(symbol, timeframes.H1, historyLength);
            await this.sleep(this.requestDelayMs);
            const m15Data = await getHistorical(symbol, timeframes.M15, historyLength);
            await this.sleep(this.requestDelayMs);
            const m5Data = await getHistorical(symbol, timeframes.M5, historyLength);
            await this.sleep(this.requestDelayMs);
            const m1Data = await getHistorical(symbol, timeframes.M1, historyLength);
            return { h1Data, m15Data, m5Data, m1Data };
        } catch (error) {
            logger.warn(`[PriceLogger] Candle fetch failed for ${symbol}: ${error.message}`);
            return {};
        }
    }

    async buildIndicatorsSnapshot(symbol) {
        const { h1Data, m15Data, m5Data, m1Data } = await this.fetchAllCandles(symbol, TIMEFRAMES, this.historyLength);
        const h1Candles = this.normalizeHistoricalCandles(h1Data?.prices?.slice(-this.historyLength) || []);
        const m15Candles = this.normalizeHistoricalCandles(m15Data?.prices?.slice(-this.historyLength) || []);
        const m5Candles = this.normalizeHistoricalCandles(m5Data?.prices?.slice(-this.historyLength) || []);
        const m1Candles = this.normalizeHistoricalCandles(m1Data?.prices?.slice(-this.historyLength) || []);

        if (!h1Candles.length || !m15Candles.length || !m5Candles.length || !m1Candles.length) {
            return null;
        }

        const indicators = {
            h1: await calcIndicators(h1Candles, symbol, TIMEFRAMES.H1),
            m15: await calcIndicators(m15Candles, symbol, TIMEFRAMES.M15),
            m5: await calcIndicators(m5Candles, symbol, TIMEFRAMES.M5),
            m1: await calcIndicators(m1Candles, symbol, TIMEFRAMES.M1),
        };

        const candles = {
            h1: this.getLastClosedCandle(h1Candles),
            m15: this.getLastClosedCandle(m15Candles),
            m5: this.getLastClosedCandle(m5Candles),
            m1: this.getLastClosedCandle(m1Candles),
        };

        return {
            indicators: compactIndicators(indicators),
            candles,
        };
    }

    async logSnapshot(symbol) {
        try {
            const snapshot = await this.buildIndicatorsSnapshot(symbol);
            if (!snapshot?.indicators) {
                logger.warn(`[PriceLogger] Missing candles/indicators for ${symbol}, skipping snapshot.`);
                return false;
            }
            const { indicators, candles } = snapshot;

            let bid = null;
            let ask = null;
            let mid = null;
            let spread = null;
            let marketTimestamp = null;
            try {
                await this.sleep(this.requestDelayMs);
                const marketDetails = await getMarketDetails(symbol);
                bid = this.toNumber(marketDetails?.snapshot?.bid);
                ask = this.toNumber(marketDetails?.snapshot?.offer ?? marketDetails?.snapshot?.ask);
                const snapshotFields = marketDetails?.snapshot || {};
                const rawCandidates = [
                    snapshotFields?.updateTime,
                    snapshotFields?.updateTimeUTC,
                    snapshotFields?.timestamp,
                    snapshotFields?.snapshotTimeUTC,
                    snapshotFields?.snapshotTime,
                ].filter((v) => v !== undefined && v !== null && v !== "");
                const parsedCandidates = [];
                for (const raw of rawCandidates) {
                    const asLocal = this.toTimestampMsLocalNoZone(raw);
                    const asUtc = this.toTimestampMs(raw);
                    if (Number.isFinite(asLocal)) parsedCandidates.push(asLocal);
                    if (Number.isFinite(asUtc)) parsedCandidates.push(asUtc);
                }
                const m1ReferenceTs = this.toTimestampMs(candles?.m1?.t);
                const selectedTsMs = this.chooseTimestampClosestToReference(parsedCandidates, m1ReferenceTs);
                marketTimestamp = Number.isFinite(selectedTsMs) ? new Date(selectedTsMs).toISOString() : null;
                if (bid !== null && ask !== null) {
                    mid = (bid + ask) / 2;
                    spread = ask - bid;
                }
            } catch (error) {
                logger.warn(`[PriceLogger] Market snapshot failed for ${symbol}: ${error.message}`);
            }

            const m1Close = this.toNumber(indicators?.m1?.lastClose ?? indicators?.m1?.close);
            const referencePrice = mid !== null ? mid : m1Close;
            const resolvedTimestamp = this.resolveSnapshotTimestamp({ marketTimestamp, candles });
            const sessions = this.getActiveSessionsUtc(resolvedTimestamp);
            let newsBlocked = false;
            if (NEWS_GUARD.ENABLED) {
                try {
                    const { getNewsStatus } = await import("./newsChecker.js");
                    const newsStatus = await getNewsStatus(symbol, {
                        now: resolvedTimestamp ? new Date(resolvedTimestamp) : new Date(),
                        includeImpacts: NEWS_GUARD.INCLUDE_IMPACTS,
                        windowsByImpact: NEWS_GUARD.WINDOWS_BY_IMPACT,
                    });
                    newsBlocked = Boolean(newsStatus?.blocked);
                } catch (error) {
                    logger.warn(`[PriceLogger] News check failed for ${symbol}: ${error.message}`);
                }
            }

            const payload = {
                symbol,
                timestamp: resolvedTimestamp,
                marketTimestamp,
                bid,
                ask,
                mid,
                spread,
                price: referencePrice,
                sessions,
                newsBlocked,
                candles,
                indicators,
            };

            const sanity = this.checkCandleTimestampSanity(payload);
            if (!sanity.ok) {
                logger.warn(`[PriceLogger] Candle timestamp sanity failed for ${symbol}: ${sanity.reason}`);
                return false;
            }

            const priceSanity = this.checkMarketPriceSanity(payload);
            if (!priceSanity.ok) {
                logger.warn(`[PriceLogger] Market snapshot sanity failed for ${symbol}: ${priceSanity.reason}`);
                return false;
            }

            const monotonicCheck = this.canAppendMonotonic(symbol, payload.timestamp);
            if (!monotonicCheck.ok) {
                logger.warn(`[PriceLogger] Monotonicity check failed for ${symbol}: ${monotonicCheck.reason}`);
                return false;
            }

            appendLine(getSymbolLogPath(symbol), payload);
            this.markTimestampWritten(symbol, monotonicCheck.tsMs);
            return true;
        } catch (error) {
            logger.warn(`[PriceLogger] Snapshot failed for ${symbol}: ${error.message}`);
            return false;
        }
    }

    async logSnapshotsForSymbols(symbols = []) {
        if (!Array.isArray(symbols) || symbols.length === 0) return;
        for (const symbol of symbols) {
            await this.logSnapshot(symbol);
            await this.sleep(this.symbolDelayMs);
        }
    }

    checkCandleTimestampSanity(payload) {
        const snapshotTs = this.toTimestampMs(payload?.timestamp);
        if (!Number.isFinite(snapshotTs)) {
            return { ok: false, reason: "invalid_snapshot_timestamp" };
        }

        const evaluateLagIssues = (anchorTsMs) => {
            const lagIssues = [];
            for (const [tf, bounds] of Object.entries(CANDLE_LAG_SANITY_MINUTES)) {
                const candleTs = this.toTimestampMs(payload?.candles?.[tf]?.t);
                if (!Number.isFinite(candleTs)) {
                    lagIssues.push(`${tf}:missing_or_invalid`);
                    continue;
                }
                const lagMinutes = (anchorTsMs - candleTs) / 60000;
                if (lagMinutes < bounds.min || lagMinutes > bounds.max) {
                    lagIssues.push(`${tf}:lag=${lagMinutes.toFixed(2)}m`);
                }
            }
            return lagIssues;
        };

        let issues = evaluateLagIssues(snapshotTs);
        if (issues.length) {
            const offsetCandidates = [-60, 60, -120, 120, -180, 180];
            for (const offsetMinutes of offsetCandidates) {
                const shifted = snapshotTs + offsetMinutes * 60000;
                const shiftedIssues = evaluateLagIssues(shifted);
                if (!shiftedIssues.length) {
                    issues = shiftedIssues;
                    break;
                }
            }
        }

        if (!issues.length) return { ok: true, reason: "" };
        return { ok: false, reason: issues.join(", ") };
    }

    checkMarketPriceSanity(payload) {
        const issues = [];
        const symbol = String(payload?.symbol || "").toUpperCase();
        const isCrypto = Array.isArray(CRYPTO_SYMBOLS) && CRYPTO_SYMBOLS.map((s) => String(s).toUpperCase()).includes(symbol);
        const isForexLike = /^[A-Z]{6}$/.test(symbol) && !isCrypto;
        const bid = this.toNumber(payload?.bid);
        const ask = this.toNumber(payload?.ask);
        const mid = this.toNumber(payload?.mid);
        const m1Close = this.toNumber(payload?.candles?.m1?.c ?? payload?.indicators?.m1?.close ?? payload?.indicators?.m1?.lastClose);

        if (Number.isFinite(bid) && Number.isFinite(ask) && ask < bid) {
            issues.push("ask_below_bid");
        }
        if (Number.isFinite(mid) && Number.isFinite(bid) && Number.isFinite(ask) && (mid < bid || mid > ask)) {
            issues.push("mid_outside_bid_ask");
        }

        if (isForexLike && Number.isFinite(mid) && Number.isFinite(m1Close)) {
            const pipValue = this.getPipValue(symbol);
            const driftPips = pipValue > 0 ? Math.abs(mid - m1Close) / pipValue : null;
            if (Number.isFinite(driftPips) && driftPips > MAX_M1_MID_DEVIATION_PIPS) {
                issues.push(`m1_mid_drift_${driftPips.toFixed(2)}pip`);
            }
        }

        if (!issues.length) return { ok: true, reason: "" };
        return { ok: false, reason: issues.join(", ") };
    }
}

export const priceLogger = new PriceLogger();
