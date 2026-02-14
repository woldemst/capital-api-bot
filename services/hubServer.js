import http from "http";
import fs from "fs";
import path from "path";
import logger from "../utils/logger.js";
import Strategy from "../strategies/strategies.js";
import { SESSIONS, CRYPTO_SYMBOLS, RISK } from "../config.js";

const HUB_PORT = Number(process.env.HUB_PORT || process.env.DASHBOARD_PORT || 3001);
const LOG_DIR = path.join(process.cwd(), "backtest", "logs");
const PRICE_LOG_DIR = path.join(process.cwd(), "backtest", "prices");
const CLIENT_DIST_DIR = path.join(process.cwd(), "client", "dist");
const API_PREFIX = "/api";
const BACKTEST_STRATEGIES = {
    FOREX_H1_M15_M5: { variant: "H1_M15_M5", assetClass: "forex" },
    CRYPTO_H1_M15_M5: { variant: "H1_M15_M5", assetClass: "crypto" },
};
const BACKTEST_STRATEGY_IDS = Object.keys(BACKTEST_STRATEGIES);
const BACKTEST_SESSIONS = Object.keys(SESSIONS || {});
const CRYPTO_SYMBOL_SET = new Set((CRYPTO_SYMBOLS || []).map((symbol) => String(symbol).toUpperCase()));
const DEFAULT_MAX_HOLD_MINUTES = Number.isFinite(Number(RISK.MAX_HOLD_TIME)) ? Number(RISK.MAX_HOLD_TIME) : 300;

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
};

function sanitizeSymbol(symbol = "unknown") {
    return String(symbol || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? num : null;
}

function normalizeCloseReason(reason) {
    if (reason === undefined || reason === null || reason === "") return "unknown";
    const r = String(reason).toLowerCase();
    if (r === "unknown") return "unknown";
    if (r.includes("tp") || r.includes("take") || r.includes("limit") || r.includes("profit")) return "hit_tp";
    if (r.includes("sl") || r.includes("stop")) return "hit_sl";
    if (r.includes("timeout") || r.includes("time")) return "timeout";
    if (r.includes("manual")) return "manual_close";
    return String(reason);
}

function normalizeIndicator(indicator) {
    if (!indicator || typeof indicator !== "object") return null;
    const adxRaw = indicator.adx;
    const adx = typeof adxRaw === "number" ? { adx: adxRaw, pdi: null, mdi: null } : adxRaw ?? null;
    const macd = indicator.macd ?? null;
    return {
        rsi: indicator.rsi ?? null,
        adx,
        macd,
        atr: indicator.atr ?? null,
        ema9: indicator.ema9 ?? null,
        ema21: indicator.ema21 ?? null,
        ema20: indicator.ema20 ?? null,
        ema50: indicator.ema50 ?? null,
        price_vs_ema9: indicator.price_vs_ema9 ?? null,
        price_vs_ema21: indicator.price_vs_ema21 ?? null,
        bb: indicator.bb ?? null,
        trend: indicator.trend ?? null,
        isBullishCross: indicator.isBullishCross ?? null,
        isBearishCross: indicator.isBearishCross ?? null,
        backQuantScore: indicator.backQuantScore ?? null,
        backQuantSignal: indicator.backQuantSignal ?? null,
        lastClose: indicator.lastClose ?? indicator.close ?? null,
        close: indicator.close ?? indicator.lastClose ?? null,
    };
}

function normalizeIndicatorsByTimeframe(indicators) {
    if (!indicators || typeof indicators !== "object") return null;
    const timeframes = ["d1", "h4", "h1", "m15", "m5", "m1"];
    const normalized = {};
    for (const tf of timeframes) {
        normalized[tf] = normalizeIndicator(indicators[tf]);
    }
    return normalized;
}

function readJsonlFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const out = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line));
        } catch {
            continue;
        }
    }
    return out;
}

function loadTrades() {
    if (!fs.existsSync(LOG_DIR)) return [];
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl"));
    const trades = [];
    for (const file of files) {
        const raw = readJsonlFile(path.join(LOG_DIR, file));
        for (const entry of raw) {
            const signalRaw = String(entry.signal || "").toUpperCase();
            const signal = signalRaw === "SELL" ? "sell" : "buy";
            trades.push({
                dealId: String(entry.dealId ?? ""),
                symbol: String(entry.symbol ?? file.replace(".jsonl", "")),
                signal,
                entryPrice: toNumber(entry.entryPrice) ?? 0,
                stopLoss: toNumber(entry.stopLoss) ?? 0,
                takeProfit: toNumber(entry.takeProfit) ?? 0,
                openedAt: entry.openedAt ?? entry.timestamp ?? null,
                status: entry.status ?? "open",
                closeReason: normalizeCloseReason(entry.closeReason),
                closePrice: toNumber(entry.closePrice),
                closedAt: entry.closedAt ?? null,
                indicatorsOnOpening: normalizeIndicatorsByTimeframe(entry.indicatorsOnOpening),
                indicatorsOnClosing: normalizeIndicatorsByTimeframe(entry.indicatorsOnClosing),
                tradeStats: entry.tradeStats ?? null,
            });
        }
    }
    return trades;
}

