import { DEFAULT_INTRADAY_CONFIG } from "./config.js";
import { evaluateGuardrails } from "./guardrails.js";
import { ensureStateDay, getOpenPosition } from "./state.js";
import { step1MarketTimeWindow } from "./step1MarketTimeWindow.js";
import { step2ContextRegime } from "./step2ContextRegime.js";
import { step3Setup } from "./step3Setup.js";
import { step4Trigger } from "./step4Trigger.js";
import { step5EntryRisk } from "./step5EntryRisk.js";
import { step6TradeManagement } from "./step6TradeManagement.js";
import { buildMinuteSnapshotRecord } from "./step7ReviewBacktest.js";

export function createIntradaySevenStepEngine(userConfig = {}) {
    const config = {
        ...DEFAULT_INTRADAY_CONFIG,
        ...userConfig,
        guardrails: { ...DEFAULT_INTRADAY_CONFIG.guardrails, ...(userConfig.guardrails || {}) },
        intradayOnly: { ...DEFAULT_INTRADAY_CONFIG.intradayOnly, ...(userConfig.intradayOnly || {}) },
        context: { ...DEFAULT_INTRADAY_CONFIG.context, ...(userConfig.context || {}) },
        setup: { ...DEFAULT_INTRADAY_CONFIG.setup, ...(userConfig.setup || {}) },
        trigger: { ...DEFAULT_INTRADAY_CONFIG.trigger, ...(userConfig.trigger || {}) },
        risk: { ...DEFAULT_INTRADAY_CONFIG.risk, ...(userConfig.risk || {}) },
        management: { ...DEFAULT_INTRADAY_CONFIG.management, ...(userConfig.management || {}) },
        backtest: { ...DEFAULT_INTRADAY_CONFIG.backtest, ...(userConfig.backtest || {}) },
    };

    function evaluateSnapshot({ snapshot, state }) {
        ensureStateDay(state, snapshot.timestamp || Date.now());

        const symbol = String(snapshot.symbol || "").toUpperCase();
        const step1 = step1MarketTimeWindow(
            {
                nowUtc: snapshot.timestamp,
                symbol,
            },
            config,
        );

        const step2 = step2ContextRegime(
            {
                h1Indicators: snapshot?.indicators?.h1 || {},
            },
            config,
        );

        const step3 = step3Setup(
            {
                regime: step2,
                m15Indicators: snapshot?.indicators?.m15 || {},
                m15Candle: snapshot?.bars?.m15 || snapshot?.candles?.m15 || {},
                prevM15Candle: snapshot?.prevBars?.m15 || {},
            },
            config,
        );

        const step4 = step4Trigger(
            {
                setup: step3,
                m5Indicators: snapshot?.indicators?.m5 || {},
                m5Candle: snapshot?.bars?.m5 || snapshot?.candles?.m5 || {},
                prevM5Candle: snapshot?.prevBars?.m5 || {},
                prev2M5Candle: snapshot?.prev2Bars?.m5 || {},
            },
            config,
        );

        const side = step4.side || step3.side || null;
        const sentiment = snapshot?.sentiment || state?.sentimentBySymbol?.get?.(symbol) || null;
        const guardrails = evaluateGuardrails(
            {
                state,
                snapshot,
                symbol,
                step1,
                step2,
                step3,
                step4,
                side,
                sentiment,
            },
            config,
        );

        let step5 = {
            step: 5,
            stepName: "ENTRY_RISK",
            valid: false,
            orderPlan: null,
            planReasons: ["guardrails_or_trigger_not_ready"],
            logFields: { step5Valid: false },
        };

        if (side && step4.triggerOk && guardrails.allowed) {
            step5 = step5EntryRisk(
                {
                    symbol,
                    assetClass: step1.assetClass,
                    side,
                    equity: snapshot.equity,
                    bid: snapshot.bid,
                    ask: snapshot.ask,
                    mid: snapshot.mid,
                    spread: snapshot.spread,
                    m5Indicators: snapshot?.indicators?.m5 || {},
                    entryPrice: step4.confirmationPrice,
                },
                config,
            );
        }

        const openPosition = getOpenPosition(state, symbol);
        const step6 = openPosition
            ? step6TradeManagement(
                  {
                      position: openPosition,
                      market: snapshot,
                      m5Indicators: snapshot?.indicators?.m5 || {},
                      step1,
                  },
                  config,
              )
            : {
                  step: 6,
                  stepName: "TRADE_MANAGEMENT",
                  actions: [],
                  managementReasons: ["no_open_position"],
                  logFields: { managementActionCount: 0 },
              };

        const finalSignal = step5.valid && step5.orderPlan ? step5.orderPlan.side : null;
        const reasons = [
            ...step1.step1Reasons,
            ...step2.contextReasons,
            ...step3.setupReasons,
            ...step4.triggerReasons,
            ...(guardrails.blockReasons || []),
            ...(step5.planReasons || []),
        ];

        const decision = {
            strategyId: config.strategyId,
            symbol,
            timestamp: snapshot.timestamp,
            step1,
            step2,
            step3,
            step4,
            guardrails,
            step5,
            step6,
            finalSignal,
            reasons: [...new Set(reasons)].filter(Boolean),
        };

        decision.minuteSnapshotRecord = buildMinuteSnapshotRecord({
            strategyId: config.strategyId,
            snapshot,
            decision,
        });

        return decision;
    }

    return {
        config,
        evaluateSnapshot,
    };
}

