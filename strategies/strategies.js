const STAGE_RULES = {
    forex: {
        biasAdxMin: 25,
        setupAdxMin: 18,
        entryAdxMin: 18,
        setupRsiSlopeTolerance: 0.5,
        buySetupRsiMin: 35,
        buySetupRsiMax: 55,
        sellSetupRsiMin: 45,
        sellSetupRsiMax: 65,
        buyEntryReclaimMax: 0.0001,
        sellEntryReclaimMin: null,
    },
    crypto: {
        biasAdxMin: 20,
        setupAdxMin: 20,
        entryAdxMin: 18,
        setupRsiSlopeTolerance: 1.2,
        buySetupRsiMin: 40,
        buySetupRsiMax: 62,
        sellSetupRsiMin: 40,
        sellSetupRsiMax: 70,
        buyEntryReclaimMax: 0.0015,
        sellEntryReclaimMin: -0.0015,
    },
};

const FOREX_SELL_SPREAD_PCT_MAX = 0.00014372884899331597;

class Strategy {
    constructor() {}

    // Only supported variant: H1_M15_M5.
    generateSignal3Stage({ indicators, variant, assetClass = "forex", market = {}, timestamp = null, sessions = [] }) {
        if (!indicators) {
            return { signal: null, reason: "no_indicators", context: {} };
        }

        const selectedAssetClass = assetClass === "crypto" ? "crypto" : "forex";
        const rules = STAGE_RULES[selectedAssetClass];

        const selectedVariant = variant === "H1_M15_M5" ? variant : "H1_M15_M5";
        const biasTF = "h1";
        const trendTF = "h4";
        const setupTF = "m15";
        const entryTF = "m5";

        const biasIndicators = indicators?.[biasTF];
        const d1Indicators = indicators?.d1;
        const trendIndicators = indicators?.[trendTF];
        const setupIndicators = indicators?.[setupTF];
        const entryIndicators = indicators?.[entryTF];

        const tsMs = Date.parse(String(timestamp || ""));
        const hourUtc = Number.isFinite(tsMs) ? new Date(tsMs).getUTCHours() : null;
        const normalizedSessions = Array.isArray(sessions) ? sessions.map((session) => String(session).toUpperCase()) : [];
        const spreadValue =
            this.isNumber(market?.spread)
                ? market.spread
                : this.isNumber(market?.ask) && this.isNumber(market?.bid)
                  ? Math.abs(market.ask - market.bid)
                  : null;
        const marketPrice =
            this.isNumber(market?.price)
                ? market.price
                : this.isNumber(market?.mid)
                  ? market.mid
                  : this.isNumber(market?.ask) && this.isNumber(market?.bid)
                    ? (market.ask + market.bid) / 2
                    : this.isNumber(market?.ask)
                      ? market.ask
                      : this.isNumber(market?.bid)
                        ? market.bid
                        : null;
        const spreadPct = this.isNumber(spreadValue) && this.isNumber(marketPrice) && marketPrice !== 0 ? spreadValue / marketPrice : null;

        const d1Trend = this.pickTrend(d1Indicators);
        const h4Trend = this.pickTrend(trendIndicators);
        const biasTrend = this.pickTrend(biasIndicators);
        const biasAdx = this.adx(biasIndicators);
        const setupPullbackValue = this.priceVsEma9(setupIndicators);
        const setupRsi = this.rsi(setupIndicators);
        const setupRsiPrev = this.rsiPrev(setupIndicators);
        const setupAdx = this.adx(setupIndicators);
        const entryMacdHist = this.macdHist(entryIndicators);
        const entryPullbackValue = this.priceVsEma9(entryIndicators);
        const entryAdx = this.adx(entryIndicators);

        const biasOk = this.isNumber(biasAdx);

        const baseContext = {
            assetClass: selectedAssetClass,
            variant: selectedVariant,
            biasTF,
            d1Trend,
            h4Trend,
            setupTF,
            entryTF,
            biasTrend,
            biasAdx,
            setupPullbackValue,
            setupRsi,
            setupRsiPrev,
            setupAdx,
            entryMacdHist,
            entryPullbackValue,
            entryAdx,
            hourUtc,
            sessions: normalizedSessions,
            spreadPct,
            gateStates: { biasOk, setupOk: false, entryOk: false },
        };

        const forexSellChecks = {
            trendAligned: d1Trend === "bearish" && h4Trend === "bearish" && biasTrend === "bearish",
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= 25,
            spreadOk: this.isNumber(spreadPct) && spreadPct <= FOREX_SELL_SPREAD_PCT_MAX,
            rsiRangeOk: this.isNumber(setupRsi) && setupRsi >= rules.sellSetupRsiMin && setupRsi <= rules.sellSetupRsiMax,
        };

        const forexBuyChecks = {
            hourOk: this.isNumber(hourUtc) && hourUtc >= 7 && hourUtc <= 15,
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= 30,
            pullbackOk: this.isNumber(setupPullbackValue) && setupPullbackValue <= 0,
            rsiRangeOk: this.isNumber(setupRsi) && setupRsi >= rules.buySetupRsiMin && setupRsi <= rules.buySetupRsiMax,
            macdOk: this.isNumber(entryMacdHist) && entryMacdHist > 0,
        };

        const cryptoSellChecks = {
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= rules.biasAdxMin,
            m15AdxOk: this.isNumber(setupAdx) && setupAdx >= rules.setupAdxMin,
            m15RsiOk: this.isNumber(setupRsi) && setupRsi >= rules.sellSetupRsiMin && setupRsi <= rules.sellSetupRsiMax,
            hourOk: this.isNumber(hourUtc) && hourUtc >= 7 && hourUtc <= 15,
            sessionOk: normalizedSessions.includes("LONDON") || normalizedSessions.includes("NY"),
        };

        const forexSellOk = Object.values(forexSellChecks).every(Boolean);
        const forexBuyOk = Object.values(forexBuyChecks).every(Boolean);
        const cryptoSellOk = Object.values(cryptoSellChecks).every(Boolean);

        let signal = null;
        let patternChecks = {};

        if (selectedAssetClass === "crypto") {
            signal = cryptoSellOk ? "SELL" : null;
            patternChecks = cryptoSellChecks;
        } else if (forexSellOk) {
            signal = "SELL";
            patternChecks = forexSellChecks;
        } else if (forexBuyOk) {
            signal = "BUY";
            patternChecks = forexBuyChecks;
        } else {
            patternChecks = { sell: forexSellChecks, buy: forexBuyChecks };
        }

        if (!signal) {
            return {
                signal: null,
                reason: "pattern_blocked",
                context: {
                    ...baseContext,
                    patternChecks,
                    gateStates: { biasOk, setupOk: false, entryOk: false },
                },
            };
        }

        return {
            signal,
            reason: "pattern_confirmed",
            context: {
                ...baseContext,
                patternChecks,
                gateStates: { biasOk, setupOk: true, entryOk: true },
            },
        };
    }

    generateSignal3StageForex({ indicators, variant, market, timestamp, sessions }) {
        return this.generateSignal3Stage({ indicators, variant, assetClass: "forex", market, timestamp, sessions });
    }

    generateSignal3StageCrypto({ indicators, variant = "H1_M15_M5", market, timestamp, sessions }) {
        return this.generateSignal3Stage({ indicators, variant, assetClass: "crypto", market, timestamp, sessions });
    }

    isNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    rsi(indicators) {
        const rsi = indicators?.rsi;
        return this.isNumber(rsi) ? rsi : null;
    }

    rsiPrev(indicators) {
        const rsiPrev = indicators?.rsiPrev;
        return this.isNumber(rsiPrev) ? rsiPrev : null;
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
