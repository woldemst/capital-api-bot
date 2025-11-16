
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const EVOLUTION_DIR = process.env.EVOLUTION_DIR ? path.resolve(process.env.EVOLUTION_DIR) : path.resolve(repoRoot, "backtest", "results");

const runtimeOverrides = new Map();
const diskOverridesCache = new Map();

const baseDefaults = () => ({
    ema: {
        minM15Gap: 0,
        toleranceMultiplier: 0.6,
        minDistanceAtrMultiplier: 1.0,
    },
    atr: { slMultiplier: 1.25, tpMultiplier: 1.4 },
    session: { enabled: false, startHour: 0, endHour: 24 },
    volatility: {},
    sellQualification: null,
    rr: { min: 1.0, target: 1.5, max: 2.4 },
});

const baseRulesByPair = {
    EURJPY: () =>
        mergeRules(baseDefaults(), {
            ema: { minM15Gap: 0.08, toleranceMultiplier: 0.42, minDistanceAtrMultiplier: 1.4 },
            atr: { slMultiplier: 1.55, tpMultiplier: 1.15 },
            session: { enabled: true, startHour: 6, endHour: 20 },
            volatility: { minH1Atr: 0.08 },
            sellQualification: { maxH4Gap: 0.22, maxH1Slope: 0.05 },
            rr: { min: 1.2, target: 1.45, max: 1.9 },
        }),
    GBPJPY: () =>
        mergeRules(baseDefaults(), {
            ema: { minM15Gap: 0.09, toleranceMultiplier: 0.38, minDistanceAtrMultiplier: 1.5 },
            atr: { slMultiplier: 1.7, tpMultiplier: 1.2 },
            session: { enabled: true, startHour: 7, endHour: 21 },
            volatility: { minH1Atr: 0.09 },
            sellQualification: { maxH4Gap: 0.2, maxH1Slope: 0.06 },
            rr: { min: 1.25, target: 1.55, max: 2.0 },
        }),
    EURUSD: () =>
        mergeRules(baseDefaults(), {
            ema: { minM15Gap: 0.00025, toleranceMultiplier: 0.55, minDistanceAtrMultiplier: 0.9 },
            atr: { slMultiplier: 1.2, tpMultiplier: 1.6 },
            session: { enabled: true, startHour: 7, endHour: 22 },
            volatility: { minH1Atr: 0.00018 },
            rr: { min: 1.1, target: 1.8, max: 2.5 },
        }),
};

function mergeRules(...layers) {
    return layers.reduce((acc, layer) => deepMerge(acc, layer), {});
}

function deepMerge(target = {}, source = {}) {
    const output = { ...target };
    if (!source || typeof source !== "object") return output;
    for (const [key, value] of Object.entries(source)) {
        if (Array.isArray(value)) {
            output[key] = value.slice();
        } else if (value && typeof value === "object") {
            output[key] = deepMerge(output[key] || {}, value);
        } else if (value !== undefined) {
            output[key] = value;
        }
    }
    return output;
}

function getBaseRules(symbol = "") {
    const upper = (symbol || "").toUpperCase();
    return (baseRulesByPair[upper] || baseDefaults)();
}

function getPairSlug(symbol = "") {
    return (symbol || "default").replace(/[^\w]/g, "").toUpperCase();
}

