import fs from "fs";
import path from "path";
import { getMarketDetails, getHistorical } from "../api.js";
import { calcIndicators } from "../indicators/indicators.js";
import logger from "./logger.js";

import { ANALYSIS } from "../config.js";
const { TIMEFRAMES } = ANALYSIS;

const LOG_DIR = path.join(process.cwd(), "backtest", "logs");

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function sanitizeSymbol(symbol = "unknown") {
    return String(symbol || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function listLogFiles() {
    if (!fs.existsSync(LOG_DIR)) return [];
    return fs
        .readdirSync(LOG_DIR)
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => path.join(LOG_DIR, file));
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

function updateEntry(logPath, dealId, updater) {
    if (!fs.existsSync(logPath)) return false;
    const targetId = String(dealId);
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw.trim()) continue;

        let entry;
        try {
            entry = JSON.parse(raw.trim());
        } catch {
            continue;
        }

        if (String(entry.dealId) === targetId) {
            const next = updater(entry);
            lines[i] = JSON.stringify(next);
            updated = true;
            break;
        }
    }

    if (updated) {
        fs.writeFileSync(logPath, lines.filter(Boolean).join("\n") + "\n");
    }

    return updated;
}

function normalizeCloseReason(reason) {
    if (reason === undefined || reason === null || reason === "") return "";
    const r = String(reason).toLowerCase();
    if (r === "unknown") return "unknown";
    if (r === "tp" || r === "take_profit" || r.includes("take") || r.includes("limit") || r.includes("profit")) return "hit_tp";
    if (r === "sl" || r === "stop_loss" || r.includes("stop")) return "hit_sl";
    if (r === "timeout" || r === "time" || r.includes("timed out") || r.includes("time_out")) return "timeout";
    if (r.includes("manual")) return "manual_close";
    return reason;
}

function toNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? num : null;
}

function getPipSize(symbol) {
    return String(symbol || "")
        .toUpperCase()
        .includes("JPY")
        ? 0.01
        : 0.0001;
}

export function getTradeEntry(dealId, symbol) {
    const targetId = String(dealId);
    const primaryPath = symbol ? getSymbolLogPath(symbol) : null;
    const candidates = primaryPath ? [primaryPath, ...listLogFiles().filter((p) => p !== primaryPath)] : listLogFiles();

    for (const logPath of candidates) {
        if (!fs.existsSync(logPath)) continue;
        const lines = fs.readFileSync(logPath, "utf-8").split("\n");
        for (const raw of lines) {
            if (!raw.trim()) continue;
            let entry;
            try {
                entry = JSON.parse(raw.trim());
            } catch {
                continue;
            }
            if (String(entry.dealId) === targetId) {
                return { entry, logPath };
            }
        }
    }
    return { entry: null, logPath: null };
}

export function logTradeOpen({ dealId, symbol, signal, entryPrice, stopLoss, takeProfit, indicatorsOnOpening, timestamp }) {
    const logPath = getSymbolLogPath(symbol);
    const compactOpening = compactIndicators(indicatorsOnOpening);
    const payload = {
        dealId,
        symbol,
        signal,
        entryPrice,
        stopLoss,
        takeProfit,
        indicatorsOnOpening: compactOpening,
        openedAt: timestamp,
        status: "open",

        // keep stable schema for later analysis
        closeReason: "",
        indicatorsOnClosing: null,
        closePrice: null,
        closedAt: null,
    };

    appendLine(logPath, payload);
}

export function logTradeClose({ dealId, symbol, closePrice, closeReason, indicatorsOnClosing, timestamp }) {
    const normalizedReason = normalizeCloseReason(closeReason);
    const closedAt = timestamp;
    const compactClosing = compactIndicators(indicatorsOnClosing);
    const primaryPath = symbol ? getSymbolLogPath(symbol) : null;
    const candidates = primaryPath ? [primaryPath, ...listLogFiles().filter((p) => p !== primaryPath)] : listLogFiles();

    for (const logPath of candidates) {
        const updated = updateEntry(logPath, dealId, (entry) => {
            const openedTimestamp = entry.openedAt ?? entry.timestamp ?? null;

            const existingReason = entry.closeReason && String(entry.closeReason).trim() ? String(entry.closeReason) : "";
            const shouldUseNormalized = normalizedReason && normalizedReason !== "unknown";
            const finalReason = shouldUseNormalized ? normalizedReason : existingReason || normalizedReason || "unknown";

            const hasClosePrice = closePrice !== undefined && closePrice !== null && closePrice !== "";
            const nextClosePrice = hasClosePrice ? closePrice : (entry.closePrice ?? null);
            const nextIndicatorsOnClosing = compactClosing ?? entry.indicatorsOnClosing ?? null;

            return {
                ...entry,
                openedAt: openedTimestamp,
                status: "closed",
                closeReason: finalReason,
                closedAt: closedAt ?? entry.closedAt,
                closePrice: nextClosePrice,
                indicatorsOnClosing: nextIndicatorsOnClosing,
            };
        });

        if (updated) return true;
    }

    return false;
}

