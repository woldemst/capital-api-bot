import { DEFAULT_INTRADAY_CONFIG } from "./config.js";

export const STEP2_NAME = "CONTEXT_REGIME";

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function adxValue(indicators) {
    if (!indicators) return null;
    if (typeof indicators.adx === "object") return toNum(indicators.adx.adx);
    return toNum(indicators.adx);
}

function ema(indicators, key) {
    return toNum(indicators?.[key]);
}

function resolveEmaSet(h1, params = {}) {
    const candidates = [
        {
            name: "configured",
            fast: params.h1EmaFast || "ema20",
            mid: params.h1EmaMid || "ema50",
            slow: params.h1EmaSlow || "ema200",
            requireSlow: true,
        },
        { name: "ema9_20_50", fast: "ema9", mid: "ema20", slow: "ema50", requireSlow: true },
        { name: "ema20_50", fast: "ema20", mid: "ema50", slow: null, requireSlow: false },
        { name: "emaFast_emaSlow", fast: "emaFast", mid: "emaSlow", slow: null, requireSlow: false },
    ];

    for (const c of candidates) {
        const fast = ema(h1, c.fast);
        const mid = ema(h1, c.mid);
        const slow = c.slow ? ema(h1, c.slow) : null;
        if (!Number.isFinite(fast) || !Number.isFinite(mid)) continue;
        if (c.requireSlow && !Number.isFinite(slow)) continue;
        return { ...c, values: { fast, mid, slow } };
    }
    return null;
}

export function step2ContextRegime(input, config = DEFAULT_INTRADAY_CONFIG) {
    const h1 = input?.h1Indicators || input?.h1 || {};
    const params = config.context || {};

    const emaSet = resolveEmaSet(h1, params);
    const emaFast = emaSet?.values?.fast ?? null;
    const emaMid = emaSet?.values?.mid ?? null;
    const emaSlow = emaSet?.values?.slow ?? null;
    const adx = adxValue(h1);
    const atr = toNum(h1?.atr);
    const price = toNum(h1?.close ?? h1?.lastClose);
    const atrPct = toNum(h1?.atrPct) ?? (Number.isFinite(atr) && Number.isFinite(price) && price !== 0 ? atr / price : null);

    const bullAligned =
        emaSet?.requireSlow !== false
            ? [emaFast, emaMid, emaSlow].every(Number.isFinite) && emaFast > emaMid && emaMid > emaSlow
            : [emaFast, emaMid].every(Number.isFinite) && emaFast > emaMid;
    const bearAligned =
        emaSet?.requireSlow !== false
            ? [emaFast, emaMid, emaSlow].every(Number.isFinite) && emaFast < emaMid && emaMid < emaSlow
            : [emaFast, emaMid].every(Number.isFinite) && emaFast < emaMid;
    const aligned = bullAligned || bearAligned;

    let regimeType = "UNKNOWN";
    let trendBias = "NEUTRAL";
    const contextReasons = [];

    if (aligned && Number.isFinite(adx) && adx >= Number(params.adxTrendMin || 20)) {
        regimeType = "TREND";
        trendBias = bullAligned ? "LONG" : "SHORT";
        contextReasons.push(`ema_alignment_${trendBias.toLowerCase()}`);
        if (emaSet?.name) contextReasons.push(`ema_set=${emaSet.name}`);
        contextReasons.push(`adx>=${params.adxTrendMin}`);
    } else {
        regimeType = "RANGE";
        trendBias = "NEUTRAL";
        if (!aligned) contextReasons.push("ema_misaligned");
        if (emaSet?.name) contextReasons.push(`ema_set=${emaSet.name}`);
        if (Number.isFinite(adx)) {
            if (adx <= Number(params.adxRangeMax || 18)) contextReasons.push(`adx<=${params.adxRangeMax}`);
            else contextReasons.push("adx_not_trend_aligned");
        } else {
            contextReasons.push("adx_missing");
        }
    }

    let volatilityRegime = "UNKNOWN";
    if (Number.isFinite(atrPct)) {
        if (atrPct < Number(params.atrPctLow || 0.0002)) volatilityRegime = "LOW";
        else if (atrPct > Number(params.atrPctHigh || 0.03)) volatilityRegime = "HIGH";
        else volatilityRegime = "NORMAL";
        contextReasons.push(`vol=${volatilityRegime.toLowerCase()}`);
    }

    let regimeScore = 0;
    if (regimeType === "TREND") {
        regimeScore += 0.5;
        if (Number.isFinite(adx)) regimeScore += Math.min(0.4, Math.max(0, (adx - (params.adxTrendMin || 20)) / 40));
        if (aligned) regimeScore += 0.1;
    } else if (regimeType === "RANGE") {
        regimeScore += 0.4;
        if (Number.isFinite(adx)) regimeScore += Math.min(0.3, Math.max(0, ((params.adxRangeMax || 18) - adx) / (params.adxRangeMax || 18)));
        if (!aligned) regimeScore += 0.2;
    }
    regimeScore = Number(Math.min(1, Math.max(0, regimeScore)).toFixed(4));

    return {
        step: 2,
        stepName: STEP2_NAME,
        regimeType,
        trendBias,
        volatilityRegime,
        regimeScore,
        contextReasons,
        logFields: {
            regimeType,
            trendBias,
            volatilityRegime,
            regimeScore,
            h1Adx: adx,
            h1AtrPct: atrPct,
            h1EmaFast: emaFast,
            h1EmaMid: emaMid,
            h1EmaSlow: emaSlow,
            h1EmaSetUsed: emaSet?.name || null,
        },
    };
}
