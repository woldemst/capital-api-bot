import fs from "fs";
import path from "path";
import { createIntradaySevenStepEngine } from "../intraday/engine.js";
import { DEFAULT_INTRADAY_CONFIG } from "../intraday/config.js";
import { createIntradayRuntimeState, ensureStateDay, registerClosedTrade, registerOpenedTrade } from "../intraday/state.js";
import { CRYPTO_SYMBOLS, RISK, SESSIONS } from "../config.js";

const PRICES_DIR = path.join(process.cwd(), "backtest", "prices");
const LOGS_DIR = path.join(process.cwd(), "backtest", "logs");
const LOOKBACK_DAYS = 3;

const FOREX_RISK_PCT = Number(RISK?.PER_TRADE) || 0.05;
const CRYPTO_RISK_PCT = Number(RISK?.CRYPTO_PER_TRADE) || 0.04;
const MAX_POSITIONS = Number(RISK?.MAX_POSITIONS) || 5;
const GUARDS = RISK?.GUARDS || {};
const EXITS = RISK?.EXITS || {};

const MAX_DAILY_LOSS_PCT = Number.isFinite(Number(GUARDS.MAX_DAILY_LOSS_PCT)) ? Number(GUARDS.MAX_DAILY_LOSS_PCT) : 0;
const MAX_OPEN_RISK_PCT = Number.isFinite(Number(GUARDS.MAX_OPEN_RISK_PCT))
    ? Number(GUARDS.MAX_OPEN_RISK_PCT)
    : Math.max(FOREX_RISK_PCT, CRYPTO_RISK_PCT) * 2;
const MAX_LOSS_STREAK = Number.isFinite(Number(GUARDS.MAX_LOSS_STREAK)) ? Number(GUARDS.MAX_LOSS_STREAK) : 3;
const LOSS_STREAK_COOLDOWN_MINUTES = Number.isFinite(Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES))
    ? Number(GUARDS.LOSS_STREAK_COOLDOWN_MINUTES)
    : 0;

const ROLLOVER_TZ = "America/New_York";
const ROLLOVER_HOUR = 17;
const ROLLOVER_MINUTE = 0;
const ROLLOVER_BUFFER_MINUTES = 10;

const intradayForexConfig = {
    ...DEFAULT_INTRADAY_CONFIG,
    strategyId: "INTRADAY_7STEP_FOREX",
    context: { ...(DEFAULT_INTRADAY_CONFIG.context || {}) },
    setup: { ...(DEFAULT_INTRADAY_CONFIG.setup || {}) },
    trigger: { ...(DEFAULT_INTRADAY_CONFIG.trigger || {}) },
    risk: { ...(DEFAULT_INTRADAY_CONFIG.risk || {}) },
    guardrails: { ...(DEFAULT_INTRADAY_CONFIG.guardrails || {}) },
    backtest: { ...(DEFAULT_INTRADAY_CONFIG.backtest || {}) },
};

const intradayCryptoConfig = {
    ...DEFAULT_INTRADAY_CONFIG,
    strategyId: "INTRADAY_7STEP_CRYPTO",
    context: {
        ...(DEFAULT_INTRADAY_CONFIG.context || {}),
        adxTrendMin: 18,
        adxRangeMax: 18,
    },
    setup: {
        ...(DEFAULT_INTRADAY_CONFIG.setup || {}),
        trendPullbackZonePct: 0.0023,
        trendRsiMin: 38,
        trendRsiMax: 62,
        rangeBbPbLow: 0.2,
        rangeBbPbHigh: 0.8,
        rangeRsiLow: 40,
        rangeRsiHigh: 60,
    },
    trigger: {
        ...(DEFAULT_INTRADAY_CONFIG.trigger || {}),
        displacementAtrMultiplier: 1.0,
        requireStructureBreak: false,
    },
    risk: { ...(DEFAULT_INTRADAY_CONFIG.risk || {}) },
    guardrails: {
        ...(DEFAULT_INTRADAY_CONFIG.guardrails || {}),
        allowRangeContrarian: true,
    },
    backtest: { ...(DEFAULT_INTRADAY_CONFIG.backtest || {}) },
};

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function fmtPct(value) {
    if (!Number.isFinite(value)) return "n/a";
    return `${(value * 100).toFixed(2)}%`;
}

