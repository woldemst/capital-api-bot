import fs from "fs";
import path from "path";
import { getHistorical, getMarketDetails } from "../api.js";
import { calcIndicators } from "../indicators/indicators.js";
import { ANALYSIS, SESSIONS, CRYPTO_SYMBOLS } from "../config.js";
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

    getLastClosedCandle(candles = []) {
        if (!Array.isArray(candles) || candles.length === 0) return null;
        // Use the penultimate candle as a safe "last closed" candidate.
        const candle = candles.length > 1 ? candles[candles.length - 2] : candles[candles.length - 1];
        return {
            t: this.toIsoTimestamp(candle?.timestamp ?? candle?.snapshotTime ?? candle?.snapshotTimeUTC),
            o: this.toNumber(candle?.open ?? candle?.openPrice?.bid ?? candle?.openPrice?.ask),
            h: this.toNumber(candle?.high ?? candle?.highPrice?.bid ?? candle?.highPrice?.ask),
            l: this.toNumber(candle?.low ?? candle?.lowPrice?.bid ?? candle?.lowPrice?.ask),
            c: this.toNumber(candle?.close ?? candle?.closePrice?.bid ?? candle?.closePrice?.ask),
        };
    }

    getPipValue(symbol) {
        return String(symbol || "").toUpperCase().includes("JPY") ? 0.01 : 0.0001;
    }

    getActiveSessionsUtc() {
        const now = new Date();
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

    async fetchAllCandles(symbol, timeframes, historyLength) {
        try {
            const d1Data = await getHistorical(symbol, timeframes.D1, historyLength);
            await this.sleep(this.requestDelayMs);
            const h4Data = await getHistorical(symbol, timeframes.H4, historyLength);
            await this.sleep(this.requestDelayMs);
            const h1Data = await getHistorical(symbol, timeframes.H1, historyLength);
            await this.sleep(this.requestDelayMs);
            const m15Data = await getHistorical(symbol, timeframes.M15, historyLength);
            await this.sleep(this.requestDelayMs);
            const m5Data = await getHistorical(symbol, timeframes.M5, historyLength);
            await this.sleep(this.requestDelayMs);
            const m1Data = await getHistorical(symbol, timeframes.M1, historyLength);
            return { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data };
        } catch (error) {
            logger.warn(`[PriceLogger] Candle fetch failed for ${symbol}: ${error.message}`);
            return {};
        }
    }

    async buildIndicatorsSnapshot(symbol) {
        const { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data } = await this.fetchAllCandles(symbol, TIMEFRAMES, this.historyLength);
        const d1Candles = d1Data?.prices?.slice(-this.historyLength) || [];
        const h4Candles = h4Data?.prices?.slice(-this.historyLength) || [];
        const h1Candles = h1Data?.prices?.slice(-this.historyLength) || [];
        const m15Candles = m15Data?.prices?.slice(-this.historyLength) || [];
        const m5Candles = m5Data?.prices?.slice(-this.historyLength) || [];
        const m1Candles = m1Data?.prices?.slice(-this.historyLength) || [];

        if (!d1Candles.length || !h4Candles.length || !h1Candles.length || !m15Candles.length || !m5Candles.length || !m1Candles.length) {
            return null;
        }

        const indicators = {
            d1: await calcIndicators(d1Candles, symbol, TIMEFRAMES.D1),
            h4: await calcIndicators(h4Candles, symbol, TIMEFRAMES.H4),
            h1: await calcIndicators(h1Candles, symbol, TIMEFRAMES.H1),
            m15: await calcIndicators(m15Candles, symbol, TIMEFRAMES.M15),
            m5: await calcIndicators(m5Candles, symbol, TIMEFRAMES.M5),
            m1: await calcIndicators(m1Candles, symbol, TIMEFRAMES.M1),
        };

        const candles = {
            d1: this.getLastClosedCandle(d1Candles),
            h4: this.getLastClosedCandle(h4Candles),
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
            const sessions = this.getActiveSessionsUtc();
            let newsBlocked = false;
            try {
                const { isNewsTime } = await import("./newsChecker.js");
                newsBlocked = await isNewsTime(symbol);
            } catch (error) {
                logger.warn(`[PriceLogger] News check failed for ${symbol}: ${error.message}`);
            }

            const payload = {
                symbol,
                timestamp: marketTimestamp || new Date().toISOString(),
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

            appendLine(getSymbolLogPath(symbol), payload);
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
