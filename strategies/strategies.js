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

        const m5Candles = candles?.m5Candles || [];
        const prev = m5Candles[m5Candles.length - 2];
        const last = m5Candles[m5Candles.length - 1];
        if (!prev || !last) return { signal: null, reason: "no_candle_data" };

        // --- Trend detection ---
        const m5Trend = this.pickTrend(m5, { symbol, timeframe: "M5", atr });
        const m15Trend = this.pickTrend(m15, { symbol, timeframe: "M15", atr });
        const h1Trend = this.pickTrend(h1, { symbol, timeframe: "H1", atr });
        const h4Trend = this.pickTrend(h4, { symbol, timeframe: "H4", atr });

        const desired = m5Trend;

        // ------------------------------------------------------------
        //                1. M15 Alignment (ATR-based)
        // ------------------------------------------------------------
        const tolerance = atr * 0.6;

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
        if (emaDistance < atr * 1.0) {
            return { signal: null, reason: "too_close_to_ema50" };
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