class TradeTracker {
    constructor() {
        this.openDealIds = [];
        this.dealIdToSymbol = new Map();

        this.openDealIdsBrocker = [];
        this.dealIdToSymbolBrocker = new Map();

        this.candleHistoryData = {}; // symbol -> array of candles
        this.historyLength = 200;
    }

    registerOpenBrockerDeal(dealId, symbol) {
        if (!dealId) return;
        const id = String(dealId);
        if (!this.openDealIdsBrocker.includes(id)) {
            this.openDealIdsBrocker.push(id);
        }
        if (symbol) this.dealIdToSymbolBrocker.set(id, String(symbol));
    }

    registerOpenDeal(dealId, symbol) {
        if (!dealId) return;
        const id = String(dealId);
        console.log("registered opened deal id", id, "for: ", symbol);

        if (!this.openDealIds.includes(id)) {
            this.openDealIds.push(id);
        }
        console.log("[tradeLogger] openDealIds", this.openDealIds);

        if (symbol) this.dealIdToSymbol.set(id, symbol);
    }

    markDealClosed(dealId) {
        if (!dealId) return;
        const id = String(dealId);

        // local tracker
        this.openDealIds = this.openDealIds.filter((dealId) => dealId !== id);
        this.dealIdToSymbol.delete(id);

        // broker tracker
        this.openDealIdsBrocker = this.openDealIdsBrocker.filter((dealId) => dealId !== id);
        this.dealIdToSymbolBrocker.delete(id);
    }

    // ------------------------------------------------------------
    //                 CLOSE INDICATORS CALCULATION
    // ------------------------------------------------------------

    async fetchAllCandles(symbol, timeframes, historyLength) {
        try {
            const [d1Data, h4Data, h1Data, m15Data, m5Data, m1Data] = await Promise.all([
                getHistorical(symbol, timeframes.D1, historyLength),
                getHistorical(symbol, timeframes.H4, historyLength),
                getHistorical(symbol, timeframes.H1, historyLength),
                getHistorical(symbol, timeframes.M15, historyLength),
                getHistorical(symbol, timeframes.M5, historyLength),
                getHistorical(symbol, timeframes.M1, historyLength),
            ]);
            console.log(`Fetched candles: ${timeframes.D1}, ${timeframes.H4}, ${timeframes.H1}, ${timeframes.M15}, ${timeframes.M5}, ${timeframes.M1}`);
            return { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data };
        } catch (error) {
            logger.error(`[CandleFetch] Error fetching candles for ${symbol}: ${error.message}`);
            return {};
        }
    }
    async getCloseIndicators(symbol) {
        try {
            const { d1Data, h4Data, h1Data, m15Data, m5Data, m1Data } = await this.fetchAllCandles(symbol, TIMEFRAMES, this.historyLength);

            this.candleHistoryData[symbol] = {
                D1: d1Data.prices.slice(-this.historyLength) || [],
                H4: h4Data.prices.slice(-this.historyLength) || [],
                H1: h1Data.prices.slice(-this.historyLength) || [],
                M15: m15Data.prices.slice(-this.historyLength) || [],
                M5: m5Data.prices.slice(-this.historyLength) || [],
                M1: m1Data.prices.slice(-this.historyLength) || [],
            };

            const d1Candles = this.candleHistoryData[symbol].D1;
            const h4Candles = this.candleHistoryData[symbol].H4;
            const h1Candles = this.candleHistoryData[symbol].H1;
            const m15Candles = this.candleHistoryData[symbol].M15;
            const m5Candles = this.candleHistoryData[symbol].M5;
            const m1Candles = this.candleHistoryData[symbol].M1;

            const indicatorsClose = {
                d1: await calcIndicators(d1Candles, symbol, TIMEFRAMES.D1),
                h4: await calcIndicators(h4Candles, symbol, TIMEFRAMES.H4),
                h1: await calcIndicators(h1Candles, symbol, TIMEFRAMES.H1),
                m15: await calcIndicators(m15Candles, symbol, TIMEFRAMES.M15),
                m5: await calcIndicators(m5Candles, symbol, TIMEFRAMES.M5),
                m1: await calcIndicators(m1Candles, symbol, TIMEFRAMES.M1),
            };

            return indicatorsClose;
        } catch (err) {
            logger.warn(`[Reconcile] Close-indicators calc failed for ${symbol}: ${err.message}`);
            return null;
        }
    }

