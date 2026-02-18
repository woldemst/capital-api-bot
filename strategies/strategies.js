const STAGE_RULES = {
    forex: {
        blockedSymbols: ["GBPUSD", "NZDUSD"],
        blockedHoursUtc: [14],
        buyH1AdxMin: 25,
        buyM15AdxMin: 25,
        buySetupRsiMin: 40,
        buySetupRsiMax: 55,
        buyPullbackMax: 0.001,
        buyMacdHistMin: 0,
        sellH1AdxMin: 25,
        sellM15AdxMin: 15,
        sellSetupRsiMin: 45,
        sellSetupRsiMax: 55,
        sellPullbackMin: -0.002,
        sellMacdHistMax: -0.002,
        spreadPctMax: 0.00025,
    },
    crypto: {
        enabled: true,
        blockedSymbols: ["BTCEUR", "SOLUSD", "ADAUSD"],
        buyH1AdxMin: 18,
        buyM15AdxMin: 5,
        buySetupRsiMin: 45,
        buySetupRsiMax: 62,
        buyPullbackMax: 0.003,
        buyMacdHistMin: -0.005,
        buyHourStartUtc: 0,
        buyHourEndUtc: 21,
        sellH1AdxMin: 18,
        sellM15AdxMin: 15,
        sellSetupRsiMin: 42,
        sellSetupRsiMax: 60,
        sellPullbackMin: -0.006,
        sellHourStartUtc: 0,
        sellHourEndUtc: 21,
        sellMacdHistMax: 0.01,
        spreadPctMax: 0.006,
        allowedSessions: ["CRYPTO"],
    },
};

class Strategy {
    constructor() {}

