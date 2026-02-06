class Strategy {
    constructor() {}

    generateSignal({ indicators, bid, ask }) {
        if (!indicators) {
            return { signal: null, reason: "no_indicators", context: {} };
        }

        const { d1, h4, h1, m15, m5, m1 } = indicators;
        const d1Trend = this.pickTrend(d1);
        const h4Trend = this.pickTrend(h4);
        const h1Trend = this.pickTrend(h1);
        const m15Trend = this.pickTrend(m15);
        const m5Trend = this.pickTrend(m5);

        const h1Rsi = this.rsi(h1);
        const m15Rsi = this.rsi(m15);
        const m5Rsi = this.rsi(m5);
        const m1Rsi = this.rsi(m1);

        const m15Adx = this.adx(m15);

        const m5Pullback = this.priceVsEma9(m5);

        const m15Bb = m15?.bb?.pb;
        const m5Bb = m5?.bb?.pb;
        const m1Bb = m1?.bb?.pb;

        const m15Macd = this.macdHist(m15);
        const m5Macd = this.macdHist(m5);

        const momentumUp = this.allNumbers(m15Macd, m5Macd) && (m15Macd > 0 || m5Macd > 0);
        const momentumDown = this.allNumbers(m15Macd, m5Macd) && (m15Macd < 0 || m5Macd < 0);

        const isTrendPullbackBuy =
            h1Trend === "bullish" &&
            this.isNumber(m5Pullback) &&
            m5Pullback <= 0 &&
            this.isNumber(m15Rsi) &&
            m15Rsi >= 40 &&
            m15Rsi <= 62 &&
            this.isNumber(m1Rsi) &&
            m1Rsi <= 56 &&
            this.isNumber(m5Bb) &&
            m5Bb >= 0.1 &&
            m5Bb <= 0.9 &&
            this.isNumber(m1Bb) &&
            m1Bb <= 0.92 &&
            this.isNumber(m15Adx) &&
            m15Adx >= 15 &&
            m15Adx <= 40 &&
            momentumUp;

        const isTrendPullbackSell =
            h1Trend === "bearish" &&
            this.isNumber(m5Pullback) &&
            m5Pullback >= 0 &&
            this.isNumber(m15Rsi) &&
            m15Rsi >= 48 &&
            m15Rsi <= 65 &&
            this.isNumber(m1Rsi) &&
            m1Rsi >= 55 &&
            this.isNumber(m5Bb) &&
            m5Bb <= 0.95 &&
            this.isNumber(m1Bb) &&
            m1Bb >= 0.65 &&
            this.isNumber(m15Adx) &&
            m15Adx >= 10 &&
            m15Adx <= 35 &&
            momentumDown;

        const isOverboughtSpikeSell =
            h1Trend === "bearish" &&
            this.isNumber(m15Rsi) &&
            m15Rsi >= 68 &&
            this.isNumber(m15Bb) &&
            m15Bb >= 0.85 &&
            this.isNumber(m5Rsi) &&
            m5Rsi >= 65 &&
            this.isNumber(m5Bb) &&
            m5Bb >= 0.75 &&
            this.isNumber(m15Adx) &&
            m15Adx >= 12 &&
            m15Adx <= 40 &&
            momentumDown;

        const isOversoldSpikeBuy =
            h1Trend === "bullish" &&
            this.isNumber(m15Rsi) &&
            m15Rsi <= 32 &&
            this.isNumber(m15Bb) &&
            m15Bb <= 0.15 &&
            this.isNumber(m5Rsi) &&
            m5Rsi <= 35 &&
            this.isNumber(m5Bb) &&
            m5Bb <= 0.25 &&
            this.isNumber(m15Adx) &&
            m15Adx >= 12 &&
            m15Adx <= 40 &&
            momentumUp;

        if (isOverboughtSpikeSell) {
            return {
                signal: "SELL",
                reason: "overbought_spike",
                context: { d1Trend, h1Trend, h4Trend, m15Rsi, m15Bb, m5Rsi, m5Bb, m15Adx, m15Macd, m5Macd },
            };
        }

        if (isOversoldSpikeBuy) {
            return {
                signal: "BUY",
                reason: "oversold_spike",
                context: { d1Trend, h1Trend, h4Trend, m15Rsi, m15Bb, m5Rsi, m5Bb, m15Adx, m15Macd, m5Macd },
            };
        }

        if (isTrendPullbackBuy) {
            return {
                signal: "BUY",
                reason: "trend_pullback",
                context: { d1Trend, h1Trend, h4Trend, m15Trend, m5Trend, m15Rsi, m1Rsi, m1Bb, m15Adx, m5Pullback, m15Macd, m5Macd },
            };
        }

        if (isTrendPullbackSell) {
            return {
                signal: "SELL",
                reason: "trend_pullback",
                context: { d1Trend, h1Trend, h4Trend, m15Trend, m5Trend, m15Rsi, m1Rsi, m1Bb, m15Adx, m5Pullback, m15Macd, m5Macd },
            };
        }

        return { signal: null, reason: "no_rule_match", context: { d1Trend, h1Trend, h4Trend, m15Trend, m5Trend, h1Rsi, m15Rsi, m5Rsi, m1Rsi } };
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
