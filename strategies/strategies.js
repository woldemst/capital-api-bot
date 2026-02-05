class Strategy {
    constructor() {}

    generateSignal({ indicators, bid, ask }) {
        if (!indicators) {
            return { signal: null, reason: "no_indicators", context: {} };
        }

        const { d1, h4, h1, m15, m5, m1 } = indicators;
        const trend = this.trendBias(h1, h4);

        const h1Rsi = this.rsi(h1);
        const h1Adx = this.adx(h1);
        const m15Adx = this.adx(m15);
        const m5Pullback = this.priceVsEma9(m5);
        const m1Rsi = this.rsi(m1);
        const m1Bb = m1?.bb?.pb;
        const m15Rsi = this.rsi(m15);
        const m5Rsi = this.rsi(m5);
        const m15Bb = m15?.bb?.pb;
        const m5Bb = m5?.bb?.pb;
        const h1Bb = h1?.bb?.pb;
        const m15Trend = this.pickTrend(m15);
        const m5Trend = this.pickTrend(m5);
        const d1Trend = this.pickTrend(d1);

        const m15Macd = this.macdHist(m15);
        const m5Macd = this.macdHist(m5);

        const slowH4 = this.slowTrend(h4);
        const h4Macd = this.macdHist(h4);
        const h1EmaBull = this.isNumber(h1?.ema9) && this.isNumber(h1?.ema21) && h1.ema9 > h1.ema21;
        const h1EmaBear = this.isNumber(h1?.ema9) && this.isNumber(h1?.ema21) && h1.ema9 < h1.ema21;

        const momentumUp = this.allNumbers(m15Macd, m5Macd) && m15Macd > 0 && m5Macd > 0;
        const momentumDown = this.allNumbers(m15Macd, m5Macd) && m15Macd < 0 && m5Macd < 0;

        const overboughtSpikeSell =
            this.isNumber(m15Rsi) &&
            m15Rsi >= 75 &&
            this.isNumber(m15Bb) &&
            m15Bb >= 0.9 &&
            this.isNumber(m5Rsi) &&
            m5Rsi >= 70 &&
            this.isNumber(m5Bb) &&
            m5Bb >= 0.8 &&
            this.isNumber(m15Adx) &&
            m15Adx >= 25 &&
            (d1Trend === "bearish" || (this.isNumber(h1Bb) && h1Bb >= 1.05));

        const countertrendContinuationBuy =
            d1Trend === "bearish" &&
            this.pickTrend(h4) === "bearish" &&
            this.pickTrend(h1) === "bullish" &&
            m15Trend === "bullish" &&
            m5Trend === "bearish" &&
            this.isNumber(m15Macd) &&
            m15Macd <= 0 &&
            this.isNumber(m5Macd) &&
            m5Macd <= 0 &&
            this.isNumber(m5Pullback) &&
            Math.abs(m5Pullback) <= 0.0002 &&
            this.isNumber(m1Bb) &&
            m1Bb <= 0.9;

        const pullbackFadeSell =
            m15Trend === "bearish" &&
            m5Trend === "bearish" &&
            this.isNumber(m15Macd) &&
            m15Macd < 0 &&
            this.isNumber(m5Macd) &&
            m5Macd > 0 &&
            this.isNumber(m5Pullback) &&
            m5Pullback > 0 &&
            this.isNumber(m1Rsi) &&
            m1Rsi >= 60 &&
            this.isNumber(m1Bb) &&
            m1Bb >= 0.8;

        if (overboughtSpikeSell) {
            return {
                signal: "SELL",
                buyScore: 0,
                sellScore: 1,
                reason: "overbought_spike",
                context: { d1Trend, h1Bb, m15Rsi, m15Bb, m5Rsi, m5Bb, m15Adx },
            };
        }

        if (countertrendContinuationBuy) {
            return {
                signal: "BUY",
                buyScore: 1,
                sellScore: 0,
                reason: "countertrend_continuation",
                context: { d1Trend, m15Trend, m5Trend, m5Pullback, m15Macd, m5Macd, m1Bb },
            };
        }

        const pullbackBounceBuy =
            trend === "bearish" &&
            m15Trend === "bearish" &&
            m5Trend === "bearish" &&
            this.isNumber(m15Macd) &&
            m15Macd > 0 &&
            this.isNumber(m5Macd) &&
            m5Macd > 0 &&
            this.isNumber(m5Pullback) &&
            m5Pullback >= 0 &&
            this.isNumber(m1Rsi) &&
            m1Rsi <= 60 &&
            this.isNumber(m1Bb) &&
            m1Bb <= 0.7;

        if (pullbackBounceBuy) {
            return {
                signal: "BUY",
                buyScore: 1,
                sellScore: 0,
                reason: "pullback_bounce",
                context: { trend, m15Trend, m5Trend, m5Pullback, m1Rsi, m1Bb, m15Macd, m5Macd },
            };
        }

        if (pullbackFadeSell) {
            return {
                signal: "SELL",
                buyScore: 0,
                sellScore: 1,
                reason: "pullback_fade",
                context: { trend, m15Trend, m5Trend, m5Pullback, m1Rsi, m1Bb, m15Macd, m5Macd },
            };
        }

        const counterTrendBuy = trend === "bearish" && this.isNumber(m5Pullback) && m5Pullback <= 0 && momentumUp;

        const counterTrendSell = trend === "bullish" && this.isNumber(m5Pullback) && m5Pullback >= 0 && momentumDown;

        if (counterTrendBuy) {
            return {
                signal: "BUY",
                buyScore: 1,
                sellScore: 0,
                reason: "countertrend_pullback",
                context: { trend, m5Pullback },
            };
        }

        if (counterTrendSell) {
            return {
                signal: "SELL",
                buyScore: 0,
                sellScore: 1,
                reason: "countertrend_pullback",
                context: { trend, m5Pullback },
            };
        }

        const trendBuy = trend === "bullish" && this.isNumber(m5Pullback) && m5Pullback <= 0 && momentumUp;

        const trendSell = trend === "bearish" && this.isNumber(m5Pullback) && m5Pullback >= 0 && momentumDown;

        if (trendBuy) {
            return {
                signal: "BUY",
                reason: "trend_pullback",
                context: { trend, m5Pullback },
            };
        }

        if (trendSell) {
            return {
                signal: "SELL",
                reason: "trend_pullback",
                context: { trend, m5Pullback },
            };
        }

        const legacyBuy =
            slowH4 === "bullish" &&
            this.isNumber(h4Macd) &&
            h4Macd > 0 &&
            h1EmaBull &&
            (m15?.isBullishCross || (this.isNumber(m15Rsi) && m15Rsi < 30) || this.bbTouchLower(m15, bid)) &&
            (!this.isNumber(h1Rsi) || h1Rsi < 35);

        const legacySell =
            slowH4 === "bearish" &&
            this.isNumber(h4Macd) &&
            h4Macd < 0 &&
            h1EmaBear &&
            (m15?.isBearishCross || (this.isNumber(m15Rsi) && m15Rsi > 70) || this.bbTouchUpper(m15, ask)) &&
            (!this.isNumber(h1Rsi) || h1Rsi > 65);

        if (legacyBuy) {
            return { signal: "BUY", reason: "legacy_smooth", context: { slowH4, h4Macd, h1Rsi, m15Rsi } };
        }

        if (legacySell) {
            return { signal: "SELL", reason: "legacy_smooth", context: { slowH4, h4Macd, h1Rsi, m15Rsi } };
        }

        return { signal: null, reason: "no_rule_match", context: { trend, h1Rsi, h1Adx, m15Adx } };
    }

    isNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    allNumbers(...values) {
        return values.every((value) => this.isNumber(value));
    }

    rsi(indicators) {
        const rsi = indicators?.rsi;
        return this.isNumber(rsi) ? rsi : null;
    }

    adx(indicators) {
        const adx = indicators?.adx;
        if (this.isNumber(adx)) return adx;
        if (adx && this.isNumber(adx.adx)) return adx.adx;
        return null;
    }

    macdHist(indicators) {
        const hist = indicators?.macd?.histogram;
        return this.isNumber(hist) ? hist : null;
    }

    priceVsEma9(indicators) {
        const direct = indicators?.price_vs_ema9;
        if (this.isNumber(direct)) return direct;
        const price = indicators?.close ?? indicators?.lastClose;
        const ema9 = indicators?.ema9;
        if (this.isNumber(price) && this.isNumber(ema9) && ema9 !== 0) return (price - ema9) / ema9;
        return null;
    }

    trendBias(h1, h4) {
        const h1Trend = this.pickTrend(h1);
        const h4Trend = this.pickTrend(h4);
        if (h1Trend === h4Trend) return h1Trend;
        if (h1Trend === "neutral") return h4Trend;
        if (h4Trend === "neutral") return h1Trend;
        return "neutral";
    }

    pickTrend(indicator) {
        if (!indicator || typeof indicator !== "object") return "neutral";
        const { ema20, ema50, trend } = indicator;

        if (ema20 > ema50) return "bullish";
        if (ema20 < ema50) return "bearish";
        if (trend === "bullish" || trend === "bearish") return trend;

        return "neutral";
    }

    slowTrend(ind) {
        const fast = this.isNumber(ind?.emaFastTrend) ? ind.emaFastTrend : ind?.emaFast;
        const slow = this.isNumber(ind?.emaSlowTrend) ? ind.emaSlowTrend : ind?.emaSlow;
        if (this.isNumber(fast) && this.isNumber(slow)) {
            if (fast > slow) return "bullish";
            if (fast < slow) return "bearish";
        }
        return "neutral";
    }

    bbTouchLower(ind, bid) {
        const lower = ind?.bb?.lower;
        return this.isNumber(lower) && this.isNumber(bid) && bid <= lower;
    }

    bbTouchUpper(ind, ask) {
        const upper = ind?.bb?.upper;
        return this.isNumber(upper) && this.isNumber(ask) && ask >= upper;
    }
}

export default new Strategy();