    async reconcileClosedDeals(closedDealsIds = []) {
        if (!Array.isArray(closedDealsIds) || !closedDealsIds.length) return;

        for (const id of closedDealsIds) {
            // Prefer known symbol mappings; broker mapping is what your DealID monitor populates
            let symbol = this.dealIdToSymbol.get(id) || this.dealIdToSymbolBrocker.get(id) || null;
            try {
                console.log("its", id, symbol);

                const { entry } = getTradeEntry(id, symbol);

                // If symbol wasn't mapped (e.g., after restart), fallback to the symbol stored in the log entry
                if (!symbol) symbol = entry?.symbol ? String(entry.symbol) : null;

                const existingReason = entry?.closeReason && String(entry.closeReason).trim() ? String(entry.closeReason) : "";
                let closePrice = entry?.closePrice ?? null;

                if (closePrice === null) {
                    closePrice = await this.getClosePrice(symbol, entry);
                }

                const inferredReason = this.inferCloseReason(entry, {
                    closePrice,
                    symbol,
                    source: closePrice !== null ? "market_snapshot" : "unknown",
                });
                const finalReason = existingReason && existingReason !== "unknown" ? existingReason : inferredReason || "unknown";

                const closePriceSource = entry?.closePrice !== null && entry?.closePrice !== undefined ? "existing_log" : closePrice !== null ? "market_snapshot" : "unknown";
                logger.info("[Reconcile] Close snapshot", {
                    dealId: id,
                    symbol,
                    closePrice,
                    source: closePriceSource,
                });
                logger.info("[Reconcile] Close reason", {
                    dealId: id,
                    reason: finalReason,
                    source: existingReason ? "existing_log" : "unknown",
                });

                // Compute REAL close indicators snapshot (current candles at closing time)
                const indicatorsOnClosing = await this.getCloseIndicators(symbol);

                const updated = logTradeClose({
                    symbol: symbol ?? entry?.symbol ?? "unknown",
                    dealId: id,
                    closeReason: finalReason,
                    indicatorsOnClosing,
                    closePrice: closePrice ?? null,
                    timestamp: new Date().toISOString(),
                });

                if (updated || !entry) {
                    this.markDealClosed(id);
                }
            } catch (err) {
                logger.warn(`[Reconcile] Failed to close log for ${id}: ${err.message}`);
            }
        }
    }

    async getClosePrice(symbol, entry) {
        const fallback = entry?.entryPrice ?? null;
        if (!symbol) return fallback;
        try {
            const details = await getMarketDetails(symbol);
            const snapshot = details?.snapshot || {};
            const signal = String(entry?.signal || entry?.side || "").toUpperCase();

            if (signal === "BUY") {
                return snapshot.offer ?? snapshot.ask ?? snapshot.bid ?? fallback;
            }
            if (signal === "SELL") {
                return snapshot.bid ?? snapshot.offer ?? snapshot.ask ?? fallback;
            }
            return snapshot.bid ?? snapshot.offer ?? snapshot.ask ?? fallback;
        } catch (err) {
            logger.warn(`[Reconcile] Price lookup failed for ${symbol}: ${err.message}`);
            return fallback;
        }
    }

    inferCloseReason(entry, closeInfo = null) {
        if (!entry) return "unknown";
        const raw = closeInfo?.reason ?? closeInfo?.status ?? closeInfo?.dealStatus ?? closeInfo?.result ?? closeInfo?.message ?? "";
        const normalized = normalizeCloseReason(raw);
        if (normalized && normalized !== "unknown") return normalized;
        if (closeInfo?.source === "market_snapshot") return normalized || "unknown";

        const closePrice = toNumber(
            closeInfo?.closePrice ?? closeInfo?.closeLevel ?? closeInfo?.level ?? closeInfo?.price ?? entry?.closePrice ?? entry?.closeLevel ?? entry?.level,
        );
        const stopLoss = toNumber(entry?.stopLoss ?? entry?.stopLevel ?? closeInfo?.stopLoss ?? closeInfo?.stopLevel);
        const takeProfit = toNumber(
            entry?.takeProfit ?? entry?.limitLevel ?? entry?.profitLevel ?? closeInfo?.takeProfit ?? closeInfo?.limitLevel ?? closeInfo?.profitLevel,
        );

        if (closePrice === null || (stopLoss === null && takeProfit === null)) return normalized || "unknown";

        const side = String(entry?.signal ?? entry?.side ?? entry?.direction ?? closeInfo?.direction ?? "").toUpperCase();
        const pip = getPipSize(entry?.symbol ?? closeInfo?.symbol);
        const tolerance = pip * 2;
        const hasSide = side === "BUY" || side === "SELL";

        let hitTp = false;
        let hitSl = false;

        if (takeProfit !== null) {
            if (hasSide) {
                hitTp = side === "BUY" ? closePrice >= takeProfit - tolerance : closePrice <= takeProfit + tolerance;
            } else {
                hitTp = Math.abs(closePrice - takeProfit) <= tolerance;
            }
        }

        if (stopLoss !== null) {
            if (hasSide) {
                hitSl = side === "BUY" ? closePrice <= stopLoss + tolerance : closePrice >= stopLoss - tolerance;
            } else {
                hitSl = Math.abs(closePrice - stopLoss) <= tolerance;
            }
        }

        if (hitTp && hitSl) {
            const tpDist = takeProfit === null ? Number.POSITIVE_INFINITY : Math.abs(closePrice - takeProfit);
            const slDist = stopLoss === null ? Number.POSITIVE_INFINITY : Math.abs(closePrice - stopLoss);
            return tpDist <= slDist ? "hit_tp" : "hit_sl";
        }
        if (hitTp) return "hit_tp";
        if (hitSl) return "hit_sl";
        return normalized || "unknown";
    }
}

export const tradeTracker = new TradeTracker();
