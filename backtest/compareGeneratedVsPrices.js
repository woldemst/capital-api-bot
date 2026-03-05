import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import readline from "readline";
import { sanitizePriceSnapshotRows } from "./priceSnapshotSanity.js";
import { createIntradaySevenStepEngine } from "../intraday/engine.js";
import { DEFAULT_INTRADAY_CONFIG } from "../intraday/config.js";
import { createIntradayRuntimeState, ensureStateDay, registerClosedTrade, registerOpenedTrade } from "../intraday/state.js";
import { RISK, SESSIONS } from "../config.js";

const GENERATED_DIR = path.join(process.cwd(), "backtest", "generated-dataset");
const PRICES_DIR = path.join(process.cwd(), "backtest", "prices");

const TARGET_SYMBOLS = (process.env.BT_COMPARE_SYMBOLS || "EURUSD,GBPUSD,USDJPY")
    .split(",")
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
const LOOKBACK_DAYS = Number.isFinite(Number(process.env.BT_COMPARE_DAYS)) ? Number(process.env.BT_COMPARE_DAYS) : 3;
const START_CAPITAL = Number.isFinite(Number(process.env.BT_COMPARE_START_CAPITAL)) ? Number(process.env.BT_COMPARE_START_CAPITAL) : 500;
const MIN_VALID_PRICE_ROW_RATIO = Number.isFinite(Number(process.env.BT_COMPARE_MIN_VALID_ROW_RATIO))
    ? Number(process.env.BT_COMPARE_MIN_VALID_ROW_RATIO)
    : 0;

const FOREX_RISK_PCT = Number(RISK?.PER_TRADE) || 0.05;
const MAX_POSITIONS = Number(RISK?.MAX_POSITIONS) || 5;
const GUARDS = RISK?.GUARDS || {};
const EXITS = RISK?.EXITS || {};

const MAX_DAILY_LOSS_PCT = Number.isFinite(Number(GUARDS.MAX_DAILY_LOSS_PCT)) ? Number(GUARDS.MAX_DAILY_LOSS_PCT) : 0;
const MAX_OPEN_RISK_PCT = Number.isFinite(Number(GUARDS.MAX_OPEN_RISK_PCT))
    ? Number(GUARDS.MAX_OPEN_RISK_PCT)
    : FOREX_RISK_PCT * 2;
const MAX_LOSS_STREAK = Number.isFinite(Number(GUARDS.MAX_LOSS_STREAK)) ? Number(GUARDS.MAX_LOSS_STREAK) : 3;
const LOSS_STREAK_COOLDOWN_MINUTES = Number.isFinite(Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES))
    ? Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES)
    : 180;

const ROLLOVER_TIMEZONE = "America/New_York";
const ROLLOVER_HOUR = 17;
const ROLLOVER_MINUTE = 0;
const ROLLOVER_BUFFER_MINUTES = 10;
const TIMEFRAMES = ["M1", "M5", "M15", "H1"];

