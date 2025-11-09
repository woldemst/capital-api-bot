import logger from "../utils/logger.js";

class Strategy {
    constructor() {}

    trendFrom = (fast, slow, minGap = 0) => {
        if (fast == null || slow == null) return "neutral";
        const diff = fast - slow;
        if (diff > minGap) return "bullish";
        if (diff < -minGap) return "bearish";
        return "neutral";
    };

    pickTrend(frame, fast = ["ema20", "emaFast", "ema9"], slow = ["ema50", "emaSlow", "ema21"]) {
        const fastVal = fast.map((k) => frame?.[k]).find((v) => v != null);
        const slowVal = slow.map((k) => frame?.[k]).find((v) => v != null);
        return this.trendFrom(fastVal, slowVal);
    }

    getPipSize(symbol = "") {
        return symbol.includes("JPY") ? 0.01 : 0.0001;
    }

    analyzeHigherTimeframe(frame, timeframe = "m15") {
        if (!frame) return null;

        const direction = this.pickTrend(frame);
        if (!["bullish", "bearish"].includes(direction)) {
            return { direction: "neutral", ready: false, reason: "neutral_trend" };
        }

        const slope = frame.ema20Slope ?? 0;
        const macdMomentum = frame.macd?.histogram ?? 0;
        const adx = frame.adx ?? frame.trendStrength ?? 0;
        const close = frame.close ?? frame.lastClose ?? null;
        const ema20 = frame.ema20 ?? null;
        const ema50 = frame.ema50 ?? null;
        const atr = frame.atr ?? null;
        const priceAligned =
            close != null && ema20 != null
                ? direction === "bullish"
                    ? close >= ema20 && (ema50 == null || close >= ema50)
                    : close <= ema20 && (ema50 == null || close <= ema50)
                : false;
        const slopeAligned = direction === "bullish" ? slope > 0 : slope < 0;
        const momentumAligned =
            macdMomentum != null
                ? direction === "bullish"
                    ? macdMomentum > 0
                    : macdMomentum < 0
                : false;

        const atrPct = atr != null && close ? atr / close : 0;
        const minAdx = timeframe === "h1" ? 17 : 19;
        const minAtrPct = timeframe === "h1" ? 0.00035 : 0.00025;

        const adxOk = adx >= minAdx;
        const volatilityOk = atrPct >= minAtrPct;

        const scoreComponents = {
            priceAligned,
            slopeAligned,
            momentumAligned,
            adxOk,
            volatilityOk,
        };

        const score = Object.values(scoreComponents).filter(Boolean).length;
        const ready = slopeAligned && (momentumAligned || adxOk) && priceAligned;

        return {
            direction,
            slope,
            macdMomentum,
            adx,
            atrPct,
            priceAligned,
            slopeAligned,
            momentumAligned,
            adxOk,
            volatilityOk,
            score,
            ready,
        };
    }

    buildM5Entry(direction, candles = [], m5Indicators = {}, symbol) {
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const pullback = candles[candles.length - 3];
        if (!last || !prev) {
            return { valid: false, reason: "insufficient_m5_candles" };
        }

        const pip = this.getPipSize(symbol);
        const ema21 = m5Indicators?.ema21;
        const ema50 = m5Indicators?.ema50;
        const adx = m5Indicators?.adx ?? 0;
        const atr = m5Indicators?.atr;
        const atrFallback = Math.max(atr ?? 0, last.high - last.low);
        const atrValue = atrFallback > 0 ? atrFallback : Math.abs(last.close - prev.close) || pip * 6;

        const isBullish = direction === "bullish";
        const isBearish = direction === "bearish";
        const bullish = (c) => c?.close > c?.open;
        const bearish = (c) => c?.close < c?.open;

        const range = last.high - last.low;
        const body = Math.abs(last.close - last.open);
        const bodyRatio = range > 0 ? body / range : 0;
        const upperWick = last.high - Math.max(last.open, last.close);
        const lowerWick = Math.min(last.open, last.close) - last.low;

        const breakStructure = isBullish ? last.close > prev.high : last.close < prev.low;
        const momentumBody = bodyRatio >= 0.55;
        const wickOk = isBullish ? upperWick <= range * 0.35 : lowerWick <= range * 0.35;
        const trendAligned = (() => {
            const m5Trend = this.pickTrend(m5Indicators, ["ema9", "ema10", "ema20"], ["ema21", "ema30", "ema50"]);
            return m5Trend === direction;
        })();

        const pullbackTouched =
            pullback && ema21 != null
                ? isBullish
                    ? pullback.low <= ema21 || prev.low <= ema21
                    : pullback.high >= ema21 || prev.high >= ema21
                : false;

        const priceVsEma =
            ema21 != null && ema50 != null
                ? isBullish
                    ? last.close >= ema21 && last.close >= ema50
                    : last.close <= ema21 && last.close <= ema50
                : true;

        if (!trendAligned) {
            return { valid: false, reason: "m5_trend_mismatch" };
        }
        if (!pullbackTouched) {
            return { valid: false, reason: "pullback_not_confirmed" };
        }
        if (!breakStructure) {
            return { valid: false, reason: "no_structure_break" };
        }
        if (!momentumBody || !wickOk) {
            return { valid: false, reason: "weak_trigger_candle" };
        }
        if (!priceVsEma) {
            return { valid: false, reason: "price_not_aligned_with_emas" };
        }
        if (adx < 16) {
            return { valid: false, reason: "low_m5_momentum" };
        }

        const entryPrice = last.close;
        const swingExtreme = (() => {
            if (isBullish) {
                const lowest = Math.min(prev.low ?? entryPrice, pullback?.low ?? Number.POSITIVE_INFINITY);
                return Number.isFinite(lowest) ? lowest : entryPrice;
            }
            const highest = Math.max(prev.high ?? entryPrice, pullback?.high ?? Number.NEGATIVE_INFINITY);
            return Number.isFinite(highest) ? highest : entryPrice;
        })();

        const atrStopBuffer = atrValue * 0.85;
        const minDistance = pip * 4;

        let stopLoss = entryPrice;
        if (isBullish) {
            const swingBased = swingExtreme - pip * 1.5;
            const atrBased = entryPrice - atrStopBuffer;
            stopLoss = Math.min(swingBased, atrBased);
            if (entryPrice - stopLoss < minDistance) {
                stopLoss = entryPrice - minDistance;
            }
        } else if (isBearish) {
            const swingBased = swingExtreme + pip * 1.5;
            const atrBased = entryPrice + atrStopBuffer;
            stopLoss = Math.max(swingBased, atrBased);
            if (stopLoss - entryPrice < minDistance) {
                stopLoss = entryPrice + minDistance;
            }
        }

        const risk = Math.abs(entryPrice - stopLoss);
        const rrTarget = 1.8;
        const takeProfit = isBullish ? entryPrice + risk * rrTarget : entryPrice - risk * rrTarget;

        return {
            valid: true,
            direction,
            entryPrice,
            stopLoss,
            takeProfit,
            rr: rrTarget,
            last,
            prev,
            pullback,
            bodyRatio,
            adx,
            momentumBody,
            breakStructure,
            pullbackTouched,
            wickOk,
        };
    }

