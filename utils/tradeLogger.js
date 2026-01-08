import fs from "fs";
import path from "path";
import { getMarketDetails, getHistorical } from "../api.js";
import { calcIndicators } from "../indicators/indicators.js";
import logger from "./logger.js";

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
    if (!reason) return "closed_manually";
    const r = String(reason).toLowerCase();
    if (r === "tp" || r === "take_profit" || r.includes("take")) return "hit_tp";
    if (r === "sl" || r === "stop_loss" || r.includes("stop")) return "hit_sl";
    if (r.includes("timeout") || r.includes("time")) return "timeout";
    return reason;
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

export function logTradeOpen({ dealId, symbol, signal, entryPrice, stopLoss, takeProfit, indicators, timestamp }) {
    const logPath = getSymbolLogPath(symbol);
    const payload = {
        dealId,
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
}

export function logTradeClose({ dealId, symbol, closePrice, closeReason, indicators, timestamp }) {
    const reason = normalizeCloseReason(closeReason);
    const closedAt = timestamp;
    const primaryPath = symbol ? getSymbolLogPath(symbol) : null;
    const candidates = primaryPath ? [primaryPath, ...listLogFiles().filter((p) => p !== primaryPath)] : listLogFiles();

    for (const logPath of candidates) {
        const updated = updateEntry(logPath, dealId, (entry) => {
            const openedTimestamp = entry.openedAt ?? entry.timestamp ?? null;

            // Prefer caller-provided close indicators; otherwise keep existing; otherwise reuse open indicators
            // Ensure it has the same structure as `entry.indicators` so you can compare easily.
            const base = entry.indicators ?? null;
            const incoming = indicators ?? entry.indicatorsClose ?? null;

            let indicatorsClose = incoming;
            if (base && incoming && typeof incoming === "object") {
                indicatorsClose = { ...base, ...incoming };
            } else if (base && !incoming) {
                indicatorsClose = { ...base };
            }

            // Always ensure price exists if we know it
            if (indicatorsClose && typeof indicatorsClose === "object" && typeof closePrice !== "undefined" && closePrice !== null) {
                indicatorsClose.price = closePrice;
            }

            return {
                ...entry,
                openedAt: openedTimestamp,
                status: "closed",
                closeReason: reason,
                closedAt,
                closePrice: typeof closePrice !== "undefined" ? closePrice : entry.closePrice ?? null,
                indicatorsClose: indicatorsClose ?? null,
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

    async getCloseIndicators(symbol, closePrice) {
        if (!symbol) return closePrice ? { price: closePrice } : null;

        // Use the same timeframes you log at entry (adjust if your entry log includes more/less)
        const HISTORY = 200;
        const TF = {
            h4: "HOUR_4",
            h1: "HOUR",
            m15: "MINUTE_15",
            m5: "MINUTE_5",
            // m1: "MINUTE", // enable if you also log m1 on entry
        };

        try {
            const [h4Data, h1Data, m15Data, m5Data] = await Promise.all([
                getHistorical(symbol, TF.h4, HISTORY),
                getHistorical(symbol, TF.h1, HISTORY),
                getHistorical(symbol, TF.m15, HISTORY),
                getHistorical(symbol, TF.m5, HISTORY),
            ]);

            const h4Candles = Array.isArray(h4Data?.prices) ? h4Data.prices.slice(-HISTORY) : [];
            const h1Candles = Array.isArray(h1Data?.prices) ? h1Data.prices.slice(-HISTORY) : [];
            const m15Candles = Array.isArray(m15Data?.prices) ? m15Data.prices.slice(-HISTORY) : [];
            const m5Candles = Array.isArray(m5Data?.prices) ? m5Data.prices.slice(-HISTORY) : [];

            const indicatorsClose = {
                price: closePrice ?? null,
                h4: h4Candles.length ? await calcIndicators(h4Candles, symbol, TF.h4) : null,
                h1: h1Candles.length ? await calcIndicators(h1Candles, symbol, TF.h1) : null,
                m15: m15Candles.length ? await calcIndicators(m15Candles, symbol, TF.m15) : null,
                m5: m5Candles.length ? await calcIndicators(m5Candles, symbol, TF.m5) : null,
            };

            return indicatorsClose;
        } catch (err) {
            logger.warn(`[Reconcile] Close-indicators calc failed for ${symbol}: ${err.message}`);
            return closePrice ? { price: closePrice } : null;
        }
    }

    async reconcileClosedDeals(closedDealsIds = []) {
        if (!Array.isArray(closedDealsIds) || !closedDealsIds.length) return;

        for (const id of closedDealsIds) {
            // Prefer known symbol mappings; broker mapping is what your DealID monitor populates
            let symbol = this.dealIdToSymbol.get(id) || this.dealIdToSymbolBrocker.get(id) || null;
            try {
                console.log('its', id, symbol);
                
                const { entry } = getTradeEntry(id, symbol);

                // If symbol wasn't mapped (e.g., after restart), fallback to the symbol stored in the log entry
                if (!symbol) symbol = entry?.symbol ? String(entry.symbol) : null;

                const closePrice = await this.getClosePrice(symbol, entry);
                const inferredReason = this.inferCloseReason(entry, closePrice);

                console.log('closed deal id: ', id,'its entry: ', entry, 'closePrice:', closePrice, 'inferredReason:', inferredReason);
                
                // Compute REAL close indicators snapshot (current candles at closing time)
                const indicatorsClose = await this.getCloseIndicators(symbol, closePrice);

                const updated = logTradeClose({
                    symbol: symbol ?? entry?.symbol ?? "unknown",
                    dealId: id,
                    closeReason: inferredReason,
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

        const distToSL = Math.abs(closePrice - stopLoss);
        const distToTP = Math.abs(closePrice - takeProfit);
        return distToTP < distToSL ? "hit_tp" : "hit_sl";
    }
}

export const tradeTracker = new TradeTracker();