function toNum(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function pct(value) {
    if (!Number.isFinite(value)) return "n/a";
    return `${(value * 100).toFixed(2)}%`;
}

function num(value, digits = 2) {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(digits);
}

function minuteKey(tsMs) {
    return new Date(tsMs).toISOString().slice(0, 16);
}

function utcDayKey(tsMs) {
    return new Date(tsMs).toISOString().slice(0, 10);
}

function parseMinutes(hhmm) {
    if (typeof hhmm !== "string") return NaN;
    const [hh, mm] = hhmm.split(":").map((p) => Number(p));
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return NaN;
    return hh * 60 + mm;
}

function inSession(currentMinutes, startMinutes, endMinutes, { inclusiveEnd = false } = {}) {
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return false;
    if (startMinutes < endMinutes) {
        return currentMinutes >= startMinutes && (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes);
    }
    return currentMinutes >= startMinutes || (inclusiveEnd ? currentMinutes <= endMinutes : currentMinutes < endMinutes);
}

function getMinutesInTimeZone(timeZone, tsMs) {
    const date = new Date(tsMs);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
}

function getDateKeyInTimeZone(timeZone, tsMs) {
    const date = new Date(tsMs);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value ?? "0000";
    const month = parts.find((p) => p.type === "month")?.value ?? "00";
    const day = parts.find((p) => p.type === "day")?.value ?? "00";
    return `${year}-${month}-${day}`;
}

function isForexWeekendClosed(tsMs) {
    const d = new Date(tsMs);
    const day = d.getUTCDay();
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (day === 6) return true;
    if (day === 0 && minutes < 22 * 60) return true;
    if (day === 5 && minutes >= 22 * 60) return true;
    return false;
}

function getActiveSessionNames(tsMs) {
    const d = new Date(tsMs);
    const currentMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    const names = [];
    for (const [name, session] of Object.entries(SESSIONS || {})) {
        const upper = String(name).toUpperCase();
        if (upper === "CRYPTO") continue;
        const start = parseMinutes(session?.START);
        const end = parseMinutes(session?.END);
        if (inSession(currentMinutes, start, end)) names.push(upper);
    }
    return names;
}

function getActiveForexSymbols(tsMs) {
    if (isForexWeekendClosed(tsMs)) return [];
    const names = getActiveSessionNames(tsMs);
    const out = [];
    const set = new Set();
    for (const name of names) {
        const symbols = SESSIONS?.[name]?.SYMBOLS || [];
        for (const symbolRaw of symbols) {
            const symbol = String(symbolRaw || "").toUpperCase();
            if (!symbol || set.has(symbol)) continue;
            set.add(symbol);
            out.push(symbol);
        }
    }
    return out;
}

function symbolAllowedByActiveSessions(symbol, activeSessionNames) {
    const upper = String(symbol || "").toUpperCase();
    for (const sessionName of activeSessionNames) {
        const symbols = (SESSIONS?.[sessionName]?.SYMBOLS || []).map((s) => String(s || "").toUpperCase());
        if (symbols.includes(upper)) return true;
    }
    return false;
}

function isRolloverBuffer(tsMs) {
    const rolloverMinutes = ROLLOVER_HOUR * 60 + ROLLOVER_MINUTE;
    const nyMinutes = getMinutesInTimeZone(ROLLOVER_TIMEZONE, tsMs);
    return nyMinutes >= rolloverMinutes - ROLLOVER_BUFFER_MINUTES && nyMinutes < rolloverMinutes;
}

function pickTrend(indicator) {
    if (!indicator || typeof indicator !== "object") return "neutral";
    const ema20 = toNum(indicator?.ema20);
    const ema50 = toNum(indicator?.ema50);
    if (Number.isFinite(ema20) && Number.isFinite(ema50)) {
        if (ema20 > ema50) return "bullish";
        if (ema20 < ema50) return "bearish";
    }
    const trend = String(indicator?.trend || "").toLowerCase();
    if (trend === "bullish" || trend === "bearish") return trend;
    return "neutral";
}

function tpProgress(side, entryPrice, takeProfit, currentPrice) {
    const entry = Number(entryPrice);
    const tp = Number(takeProfit);
    const price = Number(currentPrice);
    if (![entry, tp, price].every(Number.isFinite)) return null;
    const dist = Math.abs(tp - entry);
    if (dist <= 0) return null;
    if (side === "LONG") return (price - entry) / dist;
    if (side === "SHORT") return (entry - price) / dist;
    return null;
}

function applyTrailingAndBreakeven(pos, currentPrice, indicators) {
    const trailActivationProgress = Number.isFinite(Number(EXITS?.TRAIL_ACTIVATION_TP_PROGRESS))
        ? Number(EXITS.TRAIL_ACTIVATION_TP_PROGRESS)
        : 0.45;
    const breakevenActivationProgress = Number.isFinite(Number(EXITS?.BREAKEVEN_ACTIVATION_TP_PROGRESS))
        ? Number(EXITS.BREAKEVEN_ACTIVATION_TP_PROGRESS)
        : 0.5;
    const trailFraction = Number.isFinite(Number(EXITS?.TRAIL_DISTANCE_TP_FRACTION)) ? Number(EXITS.TRAIL_DISTANCE_TP_FRACTION) : 0.18;
    const atrMultiplier = Number.isFinite(Number(EXITS?.TRAIL_DISTANCE_ATR_MULTIPLIER)) ? Number(EXITS.TRAIL_DISTANCE_ATR_MULTIPLIER) : 0.8;

    const progress = tpProgress(pos.side, pos.entryPrice, pos.takeProfit, currentPrice);
    if (!Number.isFinite(progress) || progress < trailActivationProgress) return;

    const m5 = indicators?.m5 || null;
    const m15 = indicators?.m15 || null;
    const m5Trend = pickTrend(m5);
    const m15Trend = pickTrend(m15);
    const broken =
        (pos.side === "LONG" && (m5Trend === "bearish" || m15Trend === "bearish")) ||
        (pos.side === "SHORT" && (m5Trend === "bullish" || m15Trend === "bullish"));
    if (broken && EXITS?.SOFT_EXIT_ON_M5_M15_BREAK !== false && progress >= breakevenActivationProgress) {
        pos.currentSl = pos.entryPrice;
        return;
    }

    const entry = Number(pos.entryPrice);
    const tp = Number(pos.takeProfit);
    const price = Number(currentPrice);
    const tpDist = Math.abs(tp - entry);
    if (!(tpDist > 0)) return;
    const activation = pos.side === "LONG" ? entry + tpDist * trailActivationProgress : entry - tpDist * trailActivationProgress;
    const activated = pos.side === "LONG" ? price >= activation : price <= activation;
    if (!activated) return;

    const m5Atr = toNum(m5?.atr);
    const m15Atr = toNum(m15?.atr);
    const atrFloor = Math.max(
        0,
        (Number.isFinite(m5Atr) ? m5Atr : 0) * atrMultiplier,
        (Number.isFinite(m15Atr) ? m15Atr : 0) * atrMultiplier * 0.5,
    );
    const trailDist = Math.max(tpDist * trailFraction, atrFloor);
    const newSl = pos.side === "LONG" ? price - trailDist : price + trailDist;
    if (pos.side === "LONG") {
        if (!Number.isFinite(pos.currentSl) || newSl > pos.currentSl) pos.currentSl = newSl;
        return;
    }
    if (!Number.isFinite(pos.currentSl) || newSl < pos.currentSl) pos.currentSl = newSl;
}

function toBarFromGeneratedRow(row) {
    if (!row) return null;
    const o = toNum(row.open);
    const h = toNum(row.high);
    const l = toNum(row.low);
    const c = toNum(row.close);
    if (![o, h, l, c].every(Number.isFinite)) return null;
    return { t: row.timestamp, o, h, l, c };
}

function toBarFromPriceCandle(candle) {
    if (!candle || typeof candle !== "object") return null;
    const o = toNum(candle.o);
    const h = toNum(candle.h);
    const l = toNum(candle.l);
    const c = toNum(candle.c);
    if (![o, h, l, c].every(Number.isFinite)) return null;
    return { t: candle.t || null, o, h, l, c };
}

function renderTable(headers, rows) {
    const widths = headers.map((h) => h.length);
    for (const row of rows) {
        row.forEach((cell, i) => {
            widths[i] = Math.max(widths[i], String(cell).length);
        });
    }
    const line = (cells) =>
        cells
            .map((cell, i) => {
                const text = String(cell);
                const pad = widths[i] - text.length;
                return `${text}${" ".repeat(Math.max(0, pad))}`;
            })
            .join(" | ");
    const sep = widths.map((w) => "-".repeat(w)).join("-|-");
    return [line(headers), sep, ...rows.map((r) => line(r))].join("\n");
}

function countBy(items, keyFn) {
    const m = new Map();
    for (const item of items) {
        const k = keyFn(item);
        m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function quantile(values, q) {
    if (!Array.isArray(values) || !values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
    return sorted[idx];
}

function summarizeArray(values) {
    if (!Array.isArray(values) || !values.length) return { n: 0, min: null, p50: null, p90: null, p99: null, max: null, avg: null };
    const sum = values.reduce((acc, v) => acc + v, 0);
    return {
        n: values.length,
        min: quantile(values, 0),
        p50: quantile(values, 0.5),
        p90: quantile(values, 0.9),
        p99: quantile(values, 0.99),
        max: quantile(values, 1),
        avg: values.length ? sum / values.length : null,
    };
}

function entryKey(entry) {
    return `${entry.symbol}|${minuteKey(entry.tsMs)}|${entry.side}`;
}

function tolerantEntryMatch(aEntries, bEntries, { toleranceMinutes = 2, requireSameSide = true } = {}) {
    const toleranceMs = toleranceMinutes * 60 * 1000;
    const bySymbol = new Map();
    for (const entry of bEntries) {
        if (!bySymbol.has(entry.symbol)) bySymbol.set(entry.symbol, []);
        bySymbol.get(entry.symbol).push({ ...entry, used: false });
    }
    for (const arr of bySymbol.values()) {
        arr.sort((x, y) => x.tsMs - y.tsMs);
    }

    let matched = 0;
    for (const replay of aEntries) {
        const pool = bySymbol.get(replay.symbol);
        if (!pool || !pool.length) continue;
        let bestIdx = -1;
        let bestAbsDiff = Infinity;
        for (let i = 0; i < pool.length; i += 1) {
            const actual = pool[i];
            if (actual.used) continue;
            if (requireSameSide && replay.side && actual.side && replay.side !== actual.side) continue;
            const absDiff = Math.abs(actual.tsMs - replay.tsMs);
            if (absDiff <= toleranceMs && absDiff < bestAbsDiff) {
                bestAbsDiff = absDiff;
                bestIdx = i;
            }
            if (actual.tsMs > replay.tsMs + toleranceMs) break;
        }
        if (bestIdx >= 0) {
            pool[bestIdx].used = true;
            matched += 1;
        }
    }

    const totalA = aEntries.length;
    const totalB = bEntries.length;
    return {
        toleranceMinutes,
        requireSameSide,
        matched,
        aOnly: Math.max(0, totalA - matched),
        bOnly: Math.max(0, totalB - matched),
        aMatchRate: totalA > 0 ? matched / totalA : null,
        bCoverageRate: totalB > 0 ? matched / totalB : null,
    };
}

async function readFirstJsonlLine(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        if (line && line.trim()) {
            rl.close();
            stream.destroy();
            return line;
        }
    }
    return null;
}

async function readLastJsonlLine(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const stat = await fsp.stat(filePath);
    if (!(stat.size > 0)) return null;
    const fd = await fsp.open(filePath, "r");
    const chunkSize = 64 * 1024;
    let pos = stat.size;
    let carry = "";
    try {
        while (pos > 0) {
            const size = Math.min(chunkSize, pos);
            pos -= size;
            const buf = Buffer.alloc(size);
            const { bytesRead } = await fd.read(buf, 0, size, pos);
            const text = buf.toString("utf8", 0, bytesRead) + carry;
            const lines = text.split("\n");
            carry = lines.shift() ?? "";
            for (let i = lines.length - 1; i >= 0; i -= 1) {
                if (lines[i] && lines[i].trim()) return lines[i];
            }
        }
        if (carry && carry.trim()) return carry;
        return null;
    } finally {
        await fd.close();
    }
}

async function fileTimestampRange(filePath, { priceSanitySymbol = null } = {}) {
    if (priceSanitySymbol) {
        const rows = await loadJsonlRows(filePath, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, {
            priceSanitySymbol,
            quietSanityLogs: true,
        });
        if (!rows.length) return null;
        return { firstTs: rows[0].tsMs, lastTs: rows[rows.length - 1].tsMs };
    }

    const firstLine = await readFirstJsonlLine(filePath);
    const lastLine = await readLastJsonlLine(filePath);
    if (!firstLine || !lastLine) return null;
    let firstTs = null;
    let lastTs = null;
    try {
        firstTs = Date.parse(String(JSON.parse(firstLine)?.timestamp || ""));
    } catch {
        firstTs = null;
    }
    try {
        lastTs = Date.parse(String(JSON.parse(lastLine)?.timestamp || ""));
    } catch {
        lastTs = null;
    }
    if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs)) return null;
    return { firstTs, lastTs };
}

async function loadJsonlRows(filePath, minTsMs, maxTsMs, { priceSanitySymbol = null, quietSanityLogs = false } = {}) {
    const rows = [];
    if (!fs.existsSync(filePath)) return rows;
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line || !line.trim()) continue;
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            continue;
        }
        const tsMs = Date.parse(String(row.timestamp || ""));
        if (!Number.isFinite(tsMs)) continue;
        if (tsMs < minTsMs) continue;
        if (tsMs > maxTsMs) break;
        rows.push({ ...row, tsMs });
    }
    if (!priceSanitySymbol) return rows;

    const { validRows, stats } = sanitizePriceSnapshotRows(rows, {
        symbol: priceSanitySymbol,
        minValidRatio: MIN_VALID_PRICE_ROW_RATIO,
    });
    if (!quietSanityLogs && stats.dropped > 0) {
        console.warn(
            `[DataSanity] ${priceSanitySymbol}: dropped ${stats.dropped}/${stats.total} invalid price rows (${(stats.validRatio * 100).toFixed(2)}% valid).`,
        );
    }
    if (!quietSanityLogs && stats.skipFile) {
        console.warn(
            `[DataSanity] ${priceSanitySymbol}: skipped for validation (valid ratio ${(stats.validRatio * 100).toFixed(2)}% < ${(MIN_VALID_PRICE_ROW_RATIO * 100).toFixed(2)}%).`,
        );
    }
    return validRows;
}

