

class Strategy {
    constructor() {}
    // ------------------------------------------------------------
    //                      MAIN SIGNAL LOGIC
    // ------------------------------------------------------------
    getSignal = ({ symbol, indicators, candles, bid, ask }) => {
        const { m5, m15, h1, h4 } = indicators || {};

        // Execution timeframe = M5 (as in original script: suggested chart timeframe 5m)
        const m5Candles = candles?.m5Candles || [];
        const prev = m5Candles[m5Candles.length - 2];
        const last = m5Candles[m5Candles.length - 1];

        if (!prev || !last) {
            return { signal: null, reason: "no_candle_data" };
        }

        // Need higher TF indicators
        if (!m5 || !m15 || !h1 || !h4) {
            return { signal: null, reason: "missing_tf_indicators" };
        }

        // --- Helpers ---
        const safeClose = (c) => c?.close ?? c?.Close ?? c?.closePrice?.bid ?? null;
        const pip = symbol && symbol.includes("JPY") ? 0.01 : 0.0001;

        // In the original script: tf1=D, tf2=H4, tf3=H1 on a 5m chart.
        // Here we approximate with: tf1 = H4, tf2 = H1, tf3 = M15 (we don't fetch D1 in analyzeSymbol).
        const isAboveCenter = (frame) =>
            frame && typeof frame.lastClose === "number" && typeof frame.ema50 === "number"
                ? frame.lastClose > frame.ema50
                : false;

        const isBelowCenter = (frame) =>
            frame && typeof frame.lastClose === "number" && typeof frame.ema50 === "number"
                ? frame.lastClose < frame.ema50
                : false;

        const ltf1 = isAboveCenter(h4);
        const ltf2 = isAboveCenter(h1);
        const ltf3 = isAboveCenter(m15);

        const stf1 = isBelowCenter(h4);
        const stf2 = isBelowCenter(h1);
        const stf3 = isBelowCenter(m15);

        const longAligned = ltf1 && ltf2 && ltf3;
        const shortAligned = stf1 && stf2 && stf3;

        // Center EMA on execution timeframe (Pine: ctfsrc = ema(src, lengthCenter))
        const centerEma = typeof m5.ema50 === "number" ? m5.ema50 : null;
        const prevCenterEma = typeof m5.ema50Prev === "number" ? m5.ema50Prev : centerEma;

        if (centerEma == null) {
            return { signal: null, reason: "no_center_ema" };
        }

        const lastClose = safeClose(last);
        const prevClose = safeClose(prev);

        if (lastClose == null || prevClose == null) {
            return { signal: null, reason: "invalid_closes" };
        }

        // inrange(ctfsrc) => center EMA inside current candle's range
        const inRangeCenter = centerEma >= last.low && centerEma <= last.high;

        // cross(src, ctfsrc) approximate: price crosses center EMA between prev and last
        const crossedCenter =
            (prevClose < prevCenterEma && lastClose > centerEma) ||
            (prevClose > prevCenterEma && lastClose < centerEma);

        // src == ctfsrc in float world → treat as "close enough", say within 0.1 pip
        const touchesCenter = Math.abs(lastClose - centerEma) <= pip * 0.1;

        const longSetup = longAligned && (touchesCenter || crossedCenter || inRangeCenter);
        const shortSetup = shortAligned && (touchesCenter || crossedCenter || inRangeCenter);

        let signal = null;
        let reason = "no_setup";

        if (longSetup && !shortSetup) {
            signal = "BUY";
            reason = "pipcollector_long";
        } else if (shortSetup && !longSetup) {
            signal = "SELL";
            reason = "pipcollector_short";
        }

        return {
            signal,
            reason,
            context: {
                symbol,
                pip,
                tfAlignment: {
                    longAligned,
                    shortAligned,
                    ltf1,
                    ltf2,
                    ltf3,
                    stf1,
                    stf2,
                    stf3,
                },
                centerEma,
                prevCenterEma,
                lastClose,
                prevClose,
                inRangeCenter,
                crossedCenter,
                touchesCenter,
                last,
                prev,
                timeframe: "M5",
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