function filterTrades(trades, { symbol, from, to, direction, closeReason, status } = {}) {
    const fromMs = from ? Date.parse(from) : null;
    const toMs = to ? Date.parse(to) : null;
    return trades.filter((trade) => {
        if (symbol && trade.symbol !== symbol) return false;
        if (direction && trade.signal !== String(direction).toLowerCase()) return false;
        if (status && String(trade.status).toLowerCase() !== String(status).toLowerCase()) return false;
        if (closeReason && String(trade.closeReason) !== String(closeReason)) return false;
        const openedAtMs = trade.openedAt ? Date.parse(trade.openedAt) : null;
        if (fromMs && (!openedAtMs || openedAtMs < fromMs)) return false;
        if (toMs && (!openedAtMs || openedAtMs > toMs)) return false;
        return true;
    });
}

function paginate(items, limit = 100, cursor) {
    const offset = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
    const slice = items.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    return {
        data: slice,
        hasMore: nextOffset < items.length,
        nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
    };
}

function computePnL(trade) {
    if (trade.closePrice === null || trade.closePrice === undefined) return 0;
    const diff = trade.signal === "buy" ? trade.closePrice - trade.entryPrice : trade.entryPrice - trade.closePrice;
    return Number.isFinite(diff) ? diff : 0;
}

function buildMetrics(trades) {
    const closed = trades.filter((t) => t.status === "closed" && t.closePrice !== null && t.closePrice !== undefined);
    const pnls = closed.map(computePnL);
    const totalPnL = pnls.reduce((a, b) => a + b, 0);
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0);
    const winRate = closed.length ? wins.length / closed.length : 0;
    const profitFactor = losses.length ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : wins.length ? 999 : 0;
    const expectancy = closed.length ? totalPnL / closed.length : 0;
    const durations = closed
        .map((t) => {
            const opened = t.openedAt ? Date.parse(t.openedAt) : NaN;
            const closedAt = t.closedAt ? Date.parse(t.closedAt) : NaN;
            if (!Number.isFinite(opened) || !Number.isFinite(closedAt)) return null;
            return (closedAt - opened) / 60000;
        })
        .filter((v) => v !== null);
    const avgTradeDurationMinutes = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    const sortedByClose = [...closed].sort((a, b) => {
        const ta = a.closedAt ? Date.parse(a.closedAt) : 0;
        const tb = b.closedAt ? Date.parse(b.closedAt) : 0;
        return ta - tb;
    });
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const t of sortedByClose) {
        equity += computePnL(t);
        if (equity > peak) peak = equity;
        const dd = equity - peak;
        if (dd < maxDrawdown) maxDrawdown = dd;
    }

    return {
        totalPnL,
        winRate,
        profitFactor,
        expectancy,
        maxDrawdown,
        avgTradeDurationMinutes,
        totalTrades: closed.length,
        wins: wins.length,
        losses: losses.length,
    };
}

function buildEquity(trades) {
    const closed = trades.filter((t) => t.status === "closed" && t.closePrice !== null && t.closePrice !== undefined);
    const sortedByClose = [...closed].sort((a, b) => {
        const ta = a.closedAt ? Date.parse(a.closedAt) : 0;
        const tb = b.closedAt ? Date.parse(b.closedAt) : 0;
        return ta - tb;
    });
    let equity = 0;
    const points = [];
    for (const t of sortedByClose) {
        equity += computePnL(t);
        points.push({
            timestamp: t.closedAt ?? t.openedAt ?? new Date().toISOString(),
            equity,
        });
    }
    return { points };
}

function buildDailyPnL(trades) {
    const closed = trades.filter((t) => t.status === "closed" && t.closePrice !== null && t.closePrice !== undefined);
    const byDay = new Map();
    for (const t of closed) {
        const ts = t.closedAt ?? t.openedAt;
        if (!ts) continue;
        const key = new Date(ts).toISOString().slice(0, 10);
        const prev = byDay.get(key) ?? 0;
        byDay.set(key, prev + computePnL(t));
    }
    const days = [...byDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, pnl]) => ({ date, pnl }));
    return { days };
}