function createSimulationContext() {
    return {
        engine: createIntradaySevenStepEngine({
            ...DEFAULT_INTRADAY_CONFIG,
            risk: {
                ...(DEFAULT_INTRADAY_CONFIG.risk || {}),
                forexRiskPct: FOREX_RISK_PCT,
            },
        }),
        state: createIntradayRuntimeState({ strategyId: "INTRADAY_7STEP_FOREX" }),
        equity: START_CAPITAL,
        equityPeak: START_CAPITAL,
        maxDdAbs: 0,
        maxDdPct: 0,
        openPositions: new Map(),
        closedTrades: [],
        entries: [],
        potentialSignals: [],
        blockedSignals: [],
        blockedByFilter: [],
    };
}

function syncStateOpenPositions(ctx) {
    ctx.state.openPositions = new Map();
    for (const [symbol, pos] of ctx.openPositions.entries()) {
        ctx.state.openPositions.set(symbol, {
            symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            currentSl: pos.currentSl,
            initialSl: pos.initialSl,
            takeProfit: pos.takeProfit,
            size: pos.size,
            entryTimestamp: pos.entryTimestamp,
            assetClass: "forex",
        });
    }
}

function updateEquityDrawdown(ctx) {
    if (ctx.equity > ctx.equityPeak) ctx.equityPeak = ctx.equity;
    const ddAbs = ctx.equityPeak - ctx.equity;
    const ddPct = ctx.equityPeak > 0 ? ddAbs / ctx.equityPeak : 0;
    if (ddAbs > ctx.maxDdAbs) ctx.maxDdAbs = ddAbs;
    if (ddPct > ctx.maxDdPct) ctx.maxDdPct = ddPct;
}

function computeTradeSummaryForGuards(closedTrades) {
    let currentLossStreak = 0;
    let lastLossAtMs = null;
    for (const trade of closedTrades) {
        if (trade.r < 0) {
            currentLossStreak += 1;
            lastLossAtMs = trade.closeTsMs;
        } else if (trade.r > 0) {
            currentLossStreak = 0;
        }
    }
    return { currentLossStreak, lastLossAtMs };
}

function openRiskPct(ctx) {
    let sum = 0;
    for (const pos of ctx.openPositions.values()) sum += Number(pos.riskPct) || 0;
    return sum;
}

function shouldBlockNewTrade(ctx, tsMs, nextRiskPct) {
    const dayKey = utcDayKey(tsMs);
    const periodClosed = ctx.closedTrades.filter((t) => utcDayKey(t.closeTsMs) === dayKey);
    const todayEstimatedPnlPct = periodClosed.reduce((sum, t) => sum + t.r * (Number(t.riskPct) || 0), 0);
    const todayEstimatedLossPctAbs = Math.abs(Math.min(0, todayEstimatedPnlPct));
    if (MAX_DAILY_LOSS_PCT > 0 && todayEstimatedLossPctAbs >= MAX_DAILY_LOSS_PCT) {
        return { blocked: true, reason: "daily_loss_limit" };
    }

    const { currentLossStreak, lastLossAtMs } = computeTradeSummaryForGuards(ctx.closedTrades);
    if (MAX_LOSS_STREAK > 0 && LOSS_STREAK_COOLDOWN_MINUTES > 0 && currentLossStreak >= MAX_LOSS_STREAK) {
        const cooldownMs = LOSS_STREAK_COOLDOWN_MINUTES * 60 * 1000;
        const cooldownActive = Number.isFinite(lastLossAtMs) ? tsMs - lastLossAtMs < cooldownMs : true;
        if (cooldownActive) return { blocked: true, reason: "loss_streak_cooldown" };
    }

    if (openRiskPct(ctx) + nextRiskPct > MAX_OPEN_RISK_PCT + 1e-9) {
        return { blocked: true, reason: "open_risk_cap" };
    }
    return { blocked: false, reason: null };
}

function closePosition(ctx, { symbol, pos, closePrice, tsMs, reason }) {
    const riskDistance = Math.abs(pos.entryPrice - pos.initialSl);
    if (!(riskDistance > 0)) return;

    const pnlDistance = pos.side === "LONG" ? closePrice - pos.entryPrice : pos.entryPrice - closePrice;
    const r = pnlDistance / riskDistance;
    const rawPnl = pos.riskAmount * r;

    ctx.equity += rawPnl;
    updateEquityDrawdown(ctx);

    const closed = {
        symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        closePrice,
        sl: pos.initialSl,
        tp: pos.takeProfit,
        entryTsMs: pos.entryTsMs,
        closeTsMs: tsMs,
        entryTimestamp: pos.entryTimestamp,
        closeTimestamp: new Date(tsMs).toISOString(),
        riskPct: pos.riskPct,
        riskAmount: pos.riskAmount,
        r,
        rawPnl,
        reason,
    };
    ctx.closedTrades.push(closed);
    ctx.openPositions.delete(symbol);
    registerClosedTrade(ctx.state, { symbol, pnl: rawPnl });
}

