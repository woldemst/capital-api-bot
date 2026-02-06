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
        const momentumDown = this.allNumbers(m15Macd, m5Macd) && m15Macd < 0 && m5Macd < 0;

        const buyTrendAligned = this.countTrendVotes([d1Trend, h4Trend, h1Trend], "bullish") >= 2;
        const sellTrendAligned = h1Trend === "bearish";

        const buyChecks = {
            pullback: this.isNumber(m5Pullback) && m5Pullback <= 0,
            rsiBand: this.isNumber(m15Rsi) && m15Rsi >= 42 && m15Rsi <= 55,
            microRsi: this.isNumber(m1Rsi) && m1Rsi <= 52,
            bbBand: this.isNumber(m5Bb) && m5Bb >= 0.2 && m5Bb <= 0.8,
            microBb: this.isNumber(m1Bb) && m1Bb <= 0.9,
            adxBand: this.isNumber(m15Adx) && m15Adx >= 8 && m15Adx <= 28,
            momentum: momentumUp,
        };

        const sellChecks = {
            pullback: this.isNumber(m5Pullback) && m5Pullback >= -0.0001,
            rsiBand: this.isNumber(m15Rsi) && m15Rsi >= 42 && m15Rsi <= 55,
            microRsi: this.isNumber(m1Rsi) && m1Rsi >= 48,
            bbBand: this.isNumber(m5Bb) && m5Bb >= 0.35 && m5Bb <= 0.75,
            microBb: this.isNumber(m1Bb) && m1Bb >= 0.55,
            adxBand: this.isNumber(m15Adx) && m15Adx >= 10 && m15Adx <= 28,
            momentum: momentumDown,
        };

        const buyScore = this.scoreChecks(buyChecks);
        const sellScore = this.scoreChecks(sellChecks);

        const BUY_SCORE_THRESHOLD = 5;
        const SELL_SCORE_THRESHOLD = 5;

        if (buyTrendAligned && buyScore >= BUY_SCORE_THRESHOLD) {
            return {
                signal: "BUY",
                reason: "trend_pullback",
                context: {
                    d1Trend,
                    h1Trend,
                    h4Trend,
                    m15Trend,
                    m5Trend,
                    buyTrendAligned,
                    buyScore,
                    buyChecks,
                    m15Rsi,
                    m1Rsi,
                    m1Bb,
                    m15Adx,
                    m5Pullback,
                    m15Macd,
                    m5Macd,
                },
            };
        }

        if (sellTrendAligned && sellScore >= SELL_SCORE_THRESHOLD) {
            return {
                signal: "SELL",
                reason: "trend_pullback",
                context: {
                    d1Trend,
                    h1Trend,
                    h4Trend,
                    m15Trend,
                    m5Trend,
                    sellTrendAligned,
                    sellScore,
                    sellChecks,
                    m15Rsi,
                    m1Rsi,
                    m1Bb,
                    m15Adx,
                    m5Pullback,
                    m15Macd,
                    m5Macd,
                },
            };
        }

        return {
            signal: null,
            reason: "score_below_threshold",
            context: {
                d1Trend,
                h1Trend,
                h4Trend,
                m15Trend,
                m5Trend,
                buyTrendAligned,
                sellTrendAligned,
                h1Rsi,
                m15Rsi,
                m5Rsi,
                m1Rsi,
                m15Bb,
                m5Bb,
                m1Bb,
                m15Adx,
                buyScore,
                sellScore,
            },
        };
    }

    isNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    allNumbers(...values) {
        return values.every((value) => this.isNumber(value));
    }

    countTrendVotes(trends, side) {
        if (!Array.isArray(trends)) return 0;
        return trends.reduce((count, trend) => count + (trend === side ? 1 : 0), 0);
    }

    scoreChecks(checks) {
        if (!checks || typeof checks !== "object") return 0;
        return Object.values(checks).reduce((score, passed) => score + (passed ? 1 : 0), 0);
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
