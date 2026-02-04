class Strategy {
    constructor() {}

    generateSignal({ indicators }) {
        if (!indicators) {
            return { signal: null, buyScore: 0, sellScore: 0, reason: "no_indicators", context: {} };
        }

        const { h4, h1, m15, m5, m1 } = indicators;
        const trend = this.trendBias(h1, h4);

        const h1Rsi = this.rsi(h1);
        const h1Adx = this.adx(h1);
        const m15Adx = this.adx(m15);
        const m5Pullback = this.priceVsEma9(m5);
        const m15Bb = m15?.bb?.pb;
        const m1Bb = m1?.bb?.pb;
        const m1Rsi = this.rsi(m1);

        const m15Macd = this.macdHist(m15);
        const m5Macd = this.macdHist(m5);
        const m1Macd = this.macdHist(m1);

        const momentumUp = this.allNumbers(m15Macd, m5Macd) && m15Macd > 0 && m5Macd > 0;
        const momentumDown = this.allNumbers(m15Macd, m5Macd) && m15Macd < 0 && m5Macd < 0;

        const range =
            (this.isNumber(h1Adx) && h1Adx <= 13.5) || (this.isNumber(m15Adx) && m15Adx <= 16);
        const oversold = this.isNumber(h1Rsi) && h1Rsi <= 43;
        const overbought = this.isNumber(h1Rsi) && h1Rsi >= 57;

        const trendBuy =
            trend === "bullish" &&
            this.isNumber(m5Pullback) &&
            m5Pullback <= 0 &&
            momentumUp;

        const trendSell =
            trend === "bearish" &&
            this.isNumber(m5Pullback) &&
            m5Pullback >= 0 &&
            momentumDown;

        const rangeBuy = range && oversold && momentumUp;
        const rangeSell = range && overbought && momentumDown;

        const spikeSell =
            trend === "bearish" &&
            range &&
            this.isNumber(m15Bb) &&
            m15Bb >= 0.7 &&
            this.isNumber(m1Bb) &&
            m1Bb >= 0.95 &&
            this.isNumber(m1Rsi) &&
            m1Rsi >= 58 &&
            this.isNumber(m1Macd) &&
            this.isNumber(m5Macd) &&
            m1Macd > 0 &&
            m5Macd > 0;

        if (spikeSell) {
            return {
                signal: "sell",
                buyScore: 0,
                sellScore: 1,
                reason: "spike_fade",
                context: { trend, h1Rsi, h1Adx, m15Bb, m1Bb, m1Rsi },
            };
        }

        if (rangeBuy) {
            return {
                signal: "buy",
                buyScore: 1,
                sellScore: 0,
                reason: "range_reversal",
                context: { trend, h1Rsi, h1Adx, momentum: "up" },
            };
        }

        if (rangeSell) {
            return {
                signal: "sell",
                buyScore: 0,
                sellScore: 1,
                reason: "range_reversal",
                context: { trend, h1Rsi, h1Adx, momentum: "down" },
            };
        }

        if (trendBuy) {
            return {
                signal: "buy",
                buyScore: 1,
                sellScore: 0,
                reason: "trend_pullback",
                context: { trend, m5Pullback },
            };
        }

        if (trendSell) {
            return {
                signal: "sell",
                buyScore: 0,
                sellScore: 1,
                reason: "trend_pullback",
                context: { trend, m5Pullback },
            };
        }

        return { signal: null, buyScore: 0, sellScore: 0, reason: "no_rule_match", context: { trend, h1Rsi, h1Adx, m15Adx } };
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
}

export default new Strategy();