function buildSummary(ctx, sourceName) {
    const trades = ctx.closedTrades.length;
    const wins = ctx.closedTrades.filter((t) => t.r > 0).length;
    const losses = ctx.closedTrades.filter((t) => t.r < 0).length;
    const netR = ctx.closedTrades.reduce((sum, t) => sum + t.r, 0);
    const grossWinR = ctx.closedTrades.reduce((sum, t) => sum + (t.r > 0 ? t.r : 0), 0);
    const grossLossR = ctx.closedTrades.reduce((sum, t) => sum + (t.r < 0 ? Math.abs(t.r) : 0), 0);
    const pf = grossLossR > 0 ? grossWinR / grossLossR : null;
    const rawPnl = ctx.equity - START_CAPITAL;

    const pairRows = TARGET_SYMBOLS.map((symbol) => {
        const rows = ctx.closedTrades.filter((t) => t.symbol === symbol);
        const tw = rows.filter((t) => t.r > 0).length;
        const tl = rows.filter((t) => t.r < 0).length;
        const tNetR = rows.reduce((sum, t) => sum + t.r, 0);
        const tGw = rows.reduce((sum, t) => sum + (t.r > 0 ? t.r : 0), 0);
        const tGl = rows.reduce((sum, t) => sum + (t.r < 0 ? Math.abs(t.r) : 0), 0);
        const tPnl = rows.reduce((sum, t) => sum + t.rawPnl, 0);
        return {
            symbol,
            trades: rows.length,
            wins: tw,
            losses: tl,
            winRate: rows.length ? tw / rows.length : null,
            netR: tNetR,
            pf: tGl > 0 ? tGw / tGl : null,
            pnl: tPnl,
        };
    });

    return {
        sourceName,
        trades,
        wins,
        losses,
        winRate: trades ? wins / trades : null,
        netR,
        pf,
        rawPnl,
        endEquity: ctx.equity,
        maxDdAbs: ctx.maxDdAbs,
        maxDdPct: ctx.maxDdPct,
        potentialSignals: ctx.potentialSignals.length,
        executedSignals: ctx.entries.length,
        blockedSignals: ctx.blockedSignals.length,
        pairRows,
    };
}

async function simulateGenerated({ startMs, endMs, warmupStartMs }) {
    const dataBySymbol = new Map();
    for (const symbol of TARGET_SYMBOLS) {
        const rec = {};
        for (const tf of TIMEFRAMES) {
            const filePath = path.join(GENERATED_DIR, `${symbol}_${tf}.jsonl`);
            rec[tf] = await loadJsonlRows(filePath, warmupStartMs, endMs);
        }
        dataBySymbol.set(symbol, rec);
    }

    for (const symbol of TARGET_SYMBOLS) {
        const d = dataBySymbol.get(symbol);
        if (!d?.M1?.length || !d?.M5?.length || !d?.M15?.length || !d?.H1?.length) {
            throw new Error(`[generated] Missing required timeframe data for ${symbol}`);
        }
    }

    const timelineSet = new Set();
    for (const symbol of TARGET_SYMBOLS) {
        for (const row of dataBySymbol.get(symbol).M1) {
            if (row.tsMs < startMs || row.tsMs > endMs) continue;
            timelineSet.add(row.tsMs);
        }
    }
    const timeline = [...timelineSet].sort((a, b) => a - b);

    const ctx = createSimulationContext();
    const pointers = {};
    for (const symbol of TARGET_SYMBOLS) {
        pointers[symbol] = { M1: -1, M5: -1, M15: -1, H1: -1 };
    }

    let lastRolloverCloseKey = null;

    for (const tsMs of timeline) {
        ensureStateDay(ctx.state, tsMs);
        updateEquityDrawdown(ctx);

        const pointerMovedBySymbol = new Map();
        for (const symbol of TARGET_SYMBOLS) {
            const d = dataBySymbol.get(symbol);
            const ptr = pointers[symbol];
            const move = (arr, idx) => {
                let i = idx;
                while (i + 1 < arr.length && arr[i + 1].tsMs <= tsMs) i += 1;
                return i;
            };
            const prevM1 = ptr.M1;
            ptr.M1 = move(d.M1, ptr.M1);
            ptr.M5 = move(d.M5, ptr.M5);
            ptr.M15 = move(d.M15, ptr.M15);
            ptr.H1 = move(d.H1, ptr.H1);
            pointerMovedBySymbol.set(symbol, ptr.M1 !== prevM1);
        }

        syncStateOpenPositions(ctx);

        const rolloverKey = getDateKeyInTimeZone(ROLLOVER_TIMEZONE, tsMs);
        if (isRolloverBuffer(tsMs) && rolloverKey !== lastRolloverCloseKey) {
            lastRolloverCloseKey = rolloverKey;
            for (const [symbol, pos] of [...ctx.openPositions.entries()]) {
                const ptr = pointers[symbol];
                const row = ptr.M1 >= 0 ? dataBySymbol.get(symbol).M1[ptr.M1] : null;
                const closePrice = toNum(row?.close);
                if (!Number.isFinite(closePrice)) continue;
                closePosition(ctx, { symbol, pos, closePrice, tsMs, reason: "rollover" });
            }
            syncStateOpenPositions(ctx);
        }

        for (const [symbol, pos] of [...ctx.openPositions.entries()]) {
            if (!pointerMovedBySymbol.get(symbol)) continue;
            const ptr = pointers[symbol];
            if (ptr.M1 < 0) continue;
            const m1 = dataBySymbol.get(symbol).M1[ptr.M1];
            const high = toNum(m1?.high);
            const low = toNum(m1?.low);
            const sl = toNum(pos.currentSl);
            const tp = toNum(pos.takeProfit);
            let slHit = false;
            let tpHit = false;
            if (pos.side === "LONG") {
                slHit = Number.isFinite(low) && Number.isFinite(sl) && low <= sl;
                tpHit = Number.isFinite(high) && Number.isFinite(tp) && high >= tp;
            } else {
                slHit = Number.isFinite(high) && Number.isFinite(sl) && high >= sl;
                tpHit = Number.isFinite(low) && Number.isFinite(tp) && low <= tp;
            }
            if (slHit || tpHit) {
                const closePrice = slHit ? sl : tp;
                closePosition(ctx, { symbol, pos, closePrice, tsMs, reason: slHit ? "hit_sl" : "hit_tp" });
                continue;
            }
            if (ptr.M5 >= 0 && ptr.M15 >= 0) {
                const m5 = dataBySymbol.get(symbol).M5[ptr.M5];
                const m15 = dataBySymbol.get(symbol).M15[ptr.M15];
                const currentPrice = toNum(m1?.close);
                if (Number.isFinite(currentPrice)) applyTrailingAndBreakeven(pos, currentPrice, { m5, m15 });
            }
        }

        syncStateOpenPositions(ctx);

        const activeUniverse = getActiveForexSymbols(tsMs).filter((s) => TARGET_SYMBOLS.includes(s));
        for (const symbol of activeUniverse) {
            const ptr = pointers[symbol];
            if (ptr.M1 < 0 || ptr.M5 < 2 || ptr.M15 < 1 || ptr.H1 < 0) continue;
            if (!pointerMovedBySymbol.get(symbol)) continue;

            const d = dataBySymbol.get(symbol);
            const m1 = d.M1[ptr.M1];
            const m5 = d.M5[ptr.M5];
            const m5Prev = d.M5[ptr.M5 - 1];
            const m5Prev2 = d.M5[ptr.M5 - 2];
            const m15 = d.M15[ptr.M15];
            const m15Prev = d.M15[ptr.M15 - 1];
            const h1 = d.H1[ptr.H1];
            const mid = toNum(m1?.close);
            if (!Number.isFinite(mid)) continue;

            const snapshot = {
                symbol,
                timestamp: m1.timestamp,
                bid: mid,
                ask: mid,
                mid,
                spread: 0,
                sessions: getActiveSessionNames(tsMs),
                newsBlocked: false,
                equity: ctx.equity,
                indicators: { h1, m15, m5, m1 },
                bars: {
                    h1: toBarFromGeneratedRow(h1),
                    m15: toBarFromGeneratedRow(m15),
                    m5: toBarFromGeneratedRow(m5),
                    m1: toBarFromGeneratedRow(m1),
                },
                prevBars: {
                    m15: toBarFromGeneratedRow(m15Prev),
                    m5: toBarFromGeneratedRow(m5Prev),
                },
                prev2Bars: {
                    m5: toBarFromGeneratedRow(m5Prev2),
                },
            };

            const decision = ctx.engine.evaluateSnapshot({ snapshot, state: ctx.state });
            const plan = decision?.step5?.orderPlan || null;
            if (!decision?.step5?.valid || !plan) continue;

            ctx.potentialSignals.push({ symbol, tsMs, side: String(plan.side || "").toUpperCase() });

            if (ctx.openPositions.size >= MAX_POSITIONS) {
                ctx.blockedSignals.push({ symbol, tsMs, reason: "max_positions_reached" });
                continue;
            }
            if (ctx.openPositions.has(symbol)) {
                ctx.blockedSignals.push({ symbol, tsMs, reason: "symbol_already_in_position" });
                continue;
            }

            const guard = shouldBlockNewTrade(ctx, tsMs, FOREX_RISK_PCT);
            if (guard.blocked) {
                ctx.blockedSignals.push({ symbol, tsMs, reason: guard.reason });
                continue;
            }

            const entryPrice = toNum(plan.entryPrice);
            const sl = toNum(plan.sl);
            const tp = toNum(plan.tp);
            const size = toNum(plan.size);
            const riskAmount = toNum(plan.riskAmount) ?? ctx.equity * FOREX_RISK_PCT;
            if (![entryPrice, sl, tp, size, riskAmount].every(Number.isFinite)) {
                ctx.blockedSignals.push({ symbol, tsMs, reason: "invalid_plan_numbers" });
                continue;
            }
            if (!(Math.abs(entryPrice - sl) > 0)) {
                ctx.blockedSignals.push({ symbol, tsMs, reason: "invalid_stop_distance" });
                continue;
            }

            const side = String(plan.side || "").toUpperCase();
            if (!["LONG", "SHORT"].includes(side)) {
                ctx.blockedSignals.push({ symbol, tsMs, reason: "invalid_side" });
                continue;
            }

            const pos = {
                symbol,
                side,
                entryPrice,
                currentSl: sl,
                initialSl: sl,
                takeProfit: tp,
                size,
                riskPct: FOREX_RISK_PCT,
                riskAmount,
                entryTsMs: tsMs,
                entryTimestamp: m1.timestamp,
            };
            ctx.openPositions.set(symbol, pos);
            ctx.entries.push({ symbol, tsMs, side });

            registerOpenedTrade(ctx.state, {
                symbol,
                side: pos.side,
                entryPrice: pos.entryPrice,
                currentSl: pos.currentSl,
                initialSl: pos.initialSl,
                takeProfit: pos.takeProfit,
                size: pos.size,
                entryTimestamp: pos.entryTimestamp,
                assetClass: "forex",
            });
            syncStateOpenPositions(ctx);
        }
    }

    for (const [symbol, pos] of [...ctx.openPositions.entries()]) {
        const ptr = pointers[symbol];
        if (ptr.M1 < 0) continue;
        const row = dataBySymbol.get(symbol).M1[ptr.M1];
        const closePrice = toNum(row?.close);
        if (!Number.isFinite(closePrice)) continue;
        closePosition(ctx, { symbol, pos, closePrice, tsMs: row.tsMs, reason: "period_end" });
    }

    return {
        ...buildSummary(ctx, "generated-dataset"),
        ctx,
        dataBySymbol,
        rowCounts: Object.fromEntries(TARGET_SYMBOLS.map((s) => [s, dataBySymbol.get(s).M1.filter((r) => r.tsMs >= startMs && r.tsMs <= endMs).length])),
    };
}

