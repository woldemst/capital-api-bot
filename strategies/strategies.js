import { STRATEGY } from "../config.js";
class Strategy {
    constructor() {}

    generateSignal({ symbol, indicators, bid, ask, candles }) {
        const { h4, h1, m15, m5, m1 } = indicators;
        const buyRules = this.generateBuyRules(h4, h1, m15, m5, m1, bid);
        const sellRules = this.generateSellRules(h4, h1, m15, m5, m1, ask);
        const { signal, buyScore, sellScore, reason, context } = this.evaluateRules(buyRules, sellRules);
        return {
            signal,
            buyScore,
            sellScore,
            reason,
            context,
        };
    }

    isNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    getEmaDiff(indicators) {
        if (!indicators) return null;
        const { ema9, ema21 } = indicators;
        if (!this.isNumber(ema9) || !this.isNumber(ema21)) return null;
        return ema9 - ema21;
    }

    getMacdHist(indicators) {
        const hist = indicators?.macd?.histogram;
        return this.isNumber(hist) ? hist : null;
    }

    getRsi(indicators) {
        const rsi = indicators?.rsi;
        return this.isNumber(rsi) ? rsi : null;
    }

    getBbPb(indicators) {
        const pb = indicators?.bb?.pb;
        return this.isNumber(pb) ? pb : null;
    }

    generateBuyRules(h4Indicators, h1Indicators, m15Indicators, m5Indicators, m1Indicators, bid) {
        const h4Trend = this.pickTrend(h4Indicators);
        const h1Trend = this.pickTrend(h1Indicators);
        const m15EmaDiff = this.getEmaDiff(m15Indicators);
        const m5EmaDiff = this.getEmaDiff(m5Indicators);
        const m1MacdHist = this.getMacdHist(m1Indicators);

        return [
            {
                name: "buy_h4_trend_pullback_m1_turn",
                ok: h4Trend === "bullish" && this.isNumber(m15EmaDiff) && m15EmaDiff <= 0 && this.isNumber(m1MacdHist) && m1MacdHist > 0,
            },
            {
                name: "buy_h1_trend_dual_pullback",
                ok: h1Trend === "bullish" && this.isNumber(m15EmaDiff) && m15EmaDiff <= 0 && this.isNumber(m5EmaDiff) && m5EmaDiff <= 0,
            },
        ];
    }

    generateSellRules(h4Indicators, h1Indicators, m15Indicators, m5Indicators, m1Indicators, ask) {
        const h4Trend = this.pickTrend(h4Indicators);
        const m15Rsi = this.getRsi(m15Indicators);
        const m15EmaDiff = this.getEmaDiff(m15Indicators);
        const m5BbPb = this.getBbPb(m5Indicators);
        const m1MacdHist = this.getMacdHist(m1Indicators);

        return [
            {
                name: "sell_m15_rsi_turn_m1_macd",
                ok: this.isNumber(m15Rsi) && m15Rsi >= 55 && this.isNumber(m1MacdHist) && m1MacdHist < 0,
            },
            {
                name: "sell_m5_bb_extension_m1_macd",
                ok: this.isNumber(m5BbPb) && m5BbPb >= 0.7 && this.isNumber(m1MacdHist) && m1MacdHist < 0,
            },
            {
                name: "sell_h4_trend_pullback_m1_turn",
                ok: h4Trend === "bearish" && this.isNumber(m15EmaDiff) && m15EmaDiff >= 0 && this.isNumber(m1MacdHist) && m1MacdHist < 0,
            },
        ];
    }