function fmtNum(value, d = 2) {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(d);
}

function minuteKey(tsMs) {
    return new Date(tsMs).toISOString().slice(0, 16);
}

function utcDayKey(tsMs) {
    return new Date(tsMs).toISOString().slice(0, 10);
}

function normalizeDirection(signalOrSide) {
    const s = String(signalOrSide || "").toUpperCase();
    if (s === "BUY" || s === "LONG") return "LONG";
    if (s === "SELL" || s === "SHORT") return "SHORT";
    return null;
}

function isCryptoSymbol(symbol) {
    return CRYPTO_SYMBOLS.includes(String(symbol || "").toUpperCase());
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
    const currentMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (day === 6) return true;
    if (day === 0 && currentMinutes < 22 * 60) return true;
    if (day === 5 && currentMinutes >= 22 * 60) return true;
    return false;
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

function symbolAllowedByActiveSessions(symbol, activeSessionNames) {
    const upper = String(symbol || "").toUpperCase();
    for (const sessionName of activeSessionNames) {
        const symbols = (SESSIONS?.[sessionName]?.SYMBOLS || []).map((s) => String(s).toUpperCase());
        if (symbols.includes(upper)) return true;
    }
    return false;
}

function isRolloverBuffer(tsMs) {
    const rolloverMinutes = ROLLOVER_HOUR * 60 + ROLLOVER_MINUTE;
    const nyMinutes = getMinutesInTimeZone(ROLLOVER_TZ, tsMs);
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
    if (!Array.isArray(values) || !values.length) {
        return { n: 0, min: null, p50: null, p90: null, p99: null, max: null };
    }
    return {
        n: values.length,
        min: quantile(values, 0),
        p50: quantile(values, 0.5),
        p90: quantile(values, 0.9),
        p99: quantile(values, 0.99),
        max: quantile(values, 1),
    };
}

function minuteBucket(tsMs, bucketMinutes = 5) {
    const bucketMs = bucketMinutes * 60 * 1000;
    const bucket = Math.floor(tsMs / bucketMs) * bucketMs;
    return new Date(bucket).toISOString().slice(0, 16);
}

function tolerantEntryMatch(replayEntries, actualEntries, { toleranceMinutes = 2, requireSameSide = true } = {}) {
    const toleranceMs = toleranceMinutes * 60 * 1000;
    const bySymbol = new Map();
    for (const entry of actualEntries) {
        if (!bySymbol.has(entry.symbol)) bySymbol.set(entry.symbol, []);
        bySymbol.get(entry.symbol).push({ ...entry, used: false });
    }
    for (const arr of bySymbol.values()) {
        arr.sort((a, b) => a.tsMs - b.tsMs);
    }

    let matched = 0;
    for (const replay of replayEntries) {
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

    const totalReplay = replayEntries.length;
    const totalActual = actualEntries.length;
    return {
        toleranceMinutes,
        requireSameSide,
        matched,
        replayOnly: Math.max(0, totalReplay - matched),
        actualOnly: Math.max(0, totalActual - matched),
        replayMatchRate: totalReplay > 0 ? matched / totalReplay : null,
        actualCoverageRate: totalActual > 0 ? matched / totalActual : null,
    };
}

function loadJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) return [];
    const out = [];
    for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line));
        } catch {
            // ignore malformed line
        }
    }
    return out;
}

function readPricesWindow() {
    const files = fs.readdirSync(PRICES_DIR).filter((f) => f.endsWith(".jsonl")).sort();
    const allBySymbol = new Map();
    let maxTs = 0;
    for (const file of files) {
        const symbol = file.replace(".jsonl", "").toUpperCase();
        const rows = loadJsonl(path.join(PRICES_DIR, file))
            .map((r) => ({ ...r, symbol: symbol, tsMs: Date.parse(String(r.timestamp || "")) }))
            .filter((r) => Number.isFinite(r.tsMs))
            .sort((a, b) => a.tsMs - b.tsMs);
        if (!rows.length) continue;
        maxTs = Math.max(maxTs, rows[rows.length - 1].tsMs);
        allBySymbol.set(symbol, rows);
    }
    const startTs = maxTs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const filtered = new Map();
    for (const [symbol, rows] of allBySymbol.entries()) {
        const inRange = rows.filter((r) => r.tsMs >= startTs && r.tsMs <= maxTs);
        if (inRange.length) filtered.set(symbol, inRange);
    }
    return { startTs, endTs: maxTs, bySymbol: filtered };
}