async function simulatePrices({ startMs, endMs, warmupStartMs }) {
    const rowsBySymbol = new Map();
    for (const symbol of TARGET_SYMBOLS) {
        const filePath = path.join(PRICES_DIR, `${symbol}.jsonl`);
        const rows = await loadJsonlRows(filePath, warmupStartMs, endMs, { priceSanitySymbol: symbol });
        rowsBySymbol.set(symbol, rows.map((r) => ({ ...r, symbol })));
    }

    const events = [];
    for (const symbol of TARGET_SYMBOLS) {
        for (const row of rowsBySymbol.get(symbol)) {
            if (row.tsMs < startMs || row.tsMs > endMs) continue;
            events.push({ symbol, ...row });
        }
    }
    events.sort((a, b) => (a.tsMs === b.tsMs ? a.symbol.localeCompare(b.symbol) : a.tsMs - b.tsMs));

    const ctx = createSimulationContext();
    const historyBySymbol = new Map();
    for (const symbol of TARGET_SYMBOLS) {
        historyBySymbol.set(symbol, { m15Bars: [], m5Bars: [], lastM15Key: null, lastM5Key: null });
    }

    let lastRolloverCloseKey = null;

    for (const ev of events) {
        const symbol = ev.symbol;
        const tsMs = ev.tsMs;
        ensureStateDay(ctx.state, tsMs);
        updateEquityDrawdown(ctx);
        syncStateOpenPositions(ctx);

        const rolloverKey = getDateKeyInTimeZone(ROLLOVER_TIMEZONE, tsMs);
        if (isRolloverBuffer(tsMs) && rolloverKey !== lastRolloverCloseKey) {
            lastRolloverCloseKey = rolloverKey;
            for (const [s, pos] of [...ctx.openPositions.entries()]) {
                const mid = toNum(ev?.mid ?? ev?.price ?? ev?.bid ?? ev?.ask);
                if (!Number.isFinite(mid)) continue;
                closePosition(ctx, { symbol: s, pos, closePrice: mid, tsMs, reason: "rollover" });
            }
        }

        const h = historyBySymbol.get(symbol);
        const m15 = ev?.candles?.m15 || null;
        const m5 = ev?.candles?.m5 || null;
        const m15Key = m15 ? `${m15.o}|${m15.h}|${m15.l}|${m15.c}` : null;
        const m5Key = m5 ? `${m5.o}|${m5.h}|${m5.l}|${m5.c}` : null;
        if (m15Key && m15Key !== h.lastM15Key) {
            h.m15Bars.push(m15);
            if (h.m15Bars.length > 80) h.m15Bars.shift();
            h.lastM15Key = m15Key;
        }
        if (m5Key && m5Key !== h.lastM5Key) {
            h.m5Bars.push(m5);
            if (h.m5Bars.length > 160) h.m5Bars.shift();
            h.lastM5Key = m5Key;
        }

        const open = ctx.openPositions.get(symbol);
        if (open) {
            const m1 = ev?.candles?.m1 || null;
            const high = toNum(m1?.h);
            const low = toNum(m1?.l);
            const sl = toNum(open.currentSl);
            const tp = toNum(open.takeProfit);
            let slHit = false;
            let tpHit = false;
            if (open.side === "LONG") {
                slHit = Number.isFinite(low) && Number.isFinite(sl) && low <= sl;
                tpHit = Number.isFinite(high) && Number.isFinite(tp) && high >= tp;
            } else {
                slHit = Number.isFinite(high) && Number.isFinite(sl) && high >= sl;
                tpHit = Number.isFinite(low) && Number.isFinite(tp) && low <= tp;
            }
            if (slHit || tpHit) {
                closePosition(ctx, { symbol, pos: open, closePrice: slHit ? sl : tp, tsMs, reason: slHit ? "hit_sl" : "hit_tp" });
            } else {
                const currentPrice = toNum(ev?.mid ?? ev?.price ?? ev?.bid ?? ev?.ask);
                if (Number.isFinite(currentPrice)) {
                    applyTrailingAndBreakeven(open, currentPrice, {
                        m5: ev?.indicators?.m5 || null,
                        m15: ev?.indicators?.m15 || null,
                    });
                }
            }
        }

        const activeSessions = getActiveSessionNames(tsMs);
        let botWouldAnalyze = true;
        if (isForexWeekendClosed(tsMs)) {
            botWouldAnalyze = false;
            ctx.blockedByFilter.push({ symbol, tsMs, reason: "weekend_closed" });
        }
        if (botWouldAnalyze && !symbolAllowedByActiveSessions(symbol, activeSessions)) {
            botWouldAnalyze = false;
            ctx.blockedByFilter.push({ symbol, tsMs, reason: "outside_session_symbol_universe" });
        }
        if (botWouldAnalyze && isRolloverBuffer(tsMs)) {
            botWouldAnalyze = false;
            ctx.blockedByFilter.push({ symbol, tsMs, reason: "rollover_buffer" });
        }
        if (botWouldAnalyze && ev?.newsBlocked) {
            botWouldAnalyze = false;
            ctx.blockedByFilter.push({ symbol, tsMs, reason: "news_blocked" });
        }
        if (!botWouldAnalyze) continue;

        const mid = toNum(ev?.mid ?? ev?.price ?? ev?.bid ?? ev?.ask);
        const bid = toNum(ev?.bid ?? mid);
        const ask = toNum(ev?.ask ?? mid);
        if (![mid, bid, ask].every(Number.isFinite)) continue;

        const m15Bars = h.m15Bars;
        const m5Bars = h.m5Bars;
        const prevM15 = m15Bars.length >= 2 ? m15Bars[m15Bars.length - 2] : null;
        const prevM5 = m5Bars.length >= 2 ? m5Bars[m5Bars.length - 2] : null;
        const prev2M5 = m5Bars.length >= 3 ? m5Bars[m5Bars.length - 3] : null;

        const snapshot = {
            symbol,
            timestamp: ev.timestamp,
            bid,
            ask,
            mid,
            spread: toNum(ev?.spread) ?? Math.abs(ask - bid),
            sessions: Array.isArray(ev?.sessions) ? ev.sessions : [],
            newsBlocked: Boolean(ev?.newsBlocked),
            equity: ctx.equity,
            indicators: {
                h1: ev?.indicators?.h1 || {},
                m15: ev?.indicators?.m15 || {},
                m5: ev?.indicators?.m5 || {},
                m1: ev?.indicators?.m1 || {},
            },
            bars: {
                h1: toBarFromPriceCandle(ev?.candles?.h1 || null),
                m15: toBarFromPriceCandle(ev?.candles?.m15 || null),
                m5: toBarFromPriceCandle(ev?.candles?.m5 || null),
                m1: toBarFromPriceCandle(ev?.candles?.m1 || null),
            },
            prevBars: {
                m15: toBarFromPriceCandle(prevM15),
                m5: toBarFromPriceCandle(prevM5),
            },
            prev2Bars: {
                m5: toBarFromPriceCandle(prev2M5),
            },
        };

        const decision = ctx.engine.evaluateSnapshot({ snapshot, state: ctx.state });
        const plan = decision?.step5?.orderPlan || null;
        if (!decision?.step5?.valid || !plan) continue;
        ctx.potentialSignals.push({ symbol, tsMs, side: String(plan.side || "").toUpperCase() });

        if (ctx.openPositions.has(symbol)) {
            ctx.blockedSignals.push({ symbol, tsMs, reason: "symbol_already_in_position" });
            continue;
        }
        if (ctx.openPositions.size >= MAX_POSITIONS) {
            ctx.blockedSignals.push({ symbol, tsMs, reason: "max_positions_reached" });
            continue;
        }

        const guard = shouldBlockNewTrade(ctx, tsMs, FOREX_RISK_PCT);
        if (guard.blocked) {
            ctx.blockedSignals.push({ symbol, tsMs, reason: guard.reason });
            continue;
        }

        const entryPrice = toNum(plan.entryPrice);
        const sl = toNum(plan.sl);
        const tp = toNum(plan.tp);
        const size = toNum(plan.size);
        const riskAmount = toNum(plan.riskAmount) ?? ctx.equity * FOREX_RISK_PCT;
        if (![entryPrice, sl, tp, size, riskAmount].every(Number.isFinite)) {
            ctx.blockedSignals.push({ symbol, tsMs, reason: "invalid_plan_numbers" });
            continue;
        }
        if (!(Math.abs(entryPrice - sl) > 0)) {
            ctx.blockedSignals.push({ symbol, tsMs, reason: "invalid_stop_distance" });
            continue;
        }

        const side = String(plan.side || "").toUpperCase();
        if (!["LONG", "SHORT"].includes(side)) {
            ctx.blockedSignals.push({ symbol, tsMs, reason: "invalid_side" });
            continue;
        }

        const trade = {
            symbol,
            side,
            entryTsMs: tsMs,
            entryTimestamp: ev.timestamp,
            entryPrice,
            initialSl: sl,
            currentSl: sl,
            takeProfit: tp,
            size,
            riskPct: FOREX_RISK_PCT,
            riskAmount,
        };
        ctx.openPositions.set(symbol, trade);
        ctx.entries.push({ symbol, tsMs, side });
        registerOpenedTrade(ctx.state, {
            symbol,
            side: trade.side,
            entryPrice: trade.entryPrice,
            currentSl: trade.currentSl,
            initialSl: trade.initialSl,
            takeProfit: trade.takeProfit,
            size: trade.size,
            entryTimestamp: trade.entryTimestamp,
            assetClass: "forex",
        });
    }

    const lastBySymbol = new Map();
    for (const symbol of TARGET_SYMBOLS) {
        const rows = rowsBySymbol.get(symbol).filter((r) => r.tsMs <= endMs);
        if (rows.length) lastBySymbol.set(symbol, rows[rows.length - 1]);
    }
    for (const [symbol, pos] of [...ctx.openPositions.entries()]) {
        const last = lastBySymbol.get(symbol);
        const closePrice = toNum(last?.mid ?? last?.price ?? last?.bid ?? last?.ask);
        const closeTs = Number.isFinite(last?.tsMs) ? last.tsMs : endMs;
        if (!Number.isFinite(closePrice)) continue;
        closePosition(ctx, { symbol, pos, closePrice, tsMs: closeTs, reason: "period_end" });
    }

    return {
        ...buildSummary(ctx, "prices"),
        ctx,
        rowsBySymbol,
        rowCounts: Object.fromEntries(
            TARGET_SYMBOLS.map((s) => [
                s,
                rowsBySymbol.get(s).filter((r) => r.tsMs >= startMs && r.tsMs <= endMs).length,
            ]),
        ),
    };
}