    evaluateRules(buyRules, sellRules) {
        const buyScore = buyRules.filter((r) => r.ok).length;
        const sellScore = sellRules.filter((r) => r.ok).length;
        console.log(`[Signal] BuyRules: ${buyScore}/${buyRules.length}, SellRules: ${sellScore}/${sellRules.length}`);

        const buyHit = buyRules.find((r) => r.ok);
        const sellHit = sellRules.find((r) => r.ok);

        if (buyHit && sellHit) {
            return {
                signal: null,
                buyScore,
                sellScore,
                reason: "conflicting_rules",
                context: { buyRule: buyHit.name, sellRule: sellHit.name },
            };
        }

        if (buyHit) {
            return {
                signal: "buy",
                buyScore,
                sellScore,
                reason: buyHit.name,
                context: { rule: buyHit.name },
            };
        }

        if (sellHit) {
            return {
                signal: "sell",
                buyScore,
                sellScore,
                reason: sellHit.name,
                context: { rule: sellHit.name },
            };
        }

        return {
            signal: null,
            buyScore,
            sellScore,
            reason: "no_rule_match",
            context: {},
        };
    }

    // ------------------------------------------------------------
    //                       PRICE ACTION PATTERN | "GREEN RED"
    // ------------------------------------------------------------
    getSignalGreenRed({ indicators, candles }) {
        const { m5, m15 } = indicators;

        if (candles?.m5Candles.length < 3) return { signal: null, reason: "insufficient_m5_candles", context: {} };
        if (candles?.m15Candles.length < 3) return { signal: null, reason: "insufficient_m15_candles", context: {} };

        const m5Prev = candles.m5Candles[candles.m5Candles.length - 3];
        const m5Last = candles.m5Candles[candles.m5Candles.length - 2];

        const m5Signal = this.greenRedCandlePattern(m5Prev, m5Last);
        if (!m5Signal) {
            return { signal: null, reason: "no_pattern", context: { last: m5Last, prev: m5Prev } };
        }

        const m5Trend = this.pickTrend(m5);
        const m15Trend = this.pickTrend(m15);
        const trendsAligned = m5Trend === m15Trend && (m5Trend === "bullish" || m5Trend === "bearish");

        // if (!trendsAligned) {
        //     return { signal: null, reason: "trend_not_aligned", context: { last: m5Last, prev: m5Prev, m5Trend, m15Trend } };
        // }

        // if (m5Signal !== m5Trend) {
        //     return { signal: null, reason: "pattern_vs_trend_mismatch", context: { last: m5Last, prev: m5Prev, m5Signal, m5Trend, m15Trend } };
        // }

        const signal = m5Trend === "bullish" ? "BUY" : "SELL";

        const m15Rsi = m15.rsi;
        const m15Pb = m15.bb.pb;
        console.log(m15Rsi, m15Pb);

        const buyQualityOk = m15Rsi <= 55 && m15Pb <= 0.7;
        const sellQualityOk = m15Rsi >= 45 && m15Pb >= 0.3;

        if (signal === "BUY" && !buyQualityOk) {
            return { signal: null, reason: "blocked_m15_quality_buy", context: { m15Rsi, m15Pb } };
        }
        if (signal === "SELL" && !sellQualityOk) {
            return { signal: null, reason: "blocked_m15_quality_sell", context: { m15Rsi, m15Pb } };
        }

        return { signal, reason: "green_red_pattern", context: { last: m5Last, prev: m5Prev, m15Rsi, m15Pb } };
    }

    greenRedCandlePattern(prev, last) {
        console.log(`Prev: ${prev.close}, Last: ${prev.close}`);

        if (!prev || !last) return false;

        const isBull = (c) => c.close > c.open;
        const isBear = (c) => c.close < c.open;

        // --- Candle body strength check ---
        // const body = Math.abs(last.close - last.open);
        // const range = last.high - last.low;
        // const strong = range > 0 && body / range >= 0.3;

        // if (isBear(prev) && isBull(last) && strong) return "bullish";
        // if (isBull(prev) && isBear(last) && strong) return "bearish";

        if (isBear(prev) && isBull(last)) return "bullish";
        if (isBull(prev) && isBear(last)) return "bearish";

        return false;
    }

    pickTrend(indicator) {
        const { ema20, ema50, trend } = indicator;

        if (ema20 > ema50) return "bullish";
        if (ema20 < ema50) return "bearish";
        if (trend === "bullish" || trend === "bearish") return trend;

        return "neutral";
    }
}

export default new Strategy();
