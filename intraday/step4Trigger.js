import { DEFAULT_INTRADAY_CONFIG } from "./config.js";

export const STEP4_NAME = "TRIGGER_M5";

function toNum(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function bodySize(candle) {
    const o = toNum(candle?.o);
    const c = toNum(candle?.c);
    if (![o, c].every(Number.isFinite)) return null;
    return Math.abs(c - o);
}

export function detectFairValueGap(side, prev2, current) {
    const prev2High = toNum(prev2?.h);
    const prev2Low = toNum(prev2?.l);
    const currLow = toNum(current?.l);
    const currHigh = toNum(current?.h);
    if (side === "LONG") {
        if ([prev2High, currLow].every(Number.isFinite) && currLow > prev2High) {
            return { exists: true, gapStart: prev2High, gapEnd: currLow };
        }
        return { exists: false };
    }
    if (side === "SHORT") {
        if ([prev2Low, currHigh].every(Number.isFinite) && currHigh < prev2Low) {
            return { exists: true, gapStart: currHigh, gapEnd: prev2Low };
        }
        return { exists: false };
    }
    return { exists: false };
}

export function step4Trigger(input, config = DEFAULT_INTRADAY_CONFIG) {
    const setup = input?.setup || {};
    const side = setup.side || input?.side || null;
    const candle = input?.m5Candle || input?.candle || {};
    const prev = input?.prevM5Candle || input?.prevCandle || {};
    const prev2 = input?.prev2M5Candle || input?.prev2Candle || {};
    const indicators = input?.m5Indicators || input?.m5 || {};
    const params = config.trigger || {};

    if (!side || setup.setupType === "NONE") {
        return {
            step: 4,
            stepName: STEP4_NAME,
            triggerOk: false,
            triggerScore: 0,
            triggerReasons: ["no_setup"],
            fvg: { exists: false },
            logFields: { triggerOk: false, triggerScore: 0 },
        };
    }

    const atr = toNum(indicators.atr);
    const currentBody = bodySize(candle);
    const displacementThreshold = Number.isFinite(atr) ? atr * Number(params.displacementAtrMultiplier || 0.9) : null;
    const displacementOk =
        !params.requireDisplacement || (Number.isFinite(currentBody) && Number.isFinite(displacementThreshold) && currentBody >= displacementThreshold);

    const close = toNum(candle?.c);
    const prevHigh = toNum(prev?.h);
    const prevLow = toNum(prev?.l);
    const structureBreakOk =
        side === "LONG"
            ? [close, prevHigh].every(Number.isFinite) && close > prevHigh
            : [close, prevLow].every(Number.isFinite) && close < prevLow;
    const fvg = detectFairValueGap(side, prev2, candle);

    const triggerReasons = [];
    if (displacementOk) triggerReasons.push("displacement_candle");
    if (structureBreakOk) triggerReasons.push("minor_structure_break");
    if (fvg.exists) triggerReasons.push("fvg_detected");

    const structureRequired = Boolean(params.requireStructureBreak);
    const fvgRequired = Boolean(params.requireFvg);
    if (structureRequired && !structureBreakOk) triggerReasons.push("structure_break_required_not_found");
    if (fvgRequired && !fvg.exists) triggerReasons.push("fvg_required_not_found");
    const triggerOk = Boolean(displacementOk && (!structureRequired || structureBreakOk) && (!fvgRequired || fvg.exists));

    let triggerScore = 0;
    if (triggerOk) {
        triggerScore = 0.6;
        if (fvg.exists && params.useFvgBonus) triggerScore += 0.15;
        if (structureBreakOk) triggerScore += 0.15;
        if (displacementOk) triggerScore += 0.1;
    }
    triggerScore = Number(Math.min(1, Math.max(0, triggerScore)).toFixed(4));

    return {
        step: 4,
        stepName: STEP4_NAME,
        triggerOk,
        triggerScore,
        triggerReasons,
        side,
        confirmationPrice: close,
        fvg,
        logFields: {
            triggerOk,
            triggerScore,
            displacementOk,
            structureBreakOk,
            fvgDetected: fvg.exists,
            structureRequired,
            fvgRequired,
            m5Atr: atr,
            m5Body: currentBody,
        },
    };
}