function extractRanges(rangesBySymbol) {
    const starts = [];
    const ends = [];
    for (const symbol of TARGET_SYMBOLS) {
        const range = rangesBySymbol[symbol];
        if (!range) continue;
        starts.push(range.firstTs);
        ends.push(range.lastTs);
    }
    return {
        startAll: starts.length ? Math.max(...starts) : null,
        endAll: ends.length ? Math.min(...ends) : null,
    };
}

function computeCadenceFromRows(rowsBySymbol, { isGenerated }) {
    const bySymbol = {};
    for (const symbol of TARGET_SYMBOLS) {
        const rows = isGenerated ? rowsBySymbol.get(symbol).M1 : rowsBySymbol.get(symbol);
        const deltasSec = [];
        for (let i = 1; i < rows.length; i += 1) {
            const prev = Number(rows[i - 1]?.tsMs);
            const curr = Number(rows[i]?.tsMs);
            if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
            const dt = (curr - prev) / 1000;
            if (dt >= 0) deltasSec.push(dt);
        }
        bySymbol[symbol] = summarizeArray(deltasSec);
    }
    return bySymbol;
}

function computeSpreadStats(rowsBySymbol, { isGenerated }) {
    const bySymbol = {};
    for (const symbol of TARGET_SYMBOLS) {
        const spreads = [];
        if (isGenerated) {
            const rows = rowsBySymbol.get(symbol).M1;
            for (const row of rows) {
                if (!Number.isFinite(row?.tsMs)) continue;
                spreads.push(0);
            }
        } else {
            const rows = rowsBySymbol.get(symbol);
            for (const row of rows) {
                const spread = toNum(row?.spread);
                if (Number.isFinite(spread)) spreads.push(spread);
            }
        }
        bySymbol[symbol] = summarizeArray(spreads);
    }
    return bySymbol;
}

