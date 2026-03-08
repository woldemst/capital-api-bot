import fs from "fs";
import path from "path";
import {
    STRATEGIES,
    RISK,
} from "../config.js";
import {
    computeStrategyTradeCountersForDay,
    evaluateCryptoLiquidityWindowMomentum,
    getMinutesInTimeZone,
    isMinuteInWindow,
    parseHhMmToMinutes,
} from "../strategies/cryptoLiquidityWindowMomentum.js";

const DATA_DIR = path.join(process.cwd(), "backtest", "generated-dataset");
const TARGET_SYMBOLS = String(process.env.CRYPTO_REPLAY_SYMBOLS || process.env.LIVE_PARITY_SYMBOLS || "BTCUSD")
    .split(",")
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
const RANGE_START = String(process.env.CRYPTO_REPLAY_FROM || process.env.LIVE_PARITY_FROM || "").trim();
const RANGE_END = String(process.env.CRYPTO_REPLAY_TO || process.env.LIVE_PARITY_TO || "").trim();
const START_CAPITAL = Number.isFinite(Number(process.env.CRYPTO_REPLAY_START_CAPITAL))
    ? Number(process.env.CRYPTO_REPLAY_START_CAPITAL)
    : 500;
const MAX_POSITIONS = Number.isFinite(Number(process.env.CRYPTO_REPLAY_MAX_POSITIONS))
    ? Number(process.env.CRYPTO_REPLAY_MAX_POSITIONS)
    : Number(RISK?.MAX_POSITIONS) || 5;
const MAX_OPEN_RISK_PCT = Number.isFinite(Number(process.env.CRYPTO_REPLAY_MAX_OPEN_RISK_PCT))
    ? Number(process.env.CRYPTO_REPLAY_MAX_OPEN_RISK_PCT)
    : Number(RISK?.GUARDS?.MAX_OPEN_RISK_PCT) || 0.25;
const REPORT_JSON_PATH = String(process.env.CRYPTO_REPLAY_REPORT_PATH || "").trim();
const CONFIG_OVERRIDE_JSON = String(process.env.CRYPTO_REPLAY_CONFIG_OVERRIDE_JSON || "").trim();
const CONFIG_OVERRIDE_FILE = String(process.env.CRYPTO_REPLAY_CONFIG_OVERRIDE_FILE || "").trim();
const SAME_BAR_FILL_PRIORITY = String(process.env.CRYPTO_REPLAY_SAME_BAR_FILL_PRIORITY || "STOP_FIRST").trim().toUpperCase();

function toNum(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function parseTs(raw) {
    const ts = Date.parse(String(raw || ""));
    return Number.isFinite(ts) ? ts : null;
}

function num(value, digits = 2) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a";
}

function pct(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";
}

function isoDate(tsMs) {
    return new Date(tsMs).toISOString().slice(0, 10);
}

function weekStartUtc(tsMs) {
    const d = new Date(tsMs);
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
}

