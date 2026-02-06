import fs from "fs";
import path from "path";
import { getHistorical, getMarketDetails } from "../api.js";
import { calcIndicators } from "../indicators/indicators.js";
import { ANALYSIS, SESSIONS } from "../config.js";
import logger from "./logger.js";

const { TIMEFRAMES } = ANALYSIS;
const LOG_DIR = path.join(process.cwd(), "backtest", "prices");

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
    const compact = {};
    for (const [timeframe, data] of Object.entries(snapshot)) {
        if (!data || typeof data !== "object") {
            compact[timeframe] = data;
            continue;
        }
        const { rsiSeries, bbSeries, bbUpperSeries, bbLowerSeries, ...rest } = data;
        compact[timeframe] = rest;
    }
    return compact;
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
        this.higherIndicatorsCache = new Map();
        this.lastHigherBucketBySymbol = new Map();
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    toNumber(value) {
        const num = typeof value === "number" ? value : Number(value);
        return Number.isFinite(num) ? num : null;
    }

    getM15BucketMs(date = new Date()) {
        const d = new Date(date);
        d.setUTCSeconds(0, 0);
        const minute = d.getUTCMinutes();
        d.setUTCMinutes(Math.floor(minute / 15) * 15);
        return d.getTime();
    }

    shouldRefreshHigherIndicators(symbol, now = new Date()) {
        const bucket = this.getM15BucketMs(now);
        const last = this.lastHigherBucketBySymbol.get(symbol);
        return bucket !== last;
    }

    getActiveSessionsUtc() {
        const now = new Date();
        const hour = now.getUTCHours();
        const minute = now.getUTCMinutes();
        const currentMinutes = hour * 60 + minute;

        const sessions = [];
        const entries = Object.entries(SESSIONS).filter(([key]) => key !== "CRYPTO");
        for (const [name, win] of entries) {
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

    async fetchHigherCandles(symbol, timeframes, historyLength) {
        try {
            const d1Data = await getHistorical(symbol, timeframes.D1, historyLength);
            await this.sleep(this.requestDelayMs);
            const h4Data = await getHistorical(symbol, timeframes.H4, historyLength);
            await this.sleep(this.requestDelayMs);
            const h1Data = await getHistorical(symbol, timeframes.H1, historyLength);
            await this.sleep(this.requestDelayMs);
            const m15Data = await getHistorical(symbol, timeframes.M15, historyLength);
            return { d1Data, h4Data, h1Data, m15Data };
        } catch (error) {
            logger.warn(`[PriceLogger] Higher-timeframe candle fetch failed for ${symbol}: ${error.message}`);
            return {};
        }
    }

    async fetchEntryCandles(symbol, timeframes, historyLength) {
        try {
            const m5Data = await getHistorical(symbol, timeframes.M5, historyLength);
            await this.sleep(this.requestDelayMs);
            const m1Data = await getHistorical(symbol, timeframes.M1, historyLength);
            return { m5Data, m1Data };
        } catch (error) {
            logger.warn(`[PriceLogger] Entry-timeframe candle fetch failed for ${symbol}: ${error.message}`);
            return {};
        }
    }

    async buildHigherIndicators(symbol) {
        const { d1Data, h4Data, h1Data, m15Data } = await this.fetchHigherCandles(symbol, TIMEFRAMES, this.historyLength);
        const d1Candles = d1Data?.prices?.slice(-this.historyLength) || [];
        const h4Candles = h4Data?.prices?.slice(-this.historyLength) || [];
        const h1Candles = h1Data?.prices?.slice(-this.historyLength) || [];
        const m15Candles = m15Data?.prices?.slice(-this.historyLength) || [];

        if (!d1Candles.length || !h4Candles.length || !h1Candles.length || !m15Candles.length) {
            return null;
        }

        return {
            d1: await calcIndicators(d1Candles, symbol, TIMEFRAMES.D1),
            h4: await calcIndicators(h4Candles, symbol, TIMEFRAMES.H4),
            h1: await calcIndicators(h1Candles, symbol, TIMEFRAMES.H1),
            m15: await calcIndicators(m15Candles, symbol, TIMEFRAMES.M15),
        };
    }

    async buildEntryIndicators(symbol) {
        const { m5Data, m1Data } = await this.fetchEntryCandles(symbol, TIMEFRAMES, this.historyLength);
        const m5Candles = m5Data?.prices?.slice(-this.historyLength) || [];
        const m1Candles = m1Data?.prices?.slice(-this.historyLength) || [];

        if (!m5Candles.length || !m1Candles.length) {
            return null;
        }

        return {
            m5: await calcIndicators(m5Candles, symbol, TIMEFRAMES.M5),
            m1: await calcIndicators(m1Candles, symbol, TIMEFRAMES.M1),
        };
    }

    async buildIndicatorsSnapshot(symbol, options = {}) {
        const now = options?.now instanceof Date ? options.now : new Date();
        const forceHigherRefresh = Boolean(options?.forceHigherRefresh);

        const entryIndicators = await this.buildEntryIndicators(symbol);
        if (!entryIndicators) return null;

        let higherIndicators = this.higherIndicatorsCache.get(symbol) || null;
        const shouldRefreshHigher = forceHigherRefresh || this.shouldRefreshHigherIndicators(symbol, now) || !higherIndicators;

        if (shouldRefreshHigher) {
            const freshHigher = await this.buildHigherIndicators(symbol);
            if (freshHigher) {
                higherIndicators = freshHigher;
                this.higherIndicatorsCache.set(symbol, freshHigher);
                this.lastHigherBucketBySymbol.set(symbol, this.getM15BucketMs(now));
            }
        }

        return compactIndicators({
            ...(higherIndicators || {}),
            ...entryIndicators,
        });
    }

    async logSnapshot(symbol, options = {}) {
        try {
            const now = options?.now instanceof Date ? options.now : new Date();
            const indicators = await this.buildIndicatorsSnapshot(symbol, options);
            if (!indicators) {
                logger.warn(`[PriceLogger] Missing candles/indicators for ${symbol}, skipping snapshot.`);
                return false;
            }

            let bid = null;
            let ask = null;
            let mid = null;
            let spread = null;
            try {
                await this.sleep(this.requestDelayMs);
                const marketDetails = await getMarketDetails(symbol);
                bid = this.toNumber(marketDetails?.snapshot?.bid);
                ask = this.toNumber(marketDetails?.snapshot?.offer ?? marketDetails?.snapshot?.ask);
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
                timestamp: now.toISOString(),
                bid,
                ask,
                mid,
                spread,
                price: referencePrice,
                sessions,
                newsBlocked,
                indicators,
            };

            appendLine(getSymbolLogPath(symbol), payload);
            return true;
        } catch (error) {
            logger.warn(`[PriceLogger] Snapshot failed for ${symbol}: ${error.message}`);
            return false;
        }
    }

    async logSnapshotsForSymbols(symbols = [], options = {}) {
        if (!Array.isArray(symbols) || symbols.length === 0) return;
        const now = options?.now instanceof Date ? options.now : new Date();
        for (const symbol of symbols) {
            await this.logSnapshot(symbol, { ...options, now });
            await this.sleep(this.symbolDelayMs);
        }
    }

    async logOneMinuteSnapshotsForSymbols(symbols = []) {
        return this.logSnapshotsForSymbols(symbols);
    }
}

export const priceLogger = new PriceLogger();