function computeNewsBlockedStats(rowsBySymbol) {
    const bySymbol = {};
    for (const symbol of TARGET_SYMBOLS) {
        const rows = rowsBySymbol.get(symbol);
        let blocked = 0;
        for (const row of rows) {
            if (row?.newsBlocked) blocked += 1;
        }
        bySymbol[symbol] = { blockedRows: blocked, totalRows: rows.length, blockedRate: rows.length ? blocked / rows.length : null };
    }
    return bySymbol;
}

function compareSourceSeries(generatedDataBySymbol, pricesRowsBySymbol, { startMs, endMs }) {
    const perSymbol = {};
    for (const symbol of TARGET_SYMBOLS) {
        const gRows = generatedDataBySymbol.get(symbol).M1.filter((r) => r.tsMs >= startMs && r.tsMs <= endMs);
        const pRows = pricesRowsBySymbol.get(symbol).filter((r) => r.tsMs >= startMs && r.tsMs <= endMs);

        const gMap = new Map();
        for (const row of gRows) {
            gMap.set(minuteKey(row.tsMs), row);
        }
        const pMap = new Map();
        for (const row of pRows) {
            pMap.set(minuteKey(row.tsMs), row);
        }

        const sharedKeys = [...gMap.keys()].filter((k) => pMap.has(k));
        const midDiff = [];
        const rsiDiff = [];
        for (const key of sharedKeys) {
            const g = gMap.get(key);
            const p = pMap.get(key);
            const gClose = toNum(g?.close);
            const pMid = toNum(p?.mid);
            if (Number.isFinite(gClose) && Number.isFinite(pMid)) midDiff.push(Math.abs(gClose - pMid));
            const gRsi = toNum(g?.rsi);
            const pRsi = toNum(p?.indicators?.m1?.rsi);
            if (Number.isFinite(gRsi) && Number.isFinite(pRsi)) rsiDiff.push(Math.abs(gRsi - pRsi));
        }

        perSymbol[symbol] = {
            generatedRows: gRows.length,
            pricesRows: pRows.length,
            sharedMinutes: sharedKeys.length,
            generatedOnlyMinutes: Math.max(0, gRows.length - sharedKeys.length),
            pricesOnlyMinutes: Math.max(0, pRows.length - sharedKeys.length),
            absMidDiff: summarizeArray(midDiff),
            absRsiDiff: summarizeArray(rsiDiff),
        };
    }
    return perSymbol;
}