function loadDiskOverrides(symbol = "") {
    const slug = getPairSlug(symbol);
    const cached = diskOverridesCache.get(slug);
    const filePath = path.join(EVOLUTION_DIR, `improvements_${slug}.json`);

    if (!fs.existsSync(filePath)) {
        diskOverridesCache.set(slug, { overrides: null, mtime: null });
        return null;
    }

    try {
        const stats = fs.statSync(filePath);
        if (cached && cached.mtime === stats.mtimeMs) {
            return cached.overrides;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const overrides = raw?.rules ?? null;
        diskOverridesCache.set(slug, { overrides, mtime: stats.mtimeMs });
        return overrides;
    } catch (error) {
        return cached?.overrides ?? null;
    }
}

export function setPairRuleOverrides(symbol, overrides = {}) {
    if (!symbol) return;
    const slug = getPairSlug(symbol);
    const existing = runtimeOverrides.get(slug);
    runtimeOverrides.set(slug, mergeRules(existing ?? {}, overrides ?? {}));
}

export function clearPairRuleOverrides(symbol) {
    if (!symbol) {
        runtimeOverrides.clear();
        return;
    }
    runtimeOverrides.delete(getPairSlug(symbol));
}

export function getPairRules(symbol = "") {
    const slug = getPairSlug(symbol);
    const base = mergeRules(getBaseRules(symbol));
    const disk = loadDiskOverrides(symbol);
    const runtime = runtimeOverrides.get(slug);

    return mergeRules(base, disk, runtime);
}

class Strategy {
    constructor() {}

    // --- Dynamic minimum EMA gap ---
    getMinGap(symbol = "", timeframe = "", slow = 0, atr = 0) {
        const price = Math.abs(slow ?? 0) || 1;
        const isJPY = symbol.includes("JPY");

        // baseline percentage gap
        const basePct = isJPY ? 0.0003 : 0.001;

        const tfMultiplier = timeframe === "H4" ? 1.8 : timeframe === "H1" ? 1.4 : timeframe === "M15" ? 1.0 : 0.8;

        const floorMap = isJPY ? { default: 0.02, H1: 0.03, H4: 0.05 } : { default: 0.0007, H1: 0.001, H4: 0.0015 };

        const floor = floorMap[timeframe] ?? floorMap.default;

        // ATR-based relaxation for JPY pairs
        const atrAdjust = atr * (isJPY ? 0.5 : 1);

        return Math.max(price * basePct * tfMultiplier, floor, atrAdjust);
    }

    // --- Slope helper (kept, but no longer overrides HTF mismatches) ---
    slopeSupports(frame, desiredTrend, timeframe = "", symbol = "") {
        if (!frame) return false;

        const slope = frame.ema20Slope ?? frame.ema20 - frame.ema20Prev ?? 0;
        const diff = (frame.ema20 ?? 0) - (frame.ema50 ?? 0);

        const baseThreshold = { M5: 0.0025, M15: 0.004, H1: 0.01, H4: 0.015 };
        const diffThreshold = { M5: 0.01, M15: 0.02, H1: 0.05, H4: 0.08 };

        const adjust = symbol.includes("JPY") ? 0.6 : 1;

        const slopeThresh = (baseThreshold[timeframe] ?? 0.003) * adjust;
        const diffThresh = (diffThreshold[timeframe] ?? 0.02) * adjust;

        if (desiredTrend === "bullish") return slope > slopeThresh || diff > diffThresh;
        if (desiredTrend === "bearish") return slope < -slopeThresh || diff < -diffThresh;

        return false;
    }

    oppositeTrend(t) {
        return t === "bullish" ? "bearish" : t === "bearish" ? "bullish" : "neutral";
    }

    // --- Higher timeframe MUST match desired direction. No overrides. ---
    higherTimeframeDecision(current, desired) {
        if (current === desired) return { accepted: true, rationale: "trend_match" };
        return { accepted: false, rationale: `trend_${current}` };
    }

    // --- ATR-based EMA-gap trend detection ---
    trendFrom = (fast, slow, options = {}) => {
        if (fast == null || slow == null) return "neutral";

        const { symbol = "", timeframe = "", atr = 0 } = options;

        const minGap = this.getMinGap(symbol, timeframe, slow, atr);
        const diff = fast - slow;

        if (diff > minGap) return "bullish";
        if (diff < -minGap) return "bearish";
        return "neutral";
    };

    pickTrend(frame, options = {}) {
        const { fastKeys = ["ema20", "emaFast", "ema9"], slowKeys = ["ema50", "emaSlow", "ema21"], symbol = "", timeframe = "", atr = 0 } = options;

        const fastVal = fastKeys.map((k) => frame?.[k]).find((v) => v != null);
        const slowVal = slowKeys.map((k) => frame?.[k]).find((v) => v != null);

        return this.trendFrom(fastVal, slowVal, { symbol, timeframe, atr });
    }

    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------
    getSignal = ({ symbol, indicators, candles }) => {
        const { m5, m15, h1, h4 } = indicators || {};
        const atr = m5?.atr ?? 0;
        const pairRules = getPairRules(symbol);

        const m5Candles = candles?.m5Candles || [];
        const prev = m5Candles[m5Candles.length - 2];
        const last = m5Candles[m5Candles.length - 1];
        if (!prev || !last) return { signal: null, reason: "no_candle_data" };

        const activeTimestamp = m5?.timestamp || last?.timestamp || prev?.timestamp;
        if (pairRules.session?.enabled && activeTimestamp) {
            const hour = new Date(activeTimestamp).getUTCHours();
            const { startHour = 0, endHour = 24 } = pairRules.session;
            if (hour < startHour || hour >= endHour) {
                return {
                    signal: null,
                    reason: "session_blocked",
                    context: { hour, window: `${startHour}-${endHour}` },
                };
            }
        }
        if (pairRules.volatility?.minH1Atr && (h1?.atr ?? 0) < pairRules.volatility.minH1Atr) {
            return {
                signal: null,
                reason: "volatility_blocked",
                context: { h1Atr: h1?.atr ?? null, min: pairRules.volatility.minH1Atr },
            };
        }

        // --- Trend detection ---
        const m5Trend = this.pickTrend(m5, { symbol, timeframe: "M5", atr });
        const m15Trend = this.pickTrend(m15, { symbol, timeframe: "M15", atr });
        const h1Trend = this.pickTrend(h1, { symbol, timeframe: "H1", atr });
        const h4Trend = this.pickTrend(h4, { symbol, timeframe: "H4", atr });

        const desired = m5Trend;

        const requiredGap = pairRules.ema?.minM15Gap ?? 0;
        if (requiredGap) {
            const m15Gap = Math.abs((m15?.ema20 ?? 0) - (m15?.ema50 ?? 0));
            if (m15Gap < requiredGap) {
                return {
                    signal: null,
                    reason: "m15_gap_insufficient",
                    context: { m15Gap, requiredGap },
                };
            }
        }

        // ------------------------------------------------------------
        //                1. M15 Alignment (ATR-based)
        // ------------------------------------------------------------
        const toleranceMultiplier = pairRules.ema?.toleranceMultiplier ?? 0.6;
        const tolerance = atr * toleranceMultiplier;

        const m15Aligned =
            desired === m15Trend || (m15Trend === "neutral" && this.slopeSupports(m15, desired, "M15", symbol)) || Math.abs(m5.ema20 - m15.ema20) < tolerance;

        if (!m15Aligned) {
            return {
                signal: null,
                reason: "tf_misaligned",
                context: { m5Trend, m15Trend },
            };
        }

        // ------------------------------------------------------------
        //                2. STRICT H1 / H4 FULL ALIGNMENT
        // ------------------------------------------------------------
        const h1Check = this.higherTimeframeDecision(h1Trend, desired);
        if (!h1Check.accepted) {
            return { signal: null, reason: "h1_filter_blocked", context: { h1Trend, rationale: h1Check.rationale } };
        }

        const h4Check = this.higherTimeframeDecision(h4Trend, desired);
        if (!h4Check.accepted) {
            return { signal: null, reason: "h4_filter_blocked", context: { h4Trend, rationale: h4Check.rationale } };
        }

        // ------------------------------------------------------------
        //      3. Avoid late entries → Minimum distance to EMA50
        // ------------------------------------------------------------
        const emaDistance = Math.abs(last.close - (m5?.ema50 ?? last.close));
        const emaDistanceMultiplier = pairRules.ema?.minDistanceAtrMultiplier ?? 1.0;
        if (emaDistance < atr * emaDistanceMultiplier) {
            return {
                signal: null,
                reason: "too_close_to_ema50",
                context: { emaDistance, minDistance: atr * emaDistanceMultiplier },
            };
        }

        // ------------------------------------------------------------
        //                       4. Patterns
        // ------------------------------------------------------------
        const pattern = this.greenRedCandlePattern(desired, prev, last);
        const engulfing = this.engulfingPattern(prev, last);
        const pinBar = this.pinBarPattern(last);

        const finalPattern = pattern || engulfing || pinBar;
        if (finalPattern !== desired) {
            return { signal: null, reason: "pattern_mismatch" };
        }

        // Volume check
        if (last.volume != null && prev.volume != null && last.volume < prev.volume * 0.8) {
            return { signal: null, reason: "low_volume" };
        }

        const decision = desired === "bullish" ? "BUY" : "SELL";

        if (decision === "SELL" && pairRules.sellQualification) {
            const h4Gap = (h4?.ema20 ?? 0) - (h4?.ema50 ?? 0);
            const h1Slope = h1?.ema20Slope ?? (h1?.ema20 != null && h1?.ema20Prev != null ? h1.ema20 - h1.ema20Prev : 0);
            const { maxH4Gap, maxH1Slope } = pairRules.sellQualification;
            if ((maxH4Gap != null && h4Gap > maxH4Gap) || (maxH1Slope != null && h1Slope > maxH1Slope)) {
                return {
                    signal: null,
                    reason: "sell_filter_blocked",
                    context: { h4Gap, h1Slope, thresholds: pairRules.sellQualification },
                };
            }
        }

        return {
            signal: decision,
            reason: "pattern+tf_alignment",
            context: {
                m5Trend,
                m15Trend,
                h1Trend,
                h4Trend,
                h1Rationale: h1Check.rationale,
                h4Rationale: h4Check.rationale,
                pattern,
                engulfing,
                pinBar,
                prev,
                last,
            },
        };
    };

    // ------------------------------------------------------------
    //                       PATTERN LOGIC
    // ------------------------------------------------------------
    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last) return false;

        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        const body = Math.abs(last.close - last.open);
        const range = last.high - last.low;
        const strong = range > 0 && body / range >= 0.3;

        const dir = trend.toLowerCase();

        if (isBear(prev) && isBull(last) && dir === "bullish" && strong) return "bullish";
        if (isBull(prev) && isBear(last) && dir === "bearish" && strong) return "bearish";

        return false;
    }

    engulfingPattern(prev, last) {
        if (!prev || !last) return null;

        const bull = last.close > last.open && prev.close < prev.open && last.close > prev.open && last.open < prev.close;

        const bear = last.close < last.open && prev.close > prev.open && last.close < prev.open && last.open > prev.close;

        if (bull) return "bullish";
        if (bear) return "bearish";
        return null;
    }

    pinBarPattern(last) {
        if (!last) return null;

        const body = Math.abs(last.close - last.open);
        const upper = last.high - Math.max(last.open, last.close);
        const lower = Math.min(last.open, last.close) - last.low;

        if (lower > body * 2) return "bullish";
        if (upper > body * 2) return "bearish";

        return null;
    }
}

export default new Strategy();
