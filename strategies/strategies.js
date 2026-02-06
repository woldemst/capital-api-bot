class Strategy {
    constructor() {}

    generateSignal({ indicators, bid, ask }) {
        if (!indicators) {
            return { signal: null, reason: "no_indicators", context: {} };
        }

        const { d1, h4, h1, m15, m5, m1 } = indicators;

        const trend = this.trendBias(h1, h4);
        const d1Trend = this.pickTrend(d1);
        const h4Trend = this.pickTrend(h4);
        const h1Trend = this.pickTrend(h1);
        const m15Trend = this.pickTrend(m15);
        const m5Trend = this.pickTrend(m5);

        const h1Rsi = this.rsi(h1);
        const m15Rsi = this.rsi(m15);
        const m5Rsi = this.rsi(m5);
        const m1Rsi = this.rsi(m1);

        const h1Adx = this.adx(h1);
        const m15Adx = this.adx(m15);

        const m5Pullback = this.priceVsEma9(m5);

        const h1Bb = h1?.bb?.pb;
        const m15Bb = m15?.bb?.pb;
        const m5Bb = m5?.bb?.pb;
        const m1Bb = m1?.bb?.pb;

        const m15Macd = this.macdHist(m15);
        const m5Macd = this.macdHist(m5);

        const slowH4 = this.slowTrend(h4);
        const h4Macd = this.macdHist(h4);
        const h1Ema9 = h1?.ema9;
        const h1Ema21 = h1?.ema21;
        const h1EmaValid = this.isNumber(h1Ema9) && this.isNumber(h1Ema21);
        const h1EmaBull = h1EmaValid && h1Ema9 > h1Ema21;
        const h1EmaBear = h1EmaValid && h1Ema9 < h1Ema21;

        const momentumUp = this.allNumbers(m15Macd, m5Macd) && m15Macd > 0 && m5Macd > 0;
        const momentumDown = this.allNumbers(m15Macd, m5Macd) && m15Macd < 0 && m5Macd < 0;

        const scoreRule = (name, conditions) => {
            const passed = conditions.filter(Boolean).length;
            const total = conditions.length;
            const matched = passed === total;
            console.log(`${name}: ${passed}/${total}`, matched);
            return matched;
        };

        const isOverboughtSpikeSell = scoreRule("SPIKE SELL", [
            this.isNumber(m15Rsi),
            this.isNumber(m15Rsi) && m15Rsi >= 75,
            this.isNumber(m15Bb),
            this.isNumber(m15Bb) && m15Bb >= 0.9,
            this.isNumber(m5Rsi),
            this.isNumber(m5Rsi) && m5Rsi >= 70,
            this.isNumber(m5Bb),
            this.isNumber(m5Bb) && m5Bb >= 0.8,
            this.isNumber(m15Adx),
            this.isNumber(m15Adx) && m15Adx >= 25,
            d1Trend === "bearish" || (this.isNumber(h1Bb) && h1Bb >= 1.05),
            this.allNumbers(m15Macd, m5Macd),
            this.allNumbers(m15Macd, m5Macd) && (m15Macd < 0 || m5Macd < 0),
        ]);

        const isCountertrendContinuationBuy = scoreRule("COUNTERTREND CONT BUY", [
            d1Trend === "bearish",
            h4Trend === "bearish",
            h1Trend === "bullish",
            m15Trend === "bullish",
            m5Trend === "bearish",
            this.isNumber(m15Macd),
            this.isNumber(m15Macd) && m15Macd <= 0,
            this.isNumber(m5Macd),
            this.isNumber(m5Macd) && m5Macd <= 0,
            this.isNumber(m5Pullback),
            this.isNumber(m5Pullback) && Math.abs(m5Pullback) <= 0.0002,
            this.isNumber(m1Bb),
            this.isNumber(m1Bb) && m1Bb <= 0.9,
        ]);

        const isPullbackFadeSell = scoreRule("PULLBACK FADE SELL", [
            m15Trend === "bearish",
            m5Trend === "bearish",
            this.isNumber(m15Macd),
            this.isNumber(m15Macd) && m15Macd < 0,
            this.isNumber(m5Macd),
            this.isNumber(m5Macd) && m5Macd > 0,
            this.isNumber(m5Pullback),
            this.isNumber(m5Pullback) && m5Pullback > 0,
            this.isNumber(m5Pullback) && m5Pullback <= 0.00035,
            this.isNumber(m15Adx),
            this.isNumber(m15Adx) && m15Adx <= 30,
            this.isNumber(m1Rsi),
            this.isNumber(m1Rsi) && m1Rsi >= 65,
            this.isNumber(m1Bb),
            this.isNumber(m1Bb) && m1Bb >= 0.9,
        ]);

        const isPullbackBounceBuy = scoreRule("PULLBACK BOUNCE BUY", [
            trend === "bearish",
            m15Trend === "bearish",
            m5Trend === "bearish",
            this.isNumber(m15Macd),
            this.isNumber(m15Macd) && m15Macd > 0,
            this.isNumber(m5Macd),
            this.isNumber(m5Macd) && m5Macd > 0,
            this.isNumber(m5Pullback),
            this.isNumber(m5Pullback) && m5Pullback >= 0,
            this.isNumber(m1Rsi),
            this.isNumber(m1Rsi) && m1Rsi <= 65,
            this.isNumber(m1Bb),
            this.isNumber(m1Bb) && m1Bb <= 0.85,
        ]);

        const isCounterTrendBuy = scoreRule("COUNTERTREND BUY", [
            trend === "bearish",
            this.isNumber(m5Pullback),
            this.isNumber(m5Pullback) && m5Pullback <= 0,
            momentumUp,
            !this.isNumber(h1Rsi) || h1Rsi <= 50,
        ]);

        const isCounterTrendSell = scoreRule("COUNTERTREND SELL", [
            trend === "bullish",
            this.isNumber(m5Pullback),
            this.isNumber(m5Pullback) && m5Pullback >= 0,
            momentumDown,
        ]);

        const isTrendBuy = scoreRule("TREND BUY", [
            trend === "bullish",
            this.isNumber(m5Pullback),
            this.isNumber(m5Pullback) && m5Pullback <= 0,
            momentumUp,
            !this.isNumber(h1Rsi) || h1Rsi <= 55,
            !this.isNumber(m15Rsi) || m15Rsi <= 60,
        ]);

        const isTrendSell = scoreRule("TREND SELL", [
            trend === "bearish",
            this.isNumber(m5Pullback),
            this.isNumber(m5Pullback) && m5Pullback >= 0,
            momentumDown,
        ]);

        const isLegacyBuy = scoreRule("LEGACY BUY", [
            slowH4 === "bullish",
            this.isNumber(h4Macd),
            this.isNumber(h4Macd) && h4Macd > 0,
            h1EmaBull,
            m15?.isBullishCross || (this.isNumber(m15Rsi) && m15Rsi < 30) || this.bbTouchLower(m15, bid),
            this.isNumber(m5Pullback),
            this.isNumber(m5Pullback) && m5Pullback <= 0,
            !this.isNumber(h1Rsi) || h1Rsi < 45,
        ]);

        const isLegacySell = scoreRule("LEGACY SELL", [
            slowH4 === "bearish",
            this.isNumber(h4Macd),
            this.isNumber(h4Macd) && h4Macd < 0,
            h1EmaBear,
            m15?.isBearishCross || (this.isNumber(m15Rsi) && m15Rsi > 70) || this.bbTouchUpper(m15, ask),
            this.isNumber(m5Pullback),
            this.isNumber(m5Pullback) && m5Pullback >= 0,
            !this.isNumber(h1Rsi) || h1Rsi > 55,
        ]);

        const trendFilterSignal = trend === "bullish" ? "BUY" : trend === "bearish" ? "SELL" : null;
        const m15FilterSignal = m15Trend === "bullish" ? "BUY" : m15Trend === "bearish" ? "SELL" : null;

        if (!trendFilterSignal) {
            return { signal: null, reason: "trend_filter_neutral", context: { h1Trend, h4Trend } };
        }

        if (!m15FilterSignal) {
            return { signal: null, reason: "m15_trend_neutral", context: { m15Trend } };
        }

        const rules = [
            {
                reason: "overbought_spike",
                signal: "SELL",
                when: isOverboughtSpikeSell,
                buyScore: 0,
                sellScore: 1,
                context: { d1Trend, h1Bb, m15Rsi, m15Bb, m5Rsi, m5Bb, m15Adx },
            },
            {
                reason: "countertrend_continuation",
                signal: "BUY",
                when: isCountertrendContinuationBuy,
                buyScore: 1,
                sellScore: 0,
                context: { d1Trend, m15Trend, m5Trend, m5Pullback, m15Macd, m5Macd, m1Bb },
            },
            {
                reason: "pullback_bounce",
                signal: "BUY",
                when: isPullbackBounceBuy,
                buyScore: 1,
                sellScore: 0,
                context: { trend, m15Trend, m5Trend, m5Pullback, m1Rsi, m1Bb, m15Macd, m5Macd },
            },
            {
                reason: "pullback_fade",
                signal: "SELL",
                when: isPullbackFadeSell,
                buyScore: 0,
                sellScore: 1,
                context: { trend, m15Trend, m5Trend, m5Pullback, m1Rsi, m1Bb, m15Macd, m5Macd },
            },
            {
                reason: "countertrend_pullback",
                signal: "BUY",
                when: isCounterTrendBuy,
                buyScore: 1,
                sellScore: 0,
                context: { trend, m5Pullback },
            },
            {
                reason: "countertrend_pullback",
                signal: "SELL",
                when: isCounterTrendSell,
                buyScore: 0,
                sellScore: 1,
                context: { trend, m5Pullback },
            },
            {
                reason: "trend_pullback",
                signal: "BUY",
                when: isTrendBuy,
                context: { trend, m5Pullback },
            },
            {
                reason: "trend_pullback",
                signal: "SELL",
                when: isTrendSell,
                context: { trend, m5Pullback },
            },
            {
                reason: "legacy_smooth",
                signal: "BUY",
                when: isLegacyBuy,
                context: { slowH4, h4Macd, h1Rsi, m15Rsi },
            },
            {
                reason: "legacy_smooth",
                signal: "SELL",
                when: isLegacySell,
                context: { slowH4, h4Macd, h1Rsi, m15Rsi },
            },
        ];

        for (const rule of rules) {
            if (!rule.when) continue;
            if (trendFilterSignal && rule.signal !== trendFilterSignal) continue;
            if (m15FilterSignal && rule.signal !== m15FilterSignal) continue;
            const payload = { signal: rule.signal, reason: rule.reason, context: rule.context };
            if (typeof rule.buyScore === "number") payload.buyScore = rule.buyScore;
            if (typeof rule.sellScore === "number") payload.sellScore = rule.sellScore;
            return payload;
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
