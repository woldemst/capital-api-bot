import { LOOKAHEAD_CANDLES } from "./helpers.js";

export const baselineConfig = {
    id: "baseline",
    label: "Baseline (current logic)",
    trendAlignment: false,
    atrGate: { mode: "off", scope: "H1", minPips: null, maxPips: null },
    rsiGate: { mode: "off", scope: "H1", longRange: null, shortRange: null },
    softExit: "standard",
    softExitWarmup: 2,
    riskReward: 1.8,
    maxCandles: LOOKAHEAD_CANDLES,
};

const TREND_OPTIONS = [false, true];
const ATR_OPTIONS = [
    { mode: "off" },
    { mode: "min", minPips: 4 },
    { mode: "band", minPips: 4, maxPips: 18 },
];
const RSI_OPTIONS = [
    { mode: "off" },
    { mode: "band", scope: "M15", longRange: [32, 55], shortRange: [45, 68] },
];
const SOFT_EXIT_OPTIONS = [
    { mode: "off", warmup: 2 },
    { mode: "conservative", warmup: 3 },
    { mode: "standard", warmup: 2 },
    { mode: "aggressive", warmup: 1 },
];
const RR_OPTIONS = [1.2, 1.5, 2.0];

export function buildExperimentGrid() {
    const configs = [];
    for (const trend of TREND_OPTIONS) {
        for (const atr of ATR_OPTIONS) {
            for (const rsi of RSI_OPTIONS) {
                for (const soft of SOFT_EXIT_OPTIONS) {
                    for (const rr of RR_OPTIONS) {
                        const id = [
                            `trend_${trend ? "on" : "off"}`,
                            `atr_${atr.mode}`,
                            `rsi_${rsi.mode}`,
                            `soft_${soft.mode}`,
                            `rr_${rr}`,
                        ].join("__");
                        configs.push({
                            id,
                            label: id.replace(/__/g, " | "),
                            trendAlignment: trend,
                            atrGate: {
                                mode: atr.mode,
                                scope: "H1",
                                minPips: atr.minPips ?? null,
                                maxPips: atr.maxPips ?? null,
                            },
                            rsiGate: {
                                mode: rsi.mode,
                                scope: rsi.scope || "H1",
                                longRange: rsi.longRange || null,
                                shortRange: rsi.shortRange || null,
                            },
                            softExit: soft.mode,
                            softExitWarmup: soft.warmup,
                            riskReward: rr,
                            maxCandles: LOOKAHEAD_CANDLES,
                        });
                    }
                }
            }
        }
    }
    return configs;
}
