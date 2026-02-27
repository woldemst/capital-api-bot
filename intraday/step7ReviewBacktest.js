import fs from "node:fs";
import path from "node:path";
import { DEFAULT_INTRADAY_CONFIG, assetClassOfSymbol } from "./config.js";
import { createIntradayRuntimeState, ensureStateDay, getOpenPosition, registerClosedTrade, registerOpenedTrade } from "./state.js";
import { CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID } from "../strategies/cryptoLiquidityWindowMomentum.js";

export const STEP7_NAME = "REVIEW_JOURNAL_BACKTEST";

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function roundNum(value, decimals = 8) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Number(n.toFixed(decimals));
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

export function appendJsonlRecord(filePath, record) {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
}

export function buildMinuteSnapshotRecord({ strategyId, snapshot, decision }) {
    const indicators = snapshot?.indicators || {};
    const bars = snapshot?.bars || snapshot?.candles || {};
    const sentiment = snapshot?.sentiment || {};

    return {
        strategyId: strategyId || null,
        timestamp: snapshot?.timestamp || new Date().toISOString(),
        symbol: String(snapshot?.symbol || "").toUpperCase(),
        bid: toNum(snapshot?.bid),
        ask: toNum(snapshot?.ask),
        mid: toNum(snapshot?.mid),
        spread: toNum(snapshot?.spread),
        bars: {
            m1: bars.m1 || null,
            m5: bars.m5 || null,
            m15: bars.m15 || null,
            h1: bars.h1 || null,
        },
        indicators: {
            m1: indicators.m1 || null,
            m5: indicators.m5 || null,
            m15: indicators.m15 || null,
            h1: indicators.h1 || null,
        },
        session: decision?.step1?.activeSession || null,
        sessions: decision?.step1?.activeSessions || snapshot?.sessions || [],
        newsWindowActive: Boolean(snapshot?.newsWindowActive ?? snapshot?.newsBlocked),
        clientLongPct: toNum(sentiment?.clientLongPct),
        clientShortPct: toNum(sentiment?.clientShortPct),
        regimeType: decision?.step2?.regimeType || null,
        regimeScore: toNum(decision?.step2?.regimeScore),
        setupType: decision?.step3?.setupType || "NONE",
        setupScore: toNum(decision?.step3?.setupScore),
        triggerScore: toNum(decision?.step4?.triggerScore),
        finalSignal: decision?.finalSignal || null,
        reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
        guardrails: decision?.guardrails?.logFields || null,
    };
}

export function buildTradeLogRecord(input) {
    const entry = input?.entry || {};
    const exit = input?.exit || {};
    const decision = input?.decision || {};
    const sentiment = input?.sentiment || {};
    const symbol = String(entry.symbol || exit.symbol || "").toUpperCase();
    const side = String(entry.side || exit.side || "").toUpperCase();
    const entryPrice = toNum(entry.entryPrice);
    const exitPrice = toNum(exit.exitPrice);
    const sl = toNum(entry.initialSl ?? entry.sl);
    const tp = toNum(entry.takeProfit ?? entry.tp);
    const riskAmount = toNum(entry.riskAmount);
    const riskDistance = Math.abs((entryPrice ?? NaN) - (sl ?? NaN));

    let rMultiple = null;
    if (["LONG", "SHORT"].includes(side) && [entryPrice, exitPrice, sl].every(Number.isFinite) && riskDistance > 0) {
        const pnlDistance = side === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice;
        rMultiple = pnlDistance / riskDistance;
    }

    return {
        strategyId: input?.strategyId || null,
        tradeId: input?.tradeId || null,
        symbol,
        side,
        status: "closed",
        entryTimestamp: entry.entryTimestamp || null,
        exitTimestamp: exit.exitTimestamp || null,
        entryPrice,
        exitPrice,
        sl,
        tp,
        riskAmount,
        rr: toNum(entry.rr),
        rMultiple: Number.isFinite(rMultiple) ? Number(rMultiple.toFixed(6)) : null,
        pnl: toNum(exit.pnl),
        pnlPct: toNum(exit.pnlPct),
        closeReason: exit.closeReason || "unknown",
        regime: {
            type: decision?.step2?.regimeType || null,
            score: toNum(decision?.step2?.regimeScore),
        },
        setup: {
            type: decision?.step3?.setupType || null,
            score: toNum(decision?.step3?.setupScore),
        },
        trigger: {
            score: toNum(decision?.step4?.triggerScore),
        },
        sentiment: {
            clientLongPct: toNum(sentiment?.clientLongPct),
            clientShortPct: toNum(sentiment?.clientShortPct),
        },
        spreadOnEntry: toNum(entry.spread),
        newsFlags: {
            newsWindowActive: Boolean(entry.newsWindowActive),
        },
        reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
    };
}

