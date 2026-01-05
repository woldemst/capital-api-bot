import fs from "fs";
import path from "path";
import { getMarketDetails } from "../api.js";
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
    if (!reason) return "closed_";
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

export function getOpenTradesFromLogs() {
    const openEntries = [];
    const files = listLogFiles();

    for (const logPath of files) {
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
            if (entry?.status === "open" && entry?.dealId) {
                openEntries.push(entry);
            }
        }
    }

    return openEntries;
}

export function logTradeOpen({ symbol, dealId, signal, entryPrice, stopLoss, takeProfit, indicators }) {
    const logPath = getSymbolLogPath(symbol);
    const payload = {
        dealId,
        symbol,
        signal,
        openedAt: new Date().toISOString(),
        entryPrice,
        stopLoss,
        takeProfit,
        indicators,
        status: "open",
    };

    // console.log("payload",payload);

    appendLine(logPath, payload);
}

export function logTradeClose({ symbol, dealId, closeReason, indicators, closePrice }) {
    const reason = normalizeCloseReason(closeReason);
    const closedAt = new Date().toISOString();
    const primaryPath = symbol ? getSymbolLogPath(symbol) : null;
    const candidates = primaryPath ? [primaryPath, ...listLogFiles().filter((p) => p !== primaryPath)] : listLogFiles();

    for (const logPath of candidates) {
        const updated = updateEntry(logPath, dealId, (entry) => {
            const openedTimestamp = entry.openedAt ?? entry.timestamp ?? null;

            return {
                ...entry,
                openedAt: openedTimestamp,
                status: "closed",
                closeReason: reason,
                closedAt,
                closePrice: typeof closePrice !== "undefined" ? closePrice : entry.closePrice,
                indicatorsClose: indicators ?? entry.indicatorsClose ?? null,
            };
        });

        if (updated) return true;
    }

    return false;
}

class TradeTracker {
    constructor() {
        this.openDealIds = new Set();
        this.dealIdToSymbol = new Map();
        this.hydrateOpenDealsFromLogs();
    }

    hydrateOpenDealsFromLogs() {
        try {
            const openEntries = getOpenTradesFromLogs();
            openEntries.forEach((entry) => {
                const id = String(entry.dealId);
                this.openDealIds.add(id);
                if (entry.symbol) this.dealIdToSymbol.set(id, entry.symbol);
            });
            if (openEntries.length) {
                logger.info(`[Reconcile] Hydrated ${openEntries.length} open trades from logs.`);
            }
        } catch (err) {
            logger.warn(`[Reconcile] Failed to hydrate open trades from logs: ${err.message}`);
        }
    }

    registerOpenDeal(dealId, symbol) {
        if (!dealId) return;
        const id = String(dealId);
        this.openDealIds.add(id);
        if (symbol) this.dealIdToSymbol.set(id, symbol);
    }

    markDealClosed(dealId) {
        if (!dealId) return;
        const id = String(dealId);
        this.openDealIds.delete(id);
        this.dealIdToSymbol.delete(id);
    }

    async syncOpenPositions(positions = []) {
        const brokerDealIds = new Set();

        if (Array.isArray(positions)) {
            positions.forEach((p) => {
                const epic = p?.market?.epic || p?.position?.epic;
                const dealId = p?.position?.dealId ?? p?.dealId;
                if (!dealId) return;

                const id = String(dealId);
                brokerDealIds.add(id);
                this.openDealIds.add(id);
                if (epic) this.dealIdToSymbol.set(id, epic);
            });
        }

        await this.reconcileClosedDeals(brokerDealIds);
    }

    async reconcileClosedDeals(brokerDealIds = new Set()) {
        const missing = [];
        for (const id of this.openDealIds) {
            if (!brokerDealIds.has(id)) missing.push(id);
        }

        for (const id of missing) {
            const symbol = this.dealIdToSymbol.get(id);
            try {
                const { entry } = getTradeEntry(id, symbol);
                const closePrice = await this.getClosePrice(symbol, entry);
                const inferredReason = this.inferCloseReason(entry, closePrice);

                const updated = logTradeClose({
                    symbol,
                    dealId: id,
                    closeReason: inferredReason,
                    indicators: closePrice ? { price: closePrice } : null,
                    closePrice: closePrice ?? undefined,
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
