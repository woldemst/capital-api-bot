import {
    CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
    buildBacktestDecisionLogRecord,
    evaluateCryptoLiquidityWindowMomentum,
    getDateKeyInTimeZone,
    normalizeBar,
} from "../strategies/cryptoLiquidityWindowMomentum.js";

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function floorToBucketTs(tsInput, bucketMinutes) {
    const tsMs = Date.parse(String(tsInput || ""));
    if (!Number.isFinite(tsMs)) return null;
    const bucketMs = Math.max(1, Number(bucketMinutes || 1)) * 60 * 1000;
    return Math.floor(tsMs / bucketMs) * bucketMs;
}

function normalizedSnapshotBar(rawBar, snapshotTimestamp, timeframeMinutes) {
    const fallbackTsMs = floorToBucketTs(snapshotTimestamp, timeframeMinutes);
    return normalizeBar(rawBar, { fallbackTsMs });
}

function barKey(bar, fallbackPrefix = "bar") {
    if (!bar) return null;
    return bar.t || (Number.isFinite(bar.tsMs) ? `ts:${bar.tsMs}` : `${fallbackPrefix}:${[bar.o, bar.h, bar.l, bar.c].join("|")}`);
}

function pushUniqueBar(history, bar, key, maxLen = 400) {
    if (!bar || !key) return false;
    const last = history.length ? history[history.length - 1] : null;
    const lastKey = last ? barKey(last, "bar") : null;
    if (lastKey === key) {
        history[history.length - 1] = bar;
        return false;
    }
    history.push(bar);
    if (history.length > maxLen) history.splice(0, history.length - maxLen);
    return true;
}

function createStep5FromEvaluation(evaluation) {
    if (evaluation?.action !== "OPEN" || !evaluation?.orderPlan) {
        return {
            step: 5,
            stepName: "ENTRY_RISK",
            valid: false,
            orderPlan: null,
            planReasons: [evaluation?.reasonCode || "no_entry"],
            logFields: { step5Valid: false },
        };
    }

    const plan = evaluation.orderPlan;
    return {
        step: 5,
        stepName: "ENTRY_RISK",
        valid: true,
        orderPlan: {
            side: String(plan.side || "").toUpperCase(),
            size: toNum(plan.size),
            entryPrice: toNum(plan.entryPrice ?? plan.requestedPrice),
            sl: toNum(plan.sl),
            tp: toNum(plan.tp),
            riskAmount: toNum(plan.riskAmount),
            rr: toNum(plan.rr),
        },
        planReasons: [evaluation?.reasonCode || "entry_signal"],
        logFields: { step5Valid: true },
    };
}

function createStep6FromEvaluation(evaluation) {
    if (evaluation?.action === "EXIT") {
        return {
            step: 6,
            stepName: "TRADE_MANAGEMENT",
            actions: [
                {
                    type: "FORCE_CLOSE",
                    reason: evaluation.exitReason || evaluation.reasonCode || "manage_exit",
                    expectedExitPrice: toNum(evaluation?.metrics?.currentMark),
                },
            ],
            managementReasons: [evaluation.exitReason || "manage_exit"],
            logFields: { managementActionCount: 1 },
        };
    }

    if (evaluation?.action === "MANAGE" && evaluation?.manageAction?.type === "MOVE_SL") {
        return {
            step: 6,
            stepName: "TRADE_MANAGEMENT",
            actions: [
                {
                    type: "MOVE_SL",
                    newStopLoss: toNum(evaluation.manageAction.newStopLoss),
                    reason: evaluation.manageAction.reason || "manage",
                },
            ],
            managementReasons: [evaluation.manageAction.reason || "manage"],
            logFields: { managementActionCount: 1 },
        };
    }

    return {
        step: 6,
        stepName: "TRADE_MANAGEMENT",
        actions: [],
        managementReasons: [evaluation?.reasonCode || "no_management_action"],
        logFields: { managementActionCount: 0 },
    };
}

