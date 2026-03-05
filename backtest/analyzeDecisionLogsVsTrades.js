import fs from "fs";
import path from "path";

const DECISION_DIR = path.join(process.cwd(), "backtest", "decision-logs");
const TRADE_LOG_DIR = path.join(process.cwd(), "backtest", "logs");
const LOOKBACK_DAYS = Number(process.env.BT_DECISION_DAYS || 3);
const SYMBOL_FILTER = new Set(
    String(process.env.BT_DECISION_SYMBOLS || "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
);

function loadJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of lines) {
        try {
            rows.push(JSON.parse(line));
        } catch {
            // ignore malformed line
        }
    }
    return rows;
}

function minuteKey(tsMs) {
    return new Date(tsMs).toISOString().slice(0, 16);
}

function countBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
        const key = keyFn(item);
        map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function normalizeSide(sideOrSignal) {
    const s = String(sideOrSignal || "").toUpperCase();
    if (s === "BUY" || s === "LONG") return "LONG";
    if (s === "SELL" || s === "SHORT") return "SHORT";
    return null;
}

function readDecisionWindow() {
    if (!fs.existsSync(DECISION_DIR)) {
        return { startTs: 0, endTs: 0, events: [] };
    }

    const files = fs.readdirSync(DECISION_DIR).filter((f) => f.endsWith(".jsonl"));
    const events = [];
    let endTs = 0;
    for (const file of files) {
        const symbol = file.replace(".jsonl", "").toUpperCase();
        for (const row of loadJsonl(path.join(DECISION_DIR, file))) {
            const tsMs = Date.parse(String(row?.timestamp || ""));
            if (!Number.isFinite(tsMs)) continue;
            if (tsMs > endTs) endTs = tsMs;
            events.push({
                ...row,
                symbol: String(row?.symbol || symbol).toUpperCase(),
                tsMs,
            });
        }
    }

    const startTs = endTs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const filtered = events
        .filter((e) => e.tsMs >= startTs && e.tsMs <= endTs)
        .filter((e) => !SYMBOL_FILTER.size || SYMBOL_FILTER.has(e.symbol))
        .sort((a, b) => a.tsMs - b.tsMs);
    return { startTs, endTs, events: filtered };
}

function readActualTradesWindow(startTs, endTs) {
    if (!fs.existsSync(TRADE_LOG_DIR)) return [];
    const files = fs.readdirSync(TRADE_LOG_DIR).filter((f) => f.endsWith(".jsonl"));
    const trades = [];
    for (const file of files) {
        const symbol = file.replace(".jsonl", "").toUpperCase();
        for (const row of loadJsonl(path.join(TRADE_LOG_DIR, file))) {
            const openedAtMs = Date.parse(String(row?.openedAt || row?.timestamp || ""));
            if (!Number.isFinite(openedAtMs)) continue;
            if (openedAtMs < startTs || openedAtMs > endTs) continue;
            trades.push({
                symbol,
                openedAtMs,
                side: normalizeSide(row?.signal),
            });
        }
    }
    return trades
        .filter((t) => !SYMBOL_FILTER.size || SYMBOL_FILTER.has(t.symbol))
        .sort((a, b) => a.openedAtMs - b.openedAtMs);
}

function main() {
    const { startTs, endTs, events } = readDecisionWindow();
    if (!events.length) {
        console.log("No decision logs found in backtest/decision-logs for analysis.");
        return;
    }

    const actualTrades = readActualTradesWindow(startTs, endTs);

    const orderAttempts = events.filter((e) => String(e.event || "").toLowerCase() === "order_attempt");
    const orderResults = events.filter((e) => String(e.event || "").toLowerCase() === "order_result");
    const accepted = orderResults.filter((e) => Boolean(e?.execution?.accepted));
    const rejected = orderResults.filter((e) => !Boolean(e?.execution?.accepted));
    const blocked = events.filter((e) => String(e.event || "").toLowerCase() === "blocked");
    const noSignal = events.filter((e) => String(e.event || "").toLowerCase() === "no_signal");

    const decisionEntries = accepted.map((e) => ({
        symbol: e.symbol,
        tsMs: e.tsMs,
        side: normalizeSide(e?.side || e?.signal),
        key: `${e.symbol}|${minuteKey(e.tsMs)}`,
    }));
    const actualEntries = actualTrades.map((t) => ({
        symbol: t.symbol,
        tsMs: t.openedAtMs,
        side: t.side,
        key: `${t.symbol}|${minuteKey(t.openedAtMs)}`,
    }));

    const actualSet = new Set(actualEntries.map((e) => e.key));
    const decisionSet = new Set(decisionEntries.map((e) => e.key));
    const matched = decisionEntries.filter((e) => actualSet.has(e.key));
    const decisionOnly = decisionEntries.filter((e) => !actualSet.has(e.key));
    const actualOnly = actualEntries.filter((e) => !decisionSet.has(e.key));

    console.log("=== WINDOW ===");
    console.log(`${new Date(startTs).toISOString()} -> ${new Date(endTs).toISOString()}`);

    console.log("\n=== DECISION FEED SUMMARY ===");
    console.log(
        JSON.stringify(
            {
                totalEvents: events.length,
                noSignal: noSignal.length,
                blocked: blocked.length,
                orderAttempts: orderAttempts.length,
                orderResults: orderResults.length,
                acceptedOrders: accepted.length,
                rejectedOrders: rejected.length,
                uniqueConfigHashes: [...new Set(events.map((e) => e.configHash).filter(Boolean))].length,
            },
            null,
            2,
        ),
    );

    console.log("\n=== ENTRY COMPARISON (DECISION LOGS VS ACTUAL) ===");
    console.log(
        JSON.stringify(
            {
                decisionEntries: decisionEntries.length,
                actualEntries: actualEntries.length,
                matchedSameMinuteSameSymbol: matched.length,
                decisionOnly: decisionOnly.length,
                actualOnly: actualOnly.length,
            },
            null,
            2,
        ),
    );

    console.log("\n=== TOP BLOCK REASONS ===");
    console.log(JSON.stringify(countBy(blocked, (e) => e.blockReason || "unknown").slice(0, 20).map(([reason, count]) => ({ reason, count })), null, 2));

    console.log("\n=== TOP REJECT REASONS ===");
    console.log(
        JSON.stringify(
            countBy(rejected, (e) => e?.execution?.brokerReason || e?.execution?.reason || e?.reason || "unknown")
                .slice(0, 20)
                .map(([reason, count]) => ({ reason, count })),
            null,
            2,
        ),
    );

    console.log("\n=== DECISION ENTRIES BY SYMBOL ===");
    console.log(JSON.stringify(countBy(decisionEntries, (e) => e.symbol).map(([symbol, count]) => ({ symbol, count })), null, 2));

    console.log("\n=== ACTUAL ENTRIES BY SYMBOL ===");
    console.log(JSON.stringify(countBy(actualEntries, (e) => e.symbol).map(([symbol, count]) => ({ symbol, count })), null, 2));
}

main();