function formatDay(ts) {
    return new Date(ts).toISOString().slice(0, 10);
}

function slippageBps(config, assetClass, phase) {
    const slip = config?.backtest?.slippage || DEFAULT_INTRADAY_CONFIG.backtest.slippage;
    if (assetClass === "crypto") return phase === "entry" ? Number(slip.entryBpsCrypto || 0) : Number(slip.exitBpsCrypto || 0);
    return phase === "entry" ? Number(slip.entryBpsForex || 0) : Number(slip.exitBpsForex || 0);
}

function applyAdverseSlippage(price, side, assetClass, phase, config) {
    if (!Number.isFinite(price)) return price;
    const bps = slippageBps(config, assetClass, phase);
    const delta = price * (bps / 10000);
    const s = String(side || "").toUpperCase();
    if (phase === "entry") {
        if (s === "LONG") return price + delta;
        if (s === "SHORT") return price - delta;
    }
    if (phase === "exit") {
        if (s === "LONG") return price - delta;
        if (s === "SHORT") return price + delta;
    }
    return price;
}

function marketQuoteForEntry(snapshot, side) {
    const bid = toNum(snapshot?.bid);
    const ask = toNum(snapshot?.ask);
    const mid = toNum(snapshot?.mid);
    if (side === "LONG") return ask ?? mid ?? bid;
    if (side === "SHORT") return bid ?? mid ?? ask;
    return mid ?? bid ?? ask;
}

function marketQuoteForExit(snapshot, side) {
    const bid = toNum(snapshot?.bid);
    const ask = toNum(snapshot?.ask);
    const mid = toNum(snapshot?.mid);
    if (side === "LONG") return bid ?? mid ?? ask;
    if (side === "SHORT") return ask ?? mid ?? bid;
    return mid ?? bid ?? ask;
}

function normalizeSnapshotRecord(raw) {
    const symbol = String(raw?.symbol || "").toUpperCase();
    return {
        symbol,
        timestamp: raw?.timestamp,
        bid: toNum(raw?.bid),
        ask: toNum(raw?.ask),
        mid: toNum(raw?.mid),
        spread: toNum(raw?.spread),
        price: toNum(raw?.price),
        sessions: Array.isArray(raw?.sessions) ? raw.sessions : [],
        newsWindowActive: Boolean(raw?.newsWindowActive ?? raw?.newsBlocked),
        newsBlocked: Boolean(raw?.newsBlocked),
        sentiment:
            Number.isFinite(toNum(raw?.clientLongPct)) || Number.isFinite(toNum(raw?.clientShortPct))
                ? {
                      clientLongPct: toNum(raw?.clientLongPct),
                      clientShortPct: toNum(raw?.clientShortPct),
                  }
                : raw?.sentiment || null,
        indicators: raw?.indicators && typeof raw.indicators === "object" ? raw.indicators : {},
        bars: raw?.bars && typeof raw.bars === "object" ? raw.bars : raw?.candles && typeof raw.candles === "object" ? raw.candles : {},
        candles: raw?.candles && typeof raw.candles === "object" ? raw.candles : raw?.bars && typeof raw.bars === "object" ? raw.bars : {},
        equity: toNum(raw?.equity) ?? null,
    };
}

function loadSnapshotsFromPriceFiles(priceFiles) {
    const rows = [];
    for (const filePath of priceFiles) {
        if (!fs.existsSync(filePath)) continue;
        const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
            try {
                const raw = JSON.parse(line);
                const snap = normalizeSnapshotRecord(raw);
                const ts = Date.parse(snap.timestamp || "");
                if (!Number.isFinite(ts) || !snap.symbol) continue;
                rows.push({ ...snap, ts });
            } catch {
                // Ignore malformed lines.
            }
        }
    }
    rows.sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
    return rows;
}