export function createCryptoLiquidityWindowMomentumEngine({ config }) {
    const strategyConfig = config || {};
    const tz = strategyConfig?.timezone || "Europe/Berlin";

    const perSymbolState = new Map();
    const runtime = {
        berlinDayKey: null,
        startOfDayEquity: null,
        realizedPnlToday: 0,
        tradesTodayTotal: 0,
        tradesTodayBySymbol: new Map(),
        lastExitAtBySymbol: new Map(),
        processedOpenedTradeIds: new Set(),
        processedClosedTradeIds: new Set(),
    };

    function ensureBerlinDay(timestamp, equity = null) {
        const dayKey = getDateKeyInTimeZone(timestamp, tz);
        if (!dayKey) return;
        if (runtime.berlinDayKey === dayKey) return;
        runtime.berlinDayKey = dayKey;
        runtime.startOfDayEquity = Number.isFinite(toNum(equity)) ? toNum(equity) : runtime.startOfDayEquity;
        runtime.realizedPnlToday = 0;
        runtime.tradesTodayTotal = 0;
        runtime.tradesTodayBySymbol = new Map();
        runtime.lastExitAtBySymbol = new Map();
        runtime.processedOpenedTradeIds = new Set();
        runtime.processedClosedTradeIds = new Set();
    }

    function getSymbolReplayState(symbol) {
        const key = String(symbol || "").toUpperCase();
        if (!perSymbolState.has(key)) {
            perSymbolState.set(key, {
                m5Bars: [],
                h1Bars: [],
                lastEvaluatedM5BarKey: null,
            });
        }
        return perSymbolState.get(key);
    }

    function syncBarsFromSnapshot(snapshot) {
        const symbolState = getSymbolReplayState(snapshot.symbol);
        const m5Raw = snapshot?.bars?.m5 || snapshot?.candles?.m5 || null;
        const h1Raw = snapshot?.bars?.h1 || snapshot?.candles?.h1 || null;

        const m5Bar = normalizedSnapshotBar(m5Raw, snapshot.timestamp, 5);
        const h1Bar = normalizedSnapshotBar(h1Raw, snapshot.timestamp, 60);
        const m5Key = barKey(m5Bar, "m5");
        const h1Key = barKey(h1Bar, "h1");
        if (m5Bar && m5Key) pushUniqueBar(symbolState.m5Bars, m5Bar, m5Key, 500);
        if (h1Bar && h1Key) pushUniqueBar(symbolState.h1Bars, h1Bar, h1Key, 200);
        return { symbolState, currentM5Key: m5Key };
    }

    function onTradeOpened({ position }) {
        const tradeId = String(position?.tradeId || "");
        if (!tradeId || runtime.processedOpenedTradeIds.has(tradeId)) return;
        runtime.processedOpenedTradeIds.add(tradeId);

        const symbol = String(position?.symbol || "").toUpperCase();
        runtime.tradesTodayTotal += 1;
        runtime.tradesTodayBySymbol.set(symbol, (runtime.tradesTodayBySymbol.get(symbol) || 0) + 1);
    }

    function onTradeClosed({ tradeRecord, position, exitTimestamp }) {
        const tradeId = String(tradeRecord?.tradeId || position?.tradeId || "");
        if (tradeId && runtime.processedClosedTradeIds.has(tradeId)) return;
        if (tradeId) runtime.processedClosedTradeIds.add(tradeId);

        const pnl = toNum(tradeRecord?.pnl);
        if (Number.isFinite(pnl)) runtime.realizedPnlToday += pnl;

        const symbol = String(tradeRecord?.symbol || position?.symbol || "").toUpperCase();
        const ts = exitTimestamp || tradeRecord?.exitTimestamp || null;
        const exitTsMs = Date.parse(String(ts || ""));
        if (symbol && Number.isFinite(exitTsMs)) {
            runtime.lastExitAtBySymbol.set(symbol, exitTsMs);
        }
    }

    function evaluateSnapshot({ snapshot, state }) {
        ensureBerlinDay(snapshot.timestamp, snapshot.equity);
        const symbol = String(snapshot.symbol || "").toUpperCase();
        const { symbolState, currentM5Key } = syncBarsFromSnapshot(snapshot);
        const openPosition = state?.openPositions?.get?.(symbol) || null;

        const evaluation = evaluateCryptoLiquidityWindowMomentum({
            symbol,
            timestamp: snapshot.timestamp,
            bid: snapshot.bid,
            ask: snapshot.ask,
            mid: snapshot.mid,
            candles5m: symbolState.m5Bars,
            candles1h: symbolState.h1Bars,
            config: strategyConfig,
            equity: snapshot.equity,
            openPosition,
            counters: {
                tradesTodaySymbol: runtime.tradesTodayBySymbol.get(symbol) || 0,
                tradesTodayTotal: runtime.tradesTodayTotal,
                lastExitAtMs: runtime.lastExitAtBySymbol.get(symbol) || null,
                startOfDayEquity: runtime.startOfDayEquity,
                realizedPnlToday: runtime.realizedPnlToday,
            },
            entryContext: {
                requireNewClosedBar: true,
                isNewClosedBar: Boolean(currentM5Key) && currentM5Key !== symbolState.lastEvaluatedM5BarKey,
                externalEntryAllowed: !openPosition,
                externalBlockReason: openPosition ? "symbol_already_in_position" : null,
            },
        });

        if (currentM5Key) {
            symbolState.lastEvaluatedM5BarKey = currentM5Key;
        }

        const step5 = createStep5FromEvaluation(evaluation);
        const step6 = createStep6FromEvaluation(evaluation);
        const finalSignal = step5.valid ? step5.orderPlan?.side || null : null;
        const reasons = [evaluation?.reasonCode || "none"].filter(Boolean);

        const decision = {
            strategyId: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
            symbol,
            timestamp: snapshot.timestamp,
            step1: {
                step: 1,
                stepName: "LIQUIDITY_WINDOW",
                activeSession: "CRYPTO",
                activeSessions: Array.isArray(snapshot?.sessions) ? snapshot.sessions : ["CRYPTO"],
                symbolAllowed: true,
                forceFlatNow: false,
                windowGatePassed: Boolean(evaluation?.decisionLog?.windowGatePassed),
                withinWindow: Boolean(evaluation?.decisionLog?.withinWindow),
                step1Reasons: [],
            },
            step2: { step: 2, stepName: "CONTEXT", regimeType: "MOMENTUM", regimeScore: null, contextReasons: [] },
            step3: { step: 3, stepName: "SETUP", setupType: "LIQUIDITY_WINDOW_MOMENTUM", setupScore: null, setupReasons: [] },
            step4: {
                step: 4,
                stepName: "TRIGGER",
                triggerOk: Boolean(finalSignal),
                side: finalSignal || null,
                triggerScore: null,
                triggerReasons: [],
            },
            guardrails: {
                allowed: evaluation?.action === "OPEN" || evaluation?.action === "NO_TRADE" || evaluation?.action === "MANAGE" || evaluation?.action === "EXIT",
                blockReasons: evaluation?.action === "OPEN" ? [] : [evaluation?.reasonCode || "no_trade"],
                logFields: {
                    ...evaluation?.decisionLog?.gates,
                    reasonCode: evaluation?.reasonCode || null,
                },
            },
            step5,
            step6,
            finalSignal,
            reasons,
            evaluation,
        };

        decision.minuteSnapshotRecord = buildBacktestDecisionLogRecord({
            evaluation,
            snapshot,
            symbol,
            timestamp: snapshot.timestamp,
        });

        return decision;
    }

    return {
        strategyId: CRYPTO_LIQUIDITY_WINDOW_MOMENTUM_ID,
        config: strategyConfig,
        evaluateSnapshot,
        onTradeOpened,
        onTradeClosed,
    };
}