function buildPatterns(trades) {
    const closed = trades.filter((t) => t.status === "closed" && t.closePrice !== null && t.closePrice !== undefined);
    const pnls = closed.map((t) => ({ trade: t, pnl: computePnL(t) }));

    const byCloseReason = new Map();
    const bySymbol = new Map();

    for (const { trade, pnl } of pnls) {
        const reasonKey = trade.closeReason ?? "unknown";
        const reason = byCloseReason.get(reasonKey) ?? { closeReason: reasonKey, count: 0, wins: 0 };
        reason.count += 1;
        if (pnl > 0) reason.wins += 1;
        byCloseReason.set(reasonKey, reason);

        const symbolKey = trade.symbol ?? "unknown";
        const symbol = bySymbol.get(symbolKey) ?? { symbol: symbolKey, count: 0, wins: 0, pnl: 0 };
        symbol.count += 1;
        symbol.pnl += pnl;
        if (pnl > 0) symbol.wins += 1;
        bySymbol.set(symbolKey, symbol);
    }

    const byCloseReasonArr = [...byCloseReason.values()].map((r) => ({
        closeReason: r.closeReason,
        count: r.count,
        winRate: r.count ? r.wins / r.count : 0,
    }));

    const bySymbolArr = [...bySymbol.values()].map((s) => ({
        symbol: s.symbol,
        count: s.count,
        winRate: s.count ? s.wins / s.count : 0,
        avgPnL: s.count ? s.pnl / s.count : 0,
    }));

    const indicatorKeys = ["rsi", "adx", "macd_histogram", "price_vs_ema9", "atr"];
    const indicatorDistributions = {};

    function extractIndicator(trade, key) {
        const m15 = trade.indicatorsOnOpening?.m15;
        if (!m15) return null;
        if (key === "rsi") return m15.rsi ?? null;
        if (key === "adx") return m15.adx?.adx ?? null;
        if (key === "macd_histogram") return m15.macd?.histogram ?? null;
        if (key === "price_vs_ema9") return m15.price_vs_ema9 ?? null;
        if (key === "atr") return m15.atr ?? null;
        return null;
    }

    for (const key of indicatorKeys) {
        const wins = pnls.filter((t) => t.pnl > 0).map((t) => extractIndicator(t.trade, key)).filter((v) => typeof v === "number");
        const losses = pnls.filter((t) => t.pnl <= 0).map((t) => extractIndicator(t.trade, key)).filter((v) => typeof v === "number");

        const all = [...wins, ...losses];
        if (!all.length) continue;
        const min = Math.min(...all);
        const max = Math.max(...all);
        const bucketCount = 12;
        const width = max === min ? 1 : (max - min) / bucketCount;
        const buckets = Array.from({ length: bucketCount }, (_, i) => min + i * width);
        const countBuckets = (values) => {
            const counts = Array.from({ length: bucketCount }, () => 0);
            for (const v of values) {
                const idx = Math.min(bucketCount - 1, Math.floor((v - min) / width));
                counts[idx] += 1;
            }
            return counts;
        };

        indicatorDistributions[key] = {
            wins: { buckets, counts: countBuckets(wins) },
            losses: { buckets, counts: countBuckets(losses) },
        };
    }

    const trendFade = pnls
        .map(({ trade, pnl }) => {
            const stats = trade.tradeStats;
            if (!stats || stats.mfePoints === null || stats.mfePoints === undefined) return null;
            const maxUnrealized = stats.mfePoints;
            if (maxUnrealized <= 0 || pnl >= 0) return null;
            return {
                dealId: trade.dealId,
                symbol: trade.symbol,
                maxUnrealized,
                finalPnL: pnl,
            };
        })
        .filter(Boolean);

    return {
        byCloseReason: byCloseReasonArr,
        bySymbol: bySymbolArr,
        indicatorDistributions,
        trendFade,
    };
}