function closeTradeFromPosition(position, snapshot, exitPrice, closeReason, exitTimestamp, decision) {
    const side = String(position.side || "").toUpperCase();
    const riskDistance = Math.abs(Number(position.entryPrice) - Number(position.initialSl));
    const units = Number(position.size) || 0;
    const pnlPerUnit = side === "LONG" ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
    const pnl = pnlPerUnit * units;
    const pnlPct = Number(position.equityAtEntry) > 0 ? pnl / Number(position.equityAtEntry) : null;
    return {
        position,
        exit: {
            symbol: position.symbol,
            side,
            exitTimestamp,
            exitPrice,
            closeReason,
            pnl,
            pnlPct,
        },
        riskDistance,
        decision,
        sentiment: snapshot.sentiment || null,
    };
}

function checkStopsAndTargets(position, snapshot, config) {
    const side = String(position.side || "").toUpperCase();
    const bars = snapshot?.bars || snapshot?.candles || {};
    const m1 = bars.m1 || {};
    const low = toNum(m1?.l);
    const high = toNum(m1?.h);
    const stop = toNum(position.currentSl);
    const tp = toNum(position.takeProfit);
    const priority = String(config?.backtest?.sameBarFillPriority || "STOP_FIRST").toUpperCase();

    if (!["LONG", "SHORT"].includes(side) || !Number.isFinite(stop) || !Number.isFinite(tp)) return null;

    let stopHit = false;
    let tpHit = false;
    if (side === "LONG") {
        if (Number.isFinite(low)) stopHit = low <= stop;
        if (Number.isFinite(high)) tpHit = high >= tp;
    } else {
        if (Number.isFinite(high)) stopHit = high >= stop;
        if (Number.isFinite(low)) tpHit = low <= tp;
    }

    if (!stopHit && !tpHit) {
        return null;
    }

    if (stopHit && tpHit) {
        if (priority === "TP_FIRST") return { closeReason: "hit_tp", rawExitPrice: tp };
        return { closeReason: "hit_sl", rawExitPrice: stop };
    }
    if (stopHit) return { closeReason: "hit_sl", rawExitPrice: stop };
    return { closeReason: "hit_tp", rawExitPrice: tp };
}