function mergeObjects(baseValue, overrideValue) {
    const base = baseValue && typeof baseValue === "object" && !Array.isArray(baseValue) ? baseValue : {};
    const override = overrideValue && typeof overrideValue === "object" && !Array.isArray(overrideValue) ? overrideValue : {};
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
            out[key] = mergeObjects(out[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function parseOverrides() {
    if (CONFIG_OVERRIDE_JSON) return JSON.parse(CONFIG_OVERRIDE_JSON);
    if (CONFIG_OVERRIDE_FILE) {
        const file = path.isAbsolute(CONFIG_OVERRIDE_FILE) ? CONFIG_OVERRIDE_FILE : path.join(process.cwd(), CONFIG_OVERRIDE_FILE);
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    return {};
}

function loadJsonl(filePath) {
    return fs
        .readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .map((row) => ({
            ...row,
            tsMs: parseTs(row.timestamp || row.time || row.t),
            o: toNum(row.open ?? row.o),
            h: toNum(row.high ?? row.h),
            l: toNum(row.low ?? row.l),
            c: toNum(row.close ?? row.c),
            v: toNum(row.volume ?? row.v),
        }))
        .filter((row) => Number.isFinite(row.tsMs) && Number.isFinite(row.c))
        .sort((a, b) => a.tsMs - b.tsMs);
}

function loadSymbolData(symbol) {
    const m5Path = path.join(DATA_DIR, `${symbol}_M5.jsonl`);
    const h1Path = path.join(DATA_DIR, `${symbol}_H1.jsonl`);
    if (!fs.existsSync(m5Path) || !fs.existsSync(h1Path)) return null;
    return {
        M5: loadJsonl(m5Path),
        H1: loadJsonl(h1Path),
    };
}

function resolveRange(symbolData) {
    const requestedStart = parseTs(RANGE_START);
    const requestedEnd = parseTs(RANGE_END);
    const starts = [];
    const ends = [];
    for (const data of symbolData.values()) {
        if (!data?.M5?.length || !data?.H1?.length) continue;
        starts.push(Math.max(data.M5[0].tsMs, data.H1[0].tsMs));
        ends.push(Math.min(data.M5[data.M5.length - 1].tsMs, data.H1[data.H1.length - 1].tsMs));
    }
    const actualStart = Math.max(requestedStart || -Infinity, ...starts);
    const actualEnd = Math.min(requestedEnd || Infinity, ...ends);
    if (!Number.isFinite(actualStart) || !Number.isFinite(actualEnd) || actualEnd <= actualStart) {
        throw new Error("No overlapping crypto range.");
    }
    return { actualStart, actualEnd };
}

function ensureWeek(weeklyStats, tsMs, equity) {
    const key = weekStartUtc(tsMs);
    if (!weeklyStats.has(key)) {
        weeklyStats.set(key, {
            week: isoDate(key),
            trades: 0,
            wins: 0,
            losses: 0,
            rawPnl: 0,
            startEquity: equity,
            endEquity: equity,
            peakEquity: equity,
            maxDdPct: 0,
        });
    }
    return weeklyStats.get(key);
}

function ensurePair(pairStats, symbol) {
    if (!pairStats.has(symbol)) {
        pairStats.set(symbol, {
            symbol,
            trades: 0,
            wins: 0,
            losses: 0,
            rawPnl: 0,
            grossWin: 0,
            grossLoss: 0,
            holdMinutes: [],
        });
    }
    return pairStats.get(symbol);
}

function markWeekPeakAndDd(week, equity) {
    week.endEquity = equity;
    week.peakEquity = Math.max(week.peakEquity, equity);
    const dd = week.peakEquity > 0 ? (week.peakEquity - equity) / week.peakEquity : 0;
    week.maxDdPct = Math.max(week.maxDdPct, dd);
}

function exitPnl(position, exitPrice) {
    const dir = position.side === "LONG" ? 1 : -1;
    return (exitPrice - position.entryPrice) * dir * position.size;
}

function closePosition({ symbol, position, exitPrice, exitTsMs, reason, equity, closedTrades, pairStats, weeklyStats, events }) {
    const pnl = exitPnl(position, exitPrice);
    const holdMinutes = Math.max(0, (exitTsMs - position.entryTsMs) / 60000);
    const pair = ensurePair(pairStats, symbol);
    pair.trades += 1;
    pair.rawPnl += pnl;
    pair.holdMinutes.push(holdMinutes);
    if (pnl >= 0) {
        pair.wins += 1;
        pair.grossWin += pnl;
    } else {
        pair.losses += 1;
        pair.grossLoss += Math.abs(pnl);
    }

    const week = ensureWeek(weeklyStats, exitTsMs, equity);
    week.trades += 1;
    week.rawPnl += pnl;
    if (pnl >= 0) week.wins += 1;
    else week.losses += 1;

    closedTrades.push({
        symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        pnl,
        holdMinutes,
        reason,
        openedAt: new Date(position.entryTsMs).toISOString(),
        closedAt: new Date(exitTsMs).toISOString(),
    });
    events.push({ type: "EXIT", symbol, timestamp: new Date(exitTsMs).toISOString(), pnl, reason });
    return pnl;
}

function maybeSameBarExit(position, bar) {
    const sl = position.currentSl;
    const tp = position.takeProfit;
    if (!Number.isFinite(sl) && !Number.isFinite(tp)) return null;

    const low = toNum(bar?.l);
    const high = toNum(bar?.h);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null;

    if (position.side === "LONG") {
        const stopHit = Number.isFinite(sl) && low <= sl;
        const tpHit = Number.isFinite(tp) && high >= tp;
        if (!stopHit && !tpHit) return null;
        if (stopHit && tpHit) {
            return SAME_BAR_FILL_PRIORITY === "TP_FIRST" ? { price: tp, reason: "take_profit_same_bar" } : { price: sl, reason: "stop_loss_same_bar" };
        }
        if (stopHit) return { price: sl, reason: "stop_loss" };
        return { price: tp, reason: "take_profit" };
    }

    const stopHit = Number.isFinite(sl) && high >= sl;
    const tpHit = Number.isFinite(tp) && low <= tp;
    if (!stopHit && !tpHit) return null;
    if (stopHit && tpHit) {
        return SAME_BAR_FILL_PRIORITY === "TP_FIRST" ? { price: tp, reason: "take_profit_same_bar" } : { price: sl, reason: "stop_loss_same_bar" };
    }
    if (stopHit) return { price: sl, reason: "stop_loss" };
    return { price: tp, reason: "take_profit" };
}

async function main() {
    const config = mergeObjects(STRATEGIES.CRYPTO_LIQUIDITY_WINDOW_MOMENTUM || {}, parseOverrides());
    const symbols = TARGET_SYMBOLS.filter(Boolean);
    const dataBySymbol = new Map();
    for (const symbol of symbols) {
        const data = loadSymbolData(symbol);
        if (data) dataBySymbol.set(symbol, data);
    }
    if (!dataBySymbol.size) throw new Error("No crypto symbols with M5/H1 data found.");

    const { actualStart, actualEnd } = resolveRange(dataBySymbol);
    const timelineSet = new Set();
    for (const [symbol, data] of dataBySymbol.entries()) {
        for (const row of data.M5) {
            if (row.tsMs < actualStart || row.tsMs > actualEnd) continue;
            timelineSet.add(`${row.tsMs}:${symbol}`);
        }
    }
    const timeline = [...timelineSet]
        .map((key) => {
            const idx = key.indexOf(":");
            return { tsMs: Number(key.slice(0, idx)), symbol: key.slice(idx + 1) };
        })
        .sort((a, b) => (a.tsMs - b.tsMs) || a.symbol.localeCompare(b.symbol));

    const pointers = {};
    for (const symbol of dataBySymbol.keys()) {
        pointers[symbol] = { M5: -1, H1: -1 };
    }

    let equity = START_CAPITAL;
    let peakEquity = START_CAPITAL;
    let maxDrawdownAbs = 0;
    let maxDrawdownPct = 0;
    const openPositions = new Map();
    const closedTrades = [];
    const events = [];
    const pairStats = new Map();
    const weeklyStats = new Map();
    const noTradeReasons = new Map();
    const windowStartMinutes = parseHhMmToMinutes(config?.window?.start || "14:00");
    const windowEndMinutes = parseHhMmToMinutes(config?.window?.end || "20:00");
    const timeZone = config?.timezone || "Europe/Berlin";
    const minCandles5m = Number(config?.data?.minCandles5m || 200);
    const minCandles1h = Number(config?.data?.minCandles1h || 50);

    for (const { tsMs, symbol } of timeline) {
        const data = dataBySymbol.get(symbol);
        while (pointers[symbol].M5 + 1 < data.M5.length && data.M5[pointers[symbol].M5 + 1].tsMs <= tsMs) pointers[symbol].M5 += 1;
        while (pointers[symbol].H1 + 1 < data.H1.length && data.H1[pointers[symbol].H1 + 1].tsMs <= tsMs) pointers[symbol].H1 += 1;
        const m5Index = pointers[symbol].M5;
        const h1Index = pointers[symbol].H1;
        if (m5Index < 0 || h1Index < 0) continue;

        const bar = data.M5[m5Index];
        const m5Candles = data.M5.slice(Math.max(0, m5Index - 260), m5Index + 1);
        const h1Candles = data.H1.slice(Math.max(0, h1Index - 80), h1Index + 1);
        const timestamp = new Date(tsMs).toISOString();

        const week = ensureWeek(weeklyStats, tsMs, equity);
        markWeekPeakAndDd(week, equity);

        const openPosition = openPositions.get(symbol) || null;
        const currentMinutesTz = getMinutesInTimeZone(tsMs, timeZone);
        const withinWindow = isMinuteInWindow(currentMinutesTz, windowStartMinutes, windowEndMinutes);
        if (openPosition) {
            const barExit = maybeSameBarExit(openPosition, bar);
            if (barExit) {
                const pnl = closePosition({
                    symbol,
                    position: openPosition,
                    exitPrice: barExit.price,
                    exitTsMs: tsMs,
                    reason: barExit.reason,
                    equity,
                    closedTrades,
                    pairStats,
                    weeklyStats,
                    events,
                });
                equity += pnl;
                peakEquity = Math.max(peakEquity, equity);
                maxDrawdownAbs = Math.max(maxDrawdownAbs, peakEquity - equity);
                maxDrawdownPct = Math.max(maxDrawdownPct, peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0);
                openPositions.delete(symbol);
                markWeekPeakAndDd(week, equity);
                continue;
            }

            const evalOpen = evaluateCryptoLiquidityWindowMomentum({
                symbol,
                timestamp,
                bid: bar.c,
                ask: bar.c,
                mid: bar.c,
                candles5m: m5Candles,
                candles1h: h1Candles,
                config,
                equity,
                openPosition: {
                    symbol,
                    side: openPosition.side,
                    size: openPosition.size,
                    entryPrice: openPosition.entryPrice,
                    currentSl: openPosition.currentSl,
                    takeProfit: openPosition.takeProfit,
                    initialSl: openPosition.initialSl,
                    entryTimestamp: new Date(openPosition.entryTsMs).toISOString(),
                },
                counters: {
                    tradesTodaySymbol: 0,
                    tradesTodayTotal: 0,
                    lastExitAtMs: null,
                    startOfDayEquity: equity,
                    realizedPnlToday: 0,
                },
                entryContext: {},
            });

            if (evalOpen?.action === "EXIT") {
                const exitPrice = toNum(evalOpen?.metrics?.currentMark) ?? bar.c;
                const pnl = closePosition({
                    symbol,
                    position: openPosition,
                    exitPrice,
                    exitTsMs: tsMs,
                    reason: evalOpen.exitReason || "strategy_exit",
                    equity,
                    closedTrades,
                    pairStats,
                    weeklyStats,
                    events,
                });
                equity += pnl;
                peakEquity = Math.max(peakEquity, equity);
                maxDrawdownAbs = Math.max(maxDrawdownAbs, peakEquity - equity);
                maxDrawdownPct = Math.max(maxDrawdownPct, peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0);
                openPositions.delete(symbol);
                markWeekPeakAndDd(week, equity);
                continue;
            }

            if (evalOpen?.action === "MANAGE" && evalOpen?.manageAction?.type === "MOVE_SL") {
                const newSl = toNum(evalOpen.manageAction.newStopLoss);
                if (Number.isFinite(newSl)) openPosition.currentSl = newSl;
            }
            continue;
        }

        if (!withinWindow) {
            noTradeReasons.set("outside_liquidity_window", (noTradeReasons.get("outside_liquidity_window") || 0) + 1);
            continue;
        }
        if (m5Index + 1 < minCandles5m || h1Index + 1 < minCandles1h) {
            noTradeReasons.set("insufficient_candles", (noTradeReasons.get("insufficient_candles") || 0) + 1);
            continue;
        }

        const dayKey = timestamp.slice(0, 10);
        const counters = computeStrategyTradeCountersForDay({
            events,
            symbol,
            dayKey,
            timeZone: config?.timezone || "Europe/Berlin",
        });

        const currentOpenRiskPct = [...openPositions.values()].reduce((sum, pos) => sum + (toNum(pos.riskPct) || 0), 0);
        const externalEntryAllowed = openPositions.size < MAX_POSITIONS && currentOpenRiskPct + (toNum(config?.risk?.riskPctNormal) || 0.04) <= MAX_OPEN_RISK_PCT;
        const evaluation = evaluateCryptoLiquidityWindowMomentum({
            symbol,
            timestamp,
            bid: bar.c,
            ask: bar.c,
            mid: bar.c,
            candles5m: m5Candles,
            candles1h: h1Candles,
            config,
            equity,
            openPosition: null,
            counters: {
                tradesTodaySymbol: counters.tradesTodaySymbol,
                tradesTodayTotal: counters.tradesTodayTotal,
                lastExitAtMs: counters.lastExitAtMs,
                startOfDayEquity: equity,
                realizedPnlToday: 0,
            },
            entryContext: {
                requireNewClosedBar: false,
                isNewClosedBar: true,
                externalEntryAllowed,
                externalBlockReason: externalEntryAllowed ? null : "portfolio_guard_block",
            },
        });

        if (evaluation?.action !== "OPEN" || !evaluation?.orderPlan) {
            const reason = String(evaluation?.reasonCode || "no_trade");
            noTradeReasons.set(reason, (noTradeReasons.get(reason) || 0) + 1);
            continue;
        }

        openPositions.set(symbol, {
            symbol,
            side: evaluation.orderPlan.side,
            size: evaluation.orderPlan.size,
            entryPrice: evaluation.orderPlan.entryPrice,
            initialSl: evaluation.orderPlan.sl,
            currentSl: evaluation.orderPlan.sl,
            takeProfit: evaluation.orderPlan.tp,
            riskPct: evaluation.orderPlan.riskPct,
            entryTsMs: tsMs,
        });
        events.push({ type: "OPEN", symbol, timestamp });
    }

    const summary = {
        rangeStartIso: new Date(actualStart).toISOString(),
        rangeEndIso: new Date(actualEnd).toISOString(),
        trades: closedTrades.length,
        wins: closedTrades.filter((t) => t.pnl >= 0).length,
        losses: closedTrades.filter((t) => t.pnl < 0).length,
        winrate: closedTrades.length ? closedTrades.filter((t) => t.pnl >= 0).length / closedTrades.length : null,
        startCapital: START_CAPITAL,
        endCapital: equity,
        rawPnl: equity - START_CAPITAL,
        returnPct: START_CAPITAL > 0 ? (equity - START_CAPITAL) / START_CAPITAL : null,
        avgHoldMinutes: closedTrades.length ? closedTrades.reduce((sum, t) => sum + t.holdMinutes, 0) / closedTrades.length : null,
        medianHoldMinutes: closedTrades.length
            ? closedTrades.map((t) => t.holdMinutes).sort((a, b) => a - b)[Math.floor(closedTrades.length / 2)]
            : null,
        maxDrawdownAbs,
        maxDrawdownPct,
        maxPositions: MAX_POSITIONS,
        maxOpenRiskPct: MAX_OPEN_RISK_PCT,
    };

    const pairRows = [...pairStats.values()].map((row) => ({
        symbol: row.symbol,
        trades: row.trades,
        wins: row.wins,
        losses: row.losses,
        winrate: row.trades ? row.wins / row.trades : null,
        rawPnl: row.rawPnl,
        profitFactor: row.grossLoss > 0 ? row.grossWin / row.grossLoss : null,
        avgHoldMinutes: row.holdMinutes.length ? row.holdMinutes.reduce((sum, v) => sum + v, 0) / row.holdMinutes.length : null,
    }));

    const weekRows = [...weeklyStats.values()].sort((a, b) => a.week.localeCompare(b.week));
    const noTradeReasonRows = [...noTradeReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count }));

    const report = {
        strategyId: "CRYPTO_LIQUIDITY_WINDOW_MOMENTUM",
        symbols,
        summary,
        pairRows,
        weekRows,
        noTradeReasonRows,
        closedTrades,
        config,
    };

    if (REPORT_JSON_PATH) {
        const outPath = path.isAbsolute(REPORT_JSON_PATH) ? REPORT_JSON_PATH : path.join(process.cwd(), REPORT_JSON_PATH);
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    }

    console.log(`=== CRYPTO LWM REPLAY (${summary.rangeStartIso} -> ${summary.rangeEndIso}) ===`);
    console.log(`Symbols: ${symbols.join(", ")}`);
    console.log(`Start Capital: ${num(summary.startCapital)} EUR`);
    console.log(`End Capital: ${num(summary.endCapital)} EUR`);
    console.log(`Raw PnL: ${num(summary.rawPnl)} EUR`);
    console.log(`Trades: ${summary.trades}`);
    console.log(`Winrate: ${pct(summary.winrate)}`);
    console.log(`Avg Hold: ${num(summary.avgHoldMinutes)} min`);
    console.log(`Max DD: ${num(summary.maxDrawdownAbs)} EUR (${pct(summary.maxDrawdownPct)})`);
    console.log(`Top no-trade reasons: ${noTradeReasonRows.slice(0, 8).map((r) => `${r.reason}=${r.count}`).join(", ")}`);
    if (REPORT_JSON_PATH) {
        const outPath = path.isAbsolute(REPORT_JSON_PATH) ? REPORT_JSON_PATH : path.join(process.cwd(), REPORT_JSON_PATH);
        console.log(`Report written to: ${outPath}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
