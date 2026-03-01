import { DEFAULT_INTRADAY_CONFIG } from "./config.js";

export const STEP3_NAME = "SETUP_M15";

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function candleValue(candle, key) {
    return toNum(candle?.[key]);
}

function priceInZone(price, a, b, tolerancePct) {
    if (![price, a, b].every(Number.isFinite)) return false;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const tol = Math.abs(price) * Number(tolerancePct || 0);
    return price >= low - tol && price <= high + tol;
}

export function step3Setup(input, config = DEFAULT_INTRADAY_CONFIG) {
    const regime = input?.regime || {};
    const m15Indicators = input?.m15Indicators || input?.m15 || {};
    const m15Candle = input?.m15Candle || input?.candle || {};
    const prevM15Candle = input?.prevM15Candle || input?.prevCandle || {};
    const params = config.setup || {};

    const close = candleValue(m15Candle, "c") ?? toNum(m15Indicators.close ?? m15Indicators.lastClose);
    const low = candleValue(m15Candle, "l");
    const high = candleValue(m15Candle, "h");
    const prevLow = candleValue(prevM15Candle, "l");
    const prevHigh = candleValue(prevM15Candle, "h");
    const prevClose = candleValue(prevM15Candle, "c");

    const ema20 = toNum(m15Indicators.ema20);
    const ema50 = toNum(m15Indicators.ema50);
    const rsi = toNum(m15Indicators.rsi);
    const bbPb = toNum(m15Indicators?.bb?.pb ?? m15Indicators.bbPb);
    const h1Adx = toNum(regime?.logFields?.h1Adx ?? regime?.h1Adx);

    const setupReasons = [];
    let setupType = "NONE";
    let side = null;
    let setupScore = 0;

    if (regime.regimeType === "TREND" && (regime.trendBias === "LONG" || regime.trendBias === "SHORT")) {
        const inEmaZone = priceInZone(close, ema20, ema50, params.trendPullbackZonePct);
        const rsiOk =
            Number.isFinite(rsi) &&
            rsi >= Number(params.trendRsiMin || 35) &&
            rsi <= Number(params.trendRsiMax || 65);
        const structureOk =
            regime.trendBias === "LONG"
                ? (Number.isFinite(low) && Number.isFinite(prevLow) ? low >= prevLow : Number.isFinite(close) && Number.isFinite(prevClose) && close >= prevClose)
                : (Number.isFinite(high) && Number.isFinite(prevHigh) ? high <= prevHigh : Number.isFinite(close) && Number.isFinite(prevClose) && close <= prevClose);

        if (inEmaZone) setupReasons.push("pullback_into_ema_zone");
        if (rsiOk) setupReasons.push("rsi_pullback_valid");
        if (structureOk) setupReasons.push("structure_pullback_valid");

        if (inEmaZone && rsiOk && structureOk) {
            const maxH1AdxForTrendSetup = Number(params.maxH1AdxForTrendSetup);
            if (Number.isFinite(maxH1AdxForTrendSetup) && maxH1AdxForTrendSetup > 0 && Number.isFinite(h1Adx) && h1Adx > maxH1AdxForTrendSetup) {
                setupReasons.push(`h1_adx_above_max=${maxH1AdxForTrendSetup}`);
            } else {
                setupType = "TREND_PULLBACK";
                const trendEntryMode = String(params.trendEntryMode || "continuation").toLowerCase();
                if (trendEntryMode === "reversion") {
                    side = regime.trendBias === "LONG" ? "SHORT" : "LONG";
                    setupReasons.push("trend_entry_mode_reversion");
                } else {
                    side = regime.trendBias;
                    setupReasons.push("trend_entry_mode_continuation");
                }
                setupScore = 0.75 + (regime.regimeScore || 0) * 0.2;
            }
        }
    }

    if (
        setupType === "NONE" &&
        regime.regimeType === "RANGE" &&
        Boolean(config.guardrails?.allowRangeContrarian)
    ) {
        const lowTrigger = Number(params.rangeBbPbLow || 0.1);
        const highTrigger = Number(params.rangeBbPbHigh || 0.9);
        if (Number.isFinite(bbPb) && bbPb <= lowTrigger && Number.isFinite(rsi) && rsi <= Number(params.rangeRsiLow || 35)) {
            setupType = "RANGE_REVERSION";
            side = "LONG";
            setupScore = 0.6;
            setupReasons.push("range_boundary_lower");
        } else if (Number.isFinite(bbPb) && bbPb >= highTrigger && Number.isFinite(rsi) && rsi >= Number(params.rangeRsiHigh || 65)) {
            setupType = "RANGE_REVERSION";
            side = "SHORT";
            setupScore = 0.6;
            setupReasons.push("range_boundary_upper");
        }
    }

    setupScore = Number(Math.min(1, Math.max(0, setupScore)).toFixed(4));

    return {
        step: 3,
        stepName: STEP3_NAME,
        setupType,
        side,
        setupScore,
        setupReasons,
        logFields: {
            setupType,
            side,
            setupScore,
            m15Rsi: rsi,
            m15BbPb: bbPb,
            m15Ema20: ema20,
            m15Ema50: ema50,
        },
    };
}
