import { DEFAULT_INTRADAY_CONFIG } from "./config.js";

export const STEP6_NAME = "TRADE_MANAGEMENT";

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function calcMarketPriceForExit(side, market) {
    const bid = toNum(market?.bid);
    const ask = toNum(market?.ask);
    const mid = toNum(market?.mid);
    if (side === "LONG") return bid ?? mid ?? ask;
    if (side === "SHORT") return ask ?? mid ?? bid;
    return mid ?? bid ?? ask;
}

export function step6TradeManagement(input, config = DEFAULT_INTRADAY_CONFIG) {
    const position = input?.position || {};
    const side = String(position.side || "").toUpperCase();
    const entryPrice = toNum(position.entryPrice);
    const initialSl = toNum(position.initialSl ?? position.stopLoss ?? position.sl);
    const currentSl = toNum(position.currentSl ?? position.stopLoss ?? position.sl);
    const takeProfit = toNum(position.takeProfit ?? position.tp);
    const market = input?.market || {};
    const m5Indicators = input?.m5Indicators || input?.m5 || {};
    const atr = toNum(m5Indicators.atr);
    const step1 = input?.step1 || {};
    const params = config.management || {};

    const actions = [];
    const managementReasons = [];

    if (!["LONG", "SHORT"].includes(side) || ![entryPrice, initialSl].every(Number.isFinite)) {
        return {
            step: 6,
            stepName: STEP6_NAME,
            actions,
            managementReasons: ["invalid_position"],
            logFields: { managementActionCount: 0 },
        };
    }

    const riskDistance = Math.abs(entryPrice - initialSl);
    const liveExitPrice = calcMarketPriceForExit(side, market);
    const favorableMove =
        side === "LONG"
            ? Number.isFinite(liveExitPrice) ? liveExitPrice - entryPrice : null
            : Number.isFinite(liveExitPrice) ? entryPrice - liveExitPrice : null;
    const rNow = Number.isFinite(favorableMove) && riskDistance > 0 ? favorableMove / riskDistance : null;

    const breakevenAtR = Number(params.breakevenAtR || 1);
    const beAlready = Number.isFinite(currentSl) && Math.abs(currentSl - entryPrice) <= riskDistance * 0.02;
    if (Number.isFinite(rNow) && rNow >= breakevenAtR && !beAlready) {
        actions.push({
            type: "MOVE_SL",
            newStopLoss: entryPrice,
            reason: "breakeven_reached",
        });
        managementReasons.push(`r>=${breakevenAtR}`);
    }

    const canTrail = Number.isFinite(rNow) && rNow >= breakevenAtR && Number.isFinite(atr) && atr > 0;
    if (canTrail && params.trailMode === "ATR_M5") {
        const trailMult = Number(params.trailAtrMultiplier || 1);
        const referencePrice = calcMarketPriceForExit(side, market);
        let trailStop = null;
        if (side === "LONG" && Number.isFinite(referencePrice)) {
            trailStop = referencePrice - atr * trailMult;
            if (Number.isFinite(currentSl) && trailStop <= currentSl) trailStop = null;
        } else if (side === "SHORT" && Number.isFinite(referencePrice)) {
            trailStop = referencePrice + atr * trailMult;
            if (Number.isFinite(currentSl) && trailStop >= currentSl) trailStop = null;
        }

        if (Number.isFinite(trailStop)) {
            actions.push({
                type: "MOVE_SL",
                newStopLoss: trailStop,
                reason: "atr_trail",
            });
            managementReasons.push("atr_trail");
        }
    }

    if (step1.forceFlatNow) {
        actions.push({
            type: "FORCE_CLOSE",
            reason: "intraday_cutoff",
            expectedExitPrice: calcMarketPriceForExit(side, market),
        });
        managementReasons.push("force_flat_cutoff");
    }

    return {
        step: 6,
        stepName: STEP6_NAME,
        rNow: Number.isFinite(rNow) ? Number(rNow.toFixed(4)) : null,
        actions,
        managementReasons,
        logFields: {
            managementActionCount: actions.length,
            rNow: Number.isFinite(rNow) ? Number(rNow.toFixed(4)) : null,
            takeProfit: Number.isFinite(takeProfit) ? takeProfit : null,
        },
    };
}