    // --- Main signal with multi-timeframe preparation layer ---
    getSignal = ({ symbol, indicators, candles }) => {
        const { m5, m15, h1 } = indicators || {};
        const m5Candles = candles?.m5Candles || [];

        const prev = m5Candles[m5Candles.length - 2];
        const last = m5Candles[m5Candles.length - 1];
        if (!prev || !last) return { signal: null, reason: "no_candle_data" };

        const m15State = this.analyzeHigherTimeframe(m15, "m15");
        const h1State = this.analyzeHigherTimeframe(h1, "h1");

        if (!m15State?.ready) {
            return { signal: null, reason: "m15_not_ready", context: { m15State } };
        }

        if (!h1State?.ready) {
            return { signal: null, reason: "h1_not_ready", context: { h1State } };
        }

        if (m15State.direction !== h1State.direction) {
            return {
                signal: null,
                reason: "htf_direction_conflict",
                context: { m15Direction: m15State.direction, h1Direction: h1State.direction },
            };
        }

        const entrySetup = this.buildM5Entry(m15State.direction, m5Candles, m5, symbol);
        if (!entrySetup.valid) {
            return { signal: null, reason: entrySetup.reason, context: { entrySetup } };
        }

        const decision = entrySetup.direction === "bullish" ? "BUY" : "SELL";

        return {
            signal: decision,
            reason: "multi_tf_confirmed_entry",
            context: {
                prev,
                last,
                entrySetup,
                higher: {
                    m15: m15State,
                    h1: h1State,
                },
            },
        };
    };

    greenRedCandlePattern(trend, prev, last) {
        if (!prev || !last) return false;
        const isBullish = (c) => c.close > c.open;
        const isBearish = (c) => c.close < c.open;

        const bodySize = Math.abs(last.close - last.open);
        const range = last.high - last.low;
        const minBodyRatio = 0.3; // require body ≥ 30% of total range

        const trendDirection = String(trend).toLowerCase();

        // Only strong candle in direction of trend counts
        const strongCandle = range > 0 && bodySize / range >= minBodyRatio;

        if (isBearish(prev) && isBullish(last) && trendDirection === "bullish" && strongCandle) {
            return "bullish";
        }

        if (isBullish(prev) && isBearish(last) && trendDirection === "bearish" && strongCandle) {
            return "bearish";
        }

        return false;
    }

    engulfingPattern(prev, last) {
        const getOpen = (c) => c.open;
        const getClose = (c) => c.close;

        if (!prev || !last) return null;

        const prevOpen = getOpen(prev);
        const prevClose = getClose(prev);

        const lastOpen = getOpen(last);
        const lastClose = getClose(last);

        // Bullish engulfing
        if (lastClose > lastOpen && prevClose < prevOpen && lastClose > prevOpen && lastOpen < prevClose) return "bullish";

        // Bearish engulfing
        if (lastClose < lastOpen && prevClose > prevOpen && lastClose < prevOpen && lastOpen > prevClose) return "bearish";

        return null;
    }

    pinBarPattern(last) {
        if (!last) return null;
        const open = last.open;
        const close = last.close;
        const high = last.high;
        const low = last.low;

        const body = Math.abs(close - open);
        const upperWick = high - Math.max(open, close);
        const lowerWick = Math.min(open, close) - low;

        // Bullish pin bar: long lower wick (≥2× body)
        if (lowerWick > body * 2) return "bullish";

        // Bearish pin bar: long upper wick (≥2× body)
        if (upperWick > body * 2) return "bearish";

        return null;
    }
}

export default new Strategy();