function loadPriceSnapshots(symbol, { from, to } = {}) {
    if (!symbol) return [];
    const filePath = path.join(PRICE_LOG_DIR, `${sanitizeSymbol(symbol)}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const raw = readJsonlFile(filePath);
    const fromMs = from ? Date.parse(from) : null;
    const toMs = to ? Date.parse(to) : null;
    return raw
        .filter((row) => {
            const ts = Date.parse(row.timestamp || "");
            if (!Number.isFinite(ts)) return false;
            if (fromMs && ts < fromMs) return false;
            if (toMs && ts > toMs) return false;
            return true;
        })
        .map((row) => ({
            symbol: row.symbol ?? symbol,
            timestamp: row.timestamp,
            bid: row.bid ?? null,
            ask: row.ask ?? null,
            mid: row.mid ?? null,
            spread: row.spread ?? null,
            price: row.price ?? null,
            sessions: row.sessions ?? [],
            newsBlocked: row.newsBlocked ?? false,
            indicators: normalizeIndicatorsByTimeframe(row.indicators),
        }));
}

function parseCsvParam(value) {
    if (!value) return [];
    return String(value)
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
}

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === "") return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
    return defaultValue;
}

function parseTimestampMs(value) {
    if (!value) return null;
    const ts = Date.parse(String(value));
    return Number.isFinite(ts) ? ts : null;
}

function parseMinutes(hhmm) {
    if (typeof hhmm !== "string") return NaN;
    const [hh, mm] = hhmm.split(":").map((part) => Number(part));
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return NaN;
    return hh * 60 + mm;
}

function inSession(currentMinutes, startMinutes, endMinutes) {
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return false;
    if (startMinutes < endMinutes) return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function getSessionsAtTimestamp(timestamp) {
    const tsMs = parseTimestampMs(timestamp);
    if (!Number.isFinite(tsMs)) return [];
    const date = new Date(tsMs);
    const currentMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    const active = [];
    for (const [name, session] of Object.entries(SESSIONS || {})) {
        const startMinutes = parseMinutes(session?.START);
        const endMinutes = parseMinutes(session?.END);
        if (inSession(currentMinutes, startMinutes, endMinutes)) {
            active.push(String(name).toUpperCase());
        }
    }
    return active;
}

function matchesSessionFilter(timestamp, snapshotSessions, selectedSessionsSet) {
    if (!selectedSessionsSet.size) return true;
    const sessions = Array.isArray(snapshotSessions) && snapshotSessions.length
        ? snapshotSessions.map((s) => String(s).toUpperCase())
        : getSessionsAtTimestamp(timestamp);
    return sessions.some((s) => selectedSessionsSet.has(s));
}

function getPipSize(symbol) {
    return String(symbol || "").toUpperCase().includes("JPY") ? 0.01 : 0.0001;
}

function isCryptoSymbol(symbol) {
    return CRYPTO_SYMBOL_SET.has(String(symbol || "").toUpperCase());
}

function getEntryPrice(direction, snapshot) {
    if (direction === "buy") return toNumber(snapshot?.ask) ?? toNumber(snapshot?.mid) ?? toNumber(snapshot?.price);
    return toNumber(snapshot?.bid) ?? toNumber(snapshot?.mid) ?? toNumber(snapshot?.price);
}

function getExitPrice(direction, snapshot) {
    if (direction === "buy") return toNumber(snapshot?.bid) ?? toNumber(snapshot?.mid) ?? toNumber(snapshot?.price);
    return toNumber(snapshot?.ask) ?? toNumber(snapshot?.mid) ?? toNumber(snapshot?.price);
}

function summarizeTrades(strategyId, source, trades, sampleLimit = 200) {
    const closed = trades
        .filter((trade) => trade.status === "closed" && Number.isFinite(trade.entryPrice) && Number.isFinite(trade.closePrice))
        .map((trade) => {
            const pnlPoints = computePnL(trade);
            return {
                ...trade,
                pnlPoints,
            };
        });

    const wins = closed.filter((trade) => trade.pnlPoints > 0);
    const losses = closed.filter((trade) => trade.pnlPoints < 0);
    const totalPoints = closed.reduce((acc, trade) => acc + trade.pnlPoints, 0);
    const totalTrades = closed.length;
    const winRate = totalTrades ? wins.length / totalTrades : 0;
    const profitFactor = losses.length
        ? wins.reduce((acc, trade) => acc + trade.pnlPoints, 0) / Math.abs(losses.reduce((acc, trade) => acc + trade.pnlPoints, 0))
        : wins.length
          ? 999
          : 0;
    const expectancyPoints = totalTrades ? totalPoints / totalTrades : 0;

    const sortedByClose = [...closed].sort((a, b) => {
        const ta = parseTimestampMs(a.closedAt) ?? 0;
        const tb = parseTimestampMs(b.closedAt) ?? 0;
        return ta - tb;
    });

    let equity = 0;
    let peak = 0;
    let maxDrawdownPoints = 0;
    const equityPoints = [];
    for (const trade of sortedByClose) {
        equity += trade.pnlPoints;
        peak = Math.max(peak, equity);
        maxDrawdownPoints = Math.min(maxDrawdownPoints, equity - peak);
        equityPoints.push({
            timestamp: trade.closedAt ?? trade.openedAt ?? new Date().toISOString(),
            equity,
        });
    }

    const holdMinutes = closed
        .map((trade) => {
            const openedAtMs = parseTimestampMs(trade.openedAt);
            const closedAtMs = parseTimestampMs(trade.closedAt);
            if (!Number.isFinite(openedAtMs) || !Number.isFinite(closedAtMs)) return null;
            return (closedAtMs - openedAtMs) / 60000;
        })
        .filter((value) => value !== null);

    const closeReasonCounts = { hitTp: 0, hitSl: 0, timeout: 0, manualClose: 0, unknown: 0 };
    for (const trade of closed) {
        const reason = normalizeCloseReason(trade.closeReason);
        if (reason === "hit_tp") closeReasonCounts.hitTp += 1;
        else if (reason === "hit_sl") closeReasonCounts.hitSl += 1;
        else if (reason === "timeout") closeReasonCounts.timeout += 1;
        else if (reason === "manual_close") closeReasonCounts.manualClose += 1;
        else closeReasonCounts.unknown += 1;
    }

    const bySymbolMap = new Map();
    for (const trade of closed) {
        const symbol = String(trade.symbol || "unknown");
        const current = bySymbolMap.get(symbol) ?? { symbol, trades: 0, wins: 0, totalPoints: 0 };
        current.trades += 1;
        current.totalPoints += trade.pnlPoints;
        if (trade.pnlPoints > 0) current.wins += 1;
        bySymbolMap.set(symbol, current);
    }

    const bySymbol = [...bySymbolMap.values()]
        .map((item) => ({
            symbol: item.symbol,
            trades: item.trades,
            wins: item.wins,
            winRate: item.trades ? item.wins / item.trades : 0,
            totalPoints: item.totalPoints,
            avgPoints: item.trades ? item.totalPoints / item.trades : 0,
        }))
        .sort((a, b) => b.totalPoints - a.totalPoints);

    const tradesSample = [...closed]
        .sort((a, b) => (parseTimestampMs(b.openedAt) ?? 0) - (parseTimestampMs(a.openedAt) ?? 0))
        .slice(0, Math.max(1, Math.min(sampleLimit, 1000)))
        .map((trade) => ({
            dealId: trade.dealId,
            symbol: trade.symbol,
            signal: trade.signal,
            openedAt: trade.openedAt,
            closedAt: trade.closedAt,
            closeReason: trade.closeReason,
            entryPrice: trade.entryPrice,
            closePrice: trade.closePrice,
            pnlPoints: trade.pnlPoints,
        }));

    return {
        strategyId,
        source,
        totalTrades,
        wins: wins.length,
        losses: losses.length,
        winRate,
        totalPoints,
        expectancyPoints,
        profitFactor,
        maxDrawdownPoints,
        avgHoldMinutes: holdMinutes.length ? holdMinutes.reduce((a, b) => a + b, 0) / holdMinutes.length : 0,
        closeReasonCounts,
        bySymbol,
        equityPoints,
        tradesSample,
    };
}

function listAvailableSymbols() {
    if (!fs.existsSync(PRICE_LOG_DIR)) return [];
    return fs
        .readdirSync(PRICE_LOG_DIR)
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => file.replace(".jsonl", ""))
        .sort();
}

function buildBacktestOptions() {
    return {
        symbols: listAvailableSymbols(),
        sessions: BACKTEST_SESSIONS,
        strategies: [
            { id: "FOREX_H1_M15_M5", label: "Forex H1 / M15 / M5" },
            { id: "CRYPTO_H1_M15_M5", label: "Crypto H1 / M15 / M5" },
            { id: "logged_live", label: "Logged Live Strategy" },
        ],
        defaults: {
            maxHoldMinutes: DEFAULT_MAX_HOLD_MINUTES,
            includeLogged: true,
        },
    };
}

function runSimulationForVariant({ strategyId, variant, assetClass, symbols, fromMs, toMs, selectedSessionsSet, maxHoldMinutes }) {
    const allTrades = [];
    const maxHold = Number.isFinite(maxHoldMinutes) && maxHoldMinutes > 0 ? maxHoldMinutes : DEFAULT_MAX_HOLD_MINUTES;

    for (const symbol of symbols) {
        const symbolIsCrypto = isCryptoSymbol(symbol);
        if (assetClass === "crypto" && !symbolIsCrypto) continue;
        if (assetClass === "forex" && symbolIsCrypto) continue;

        const rows = loadPriceSnapshots(symbol).sort((a, b) => (parseTimestampMs(a.timestamp) ?? 0) - (parseTimestampMs(b.timestamp) ?? 0));
        if (!rows.length) continue;

        let openTrade = null;
        let tradeIndex = 0;

        for (const row of rows) {
            const tsMs = parseTimestampMs(row.timestamp);
            if (!Number.isFinite(tsMs)) continue;
            if (Number.isFinite(fromMs) && tsMs < fromMs) continue;
            if (Number.isFinite(toMs) && tsMs > toMs) continue;

            if (openTrade) {
                const currentExitPrice = getExitPrice(openTrade.signal, row);
                const minutesHeld = (tsMs - openTrade.openedAtMs) / 60000;
                if (Number.isFinite(currentExitPrice)) {
                    let closePrice = null;
                    let closeReason = null;

                    if (openTrade.signal === "buy") {
                        if (currentExitPrice >= openTrade.takeProfit) {
                            closePrice = openTrade.takeProfit;
                            closeReason = "hit_tp";
                        } else if (currentExitPrice <= openTrade.stopLoss) {
                            closePrice = openTrade.stopLoss;
                            closeReason = "hit_sl";
                        }
                    } else if (currentExitPrice <= openTrade.takeProfit) {
                        closePrice = openTrade.takeProfit;
                        closeReason = "hit_tp";
                    } else if (currentExitPrice >= openTrade.stopLoss) {
                        closePrice = openTrade.stopLoss;
                        closeReason = "hit_sl";
                    }

                    if (!closeReason && minutesHeld >= maxHold) {
                        closePrice = currentExitPrice;
                        closeReason = "timeout";
                    }

                    if (closeReason) {
                        allTrades.push({
                            ...openTrade,
                            status: "closed",
                            closePrice,
                            closeReason,
                            closedAt: row.timestamp,
                        });
                        openTrade = null;
                    }
                }
            }

            if (openTrade) continue;
            if (row.newsBlocked) continue;
            if (!matchesSessionFilter(row.timestamp, row.sessions, selectedSessionsSet)) continue;

            const signalResult =
                assetClass === "crypto"
                    ? Strategy.generateSignal3StageCrypto({ indicators: row.indicators, variant })
                    : Strategy.generateSignal3StageForex({ indicators: row.indicators, variant });
            const signal = String(signalResult?.signal || "").toUpperCase();
            if (signal !== "BUY" && signal !== "SELL") continue;

            const direction = signal === "BUY" ? "buy" : "sell";
            const entryPrice = getEntryPrice(direction, row);
            if (!Number.isFinite(entryPrice)) continue;

            const spread = toNumber(row.spread) ?? Math.abs((toNumber(row.ask) ?? entryPrice) - (toNumber(row.bid) ?? entryPrice));
            const atr = toNumber(row?.indicators?.m15?.atr);
            let stopDistance;
            let takeProfitDistance;

            if (assetClass === "crypto") {
                const fallbackDistance = Math.max(entryPrice * 0.0045, (Number.isFinite(spread) ? spread : 0) * 3);
                stopDistance = Math.max(
                    Number.isFinite(atr) ? 2.2 * atr : 0,
                    Number.isFinite(spread) ? spread * 3 : 0,
                    fallbackDistance,
                );
                takeProfitDistance = stopDistance * 1.8;
            } else {
                const fallbackStop = 8 * getPipSize(symbol);
                stopDistance = Math.max(
                    Number.isFinite(atr) ? 1.5 * atr : 0,
                    Number.isFinite(spread) ? spread * 2 : 0,
                    fallbackStop,
                );
                takeProfitDistance = stopDistance * 2;
            }

            const stopLoss = direction === "buy" ? entryPrice - stopDistance : entryPrice + stopDistance;
            const takeProfit = direction === "buy" ? entryPrice + takeProfitDistance : entryPrice - takeProfitDistance;

            tradeIndex += 1;
            openTrade = {
                dealId: `sim_${strategyId}_${symbol}_${tsMs}_${tradeIndex}`,
                symbol,
                signal: direction,
                entryPrice,
                stopLoss,
                takeProfit,
                openedAt: row.timestamp,
                openedAtMs: tsMs,
                status: "open",
                closeReason: null,
            };
        }

        if (openTrade) {
            const lastRow = rows
                .filter((row) => {
                    const tsMs = parseTimestampMs(row.timestamp);
                    if (!Number.isFinite(tsMs)) return false;
                    if (Number.isFinite(fromMs) && tsMs < fromMs) return false;
                    if (Number.isFinite(toMs) && tsMs > toMs) return false;
                    return true;
                })
                .slice(-1)[0];
            const closePrice = getExitPrice(openTrade.signal, lastRow);
            if (lastRow && Number.isFinite(closePrice)) {
                allTrades.push({
                    ...openTrade,
                    status: "closed",
                    closePrice,
                    closeReason: "manual_close",
                    closedAt: lastRow.timestamp,
                });
            }
        }
    }

    return allTrades;
}

function buildLoggedStrategyTrades({ symbols, fromMs, toMs, selectedSessionsSet }) {
    const symbolSet = new Set((symbols || []).map((symbol) => String(symbol).toUpperCase()));
    const trades = loadTrades().filter((trade) => {
        if (!trade.openedAt) return false;
        if (symbolSet.size && !symbolSet.has(String(trade.symbol || "").toUpperCase())) return false;
        const openedAtMs = parseTimestampMs(trade.openedAt);
        if (!Number.isFinite(openedAtMs)) return false;
        if (Number.isFinite(fromMs) && openedAtMs < fromMs) return false;
        if (Number.isFinite(toMs) && openedAtMs > toMs) return false;
        if (!matchesSessionFilter(trade.openedAt, null, selectedSessionsSet)) return false;
        if (trade.status !== "closed") return false;
        if (!Number.isFinite(trade.entryPrice) || !Number.isFinite(trade.closePrice)) return false;
        return true;
    });
    return trades;
}

function sendJson(res, code, payload) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function getContentType(filePath) {
    return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function resolveStaticFilePath(urlPath) {
    const relPath = decodeURIComponent(urlPath).replace(/^\/+/, "");
    const candidatePath = path.resolve(CLIENT_DIST_DIR, relPath || "index.html");
    const distRoot = path.resolve(CLIENT_DIST_DIR);
    if (candidatePath !== distRoot && !candidatePath.startsWith(`${distRoot}${path.sep}`)) return null;
    return candidatePath;
}

function tryServeStatic(urlPath, res) {
    if (!fs.existsSync(CLIENT_DIST_DIR)) return false;

    const staticPath = resolveStaticFilePath(urlPath);
    if (!staticPath) {
        sendJson(res, 400, { error: "Bad request" });
        return true;
    }

    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        res.writeHead(200, { "Content-Type": getContentType(staticPath) });
        res.end(fs.readFileSync(staticPath));
        return true;
    }

    const indexPath = path.join(CLIENT_DIST_DIR, "index.html");
    if (!fs.existsSync(indexPath)) return false;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(indexPath));
    return true;
}

export function startHubServer() {
    const server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Cache-Control", "no-store");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
        }

        const baseUrl = `http://${req.headers.host || "localhost"}`;
        const url = new URL(req.url, baseUrl);
        const pathName = url.pathname;

        try {
            if (pathName === "/health") {
                sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString() });
                return;
            }

            if (pathName === API_PREFIX || pathName === `${API_PREFIX}/health`) {
                sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString() });
                return;
            }

            const isApiRequest = pathName.startsWith(`${API_PREFIX}/`);
            const apiPath = isApiRequest ? pathName.slice(API_PREFIX.length) : null;

            if (apiPath === "/backtest/options") {
                sendJson(res, 200, buildBacktestOptions());
                return;
            }

            if (apiPath === "/backtest/compare") {
                const availableSymbols = new Set(listAvailableSymbols().map((symbol) => String(symbol).toUpperCase()));
                const requestedSymbols = parseCsvParam(url.searchParams.get("symbols"));
                const symbols = (requestedSymbols.length ? requestedSymbols : [...availableSymbols]).filter((symbol) =>
                    availableSymbols.has(String(symbol).toUpperCase()),
                );

                if (!symbols.length) {
                    sendJson(res, 400, { error: "No valid symbols selected for backtest." });
                    return;
                }

                const requestedSessions = parseCsvParam(url.searchParams.get("sessions")).map((session) => String(session).toUpperCase());
                const selectedSessions = requestedSessions.filter((session) => BACKTEST_SESSIONS.includes(session));
                const selectedSessionsSet = new Set(selectedSessions);

                const requestedStrategies = parseCsvParam(url.searchParams.get("strategies")).map((strategy) => String(strategy));
                const selectedStrategyIds = (requestedStrategies.length ? requestedStrategies : BACKTEST_STRATEGY_IDS).filter((strategyId) =>
                    BACKTEST_STRATEGY_IDS.includes(strategyId),
                );
                const includeLogged = parseBoolean(url.searchParams.get("includeLogged"), true) || requestedStrategies.includes("logged_live");
                const maxHoldMinutes = toNumber(url.searchParams.get("maxHoldMinutes")) ?? DEFAULT_MAX_HOLD_MINUTES;
                const sampleLimit = toNumber(url.searchParams.get("sampleLimit")) ?? 200;
                const from = url.searchParams.get("from");
                const to = url.searchParams.get("to");
                const fromMs = parseTimestampMs(from);
                const toMs = parseTimestampMs(to);

                const strategyResults = [];

                for (const strategyId of selectedStrategyIds) {
                    const strategyConfig = BACKTEST_STRATEGIES[strategyId];
                    if (!strategyConfig) continue;
                    const simulationTrades = runSimulationForVariant({
                        strategyId,
                        variant: strategyConfig.variant,
                        assetClass: strategyConfig.assetClass,
                        symbols,
                        fromMs,
                        toMs,
                        selectedSessionsSet,
                        maxHoldMinutes,
                    });
                    strategyResults.push(summarizeTrades(strategyId, "simulation", simulationTrades, sampleLimit));
                }

                if (includeLogged) {
                    const loggedTrades = buildLoggedStrategyTrades({
                        symbols,
                        fromMs,
                        toMs,
                        selectedSessionsSet,
                    });
                    strategyResults.push(summarizeTrades("logged_live", "logs", loggedTrades, sampleLimit));
                }

                if (!strategyResults.length) {
                    sendJson(res, 400, { error: "No valid strategies selected for comparison." });
                    return;
                }

                strategyResults.sort((a, b) => b.totalPoints - a.totalPoints);

                sendJson(res, 200, {
                    generatedAt: new Date().toISOString(),
                    filtersApplied: {
                        from: from ?? null,
                        to: to ?? null,
                        symbols,
                        sessions: selectedSessions,
                        strategies: strategyResults.map((result) => result.strategyId),
                        maxHoldMinutes,
                    },
                    strategyResults,
                });
                return;
            }

            if (apiPath === "/trades") {
                const trades = loadTrades();
                const filtered = filterTrades(trades, {
                    symbol: url.searchParams.get("symbol") || undefined,
                    from: url.searchParams.get("from") || undefined,
                    to: url.searchParams.get("to") || undefined,
                    direction: url.searchParams.get("direction") || undefined,
                    closeReason: url.searchParams.get("closeReason") || undefined,
                    status: url.searchParams.get("status") || undefined,
                });

                filtered.sort((a, b) => {
                    const ta = a.openedAt ? Date.parse(a.openedAt) : 0;
                    const tb = b.openedAt ? Date.parse(b.openedAt) : 0;
                    return tb - ta;
                });

                const limit = toNumber(url.searchParams.get("limit")) ?? 100;
                const cursor = url.searchParams.get("cursor") ?? undefined;
                const result = paginate(filtered, limit, cursor);

                sendJson(res, 200, result);
                return;
            }

            if (apiPath && apiPath.startsWith("/trades/")) {
                const dealId = decodeURIComponent(apiPath.replace("/trades/", ""));
                const trades = loadTrades();
                const trade = trades.find((t) => t.dealId === dealId);
                if (!trade) {
                    sendJson(res, 404, { error: "Trade not found" });
                    return;
                }
                sendJson(res, 200, trade);
                return;
            }

            if (apiPath === "/metrics/summary") {
                const trades = filterTrades(loadTrades(), {
                    symbol: url.searchParams.get("symbol") || undefined,
                    from: url.searchParams.get("from") || undefined,
                    to: url.searchParams.get("to") || undefined,
                });
                const metrics = buildMetrics(trades);
                sendJson(res, 200, metrics);
                return;
            }

            if (apiPath === "/metrics/equity") {
                const trades = filterTrades(loadTrades(), {
                    symbol: url.searchParams.get("symbol") || undefined,
                    from: url.searchParams.get("from") || undefined,
                    to: url.searchParams.get("to") || undefined,
                });
                const equity = buildEquity(trades);
                sendJson(res, 200, equity);
                return;
            }

            if (apiPath === "/metrics/daily-pnl") {
                const trades = filterTrades(loadTrades(), {
                    symbol: url.searchParams.get("symbol") || undefined,
                    from: url.searchParams.get("from") || undefined,
                    to: url.searchParams.get("to") || undefined,
                });
                const daily = buildDailyPnL(trades);
                sendJson(res, 200, daily);
                return;
            }

            if (apiPath === "/patterns") {
                const trades = filterTrades(loadTrades(), {
                    symbol: url.searchParams.get("symbol") || undefined,
                    from: url.searchParams.get("from") || undefined,
                    to: url.searchParams.get("to") || undefined,
                });
                const patterns = buildPatterns(trades);
                sendJson(res, 200, patterns);
                return;
            }

            if (apiPath === "/prices") {
                const symbol = url.searchParams.get("symbol") || "";
                if (!symbol) {
                    sendJson(res, 400, { error: "symbol is required" });
                    return;
                }
                const from = url.searchParams.get("from") || undefined;
                const to = url.searchParams.get("to") || undefined;
                const limit = toNumber(url.searchParams.get("limit")) ?? 200;
                const cursor = url.searchParams.get("cursor") ?? undefined;
                const snapshots = loadPriceSnapshots(symbol, { from, to }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
                const result = paginate(snapshots, limit, cursor);
                sendJson(res, 200, result);
                return;
            }

            if (isApiRequest) {
                sendJson(res, 404, { error: "Not found" });
                return;
            }

            if (tryServeStatic(pathName, res)) {
                return;
            }

            sendJson(res, 404, { error: "UI build not found. Run: cd client && npm run build" });
        } catch (error) {
            logger.error("[Hub] Request error:", error);
            sendJson(res, 500, { error: "Internal server error" });
        }
    });

    server.listen(HUB_PORT, () => {
        logger.info(`[Hub] API/UI listening on http://localhost:${HUB_PORT}`);
    });

    return server;
}