async function run() {
    const generatedRanges = {};
    const pricesRanges = {};

    for (const symbol of TARGET_SYMBOLS) {
        generatedRanges[symbol] = await fileTimestampRange(path.join(GENERATED_DIR, `${symbol}_M1.jsonl`));
        pricesRanges[symbol] = await fileTimestampRange(path.join(PRICES_DIR, `${symbol}.jsonl`), { priceSanitySymbol: symbol });
    }

    for (const symbol of TARGET_SYMBOLS) {
        if (!generatedRanges[symbol]) throw new Error(`Missing generated M1 range for ${symbol}`);
        if (!pricesRanges[symbol]) throw new Error(`Missing prices range for ${symbol}`);
    }

    const generatedAll = extractRanges(generatedRanges);
    const pricesAll = extractRanges(pricesRanges);
    if (!Number.isFinite(generatedAll?.endAll) || !Number.isFinite(pricesAll?.endAll)) {
        throw new Error("Cannot determine source ranges.");
    }

    const commonEnd = Math.min(generatedAll.endAll, pricesAll.endAll);
    const requestedStart = commonEnd - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const commonStart = Math.max(requestedStart, generatedAll.startAll, pricesAll.startAll);
    if (!(commonStart < commonEnd)) throw new Error("No overlapping compare window.");
    const warmupStart = commonStart - 3 * 24 * 60 * 60 * 1000;

    const generated = await simulateGenerated({ startMs: commonStart, endMs: commonEnd, warmupStartMs: warmupStart });
    const prices = await simulatePrices({ startMs: commonStart, endMs: commonEnd, warmupStartMs: warmupStart });

    const generatedEntrySet = new Set(generated.ctx.entries.map((e) => entryKey(e)));
    const pricesEntrySet = new Set(prices.ctx.entries.map((e) => entryKey(e)));
    const matchedExact = generated.ctx.entries.filter((e) => pricesEntrySet.has(entryKey(e)));
    const generatedOnly = generated.ctx.entries.filter((e) => !pricesEntrySet.has(entryKey(e)));
    const pricesOnly = prices.ctx.entries.filter((e) => !generatedEntrySet.has(entryKey(e)));

    const generatedClosedByEntry = new Map(generated.ctx.closedTrades.map((t) => [entryKey({ symbol: t.symbol, tsMs: t.entryTsMs, side: t.side }), t]));
    const pricesClosedByEntry = new Map(prices.ctx.closedTrades.map((t) => [entryKey({ symbol: t.symbol, tsMs: t.entryTsMs, side: t.side }), t]));
    const generatedOnlyProfitable = generatedOnly.filter((e) => (generatedClosedByEntry.get(entryKey(e))?.r || 0) > 0).length;
    const pricesOnlyProfitable = pricesOnly.filter((e) => (pricesClosedByEntry.get(entryKey(e))?.r || 0) > 0).length;

    const tolerant2m = tolerantEntryMatch(generated.ctx.entries, prices.ctx.entries, { toleranceMinutes: 2, requireSameSide: true });
    const tolerant5m = tolerantEntryMatch(generated.ctx.entries, prices.ctx.entries, { toleranceMinutes: 5, requireSameSide: true });

    const generatedBlockedTop = countBy(generated.ctx.blockedSignals, (x) => x.reason).slice(0, 10);
    const pricesBlockedTop = countBy(prices.ctx.blockedSignals, (x) => x.reason).slice(0, 10);
    const pricesFilterTop = countBy(prices.ctx.blockedByFilter, (x) => x.reason).slice(0, 10);

    const generatedCadence = computeCadenceFromRows(generated.dataBySymbol, { isGenerated: true });
    const pricesCadence = computeCadenceFromRows(prices.rowsBySymbol, { isGenerated: false });
    const generatedSpread = computeSpreadStats(generated.dataBySymbol, { isGenerated: true });
    const pricesSpread = computeSpreadStats(prices.rowsBySymbol, { isGenerated: false });
    const pricesNews = computeNewsBlockedStats(prices.rowsBySymbol);
    const seriesCompare = compareSourceSeries(generated.dataBySymbol, prices.rowsBySymbol, { startMs: commonStart, endMs: commonEnd });

    const overviewTable = renderTable(
        ["Metric", "generated-dataset", "prices", "Delta (prices - generated)"],
        [
            ["Window", `${new Date(commonStart).toISOString()} -> ${new Date(commonEnd).toISOString()}`, `${new Date(commonStart).toISOString()} -> ${new Date(commonEnd).toISOString()}`, "same"],
            ["Trades", String(generated.trades), String(prices.trades), String(prices.trades - generated.trades)],
            ["Winrate", pct(generated.winRate), pct(prices.winRate), pct((prices.winRate ?? 0) - (generated.winRate ?? 0))],
            ["Net R", num(generated.netR, 4), num(prices.netR, 4), num((prices.netR ?? 0) - (generated.netR ?? 0), 4)],
            ["Profit Factor", num(generated.pf, 4), num(prices.pf, 4), num((prices.pf ?? 0) - (generated.pf ?? 0), 4)],
            ["PnL (EUR)", num(generated.rawPnl), num(prices.rawPnl), num((prices.rawPnl ?? 0) - (generated.rawPnl ?? 0))],
            ["End Equity (EUR)", num(generated.endEquity), num(prices.endEquity), num((prices.endEquity ?? 0) - (generated.endEquity ?? 0))],
            ["Max DD (EUR)", num(generated.maxDdAbs), num(prices.maxDdAbs), num((prices.maxDdAbs ?? 0) - (generated.maxDdAbs ?? 0))],
            ["Potential Signals", String(generated.potentialSignals), String(prices.potentialSignals), String(prices.potentialSignals - generated.potentialSignals)],
            ["Executed Signals", String(generated.executedSignals), String(prices.executedSignals), String(prices.executedSignals - generated.executedSignals)],
            ["Blocked Signals", String(generated.blockedSignals), String(prices.blockedSignals), String(prices.blockedSignals - generated.blockedSignals)],
        ],
    );

    const pairRows = TARGET_SYMBOLS.map((symbol) => {
        const g = generated.pairRows.find((x) => x.symbol === symbol) || {};
        const p = prices.pairRows.find((x) => x.symbol === symbol) || {};
        return [
            symbol,
            String(g.trades ?? 0),
            pct(g.winRate),
            num(g.netR, 4),
            num(g.pnl),
            String(p.trades ?? 0),
            pct(p.winRate),
            num(p.netR, 4),
            num(p.pnl),
        ];
    });
    const pairTable = renderTable(
        ["Pair", "Gen Trades", "Gen WR", "Gen NetR", "Gen PnL", "Price Trades", "Price WR", "Price NetR", "Price PnL"],
        pairRows,
    );

    const matchingTable = renderTable(
        ["Metric", "Value"],
        [
            ["Generated entries", String(generated.ctx.entries.length)],
            ["Prices entries", String(prices.ctx.entries.length)],
            ["Exact match (symbol+minute+side)", String(matchedExact.length)],
            ["Generated-only entries", String(generatedOnly.length)],
            ["Prices-only entries", String(pricesOnly.length)],
            ["Generated-only profitable trades", String(generatedOnlyProfitable)],
            ["Prices-only profitable trades", String(pricesOnlyProfitable)],
            ["Tolerant same-side ±2m matched", `${tolerant2m.matched} (${pct(tolerant2m.aMatchRate)})`],
            ["Tolerant same-side ±5m matched", `${tolerant5m.matched} (${pct(tolerant5m.aMatchRate)})`],
        ],
    );

    const blockedTable = renderTable(
        ["Reason", "Generated blocked", "Prices blocked", "Prices filter blocks"],
        [...new Set([...generatedBlockedTop.map(([r]) => r), ...pricesBlockedTop.map(([r]) => r), ...pricesFilterTop.map(([r]) => r)])]
            .sort((a, b) => a.localeCompare(b))
            .map((reason) => [
                reason,
                String(generatedBlockedTop.find(([r]) => r === reason)?.[1] || 0),
                String(pricesBlockedTop.find(([r]) => r === reason)?.[1] || 0),
                String(pricesFilterTop.find(([r]) => r === reason)?.[1] || 0),
            ]),
    );

    const dataQualityRows = [];
    for (const symbol of TARGET_SYMBOLS) {
        const cmp = seriesCompare[symbol];
        dataQualityRows.push([
            symbol,
            String(cmp.generatedRows),
            String(cmp.pricesRows),
            String(cmp.sharedMinutes),
            String(cmp.generatedOnlyMinutes),
            String(cmp.pricesOnlyMinutes),
            num(cmp.absMidDiff.p50, 6),
            num(cmp.absMidDiff.p90, 6),
            num(cmp.absRsiDiff.p50, 4),
        ]);
    }
    const dataQualityTable = renderTable(
        ["Pair", "Gen rows", "Price rows", "Shared mins", "Gen-only mins", "Price-only mins", "|mid-close| p50", "|mid-close| p90", "|RSI diff| p50"],
        dataQualityRows,
    );

    const spreadRows = TARGET_SYMBOLS.map((symbol) => [
        symbol,
        num(generatedSpread[symbol]?.p50, 6),
        num(generatedSpread[symbol]?.p90, 6),
        num(pricesSpread[symbol]?.p50, 6),
        num(pricesSpread[symbol]?.p90, 6),
        num(pricesNews[symbol]?.blockedRate, 4),
    ]);
    const spreadTable = renderTable(
        ["Pair", "Gen spread p50", "Gen spread p90", "Price spread p50", "Price spread p90", "Price newsBlocked rate"],
        spreadRows,
    );

    const cadenceRows = TARGET_SYMBOLS.map((symbol) => [
        symbol,
        num(generatedCadence[symbol]?.p50, 2),
        num(generatedCadence[symbol]?.p90, 2),
        num(pricesCadence[symbol]?.p50, 2),
        num(pricesCadence[symbol]?.p90, 2),
    ]);
    const cadenceTable = renderTable(
        ["Pair", "Gen dt p50 (sec)", "Gen dt p90 (sec)", "Price dt p50 (sec)", "Price dt p90 (sec)"],
        cadenceRows,
    );

    const sampleGeneratedOnly = generatedOnly.slice(0, 15).map((e) => {
        const closed = generatedClosedByEntry.get(entryKey(e));
        return {
            symbol: e.symbol,
            minute: minuteKey(e.tsMs),
            side: e.side,
            r: closed?.r ?? null,
        };
    });
    const samplePricesOnly = pricesOnly.slice(0, 15).map((e) => {
        const closed = pricesClosedByEntry.get(entryKey(e));
        return {
            symbol: e.symbol,
            minute: minuteKey(e.tsMs),
            side: e.side,
            r: closed?.r ?? null,
        };
    });

    console.log("=== SOURCE RANGES ===");
    console.log(
        JSON.stringify(
            {
                symbols: TARGET_SYMBOLS,
                generatedRangeBySymbol: Object.fromEntries(
                    TARGET_SYMBOLS.map((s) => [
                        s,
                        {
                            start: new Date(generatedRanges[s].firstTs).toISOString(),
                            end: new Date(generatedRanges[s].lastTs).toISOString(),
                        },
                    ]),
                ),
                pricesRangeBySymbol: Object.fromEntries(
                    TARGET_SYMBOLS.map((s) => [
                        s,
                        {
                            start: new Date(pricesRanges[s].firstTs).toISOString(),
                            end: new Date(pricesRanges[s].lastTs).toISOString(),
                        },
                    ]),
                ),
                requestedLookbackDays: LOOKBACK_DAYS,
                commonWindowUsed: {
                    start: new Date(commonStart).toISOString(),
                    end: new Date(commonEnd).toISOString(),
                    durationHours: Number(((commonEnd - commonStart) / 3600000).toFixed(2)),
                },
            },
            null,
            2,
        ),
    );

    console.log("\n=== OVERVIEW ===");
    console.log(overviewTable);

    console.log("\n=== BY PAIR ===");
    console.log(pairTable);

    console.log("\n=== ENTRY MATCHING ===");
    console.log(matchingTable);

    console.log("\n=== BLOCK REASONS ===");
    console.log(blockedTable);

    console.log("\n=== DATA COVERAGE / ALIGNMENT ===");
    console.log(dataQualityTable);

    console.log("\n=== SPREAD + NEWS ===");
    console.log(spreadTable);

    console.log("\n=== TIMING CADENCE ===");
    console.log(cadenceTable);

    console.log("\n=== SAMPLE GENERATED-ONLY ENTRIES (FIRST 15) ===");
    console.log(JSON.stringify(sampleGeneratedOnly, null, 2));

    console.log("\n=== SAMPLE PRICES-ONLY ENTRIES (FIRST 15) ===");
    console.log(JSON.stringify(samplePricesOnly, null, 2));
}

run().catch((error) => {
    console.error("[compareGeneratedVsPrices] Failed:", error);
    process.exit(1);
});
