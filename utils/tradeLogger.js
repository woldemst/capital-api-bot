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
    if (!reason) return "unknown";
    const r = String(reason).toLowerCase();
    if (r === "tp" || r === "take_profit" || r.includes("take") || r.includes("limit")) return "hit_tp";
    if (r.includes("trailing")) return "trailing_stop";
    if (r === "sl" || r === "stop_loss" || r.includes("stop")) return "hit_sl";
    if (r.includes("manual") || r.includes("user")) return "manual_close";
    if (r.includes("timeout") || r.includes("time")) return "timeout";
    if (r.includes("expire")) return "expired";
    if (r.includes("partial")) return "partial_close";
    return reason;
}

function inferCloseReasonFromPrice(entry, closePrice) {
    if (!entry) return "unknown";
    const signal = String(entry?.signal || entry?.side || "").toUpperCase();
    const stopLoss = Number(entry?.stopLoss);
    const takeProfit = Number(entry?.takeProfit);

    if (!signal || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || !Number.isFinite(closePrice)) {
        return "unknown";
    }

    const slHit = signal === "BUY" ? closePrice <= stopLoss : closePrice >= stopLoss;
    const tpHit = signal === "BUY" ? closePrice >= takeProfit : closePrice <= takeProfit;

    if (tpHit && !slHit) return "hit_tp";
    if (slHit && !tpHit) return "hit_sl";
    if (!tpHit && !slHit) return "unknown";

    const distToSL = Math.abs(closePrice - stopLoss);
    const distToTP = Math.abs(closePrice - takeProfit);
    return distToTP < distToSL ? "hit_tp" : "hit_sl";
}

export function deriveCloseReason({ brokerPayload, closeReasonHint, entry, closePrice }) {
    const hint = normalizeCloseReason(closeReasonHint);
    const affectedStatuses = Array.isArray(brokerPayload?.affectedDeals)
        ? brokerPayload.affectedDeals.map((d) => d?.status).filter(Boolean).join(" ")
        : "";
    const text = [brokerPayload?.dealStatus, brokerPayload?.status, brokerPayload?.reason, brokerPayload?.closeReason, brokerPayload?.result, affectedStatuses]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase())
        .join(" ");

    // TODO: Confirm broker close payload fields and tighten mappings to broker enums.
    if (text) {
        if (text.includes("trailing")) return { reason: "trailing_stop", source: "broker" };
        if (text.includes("stop") || text.includes("sl")) return { reason: "hit_sl", source: "broker" };
        if (text.includes("limit") || text.includes("take") || text.includes("tp")) return { reason: "hit_tp", source: "broker" };
        if (text.includes("partial")) return { reason: "partial_close", source: "broker" };
        if (text.includes("expire")) return { reason: "expired", source: "broker" };
        if (text.includes("manual") || text.includes("user") || text.includes("client")) return { reason: "manual_close", source: "broker" };
    }

    if (hint && hint !== "unknown") return { reason: hint, source: "hint" };

    const inferred = inferCloseReasonFromPrice(entry, closePrice);
    if (inferred !== "unknown") return { reason: inferred, source: "inferred" };

    return { reason: "unknown", source: "unknown" };
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

export function logTradeOpen({ dealId, symbol, signal, entryPrice, stopLoss, takeProfit, indicators, timestamp, dealReference }) {
    if (!dealId) return false;
    const { entry } = getTradeEntry(dealId, symbol);
    if (entry) {
        logger.warn(`[tradeLogger] Duplicate open log for ${dealId} (${symbol}), skipping.`);
        return false;
    }

    const logPath = getSymbolLogPath(symbol);
    const payload = {
        dealId,
        dealReference,
        symbol,
        signal,
        entryPrice,
        stopLoss,
        takeProfit,
        indicators,
        openedAt: timestamp,
        status: "open",

        // keep stable schema for later analysis
        closeReason: "",
        indicatorsClose: null,
        closePrice: null,
        closedAt: null,
    };

    appendLine(logPath, payload);
    return true;
}

export function logTradeClose({ dealId, symbol, closePrice, closeReason, indicators, timestamp }) {
    const reason = normalizeCloseReason(closeReason);
    const closedAt = timestamp;
    const { entry: existing, logPath: preferredPath } = getTradeEntry(dealId, symbol);
    if (existing?.status === "closed" && existing.closedAt) return true;

    const primaryPath = preferredPath ?? (symbol ? getSymbolLogPath(symbol) : null);
    const candidates = primaryPath ? [primaryPath, ...listLogFiles().filter((p) => p !== primaryPath)] : listLogFiles();

    for (const logPath of candidates) {
        const updated = updateEntry(logPath, dealId, (entry) => {
            const openedTimestamp = entry.openedAt ?? entry.timestamp ?? null;

            const incoming = indicators ?? entry.indicatorsClose ?? null;
            const indicatorsClose = incoming && typeof incoming === "object" ? { ...incoming } : incoming ?? null;
            const resolvedClosePrice = typeof closePrice !== "undefined" ? closePrice : indicatorsClose?.price ?? entry.closePrice ?? null;

            if (indicatorsClose && typeof indicatorsClose === "object" && resolvedClosePrice !== null) {
                indicatorsClose.price = resolvedClosePrice;
            }

            return {
                ...entry,
                openedAt: openedTimestamp,
                status: "closed",
                closeReason: reason,
                closedAt: closedAt ?? entry.closedAt ?? null,
                closePrice: resolvedClosePrice,
                indicatorsClose: indicatorsClose ?? null,
            };
        });

        if (updated) return true;
    }

    return false;
}

export function logTradeUpdate({ dealId, symbol, stopLoss, takeProfit, timestamp, reason }) {
    if (!dealId) return false;
    if (typeof stopLoss === "undefined" && typeof takeProfit === "undefined") return false;

    const { entry, logPath: preferredPath } = getTradeEntry(dealId, symbol);
    if (!entry) return false;

    const primaryPath = preferredPath ?? (symbol ? getSymbolLogPath(symbol) : null);
    const candidates = primaryPath ? [primaryPath, ...listLogFiles().filter((p) => p !== primaryPath)] : listLogFiles();
    const updatedAt = timestamp ?? new Date().toISOString();

    for (const logPath of candidates) {
        const updated = updateEntry(logPath, dealId, (existing) => {
            return {
                ...existing,
                stopLoss: typeof stopLoss !== "undefined" ? stopLoss : existing.stopLoss,
                takeProfit: typeof takeProfit !== "undefined" ? takeProfit : existing.takeProfit,
                lastUpdateAt: updatedAt,
                lastUpdateReason: reason ?? existing.lastUpdateReason ?? "",
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

                const closePrice = await this.getClosePrice(symbol, entry);
                const { reason: derivedReason, source: reasonSource } = deriveCloseReason({ entry, closePrice });

                logger.info(`[Reconcile] Derived close reason for ${id}: ${derivedReason} (source: ${reasonSource})`);
                console.log("closed deal id: ", id, "its entry: ", entry, "closePrice:", closePrice, "inferredReason:", derivedReason);

                // Compute REAL close indicators snapshot (current candles at closing time)
                const indicatorsClose = await this.getCloseIndicators(symbol);

                const updated = logTradeClose({
                    symbol: symbol ?? entry?.symbol ?? "unknown",
                    dealId: id,
                    closeReason: derivedReason,
                    indicators: indicatorsClose,
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

    inferCloseReason(entry, closePrice) {
        return inferCloseReasonFromPrice(entry, closePrice);
    }
}

export const tradeTracker = new TradeTracker();
