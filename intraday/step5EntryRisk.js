import { DEFAULT_INTRADAY_CONFIG } from "./config.js";

export const STEP5_NAME = "ENTRY_RISK";

function toNum(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Number(n.toFixed(decimals));
}

export function step5EntryRisk(input, config = DEFAULT_INTRADAY_CONFIG) {
    const side = String(input?.side || "").toUpperCase();
    const symbol = String(input?.symbol || "").toUpperCase();
    const equity = toNum(input?.equity);
    const bid = toNum(input?.bid);
    const ask = toNum(input?.ask);
    const mid = toNum(input?.mid) ?? ([bid, ask].every(Number.isFinite) ? (bid + ask) / 2 : bid ?? ask);
    const spread = toNum(input?.spread) ?? ([bid, ask].every(Number.isFinite) ? Math.abs(ask - bid) : null);
    const m5Indicators = input?.m5Indicators || input?.m5 || {};
    const atr = toNum(input?.atr) ?? toNum(m5Indicators.atr);
    const params = config.risk || {};

    const entryPrice =
        toNum(input?.entryPrice) ??
        (side === "LONG" ? ask : side === "SHORT" ? bid : null) ??
        mid;

    const invalidReasons = [];
    if (!["LONG", "SHORT"].includes(side)) invalidReasons.push("invalid_side");
    if (!Number.isFinite(equity) || equity <= 0) invalidReasons.push("invalid_equity");
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) invalidReasons.push("invalid_entry_price");

    const riskPct = Number(params.forexRiskPct || 0.005);
    const riskAmount = Number.isFinite(equity) ? equity * riskPct : null;
    const minStopPct = Number(params.minStopPctForex || 0.00025);
    const atrStop = Number.isFinite(atr) ? atr * Number(params.atrStopMultiplier || 1.2) : 0;
    const spreadStop = Number.isFinite(spread) ? spread * Number(params.spreadStopMultiplier || 2.5) : 0;
    const pctStop = Number.isFinite(entryPrice) ? entryPrice * minStopPct : 0;
    const stopDistance = Math.max(atrStop || 0, spreadStop || 0, pctStop || 0);
    if (!(stopDistance > 0)) invalidReasons.push("invalid_stop_distance");

    const contractPointValue = Number(params.contractPointValue || 1);
    const rawSize =
        Number.isFinite(riskAmount) && stopDistance > 0 && contractPointValue > 0 ? riskAmount / (stopDistance * contractPointValue) : null;
    const size = rawSize !== null ? Math.max(Number(params.minSize || 0), rawSize) : null;

    let sl = null;
    let tp = null;
    const rr = Number(params.rr || 2);
    if (Number.isFinite(entryPrice) && stopDistance > 0) {
        if (side === "LONG") {
            sl = entryPrice - stopDistance;
            tp = entryPrice + rr * stopDistance;
        } else if (side === "SHORT") {
            sl = entryPrice + stopDistance;
            tp = entryPrice - rr * stopDistance;
        }
    }

    const valid = invalidReasons.length === 0 && Number.isFinite(size) && size > 0 && Number.isFinite(sl) && Number.isFinite(tp);

    const planReasons = [];
    if (valid) {
        planReasons.push(`risk_pct=${riskPct}`);
        if (stopDistance === atrStop) planReasons.push("stop_from_atr");
        if (stopDistance === spreadStop) planReasons.push("stop_from_spread");
        if (stopDistance === pctStop) planReasons.push("stop_from_min_pct");
    } else {
        planReasons.push(...invalidReasons);
    }

    return {
        step: 5,
        stepName: STEP5_NAME,
        valid,
        orderPlan: valid
            ? {
                  symbol,
                  side,
                  entryType: "MARKET",
                  size: round(size, 6),
                  entryPrice: round(entryPrice, 8),
                  sl: round(sl, 8),
                  tp: round(tp, 8),
                  stopDistance: round(stopDistance, 8),
                  riskAmount: round(riskAmount, 8),
                  rr,
                  riskPct,
                  planReasons,
              }
            : null,
        planReasons,
        logFields: {
            step5Valid: valid,
            riskPct,
            riskAmount: round(riskAmount, 8),
            stopDistance: round(stopDistance, 8),
            rr,
        },
    };
}
