import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_INTRADAY_CONFIG } from "../../intraday/config.js";
import { evaluateGuardrails } from "../../intraday/guardrails.js";
import { step1MarketTimeWindow } from "../../intraday/step1MarketTimeWindow.js";
import { step2ContextRegime } from "../../intraday/step2ContextRegime.js";
import { step3Setup } from "../../intraday/step3Setup.js";
import { step4Trigger } from "../../intraday/step4Trigger.js";
import { step5EntryRisk } from "../../intraday/step5EntryRisk.js";
import { step6TradeManagement } from "../../intraday/step6TradeManagement.js";
import { buildMinuteSnapshotRecord, compareBacktestReports } from "../../intraday/step7ReviewBacktest.js";

test("Step 1 determines active session and allowed symbol", () => {
    const out = step1MarketTimeWindow(
        {
            nowUtc: "2026-02-25T14:05:00.000Z",
            symbol: "EURUSD",
        },
        DEFAULT_INTRADAY_CONFIG,
    );
    assert.equal(out.activeSession, "NY");
    assert.equal(out.symbolAllowed, true);
    assert.equal(out.forceFlatNow, false);
});

test("Step 2 classifies H1 trend regime", () => {
    const out = step2ContextRegime({
        h1Indicators: {
            ema20: 105,
            ema50: 103,
            ema200: 100,
            adx: { adx: 27, pdi: 30, mdi: 14 },
            atr: 1.2,
            close: 106,
        },
    });
    assert.equal(out.regimeType, "TREND");
    assert.equal(out.trendBias, "LONG");
    assert.ok(out.regimeScore > 0.5);
});

test("Step 3 detects trend pullback setup on M15", () => {
    const out = step3Setup({
        regime: { regimeType: "TREND", trendBias: "LONG", regimeScore: 0.8 },
        m15Indicators: { ema20: 100, ema50: 99.95, rsi: 48, bb: { pb: 0.45 } },
        m15Candle: { o: 100.02, h: 100.15, l: 99.98, c: 100.01 },
        prevM15Candle: { o: 99.9, h: 100.1, l: 99.95, c: 99.99 },
    });
    assert.equal(out.setupType, "TREND_PULLBACK");
    assert.equal(out.side, "LONG");
    assert.ok(out.setupScore > 0.7);
});

test("Step 4 confirms trigger with displacement and structure break", () => {
    const out = step4Trigger({
        setup: { setupType: "TREND_PULLBACK", side: "LONG" },
        m5Indicators: { atr: 1 },
        m5Candle: { o: 100, c: 101.2, h: 101.3, l: 100.1 },
        prevM5Candle: { o: 99.8, c: 100.2, h: 100.9, l: 99.7 },
        prev2M5Candle: { o: 99.5, c: 99.9, h: 100.0, l: 99.4 },
    });
    assert.equal(out.triggerOk, true);
    assert.equal(out.side, "LONG");
    assert.ok(out.triggerScore >= 0.6);
});

test("Step 5 builds order plan with mandatory SL/TP", () => {
    const out = step5EntryRisk({
        symbol: "EURUSD",
        assetClass: "forex",
        side: "LONG",
        equity: 10000,
        bid: 1.1,
        ask: 1.1002,
        spread: 0.0002,
        m5Indicators: { atr: 0.0008 },
        entryPrice: 1.1002,
    });
    assert.equal(out.valid, true);
    assert.ok(out.orderPlan.size > 0);
    assert.ok(out.orderPlan.sl < out.orderPlan.entryPrice);
    assert.ok(out.orderPlan.tp > out.orderPlan.entryPrice);
});

test("Step 6 emits breakeven move and cutoff force close", () => {
    const out = step6TradeManagement(
        {
            position: {
                side: "LONG",
                entryPrice: 100,
                initialSl: 99,
                currentSl: 99,
                takeProfit: 102,
            },
            market: { bid: 101.2, ask: 101.3, mid: 101.25 },
            m5Indicators: { atr: 0.5 },
            step1: { forceFlatNow: true },
        },
        {
            ...DEFAULT_INTRADAY_CONFIG,
            management: { ...DEFAULT_INTRADAY_CONFIG.management, breakevenAtR: 1 },
        },
    );
    assert.ok(out.actions.some((a) => a.type === "MOVE_SL"));
    assert.ok(out.actions.some((a) => a.type === "FORCE_CLOSE"));
});

test("Guardrails block crowded trend sentiment and daily trade cap", () => {
    const state = {
        dailyTradeCount: 15,
        openPositions: new Map(),
    };
    const out = evaluateGuardrails(
        {
            state,
            snapshot: { symbol: "EURUSD", newsWindowActive: false },
            step1: { symbolAllowed: true, forceFlatNow: false },
            step2: { regimeType: "TREND" },
            step3: { setupType: "TREND_PULLBACK", side: "LONG" },
            step4: { triggerOk: true, side: "LONG" },
            side: "LONG",
            sentiment: { clientLongPct: 0.8, clientShortPct: 0.2 },
        },
        DEFAULT_INTRADAY_CONFIG,
    );
    assert.equal(out.allowed, false);
    assert.ok(out.blockReasons.includes("maxTradesPerDay"));
    assert.ok(out.blockReasons.includes("sentimentCrowded"));
});

test("Step 7 builds minute snapshot record and comparator", () => {
    const decision = {
        step1: { activeSession: "LONDON", activeSessions: ["LONDON"] },
        step2: { regimeType: "TREND", regimeScore: 0.9 },
        step3: { setupType: "TREND_PULLBACK", setupScore: 0.8 },
        step4: { triggerScore: 0.7 },
        guardrails: { logFields: { guardrailsAllowed: true } },
        finalSignal: "LONG",
        reasons: ["ok"],
    };
    const rec = buildMinuteSnapshotRecord({
        strategyId: "TEST",
        snapshot: {
            symbol: "EURUSD",
            timestamp: "2026-02-25T08:00:00.000Z",
            bid: 1.1,
            ask: 1.1002,
            mid: 1.1001,
            spread: 0.0002,
            bars: { m1: { c: 1.1 }, m5: { c: 1.1 }, m15: { c: 1.1 }, h1: { c: 1.1 } },
            indicators: { m1: {}, m5: {}, m15: {}, h1: {} },
            sentiment: { clientLongPct: 0.6, clientShortPct: 0.4 },
        },
        decision,
    });
    assert.equal(rec.symbol, "EURUSD");
    assert.equal(rec.finalSignal, "LONG");
    const cmp = compareBacktestReports(
        { strategyId: "A", metrics: { netPnl: 100, profitFactor: 1.2 } },
        { strategyId: "B", metrics: { netPnl: 140, profitFactor: 1.5 } },
    );
    assert.equal(cmp.delta.netPnl, 40);
    assert.equal(cmp.delta.profitFactor, 0.3);
});