function readActualTradesWindow(startTs, endTs) {
    const files = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith(".jsonl")).sort();
    const trades = [];
    for (const file of files) {
        const symbol = file.replace(".jsonl", "").toUpperCase();
        const rows = loadJsonl(path.join(LOGS_DIR, file));
        for (const t of rows) {
            const openedAtMs = Date.parse(String(t.openedAt || t.timestamp || ""));
            if (!Number.isFinite(openedAtMs)) continue;
            if (openedAtMs < startTs || openedAtMs > endTs) continue;
            trades.push({
                symbol,
                openedAtMs,
                openedAt: t.openedAt || t.timestamp,
                closedAtMs: Date.parse(String(t.closedAt || "")),
                closedAt: t.closedAt || null,
                signal: t.signal || null,
                side: normalizeDirection(t.signal),
                strategyId: t.strategyId || t?.riskMeta?.strategyId || null,
                openReason: t.openReason || "",
                closeReason: t.closeReason || "",
                status: t.status || null,
            });
        }
    }
    return trades.sort((a, b) => a.openedAtMs - b.openedAtMs);
}

function main() {
    const { startTs, endTs, bySymbol } = readPricesWindow();
    const symbols = [...bySymbol.keys()].sort();
    const events = [];
    for (const symbol of symbols) {
        for (const row of bySymbol.get(symbol)) {
            events.push({ symbol, ...row });
        }
    }
    events.sort((a, b) => (a.tsMs === b.tsMs ? a.symbol.localeCompare(b.symbol) : a.tsMs - b.tsMs));

    const forexEngine = createIntradaySevenStepEngine(intradayForexConfig);
    const cryptoEngine = createIntradaySevenStepEngine(intradayCryptoConfig);
    const forexState = createIntradayRuntimeState({ strategyId: intradayForexConfig.strategyId });
    const cryptoState = createIntradayRuntimeState({ strategyId: intradayCryptoConfig.strategyId });

    const openPositions = new Map();
    const closedTrades = [];
    const replayEntries = [];
    const potentialSignals = [];
    const blockedSignals = [];

    const historyBySymbol = new Map();
    for (const symbol of symbols) {
        historyBySymbol.set(symbol, {
            m15Bars: [],
            m5Bars: [],
            lastM15Key: null,
            lastM5Key: null,
        });
    }

    let equity = 500;
    let lastRolloverCloseKey = null;

    function getOpenRiskPct() {
        let sum = 0;
        for (const p of openPositions.values()) sum += Number(p.riskPct) || 0;
        return sum;
    }

    function guardSummaryFor(tsMs) {
        const day = utcDayKey(tsMs);
        const periodClosed = closedTrades.filter((t) => utcDayKey(t.closeTsMs) === day);
        const todayEstimatedPnlPct = periodClosed.reduce((sum, t) => sum + t.r * (Number(t.riskPct) || 0), 0);
        const todayEstimatedLossPctAbs = Math.abs(Math.min(0, todayEstimatedPnlPct));

        let currentLossStreak = 0;
        let lastLossAtMs = null;
        for (const t of closedTrades) {
            if (t.r < 0) {
                currentLossStreak += 1;
                lastLossAtMs = t.closeTsMs;
            } else if (t.r > 0) {
                currentLossStreak = 0;
            }
        }
        return { todayEstimatedLossPctAbs, currentLossStreak, lastLossAtMs };
    }

    function closePosition(pos, closePrice, tsMs, reason) {
        const riskDistance = Math.abs(pos.entryPrice - pos.initialSl);
        if (!(riskDistance > 0)) return;
        const pnlDistance = pos.side === "LONG" ? closePrice - pos.entryPrice : pos.entryPrice - closePrice;
        const r = pnlDistance / riskDistance;
        const rawPnl = pos.riskAmount * r;
        equity += rawPnl;
        const closed = {
            ...pos,
            closeTsMs: tsMs,
            closePrice,
            r,
            rawPnl,
            closeReason: reason,
        };
        closedTrades.push(closed);
        openPositions.delete(pos.symbol);
        if (pos.assetClass === "crypto") registerClosedTrade(cryptoState, { symbol: pos.symbol, pnl: rawPnl });
        else registerClosedTrade(forexState, { symbol: pos.symbol, pnl: rawPnl });
    }

    for (const ev of events) {
        const symbol = ev.symbol;
        const tsMs = ev.tsMs;
        const snapshot = ev;
        const isCrypto = isCryptoSymbol(symbol);
        const state = isCrypto ? cryptoState : forexState;
        const engine = isCrypto ? cryptoEngine : forexEngine;

        ensureStateDay(forexState, tsMs);
        ensureStateDay(cryptoState, tsMs);

        // keep duplicate-symbol guard in sync with global positions
        forexState.openPositions = new Map();
        cryptoState.openPositions = new Map();
        for (const [s, p] of openPositions.entries()) {
            const mapped = {
                symbol: s,
                side: p.side,
                entryPrice: p.entryPrice,
                currentSl: p.currentSl,
                initialSl: p.initialSl,
                takeProfit: p.takeProfit,
                size: p.size,
                entryTimestamp: p.entryTimestamp,
                assetClass: p.assetClass,
            };
            forexState.openPositions.set(s, mapped);
            cryptoState.openPositions.set(s, mapped);
        }

        // rollover close (forex only)
        const rolloverKey = getDateKeyInTimeZone(ROLLOVER_TZ, tsMs);
        if (isRolloverBuffer(tsMs) && rolloverKey !== lastRolloverCloseKey) {
            lastRolloverCloseKey = rolloverKey;
            for (const [s, p] of [...openPositions.entries()]) {
                if (p.assetClass !== "forex") continue;
                const currentMid = toNum(snapshot?.mid ?? snapshot?.price ?? snapshot?.bid ?? snapshot?.ask);
                if (!Number.isFinite(currentMid)) continue;
                closePosition(p, currentMid, tsMs, "rollover");
            }
        }

        // update candle history for prev/prev2 reconstruction
        const h = historyBySymbol.get(symbol);
        const m15 = snapshot?.candles?.m15 || null;
        const m5 = snapshot?.candles?.m5 || null;
        const m15Key = m15 ? `${m15.o}|${m15.h}|${m15.l}|${m15.c}` : null;
        const m5Key = m5 ? `${m5.o}|${m5.h}|${m5.l}|${m5.c}` : null;
        if (m15Key && m15Key !== h.lastM15Key) {
            h.m15Bars.push(m15);
            if (h.m15Bars.length > 50) h.m15Bars.shift();
            h.lastM15Key = m15Key;
        }
        if (m5Key && m5Key !== h.lastM5Key) {
            h.m5Bars.push(m5);
            if (h.m5Bars.length > 100) h.m5Bars.shift();
            h.lastM5Key = m5Key;
        }

        // manage open position for this symbol
        const open = openPositions.get(symbol);
        if (open) {
            const m1 = snapshot?.candles?.m1 || null;
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
                closePosition(open, slHit ? sl : tp, tsMs, slHit ? "hit_sl" : "hit_tp");
            } else {
                const currentPrice = toNum(snapshot?.mid ?? snapshot?.price ?? snapshot?.bid ?? snapshot?.ask);
                if (Number.isFinite(currentPrice)) {
                    applyTrailingAndBreakeven(open, currentPrice, {
                        m5: snapshot?.indicators?.m5 || null,
                        m15: snapshot?.indicators?.m15 || null,
                    });
                }
            }
        }

        // simulate bot-level active symbol filter
        const activeSessions = getActiveSessionNames(tsMs);
        let botWouldAnalyze = true;
        if (!isCrypto) {
            if (isForexWeekendClosed(tsMs)) botWouldAnalyze = false;
            if (botWouldAnalyze && !symbolAllowedByActiveSessions(symbol, activeSessions)) botWouldAnalyze = false;
            if (botWouldAnalyze && isRolloverBuffer(tsMs)) botWouldAnalyze = false;
            if (botWouldAnalyze && snapshot?.newsBlocked) botWouldAnalyze = false;
        }
        if (!botWouldAnalyze) continue;

        const mid = toNum(snapshot?.mid ?? snapshot?.price ?? snapshot?.bid ?? snapshot?.ask);
        const bid = toNum(snapshot?.bid ?? mid);
        const ask = toNum(snapshot?.ask ?? mid);
        if (![mid, bid, ask].every(Number.isFinite)) continue;

        const m15Bars = h.m15Bars;
        const m5Bars = h.m5Bars;
        const prevM15 = m15Bars.length >= 2 ? m15Bars[m15Bars.length - 2] : null;
        const prevM5 = m5Bars.length >= 2 ? m5Bars[m5Bars.length - 2] : null;
        const prev2M5 = m5Bars.length >= 3 ? m5Bars[m5Bars.length - 3] : null;

        const replaySnapshot = {
            symbol,
            timestamp: snapshot.timestamp,
            bid,
            ask,
            mid,
            spread: toNum(snapshot?.spread) ?? Math.abs(ask - bid),
            sessions: Array.isArray(snapshot?.sessions) ? snapshot.sessions : [],
            newsBlocked: Boolean(snapshot?.newsBlocked),
            indicators: {
                h1: snapshot?.indicators?.h1 || {},
                m15: snapshot?.indicators?.m15 || {},
                m5: snapshot?.indicators?.m5 || {},
                m1: snapshot?.indicators?.m1 || {},
            },
            bars: {
                h1: snapshot?.candles?.h1 || null,
                m15: snapshot?.candles?.m15 || null,
                m5: snapshot?.candles?.m5 || null,
                m1: snapshot?.candles?.m1 || null,
            },
            prevBars: {
                m15: prevM15,
                m5: prevM5,
            },
            prev2Bars: {
                m5: prev2M5,
            },
            equity,
        };

        const decision = engine.evaluateSnapshot({ snapshot: replaySnapshot, state });
        const plan = decision?.step5?.orderPlan || null;
        if (!decision?.step5?.valid || !plan) continue;

        potentialSignals.push({
            symbol,
            tsMs,
            key: `${symbol}|${minuteKey(tsMs)}`,
            side: plan.side,
            reasons: decision?.reasons || [],
        });

        if (openPositions.has(symbol)) {
            blockedSignals.push({ symbol, tsMs, reason: "symbol_already_in_position" });
            continue;
        }
        if (openPositions.size >= MAX_POSITIONS) {
            blockedSignals.push({ symbol, tsMs, reason: "max_positions_reached" });
            continue;
        }

        const riskPct = Number.isFinite(Number(plan?.riskPct)) ? Number(plan.riskPct) : isCrypto ? CRYPTO_RISK_PCT : FOREX_RISK_PCT;
        const guardSummary = guardSummaryFor(tsMs);
        if (MAX_DAILY_LOSS_PCT > 0 && guardSummary.todayEstimatedLossPctAbs >= MAX_DAILY_LOSS_PCT) {
            blockedSignals.push({ symbol, tsMs, reason: "daily_loss_limit" });
            continue;
        }
        if (MAX_LOSS_STREAK > 0 && LOSS_STREAK_COOLDOWN_MINUTES > 0 && guardSummary.currentLossStreak >= MAX_LOSS_STREAK) {
            const cooldownMs = LOSS_STREAK_COOLDOWN_MINUTES * 60 * 1000;
            const cooldownActive = Number.isFinite(guardSummary.lastLossAtMs) ? tsMs - guardSummary.lastLossAtMs < cooldownMs : true;
            if (cooldownActive) {
                blockedSignals.push({ symbol, tsMs, reason: "loss_streak_cooldown" });
                continue;
            }
        }
        if (getOpenRiskPct() + riskPct > MAX_OPEN_RISK_PCT + 1e-9) {
            blockedSignals.push({ symbol, tsMs, reason: "open_risk_cap" });
            continue;
        }

        const entryPrice = toNum(plan.entryPrice);
        const sl = toNum(plan.sl);
        const tp = toNum(plan.tp);
        const size = toNum(plan.size);
        const riskAmount = toNum(plan.riskAmount) ?? equity * riskPct;
        if (![entryPrice, sl, tp, size, riskAmount].every(Number.isFinite)) {
            blockedSignals.push({ symbol, tsMs, reason: "invalid_plan_numbers" });
            continue;
        }
        if (!(Math.abs(entryPrice - sl) > 0)) {
            blockedSignals.push({ symbol, tsMs, reason: "invalid_stop_distance" });
            continue;
        }

        const trade = {
            symbol,
            assetClass: isCrypto ? "crypto" : "forex",
            side: String(plan.side || "").toUpperCase(),
            entryTsMs: tsMs,
            entryTimestamp: snapshot.timestamp,
            entryPrice,
            initialSl: sl,
            currentSl: sl,
            takeProfit: tp,
            size,
            riskPct,
            riskAmount,
            sourceReasons: decision?.reasons || [],
        };
        openPositions.set(symbol, trade);
        replayEntries.push({
            symbol,
            tsMs,
            key: `${symbol}|${minuteKey(tsMs)}`,
            side: trade.side,
        });
        registerOpenedTrade(state, {
            symbol,
            side: trade.side,
            entryPrice: trade.entryPrice,
            currentSl: trade.currentSl,
            initialSl: trade.initialSl,
            takeProfit: trade.takeProfit,
            size: trade.size,
            entryTimestamp: trade.entryTimestamp,
            assetClass: trade.assetClass,
        });
    }

    // force-close leftovers at last known mid
    const lastBySymbol = new Map();
    for (const ev of events) lastBySymbol.set(ev.symbol, ev);
    for (const [symbol, pos] of [...openPositions.entries()]) {
        const last = lastBySymbol.get(symbol);
        const closePrice = toNum(last?.mid ?? last?.price ?? last?.bid ?? last?.ask);
        const closeTs = Number.isFinite(last?.tsMs) ? last.tsMs : endTs;
        if (Number.isFinite(closePrice)) closePosition(pos, closePrice, closeTs, "period_end");
    }

    const actualTrades = readActualTradesWindow(startTs, endTs);
    const actualEntries = actualTrades.map((t) => ({
        symbol: t.symbol,
        tsMs: t.openedAtMs,
        key: `${t.symbol}|${minuteKey(t.openedAtMs)}`,
        side: t.side,
    }));

    const replayEntrySet = new Set(replayEntries.map((e) => e.key));
    const actualEntrySet = new Set(actualEntries.map((e) => e.key));

    const matched = replayEntries.filter((e) => actualEntrySet.has(e.key));
    const replayOnly = replayEntries.filter((e) => !actualEntrySet.has(e.key));
    const actualOnly = actualEntries.filter((e) => !replayEntrySet.has(e.key));

    const replayByKey = new Map(replayEntries.map((e) => [e.key, e]));
    const closedByEntryKey = new Map(closedTrades.map((t) => [`${t.symbol}|${minuteKey(t.entryTsMs)}`, t]));
    const replayOnlyProfitable = replayOnly.filter((e) => (closedByEntryKey.get(e.key)?.r || 0) > 0);

    const tolerantSameSide2m = tolerantEntryMatch(replayEntries, actualEntries, { toleranceMinutes: 2, requireSameSide: true });
    const tolerantSameSide5m = tolerantEntryMatch(replayEntries, actualEntries, { toleranceMinutes: 5, requireSameSide: true });
    const tolerantAnySide5m = tolerantEntryMatch(replayEntries, actualEntries, { toleranceMinutes: 5, requireSameSide: false });

    const replayEntriesBy5mBucket = countBy(replayEntries, (e) => `${e.symbol}|${minuteBucket(e.tsMs, 5)}`);
    const duplicateReplay5m = replayEntriesBy5mBucket.filter(([, count]) => count > 1);
    const duplicateReplay5mTop = duplicateReplay5m
        .slice(0, 20)
        .map(([key, count]) => {
            const [symbol, bucket] = key.split("|");
            return { symbol, bucket, count };
        });

    const lagMinutesByTf = { m1: [], m5: [], m15: [], h1: [] };
    for (const ev of events) {
        for (const tf of Object.keys(lagMinutesByTf)) {
            const rawT = ev?.candles?.[tf]?.t;
            const candleTs = Date.parse(String(rawT || ""));
            if (!Number.isFinite(candleTs)) continue;
            lagMinutesByTf[tf].push((ev.tsMs - candleTs) / 60000);
        }
    }
    const lagStatsByTf = {};
    for (const [tf, arr] of Object.entries(lagMinutesByTf)) {
        const stats = summarizeArray(arr);
        lagStatsByTf[tf] = {
            ...stats,
            over60: arr.filter((x) => x > 60).length,
            over1440: arr.filter((x) => x > 1440).length,
            underNeg60: arr.filter((x) => x < -60).length,
        };
    }

    const closedActualTrades = actualTrades.filter((t) => Number.isFinite(t.closedAtMs));
    const actualDurationsMinutes = closedActualTrades
        .map((t) => (t.closedAtMs - t.openedAtMs) / 60000)
        .filter((v) => Number.isFinite(v) && v >= 0);
    const actualDurationStats = summarizeArray(actualDurationsMinutes);

    const trades = closedTrades.length;
    const wins = closedTrades.filter((t) => t.r > 0).length;
    const netR = closedTrades.reduce((sum, t) => sum + t.r, 0);
    const grossWinR = closedTrades.reduce((sum, t) => sum + (t.r > 0 ? t.r : 0), 0);
    const grossLossR = closedTrades.reduce((sum, t) => sum + (t.r < 0 ? Math.abs(t.r) : 0), 0);
    const pf = grossLossR > 0 ? grossWinR / grossLossR : null;
    const pnl = equity - 500;

    const blockedTop = countBy(blockedSignals, (x) => x.reason).slice(0, 10);
    const replayOnlyBySymbol = countBy(replayOnly, (x) => x.symbol);
    const actualOnlyBySymbol = countBy(actualOnly, (x) => x.symbol);
    const actualBySymbol = countBy(actualEntries, (x) => x.symbol);

    console.log("=== WINDOW ===");
    console.log(`${new Date(startTs).toISOString()} -> ${new Date(endTs).toISOString()}`);
    console.log(`Symbols in prices window: ${symbols.length} (${symbols.join(", ")})`);

    console.log("\n=== REPLAY PERFORMANCE (FROM PRICE SNAPSHOTS) ===");
    console.log(
        JSON.stringify(
            {
                trades,
                wins,
                losses: trades - wins,
                winRate: trades ? wins / trades : null,
                netR,
                profitFactor: pf,
                pnlEuro: pnl,
                endEquity: equity,
            },
            null,
            2,
        ),
    );

    console.log("\n=== ENTRY COMPARISON (REPLAY VS ACTUAL LOGS) ===");
    console.log(
        JSON.stringify(
            {
                replayEntries: replayEntries.length,
                actualEntries: actualEntries.length,
                matchedSameMinuteSameSymbol: matched.length,
                replayOnly: replayOnly.length,
                actualOnly: actualOnly.length,
                replayOnlyProfitable: replayOnlyProfitable.length,
            },
            null,
            2,
        ),
    );

    console.log("\n=== TOLERANT MATCHING (TIMING DRIFT CHECK) ===");
    console.log(JSON.stringify({ sameSide2m: tolerantSameSide2m, sameSide5m: tolerantSameSide5m, anySide5m: tolerantAnySide5m }, null, 2));

    console.log("\n=== TOP BLOCK REASONS (SIGNAL GENERATED BUT NOT EXECUTED IN REPLAY) ===");
    console.log(JSON.stringify(blockedTop.map(([reason, count]) => ({ reason, count })), null, 2));

    console.log("\n=== REPLAY-ONLY BY SYMBOL ===");
    console.log(JSON.stringify(replayOnlyBySymbol.map(([symbol, count]) => ({ symbol, count })), null, 2));

    console.log("\n=== ACTUAL-ONLY BY SYMBOL ===");
    console.log(JSON.stringify(actualOnlyBySymbol.map(([symbol, count]) => ({ symbol, count })), null, 2));

    console.log("\n=== ACTUAL ENTRIES BY SYMBOL (WINDOW) ===");
    console.log(JSON.stringify(actualBySymbol.map(([symbol, count]) => ({ symbol, count })), null, 2));

    console.log("\n=== REPLAY DENSITY CHECK (MULTI-ENTRIES PER SYMBOL PER 5M BUCKET) ===");
    console.log(
        JSON.stringify(
            {
                duplicateBucketsCount: duplicateReplay5m.length,
                duplicateBucketsTop: duplicateReplay5mTop,
            },
            null,
            2,
        ),
    );

    console.log("\n=== CANDLE TIMESTAMP LAG (SNAPSHOT_TS - CANDLE_T IN MINUTES) ===");
    console.log(JSON.stringify(lagStatsByTf, null, 2));

    console.log("\n=== ACTUAL TRADE DURATION (MINUTES) ===");
    console.log(JSON.stringify(actualDurationStats, null, 2));

    // diagnostic sample rows
    const sampleReplayOnly = replayOnly.slice(0, 15).map((e) => ({
        symbol: e.symbol,
        minute: minuteKey(e.tsMs),
        side: e.side,
        r: closedByEntryKey.get(e.key)?.r ?? null,
    }));
    const sampleActualOnly = actualOnly.slice(0, 15).map((e) => ({
        symbol: e.symbol,
        minute: minuteKey(e.tsMs),
        side: e.side,
    }));
    console.log("\n=== SAMPLE REPLAY-ONLY ENTRIES (FIRST 15) ===");
    console.log(JSON.stringify(sampleReplayOnly, null, 2));

    console.log("\n=== SAMPLE ACTUAL-ONLY ENTRIES (FIRST 15) ===");
    console.log(JSON.stringify(sampleActualOnly, null, 2));

    const totalPotentialSignals = potentialSignals.length;
    const executedSignals = replayEntries.length;
    const executionRate = totalPotentialSignals > 0 ? executedSignals / totalPotentialSignals : null;
    console.log("\n=== SIGNAL PIPELINE ===");
    console.log(
        JSON.stringify(
            {
                potentialSignalsSample: potentialSignals.slice(0, 20),
                totalPotentialSignals,
                executedSignals,
                blockedSignals: blockedSignals.length,
                blockedSignalsSample: blockedSignals.slice(0, 20),
                executionRate,
                blockedRate: totalPotentialSignals > 0 ? blockedSignals.length / totalPotentialSignals : null,
            },
            null,
            2,
        ),
    );

    console.log("\n=== QUICK TAKEAWAYS ===");
    console.log(
        JSON.stringify(
            {
                windowDays: LOOKBACK_DAYS,
                note: "Short sample; evaluate as diagnostics, not robust expectancy.",
                dailyLossGuardEnabled: MAX_DAILY_LOSS_PCT > 0,
                openRiskCapPct: MAX_OPEN_RISK_PCT,
                maxPositions: MAX_POSITIONS,
                lossStreakCooldownMinutes: LOSS_STREAK_COOLDOWN_MINUTES,
                profitableReplaySignalsMissedByActual: replayOnlyProfitable.length,
            },
            null,
            2,
        ),
    );

    // human-readable compact summary
    console.log("\n=== SUMMARY (HUMAN) ===");
    console.log(`Replay Trades: ${trades}, Winrate: ${fmtPct(trades ? wins / trades : null)}, NetR: ${fmtNum(netR, 2)}, PF: ${fmtNum(pf, 2)}, PnL: ${fmtNum(pnl)} EUR`);
    console.log(`Actual Entries: ${actualEntries.length}, Replay Entries: ${replayEntries.length}, Match: ${matched.length}, ReplayOnly: ${replayOnly.length}, ActualOnly: ${actualOnly.length}`);
    console.log(`ReplayOnly profitable: ${replayOnlyProfitable.length}`);
}

main();