function computeTradeMetrics(trades) {
    const closed = trades.filter((t) => t && t.status === "closed");
    let grossProfit = 0;
    let grossLossAbs = 0;
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let sumR = 0;
    let rCount = 0;
    const dailyPnl = new Map();
    const dailyTrades = new Map();

    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;

    for (const trade of closed) {
        const pnlPct = toNum(trade.pnlPct);
        const pnl = toNum(trade.pnl);
        if (Number.isFinite(pnlPct)) {
            equity *= 1 + pnlPct;
            peak = Math.max(peak, equity);
            const dd = peak > 0 ? (equity - peak) / peak : 0;
            if (dd < maxDrawdown) maxDrawdown = dd;
        }
        if (Number.isFinite(pnl) && pnl > 0) {
            wins += 1;
            grossProfit += pnl;
        } else if (Number.isFinite(pnl) && pnl < 0) {
            losses += 1;
            grossLossAbs += Math.abs(pnl);
        } else {
            breakeven += 1;
        }
        const r = toNum(trade.rMultiple);
        if (Number.isFinite(r)) {
            sumR += r;
            rCount += 1;
        }
        const day = formatDay(trade.exitTimestamp || trade.entryTimestamp || trade.timestamp || Date.now());
        dailyPnl.set(day, (dailyPnl.get(day) || 0) + (pnl || 0));
        dailyTrades.set(day, (dailyTrades.get(day) || 0) + 1);
    }

    const count = closed.length;
    const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : null;
    const winrate = count > 0 ? wins / count : null;
    const avgR = rCount > 0 ? sumR / rCount : null;
    const tradesPerDayValues = [...dailyTrades.values()];
    const tradesPerDay =
        tradesPerDayValues.length > 0 ? tradesPerDayValues.reduce((a, b) => a + b, 0) / tradesPerDayValues.length : 0;

    return {
        tradeCount: count,
        wins,
        losses,
        breakeven,
        winrate,
        netPnl: grossProfit - grossLossAbs,
        grossProfit,
        grossLossAbs,
        profitFactor,
        avgR,
        maxDrawdown,
        tradesPerDay,
        dailyPnlDistribution: Object.fromEntries([...dailyPnl.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
}

export function compareBacktestReports(beforeReport, afterReport) {
    const before = beforeReport?.metrics || beforeReport || {};
    const after = afterReport?.metrics || afterReport || {};
    const keys = ["netPnl", "maxDrawdown", "profitFactor", "winrate", "avgR", "tradesPerDay", "tradeCount"];
    const delta = {};
    for (const key of keys) {
        const a = toNum(after[key]);
        const b = toNum(before[key]);
        if (Number.isFinite(a) && Number.isFinite(b)) delta[key] = roundNum(a - b, 8);
        else delta[key] = null;
    }
    return {
        beforeStrategyId: beforeReport?.strategyId || null,
        afterStrategyId: afterReport?.strategyId || null,
        delta,
        before,
        after,
    };
}

function clonePositionForState(position) {
    return JSON.parse(JSON.stringify(position));
}

function applyManagementActionsToPosition(position, actions = []) {
    let forceCloseAction = null;
    for (const action of actions) {
        if (action.type === "MOVE_SL" && Number.isFinite(toNum(action.newStopLoss))) {
            position.currentSl = toNum(action.newStopLoss);
        } else if (action.type === "FORCE_CLOSE") {
            forceCloseAction = action;
        }
    }
    return forceCloseAction;
}

export async function runReplayBacktest({
    engine = null,
    priceFiles = [],
    config = DEFAULT_INTRADAY_CONFIG,
    strategyId = DEFAULT_INTRADAY_CONFIG.strategyId,
    outputDir = path.join(process.cwd(), "backtest", "reports"),
    minuteLogOutputPath = null,
    tradeLogOutputPath = null,
    startingEquity = 10000,
} = {}) {
    let selectedEngine = engine;
    if (!selectedEngine) {
        if (String(strategyId || "").toUpperCase() === CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID) {
            const mod = await import("./cryptoLiquidityWindowMomentumEngine.js");
            let strategyConfig = config;
            if (!strategyConfig || typeof strategyConfig !== "object" || !strategyConfig.window || !strategyConfig.entry || !strategyConfig.risk) {
                try {
                    const rootCfg = await import("../config.js");
                    strategyConfig = rootCfg?.STRATEGIES?.CRYPTO_LIQUIDITY_WINDOW_MOMENTUM || config || {};
                } catch {
                    strategyConfig = config || {};
                }
            }
            selectedEngine = mod.createCryptoLiquidityWindowMomentumEngine({ config: strategyConfig });
        } else {
            const mod = await import("./engine.js");
            selectedEngine = mod.createIntradaySevenStepEngine({ ...config, strategyId });
        }
    }

    const snapshots = loadSnapshotsFromPriceFiles(priceFiles);
    const state = createIntradayRuntimeState({ strategyId });
    const tradeLogs = [];
    let equity = startingEquity;
    let tradeSeq = 0;
    const symbolReplayContext = new Map();

    for (const snapshot of snapshots) {
        ensureStateDay(state, snapshot.timestamp);
        snapshot.equity = equity;

        const prevCtx = symbolReplayContext.get(snapshot.symbol) || { barsHistory: [], indicatorsHistory: [] };
        snapshot.prevBars = prevCtx.barsHistory[0] || {};
        snapshot.prev2Bars = prevCtx.barsHistory[1] || {};
        snapshot.prevIndicators = prevCtx.indicatorsHistory[0] || {};

        const existing = getOpenPosition(state, snapshot.symbol);
        if (existing) {
            const position = existing;
            const stopTpHit = checkStopsAndTargets(position, snapshot, config);
            if (stopTpHit && position.entryTimestamp !== snapshot.timestamp) {
                const rawExit = applyAdverseSlippage(
                    stopTpHit.rawExitPrice,
                    position.side,
                    position.assetClass,
                    "exit",
                    { backtest: config.backtest || DEFAULT_INTRADAY_CONFIG.backtest },
                );
                const closed = closeTradeFromPosition(position, snapshot, rawExit, stopTpHit.closeReason, snapshot.timestamp, position.entryDecision);
                const tradeRecord = buildTradeLogRecord({
                    strategyId,
                    tradeId: position.tradeId,
                    entry: position,
                    exit: closed.exit,
                    decision: position.entryDecision,
                    sentiment: snapshot.sentiment,
                });
                tradeLogs.push(tradeRecord);
                equity += toNum(tradeRecord.pnl) || 0;
                registerClosedTrade(state, {
                    symbol: position.symbol,
                    pnl: toNum(tradeRecord.pnl),
                    tradeId: position.tradeId,
                    timestamp: snapshot.timestamp,
                });
                if (typeof selectedEngine?.onTradeClosed === "function") {
                    selectedEngine.onTradeClosed({
                        tradeRecord,
                        position,
                        snapshot,
                        exitTimestamp: snapshot.timestamp,
                        state,
                    });
                }
            }
        }

        const decision = selectedEngine.evaluateSnapshot({ snapshot, state });

        if (minuteLogOutputPath) {
            appendJsonlRecord(minuteLogOutputPath, decision.minuteSnapshotRecord);
        }

        const existingAfterDecision = getOpenPosition(state, snapshot.symbol);
        if (existingAfterDecision) {
            const forceClose = applyManagementActionsToPosition(existingAfterDecision, decision.step6?.actions || []);
            if (forceClose) {
                const rawExitPrice = toNum(forceClose.expectedExitPrice) ?? marketQuoteForExit(snapshot, existingAfterDecision.side);
                const exitPrice = applyAdverseSlippage(
                    rawExitPrice,
                    existingAfterDecision.side,
                    existingAfterDecision.assetClass,
                    "exit",
                    { backtest: config.backtest || DEFAULT_INTRADAY_CONFIG.backtest },
                );
                const closed = closeTradeFromPosition(
                    existingAfterDecision,
                    snapshot,
                    exitPrice,
                    forceClose.reason || "force_close",
                    snapshot.timestamp,
                    existingAfterDecision.entryDecision,
                );
                const tradeRecord = buildTradeLogRecord({
                    strategyId,
                    tradeId: existingAfterDecision.tradeId,
                    entry: existingAfterDecision,
                    exit: closed.exit,
                    decision: existingAfterDecision.entryDecision,
                    sentiment: snapshot.sentiment,
                });
                tradeLogs.push(tradeRecord);
                equity += toNum(tradeRecord.pnl) || 0;
                registerClosedTrade(state, {
                    symbol: existingAfterDecision.symbol,
                    pnl: toNum(tradeRecord.pnl),
                    tradeId: existingAfterDecision.tradeId,
                    timestamp: snapshot.timestamp,
                });
                if (typeof selectedEngine?.onTradeClosed === "function") {
                    selectedEngine.onTradeClosed({
                        tradeRecord,
                        position: existingAfterDecision,
                        snapshot,
                        exitTimestamp: snapshot.timestamp,
                        state,
                    });
                }
            }
        }

        if (decision?.step5?.valid && decision?.step5?.orderPlan && !getOpenPosition(state, snapshot.symbol)) {
            const plan = decision.step5.orderPlan;
            const quoteEntry = toNum(plan.entryPrice) ?? marketQuoteForEntry(snapshot, plan.side);
            const entryPrice = applyAdverseSlippage(
                quoteEntry,
                plan.side,
                assetClassOfSymbol(snapshot.symbol),
                "entry",
                { backtest: config.backtest || DEFAULT_INTRADAY_CONFIG.backtest },
            );
            if (Number.isFinite(entryPrice)) {
                tradeSeq += 1;
                const position = {
                    tradeId: `${strategyId}-${tradeSeq}`,
                    symbol: snapshot.symbol,
                    assetClass: assetClassOfSymbol(snapshot.symbol),
                    side: plan.side,
                    size: toNum(plan.size),
                    entryPrice,
                    initialSl: toNum(plan.sl),
                    currentSl: toNum(plan.sl),
                    takeProfit: toNum(plan.tp),
                    riskAmount: toNum(plan.riskAmount),
                    rr: toNum(plan.rr),
                    spread: toNum(snapshot.spread),
                    newsWindowActive: Boolean(snapshot.newsWindowActive),
                    entryTimestamp: snapshot.timestamp,
                    equityAtEntry: equity,
                    entryDecision: decision,
                };
                registerOpenedTrade(state, clonePositionForState(position));
                if (typeof selectedEngine?.onTradeOpened === "function") {
                    selectedEngine.onTradeOpened({ position, snapshot, state });
                }
            }
        }

        const nextBarsHistory = [snapshot.bars || {}, ...(prevCtx.barsHistory || [])].slice(0, 2);
        const nextIndicatorsHistory = [snapshot.indicators || {}, ...(prevCtx.indicatorsHistory || [])].slice(0, 2);
        symbolReplayContext.set(snapshot.symbol, {
            barsHistory: nextBarsHistory,
            indicatorsHistory: nextIndicatorsHistory,
        });
    }

    for (const [symbol, position] of state.openPositions.entries()) {
        const lastSnapshot = [...snapshots].reverse().find((s) => s.symbol === symbol);
        if (!lastSnapshot) continue;
        const rawExitPrice = marketQuoteForExit(lastSnapshot, position.side);
        if (!Number.isFinite(rawExitPrice)) continue;
        const exitPrice = applyAdverseSlippage(
            rawExitPrice,
            position.side,
            position.assetClass,
            "exit",
            { backtest: config.backtest || DEFAULT_INTRADAY_CONFIG.backtest },
        );
        const closed = closeTradeFromPosition(position, lastSnapshot, exitPrice, "end_of_replay", lastSnapshot.timestamp, position.entryDecision);
        const tradeRecord = buildTradeLogRecord({
            strategyId,
            tradeId: position.tradeId,
            entry: position,
            exit: closed.exit,
            decision: position.entryDecision,
            sentiment: lastSnapshot.sentiment,
        });
        tradeLogs.push(tradeRecord);
        equity += toNum(tradeRecord.pnl) || 0;
        registerClosedTrade(state, {
            symbol: position.symbol,
            pnl: toNum(tradeRecord.pnl),
            tradeId: position.tradeId,
            timestamp: lastSnapshot.timestamp,
        });
        if (typeof selectedEngine?.onTradeClosed === "function") {
            selectedEngine.onTradeClosed({
                tradeRecord,
                position,
                snapshot: lastSnapshot,
                exitTimestamp: lastSnapshot.timestamp,
                state,
            });
        }
    }
    state.openPositions.clear();

    if (tradeLogOutputPath) {
        for (const trade of tradeLogs) appendJsonlRecord(tradeLogOutputPath, trade);
    }

    const metrics = computeTradeMetrics(tradeLogs);
    const bySymbol = {};
    for (const trade of tradeLogs) {
        if (!bySymbol[trade.symbol]) bySymbol[trade.symbol] = [];
        bySymbol[trade.symbol].push(trade);
    }
    const bySymbolMetrics = Object.fromEntries(
        Object.entries(bySymbol).map(([symbol, trades]) => [symbol, computeTradeMetrics(trades)]),
    );

    const report = {
        generatedAt: new Date().toISOString(),
        strategyId,
        replay: {
            sourceFiles: priceFiles,
            snapshotCount: snapshots.length,
            startingEquity,
            endingEquity: equity,
            assumptions: {
                fillModel: "Minute snapshot replay with M1 candle SL/TP checks when available.",
                slippageModel: config.backtest?.slippage || DEFAULT_INTRADAY_CONFIG.backtest.slippage,
            },
        },
        metrics,
        bySymbol: bySymbolMetrics,
    };

    ensureDir(outputDir);
    const reportPath = path.join(outputDir, `backtest-${String(strategyId || "strategy").replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    return {
        report,
        reportPath,
        tradeLogs,
        snapshotsProcessed: snapshots.length,
    };
}