    // Only supported variant: H1_M15_M5.
    generateSignal3Stage({ symbol = "", indicators, variant, assetClass = "forex", market = {}, timestamp = null, sessions = [] }) {
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
            symbol: String(symbol || "").toUpperCase(),
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

        if (selectedAssetClass === "forex") {
            const normalizedSymbol = String(symbol || "").toUpperCase();
            const blockedSymbols = Array.isArray(rules.blockedSymbols) ? rules.blockedSymbols : [];
            const blockedHoursUtc = Array.isArray(rules.blockedHoursUtc) ? rules.blockedHoursUtc : [];
            if (blockedSymbols.includes(normalizedSymbol)) {
                return {
                    signal: null,
                    reason: "symbol_blocked",
                    context: {
                        ...baseContext,
                        patternChecks: { symbolAllowed: false },
                        gateStates: { biasOk, setupOk: false, entryOk: false },
                    },
                };
            }
            if (this.isNumber(hourUtc) && blockedHoursUtc.includes(hourUtc)) {
                return {
                    signal: null,
                    reason: "hour_blocked",
                    context: {
                        ...baseContext,
                        patternChecks: { hourAllowed: false },
                        gateStates: { biasOk, setupOk: false, entryOk: false },
                    },
                };
            }
        }

        if (selectedAssetClass === "crypto" && !rules.enabled) {
            return {
                signal: null,
                reason: "crypto_disabled",
                context: {
                    ...baseContext,
                    patternChecks: { cryptoEnabled: false },
                    gateStates: { biasOk, setupOk: false, entryOk: false },
                },
            };
        }
        if (selectedAssetClass === "crypto") {
            const normalizedSymbol = String(symbol || "").toUpperCase();
            const blockedSymbols = Array.isArray(rules.blockedSymbols) ? rules.blockedSymbols : [];
            if (blockedSymbols.includes(normalizedSymbol)) {
                return {
                    signal: null,
                    reason: "symbol_blocked",
                    context: {
                        ...baseContext,
                        patternChecks: { symbolAllowed: false },
                        gateStates: { biasOk, setupOk: false, entryOk: false },
                    },
                };
            }
        }

        const forexSellChecks = {
            trendAligned: true,
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= rules.sellH1AdxMin,
            m15AdxOk: this.isNumber(setupAdx) && setupAdx >= rules.sellM15AdxMin,
            spreadOk: this.isNumber(spreadPct) && spreadPct <= rules.spreadPctMax,
            rsiRangeOk: this.isNumber(setupRsi) && setupRsi >= rules.sellSetupRsiMin && setupRsi <= rules.sellSetupRsiMax,
            pullbackOk: this.isNumber(setupPullbackValue) && setupPullbackValue >= rules.sellPullbackMin,
            macdOk: this.isNumber(entryMacdHist) && entryMacdHist <= rules.sellMacdHistMax,
        };

        const forexBuyChecks = {
            trendAligned: true,
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= rules.buyH1AdxMin,
            m15AdxOk: this.isNumber(setupAdx) && setupAdx >= rules.buyM15AdxMin,
            spreadOk: this.isNumber(spreadPct) && spreadPct <= rules.spreadPctMax,
            pullbackOk: this.isNumber(setupPullbackValue) && setupPullbackValue <= rules.buyPullbackMax,
            rsiRangeOk: this.isNumber(setupRsi) && setupRsi >= rules.buySetupRsiMin && setupRsi <= rules.buySetupRsiMax,
            macdOk: this.isNumber(entryMacdHist) && entryMacdHist >= rules.buyMacdHistMin,
        };

        const cryptoAllowedSessions =
            Array.isArray(rules.allowedSessions) && rules.allowedSessions.length
                ? rules.allowedSessions.map((session) => String(session).toUpperCase())
                : ["CRYPTO"];
        const cryptoSessionOk = normalizedSessions.some((session) => cryptoAllowedSessions.includes(session));
        const cryptoSellChecks = {
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= rules.sellH1AdxMin,
            m15AdxOk: this.isNumber(setupAdx) && setupAdx >= rules.sellM15AdxMin,
            m15RsiOk: this.isNumber(setupRsi) && setupRsi >= rules.sellSetupRsiMin && setupRsi <= rules.sellSetupRsiMax,
            pullbackOk: this.isNumber(setupPullbackValue) && setupPullbackValue >= rules.sellPullbackMin,
            m5MacdOk: this.isNumber(entryMacdHist) && entryMacdHist <= rules.sellMacdHistMax,
            spreadOk: this.isNumber(spreadPct) && spreadPct <= rules.spreadPctMax,
            hourOk: this.isNumber(hourUtc) && hourUtc >= rules.sellHourStartUtc && hourUtc <= rules.sellHourEndUtc,
            sessionOk: cryptoSessionOk,
        };
        const cryptoBuyChecks = {
            h1AdxOk: this.isNumber(biasAdx) && biasAdx >= rules.buyH1AdxMin,
            m15AdxOk: this.isNumber(setupAdx) && setupAdx >= rules.buyM15AdxMin,
            m15RsiOk: this.isNumber(setupRsi) && setupRsi >= rules.buySetupRsiMin && setupRsi <= rules.buySetupRsiMax,
            pullbackOk: this.isNumber(setupPullbackValue) && setupPullbackValue <= rules.buyPullbackMax,
            m5MacdOk: this.isNumber(entryMacdHist) && entryMacdHist >= rules.buyMacdHistMin,
            spreadOk: this.isNumber(spreadPct) && spreadPct <= rules.spreadPctMax,
            hourOk: this.isNumber(hourUtc) && hourUtc >= rules.buyHourStartUtc && hourUtc <= rules.buyHourEndUtc,
            sessionOk: cryptoSessionOk,
        };

        const forexSellOk = Object.values(forexSellChecks).every(Boolean);
        const forexBuyOk = Object.values(forexBuyChecks).every(Boolean);
        const cryptoSellOk = Object.values(cryptoSellChecks).every(Boolean);
        const cryptoBuyOk = Object.values(cryptoBuyChecks).every(Boolean);

        let signal = null;
        let patternChecks = {};

        if (selectedAssetClass === "crypto") {
            if (cryptoSellOk) {
                signal = "SELL";
                patternChecks = cryptoSellChecks;
            } else if (cryptoBuyOk) {
                signal = "BUY";
                patternChecks = cryptoBuyChecks;
            } else {
                patternChecks = { sell: cryptoSellChecks, buy: cryptoBuyChecks };
            }
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

    generateSignal3StageForex({ symbol, indicators, variant, market, timestamp, sessions }) {
        return this.generateSignal3Stage({ symbol, indicators, variant, assetClass: "forex", market, timestamp, sessions });
    }

    generateSignal3StageCrypto({ symbol, indicators, variant = "H1_M15_M5", market, timestamp, sessions }) {
        return this.generateSignal3Stage({ symbol, indicators, variant, assetClass: "crypto", market, timestamp, sessions });
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
